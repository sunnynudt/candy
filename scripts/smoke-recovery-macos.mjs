import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { cleanChildEnvironment } from "@candy/platform";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("macOS recovery smoke skipped: not macOS arm64");
  process.exit(0);
}

const packaged = process.argv.includes("--packaged");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "out", "macos", "Candy.app", "Contents");
const runtimeExecutable = packaged
  ? path.join(bundle, "Resources", "node", "bin", "node")
  : process.execPath;
const appServer = packaged
  ? path.join(bundle, "Resources", "app-server", "main.js")
  : path.join(root, "apps", "app-server", "dist", "main.js");
const sandboxRunner = packaged
  ? path.join(bundle, "Resources", "native", "candy-sandbox-runner")
  : path.join(root, "native", "sandbox-runner", "target", "debug", "candy-sandbox-runner");

if (!existsSync(runtimeExecutable) || !existsSync(appServer))
  throw new Error("macOS recovery runtime is incomplete.");
if (!existsSync(sandboxRunner)) {
  if (packaged) throw new Error("Packaged macOS recovery Sandbox Runner is missing.");
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
}

const fixtureRoot = await mkdtemp(
  path.join(tmpdir(), packaged ? "candy-packaged-recovery-macos-" : "candy-recovery-macos-"),
);
const home = path.join(fixtureRoot, "home");
const temporary = path.join(fixtureRoot, "tmp");
const appData = path.join(fixtureRoot, "app-data");
const workspace = path.join(fixtureRoot, "workspace");
const marker = path.join(workspace, "validator-survived.txt");
const queuedTaskId = packaged ? "packaged-macos-queued-recovery" : "macos-queued-recovery";
const activeTaskId = packaged ? "packaged-macos-active-recovery" : "macos-active-recovery";
await mkdir(home, { recursive: true });
await mkdir(temporary, { recursive: true });
await mkdir(appData, { recursive: true });
await mkdir(workspace);

function command(taskId, commandId, expectedRevision, value) {
  return {
    v: 1,
    kind: "command",
    commandId,
    taskId,
    expectedRevision,
    command: value,
  };
}

async function startServer() {
  const environment = cleanChildEnvironment(process.env);
  environment.HOME = home;
  environment.TMPDIR = temporary;
  environment.CANDY_APP_DATA_ROOT = appData;
  environment.CANDY_DETERMINISTIC_RECOVERY_SMOKE = "1";
  environment.CANDY_SANDBOX_RUNNER = sandboxRunner;
  const child = spawn(runtimeExecutable, [appServer], {
    cwd: packaged ? path.dirname(appServer) : root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return { child, lines, stderr, stopped: false };
}

async function waitForSnapshot(server, predicate) {
  return new Promise((resolve, reject) => {
    const timeoutMs = packaged ? 30_000 : 10_000;
    const timeout = globalThis.setTimeout(() => {
      server.lines.off("line", onLine);
      reject(new Error("macOS recovery did not emit the expected snapshot."));
    }, timeoutMs);
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        const snapshot =
          parsed.kind === "event" && parsed.event?.type === "snapshot"
            ? parsed.event.snapshot
            : undefined;
        if (snapshot !== undefined && predicate(snapshot)) {
          globalThis.clearTimeout(timeout);
          server.lines.off("line", onLine);
          resolve(snapshot);
        }
      } catch {
        // Ignore unrelated diagnostics; the protocol assertion remains JSONL-only.
      }
    };
    server.lines.on("line", onLine);
  });
}

async function waitForEvent(server, taskId, type) {
  return new Promise((resolve, reject) => {
    const timeoutMs = packaged ? 30_000 : 10_000;
    const timeout = globalThis.setTimeout(() => {
      server.lines.off("line", onLine);
      reject(new Error(`macOS recovery did not emit ${type}.`));
    }, timeoutMs);
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.kind === "event" && parsed.taskId === taskId && parsed.event?.type === type) {
          globalThis.clearTimeout(timeout);
          server.lines.off("line", onLine);
          resolve(parsed.event);
        }
      } catch {
        // Ignore unrelated diagnostics; the protocol assertion remains JSONL-only.
      }
    };
    server.lines.on("line", onLine);
  });
}

async function stopServer(server) {
  if (server.stopped) return;
  server.stopped = true;
  server.lines.close();
  server.child.stdin.end();
  await new Promise((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      server.child.kill("SIGKILL");
      resolve();
    }, 2_000);
    server.child.once("exit", () => {
      globalThis.clearTimeout(timeout);
      resolve();
    });
  });
}

const validator = {
  executable: runtimeExecutable,
  args: [
    "-e",
    "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'validator-survived'), 2500); setTimeout(() => {}, 10000);",
    marker,
  ],
};

try {
  const first = await startServer();
  try {
    const queuedCreatedPromise = waitForSnapshot(
      first,
      (snapshot) => snapshot.taskId === queuedTaskId && snapshot.state === "queued",
    );
    first.child.stdin.write(
      `${JSON.stringify(
        command(queuedTaskId, "queued-create", 0, {
          type: "task.create",
          prompt: "macOS queued recovery fixture",
          approvalProfile: "read-only",
          workspacePath: workspace,
          model: "deepseek-v4-flash",
          attachmentIds: [],
        }),
      )}\n`,
    );
    const queuedCreated = await queuedCreatedPromise;
    assert.equal(queuedCreated.revision, 0);

    const activeCreatedPromise = waitForSnapshot(
      first,
      (snapshot) => snapshot.taskId === activeTaskId && snapshot.state === "queued",
    );
    first.child.stdin.write(
      `${JSON.stringify(
        command(activeTaskId, "active-create", 0, {
          type: "task.create",
          prompt: "macOS active recovery fixture",
          approvalProfile: "auto",
          workspacePath: workspace,
          model: "deepseek-v4-flash",
          attachmentIds: [],
          validator,
        }),
      )}\n`,
    );
    const activeCreated = await activeCreatedPromise;

    const runningPromise = waitForSnapshot(
      first,
      (snapshot) => snapshot.taskId === activeTaskId && snapshot.state === "running",
    );
    const validatorStarted = waitForEvent(first, activeTaskId, "tool.started");
    first.child.stdin.write(
      `${JSON.stringify(command(activeTaskId, "active-run", activeCreated.revision, { type: "task.run" }))}\n`,
    );
    const running = await runningPromise;
    assert.equal(running.revision, 1);
    await validatorStarted;
    await stopServer(first);
  } catch (error) {
    await stopServer(first);
    throw error;
  }

  await new Promise((resolve) => globalThis.setTimeout(resolve, 750));
  assert.equal(existsSync(marker), false, "macOS validator descendant survived interruption.");

  const second = await startServer();
  try {
    const restoredQueuedPromise = waitForSnapshot(
      second,
      (snapshot) => snapshot.taskId === queuedTaskId && snapshot.state === "queued",
    );
    second.child.stdin.write(
      `${JSON.stringify(command(queuedTaskId, "queued-snapshot", 0, { type: "snapshot" }))}\n`,
    );
    const restoredQueued = await restoredQueuedPromise;
    assert.equal(restoredQueued.revision, 0);
    assert.equal(restoredQueued.workspacePath, workspace);

    const restoredActivePromise = waitForSnapshot(
      second,
      (snapshot) => snapshot.taskId === activeTaskId && snapshot.state === "interrupted",
    );
    second.child.stdin.write(
      `${JSON.stringify(command(activeTaskId, "active-snapshot", 2, { type: "snapshot" }))}\n`,
    );
    const restoredActive = await restoredActivePromise;
    assert.equal(restoredActive.revision, 2);
    assert.equal(restoredActive.workspacePath, workspace);
    assert.equal(restoredActive.progress?.stopReason, "crash_interrupted");
  } finally {
    await stopServer(second);
  }
  console.log(
    `${packaged ? "Packaged macOS" : "macOS"} app-server recovery smoke passed: queued metadata, owner interruption, and validator descendant cleanup`,
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
