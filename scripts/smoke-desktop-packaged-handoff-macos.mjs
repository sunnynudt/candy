import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { cleanChildEnvironment } from "@candy/platform";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("Packaged macOS handoff smoke skipped: not macOS arm64");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contents = path.join(root, "out", "macos", "Candy.app", "Contents");
const packagedNode = path.join(contents, "Resources", "node", "bin", "node");
const appServer = path.join(contents, "Resources", "app-server", "main.js");
const sandboxRunner = path.join(contents, "Resources", "native", "candy-sandbox-runner");
if (!existsSync(packagedNode) || !existsSync(appServer) || !existsSync(sandboxRunner))
  throw new Error("Packaged macOS handoff runtime is incomplete.");

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-packaged-handoff-macos-"));
const home = path.join(fixtureRoot, "home");
const temporary = path.join(fixtureRoot, "tmp");
const appData = path.join(fixtureRoot, "app-data");
const workspace = path.join(fixtureRoot, "workspace");
const marker = path.join(fixtureRoot, "validator-invocations.txt");
const descendantMarker = path.join(fixtureRoot, "validator-descendant-survived.txt");
const taskId = "packaged-macos-handoff";
await mkdir(home, { recursive: true });
await mkdir(temporary, { recursive: true });
await mkdir(appData, { recursive: true });
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
  environment.HOME = home;
  environment.TMPDIR = temporary;
  environment.CANDY_APP_DATA_ROOT = appData;
  environment.CANDY_DETERMINISTIC_RECOVERY_SMOKE = "1";
  environment.CANDY_SANDBOX_RUNNER = sandboxRunner;
  const child = spawn(packagedNode, [appServer], {
    cwd: path.dirname(appServer),
    env: environment,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return { child, lines: createInterface({ input: child.stdout, crlfDelay: Infinity }) };
}

async function waitForSnapshot(server, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      server.lines.off("line", onLine);
      reject(new Error("Packaged macOS handoff did not emit the expected snapshot."));
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
      reject(new Error(`Packaged macOS handoff did not emit ${type}.`));
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
        // Ignore unrelated diagnostics; the protocol assertion remains JSONL-only.
      }
    };
    server.lines.on("line", onLine);
  });
}

async function waitForProtocolError(server) {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      server.lines.off("line", onLine);
      reject(new Error("Packaged macOS handoff did not emit the expected protocol error."));
    }, 10_000);
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.kind === "error") {
          globalThis.clearTimeout(timeout);
          server.lines.off("line", onLine);
          resolve(parsed);
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
  throw new Error(`Packaged macOS handoff validator did not reach invocation ${expected}.`);
}

async function assertNoValidatorDescendant(stage) {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 3_000));
  assert.equal(
    existsSync(descendantMarker),
    false,
    `Packaged macOS validator descendant survived ${stage}.`,
  );
}

async function stopServer(server) {
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

try {
  const descendantScript = [
    "const fs = require('node:fs');",
    "const marker = process.argv[1];",
    "setTimeout(() => fs.writeFileSync(marker, 'descendant-survived'), 2500);",
    "setTimeout(() => {}, 10000);",
  ].join(" ");
  const validatorScript = [
    "const cp = require('node:child_process');",
    "const fs = require('node:fs');",
    "const marker = process.argv[1];",
    "const descendantMarker = process.argv[2];",
    "const descendantScript = process.argv[3];",
    "const n = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split(/\\r?\\n/).filter(Boolean).length : 0;",
    "fs.appendFileSync(marker, 'invocation-' + (n + 1) + '\\n');",
    "cp.spawn(process.execPath, ['-e', descendantScript, descendantMarker], { stdio: 'ignore' });",
    "setTimeout(() => {}, 10000);",
  ].join(" ");
  const validator = {
    executable: packagedNode,
    args: ["-e", validatorScript, marker, descendantMarker, descendantScript],
  };

  const first = await startServer();
  try {
    const createdPromise = waitForSnapshot(first, (snapshot) => snapshot.state === "queued");
    first.child.stdin.write(
      `${JSON.stringify(
        command("handoff-create", 0, {
          type: "task.create",
          prompt: "Packaged macOS cross-client handoff fixture",
          approvalProfile: "auto",
          workspacePath: workspace,
          model: "deepseek-v4-flash",
          attachmentIds: [],
          validator,
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
    await assertNoValidatorDescendant("pause");
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

    const staleErrorPromise = waitForProtocolError(second);
    second.child.stdin.write(
      `${JSON.stringify(command("handoff-stale-resume", 1, { type: "task.resume" }))}\n`,
    );
    const staleError = await staleErrorPromise;
    assert.equal(staleError.code, "invalid_message");

    const fencedPromise = waitForSnapshot(
      second,
      (snapshot) => snapshot.state === "paused" && snapshot.revision === 2,
    );
    second.child.stdin.write(
      `${JSON.stringify(command("handoff-fenced-snapshot", 2, { type: "snapshot" }))}\n`,
    );
    const fenced = await fencedPromise;
    assert.equal(fenced.ownerId, undefined);

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
    await assertNoValidatorDescendant("cancel");
  } finally {
    await stopServer(second);
  }

  assert.equal(
    readFileSync(marker, "utf8").split(/\r?\n/u).filter(Boolean).length,
    2,
    "Packaged macOS handoff validator invocations were not sequential.",
  );
  console.log(
    "Packaged macOS handoff smoke passed: stale revision fenced, owner released, receiver resumed a new turn, and validator descendants were cleaned up",
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
