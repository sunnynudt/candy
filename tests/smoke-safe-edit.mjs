import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCandyWorkspaceOperations } from "@candy/pi-adapter";
import { NativeProcessRunner } from "@candy/platform";
import { CommandValidator } from "@candy/runtime";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The local safe-edit smoke requires macOS arm64.");

const root = await mkdtemp(path.join(os.tmpdir(), "candy-safe-edit-"));
const source = path.join(root, "src", "value.ts");
const testFile = path.join(root, "src", "value.test.ts");
const runner = path.resolve("native/sandbox-runner/target/debug/candy-sandbox-runner");
if (!existsSync(runner)) throw new Error("Build the macOS Sandbox Runner before this smoke.");

try {
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "export const value: number = 1;\n", "utf8");
  await writeFile(
    testFile,
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { value } from './value.ts';",
      "test('fixture value', () => assert.equal(value, 2));",
      "",
    ].join("\n"),
    "utf8",
  );
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "candy-safe-edit@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Candy Safe Edit"]);
  execFileSync("git", ["-C", root, "add", "src/value.ts", "src/value.test.ts"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture baseline"]);
  const beforeCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  const operations = createCandyWorkspaceOperations(root);
  const before = (await operations.readFile(source)).toString("utf8");
  if (!before.includes("value: number = 1")) throw new Error("Fixture read step failed.");
  await operations.writeFile(source, "export const value: number = 2;\n");

  const result = await new CommandValidator(new NativeProcessRunner(runner)).run(
    {
      executable: process.execPath,
      args: ["--experimental-strip-types", "--test", "src/value.test.ts"],
    },
    root,
    new globalThis.AbortController().signal,
  );
  if (!result.ok) throw new Error("Fixture validator failed.");

  const diff = execFileSync("git", ["-C", root, "diff", "--", "src/value.ts"], {
    encoding: "utf8",
  });
  if (
    !diff.includes("-export const value: number = 1;") ||
    !diff.includes("+export const value: number = 2;")
  )
    throw new Error("Fixture diff step failed.");
  execFileSync("git", ["-C", root, "diff", "--cached", "--quiet"]);
  const afterCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (afterCommit !== beforeCommit)
    throw new Error("Safe-edit smoke committed changes unexpectedly.");
  if ((await readFile(source, "utf8")) !== "export const value: number = 2;\n")
    throw new Error("Fixture write step failed.");
  console.log("macOS safe-edit smoke ok: read -> edit -> validator -> diff, no commit");
} finally {
  await rm(root, { recursive: true, force: true });
}
