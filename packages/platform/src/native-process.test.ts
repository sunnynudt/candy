import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { cleanChildEnvironment } from "./index.js";

const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_PROTOCOL_LINE_BYTES = 1_048_576;

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
  assert.equal(
    resolveNativeProcessRunnerPath("file:///repo/apps/app-server/dist/main.js", {
      platform: "win32",
      environment: { CANDY_SANDBOX_RUNNER: "native\\runner.exe" },
      cwd: "C:\\repo",
      exists: () => true,
    }),
    undefined,
  );
  assert.equal(
    resolveNativeProcessRunnerPath("file:///repo/apps/app-server/dist/main.js", {
      platform: "win32",
      environment: { CANDY_SANDBOX_RUNNER: "C:\\missing\\runner.exe" },
      cwd: "C:\\repo",
      exists: () => false,
    }),
    undefined,
  );
});

test("native runner path resolution uses target Windows URL and path semantics", () => {
  const existing = new Set(["C:\\repo\\apps\\app-server\\native\\candy-sandbox-runner.exe"]);
  assert.equal(
    resolveNativeProcessRunnerPath("file:///C:/repo/apps/app-server/dist/main.js", {
      platform: "win32",
      cwd: "C:\\repo",
      exists: (candidate) => existing.has(candidate),
    }),
    "C:\\repo\\apps\\app-server\\native\\candy-sandbox-runner.exe",
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

test("native runner rejects oversized raw active secrets before injected spawn", async () => {
  const canary = "q".repeat(MAX_OUTPUT_BYTES + 1);
  let spawnCalled = false;
  const runner = new NativeProcessRunner("/opt/candy/candy-sandbox-runner", "darwin", () => {
    spawnCalled = true;
    throw new Error("spawn must not be reached");
  });
  await assert.rejects(
    Promise.resolve().then(() =>
      runner.run({
        executable: "/usr/bin/node",
        args: [canary],
        cwd: "/tmp",
        workspace: "/tmp",
        activeSecrets: [canary],
      }),
    ),
    /credentials/iu,
  );
  assert.equal(spawnCalled, false);
});

test("native runner rejects a nested JSON active secret before execution", async () => {
  if (process.platform !== "darwin") return;
  const runnerPath = path.resolve(
    process.cwd(),
    "native",
    "sandbox-runner",
    "target",
    "debug",
    "candy-sandbox-runner",
  );
  if (!existsSync(runnerPath))
    throw new Error("macOS native runner binary is required for the nested-secret regression.");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "candy-native-argument-boundary-"));
  const marker = path.join(workspace, "nested-value-marker");
  const canary = [
    "fixture",
    String.fromCharCode(34),
    "wire",
    String.fromCharCode(92),
    "value42",
  ].join("");
  const nestedRepresentation = JSON.stringify(JSON.stringify(canary));
  const script = [
    'const fs = require("node:fs");',
    `const value = JSON.parse(${JSON.stringify(nestedRepresentation)});`,
    `fs.writeFileSync(${JSON.stringify(marker)}, value);`,
  ].join(" ");
  try {
    let spawned = false;
    let completed = false;
    let stdout = "";
    try {
      const result = await new NativeProcessRunner(runnerPath, "darwin", ((
        ...args: Parameters<typeof spawn>
      ) => {
        spawned = true;
        return spawn(...args);
      }) as never).run({
        executable: process.execPath,
        args: ["-e", script],
        cwd: workspace,
        workspace,
        activeSecrets: [canary],
      });
      completed = true;
      stdout = result.stdout;
    } catch (error) {
      assert.match(error instanceof Error ? error.message : String(error), /credentials/iu);
    }
    assert.equal(spawned, false);
    assert.equal(existsSync(marker), false);
    assert.equal(completed, false);
    assert.equal(stdout.includes(canary), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("native runner rejects the deepest JSON representation before injected spawn", () => {
  const canary = [
    "fixture",
    String.fromCharCode(34),
    "wire",
    String.fromCharCode(92),
    "value42",
  ].join("");
  const representations = jsonRepresentationsWithinProtocolLine(canary);
  const deepestRepresentation = representations.at(-1);
  assert.notEqual(deepestRepresentation, undefined);
  assert.ok(
    serializedNativeRequestBytes([deepestRepresentation as string], [canary]) <=
      MAX_PROTOCOL_LINE_BYTES,
  );
  assert.ok(
    serializedNativeRequestBytes([JSON.stringify(deepestRepresentation)], [canary]) >
      MAX_PROTOCOL_LINE_BYTES,
  );
  let spawnCalled = false;
  assert.throws(
    () =>
      new NativeProcessRunner("/opt/candy/candy-sandbox-runner", "darwin", () => {
        spawnCalled = true;
        throw new Error("spawn must not be reached");
      }).run({
        executable: "/usr/bin/node",
        args: [deepestRepresentation as string],
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

function jsonRepresentationsWithinProtocolLine(value: string): string[] {
  const representations: string[] = [];
  let current = value;
  while (serializedNativeRequestBytes([current], [value]) <= MAX_PROTOCOL_LINE_BYTES) {
    representations.push(current);
    const next = JSON.stringify(current);
    if (serializedNativeRequestBytes([next], [value]) > MAX_PROTOCOL_LINE_BYTES) break;
    current = next;
  }
  return representations;
}

function serializedNativeRequestBytes(
  args: readonly string[],
  activeSecrets: readonly string[],
): number {
  const payload = JSON.stringify({
    v: 1,
    kind: "run",
    requestId: `sandbox-${"0".repeat(13)}-${"f".repeat(13)}`,
    executable: "/usr/bin/node",
    args,
    cwd: "/tmp",
    workspace: "/tmp",
    network: false,
    environment: cleanChildEnvironment(process.env, activeSecrets),
  });
  return Buffer.byteLength(payload, "utf8");
}
