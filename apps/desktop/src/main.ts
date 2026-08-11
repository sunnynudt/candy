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
import { AttachmentStore, type BrowserAction, type BrowserTabSnapshot } from "@candy/runtime";
import {
  decodeJsonLine,
  encodeJsonLine,
  type CommandEnvelope,
  type EventEnvelope,
  type ProtocolMessage,
  type ValidatorSpec,
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

interface DesktopEventObservation {
  readonly event: EventEnvelope;
  readonly projection: RendererTaskProjection;
  readonly receivedAt: number;
}

type DesktopEventListener = (observation: DesktopEventObservation) => void;

class AppServerUnavailableError extends Error {
  public constructor() {
    super("Candy app-server is unavailable until the packaged Node runtime is installed.");
    this.name = "AppServerUnavailableError";
  }
}

class AppServerClient {
  #child: ChildProcessWithoutNullStreams | undefined;
  #browserSmokeMarkerSeen = false;
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
    const environment = cleanChildEnvironment(process.env);
    const browserSmokeMarker = process.env.CANDY_BROWSER_SMOKE_MARKER;
    if (process.env.CANDY_DESKTOP_RESPONSIVENESS === "1") {
      environment.CANDY_DETERMINISTIC_RECOVERY_SMOKE = "1";
      const nativeRunner = process.env.CANDY_RESPONSIVENESS_NATIVE_RUNNER;
      if (nativeRunner !== undefined && isAbsolute(nativeRunner))
        environment.CANDY_SANDBOX_RUNNER = nativeRunner;
    }
    if (process.env.CANDY_DESKTOP_LONG_RUNNING_SMOKE === "1") {
      environment.CANDY_LONG_RUNNING_SMOKE = "1";
      const nativeRunner = process.env.CANDY_SANDBOX_RUNNER;
      if (nativeRunner !== undefined && isAbsolute(nativeRunner))
        environment.CANDY_SANDBOX_RUNNER = nativeRunner;
      const validatorExecutable = process.env.CANDY_LONG_RUNNING_VALIDATOR_EXECUTABLE;
      const validatorArgs = process.env.CANDY_LONG_RUNNING_VALIDATOR_ARGS;
      if (validatorExecutable !== undefined && isAbsolute(validatorExecutable))
        environment.CANDY_LONG_RUNNING_VALIDATOR_EXECUTABLE = validatorExecutable;
      if (validatorArgs !== undefined && validatorArgs.length <= 100_000)
        environment.CANDY_LONG_RUNNING_VALIDATOR_ARGS = validatorArgs;
    }
    const child = spawn(spec.runtimeExecutable, [spec.entrypoint], {
      cwd: dirname(spec.entrypoint),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (browserSmokeMarker !== undefined && line.includes(browserSmokeMarker))
        this.#browserSmokeMarkerSeen = true;
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

  public get browserSmokeMarkerSeen(): boolean {
    return this.#browserSmokeMarkerSeen;
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
let browserNavigationId = 0;
let browserOperationTail: Promise<void> = Promise.resolve();
let browserNavigationDenied = false;
let browserPopupDenied = false;
let browserPermissionDenied = false;
let browserDownloadPrevented = false;
let browserAttachments: AttachmentStore | undefined;
let explicitQuit = false;
let selectedWorkspacePath: string | undefined;
const desktopEventListeners = new Set<DesktopEventListener>();

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
    control: current?.control ?? "agent",
    ...updates,
  };
}

function enqueueBrowserOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = browserOperationTail.then(operation, operation);
  browserOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readBrowserPage(expectedNavigationId?: number): Promise<BrowserTabSnapshot> {
  if (!browserView || !browserTab) throw new Error("Browser Workspace has no open tab.");
  const navigationId = expectedNavigationId ?? browserNavigationId;
  const page = (await browserView.webContents.executeJavaScript(
    "({ title: document.title || '', url: location.href, text: (document.body?.innerText || '').slice(0, 20000) })",
    true,
  )) as { readonly title?: unknown; readonly url?: unknown; readonly text?: unknown };
  if (navigationId !== browserNavigationId) throw new Error("Browser navigation was superseded.");
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

function observeBrowserPage(): Promise<BrowserTabSnapshot> {
  return enqueueBrowserOperation(() => readBrowserPage());
}

function assertBrowserAction(value: unknown): asserts value is BrowserAction {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Browser action is invalid.");
  const action = value as {
    readonly type?: unknown;
    readonly target?: unknown;
    readonly text?: unknown;
    readonly expectedRevision?: unknown;
    readonly confirmed?: unknown;
    readonly url?: unknown;
  };
  if (
    (action.type !== "navigate" &&
      action.type !== "click" &&
      action.type !== "type" &&
      action.type !== "submit") ||
    !Number.isSafeInteger(action.expectedRevision) ||
    (action.expectedRevision as number) < 0 ||
    (action.type === "navigate" && typeof action.url !== "string") ||
    (action.type !== "navigate" &&
      (typeof action.target !== "string" ||
        action.target.length === 0 ||
        action.target.length > 512 ||
        action.target.includes("\0"))) ||
    (action.type === "type" &&
      (typeof action.text !== "string" ||
        action.text.length > 10_000 ||
        action.text.includes("\0"))) ||
    (action.type === "submit" && typeof action.confirmed !== "boolean")
  )
    throw new Error("Browser action is invalid.");
}

async function captureBrowserScreenshotUnsafe(): Promise<BrowserTabSnapshot> {
  if (!browserView || !browserTab || !browserAttachments)
    throw new Error("Browser Workspace has no open tab.");
  mainWindow?.showInactive();
  browserView.setVisible(true);
  const capture =
    process.platform === "darwin" && mainWindow
      ? () => mainWindow!.capturePage({ x: 360, y: 0, width: 840, height: 800 })
      : () => browserView!.webContents.capturePage();
  let image;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      image = await capture();
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/display surface/u.test(message) || attempt === 9) throw error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }
  }
  if (!image) throw new Error("Browser screenshot surface is unavailable.");
  const metadata = await browserAttachments.put("image", "image/png", image.toPNG());
  browserTab = {
    ...browserTab,
    revision: browserTab.revision + 1,
    screenshotAttachmentId: metadata.id,
  };
  mainWindow?.webContents.send("browser.update", browserTab);
  return { ...browserTab };
}

function beginBrowserNavigation(parsed: URL): number {
  if (!browserView) throw new Error("Browser Workspace is unavailable.");
  browserNavigationId += 1;
  browserTab = browserSnapshotWithRevision(browserTab, {
    url: parsed.toString(),
    title: "",
    text: "",
    siteAllowed: true,
  });
  browserView.setVisible(true);
  return browserNavigationId;
}

function assertAgentBrowserRevision(expectedRevision: number): void {
  if (!browserView || !browserTab) throw new Error("Browser Workspace has no open tab.");
  if (browserTab.control !== "agent") throw new Error("User owns this browser tab.");
  if (expectedRevision !== browserTab.revision) throw new Error("Browser observation is stale.");
  if (!browserTab.siteAllowed) throw new Error("Browser site permission is required.");
}

async function navigateBrowserUrlUnsafe(
  urlValue: unknown,
  expectedRevision: number,
): Promise<BrowserTabSnapshot> {
  assertAgentBrowserRevision(expectedRevision);
  const parsed = parseCandyBrowserUrl(urlValue);
  if (!browserHosts.has(parsed.host.toLowerCase()))
    throw new Error("Browser site permission is required.");
  const navigationId = beginBrowserNavigation(parsed);
  await browserView!.webContents.loadURL(parsed.toString());
  if (!browserTab || browserTab.control !== "agent" || browserTab.revision !== expectedRevision + 1)
    throw new Error("Browser navigation was invalidated by ownership or revision change.");
  const result = await readBrowserPage(navigationId);
  if (!browserTab || browserTab.control !== "agent" || browserTab.revision !== expectedRevision + 1)
    throw new Error("Browser navigation was invalidated by ownership or revision change.");
  return result;
}

function navigateBrowserUrl(
  urlValue: unknown,
  expectedRevision: number,
): Promise<BrowserTabSnapshot> {
  return enqueueBrowserOperation(() => navigateBrowserUrlUnsafe(urlValue, expectedRevision));
}

async function actInBrowserUnsafe(action: BrowserAction): Promise<BrowserTabSnapshot> {
  if (!browserView || !browserTab) throw new Error("Browser Workspace has no open tab.");
  assertAgentBrowserRevision(action.expectedRevision);
  if (action.type === "navigate") {
    const parsed = parseCandyBrowserUrl(action.url);
    if (!browserHosts.has(parsed.host.toLowerCase()))
      throw new Error("Browser site permission is required.");
    const navigationId = beginBrowserNavigation(parsed);
    await browserView.webContents.loadURL(parsed.toString());
    if (
      !browserTab ||
      browserTab.control !== "agent" ||
      browserTab.revision !== action.expectedRevision + 1
    )
      throw new Error("Browser navigation was invalidated by ownership or revision change.");
    return readBrowserPage(navigationId);
  }
  if (action.type === "submit" && !action.confirmed)
    throw new Error("Sensitive browser action requires confirmation.");
  const actionType = action.type;
  const target = action.target;
  const text = action.type === "type" ? action.text : "";
  const confirmed = action.type === "submit" && action.confirmed;
  const result = (await browserView.webContents.executeJavaScript(
    `(() => {
      const target = document.querySelector(${JSON.stringify(target)});
      if (!target) return { ok: false, reason: 'target-not-found' };
      if (${JSON.stringify(actionType)} === 'click') {
        if (!(target instanceof HTMLElement)) return { ok: false, reason: 'target-not-element' };
        target.click();
        return { ok: true };
      }
      if (${JSON.stringify(actionType)} === 'type') {
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement))
          return { ok: false, reason: 'target-not-field' };
        target.focus();
        const prototype = Object.getPrototypeOf(target);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        descriptor?.set?.call(target, ${JSON.stringify(text)});
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }
      if (${JSON.stringify(confirmed)} !== true)
        return { ok: false, reason: 'confirmation-required' };
      if (!(target instanceof HTMLButtonElement || target instanceof HTMLInputElement || target instanceof HTMLFormElement))
        return { ok: false, reason: 'target-not-submit-control' };
      if (target instanceof HTMLFormElement) target.requestSubmit();
      else target.click();
      return { ok: true };
    })()`,
    true,
  )) as { readonly ok?: unknown; readonly reason?: unknown };
  if (result.ok !== true)
    throw new Error(
      typeof result.reason === "string"
        ? `Browser action rejected: ${result.reason}.`
        : "Browser action rejected.",
    );
  await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  if (
    !browserTab ||
    browserTab.control !== "agent" ||
    browserTab.revision !== action.expectedRevision
  )
    throw new Error("Browser action was invalidated by ownership or revision change.");
  browserTab = { ...browserTab, revision: browserTab.revision + 1 };
  const current = await readBrowserPage();
  if (
    !browserTab ||
    browserTab.control !== "agent" ||
    browserTab.revision !== action.expectedRevision + 1
  )
    throw new Error("Browser action was invalidated by ownership or revision change.");
  return current;
}

function actInBrowser(action: BrowserAction): Promise<BrowserTabSnapshot> {
  return enqueueBrowserOperation(() => actInBrowserUnsafe(action));
}

async function openBrowserUrlUnsafe(urlValue: unknown): Promise<BrowserTabSnapshot> {
  if (!browserView) throw new Error("Browser Workspace is unavailable.");
  const parsed = parseCandyBrowserUrl(urlValue);
  if (!browserHosts.has(parsed.host.toLowerCase()))
    throw new Error("Allow this Browser site before opening it.");
  const navigationId = beginBrowserNavigation(parsed);
  await browserView.webContents.loadURL(parsed.toString());
  return readBrowserPage(navigationId);
}

function openBrowserUrl(urlValue: unknown): Promise<BrowserTabSnapshot> {
  return enqueueBrowserOperation(() => openBrowserUrlUnsafe(urlValue));
}

function captureBrowserScreenshot(): Promise<BrowserTabSnapshot> {
  return enqueueBrowserOperation(() => captureBrowserScreenshotUnsafe());
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
      ...(event.event.snapshot.approvalId === undefined
        ? {}
        : { approvalId: event.event.snapshot.approvalId }),
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
  const observation = { event, projection, receivedAt: Date.now() };
  mainWindow?.webContents.send("task.update", projection);
  for (const listener of desktopEventListeners) listener(observation);
}

function validatePrompt(prompt: unknown): asserts prompt is string {
  if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 1_000_000)
    throw new Error("Invalid task prompt.");
}

function validateSteering(text: unknown): asserts text is string {
  if (typeof text !== "string" || text.length === 0 || text.length > 100_000 || text.includes("\0"))
    throw new Error("Invalid task steering.");
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
  browserAttachments = attachments;
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
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0)
      throw new Error("Browser observation revision is invalid.");
    return navigateBrowserUrl(url, expectedRevision as number);
  });
  ipcMain.handle("browser.act", async (event, action: unknown) => {
    assertTrustedRenderer(event);
    assertBrowserAction(action);
    return actInBrowser(action);
  });
  ipcMain.handle("browser.observe", (event) => {
    assertTrustedRenderer(event);
    return observeBrowserPage();
  });
  ipcMain.handle("browser.screenshot", async (event) => {
    assertTrustedRenderer(event);
    return captureBrowserScreenshot();
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
    "task.steer",
    async (
      event,
      input: DesktopPreloadApi["tasks"] extends { steer: (value: infer T) => unknown } ? T : never,
    ) => {
      assertTrustedRenderer(event);
      assertTaskId(input.taskId);
      validateSteering(input.text);
      if (!appServer) throw new AppServerUnavailableError();
      await appServer.send({
        v: 1,
        kind: "command",
        commandId: randomUUID(),
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        command: { type: "task.steer", text: input.text },
      });
    },
  );
  ipcMain.handle(
    "task.approval",
    async (
      event,
      input: DesktopPreloadApi["tasks"] extends { approval: (value: infer T) => unknown }
        ? T
        : never,
    ) => {
      assertTrustedRenderer(event);
      assertTaskId(input.taskId);
      if (typeof input.approvalId !== "string" || input.approvalId.length === 0)
        throw new Error("Invalid approval id.");
      if (input.decision !== "approve" && input.decision !== "deny")
        throw new Error("Invalid approval decision.");
      if (!appServer) throw new AppServerUnavailableError();
      await appServer.send({
        v: 1,
        kind: "command",
        commandId: randomUUID(),
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        command: {
          type: "approval.respond",
          approvalId: input.approvalId,
          decision: input.decision,
        },
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
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
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
    if (browserTab)
      void enqueueBrowserOperation(() => readBrowserPage()).catch(() => {
        // A superseded navigation is expected during an explicit navigation race.
      });
  });
  window.contentView.addChildView(view);
  view.setBounds({ x: 360, y: 0, width: 840, height: 800 });
  view.setVisible(false);
  const nonce = randomUUID().replaceAll("-", "");
  void window.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        desktopShellHtml(
          nonce,
          process.env.CANDY_DESKTOP_RESPONSIVENESS === "1" ||
            process.env.CANDY_DESKTOP_LONG_RUNNING_SMOKE === "1",
          process.env.CANDY_DESKTOP_SMOKE === "1" ||
            process.env.CANDY_DESKTOP_RESPONSIVENESS === "1",
        ),
      ),
  );
  window.on("close", (event) => {
    if (!explicitQuit && classifyWindowClose(false) === "hide-to-tray") {
      event.preventDefault();
      window.hide();
    }
  });
  return window;
}

function desktopShellHtml(
  nonce: string,
  enableProbe = false,
  skipCredentialRefresh = false,
): string {
  const credentialStore = credentialStoreLabel(process.platform);
  const probeScript = enableProbe
    ? `const desktopProbe = window.__candyDesktopProbe = {
  taskUpdateCount: 0,
  updatesByTask: {},
  lastProjection: null,
  rendererReady: false,
  frameCount: 0,
  maxFrameGapMs: 0,
  lastFrameAt: performance.now(),
  active: false,
  reset() {
    this.taskUpdateCount = 0;
    this.updatesByTask = {};
    this.lastProjection = null;
    this.frameCount = 0;
    this.maxFrameGapMs = 0;
    this.lastFrameAt = performance.now();
    this.active = true;
  },
};
const recordFrame = (now) => {
  desktopProbe.frameCount += 1;
  if (desktopProbe.active) {
    if (desktopProbe.lastFrameAt !== null)
      desktopProbe.maxFrameGapMs = Math.max(desktopProbe.maxFrameGapMs, now - desktopProbe.lastFrameAt);
    desktopProbe.lastFrameAt = now;
  }
  requestAnimationFrame(recordFrame);
};
requestAnimationFrame(recordFrame);`
    : "const desktopProbe = null;";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><title>Candy</title>
<style>body{font:14px system-ui;margin:0;color:#202124;background:#f7f7f8}main{display:grid;grid-template-columns:360px 1fr;height:100vh}aside{padding:20px;border-right:1px solid #ddd;background:#fff;overflow:auto}section{padding:20px;overflow:auto}textarea,input{width:100%;box-sizing:border-box;margin:4px 0 8px;padding:7px}textarea{height:140px}button,select{margin:8px 4px 8px 0;padding:7px 10px}pre{white-space:pre-wrap;background:#fff;padding:12px;border:1px solid #ddd;border-radius:6px}.muted{color:#6b7280}.card{border:1px solid #ddd;border-radius:6px;padding:10px;margin:14px 0}.status{font-size:12px}</style></head>
 <body><main><aside><h1>Candy</h1><p class="muted">Local-first, one agent per task</p><div class="card"><strong>Local Workspace</strong><button id="chooseWorkspace">Choose folder</button><div id="workspacePath" class="muted">No workspace selected.</div></div><div class="card"><strong>Trusted credentials</strong><div><label for="deepseekKey">DeepSeek API key</label><input id="deepseekKey" type="password" autocomplete="off" placeholder="Stored in ${credentialStore}"><button id="saveDeepSeek">Save</button><button id="deleteDeepSeek">Delete</button><span id="deepseekStatus" class="status muted"></span></div><div><label for="minimaxKey">MiniMax Token Plan key</label><input id="minimaxKey" type="password" autocomplete="off" placeholder="Stored in ${credentialStore}"><button id="saveMiniMax">Save</button><button id="deleteMiniMax">Delete</button><span id="minimaxStatus" class="status muted"></span></div></div><div class="card"><strong>Optional validator</strong><label for="validatorExecutable">Absolute executable</label><input id="validatorExecutable" placeholder="e.g. /usr/bin/env"><label for="validatorArgs">Arguments as JSON array</label><input id="validatorArgs" placeholder='["npm","test"]' value="[]"><div class="muted">Runs without Candy provider credentials and with network denied.</div></div><label for="profile">Approval profile</label><select id="profile"><option value="read-only">Read-only</option><option value="auto">Auto (gated)</option></select><label for="model">Model</label><select id="model"><option value="deepseek-v4-flash">DeepSeek V4 Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option><option value="MiniMax-M3">MiniMax M3 (image)</option></select><textarea id="prompt" placeholder="Describe the coding task"></textarea><button id="attach">Attach image</button><span id="attachments" class="muted"></span><button id="create">Create task</button><div id="taskStatus"></div><div id="taskProgress" class="muted"></div><div id="taskActions"></div><button id="applyChanges" disabled>Apply changes</button><button id="discardWorktree" disabled>Discard worktree</button></aside><section><h2>Transcript</h2><div id="transcript" class="muted">No task selected.</div><h2>Changed files</h2><pre id="diff">No diff yet.</pre></section></main>
<script nonce="${nonce}">
(() => {
  ${probeScript}
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
  const evidenceSummary = document.createElement('pre');
  evidenceSummary.className = 'muted';
  evidenceSummary.id = 'taskEvidence';
  evidenceSummary.textContent = 'No validator evidence yet.';
  taskActions.after(evidenceSummary);
  const steeringInput = document.createElement('input');
  steeringInput.placeholder = 'Steer the next agent turn';
  const steerButton = document.createElement('button');
  steerButton.textContent = 'Steer next turn';
  const controlButtons = document.createElement('div');
  taskActions.append(steeringInput, steerButton, controlButtons);
  const applyChanges = document.getElementById('applyChanges');
  const discardWorktree = document.getElementById('discardWorktree');
  const transcript = document.getElementById('transcript');
  const diff = document.getElementById('diff');
  const browserCard = document.createElement('div');
  browserCard.className = 'card';
  browserCard.innerHTML = '<strong>Browser Workspace</strong><label for="browserHost">Allowed site host</label><input id="browserHost" placeholder="localhost:3000"><button id="allowBrowserSite">Allow site</button><label for="browserUrl">Visible page URL</label><input id="browserUrl" placeholder="https://example.com"><button id="openBrowser">Open</button><button id="navigateBrowser">Agent navigate</button><label for="browserTarget">Agent selector</label><input id="browserTarget" placeholder="#search"><label for="browserTextInput">Agent text</label><input id="browserTextInput"><button id="browserClick">Agent click</button><button id="browserType">Agent type</button><button id="browserSubmit">Agent submit (confirm)</button><button id="browserScreenshot">Capture screenshot</button><button id="takeBrowserControl">Take Control</button><button id="returnBrowserControl">Return to agent</button><div id="browserStatus" class="status muted">No browser tab.</div><pre id="browserText">No browser page.</pre>';
  document.querySelector('aside').append(browserCard);
  const browserHost = browserCard.querySelector('#browserHost');
  const browserUrl = browserCard.querySelector('#browserUrl');
  const browserStatus = browserCard.querySelector('#browserStatus');
  const browserText = browserCard.querySelector('#browserText');
  const browserTarget = browserCard.querySelector('#browserTarget');
  const browserTextInput = browserCard.querySelector('#browserTextInput');
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
  const browserAction = async (type) => { if (!currentBrowser) return; try { showBrowser(await window.candy.browser.act({ type, target: browserTarget.value.trim(), text: browserTextInput.value, confirmed: type === 'submit', expectedRevision: currentBrowser.revision })); } catch (error) { browserStatus.textContent = 'Browser action failed: ' + error.message; } };
  browserCard.querySelector('#browserClick').addEventListener('click', () => browserAction('click'));
  browserCard.querySelector('#browserType').addEventListener('click', () => browserAction('type'));
  browserCard.querySelector('#browserSubmit').addEventListener('click', () => browserAction('submit'));
  browserCard.querySelector('#browserScreenshot').addEventListener('click', async () => { try { showBrowser(await window.candy.browser.screenshot()); } catch (error) { browserStatus.textContent = 'Screenshot failed: ' + error.message; } });
  browserCard.querySelector('#takeBrowserControl').addEventListener('click', async () => { try { showBrowser(await window.candy.browser.takeControl()); } catch (error) { browserStatus.textContent = 'Take Control failed: ' + error.message; } });
  browserCard.querySelector('#returnBrowserControl').addEventListener('click', async () => { try { showBrowser(await window.candy.browser.returnControlToAgent()); } catch (error) { browserStatus.textContent = 'Return control failed: ' + error.message; } });
  window.candy.browser.onUpdate(showBrowser);
  const readValidator = () => { if (!validatorExecutable.value.trim()) return undefined; const args = JSON.parse(validatorArgs.value || '[]'); if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Validator args must be a JSON string array.'); return { executable: validatorExecutable.value.trim(), args }; };
  chooseWorkspace.addEventListener('click', async () => { try { showWorkspace(await window.candy.workspace.choose()); } catch (error) { taskStatus.textContent = 'Workspace failed: ' + error.message; } });
  document.getElementById('saveDeepSeek').addEventListener('click', () => saveCredential('deepseek').catch((error) => { taskStatus.textContent = error.message; }));
  document.getElementById('deleteDeepSeek').addEventListener('click', () => deleteCredential('deepseek').catch((error) => { taskStatus.textContent = error.message; }));
  document.getElementById('saveMiniMax').addEventListener('click', () => saveCredential('minimax-cn').catch((error) => { taskStatus.textContent = error.message; }));
  document.getElementById('deleteMiniMax').addEventListener('click', () => deleteCredential('minimax-cn').catch((error) => { taskStatus.textContent = error.message; }));
  void window.candy.workspace.current().then(showWorkspace); ${skipCredentialRefresh ? "" : "void refreshCredentials();"}
  const render = (projection) => {
    if (desktopProbe) {
      desktopProbe.taskUpdateCount += 1;
      desktopProbe.updatesByTask[projection.taskId] = (desktopProbe.updatesByTask[projection.taskId] || 0) + 1;
      desktopProbe.lastProjection = { taskId: projection.taskId, revision: projection.revision, renderedAt: Date.now() };
    }
    current = projection;
    taskStatus.textContent = projection.taskId + ' · ' + projection.state + ' · revision ' + projection.revision + ' · ' + (projection.workspaceState === 'worktree' ? 'Task Worktree' : 'Local');
    taskProgress.textContent = projection.progress
      ? 'Run progress · round ' + projection.progress.rounds + ' · evidence ' + projection.progress.evidenceCount + ' · ' + projection.progress.stopReason
      : '';
    evidenceSummary.textContent = projection.progress?.evidenceSummary || 'No validator evidence yet.';
    transcript.textContent = projection.transcript.map((entry) => entry.role.toUpperCase() + ': ' + entry.text).join('\\n') || 'No transcript yet.';
    diff.textContent = projection.changedFiles.length > 0
      ? 'Changed files:\\n' + projection.changedFiles.join('\\n') + '\\n\\nDiff:\\n' + (projection.diff || '(no tracked patch)') + (projection.diffTruncated ? '\\n\\nDiff is truncated; Apply is unavailable until the workspace is reviewed in smaller changes.' : '')
      : 'No diff yet.';
    applyChanges.disabled = !(projection.state === 'completed' && projection.workspaceState === 'worktree' && projection.changedFiles.length > 0 && projection.workspaceBaseline && !projection.diffTruncated);
    discardWorktree.disabled = !(projection.state === 'completed' && projection.workspaceState === 'worktree');
    controlButtons.replaceChildren();
    for (const type of ['task.run','task.pause','task.resume','task.cancel']) {
      const button = document.createElement('button');
      button.textContent = type.replace('task.','');
      button.addEventListener('click', () => send(type));
      controlButtons.append(button);
    }
    if (projection.state === 'waiting_approval' && projection.approvalId) {
      for (const decision of ['approve', 'deny']) {
        const button = document.createElement('button');
        button.textContent = decision;
        button.addEventListener('click', () => window.candy.tasks.approval({ taskId: projection.taskId, expectedRevision: projection.revision, approvalId: projection.approvalId, decision }).catch((error) => { taskStatus.textContent = 'Approval failed: ' + error.message; }));
        controlButtons.append(button);
      }
    }
  };
  create.addEventListener('click', async () => {
    if (!prompt.value.trim()) return;
    if (!workspace) { taskStatus.textContent = 'Choose a workspace first.'; return; }
    try { render(await window.candy.tasks.create(prompt.value, profile.value, model.value, attachmentIds, readValidator())); prompt.value = ''; attachmentIds = []; attachments.textContent = ''; } catch (error) { taskStatus.textContent = 'Create failed: ' + error.message; }
  });
  attach.addEventListener('click', async () => { const id = await window.candy.attachments.pickImage(); if (id) { attachmentIds.push(id); attachments.textContent = attachmentIds.length + ' image attached'; } });
  steerButton.addEventListener('click', async () => {
    if (!current || !steeringInput.value.trim()) return;
    try {
      await window.candy.tasks.steer({ taskId: current.taskId, expectedRevision: current.revision, text: steeringInput.value });
      steeringInput.value = '';
      taskStatus.textContent = 'Steering queued for the next agent turn.';
    } catch (error) { taskStatus.textContent = 'Steering failed: ' + error.message; }
  });
  const send = (type) => current && window.candy.tasks.send({ taskId: current.taskId, expectedRevision: current.revision, type }).catch((error) => { taskStatus.textContent = error.message; });
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
  if (desktopProbe) desktopProbe.rendererReady = true;
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
    else if (process.env.CANDY_DESKTOP_RESPONSIVENESS === "1")
      void runDesktopResponsivenessSmoke().catch((error: unknown) => {
        console.error(
          error instanceof Error ? error.message : "Desktop responsiveness smoke failed.",
        );
        app.exit(1);
      });
    else if (process.env.CANDY_DESKTOP_LONG_RUNNING_SMOKE === "1")
      void runDesktopLongRunningSmoke().catch((error: unknown) => {
        console.error(
          error instanceof Error ? error.message : "Desktop long-running smoke failed.",
        );
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

async function runDesktopLongRunningSmoke(): Promise<void> {
  if (!appServer || !mainWindow)
    throw new Error("Desktop long-running smoke requires the app-server and visible window.");
  const workspace = process.env.CANDY_LONG_RUNNING_WORKSPACE;
  if (workspace === undefined || !isAbsolute(workspace))
    throw new Error("Desktop long-running workspace is unavailable.");
  assertWorkspacePath(workspace);
  const validatorExecutable = process.env.CANDY_LONG_RUNNING_VALIDATOR_EXECUTABLE;
  const validatorArgsValue = process.env.CANDY_LONG_RUNNING_VALIDATOR_ARGS;
  if (validatorExecutable === undefined || !isAbsolute(validatorExecutable))
    throw new Error("Desktop long-running validator is unavailable.");
  let validatorArgs: unknown;
  try {
    validatorArgs = JSON.parse(validatorArgsValue ?? "[]");
  } catch {
    throw new Error("Desktop long-running validator arguments are invalid.");
  }
  const validator = { executable: validatorExecutable, args: validatorArgs };
  assertValidatorSpec(validator);
  selectedWorkspacePath = workspace;
  await waitForDesktopRenderer();

  const taskId = "desktop-long-running-smoke";
  const waiting = waitForDesktopEvent(
    taskId,
    (observation) =>
      observation.event.event.type === "snapshot" &&
      observation.event.event.snapshot.state === "waiting_approval",
  );
  await appServer.send(
    desktopCommand(taskId, "desktop-long-running-create", 0, {
      type: "task.create",
      prompt: "Candy packaged long-running fixture",
      approvalProfile: "auto",
      workspacePath: workspace,
      model: DEFAULT_CANDY_MODEL,
      attachmentIds: [],
      validator,
    }),
  );
  await appServer.send(desktopCommand(taskId, "desktop-long-running-run", 0, { type: "task.run" }));
  const waitingObservation = await waiting;
  if (waitingObservation.event.event.type !== "snapshot")
    throw new Error("Desktop long-running approval snapshot is unavailable.");
  const waitingSnapshot = waitingObservation.event.event.snapshot;
  if (waitingSnapshot.approvalId === undefined)
    throw new Error("Desktop long-running approval id is unavailable.");

  await executeRenderer(
    `window.candy.tasks.steer(${JSON.stringify({
      taskId,
      expectedRevision: waitingSnapshot.revision,
      text: "steer-next-turn",
    })})`,
  );
  const completed = waitForDesktopEvent(
    taskId,
    (observation) =>
      observation.event.event.type === "snapshot" &&
      observation.event.event.snapshot.state === "completed",
  );
  await executeRenderer(
    `window.candy.tasks.approval(${JSON.stringify({
      taskId,
      expectedRevision: waitingSnapshot.revision,
      approvalId: waitingSnapshot.approvalId,
      decision: "approve",
    })})`,
  );
  const completedObservation = await completed;
  if (completedObservation.event.event.type !== "snapshot")
    throw new Error("Desktop long-running completion snapshot is unavailable.");
  const completedSnapshot = completedObservation.event.event.snapshot;
  const deadline = Date.now() + 10_000;
  let rendered: { readonly status: string; readonly evidence: string; readonly transcript: string };
  for (;;) {
    rendered = await executeRenderer(
      "({ status: document.getElementById('taskStatus')?.textContent || '', evidence: document.getElementById('taskEvidence')?.textContent || '', transcript: document.getElementById('transcript')?.textContent || '' })",
    );
    if (
      rendered.status.includes("completed") &&
      rendered.evidence.includes("validator-pass") &&
      rendered.transcript.includes("steer-next-turn")
    )
      break;
    if (Date.now() >= deadline)
      throw new Error("Packaged Desktop did not project the final long-running evidence.");
    await delay(20);
  }
  console.log(
    `CANDY_LONG_RUNNING_RESULT ${JSON.stringify({
      state: completedSnapshot.state,
      approvalId: waitingSnapshot.approvalId,
      evidenceSummary: completedSnapshot.progress?.evidenceSummary,
      rendererEvidence: rendered.evidence,
      steeringProjected: rendered.transcript.includes("steer-next-turn"),
    })}`,
  );
  app.quit();
}

interface DesktopProbeSnapshot {
  readonly taskUpdateCount: number;
  readonly updatesByTask: Readonly<Record<string, number>>;
  readonly rendererReady: boolean;
  readonly lastProjection?: {
    readonly taskId: string;
    readonly revision: number;
    readonly renderedAt: number;
  } | null;
  readonly frameCount: number;
  readonly maxFrameGapMs: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function waitForDesktopEvent(
  taskId: string,
  predicate: (observation: DesktopEventObservation) => boolean,
  timeoutMs = 10_000,
): Promise<DesktopEventObservation> {
  return new Promise((resolve, reject) => {
    const listener: DesktopEventListener = (observation) => {
      if (observation.event.taskId !== taskId || !predicate(observation)) return;
      globalThis.clearTimeout(timeout);
      desktopEventListeners.delete(listener);
      resolve(observation);
    };
    const timeout = globalThis.setTimeout(() => {
      desktopEventListeners.delete(listener);
      reject(new Error("Desktop responsiveness fixture did not emit the expected Runtime event."));
    }, timeoutMs);
    desktopEventListeners.add(listener);
  });
}

async function executeRenderer<T>(script: string): Promise<T> {
  if (!mainWindow) throw new Error("Desktop responsiveness renderer is unavailable.");
  return (await mainWindow.webContents.executeJavaScript(script, true)) as T;
}

async function waitForDesktopRenderer(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (
        await executeRenderer<boolean>(
          "Boolean(window.__candyDesktopProbe?.rendererReady && document.getElementById('taskStatus'))",
        )
      )
        return;
    } catch {
      // The data URL renderer may still be loading.
    }
    await delay(20);
  }
  throw new Error("Desktop responsiveness renderer did not become visible.");
}

async function readDesktopProbe(): Promise<DesktopProbeSnapshot> {
  const probe = await executeRenderer<DesktopProbeSnapshot | null>(
    "window.__candyDesktopProbe ? JSON.parse(JSON.stringify(window.__candyDesktopProbe)) : null",
  );
  if (probe === null) throw new Error("Desktop responsiveness probe is unavailable.");
  return probe;
}

async function resetDesktopProbe(): Promise<void> {
  await executeRenderer("window.__candyDesktopProbe.reset(); true");
}

async function waitForRenderedProjection(taskId: string, revision: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const probe = await readDesktopProbe();
    if (
      probe.lastProjection?.taskId === taskId &&
      probe.lastProjection.revision === revision &&
      Number.isSafeInteger(probe.lastProjection.renderedAt)
    )
      return probe.lastProjection.renderedAt;
    await delay(5);
  }
  const probe = await readDesktopProbe();
  throw new Error(
    `Desktop responsiveness fixture did not render the expected projection (${probe.lastProjection?.taskId ?? "none"}/${probe.lastProjection?.revision ?? "none"}).`,
  );
}

function responsivenessWorkspace(): string {
  const workspace = process.env.CANDY_RESPONSIVENESS_WORKSPACE;
  if (workspace === undefined || !isAbsolute(workspace))
    throw new Error("Desktop responsiveness workspace is unavailable.");
  assertWorkspacePath(workspace);
  return workspace;
}

function responsivenessFixtureRoot(): string {
  const fixtureRoot = process.env.CANDY_RESPONSIVENESS_FIXTURE_ROOT;
  if (fixtureRoot === undefined || !isAbsolute(fixtureRoot))
    throw new Error("Desktop responsiveness fixture root is unavailable.");
  return fixtureRoot;
}

function responsivenessNode(): string {
  const node = process.env.CANDY_RESPONSIVENESS_NODE;
  if (node === undefined || !isAbsolute(node))
    throw new Error("Desktop responsiveness Node runtime is unavailable.");
  return node;
}

function desktopCommand(
  taskId: string,
  commandId: string,
  expectedRevision: number,
  command: CommandEnvelope["command"],
): CommandEnvelope {
  return { v: 1, kind: "command", commandId, taskId, expectedRevision, command };
}

async function createResponsivenessTask(
  taskId: string,
  approvalProfile: "read-only" | "auto",
  validator?: ValidatorSpec,
): Promise<DesktopEventObservation> {
  if (!appServer) throw new Error("Desktop responsiveness app-server is unavailable.");
  const snapshot = waitForDesktopEvent(
    taskId,
    (observation) => observation.event.event.type === "snapshot",
  );
  await appServer.send(
    desktopCommand(taskId, `${taskId}-create`, 0, {
      type: "task.create",
      prompt: "Candy deterministic responsiveness fixture",
      approvalProfile,
      workspacePath: responsivenessWorkspace(),
      model: DEFAULT_CANDY_MODEL,
      attachmentIds: [],
      ...(validator === undefined ? {} : { validator }),
    }),
  );
  return snapshot;
}

async function readFixtureFile(filePath: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await delay(10);
    }
  }
  throw new Error("Desktop responsiveness process fixture did not become ready.");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return Date.now();
    await delay(10);
  }
  throw new Error("Desktop responsiveness task-owned process fixture did not terminate.");
}

async function runDesktopResponsivenessSmoke(): Promise<void> {
  if (!appServer || !mainWindow)
    throw new Error("Desktop responsiveness requires the app-server and visible window.");
  const responsivenessAppServer = appServer;
  if (process.env.CANDY_DETERMINISTIC_RECOVERY_SMOKE !== "1")
    throw new Error("Desktop responsiveness requires the deterministic app-server fixture.");
  const workspace = responsivenessWorkspace();
  const fixtureRoot = responsivenessFixtureRoot();
  const node = responsivenessNode();
  if (!(await stat(workspace)).isDirectory())
    throw new Error("Desktop responsiveness workspace is not a directory.");
  selectedWorkspacePath = workspace;
  await waitForDesktopRenderer();

  const projectionSamples: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const taskId = `desktop-responsiveness-projection-${index}`;
    const snapshot = await createResponsivenessTask(taskId, "read-only");
    const renderedAt = await waitForRenderedProjection(
      taskId,
      snapshot.event.event.type === "snapshot" ? snapshot.event.event.snapshot.revision : 0,
    );
    projectionSamples.push(Math.max(0, renderedAt - snapshot.receivedAt));
  }

  const cancellationChildScript = [
    "const fs = require('node:fs');",
    "const heartbeat = process.argv[1];",
    "const beat = () => { try { fs.writeFileSync(heartbeat, String(Date.now())); } catch {} };",
    "beat(); setInterval(beat, 25);",
  ].join(" ");
  const cancellationValidatorScript = [
    "const cp = require('node:child_process');",
    "const fs = require('node:fs');",
    "const validatorPidFile = process.argv[1];",
    "const pidFile = process.argv[2];",
    "const readyFile = process.argv[3];",
    "const heartbeat = process.argv[4];",
    "const childScript = process.argv[5];",
    "const child = cp.spawn(process.execPath, ['-e', childScript, heartbeat], { stdio: 'ignore' });",
    "if (!child.pid) process.exit(2);",
    "fs.writeFileSync(validatorPidFile, String(process.pid));",
    "fs.writeFileSync(pidFile, String(child.pid));",
    "fs.writeFileSync(readyFile, 'ready');",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const cancellationSamples: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const taskId = `desktop-responsiveness-cancel-${index}`;
    const validatorPidFile = join(fixtureRoot, `cancel-${index}.validator.pid`);
    const pidFile = join(fixtureRoot, `cancel-${index}.pid`);
    const readyFile = join(fixtureRoot, `cancel-${index}.ready`);
    const heartbeatFile = join(fixtureRoot, `cancel-${index}.heartbeat`);
    const validator: ValidatorSpec = {
      executable: node,
      args: [
        "-e",
        cancellationValidatorScript,
        validatorPidFile,
        pidFile,
        readyFile,
        heartbeatFile,
        cancellationChildScript,
      ],
    };
    await createResponsivenessTask(taskId, "auto", validator);
    const started = waitForDesktopEvent(
      taskId,
      (observation) => observation.event.event.type === "tool.started",
    );
    await appServer.send(desktopCommand(taskId, `${taskId}-run`, 0, { type: "task.run" }));
    await started;
    await readFixtureFile(readyFile);
    const validatorPid = Number.parseInt(await readFixtureFile(validatorPidFile), 10);
    const pid = Number.parseInt(await readFixtureFile(pidFile), 10);
    if (
      !Number.isSafeInteger(validatorPid) ||
      !Number.isSafeInteger(pid) ||
      !isProcessAlive(validatorPid) ||
      !isProcessAlive(pid)
    )
      throw new Error("Desktop responsiveness process fixture ended before cancellation.");
    const cancelled = waitForDesktopEvent(
      taskId,
      (observation) =>
        observation.event.event.type === "snapshot" &&
        observation.event.event.snapshot.state === "cancelled",
    );
    const cancelStartedAt = Date.now();
    const cancelRequest = executeRenderer<void>(
      `window.candy.tasks.send(${JSON.stringify({ taskId, expectedRevision: 1, type: "task.cancel" })})`,
    );
    const [childTerminatedAt, validatorTerminatedAt] = await Promise.all([
      waitForProcessGone(pid, 5_000),
      waitForProcessGone(validatorPid, 5_000),
    ]);
    const terminatedAt = Math.max(childTerminatedAt, validatorTerminatedAt);
    await cancelRequest;
    await cancelled;
    cancellationSamples.push(Math.max(0, terminatedAt - cancelStartedAt));
  }

  const fixtureUrl = process.env.CANDY_BROWSER_FIXTURE_URL;
  if (fixtureUrl === undefined)
    throw new Error("Desktop responsiveness Browser fixture is unavailable.");
  const browserUrl = new URL(fixtureUrl);
  browserHosts.add(browserUrl.host.toLowerCase());
  await executeRenderer(`window.candy.browser.allowSite(${JSON.stringify(browserUrl.host)}); true`);
  await executeRenderer(`window.candy.browser.open(${JSON.stringify(fixtureUrl)})`);
  const browserSamples: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const current = await executeRenderer<{ readonly control?: unknown }>(
      "window.candy.browser.observe()",
    );
    if (current.control === "user")
      await executeRenderer("window.candy.browser.returnControlToAgent()");
    const result = await executeRenderer<{
      readonly rejected?: unknown;
      readonly elapsed?: unknown;
    }>(
      `
        (async () => {
          const startedAt = Date.now();
          const user = await window.candy.browser.takeControl();
          try {
            await window.candy.browser.act({ type: 'click', target: '#fixture-click', expectedRevision: user.revision });
            return { rejected: false, elapsed: Date.now() - startedAt };
          } catch {
            return { rejected: true, elapsed: Date.now() - startedAt };
          }
        })()
      `,
    );
    if (
      result.rejected !== true ||
      typeof result.elapsed !== "number" ||
      !Number.isSafeInteger(result.elapsed)
    )
      throw new Error("Desktop responsiveness Browser action was not disabled after Take Control.");
    browserSamples.push(result.elapsed);
    await executeRenderer("window.candy.browser.returnControlToAgent()");
  }

  const concurrencySamples: {
    readonly maxFrameGapMs: number;
    readonly frameCount: number;
    readonly expectedEventCount: number;
    readonly renderedProjectionCount: number;
    readonly expectedByTask: readonly number[];
    readonly renderedByTask: readonly number[];
    readonly eventLoss: boolean;
  }[] = [];
  const concurrencyValidator: ValidatorSpec = {
    executable: node,
    args: ["-e", "setTimeout(() => {}, 350);"],
  };
  for (let round = 0; round < 10; round += 1) {
    const taskIds = [0, 1, 2].map((task) => `desktop-responsiveness-concurrency-${round}-${task}`);
    for (const taskId of taskIds)
      await createResponsivenessTask(taskId, "auto", concurrencyValidator);
    await resetDesktopProbe();
    const expectedByTask = new Map(taskIds.map((taskId) => [taskId, 0]));
    const listener: DesktopEventListener = (observation) => {
      if (expectedByTask.has(observation.event.taskId))
        expectedByTask.set(
          observation.event.taskId,
          expectedByTask.get(observation.event.taskId)! + 1,
        );
    };
    desktopEventListeners.add(listener);
    try {
      const completed = taskIds.map((taskId) =>
        waitForDesktopEvent(
          taskId,
          (observation) =>
            observation.event.event.type === "snapshot" &&
            observation.event.event.snapshot.state === "completed",
        ),
      );
      await Promise.all(
        taskIds.map((taskId) =>
          responsivenessAppServer.send(
            desktopCommand(taskId, `${taskId}-run`, 0, { type: "task.run" }),
          ),
        ),
      );
      await Promise.all(completed);
      await delay(100);
      const probe = await readDesktopProbe();
      const expected = taskIds.map((taskId) => expectedByTask.get(taskId) ?? 0);
      const rendered = taskIds.map((taskId) => probe.updatesByTask[taskId] ?? 0);
      const eventLoss = expected.some((count, index) => count !== rendered[index]);
      if (probe.frameCount < 2)
        throw new Error("Desktop responsiveness frame probe did not sample frames.");
      concurrencySamples.push({
        maxFrameGapMs: Math.round(probe.maxFrameGapMs),
        frameCount: probe.frameCount,
        expectedEventCount: expected.reduce((total, count) => total + count, 0),
        renderedProjectionCount: probe.taskUpdateCount,
        expectedByTask: expected,
        renderedByTask: rendered,
        eventLoss,
      });
    } finally {
      desktopEventListeners.delete(listener);
    }
  }

  console.log(
    `CANDY_RESPONSIVENESS_RESULT ${JSON.stringify({
      runtimeProjectionMs: projectionSamples,
      cancellationProcessTreeMs: cancellationSamples,
      browserTakeControlMs: browserSamples,
      concurrency: concurrencySamples,
    })}`,
  );
  app.quit();
}

async function runBrowserSmoke(): Promise<void> {
  const fixtureUrl = process.env.CANDY_BROWSER_FIXTURE_URL;
  if (!fixtureUrl || !browserView) throw new Error("Browser smoke fixture is unavailable.");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  const fixture = parseCandyBrowserUrl(fixtureUrl);
  const expectBrowserRejection = async (
    operation: () => unknown | Promise<unknown>,
    message: string,
  ): Promise<void> => {
    let rejected = false;
    try {
      await operation();
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(message);
  };
  await expectBrowserRejection(
    () => openBrowserUrl("http://example.com/"),
    "Browser accepted non-loopback HTTP.",
  );
  await expectBrowserRejection(
    () => openBrowserUrl("https://user:password@example.com/"),
    "Browser accepted URL credentials.",
  );
  await expectBrowserRejection(
    () => openBrowserUrl("https://not-allowed.example/"),
    "Browser opened a site without explicit authorization.",
  );
  await expectBrowserRejection(
    () => openBrowserUrl("javascript:document.body.innerHTML='escaped'"),
    "Browser accepted a script URL.",
  );
  for (const action of [
    null,
    { type: "click", target: "", expectedRevision: 0 },
    { type: "click", target: "\0", expectedRevision: 0 },
    { type: "click", target: "x".repeat(513), expectedRevision: 0 },
    { type: "type", target: "#x", text: "contains\0nul", expectedRevision: 0 },
    { type: "navigate", url: 123, expectedRevision: 0 },
  ])
    await expectBrowserRejection(
      () => assertBrowserAction(action),
      "Browser accepted a malformed structured action.",
    );
  browserHosts.add(fixture.host.toLowerCase());
  const opened = await openBrowserUrl(fixtureUrl);
  if (!opened.text.includes("Candy browser fixture"))
    throw new Error("Browser fixture text was not observed.");
  if (
    process.env.CANDY_BROWSER_ADVERSARIAL === "1" &&
    !opened.text.includes("UNTRUSTED PAGE INSTRUCTION")
  )
    throw new Error("Browser prompt-injection fixture text was not observed as untrusted content.");
  if (process.env.CANDY_BROWSER_ADVERSARIAL === "1") {
    const promptTrap = await browserView.webContents.executeJavaScript(
      "window.__promptInjectionTriggered === true",
      true,
    );
    if (promptTrap === true)
      throw new Error(
        "Browser prompt-injection text triggered an action without an explicit request.",
      );
    await expectBrowserRejection(
      () =>
        actInBrowser({
          type: "click",
          target: "javascript:document.body.innerHTML='injected'",
          expectedRevision: opened.revision,
        }),
      "Browser accepted a hostile selector target.",
    );
  }
  const clicked = await actInBrowser({
    type: "click",
    target: "#fixture-click",
    expectedRevision: opened.revision,
  });
  if (!clicked.text.includes("clicked")) throw new Error("Browser click action was not observed.");
  const typed = await actInBrowser({
    type: "type",
    target: "#fixture-input",
    text: "typed-fixture",
    expectedRevision: clicked.revision,
  });
  if (!typed.text.includes("typed-fixture"))
    throw new Error("Browser type action was not observed.");
  let confirmationRejected = false;
  try {
    await actInBrowser({
      type: "submit",
      target: "#fixture-form",
      confirmed: false,
      expectedRevision: typed.revision,
    });
  } catch {
    confirmationRejected = true;
  }
  if (!confirmationRejected)
    throw new Error("Browser sensitive action was not confirmation-gated.");
  const submitted = await actInBrowser({
    type: "submit",
    target: "#fixture-form",
    confirmed: true,
    expectedRevision: typed.revision,
  });
  if (!submitted.text.includes("submitted"))
    throw new Error("Browser submit action was not observed.");
  await expectBrowserRejection(
    () =>
      actInBrowser({
        type: "click",
        target: "#missing-fixture-target",
        expectedRevision: submitted.revision,
      }),
    "Browser accepted a missing selector.",
  );
  await expectBrowserRejection(
    () =>
      actInBrowser({
        type: "click",
        target: "[",
        expectedRevision: submitted.revision,
      }),
    "Browser accepted an invalid CSS selector.",
  );
  await expectBrowserRejection(
    () =>
      actInBrowser({
        type: "type",
        target: "#fixture-form",
        text: "wrong-target",
        expectedRevision: submitted.revision,
      }),
    "Browser typed into a non-field target.",
  );
  await expectBrowserRejection(
    () =>
      actInBrowser({
        type: "submit",
        target: "#fixture-status",
        confirmed: true,
        expectedRevision: submitted.revision,
      }),
    "Browser submitted a non-submit target.",
  );
  let staleRejected = false;
  try {
    await actInBrowser({
      type: "click",
      target: "#fixture-click",
      expectedRevision: opened.revision,
    });
  } catch {
    staleRejected = true;
  }
  if (!staleRejected) throw new Error("Browser stale action was not rejected.");
  if (process.env.CANDY_BROWSER_ADVERSARIAL === "1") {
    const race = await executeRenderer<
      readonly {
        readonly status: "fulfilled" | "rejected";
        readonly url?: unknown;
        readonly revision?: unknown;
      }[]
    >(
      `(async () => {
        const current = await window.candy.browser.observe();
        const results = await Promise.allSettled([
          window.candy.browser.navigate(${JSON.stringify(`${fixture.origin}/race-slow`)}, current.revision),
          window.candy.browser.navigate(${JSON.stringify(`${fixture.origin}/race-fast`)}, current.revision),
        ]);
        return results.map((result) => result.status === 'fulfilled'
          ? { status: result.status, url: result.value.url, revision: result.value.revision }
          : { status: result.status });
      })()`,
    );
    const accepted = race.filter((result) => result.status === "fulfilled");
    if (
      accepted.length !== 1 ||
      accepted[0]?.url !== `${fixture.origin}/race-slow` ||
      accepted[0]?.revision !== submitted.revision + 1
    )
      throw new Error("Browser navigation race did not consume one observation revision.");
    const restored = await openBrowserUrl(fixtureUrl);
    const inFlight = actInBrowser({
      type: "click",
      target: "#fixture-click",
      expectedRevision: restored.revision,
    });
    const user = updateBrowserControl("user");
    const ownershipRace = await Promise.allSettled([inFlight]);
    if (ownershipRace[0]?.status !== "rejected" || user.control !== "user")
      throw new Error("Browser action survived an explicit Take Control ownership transfer.");
    updateBrowserControl("agent");
  }
  const screenshot = await captureBrowserScreenshot();
  if (!screenshot.screenshotAttachmentId?.startsWith("att_"))
    throw new Error("Browser screenshot was not stored as an attachment.");
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
  let userOwnedRejected = false;
  try {
    await actInBrowser({
      type: "click",
      target: "#fixture-click",
      expectedRevision: user.revision,
    });
  } catch {
    userOwnedRejected = true;
  }
  const agent = updateBrowserControl("agent");
  if (
    !browserPopupDenied ||
    !browserNavigationDenied ||
    !browserDownloadPrevented ||
    !browserPermissionDenied ||
    !userOwnedRejected ||
    user.control !== "user" ||
    agent.control !== "agent" ||
    agent.revision <= user.revision
  )
    throw new Error(
      `Browser security or explicit Take Control smoke failed: navigation=${browserNavigationDenied}, popup=${browserPopupDenied}, permission=${browserPermissionDenied}, download=${browserDownloadPrevented}, user=${user.control}, agent=${agent.control}`,
    );
  if (
    process.env.CANDY_BROWSER_ADVERSARIAL === "1" &&
    (await browserView.webContents.executeJavaScript(
      "window.__promptInjectionTriggered === true",
      true,
    ))
  )
    throw new Error("Browser prompt-injection trap was activated without an explicit action.");
  if (process.env.CANDY_BROWSER_ADVERSARIAL === "1" && appServer?.browserSmokeMarkerSeen)
    throw new Error("Browser page content appeared in the app-server protocol stream.");
  const platformLabel = process.platform === "darwin" ? "macOS" : "Windows";
  console.log(
    `packaged ${platformLabel} Browser Workspace smoke ok: allowlist, typed actions, adversarial rejection, navigation, popup, permission, download, and Take Control`,
  );
  app.quit();
}

if (app.isPackaged || process.env.CANDY_DESKTOP_RUN === "1") startDesktop();
