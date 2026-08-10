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
  console.log("Packaged Windows recovery smoke skipped: not Windows");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "out", "windows", "Candy");
const packagedNode = path.join(bundle, "resources", "node", "node.exe");
const appServer = path.join(bundle, "resources", "app-server", "main.js");
const sandboxRunner = path.join(bundle, "resources", "native", "candy-sandbox-runner.exe");
if (!existsSync(packagedNode) || !existsSync(appServer) || !existsSync(sandboxRunner))
  throw new Error("Packaged Windows recovery runtime is incomplete.");

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-packaged-recovery-windows-"));
const localAppData = path.join(fixtureRoot, "local-app-data");
const workspace = path.join(fixtureRoot, "workspace");
const marker = path.join(fixtureRoot, "validator-survived.txt");
const taskId = "packaged-windows-recovery";
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
      reject(new Error("Packaged Windows recovery did not emit the expected snapshot."));
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
      reject(new Error(`Packaged Windows recovery did not emit ${type}.`));
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
  const first = await startServer();
  try {
    const createdPromise = waitForSnapshot(first, (snapshot) => snapshot.state === "queued");
    first.child.stdin.write(
      `${JSON.stringify(
        command("recovery-create", 0, {
          type: "task.create",
          prompt: "Packaged Windows recovery fixture",
          approvalProfile: "auto",
          workspacePath: workspace,
          model: "deepseek-v4-flash",
          attachmentIds: [],
          validator: {
            executable: packagedNode,
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

    const runningPromise = waitForSnapshot(first, (snapshot) => snapshot.state === "running");
    const validatorStarted = waitForEvent(first, "tool.started");
    first.child.stdin.write(
      `${JSON.stringify(command("recovery-run", 0, { type: "task.run" }))}\n`,
    );
    const running = await runningPromise;
    assert.equal(running.revision, 1);
    await validatorStarted;
    await stopServer(first);
  } catch (error) {
    await stopServer(first);
    throw error;
  }

  await new Promise((resolve) => globalThis.setTimeout(resolve, 3_000));
  assert.equal(existsSync(marker), false, "Packaged validator descendant survived interruption.");

  const second = await startServer();
  try {
    const restoredPromise = waitForSnapshot(second, (snapshot) => snapshot.state === "interrupted");
    second.child.stdin.write(
      `${JSON.stringify(command("recovery-snapshot", 2, { type: "snapshot" }))}\n`,
    );
    const restored = await restoredPromise;
    assert.equal(restored.revision, 2);
    assert.equal(restored.progress?.stopReason, "crash_interrupted");
  } finally {
    await stopServer(second);
  }
  console.log(
    "Packaged Windows recovery smoke passed: packaged Node/app-server restart and native validator descendant cleanup",
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
