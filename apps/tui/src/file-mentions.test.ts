import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createWorkspaceMentionAutocompleteProvider,
  expandWorkspaceMentionPrompt,
} from "./file-mentions.js";

test("workspace @file mentions add bounded file context to the prompt", async () => {
  const root = await mkdtemp(path.join(process.cwd(), "candy-file-mention-"));
  try {
    const sourcePath = path.join(root, "src", "index.ts");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "export const answer = 42;\n", "utf8");

    const expanded = await expandWorkspaceMentionPrompt("Explain @src/index.ts", root);

    assert.equal(
      expanded.prompt,
      'Explain [workspace file: src/index.ts]\n\n<workspace-context>\n<file path="src/index.ts">\nexport const answer = 42;\n</file>\n</workspace-context>',
    );
    assert.deepEqual(expanded.expandedPaths, ["src/index.ts"]);
    assert.deepEqual(expanded.skippedPaths, []);
    assert.equal(await readFile(sourcePath, "utf8"), "export const answer = 42;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace @directory mentions include nested text files and redact active secrets", async () => {
  const root = await mkdtemp(path.join(process.cwd(), "candy-directory-mention-"));
  try {
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "const token = fixture-secret;\n", "utf8");
    await writeFile(
      path.join(root, "src", "nested", "util.ts"),
      "export const ok = true;\n",
      "utf8",
    );

    const expanded = await expandWorkspaceMentionPrompt("Review @src", root, ["fixture-secret"]);

    assert.equal(
      expanded.prompt,
      'Review [workspace directory: src]\n\n<workspace-context>\n<directory path="src">\n<file path="src/index.ts">\nconst token = [REDACTED];\n</file>\n<file path="src/nested/util.ts">\nexport const ok = true;\n</file>\n</directory>\n</workspace-context>',
    );
    assert.deepEqual(expanded.expandedPaths, ["src"]);
    assert.deepEqual(expanded.skippedPaths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace @ autocomplete lists files and directories inside the selected workspace", async () => {
  const root = await mkdtemp(path.join(process.cwd(), "candy-autocomplete-mention-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");

    const provider = createWorkspaceMentionAutocompleteProvider(() => root);
    const line = "Review @src/";
    const suggestions = await provider.getSuggestions([line], 0, line.length, {
      signal: new AbortController().signal,
    });

    assert.ok(suggestions);
    assert.equal(suggestions.prefix, "@src/");
    const item = suggestions.items.find((candidate) => candidate.value === "@src/index.ts");
    assert.ok(item);
    const completed = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
    assert.deepEqual(completed.lines, ["Review @src/index.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace @ autocomplete lists entries from the workspace root", async () => {
  const root = await mkdtemp(path.join(process.cwd(), "candy-root-autocomplete-mention-"));
  try {
    await mkdir(path.join(root, "apps"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Candy\n", "utf8");

    const provider = createWorkspaceMentionAutocompleteProvider(() => root);
    const suggestions = await provider.getSuggestions(["@"], 0, 1, {
      signal: new AbortController().signal,
    });

    assert.ok(suggestions);
    assert.equal(suggestions.prefix, "@");
    assert.ok(suggestions.items.some((candidate) => candidate.value === "@README.md"));
    assert.ok(suggestions.items.some((candidate) => candidate.value === "@apps/"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
