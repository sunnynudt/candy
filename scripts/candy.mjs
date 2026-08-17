#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tuiEntrypoint = path.join(root, "apps", "tui", "dist", "main.js");

if (!existsSync(tuiEntrypoint)) {
  console.error("Candy is not built. Run `npm run build` in the Candy repository first.");
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [tuiEntrypoint, ...process.argv.slice(2)], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    console.error(`Candy could not start: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
