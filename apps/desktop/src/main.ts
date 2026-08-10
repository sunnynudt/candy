import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  WebContentsView,
  type IpcMainInvokeEvent,
} from "electron";
import {
  cleanChildEnvironment,
  DEFAULT_CANDY_MODEL,
  KeyringCredentialStore,
  resolveAppPaths,
  type CredentialName,
  type CandyModelId,
} from "@candy/platform";
import { AttachmentStore, type BrowserTabSnapshot } from "@candy/runtime";
import {
  decodeJsonLine,
  encodeJsonLine,
  type CommandEnvelope,
  type EventEnvelope,
  type ProtocolMessage,
} from "@candy/protocol";
import {
  assertApplyPaths,
  assertCredentialName,
  assertTaskId,
  assertValidatorSpec,
  assertWorkspacePath,
  classifyWindowClose,
  credentialStoreLabel,
  type DesktopPreloadApi,
  type RendererTaskProjection,
  type WorkspaceSelection,
} from "./contracts.js";

export const ELECTRON_COMPATIBILITY_VERSION = "43.2.0" as const;

interface AppServerLaunchSpec {
  readonly runtimeExecutable: string;
  readonly entrypoint: string;
}

class AppServerUnavailableError extends Error {
  public constructor() {
    super("Candy app-server is unavailable until the packaged Node runtime is installed.");
    this.name = "AppServerUnavailableError";
  }
}

class AppServerClient {
  #child: ChildProcessWithoutNullStreams | undefined;
  readonly #pending = new Map<
    string,
    { resolve: (message: ProtocolMessage) => void; reject: (error: Error) => void }
  >();
  readonly #onEvent: (event: EventEnvelope) => void;

  public constructor(onEvent: (event: EventEnvelope) => void) {
    this.#onEvent = onEvent;
  }

  public start(spec: AppServerLaunchSpec): void {
    if (this.#child) return;
    const child = spawn(spec.runtimeExecutable, [spec.entrypoint], {
      cwd: dirname(spec.entrypoint),
      env: cleanChildEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        const message = decodeJsonLine(line);
        if (message.kind !== "event") return;
        this.#onEvent(message);
        if (message.event.type === "snapshot") {
          const pending = this.#pending.get(message.taskId);
          if (pending) {
            this.#pending.delete(message.taskId);
            pending.resolve(message);
          }
        }
      } catch {
        // Malformed child output is a local runtime failure; never forward it to the renderer.
      }
    });
    child.once("exit", () => {
      this.#child = undefined;
      for (const pending of this.#pending.values()) pending.reject(new AppServerUnavailableError());
      this.#pending.clear();
    });
  }

  public send(command: CommandEnvelope): Promise<ProtocolMessage> {
    if (!this.#child) return Promise.reject(new AppServerUnavailableError());
    return new Promise((resolve, reject) => {
      this.#pending.set(command.taskId, { resolve, reject });
      this.#child?.stdin.write(encodeJsonLine(command));
    });
  }

  public stop(): void {
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    child.stdin.end();
    child.kill();
  }
}

const projections = new Map<string, RendererTaskProjection>();
let appServer: AppServerClient | undefined;
let mainWindow: BrowserWindow | undefined;
let browserView: WebContentsView | undefined;
let browserTab: BrowserTabSnapshot | undefined;
const browserHosts = new Set<string>();
let browserNavigationDenied = false;
let browserPopupDenied = false;
let browserPermissionDenied = false;
let browserDownloadPrevented = false;
let explicitQuit = false;
let selectedWorkspacePath: string | undefined;

function assertBrowserHost(host: unknown): asserts host is string {
  if (typeof host !== "string" || host.length === 0 || host.length > 255)
    throw new Error("Browser site host is invalid.");
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    throw new Error("Browser site host is invalid.");
  }
  if (parsed.host !== host.toLowerCase() || parsed.pathname !== "/" || parsed.search || parsed.hash)
    throw new Error("Browser site host is invalid.");
}

function parseCandyBrowserUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048)
    throw new Error("Browser URL is invalid.");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Browser URL is invalid.");
  }
  const localHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]");
  if (parsed.username || parsed.password || !(parsed.protocol === "https:" || localHttp))
    throw new Error("Browser URL must be HTTPS or a loopback HTTP fixture without credentials.");
  return parsed;
}

function browserSnapshotWithRevision(
  current: BrowserTabSnapshot | undefined,
  updates: Pick<BrowserTabSnapshot, "url" | "title" | "text" | "siteAllowed">,
): BrowserTabSnapshot {
  return {
    tabId: current?.tabId ?? "browser-tab-1",
    revision: (current?.revision ?? 0) + 1,
    control: current?.control ?? "user",
    ...updates,
  };
}

async function readBrowserPage(): Promise<BrowserTabSnapshot> {
  if (!browserView || !browserTab) throw new Error("Browser Workspace has no open tab.");
  const page = (await browserView.webContents.executeJavaScript(
    "({ title: document.title || '', url: location.href, text: (document.body?.innerText || '').slice(0, 20000) })",
    true,
  )) as { readonly title?: unknown; readonly url?: unknown; readonly text?: unknown };
  const url = typeof page.url === "string" ? page.url : browserTab.url;
  const parsed = parseCandyBrowserUrl(url);
  browserTab = {
    ...browserTab,
    url,
    title: typeof page.title === "string" ? page.title : "",
    text: typeof page.text === "string" ? page.text : "",
    siteAllowed: browserHosts.has(parsed.host.toLowerCase()),
  };
  mainWindow?.webContents.send("browser.update", browserTab);
  return { ...browserTab };
}

async function openBrowserUrl(urlValue: unknown): Promise<BrowserTabSnapshot> {
  if (!browserView) throw new Error("Browser Workspace is unavailable.");
  const parsed = parseCandyBrowserUrl(urlValue);
  if (!browserHosts.has(parsed.host.toLowerCase()))
    throw new Error("Allow this Browser site before opening it.");
  browserTab = browserSnapshotWithRevision(browserTab, {
    url: parsed.toString(),
    title: "",
    text: "",
    siteAllowed: true,
  });
  browserView.setVisible(true);
  await browserView.webContents.loadURL(parsed.toString());
  return readBrowserPage();
}

function updateBrowserControl(control: "user" | "agent"): BrowserTabSnapshot {
  if (!browserTab) throw new Error("Browser Workspace has no open tab.");
  browserTab = { ...browserTab, control, revision: browserTab.revision + 1 };
  mainWindow?.webContents.send("browser.update", browserTab);
  return { ...browserTab };
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (mainWindow === undefined || event.sender !== mainWindow.webContents)
    throw new Error("Unauthorized renderer.");
}

function emptyProjection(taskId: string): RendererTaskProjection {
  return {
    taskId,
    state: "idle",
    revision: 0,
    approvalProfile: "read-only",
    model: DEFAULT_CANDY_MODEL,
    workspaceState: "local",
    changedFiles: [],
    trackedFiles: [],
    untrackedFiles: [],
    diff: "",
    diffTruncated: false,
    transcript: [],
  };
}

function projectionFromEvent(event: EventEnvelope): RendererTaskProjection {
  const current = projections.get(event.taskId) ?? emptyProjection(event.taskId);
  if (event.event.type === "snapshot") {
    return {
      ...current,
      state: event.event.snapshot.state,
      revision: event.revision,
      ...(event.event.snapshot.approvalProfile === undefined
        ? {}
        : { approvalProfile: event.event.snapshot.approvalProfile }),
      ...(event.event.snapshot.model === undefined ? {} : { model: event.event.snapshot.model }),
      ...(event.event.snapshot.workspacePath === undefined
        ? {}
        : { workspacePath: event.event.snapshot.workspacePath }),
      ...(event.event.snapshot.workspaceBaseline === undefined
        ? {}
        : { workspaceBaseline: event.event.snapshot.workspaceBaseline }),
      ...(event.event.snapshot.workspaceState === undefined
        ? {}
        : { workspaceState: event.event.snapshot.workspaceState }),
      ...(event.event.snapshot.worktreePath === undefined
        ? {}
        : { worktreePath: event.event.snapshot.worktreePath }),
      ...(event.event.snapshot.progress === undefined
        ? {}
        : { progress: event.event.snapshot.progress }),
    };
  }
  if (event.event.type === "task.created")
    return {
      ...current,
      approvalProfile: event.event.approvalProfile,
      ...(event.event.model === undefined ? {} : { model: event.event.model }),
    };
  if (event.event.type === "task.state_changed")
    return { ...current, state: event.event.state, revision: event.revision };
  if (event.event.type === "assistant.delta") {
    const previous = current.transcript.at(-1);
    const transcript =
      previous?.role === "assistant"
        ? [
            ...current.transcript.slice(0, -1),
            { ...previous, text: `${previous.text}${event.event.text}` },
          ]
        : [...current.transcript, { role: "assistant" as const, text: event.event.text }];
    return { ...current, revision: event.revision, transcript };
  }
  if (event.event.type === "tool.completed") {
    return {
      ...current,
      revision: event.revision,
      transcript: [
        ...current.transcript,
        { role: "tool", text: `${event.event.tool}: ${event.event.ok ? "ok" : "error"}` },
      ],
    };
  }
  if (event.event.type === "workspace.changes") {
    return {
      ...current,
      revision: event.revision,
      changedFiles: [...event.event.tracked, ...event.event.untracked],
      trackedFiles: [...event.event.tracked],
      untrackedFiles: [...event.event.untracked],
      diff: event.event.patchText,
      diffTruncated: event.event.patchTruncated,
    };
  }
  return current;
}

function handleAppServerEvent(event: EventEnvelope): void {
  const projection = projectionFromEvent(event);
  projections.set(event.taskId, projection);
  mainWindow?.webContents.send("task.update", projection);
}

function validatePrompt(prompt: unknown): asserts prompt is string {
  if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 1_000_000)
    throw new Error("Invalid task prompt.");
}

function workspaceSelectionFile(): string {
  return join(resolveAppPaths(app.getPath("userData")).state, "workspace.json");
}

async function loadWorkspaceSelection(): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(workspaceSelectionFile(), "utf8")) as {
      readonly path?: unknown;
    };
    if (typeof parsed.path !== "string") return undefined;
    assertWorkspacePath(parsed.path);
    if (!(await stat(parsed.path)).isDirectory()) return undefined;
    return parsed.path;
  } catch {
    return undefined;
  }
}

async function saveWorkspaceSelection(workspacePath: string): Promise<void> {
  assertWorkspacePath(workspacePath);
  const stateDirectory = resolveAppPaths(app.getPath("userData")).state;
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(workspaceSelectionFile(), `${JSON.stringify({ path: workspacePath })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function registerIpcHandlers(): void {
  const credentials = new KeyringCredentialStore();
  const attachments = new AttachmentStore(resolveAppPaths(app.getPath("userData")).attachments);
  ipcMain.handle("browser.allow-site", (event, host: unknown) => {
    assertTrustedRenderer(event);
    assertBrowserHost(host);
    browserHosts.add(host.toLowerCase());
  });
  ipcMain.handle("browser.open", async (event, url: unknown) => {
    assertTrustedRenderer(event);
    return openBrowserUrl(url);
  });
  ipcMain.handle("browser.navigate", async (event, url: unknown, expectedRevision: unknown) => {
    assertTrustedRenderer(event);
    if (!browserTab || !browserView) throw new Error("Browser Workspace has no open tab.");
    if (browserTab.control !== "agent") throw new Error("User owns this browser tab.");
    if (expectedRevision !== browserTab.revision) throw new Error("Browser observation is stale.");
    const parsed = parseCandyBrowserUrl(url);
    if (!browserHosts.has(parsed.host.toLowerCase()))
      throw new Error("Browser site permission is required.");
    await browserView.webContents.loadURL(parsed.toString());
    return readBrowserPage();
  });
  ipcMain.handle("browser.observe", (event) => {
    assertTrustedRenderer(event);
    return readBrowserPage();
  });
  ipcMain.handle("browser.take-control", (event) => {
    assertTrustedRenderer(event);
    return updateBrowserControl("user");
  });
  ipcMain.handle("browser.return-control", (event) => {
    assertTrustedRenderer(event);
    return updateBrowserControl("agent");
  });
  ipcMain.handle("workspace.current", (event): WorkspaceSelection | undefined => {
    assertTrustedRenderer(event);
    return selectedWorkspacePath === undefined ? undefined : { path: selectedWorkspacePath };
  });
  ipcMain.handle("workspace.choose", async (event): Promise<WorkspaceSelection | undefined> => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Choose Candy Local Workspace",
    });
    const workspacePath = result.filePaths[0];
    if (result.canceled || workspacePath === undefined) return undefined;
    assertWorkspacePath(workspacePath);
    if (!(await stat(workspacePath)).isDirectory())
      throw new Error("Workspace is not a directory.");
    selectedWorkspacePath = workspacePath;
    await saveWorkspaceSelection(workspacePath);
    return { path: workspacePath };
  });
  ipcMain.handle("attachment.pick-image", async (event) => {
    assertTrustedRenderer(event);
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    const filePath = result.filePaths[0];
    if (result.canceled || filePath === undefined) return undefined;
    const extension = filePath.toLowerCase().split(".").at(-1);
    const mimeType =
      extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension ?? "png"}`;
    return (await attachments.put("image", mimeType, await readFile(filePath))).id;
  });
  ipcMain.handle("credential.set", (event, name: string, value: string) => {
    assertTrustedRenderer(event);
    assertCredentialName(name);
    credentials.set(name as CredentialName, value);
  });
  ipcMain.handle("credential.replace", (event, name: string, value: string) => {
    assertTrustedRenderer(event);
    assertCredentialName(name);
    credentials.replace(name as CredentialName, value);
  });
  ipcMain.handle("credential.delete", (event, name: string) => {
    assertTrustedRenderer(event);
    assertCredentialName(name);
    credentials.delete(name as CredentialName);
  });
  ipcMain.handle("credential.has", (event, name: string) => {
    assertTrustedRenderer(event);
    assertCredentialName(name);
    return credentials.has(name as CredentialName);
  });
  ipcMain.handle(
    "task.create",
    async (
      event,
      prompt: unknown,
      profile: unknown,
      model: unknown,
      attachmentIds: unknown,
      validator: unknown,
    ) => {
      assertTrustedRenderer(event);
      validatePrompt(prompt);
      if (profile !== "read-only" && profile !== "auto")
        throw new Error("Invalid approval profile.");
      if (selectedWorkspacePath === undefined) throw new Error("Choose a workspace first.");
      if (validator !== undefined) assertValidatorSpec(validator);
      if (
        model !== undefined &&
        model !== "deepseek-v4-flash" &&
        model !== "deepseek-v4-pro" &&
        model !== "MiniMax-M3"
      )
        throw new Error("Invalid model.");
      const selectedModel = (model ?? DEFAULT_CANDY_MODEL) as CandyModelId;
      if (
        attachmentIds !== undefined &&
        (!Array.isArray(attachmentIds) ||
          attachmentIds.some((id) => typeof id !== "string" || !/^att_[a-f0-9]{64}$/u.test(id)))
      )
        throw new Error("Invalid attachment ids.");
      const selectedAttachments = (attachmentIds ?? []) as readonly string[];
      const selectedValidator = validator;
      const taskId = randomUUID().replaceAll("-", "");
      const projection = emptyProjection(taskId);
      projections.set(taskId, {
        ...projection,
        approvalProfile: profile,
        model: selectedModel,
        workspacePath: selectedWorkspacePath,
      });
      if (!appServer) throw new AppServerUnavailableError();
      await appServer.send({
        v: 1,
        kind: "command",
        commandId: randomUUID(),
        taskId,
        expectedRevision: 0,
        command: {
          type: "task.create",
          prompt,
          approvalProfile: profile,
          workspacePath: selectedWorkspacePath,
          ...(selectedValidator === undefined ? {} : { validator: selectedValidator }),
          model: selectedModel,
          attachmentIds: selectedAttachments,
        },
      });
      return projections.get(taskId) ?? projection;
    },
  );
  ipcMain.handle("task.snapshot", async (event, taskId: string) => {
    assertTrustedRenderer(event);
    assertTaskId(taskId);
    if (!appServer) return projections.get(taskId) ?? emptyProjection(taskId);
    const current = projections.get(taskId) ?? emptyProjection(taskId);
    await appServer.send({
      v: 1,
      kind: "command",
      commandId: randomUUID(),
      taskId,
      expectedRevision: current.revision,
      command: { type: "snapshot" },
    });
    return projections.get(taskId) ?? current;
  });
  ipcMain.handle(
    "task.send",
    async (
      event,
      input: DesktopPreloadApi["tasks"] extends { send: (value: infer T) => unknown } ? T : never,
    ) => {
      assertTrustedRenderer(event);
      assertTaskId(input.taskId);
      if (!appServer) throw new AppServerUnavailableError();
      await appServer.send({
        v: 1,
        kind: "command",
        commandId: randomUUID(),
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        command: { type: input.type },
      });
    },
  );
  ipcMain.handle(
    "task.apply",
    async (
      event,
      input: DesktopPreloadApi["tasks"] extends { apply: (value: infer T) => unknown } ? T : never,
    ) => {
      assertTrustedRenderer(event);
      assertTaskId(input.taskId);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        throw new Error("Invalid task revision.");
      if (typeof input.expectedBase !== "string" || !/^[0-9a-f]{7,64}$/u.test(input.expectedBase))
        throw new Error("Invalid workspace baseline.");
      assertApplyPaths(input.tracked);
      assertApplyPaths(input.untracked);
      if (!appServer) throw new AppServerUnavailableError();
      await appServer.send({
        v: 1,
        kind: "command",
        commandId: randomUUID(),
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        command: {
          type: "workspace.apply",
          expectedBase: input.expectedBase,
          tracked: input.tracked,
          untracked: input.untracked,
        },
      });
      return projections.get(input.taskId) ?? emptyProjection(input.taskId);
    },
  );
  ipcMain.handle(
    "task.discard",
    async (
      event,
      input: DesktopPreloadApi["tasks"] extends { discard: (value: infer T) => unknown }
        ? T
        : never,
    ) => {
      assertTrustedRenderer(event);
      assertTaskId(input.taskId);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
        throw new Error("Invalid task revision.");
      if (!appServer) throw new AppServerUnavailableError();
      await appServer.send({
        v: 1,
        kind: "command",
        commandId: randomUUID(),
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        command: { type: "workspace.discard" },
      });
      return projections.get(input.taskId) ?? emptyProjection(input.taskId);
    },
  );
}

function resolveAppServerLaunch(): AppServerLaunchSpec | undefined {
  if (!app.isPackaged) {
    const runtimeExecutable = process.env.CANDY_DEV_APP_SERVER_NODE;
    const entrypoint = process.env.CANDY_DEV_APP_SERVER_ENTRY;
    if (runtimeExecutable === undefined || entrypoint === undefined) return undefined;
    if (!isAbsolute(runtimeExecutable) || !isAbsolute(entrypoint))
      throw new Error("Development app-server paths must be absolute.");
    return { runtimeExecutable, entrypoint };
  }
  const resourceRoot = process.resourcesPath;
  return {
    runtimeExecutable: join(
      resourceRoot,
      "node",
      process.platform === "win32" ? "node.exe" : "bin/node",
    ),
    entrypoint: join(resourceRoot, "app-server", "main.js"),
  };
}

export function createDesktopWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.js"),
    },
  });
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: "persist:candy-browser-v1",
    },
  });
  browserView = view;
  view.webContents.setWindowOpenHandler(() => {
    browserPopupDenied = true;
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedCandyBrowserUrl(url, [...browserHosts])) {
      browserNavigationDenied = true;
      event.preventDefault();
    }
  });
  view.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedCandyBrowserUrl(url, [...browserHosts])) {
      browserNavigationDenied = true;
      event.preventDefault();
    }
  });
  view.webContents.on("did-finish-load", () => {
    if (browserTab) void readBrowserPage();
  });
  window.contentView.addChildView(view);
  view.setBounds({ x: 360, y: 0, width: 840, height: 800 });
  view.setVisible(false);
  const nonce = randomUUID().replaceAll("-", "");
  void window.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(desktopShellHtml(nonce)),
  );
  window.on("close", (event) => {
    if (!explicitQuit && classifyWindowClose(false) === "hide-to-tray") {
      event.preventDefault();
      window.hide();
    }
  });
  return window;
}

function desktopShellHtml(nonce: string): string {
  const credentialStore = credentialStoreLabel(process.platform);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><title>Candy</title>
<style>body{font:14px system-ui;margin:0;color:#202124;background:#f7f7f8}main{display:grid;grid-template-columns:360px 1fr;height:100vh}aside{padding:20px;border-right:1px solid #ddd;background:#fff;overflow:auto}section{padding:20px;overflow:auto}textarea,input{width:100%;box-sizing:border-box;margin:4px 0 8px;padding:7px}textarea{height:140px}button,select{margin:8px 4px 8px 0;padding:7px 10px}pre{white-space:pre-wrap;background:#fff;padding:12px;border:1px solid #ddd;border-radius:6px}.muted{color:#6b7280}.card{border:1px solid #ddd;border-radius:6px;padding:10px;margin:14px 0}.status{font-size:12px}</style></head>
 <body><main><aside><h1>Candy</h1><p class="muted">Local-first, one agent per task</p><div class="card"><strong>Local Workspace</strong><button id="chooseWorkspace">Choose folder</button><div id="workspacePath" class="muted">No workspace selected.</div></div><div class="card"><strong>Trusted credentials</strong><div><label for="deepseekKey">DeepSeek API key</label><input id="deepseekKey" type="password" autocomplete="off" placeholder="Stored in ${credentialStore}"><button id="saveDeepSeek">Save</button><button id="deleteDeepSeek">Delete</button><span id="deepseekStatus" class="status muted"></span></div><div><label for="minimaxKey">MiniMax Token Plan key</label><input id="minimaxKey" type="password" autocomplete="off" placeholder="Stored in ${credentialStore}"><button id="saveMiniMax">Save</button><button id="deleteMiniMax">Delete</button><span id="minimaxStatus" class="status muted"></span></div></div><div class="card"><strong>Optional validator</strong><label for="validatorExecutable">Absolute executable</label><input id="validatorExecutable" placeholder="e.g. /usr/bin/env"><label for="validatorArgs">Arguments as JSON array</label><input id="validatorArgs" placeholder='["npm","test"]' value="[]"><div class="muted">Runs without Candy provider credentials and with network denied.</div></div><label for="profile">Approval profile</label><select id="profile"><option value="read-only">Read-only</option><option value="auto">Auto (gated)</option></select><label for="model">Model</label><select id="model"><option value="deepseek-v4-flash">DeepSeek V4 Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option><option value="MiniMax-M3">MiniMax M3 (image)</option></select><textarea id="prompt" placeholder="Describe the coding task"></textarea><button id="attach">Attach image</button><span id="attachments" class="muted"></span><button id="create">Create task</button><div id="taskStatus"></div><div id="taskProgress" class="muted"></div><div id="taskActions"></div><button id="applyChanges" disabled>Apply changes</button><button id="discardWorktree" disabled>Discard worktree</button></aside><section><h2>Transcript</h2><div id="transcript" class="muted">No task selected.</div><h2>Changed files</h2><pre id="diff">No diff yet.</pre></section></main>
<script nonce="${nonce}">
(() => {
  const prompt = document.getElementById('prompt');
  const validatorExecutable = document.getElementById('validatorExecutable');
  const validatorArgs = document.getElementById('validatorArgs');
  const chooseWorkspace = document.getElementById('chooseWorkspace');
  const workspacePath = document.getElementById('workspacePath');
  const credentialInputs = { deepseek: document.getElementById('deepseekKey'), 'minimax-cn': document.getElementById('minimaxKey') };
  const credentialStatus = { deepseek: document.getElementById('deepseekStatus'), 'minimax-cn': document.getElementById('minimaxStatus') };
  const profile = document.getElementById('profile');
  const model = document.getElementById('model');
  const attach = document.getElementById('attach');
  const attachments = document.getElementById('attachments');
  const create = document.getElementById('create');
  const taskStatus = document.getElementById('taskStatus');
  const taskProgress = document.getElementById('taskProgress');
  const taskActions = document.getElementById('taskActions');
  const applyChanges = document.getElementById('applyChanges');
  const discardWorktree = document.getElementById('discardWorktree');
  const transcript = document.getElementById('transcript');
  const diff = document.getElementById('diff');
  const browserCard = document.createElement('div');
  browserCard.className = 'card';
  browserCard.innerHTML = '<strong>Browser Workspace</strong><label for="browserHost">Allowed site host</label><input id="browserHost" placeholder="localhost:3000"><button id="allowBrowserSite">Allow site</button><label for="browserUrl">Visible page URL</label><input id="browserUrl" placeholder="https://example.com"><button id="openBrowser">Open</button><button id="navigateBrowser">Agent navigate</button><button id="takeBrowserControl">Take Control</button><button id="returnBrowserControl">Return to agent</button><div id="browserStatus" class="status muted">No browser tab.</div><pre id="browserText">No browser page.</pre>';
  document.querySelector('aside').append(browserCard);
  const browserHost = browserCard.querySelector('#browserHost');
  const browserUrl = browserCard.querySelector('#browserUrl');
  const browserStatus = browserCard.querySelector('#browserStatus');
  const browserText = browserCard.querySelector('#browserText');
  let currentBrowser;
  let current;
  let attachmentIds = [];
  let workspace;
  const showWorkspace = (selection) => { workspace = selection; workspacePath.textContent = selection?.path || 'No workspace selected.'; };
  const refreshCredentials = async () => { for (const name of ['deepseek','minimax-cn']) credentialStatus[name].textContent = await window.candy.credentials.has(name) === 'present' ? 'present' : 'absent'; };
  const saveCredential = async (name) => { const value = credentialInputs[name].value; if (!value) return; await window.candy.credentials.replace(name, value); credentialInputs[name].value = ''; await refreshCredentials(); };
  const deleteCredential = async (name) => { await window.candy.credentials.delete(name); await refreshCredentials(); };
  const showBrowser = (snapshot) => { currentBrowser = snapshot; browserStatus.textContent = snapshot.url + ' · ' + snapshot.control + ' · revision ' + snapshot.revision + (snapshot.siteAllowed ? ' · allowed' : ' · site not allowed'); browserText.textContent = snapshot.text || '(empty page)'; };
  browserCard.querySelector('#allowBrowserSite').addEventListener('click', async () => { try { await window.candy.browser.allowSite(browserHost.value.trim()); browserStatus.textContent = 'Site allowed. Open it explicitly.'; } catch (error) { browserStatus.textContent = 'Browser site failed: ' + error.message; } });
  browserCard.querySelector('#openBrowser').addEventListener('click', async () => { try { showBrowser(await window.candy.browser.open(browserUrl.value.trim())); } catch (error) { browserStatus.textContent = 'Browser open failed: ' + error.message; } });
  browserCard.querySelector('#navigateBrowser').addEventListener('click', async () => { if (!currentBrowser) return; try { showBrowser(await window.candy.browser.navigate(browserUrl.value.trim(), currentBrowser.revision)); } catch (error) { browserStatus.textContent = 'Browser navigate failed: ' + error.message; } });
  browserCard.querySelector('#takeBrowserControl').addEventListener('click', async () => { try { showBrowser(await window.candy.browser.takeControl()); } catch (error) { browserStatus.textContent = 'Take Control failed: ' + error.message; } });
  browserCard.querySelector('#returnBrowserControl').addEventListener('click', async () => { try { showBrowser(await window.candy.browser.returnControlToAgent()); } catch (error) { browserStatus.textContent = 'Return control failed: ' + error.message; } });
  window.candy.browser.onUpdate(showBrowser);
  const readValidator = () => { if (!validatorExecutable.value.trim()) return undefined; const args = JSON.parse(validatorArgs.value || '[]'); if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Validator args must be a JSON string array.'); return { executable: validatorExecutable.value.trim(), args }; };
  chooseWorkspace.addEventListener('click', async () => { try { showWorkspace(await window.candy.workspace.choose()); } catch (error) { taskStatus.textContent = 'Workspace failed: ' + error.message; } });
  document.getElementById('saveDeepSeek').addEventListener('click', () => saveCredential('deepseek').catch((error) => { taskStatus.textContent = error.message; }));
  document.getElementById('deleteDeepSeek').addEventListener('click', () => deleteCredential('deepseek').catch((error) => { taskStatus.textContent = error.message; }));
  document.getElementById('saveMiniMax').addEventListener('click', () => saveCredential('minimax-cn').catch((error) => { taskStatus.textContent = error.message; }));
  document.getElementById('deleteMiniMax').addEventListener('click', () => deleteCredential('minimax-cn').catch((error) => { taskStatus.textContent = error.message; }));
  void window.candy.workspace.current().then(showWorkspace); void refreshCredentials();
  const render = (projection) => {
    current = projection;
    taskStatus.textContent = projection.taskId + ' · ' + projection.state + ' · revision ' + projection.revision + ' · ' + (projection.workspaceState === 'worktree' ? 'Task Worktree' : 'Local');
    taskProgress.textContent = projection.progress
      ? 'Run progress · round ' + projection.progress.rounds + ' · evidence ' + projection.progress.evidenceCount + ' · ' + projection.progress.stopReason
      : '';
    transcript.textContent = projection.transcript.map((entry) => entry.role.toUpperCase() + ': ' + entry.text).join('\\n') || 'No transcript yet.';
    diff.textContent = projection.changedFiles.length > 0
      ? 'Changed files:\\n' + projection.changedFiles.join('\\n') + '\\n\\nDiff:\\n' + (projection.diff || '(no tracked patch)') + (projection.diffTruncated ? '\\n\\nDiff is truncated; Apply is unavailable until the workspace is reviewed in smaller changes.' : '')
      : 'No diff yet.';
    applyChanges.disabled = !(projection.state === 'completed' && projection.workspaceState === 'worktree' && projection.changedFiles.length > 0 && projection.workspaceBaseline && !projection.diffTruncated);
    discardWorktree.disabled = !(projection.state === 'completed' && projection.workspaceState === 'worktree');
  };
  create.addEventListener('click', async () => {
    if (!prompt.value.trim()) return;
    if (!workspace) { taskStatus.textContent = 'Choose a workspace first.'; return; }
    try { render(await window.candy.tasks.create(prompt.value, profile.value, model.value, attachmentIds, readValidator())); prompt.value = ''; attachmentIds = []; attachments.textContent = ''; } catch (error) { taskStatus.textContent = 'Create failed: ' + error.message; }
  });
  attach.addEventListener('click', async () => { const id = await window.candy.attachments.pickImage(); if (id) { attachmentIds.push(id); attachments.textContent = attachmentIds.length + ' image attached'; } });
  const send = (type) => current && window.candy.tasks.send({ taskId: current.taskId, expectedRevision: current.revision, type }).catch((error) => { taskStatus.textContent = error.message; });
  for (const type of ['task.run','task.pause','task.resume','task.cancel']) { const button = document.createElement('button'); button.textContent = type.replace('task.',''); button.addEventListener('click', () => send(type)); taskActions.appendChild(button); }
  applyChanges.addEventListener('click', async () => {
    if (!current) return;
    try {
      render(await window.candy.tasks.apply({ taskId: current.taskId, expectedRevision: current.revision, expectedBase: current.workspaceBaseline, tracked: current.trackedFiles, untracked: current.untrackedFiles }));
      taskStatus.textContent = 'Apply changes ok.';
    } catch (error) { taskStatus.textContent = 'Apply failed: ' + error.message; }
  });
  discardWorktree.addEventListener('click', async () => {
    if (!current) return;
    try {
      render(await window.candy.tasks.discard({ taskId: current.taskId, expectedRevision: current.revision }));
      taskStatus.textContent = 'Worktree discarded.';
    } catch (error) { taskStatus.textContent = 'Discard failed: ' + error.message; }
  });
  window.candy.tasks.onUpdate(render);
})();
</script></body></html>`;
}

export function isAllowedCandyBrowserUrl(
  url: string,
  allowedHosts: readonly string[] = [],
): boolean {
  try {
    const parsed = parseCandyBrowserUrl(url);
    return allowedHosts.includes(parsed.host.toLowerCase());
  } catch {
    return false;
  }
}

export function configureCandyBrowserSession(): void {
  const paths = resolveAppPaths(app.getPath("userData"));
  void paths;
  const browserSession = session.fromPartition("persist:candy-browser-v1");
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    browserPermissionDenied = true;
    callback(false);
  });
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on("will-download", (event) => {
    browserDownloadPrevented = true;
    event.preventDefault();
  });
}

export function startDesktop(): void {
  app.setName("Candy");
  app.whenReady().then(async () => {
    configureCandyBrowserSession();
    selectedWorkspacePath = await loadWorkspaceSelection();
    appServer = new AppServerClient(handleAppServerEvent);
    const launch = resolveAppServerLaunch();
    if (launch) appServer.start(launch);
    registerIpcHandlers();
    mainWindow = createDesktopWindow();
    mainWindow.show();
    if (process.env.CANDY_BROWSER_SMOKE === "1")
      void runBrowserSmoke().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : "Browser smoke failed.");
        app.exit(1);
      });
    else if (process.env.CANDY_DESKTOP_SMOKE === "1") void runDesktopSmoke();
  });
  app.on("before-quit", () => {
    explicitQuit = true;
    appServer?.stop();
  });
}

async function runDesktopSmoke(): Promise<void> {
  if (!appServer) throw new Error("Desktop smoke requires an app-server child.");
  await appServer.send({
    v: 1,
    kind: "command",
    commandId: "desktop-smoke-1",
    taskId: "desktop-smoke",
    expectedRevision: 0,
    command: { type: "snapshot" },
  });
  app.quit();
}

async function runBrowserSmoke(): Promise<void> {
  const fixtureUrl = process.env.CANDY_BROWSER_FIXTURE_URL;
  if (!fixtureUrl || !browserView) throw new Error("Browser smoke fixture is unavailable.");
  const fixture = parseCandyBrowserUrl(fixtureUrl);
  browserHosts.add(fixture.host.toLowerCase());
  const opened = await openBrowserUrl(fixtureUrl);
  if (!opened.text.includes("Candy browser fixture"))
    throw new Error("Browser fixture text was not observed.");
  await browserView.webContents.executeJavaScript(
    "window.open('https://example.com/'); navigator.geolocation?.getCurrentPosition(() => {}, () => {}); true",
    true,
  );
  await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  await browserView.webContents.downloadURL(`${fixture.origin}/download`);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  try {
    await browserView.webContents.loadURL(`${fixture.origin}/redirect`);
  } catch {
    // Chromium reports a rejected navigation after will-redirect prevents it.
  }
  await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  const user = updateBrowserControl("user");
  const agent = updateBrowserControl("agent");
  if (
    !browserPopupDenied ||
    !browserNavigationDenied ||
    !browserDownloadPrevented ||
    !browserPermissionDenied ||
    user.control !== "user" ||
    agent.control !== "agent" ||
    agent.revision <= user.revision
  )
    throw new Error(
      `Browser security or explicit Take Control smoke failed: navigation=${browserNavigationDenied}, popup=${browserPopupDenied}, permission=${browserPermissionDenied}, download=${browserDownloadPrevented}, user=${user.control}, agent=${agent.control}`,
    );
  console.log(
    "packaged Windows Browser Workspace smoke ok: allowlist, navigation, popup, permission, download, and Take Control",
  );
  app.quit();
}

if (app.isPackaged || process.env.CANDY_DESKTOP_RUN === "1") startDesktop();
