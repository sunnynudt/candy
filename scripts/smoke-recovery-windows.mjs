import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const taskId = "windows-recovery-fixture";

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
  environment.LOCALAPPDATA = path.join(fixtureRoot, "local-app-data");
  environment.APPDATA = environment.LOCALAPPDATA;
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
    command("recovery-create", 0, {
      type: "task.create",
      prompt: "Windows recovery fixture",
      approvalProfile: "read-only",
      workspacePath: workspace,
      model: "deepseek-v4-flash",
      attachmentIds: [],
    }),
  );
  assert.equal(created.taskId, taskId);
  assert.equal(created.state, "queued");
  assert.equal(created.workspacePath, workspace);
  await stopServer(first);

  const second = await startServer();
  const restored = await sendAndReadSnapshot(
    second,
    command("recovery-snapshot", created.revision, { type: "snapshot" }),
  );
  assert.equal(restored.taskId, taskId);
  assert.equal(restored.state, "queued");
  assert.equal(restored.workspacePath, workspace);
  assert.equal(restored.revision, created.revision);
  await stopServer(second);
  console.log("Windows app-server recovery smoke passed: task metadata survived process restart");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
