import assert from "node:assert/strict";
import test from "node:test";
import {
  ClipboardUnavailableError,
  copyToClipboard,
  resolveClipboardCommand,
  type ClipboardCommand,
} from "./clipboard.js";

test("clipboard command resolution is platform-specific and fail-closed", () => {
  const darwin = resolveClipboardCommand("darwin");
  assert.ok(darwin);
  assert.equal(darwin.command, "/usr/bin/pbcopy");
  assert.deepEqual(darwin.args, []);

  const win32 = resolveClipboardCommand("win32");
  assert.ok(win32);
  assert.equal(win32.command, "powershell.exe");
  assert.ok(win32.args.some((arg) => arg.includes("Set-Clipboard")));

  assert.equal(resolveClipboardCommand("linux"), undefined);
  assert.equal(resolveClipboardCommand("freebsd"), undefined);
});

test("copyToClipboard fails closed on unsupported platforms", async () => {
  await assert.rejects(copyToClipboard("fixture", { platform: "linux" }), (error: unknown) => {
    assert.ok(error instanceof ClipboardUnavailableError);
    assert.match(error.message, /unavailable on linux/u);
    return true;
  });
});

test("copyToClipboard pipes the value to the helper and resolves on exit zero", async () => {
  const script =
    "process.stdin.setEncoding('utf8'); let data=''; process.stdin.on('data',(c)=>data+=c); process.stdin.on('end',()=>{ if (data !== 'fixture payload') { process.stderr.write('payload mismatch: '+data.length); process.exit(2); } process.exit(0); });";
  await copyToClipboard("fixture payload", {
    resolveCommand: (): ClipboardCommand => ({
      command: process.execPath,
      args: ["-e", script],
    }),
  });
});

test("copyToClipboard rejects when the helper exits nonzero", async () => {
  await assert.rejects(
    copyToClipboard("fixture", {
      resolveCommand: (): ClipboardCommand => ({
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume(); process.stdin.on('end',()=>{ process.stderr.write('fixture failure'); process.exit(3); });",
        ],
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClipboardUnavailableError);
      assert.match(error.message, /exit 3/u);
      assert.match(error.message, /fixture failure/u);
      return true;
    },
  );
});

test("copyToClipboard rejects when the helper process cannot start", async () => {
  await assert.rejects(
    copyToClipboard("fixture", {
      resolveCommand: (): ClipboardCommand => ({
        command: "/definitely/missing/helper",
        args: [],
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClipboardUnavailableError);
      assert.match(error.message, /failed to start/u);
      return true;
    },
  );
});

test("copyToClipboard rejects when the helper times out", async () => {
  await assert.rejects(
    copyToClipboard("fixture", {
      timeoutMs: 100,
      resolveCommand: (): ClipboardCommand => ({
        command: process.execPath,
        args: ["-e", "setInterval(()=>{}, 1000);"],
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClipboardUnavailableError);
      assert.match(error.message, /timed out/u);
      return true;
    },
  );
});
