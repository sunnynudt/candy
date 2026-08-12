import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeProcessRunner,
  NativeProcessRunnerUnavailableError,
  resolveNativeProcessRunnerPath,
} from "./native-process.js";

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
