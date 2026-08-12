import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {
  NativeProcessRunner,
  NativeProcessRunnerUnavailableError,
  resolveNativeProcessRunnerPath,
} from "./native-process.js";

const MAX_OUTPUT_BYTES = 1_048_576;

test("native runner path resolution is platform-owned and fail-closed", () => {
  const existing = new Set(["/opt/candy/candy-sandbox-runner.exe"]);
  const resolved = resolveNativeProcessRunnerPath("file:///repo/apps/app-server/dist/main.js", {
    platform: "win32",
    environment: { CANDY_SANDBOX_RUNNER: "/opt/candy/candy-sandbox-runner.exe" },
    cwd: "/repo",
    exists: (candidate) => existing.has(candidate),
  });
  assert.equal(resolved, "/opt/candy/candy-sandbox-runner.exe");
  assert.equal(
    resolveNativeProcessRunnerPath("file:///repo/apps/app-server/dist/main.js", {
      platform: "linux",
      cwd: "/repo",
      exists: () => true,
    }),
    undefined,
  );
});

test("native runner rejects unsupported platforms and secret-bearing environments before spawn", () => {
  assert.throws(
    () =>
      new NativeProcessRunner("/opt/candy/candy-sandbox-runner", "linux").run({
        executable: "/usr/bin/node",
        args: [],
        cwd: "/tmp",
        workspace: "/tmp",
      }),
    NativeProcessRunnerUnavailableError,
  );
  assert.throws(
    () =>
      new NativeProcessRunner("/opt/candy/candy-sandbox-runner", "darwin").run({
        executable: "/usr/bin/node",
        args: [],
        cwd: "/tmp",
        workspace: "/tmp",
        environment: { CANDY_DEEPSEEK_API_KEY: "fixture-secret" },
      }),
    /credentials/iu,
  );
});

test("native runner rejects an exact active secret in command arguments before spawn", () => {
  const canary = "plain-command-canary-0123456789";
  let spawnCalled = false;
  assert.throws(
    () =>
      new NativeProcessRunner("/opt/candy/candy-sandbox-runner", "darwin", () => {
        spawnCalled = true;
        throw new Error("spawn must not be reached");
      }).run({
        executable: "/usr/bin/node",
        args: ["-e", `process.stdout.write(${JSON.stringify(canary)})`],
        cwd: "/tmp",
        workspace: "/tmp",
        activeSecrets: [canary],
      }),
    /credentials/iu,
  );
  assert.equal(spawnCalled, false);
});

test("native runner parses a completed frame with 1 MiB stdout and stderr", async () => {
  if (process.platform !== "darwin") return;
  const runnerPath = path.resolve(
    process.cwd(),
    "native",
    "sandbox-runner",
    "target",
    "debug",
    "candy-sandbox-runner",
  );
  if (!existsSync(runnerPath)) return;
  const workspace = await mkdtemp(path.join(os.tmpdir(), "candy-native-frame-boundary-"));
  try {
    const result = await new NativeProcessRunner(runnerPath).run({
      executable: process.execPath,
      args: [
        "-e",
        `const output = String.fromCharCode(1).repeat(${MAX_OUTPUT_BYTES}); process.stdout.write(output); process.stderr.write(output);`,
      ],
      cwd: workspace,
      workspace,
    });
    assert.equal(result.code, 0);
    assert.equal(result.cancelled, false);
    assert.equal(Buffer.byteLength(result.stdout, "utf8"), MAX_OUTPUT_BYTES);
    assert.equal(Buffer.byteLength(result.stderr, "utf8"), MAX_OUTPUT_BYTES);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("native runner parses the max completed frame through the Windows adapter", async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (): boolean => false;
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as { requestId: string };
    const output = String.fromCharCode(1).repeat(MAX_OUTPUT_BYTES);
    const response = `${JSON.stringify({
      v: 1,
      kind: "completed",
      requestId: request.requestId,
      code: 0,
      stdout: output,
      stderr: output,
      cancelled: false,
    })}\n`;
    child.stdout.end(response);
    child.stderr.end();
    queueMicrotask(() => child.emit("close", 0, null));
  });
  const result = await new NativeProcessRunner(
    "/opt/candy/candy-sandbox-runner.exe",
    "win32",
    () => child,
  ).run({
    executable: "/opt/candy/node.exe",
    args: [],
    cwd: "/opt/candy",
    workspace: "/opt/candy",
  });
  assert.equal(result.code, 0);
  assert.equal(result.cancelled, false);
  assert.equal(Buffer.byteLength(result.stdout, "utf8"), MAX_OUTPUT_BYTES);
  assert.equal(Buffer.byteLength(result.stderr, "utf8"), MAX_OUTPUT_BYTES);
});

test("native runner cancels the Windows wrapper without passing a POSIX signal", async () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.pid = 42;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killSignal: NodeJS.Signals | undefined;
  child.kill = (signal?: NodeJS.Signals): boolean => {
    killSignal = signal;
    queueMicrotask(() => child.emit("close", null, null));
    return true;
  };
  const spawnProcess = () => child;
  const controller = new AbortController();
  const pending = new NativeProcessRunner(
    "/opt/candy/candy-sandbox-runner.exe",
    "win32",
    spawnProcess as never,
  ).run({
    executable: "/opt/candy/node.exe",
    args: [],
    cwd: "/opt/candy",
    workspace: "/opt/candy",
    signal: controller.signal,
  });
  controller.abort();
  const result = await pending;
  assert.equal(killSignal, undefined);
  assert.equal(result.cancelled, true);
});
