import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { app, BrowserWindow, ipcMain, session, WebContentsView } from "electron";
import {
  cleanChildEnvironment,
  KeyringCredentialStore,
  resolveAppPaths,
  type CredentialName,
} from "@candy/platform";
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
    };
  }
  if (event.event.type === "task.created")
    return { ...current, approvalProfile: event.event.approvalProfile };
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
  ipcMain.handle("task.create", async (_event, prompt: unknown, profile: unknown) => {
    validatePrompt(prompt);
    if (profile !== "read-only" && profile !== "auto") throw new Error("Invalid approval profile.");
    const taskId = randomUUID().replaceAll("-", "");
    const projection = emptyProjection(taskId);
    projections.set(taskId, { ...projection, approvalProfile: profile });
    if (!appServer) throw new AppServerUnavailableError();
    await appServer.send({
      v: 1,
      kind: "command",
      commandId: randomUUID(),
      taskId,
      expectedRevision: 0,
      command: { type: "task.create", prompt, approvalProfile: profile },
    });
    return projections.get(taskId) ?? projection;
  });
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
      partition: "persist:candy-browser-v1",
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.js"),
    },
  });
  const browserView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.contentView.addChildView(browserView);
  browserView.setBounds({ x: 360, y: 0, width: 840, height: 800 });
  void window.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'\"><body><h1>Candy</h1><p>Local-first task client</p></body>",
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

export function configureCandyBrowserSession(): void {
  const paths = resolveAppPaths(app.getPath("userData"));
  void paths;
  const browserSession = session.fromPartition("persist:candy-browser-v1");
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  browserSession.setPermissionCheckHandler(() => false);
}

export function startDesktop(): void {
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
