import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
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
const nativeRunner = path.join(
  root,
  "native",
  "sandbox-runner",
  "target",
  "debug",
  "candy-sandbox-runner",
);
if (!existsSync(nativeRunner))
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      path.join(root, "native", "sandbox-runner", "Cargo.toml"),
    ],
    { cwd: root, stdio: "inherit" },
  );
if (!existsSync(nativeRunner))
  throw new Error("macOS Sandbox Runner is unavailable for responsiveness measurement.");

const electronModule = await import("electron");
const electronExecutable = electronModule.default ?? electronModule;
if (typeof electronExecutable !== "string" || !path.isAbsolute(electronExecutable))
  throw new Error("Electron executable path is unavailable.");

const runs = 10;
const isolationRoot = await mkdtemp(path.join(tmpdir(), "candy-responsiveness-app-data-macos-"));
const isolationHome = path.join(isolationRoot, "home");
const isolationTemporary = path.join(isolationRoot, "tmp");
const isolationAppData = path.join(isolationRoot, "app-data");
await mkdir(isolationHome, { recursive: true });
await mkdir(isolationTemporary, { recursive: true });
await mkdir(isolationAppData, { recursive: true });
const isolatedEnvironment = () => {
  const environment = cleanChildEnvironment(process.env);
  environment.HOME = isolationHome;
  environment.TMPDIR = isolationTemporary;
  environment.CANDY_APP_DATA_ROOT = isolationAppData;
  return environment;
};
let tui;
let desktop;
try {
  tui = await measure(() =>
    runProcess(process.execPath, [tuiEntrypoint, "--smoke"], root, isolatedEnvironment()),
  );
  const desktopEnvironment = isolatedEnvironment();
  desktopEnvironment.CANDY_DESKTOP_RUN = "1";
  desktopEnvironment.CANDY_DESKTOP_SMOKE = "1";
  desktopEnvironment.CANDY_DEV_APP_SERVER_NODE = process.execPath;
  desktopEnvironment.CANDY_DEV_APP_SERVER_ENTRY = appServerEntrypoint;
  desktop = await measure(() =>
    runProcess(electronExecutable, [desktopEntrypoint], root, desktopEnvironment),
  );
} finally {
  await rm(isolationRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-responsiveness-macos-"));
const home = path.join(fixtureRoot, "home");
const temporary = path.join(fixtureRoot, "tmp");
const appData = path.join(fixtureRoot, "app-data");
const workspace = path.join(fixtureRoot, "workspace");
await mkdir(home, { recursive: true });
await mkdir(temporary, { recursive: true });
await mkdir(appData, { recursive: true });
await mkdir(workspace);
const browserFixtureServer = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    '<!doctype html><title>Candy responsiveness browser fixture</title><button id="fixture-click" type="button">Click fixture</button>',
  );
});

let desktopMetrics;
try {
  await new Promise((resolve) => browserFixtureServer.listen(0, "127.0.0.1", resolve));
  const address = browserFixtureServer.address();
  if (!address || typeof address === "string")
    throw new Error("Browser responsiveness fixture failed.");
  const fixtureUrl = `http://localhost:${address.port}/`;
  const responsivenessEnvironment = cleanChildEnvironment(process.env);
  responsivenessEnvironment.HOME = home;
  responsivenessEnvironment.TMPDIR = temporary;
  responsivenessEnvironment.CANDY_APP_DATA_ROOT = appData;
  responsivenessEnvironment.CANDY_DESKTOP_RUN = "1";
  responsivenessEnvironment.CANDY_DESKTOP_RESPONSIVENESS = "1";
  responsivenessEnvironment.CANDY_DETERMINISTIC_RECOVERY_SMOKE = "1";
  responsivenessEnvironment.CANDY_DEV_APP_SERVER_NODE = process.execPath;
  responsivenessEnvironment.CANDY_DEV_APP_SERVER_ENTRY = appServerEntrypoint;
  responsivenessEnvironment.CANDY_RESPONSIVENESS_NODE = process.execPath;
  responsivenessEnvironment.CANDY_RESPONSIVENESS_NATIVE_RUNNER = nativeRunner;
  responsivenessEnvironment.CANDY_RESPONSIVENESS_WORKSPACE = workspace;
  responsivenessEnvironment.CANDY_BROWSER_FIXTURE_URL = fixtureUrl;
  desktopMetrics = await runDesktopResponsiveness(
    electronExecutable,
    [desktopEntrypoint],
    root,
    responsivenessEnvironment,
  );
} finally {
  await new Promise((resolve) => browserFixtureServer.close(() => resolve()));
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

const revision = runCapture("git", ["rev-parse", "HEAD"]);
const lockfileDigest = createHash("sha256")
  .update(await readFile(path.join(root, "package-lock.json")))
  .digest("hex");
const macosVersion = runCapture("/usr/bin/sw_vers", ["-productVersion"]);
const architecture = runCapture("/usr/bin/uname", ["-m"]);
const tuiPass = tui.p95 <= 2_000;
const desktopPass = desktop.p95 <= 5_000;
const runtimeProjection = summarizeMetric(desktopMetrics.runtimeProjectionMs, 200);
const cancellationProcessTree = summarizeMetric(desktopMetrics.cancellationProcessTreeMs, 5_000);
const browserTakeControl = summarizeMetric(desktopMetrics.browserTakeControlMs, 500);
const concurrency = summarizeConcurrency(desktopMetrics.concurrency);
const subsetPass =
  tuiPass &&
  desktopPass &&
  runtimeProjection.pass &&
  cancellationProcessTree.pass &&
  browserTakeControl.pass &&
  concurrency.pass;
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
  "This is a ten-run macOS deterministic measurement of cold start and four local Desktop seams. It uses only Candy-owned temporary fixtures, does not access Provider or Keychain values, excludes provider and public-network latency, and does not claim complete ACC-12 or final V1 acceptance.",
  "",
  "| Metric | Target | p95 | Result | Samples (ms) |",
  "| --- | ---: | ---: | --- | --- |",
  `| TUI cold start to usable smoke prompt | <= 2000 ms | ${tui.p95} ms | ${tuiPass ? "Pass" : "Fail"} | ${tui.samples.join(", ")} |`,
  `| Desktop cold start to task-list smoke | <= 5000 ms | ${desktop.p95} ms | ${desktopPass ? "Pass" : "Fail"} | ${desktop.samples.join(", ")} |`,
  `| Runtime event to visible Desktop projection | <= 200 ms | ${runtimeProjection.p95} ms | ${runtimeProjection.pass ? "Pass" : "Fail"} | ${runtimeProjection.samples.join(", ")} |`,
  `| User cancellation to task-owned process-tree termination | <= 5000 ms | ${cancellationProcessTree.p95} ms | ${cancellationProcessTree.pass ? "Pass" : "Fail"} | ${cancellationProcessTree.samples.join(", ")} |`,
  `| Browser Take Control to disabled agent action | <= 500 ms | ${browserTakeControl.p95} ms | ${browserTakeControl.pass ? "Pass" : "Fail"} | ${browserTakeControl.samples.join(", ")} |`,
  `| Three concurrent tasks: renderer frame gap | <= 1000 ms and zero event loss | ${concurrency.frameGapP95} ms | ${concurrency.pass ? "Pass" : "Fail"} | ${concurrency.frameGapSamples.join(", ")} |`,
  "",
  "## Three-task event delivery",
  "",
  `- Expected/rendered Runtime projections per run (three tasks): ${concurrency.delivery.join("; ")}`,
  `- Event-loss runs: ${concurrency.eventLossRuns.length === 0 ? "none" : concurrency.eventLossRuns.join(", ")}`,
  "",
  "## Blocked or not measured by this deterministic subset",
  "",
  "- User cancellation to provider stream stop request remains Blocked because no real Provider stream is used.",
  "- Provider first-token/completion latency, public-network behavior, and complete ACC-12 UI/recovery evidence remain outside this deterministic fixture.",
  "",
].join("\n");

const outputRoot = path.join(root, "out", "acceptance", "macos");
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, "responsiveness-latest.md"), report, "utf8");
console.log(
  `macOS responsiveness subset ${subsetPass ? "passed" : "failed"}: TUI p95=${tui.p95} ms, Desktop p95=${desktop.p95} ms, projection p95=${runtimeProjection.p95} ms, cancellation p95=${cancellationProcessTree.p95} ms, Browser p95=${browserTakeControl.p95} ms, concurrency frame-gap p95=${concurrency.frameGapP95} ms; report=out/acceptance/macos/responsiveness-latest.md`,
);
if (!subsetPass) process.exitCode = 1;

function summarizeMetric(samples, target) {
  if (
    !Array.isArray(samples) ||
    samples.length !== runs ||
    samples.some((sample) => !Number.isSafeInteger(sample) || sample < 0)
  )
    throw new Error("Responsiveness fixture returned an invalid ten-run metric.");
  const sorted = [...samples].sort((left, right) => left - right);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  return { samples, p95, pass: p95 <= target };
}

function summarizeConcurrency(samples) {
  if (!Array.isArray(samples) || samples.length !== runs)
    throw new Error("Responsiveness fixture returned an invalid concurrency matrix.");
  const frameGapSamples = samples.map((sample) => sample.maxFrameGapMs);
  if (
    frameGapSamples.some((sample) => !Number.isSafeInteger(sample) || sample < 0) ||
    samples.some(
      (sample) =>
        sample.frameCount < 2 ||
        sample.expectedEventCount !== sample.renderedProjectionCount ||
        sample.eventLoss ||
        !sample.expectedByTask.every((count, index) => count === sample.renderedByTask[index]),
    )
  )
    throw new Error(
      "Responsiveness fixture reported concurrent-task event loss or an invalid frame sample.",
    );
  const sorted = [...frameGapSamples].sort((left, right) => left - right);
  const frameGapP95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  return {
    frameGapSamples,
    frameGapP95,
    pass: frameGapSamples.every((sample) => sample <= 1_000),
    eventLossRuns: samples
      .map((sample, index) => (sample.eventLoss ? index + 1 : undefined))
      .filter((index) => index !== undefined),
    delivery: samples.map(
      (sample) => `${sample.expectedByTask.join("/")}=>${sample.renderedByTask.join("/")}`,
    ),
  };
}

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

function runDesktopResponsiveness(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const terminate = (signal) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const timeout = globalThis.setTimeout(() => {
      terminate("SIGTERM");
      globalThis.setTimeout(() => terminate("SIGKILL"), 2_000).unref();
    }, 90_000);
    child.once("error", (error) => {
      globalThis.clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      globalThis.clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            `Desktop responsiveness process failed: ${code ?? "null"}/${signal ?? "signal"}: ${stderr.slice(-4_000)}`,
          ),
        );
        return;
      }
      const line = stdout
        .split(/\r?\n/u)
        .find((entry) => entry.startsWith("CANDY_RESPONSIVENESS_RESULT "));
      if (line === undefined) {
        reject(new Error("Desktop responsiveness process did not emit a sanitized result."));
        return;
      }
      try {
        resolve(JSON.parse(line.slice("CANDY_RESPONSIVENESS_RESULT ".length)));
      } catch {
        reject(new Error("Desktop responsiveness result was not valid JSON."));
      }
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
