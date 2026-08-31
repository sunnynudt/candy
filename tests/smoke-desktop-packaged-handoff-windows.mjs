import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { cleanChildEnvironment } from "@candy/platform";

if (process.platform !== "win32") {
  console.log("Packaged Windows handoff smoke skipped: not Windows");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "out", "windows", "Candy");
const packagedNode = path.join(bundle, "resources", "node", "node.exe");
const appServer = path.join(bundle, "resources", "app-server", "main.js");
const sandboxRunner = path.join(bundle, "resources", "native", "candy-sandbox-runner.exe");
if (!existsSync(packagedNode) || !existsSync(appServer) || !existsSync(sandboxRunner))
  throw new Error("Packaged Windows handoff runtime is incomplete.");

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-packaged-handoff-windows-"));
const localAppData = path.join(fixtureRoot, "local-app-data");
const workspace = path.join(fixtureRoot, "workspace");
const marker = path.join(fixtureRoot, "validator-invocations.txt");
const taskId = "packaged-windows-handoff";
await mkdir(workspace);

function command(commandId, expectedRevision, value) {
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
  environment.LOCALAPPDATA = localAppData;
  environment.APPDATA = localAppData;
  environment.CANDY_DETERMINISTIC_RECOVERY_SMOKE = "1";
  environment.CANDY_SANDBOX_RUNNER = sandboxRunner;
  const child = spawn(packagedNode, [appServer], {
    cwd: path.dirname(appServer),
    env: environment,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  return { child, lines: createInterface({ input: child.stdout, crlfDelay: Infinity }) };
}

async function waitForSnapshot(server, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      server.lines.off("line", onLine);
      reject(new Error("Packaged Windows handoff did not emit the expected snapshot."));
    }, 10_000);
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

async function waitForEvent(server, type) {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      server.lines.off("line", onLine);
      reject(new Error(`Packaged Windows handoff did not emit ${type}.`));
    }, 10_000);
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.kind === "event" && parsed.event?.type === type) {
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

async function waitForInvocationCount(expected) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      const count = readFileSync(marker, "utf8").split(/\r?\n/u).filter(Boolean).length;
      if (count >= expected) return count;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
  throw new Error(`Packaged Windows handoff validator did not reach invocation ${expected}.`);
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
  try {
    const createdPromise = waitForSnapshot(first, (snapshot) => snapshot.state === "queued");
    first.child.stdin.write(
      `${JSON.stringify(
        command("handoff-create", 0, {
          type: "task.create",
          prompt: "Packaged Windows cross-client handoff fixture",
          approvalProfile: "auto",
          workspacePath: workspace,
          model: "deepseek-v4-flash",
          attachmentIds: [],
          validator: {
            executable: packagedNode,
            args: [
              "-e",
              "const fs=require('node:fs'); const p=process.argv[1]; const n=fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\\r?\\n/).filter(Boolean).length : 0; fs.appendFileSync(p, 'invocation-' + (n + 1) + '\\n'); setTimeout(() => {}, 10000);",
              marker,
            ],
          },
        }),
      )}\n`,
    );
    await createdPromise;

    const runningPromise = waitForSnapshot(first, (snapshot) => snapshot.state === "running");
    const validatorStarted = waitForEvent(first, "tool.started");
    first.child.stdin.write(`${JSON.stringify(command("handoff-run", 0, { type: "task.run" }))}\n`);
    const running = await runningPromise;
    assert.equal(running.revision, 1);
    await validatorStarted;
    await waitForInvocationCount(1);

    const pausedPromise = waitForSnapshot(first, (snapshot) => snapshot.state === "paused");
    first.child.stdin.write(
      `${JSON.stringify(command("handoff-pause", 1, { type: "task.pause" }))}\n`,
    );
    const paused = await pausedPromise;
    assert.equal(paused.revision, 2);
    assert.equal(paused.ownerId, undefined);
    assert.equal(paused.progress?.stopReason, "user_stop");
  } finally {
    await stopServer(first);
  }

  const second = await startServer();
  try {
    const restoredPromise = waitForSnapshot(second, (snapshot) => snapshot.state === "paused");
    second.child.stdin.write(
      `${JSON.stringify(command("handoff-snapshot", 2, { type: "snapshot" }))}\n`,
    );
    const restored = await restoredPromise;
    assert.equal(restored.revision, 2);
    assert.equal(restored.ownerId, undefined);

    const resumedPromise = waitForSnapshot(second, (snapshot) => snapshot.state === "running");
    const receiverTool = waitForEvent(second, "tool.started");
    second.child.stdin.write(
      `${JSON.stringify(command("handoff-resume", 2, { type: "task.resume" }))}\n`,
    );
    const resumed = await resumedPromise;
    assert.equal(resumed.revision, 3);
    assert.equal(resumed.ownerId?.startsWith("app-server:"), true);
    await receiverTool;
    await waitForInvocationCount(2);

    const cancelledPromise = waitForSnapshot(second, (snapshot) => snapshot.state === "cancelled");
    second.child.stdin.write(
      `${JSON.stringify(command("handoff-cancel", 3, { type: "task.cancel" }))}\n`,
    );
    const cancelled = await cancelledPromise;
    assert.equal(cancelled.revision, 4);
    assert.equal(cancelled.progress?.stopReason, "cancelled");
  } finally {
    await stopServer(second);
  }

  console.log(
    "Packaged Windows handoff smoke passed: paused owner released, receiver resumed a new turn, and validator invocations were sequential",
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
