#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pinnedNode = "22.23.2";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tuiEntrypoint = path.join(root, "apps", "tui", "dist", "main.js");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    ...options,
  });

  if (result.error !== undefined) {
    console.error(`Candy process failed: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

function pinnedNodePath() {
  if (process.versions.node === pinnedNode) {
    return process.execPath;
  }

  if (process.platform === "win32") {
    const nvmHome = process.env.NVM_HOME || path.join(process.env.APPDATA ?? "", "nvm");
    const candidate = path.join(nvmHome, `v${pinnedNode}`, "node.exe");
    return existsSync(candidate) ? candidate : undefined;
  }

  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), ".nvm");
  const candidate = path.join(nvmDir, "versions", "node", `v${pinnedNode}`, "bin", "node");
  return existsSync(candidate) ? candidate : undefined;
}

function runWithPinnedNode() {
  const node = pinnedNodePath();
  if (node === undefined) {
    console.error(
      `Candy requires Node ${pinnedNode}; received ${process.version}. Run \`nvm use ${pinnedNode}\` first.`,
    );
    return 1;
  }

  const env = { ...process.env };
  env.PATH = `${path.dirname(node)}${path.delimiter}${env.PATH ?? ""}`;
  return run(node, [process.argv[1], ...process.argv.slice(2)], { env });
}

function buildCandy() {
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  return run(process.execPath, [tsc, "-b", "--pretty", "false"]);
}

if (process.versions.node !== pinnedNode) {
  process.exitCode = runWithPinnedNode();
} else {
  const buildStatus = buildCandy();
  if (buildStatus !== 0) {
    process.exitCode = buildStatus;
  } else if (!existsSync(tuiEntrypoint)) {
    console.error(`Candy build finished but ${tuiEntrypoint} is missing.`);
    process.exitCode = 1;
  } else {
    process.exitCode = run(process.execPath, [tuiEntrypoint, ...process.argv.slice(2)]);
  }
}
