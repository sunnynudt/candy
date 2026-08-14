import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { NativeProcessRunner } from "@candy/platform";
import { CommandValidator } from "@candy/runtime";

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
  const descendantCode =
    "const fs=require('node:fs'); setTimeout(() => fs.writeFileSync(process.argv[1], 'descendant-survived'), 2500); setTimeout(() => {}, 10000);";
  const parentCode = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    "fs.writeFileSync(process.argv[1], 'started');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}, process.argv[2]], {stdio:'ignore'});`,
    "setTimeout(() => {}, 10000);",
  ].join(" ");
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
      args: ["-e", parentCode, started, descendant],
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

async function runParentLossFixture(workspace) {
  const marker = path.join(workspace, "parent-loss-survived.txt");
  const controller = [
    "const {spawn}=require('node:child_process');",
    "const request=JSON.parse(process.argv[2]);",
    "request.parentPid=process.pid;",
    "const child=spawn(process.argv[1], [], {stdio:['pipe','ignore','ignore']});",
    "child.stdin.end(JSON.stringify(request)+'\\n');",
    "child.unref();",
  ].join(" ");
  const target = `const fs=require('node:fs'); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'survived'), 2500); setTimeout(() => {}, 10000);`;
  const request = requestFor(workspace, {
    requestId: "windows-parent-loss",
    args: ["-e", target],
    parentPid: 0,
  });
  const controllerProcess = spawn(
    process.execPath,
    ["-e", controller, runner, JSON.stringify(request)],
    {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  await new Promise((resolve, reject) => {
    controllerProcess.once("error", reject);
    controllerProcess.once("close", resolve);
  });
  await delay(3_500);
  assert.equal(existsSync(marker), false, "parent loss left a sandbox process running");
}

let junctionPath;
try {
  mkdirSync(path.join(root, "workspace"));
  const workspace = path.join(root, "workspace");
  const existingWorkspaceFile = path.join(workspace, "existing.txt");
  writeFileSync(existingWorkspaceFile, "before");
  const normal = await runNative(requestFor(workspace));
  if (normal.response?.code === "sandbox_unavailable") {
    console.log(
      "BLOCKED: Windows AppContainer/BFS native sandbox is unavailable on this host; no unsandboxed fallback was used",
    );
    await removeFixtureTree();
    process.exit(0);
  }
  assert.equal(normal.response?.kind, "completed");
  assert.equal(normal.response?.code, 0);
  assert.equal(normal.response?.stdout, "native-job-ok");

  const validator = await new CommandValidator(new NativeProcessRunner(runner)).run(
    {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('native-job-validator-ok')"],
    },
    workspace,
    new globalThis.AbortController().signal,
  );
  assert.equal(validator.ok, true);
  assert.equal(validator.evidence, "native-job-validator-ok");

  const network = await runNative(requestFor(workspace, { network: true }));
  assert.equal(network.response?.kind, "completed");

  const networkServer = createServer(() => undefined);
  await new Promise((resolve, reject) => {
    networkServer.once("error", reject);
    networkServer.listen(0, "127.0.0.1", resolve);
  });
  const networkPort = networkServer.address().port;
  const networkProbe = await runNative(
    requestFor(workspace, {
      args: [
        "-e",
        `fetch('http://127.0.0.1:${networkPort}').then(() => process.stdout.write('connected')).catch(() => process.stdout.write('blocked'))`,
      ],
    }),
  );
  networkServer.close();
  assert.equal(networkProbe.response?.stdout, "blocked", "offline AppContainer reached loopback");

  const writeProbe = await runNative(
    requestFor(workspace, {
      args: [
        "-e",
        `try { require('node:fs').writeFileSync(${JSON.stringify(path.join(workspace, "write-probe.txt"))}, 'ok'); process.stdout.write('write-ok') } catch (error) { process.stdout.write(String(error.code ?? error.message)) }`,
      ],
    }),
  );
  assert.equal(writeProbe.response?.stdout, "write-ok");
  assert.equal(existsSync(path.join(workspace, "write-probe.txt")), true);
  const existingWrite = await runNative(
    requestFor(workspace, {
      args: [
        "-e",
        `try { require('node:fs').writeFileSync(${JSON.stringify(existingWorkspaceFile)}, 'after'); process.stdout.write('write-ok') } catch (error) { process.stdout.write(String(error.code ?? error.message)) }`,
      ],
    }),
  );
  assert.equal(existingWrite.response?.stdout, "write-ok");

  const outside = path.join(root, "outside");
  mkdirSync(outside);
  const outsideFile = path.join(outside, "outside.txt");
  writeFileSync(outsideFile, "outside-secret");
  const outsideRead = await runNative(
    requestFor(workspace, {
      args: [
        "-e",
        `try { require('node:fs').readFileSync(${JSON.stringify(outsideFile)}); process.stdout.write('readable') } catch { process.stdout.write('blocked') }`,
      ],
    }),
  );
  assert.equal(outsideRead.response?.stdout, "blocked", "sandbox read outside workspace");
  const outsideWrite = await runNative(
    requestFor(workspace, {
      args: [
        "-e",
        `try { require('node:fs').writeFileSync(${JSON.stringify(outsideFile)}, 'outside'); process.stdout.write('writable') } catch { process.stdout.write('blocked') }`,
      ],
    }),
  );
  assert.equal(outsideWrite.response?.stdout, "blocked", "sandbox wrote outside workspace");
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

  const missingExecutable = await runNative(
    requestFor(workspace, {
      executable: path.join(root, "missing-executable.exe"),
    }),
  );
  assert.deepEqual(
    missingExecutable.response,
    { v: 1, kind: "error", code: "invalid_path" },
    "runner accepted a missing executable path",
  );

  const largeOutput = await runNative(
    requestFor(workspace, {
      args: ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
    }),
  );
  assert.equal(largeOutput.response?.kind, "completed");
  assert.equal(largeOutput.response?.code, 0);
  assert.ok(
    largeOutput.response?.stdout.length <= 1024 * 1024,
    "runner did not bound oversized child output",
  );

  await runCancellationFixture();
  await runParentLossFixture(workspace);
  console.log(
    "native Windows AppContainer/Job Object smoke passed: completion, network denial/elevation, workspace/reparse rejection, missing-executable rejection, bounded output, descendant cancellation, parent-loss cleanup",
  );
} finally {
  await removeFixtureTree();
}
