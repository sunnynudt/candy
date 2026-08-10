import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { WindowsJobObjectRunner, WindowsJobObjectValidator } from "@candy/runtime";

if (process.platform !== "win32") {
  console.log("native Windows Job Object smoke skipped: not Windows");
  process.exit(0);
}

const runner = path.resolve("native/sandbox-runner/target/debug/candy-sandbox-runner.exe");
if (!existsSync(runner)) throw new Error("Build the Windows Sandbox Runner before this smoke.");

const root = mkdtempSync(path.join(os.tmpdir(), "candy-native-windows-"));

function requestFor(workspace, overrides = {}) {
  return {
    v: 1,
    kind: "run",
    requestId: "windows-smoke",
    executable: process.execPath,
    args: ["-e", "process.stdout.write('native-job-ok')"],
    cwd: workspace,
    workspace,
    network: false,
    environment: {
      ...Object.fromEntries(
        ["PATH", "Path", "PATHEXT", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "ComSpec"]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      ),
      CANDY_SMOKE: "present",
    },
    ...overrides,
  };
}

function runNative(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(runner, [], {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const line = stdout.split(/\r?\n/u).find((value) => value.length > 0);
      resolve({
        code,
        signal,
        response: line === undefined ? undefined : JSON.parse(line),
        stderr,
      });
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await delay(25);
  }
  throw new Error("native child did not reach its cancellation fixture");
}

async function removeFixtureTree() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (junctionPath !== undefined && existsSync(junctionPath))
        rmSync(junctionPath, { recursive: false, force: true });
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (!existsSync(root)) return;
    } catch {
      // Windows may release a terminated process' directory handle shortly after
      // the process close event. Keep the fixture cleanup bounded and retry.
    }
    await delay(100);
  }
  throw new Error("native Windows smoke fixture cleanup remained busy");
}

async function runCancellationFixture() {
  const started = path.join(root, "started.txt");
  const descendant = path.join(root, "descendant-survived.txt");
  const descendantScript = path.join(root, "descendant.mjs");
  const parentScript = path.join(root, "parent.mjs");
  writeFileSync(
    descendantScript,
    [
      "import { writeFileSync } from 'node:fs';",
      "setTimeout(() => writeFileSync(process.argv[2], 'descendant-survived'), 2500);",
      "setTimeout(() => {}, 10000);",
    ].join("\n"),
  );
  writeFileSync(
    parentScript,
    [
      "import { writeFileSync } from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      "writeFileSync(process.argv[3], 'started');",
      "spawn(process.execPath, [process.argv[2], process.argv[4]], { stdio: 'ignore' });",
      "setTimeout(() => {}, 10000);",
    ].join("\n"),
  );
  const child = spawn(runner, [], {
    cwd: root,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closePromise = new Promise((resolve) => child.once("close", resolve));
  child.stdin.end(
    `${JSON.stringify({
      ...requestFor(root),
      args: [parentScript, descendantScript, started, descendant],
    })}\n`,
  );
  try {
    await waitForFile(started);
  } catch (error) {
    child.kill();
    await closePromise;
    throw error;
  }
  child.kill();
  await closePromise;
  await delay(3_000);
  assert.equal(existsSync(descendant), false, "Job Object left a descendant running");
}

let junctionPath;
try {
  mkdirSync(path.join(root, "workspace"));
  const workspace = path.join(root, "workspace");
  const normal = await runNative(requestFor(workspace));
  assert.equal(normal.response?.kind, "completed");
  assert.equal(normal.response?.code, 0);
  assert.equal(normal.response?.stdout, "native-job-ok");

  const validator = await new WindowsJobObjectValidator(
    new WindowsJobObjectRunner(runner),
    workspace,
    {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('native-job-validator-ok')"],
    },
  ).run(new globalThis.AbortController().signal);
  assert.equal(validator.ok, true);
  assert.equal(validator.evidence, "native-job-validator-ok");

  const network = await runNative(requestFor(workspace, { network: true }));
  assert.deepEqual(network.response, { v: 1, kind: "error", code: "network_forbidden" });

  const outside = path.join(root, "outside");
  mkdirSync(outside);
  const escape = await runNative(requestFor(outside, { workspace }));
  assert.deepEqual(escape.response, { v: 1, kind: "error", code: "workspace_escape" });

  const junction = path.join(workspace, "junction");
  junctionPath = junction;
  const junctionResult = spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", "mklink", "/J", junction, outside],
    { windowsHide: true, stdio: "ignore" },
  );
  if (junctionResult.status !== 0) throw new Error("junction fixture could not be created");
  const reparse = await runNative(requestFor(junction));
  assert.deepEqual(reparse.response, { v: 1, kind: "error", code: "reparse_forbidden" });
  rmSync(junction, { recursive: false, force: true });
  junctionPath = undefined;

  await runCancellationFixture();
  console.log(
    "native Windows Job Object smoke passed: completion, network rejection, workspace/reparse rejection, descendant cancellation",
  );
} finally {
  await removeFixtureTree();
}
