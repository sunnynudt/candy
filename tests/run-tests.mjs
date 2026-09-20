import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFiles = [];

async function visit(directory, outputDirectory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        await visit(absolute, path.join(outputDirectory, entry.name));
      }
      continue;
    }

    if (entry.name.endsWith(".test.ts")) {
      const compiled = path.join(outputDirectory, entry.name.replace(/\.ts$/u, ".js"));
      await access(compiled);
      testFiles.push(compiled);
    }
  }
}

for (const workspace of ["apps", "packages"]) {
  for (const entry of await readdir(path.join(root, workspace), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, workspace, entry.name);
    await visit(path.join(directory, "tests"), path.join(directory, "build"));
  }
}

testFiles.sort();
if (testFiles.length === 0) {
  throw new Error("No compiled test files were found.");
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  encoding: "utf8",
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
