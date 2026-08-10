import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { app, BrowserWindow, dialog, ipcMain, session, WebContentsView } from "electron";
import {
  cleanChildEnvironment,
  DEFAULT_CANDY_MODEL,
  KeyringCredentialStore,
  resolveAppPaths,
  type CredentialName,
  type CandyModelId,
} from "@candy/platform";
import { AttachmentStore } from "@candy/runtime";
import {
  decodeJsonLine,
  encodeJsonLine,
  type CommandEnvelope,
  type EventEnvelope,
  type ProtocolMessage,
} from "@candy/protocol";
import {
  assertCredentialName,
  assertTaskId,
  classifyWindowClose,
  type DesktopPreloadApi,
  type RendererTaskProjection,
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
let explicitQuit = false;

function emptyProjection(taskId: string): RendererTaskProjection {
  return {
    taskId,
    state: "idle",
    revision: 0,
    approvalProfile: "read-only",
    model: DEFAULT_CANDY_MODEL,
    changedFiles: [],
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

function registerIpcHandlers(): void {
  const credentials = new KeyringCredentialStore();
  const attachments = new AttachmentStore(resolveAppPaths(app.getPath("userData")).attachments);
  ipcMain.handle("attachment.pick-image", async () => {
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
  ipcMain.handle("credential.set", (_event, name: string, value: string) => {
    assertCredentialName(name);
    credentials.set(name as CredentialName, value);
  });
  ipcMain.handle("credential.replace", (_event, name: string, value: string) => {
    assertCredentialName(name);
    credentials.replace(name as CredentialName, value);
  });
  ipcMain.handle("credential.delete", (_event, name: string) => {
    assertCredentialName(name);
    credentials.delete(name as CredentialName);
  });
  ipcMain.handle("credential.has", (_event, name: string) => {
    assertCredentialName(name);
    return credentials.has(name as CredentialName);
  });
  ipcMain.handle(
    "task.create",
    async (_event, prompt: unknown, profile: unknown, model: unknown, attachmentIds: unknown) => {
      validatePrompt(prompt);
      if (profile !== "read-only" && profile !== "auto")
        throw new Error("Invalid approval profile.");
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
      const taskId = randomUUID().replaceAll("-", "");
      const projection = emptyProjection(taskId);
      projections.set(taskId, { ...projection, approvalProfile: profile, model: selectedModel });
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
          model: selectedModel,
          attachmentIds: selectedAttachments,
        },
      });
      return projections.get(taskId) ?? projection;
    },
  );
  ipcMain.handle("task.snapshot", async (_event, taskId: string) => {
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
      _event,
      input: DesktopPreloadApi["tasks"] extends { send: (value: infer T) => unknown } ? T : never,
    ) => {
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
}

function resolveAppServerLaunch(): AppServerLaunchSpec | undefined {
  if (!app.isPackaged) return undefined;
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
  const browserView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: "persist:candy-browser-v1",
    },
  });
  const browserHosts: readonly string[] = [];
  browserView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  browserView.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedCandyBrowserUrl(url, browserHosts)) event.preventDefault();
  });
  browserView.webContents.on("will-redirect", (event, url) => {
    if (!isAllowedCandyBrowserUrl(url, browserHosts)) event.preventDefault();
  });
  window.contentView.addChildView(browserView);
  browserView.setBounds({ x: 360, y: 0, width: 840, height: 800 });
  browserView.setVisible(false);
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
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><title>Candy</title>
<style>body{font:14px system-ui;margin:0;color:#202124;background:#f7f7f8}main{display:grid;grid-template-columns:360px 1fr;height:100vh}aside{padding:20px;border-right:1px solid #ddd;background:#fff}section{padding:20px;overflow:auto}textarea{width:100%;height:140px;box-sizing:border-box}button,select{margin:8px 4px 8px 0;padding:7px 10px}pre{white-space:pre-wrap;background:#fff;padding:12px;border:1px solid #ddd;border-radius:6px}.muted{color:#6b7280}</style></head>
<body><main><aside><h1>Candy</h1><p class="muted">Local-first, one agent per task</p><label for="profile">Approval profile</label><select id="profile"><option value="read-only">Read-only</option><option value="auto">Auto (gated)</option></select><label for="model">Model</label><select id="model"><option value="deepseek-v4-flash">DeepSeek V4 Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option><option value="MiniMax-M3">MiniMax M3 (image)</option></select><textarea id="prompt" placeholder="Describe the coding task"></textarea><button id="attach">Attach image</button><span id="attachments" class="muted"></span><button id="create">Create task</button><div id="taskStatus"></div><div id="taskActions"></div></aside><section><h2>Transcript</h2><div id="transcript" class="muted">No task selected.</div><h2>Changed files</h2><pre id="diff">No diff yet.</pre></section></main>
<script nonce="${nonce}">
(() => {
  const prompt = document.getElementById('prompt');
  const profile = document.getElementById('profile');
  const model = document.getElementById('model');
  const attach = document.getElementById('attach');
  const attachments = document.getElementById('attachments');
  const create = document.getElementById('create');
  const taskStatus = document.getElementById('taskStatus');
  const taskActions = document.getElementById('taskActions');
  const transcript = document.getElementById('transcript');
  const diff = document.getElementById('diff');
  let current;
  let attachmentIds = [];
  const render = (projection) => {
    current = projection;
    taskStatus.textContent = projection.taskId + ' · ' + projection.state + ' · revision ' + projection.revision;
    transcript.textContent = projection.transcript.map((entry) => entry.role.toUpperCase() + ': ' + entry.text).join('\\n') || 'No transcript yet.';
    diff.textContent = projection.changedFiles.join('\\n') || 'No diff yet.';
  };
  create.addEventListener('click', async () => {
    if (!prompt.value.trim()) return;
    try { render(await window.candy.tasks.create(prompt.value, profile.value, model.value, attachmentIds)); prompt.value = ''; attachmentIds = []; attachments.textContent = ''; } catch (error) { taskStatus.textContent = 'Create failed: ' + error.message; }
  });
  attach.addEventListener('click', async () => { const id = await window.candy.attachments.pickImage(); if (id) { attachmentIds.push(id); attachments.textContent = attachmentIds.length + ' image attached'; } });
  const send = (type) => current && window.candy.tasks.send({ taskId: current.taskId, expectedRevision: current.revision, type }).catch((error) => { taskStatus.textContent = error.message; });
  for (const type of ['task.run','task.pause','task.resume','task.cancel']) { const button = document.createElement('button'); button.textContent = type.replace('task.',''); button.addEventListener('click', () => send(type)); taskActions.appendChild(button); }
  window.candy.tasks.onUpdate(render);
})();
</script></body></html>`;
}

export function isAllowedCandyBrowserUrl(
  url: string,
  allowedHosts: readonly string[] = [],
): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && allowedHosts.includes(parsed.host.toLowerCase());
  } catch {
    return false;
  }
}

export function configureCandyBrowserSession(): void {
  const paths = resolveAppPaths(app.getPath("userData"));
  void paths;
  const browserSession = session.fromPartition("persist:candy-browser-v1");
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on("will-download", (event) => event.preventDefault());
}

export function startDesktop(): void {
  app.setName("Candy");
  app.whenReady().then(() => {
    configureCandyBrowserSession();
    appServer = new AppServerClient(handleAppServerEvent);
    const launch = resolveAppServerLaunch();
    if (launch) appServer.start(launch);
    registerIpcHandlers();
    mainWindow = createDesktopWindow();
    mainWindow.show();
  });
  app.on("before-quit", () => {
    explicitQuit = true;
    appServer?.stop();
  });
}

if (process.env.CANDY_DESKTOP_RUN === "1") startDesktop();
