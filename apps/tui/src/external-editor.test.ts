import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ExternalEditorUnavailableError,
  launchExternalEditor,
  normalizeEditorOutput,
  resolveExternalEditorCommand,
} from "./external-editor.js";

test("external editor resolution honors VISUAL, then EDITOR, then platform defaults", () => {
  assert.deepEqual(resolveExternalEditorCommand({ VISUAL: "code -w" }), {
    command: "code",
    args: ["-w"],
  });
  assert.deepEqual(resolveExternalEditorCommand({ EDITOR: "nvim" }), {
    command: "nvim",
    args: [],
  });
  assert.deepEqual(resolveExternalEditorCommand({}, "win32"), {
    command: "notepad.exe",
    args: [],
  });
  assert.deepEqual(resolveExternalEditorCommand({}, "darwin"), {
    command: "nano",
    args: [],
  });
  assert.deepEqual(resolveExternalEditorCommand({ VISUAL: "   " }, "darwin"), {
    command: "nano",
    args: [],
  });
});

test("editor output normalization strips CRLF and the editor trailing newline", () => {
  assert.equal(normalizeEditorOutput("keep", "edited\n"), "edited");
  assert.equal(normalizeEditorOutput("keep", "edited\r\n"), "edited");
  assert.equal(normalizeEditorOutput("keep", "edited"), "edited");
  assert.equal(normalizeEditorOutput("multi\nline\n", "multi\nline\n"), "multi\nline\n");
  assert.equal(normalizeEditorOutput("keep", "edited\r\n\n"), "edited\n");
});

test("launchExternalEditor resolves with the editor exit code and a written file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-external-editor-"));
  const target = path.join(root, "draft.txt");
  try {
    const script =
      "process.stdin.resume(); const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'from editor'); process.exit(0);";
    const code = await launchExternalEditor(target, {
      resolveCommand: () => ({ command: process.execPath, args: ["-e", script] }),
    });
    assert.equal(code, 0);
    assert.equal(await readFile(target, "utf8"), "from editor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchExternalEditor rejects when the editor command cannot start", async () => {
  await assert.rejects(
    launchExternalEditor("/tmp/nonexistent-target.txt", {
      resolveCommand: () => ({ command: "/definitely/missing/editor", args: [] }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ExternalEditorUnavailableError);
      assert.match(error.message, /failed to start/u);
      return true;
    },
  );
});

test("launchExternalEditor resolves nonzero exit codes as failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-external-editor-fail-"));
  const target = path.join(root, "draft.txt");
  try {
    await writeFile(target, "original");
    const code = await launchExternalEditor(target, {
      resolveCommand: () => ({
        command: process.execPath,
        args: ["-e", "process.exit(7);"],
      }),
    });
    assert.equal(code, 7);
    assert.equal(await readFile(target, "utf8"), "original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
