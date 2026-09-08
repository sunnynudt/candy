#!/usr/bin/env node

import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageScript = path.join(root, "scripts", "package-tui-release.mjs");

const args = parseArgs(process.argv.slice(2));

const releaseCommand = [
  process.execPath,
  packageScript,
  ...args.packageArgs,
];

let packageOutput;
try {
  packageOutput = execFileSync(releaseCommand[0], releaseCommand.slice(1), {
    cwd: root,
    encoding: "utf8",
  });
} catch (error) {
  const message = error.status === undefined
    ? error.message
    : `package script exited with status ${error.status}`;
  console.error(message);
  process.exit(1);
}

const match = /package complete:\s*(.+)\n/.exec(packageOutput);
if (match === null) {
  console.error("unable to locate release directory from package output");
  process.exit(1);
}

const releaseDir = match[1].trim();
const launcher = path.join(releaseDir, "bin", "candy.mjs");
if (!existsSync(launcher)) {
  console.error(`invalid release payload: missing ${launcher}`);
  process.exit(1);
}

const updateArgs = [launcher, "update", "--from", releaseDir];
if (args.force) {
  updateArgs.push("--force");
}
if (args.home !== undefined) {
  updateArgs.push("--home", args.home);
}

const updateResult = spawnSync(process.execPath, updateArgs, {
  cwd: root,
  stdio: "inherit",
});
if (updateResult.error !== undefined) {
  console.error(`update failed: ${updateResult.error.message}`);
  process.exit(1);
}
if (updateResult.status !== 0) {
  process.exit(updateResult.status ?? 1);
}

process.stdout.write(`\nUpdated local candy from: ${releaseDir}\n`);

function parseArgs(rawArgs) {
  const options = {
    packageArgs: [],
    force: false,
    home: undefined,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      commandHelp();
      process.exit(0);
    }

    if (arg === "--home") {
      options.home = rawArgs[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--home=")) {
      options.home = arg.slice("--home=".length);
      continue;
    }

    if (arg === "--version" || arg === "--platform" || arg === "--arch" || arg === "--output") {
      const value = rawArgs[index + 1];
      if (value === undefined || value === "") {
        console.error(`missing value for ${arg}`);
        process.exit(1);
      }
      options.packageArgs.push(arg, value);
      index += 1;
      continue;
    }
    if (
      arg.startsWith("--version=") ||
      arg.startsWith("--platform=") ||
      arg.startsWith("--arch=") ||
      arg.startsWith("--output=")
    ) {
      options.packageArgs.push(arg);
      continue;
    }

    console.error(`unknown argument: ${arg}`);
    process.exit(1);
  }

  return options;
}

function commandHelp() {
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  node scripts/package-tui-release-and-update.mjs [package options] [--home <path>] [--force]\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`package options: --version --platform --arch --output\n`);
  process.stdout.write(`release options: --home <path> --force\n`);
}
