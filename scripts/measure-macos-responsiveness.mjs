import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("macOS responsiveness measurement requires macOS arm64.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tuiEntrypoint = path.join(root, "apps", "tui", "dist", "main.js");
const desktopEntrypoint = path.join(root, "apps", "desktop", "dist", "main.js");
const appServerEntrypoint = path.join(root, "apps", "app-server", "dist", "main.js");
if (
  !existsSync(tuiEntrypoint) ||
  !existsSync(desktopEntrypoint) ||
  !existsSync(appServerEntrypoint)
)
  throw new Error("Build the TypeScript packages before measuring macOS responsiveness.");

const electronModule = await import("electron");
const electronExecutable = electronModule.default ?? electronModule;
if (typeof electronExecutable !== "string" || !path.isAbsolute(electronExecutable))
  throw new Error("Electron executable path is unavailable.");

const runs = 10;
const tui = await measure(() =>
  runProcess(
    process.execPath,
    [tuiEntrypoint, "--smoke"],
    root,
    cleanChildEnvironment(process.env),
  ),
);
const desktopEnvironment = cleanChildEnvironment(process.env);
desktopEnvironment.CANDY_DESKTOP_RUN = "1";
desktopEnvironment.CANDY_DESKTOP_SMOKE = "1";
desktopEnvironment.CANDY_DEV_APP_SERVER_NODE = process.execPath;
desktopEnvironment.CANDY_DEV_APP_SERVER_ENTRY = appServerEntrypoint;
const desktop = await measure(() =>
  runProcess(electronExecutable, [desktopEntrypoint], root, desktopEnvironment),
);

const revision = runCapture("git", ["rev-parse", "HEAD"]);
const lockfileDigest = createHash("sha256")
  .update(await readFile(path.join(root, "package-lock.json")))
  .digest("hex");
const macosVersion = runCapture("/usr/bin/sw_vers", ["-productVersion"]);
const architecture = runCapture("/usr/bin/uname", ["-m"]);
const tuiPass = tui.p95 <= 2_000;
const desktopPass = desktop.p95 <= 5_000;
const subsetPass = tuiPass && desktopPass;
const report = [
  "# Candy macOS Apple Silicon Responsiveness Measurement",
  "",
  `- Timestamp: ${new Date().toISOString()}`,
  `- Source revision: \`${revision}\``,
  `- Lockfile SHA-256: \`${lockfileDigest}\``,
  `- macOS product version: \`${macosVersion}\``,
  `- Architecture: \`${architecture}\``,
  `- Node: \`${process.version}\``,
  "- Electron runtime: `43.2.0` local deterministic smoke",
  `- Runs per measured metric: ${runs}`,
  "",
  "This is the ten-run macOS deterministic cold-start subset. It excludes provider and public-network latency and does not claim complete ACC-12 or final V1 acceptance.",
  "",
  "| Metric | Target | p95 | Result | Samples (ms) |",
  "| --- | ---: | ---: | --- | --- |",
  `| TUI cold start to usable smoke prompt | <= 2000 ms | ${tui.p95} ms | ${tuiPass ? "Pass" : "Fail"} | ${tui.samples.join(", ")} |`,
  `| Desktop cold start to task-list smoke | <= 5000 ms | ${desktop.p95} ms | ${desktopPass ? "Pass" : "Fail"} | ${desktop.samples.join(", ")} |`,
  "",
  "## Not measured by this deterministic subset",
  "",
  "- Local Runtime event to visible UI projection p95.",
  "- User cancellation to provider stream stop request.",
  "- User cancellation to task-owned process-tree termination as a ten-run acceptance metric.",
  "- Browser Take Control to disabled agent action.",
  "- Three concurrent tasks presentation freeze and event-loss matrix.",
  "",
].join("\n");

const outputRoot = path.join(root, "out", "acceptance", "macos");
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, "responsiveness-latest.md"), report, "utf8");
console.log(
  `macOS responsiveness subset ${subsetPass ? "passed" : "failed"}: TUI p95=${tui.p95} ms, Desktop p95=${desktop.p95} ms; report=out/acceptance/macos/responsiveness-latest.md`,
);
if (!subsetPass) process.exitCode = 1;

async function measure(operation) {
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(Math.round(performance.now() - started));
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return { samples, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

function runProcess(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`measurement process failed: ${code ?? "null"}/${signal ?? "signal"}`));
    });
  });
}

function runCapture(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
