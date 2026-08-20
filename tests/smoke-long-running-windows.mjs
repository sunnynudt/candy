import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { cleanChildEnvironment } from "@candy/platform";

if (process.platform !== "win32") {
  console.log("Windows long-running smoke skipped: not Windows");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appServer = path.join(root, "apps", "app-server", "dist", "main.js");
const sandboxRunner = path.join(
  root,
  "native",
  "sandbox-runner",
  "target",
  "debug",
  "candy-sandbox-runner.exe",
);
if (!existsSync(sandboxRunner)) throw new Error("Windows native validator runner is missing.");

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-long-running-windows-"));
const workspace = path.join(fixtureRoot, "workspace");
const localAppData = path.join(fixtureRoot, "local-app-data");
const marker = path.join(fixtureRoot, "validator-survived.txt");
const taskId = "windows-long-running-cancel";
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
  const child = spawn(process.execPath, [appServer], {
    cwd: root,
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
      reject(new Error("Windows long-running smoke did not emit the expected snapshot."));
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
      reject(new Error(`Windows long-running smoke did not emit ${type}.`));
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
  const server = await startServer();
  try {
    const createdPromise = waitForSnapshot(server, (snapshot) => snapshot.state === "queued");
    server.child.stdin.write(
      `${JSON.stringify(
        command("long-running-create", 0, {
          type: "task.create",
          prompt: "Windows long-running cancellation fixture",
          approvalProfile: "auto",
          workspacePath: workspace,
          model: "deepseek-v4-flash",
          attachmentIds: [],
          validator: {
            executable: process.execPath,
            args: [
              "-e",
              "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'validator-survived'), 2500); setTimeout(() => {}, 10000);",
              marker,
            ],
          },
        }),
      )}\n`,
    );
    await createdPromise;

    const runningPromise = waitForSnapshot(server, (snapshot) => snapshot.state === "running");
    const validatorStarted = waitForEvent(server, "tool.started");
    server.child.stdin.write(
      `${JSON.stringify(command("long-running-run", 0, { type: "task.run" }))}\n`,
    );
    const running = await runningPromise;
    assert.equal(running.revision, 1);
    await validatorStarted;

    const cancelledPromise = waitForSnapshot(server, (snapshot) => snapshot.state === "cancelled");
    server.child.stdin.write(
      `${JSON.stringify(command("long-running-cancel", 1, { type: "task.cancel" }))}\n`,
    );
    const cancelled = await cancelledPromise;
    assert.equal(cancelled.revision, 2);
    assert.equal(cancelled.progress?.stopReason, "cancelled");
  } finally {
    await stopServer(server);
  }

  await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000));
  assert.equal(existsSync(marker), false, "Windows cancelled validator descendant survived.");
  console.log(
    "Windows long-running smoke passed: user cancellation stopped validator and descendant before marker write",
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
