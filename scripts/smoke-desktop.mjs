import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopEntrypoint = path.join(root, "apps", "desktop", "dist", "main.js");
const appServerEntrypoint = path.join(root, "apps", "app-server", "dist", "main.js");
if (!existsSync(desktopEntrypoint) || !existsSync(appServerEntrypoint))
  throw new Error("Desktop smoke requires the TypeScript build outputs.");

const electronModule = await import("electron");
const electronExecutable = electronModule.default ?? electronModule;
if (typeof electronExecutable !== "string" || !path.isAbsolute(electronExecutable))
  throw new Error("Electron executable path is unavailable.");

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-desktop-macos-"));
const home = path.join(fixtureRoot, "home");
const temporary = path.join(fixtureRoot, "tmp");
const appData = path.join(fixtureRoot, "app-data");
await mkdir(home, { recursive: true });
await mkdir(temporary, { recursive: true });
await mkdir(appData, { recursive: true });
const environment = cleanChildEnvironment(process.env);
environment.HOME = home;
environment.TMPDIR = temporary;
environment.CANDY_APP_DATA_ROOT = appData;
environment.CANDY_DESKTOP_RUN = "1";
environment.CANDY_DESKTOP_SMOKE = "1";
environment.CANDY_DEV_APP_SERVER_NODE = process.execPath;
environment.CANDY_DEV_APP_SERVER_ENTRY = appServerEntrypoint;

const child = spawn(electronExecutable, [desktopEntrypoint], {
  cwd: root,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timeout = globalThis.setTimeout(() => child.kill("SIGTERM"), 10_000);
try {
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (exit.code !== 0) {
    throw new Error(
      `Desktop smoke exited with code ${exit.code ?? "null"} (${exit.signal ?? "no signal"}): ${stderr}`,
    );
  }
  console.log("desktop app-server JSONL smoke ok");
} finally {
  globalThis.clearTimeout(timeout);
  if (child.exitCode === null) child.kill("SIGTERM");
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
