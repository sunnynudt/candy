#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherScript = path.join(root, "scripts", "package-tui-release-and-update.mjs");

const relevantPathMatchers = [
  /^apps\/tui\//u,
  /^packages\//u,
  /^scripts\//u,
  /^package\.json$/u,
  /^package-lock\.json$/u,
  /^tsconfig\.json$/u,
  /^tsconfig\.base\.json$/u,
  /^eslint\.config\.js$/u,
  /^\.prettierrc\.json$/u,
];

function isRelevantFile(filePath) {
  return relevantPathMatchers.some((matcher) => matcher.test(filePath));
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  commandHelp();
  process.exit(0);
}

const changedFiles = listChangedFiles(args.base, args.head);
const relevantFiles = changedFiles.filter(isRelevantFile);

if (!args.force && !args.all && relevantFiles.length === 0) {
  process.stdout.write("no runtime-relevant file changes; skip release build/update\n");
  process.exit(0);
}

const releaseArgs = [];
if (args.home !== undefined) {
  releaseArgs.push("--home", args.home);
}
if (args.force) {
  releaseArgs.push("--force");
}
releaseArgs.push(...args.packageArgs);

try {
  execFileSync(process.execPath, [launcherScript, ...releaseArgs], {
    cwd: root,
    stdio: "inherit",
  });
} catch (error) {
  if (error.status === undefined) {
    console.error(`release/update command failed: ${error.message}`);
    process.exit(1);
  }
  process.exit(error.status);
}

if (args.showDiff && changedFiles.length > 0) {
  process.stdout.write("\nruntime-relevant changes detected:\n");
  for (const file of relevantFiles) {
    process.stdout.write(`  ${file}\n`);
  }
}

function listChangedFiles(base, head) {
  try {
    const output = execFileSync("git", ["diff", "--name-only", `${base}..${head}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (output.length === 0) {
      return [];
    }
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    // If diff fails (for example unavailable history), force a safe default to rebuild.
    return ["all"];
  }
}

function parseArgs(rawArgs) {
  const options = {
    base: "HEAD^",
    head: "HEAD",
    force: false,
    all: false,
    showDiff: false,
    home: undefined,
    help: false,
    packageArgs: [],
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--show-diff") {
      options.showDiff = true;
      continue;
    }
    if (arg === "--base") {
      options.base = rawArgs[index + 1] ?? "HEAD^";
      index += 1;
      continue;
    }
    if (arg.startsWith("--base=")) {
      options.base = arg.slice("--base=".length);
      continue;
    }
    if (arg === "--head") {
      options.head = rawArgs[index + 1] ?? "HEAD";
      index += 1;
      continue;
    }
    if (arg.startsWith("--head=")) {
      options.head = arg.slice("--head=".length);
      continue;
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
      if (value === undefined || `${value}`.trim() === "") {
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
  process.stdout.write("Usage:\n");
  process.stdout.write(
    "  node scripts/package-tui-release-if-changed.mjs [package options] [--home <path>] [--base <ref>] [--head <ref>] [--force] [--all] [--show-diff]\n",
  );
  process.stdout.write("\n");
  process.stdout.write("package options: --version --platform --arch --output\n");
  process.stdout.write("default compare range: --base HEAD^ --head HEAD\n");
  process.stdout.write("only rebuild when runtime-relevant files changed by default:\n");
  process.stdout.write("  apps/tui/** packages/** scripts/** package*.json tsconfig*.json\n");
}
