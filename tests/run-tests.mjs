import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFiles = [];

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        await visit(absolute);
      }
      continue;
    }

    if (entry.name.endsWith(".test.js") && absolute.includes(`${path.sep}dist${path.sep}`)) {
      testFiles.push(absolute);
    }
  }
}

for (const directory of [path.join(root, "apps"), path.join(root, "packages")]) {
  await visit(directory);
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
