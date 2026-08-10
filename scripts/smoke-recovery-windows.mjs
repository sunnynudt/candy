import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { cleanChildEnvironment } from "@candy/platform";

if (process.platform !== "win32") {
  console.log("Windows recovery smoke skipped: not Windows");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appServer = path.join(root, "apps", "app-server", "dist", "main.js");
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-recovery-windows-"));
const workspace = path.join(fixtureRoot, "workspace");
await mkdir(workspace);
const queuedTaskId = "windows-recovery-fixture";
const activeTaskId = "windows-active-recovery";
const validatorMarker = path.join(fixtureRoot, "validator-survived.txt");

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
  environment.LOCALAPPDATA = path.join(fixtureRoot, "local-app-data");
  environment.APPDATA = environment.LOCALAPPDATA;
  environment.CANDY_DETERMINISTIC_RECOVERY_SMOKE = "1";
  const child = spawn(process.execPath, [appServer], {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return { child, lines, stderr };
}

async function sendAndReadSnapshot(server, message) {
  const snapshot = new Promise((resolve, reject) => {
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.kind === "event" && parsed.event?.type === "snapshot") {
          server.lines.off("line", onLine);
          resolve(parsed.event.snapshot);
        }
      } catch {
        server.lines.off("line", onLine);
        reject(new Error("Windows recovery returned malformed JSON."));
      }
    };
    server.lines.on("line", onLine);
  });
  server.child.stdin.write(`${JSON.stringify(message)}\n`);
  return snapshot;
}

async function waitForEvent(server, taskId, type) {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      server.lines.off("line", onLine);
      reject(new Error(`Windows recovery did not emit ${type}.`));
    }, 10_000);
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.kind === "event" && parsed.taskId === taskId && parsed.event?.type === type) {
          globalThis.clearTimeout(timeout);
          server.lines.off("line", onLine);
          resolve(parsed.event);
        }
      } catch {
        // Ignore unrelated child diagnostics; the protocol smoke remains JSONL-only.
      }
    };
    server.lines.on("line", onLine);
  });
}

async function stopServer(server) {
  server.lines.close();
  server.child.stdin.end();
  await new Promise((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      server.child.kill();
      resolve();
    }, 2_000);
    server.child.once("exit", () => {
      globalThis.clearTimeout(timeout);
      resolve();
    });
  });
}

try {
  const first = await startServer();
  const created = await sendAndReadSnapshot(
    first,
    command(queuedTaskId, "recovery-create", 0, {
      type: "task.create",
      prompt: "Windows recovery fixture",
      approvalProfile: "read-only",
      workspacePath: workspace,
      model: "deepseek-v4-flash",
      attachmentIds: [],
    }),
  );
  assert.equal(created.taskId, queuedTaskId);
  assert.equal(created.state, "queued");
  assert.equal(created.workspacePath, workspace);
  const activeCreated = await sendAndReadSnapshot(
    first,
    command(activeTaskId, "active-recovery-create", 0, {
      type: "task.create",
      prompt: "Windows active recovery fixture",
      approvalProfile: "auto",
      workspacePath: workspace,
      model: "deepseek-v4-flash",
      attachmentIds: [],
      validator: {
        executable: process.execPath,
        args: [
          "-e",
          "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'validator-survived'), 2500); setTimeout(() => {}, 10000);",
          validatorMarker,
        ],
      },
    }),
  );
  const validatorStarted = waitForEvent(first, activeTaskId, "tool.started");
  const activeRunning = await sendAndReadSnapshot(
    first,
    command(activeTaskId, "active-recovery-run", activeCreated.revision, { type: "task.run" }),
  );
  assert.equal(activeRunning.taskId, activeTaskId);
  assert.equal(activeRunning.state, "running");
  await validatorStarted;
  await stopServer(first);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 3_000));
  assert.equal(
    existsSync(validatorMarker),
    false,
    "Windows validator descendant survived interruption",
  );

  const second = await startServer();
  const restored = await sendAndReadSnapshot(
    second,
    command(queuedTaskId, "recovery-snapshot", created.revision, { type: "snapshot" }),
  );
  assert.equal(restored.taskId, queuedTaskId);
  assert.equal(restored.state, "queued");
  assert.equal(restored.workspacePath, workspace);
  assert.equal(restored.revision, created.revision);
  const activeRestored = await sendAndReadSnapshot(
    second,
    command(activeTaskId, "active-recovery-snapshot", activeRunning.revision + 1, {
      type: "snapshot",
    }),
  );
  assert.equal(activeRestored.taskId, activeTaskId);
  assert.equal(activeRestored.state, "interrupted");
  assert.equal(activeRestored.revision, activeRunning.revision + 1);
  assert.equal(activeRestored.progress?.stopReason, "crash_interrupted");
  await stopServer(second);
  console.log(
    "Windows app-server recovery smoke passed: queued metadata, active validator interruption, and owner crash interruption survived process restart",
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
