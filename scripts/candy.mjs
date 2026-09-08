#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pinnedNode = "22.23.2";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const invocationCwd = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const piVersion = "0.84.1";
const tuiEntrypoint = path.join(root, "apps", "tui", "dist", "main.js");
const releaseMetadata = readReleaseMetadata(path.join(root, "candy-release.json"));

const RELEASE_BINARY = path.join("..", "current", "bin", "candy.mjs");
const RELEASE_MANIFEST_NAME = "candy-release.json";

function readReleaseMetadata(manifestPath) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest?.kind === "candy-release") {
      return manifest;
    }
  } catch {
    // Not a release package.
  }
  return null;
}

function gitValue(args) {
  try {
    const value = execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

function launchMetadata() {
  if (releaseMetadata === null) {
    const revision = gitValue(["rev-parse", "HEAD"]);
    const upstream = gitValue(["rev-parse", "origin/codex/candy-v1-foundation"]);
    const dirty = gitValue(["status", "--porcelain"]) !== undefined;
    const stable = revision !== undefined && !dirty && revision === upstream;
    return {
      product: "candy",
      kind: "launcher",
      version: packageJson.version,
      channel: stable ? "stable" : "candidate",
      revision: revision ?? null,
      stableRevision: upstream ?? null,
      dirty,
      node: process.version,
      pinnedNode,
      piVersion,
      invocationCwd,
      rollback: stable
        ? `git worktree add <recovery-path> ${revision}`
        : "unavailable-without-an-upstream-revision",
    };
  }

  return {
    product: "candy",
    kind: "release-launcher",
    version: releaseMetadata.version,
    releaseVersion: releaseMetadata.version,
    packageVersion: packageJson.version,
    channel: "release",
    revision: releaseMetadata.revision ?? null,
    stableRevision: releaseMetadata.revision ?? null,
    dirty: false,
    node: process.version,
    pinnedNode,
    piVersion,
    invocationCwd,
    platform: releaseMetadata.platform,
    architecture: releaseMetadata.architecture,
    builtAt: releaseMetadata.builtAt,
    rollback: releaseMetadata.revision
      ? `rollback to ${releaseMetadata.revision} by git worktree`
      : "release-revision-not-recorded",
  };
}

function parseInvocation() {
  const rawArgs = process.argv.slice(2);
  let command;
  let commandIndex = -1;
  for (let index = 0; index < rawArgs.length; index += 1) {
    if (!rawArgs[index].startsWith("-")) {
      command = rawArgs[index];
      commandIndex = index;
      break;
    }
  }

  return {
    command,
    commandArgs: commandIndex === -1 ? [] : rawArgs.slice(commandIndex + 1),
    rawArgs,
  };
}

function parseSubcommandOptions(args) {
  const options = { from: undefined, home: undefined, force: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      return options;
    }
    if (arg === "--from") {
      options.from = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--from=")) {
      options.from = arg.slice("--from=".length);
      continue;
    }
    if (arg === "--home") {
      options.home = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--home=")) {
      options.home = arg.slice("--home=".length);
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
  }

  return options;
}

function installHomeFromArgs(args) {
  if (args.home !== undefined) {
    return path.resolve(args.home);
  }
  if (process.env.CANDY_INSTALL_HOME && process.env.CANDY_INSTALL_HOME.trim() !== "") {
    return process.env.CANDY_INSTALL_HOME;
  }
  if (process.env.CANDY_HOME && process.env.CANDY_HOME.trim() !== "") {
    return process.env.CANDY_HOME;
  }
  return path.join(os.homedir(), ".candy");
}

function realPathSafe(target) {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function commandHelp() {
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  candy [tui args]\n`);
  process.stdout.write(`  candy --version\n`);
  process.stdout.write(`  candy update --from <release-dir> [--home <path>] [--force]\n`);
  process.stdout.write(`  candy rollback [--home <path>]\n`);
  return 0;
}

function ensureDir(target) {
  mkdirSync(target, { recursive: true });
}

function rebuildDirSymlink(target, link) {
  if (existsSync(link)) {
    rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function ensureCommandShim(installRoot) {
  const shellPath = path.join(
    installRoot,
    "bin",
    process.platform === "win32" ? "candy.cmd" : "candy",
  );
  ensureDir(path.dirname(shellPath));
  if (existsSync(shellPath)) {
    rmSync(shellPath, { recursive: true, force: true });
  }
  if (process.platform === "win32") {
    // V2 scoped, currently kept for future parity and explicit local installs.
    // Keep a simple copy now for predictable execution from non-WSL shells.
    cpSync(path.join(installRoot, "current", "bin", "candy.mjs"), shellPath);
    return;
  }
  symlinkSync(RELEASE_BINARY, shellPath, "file");
}

function commandUpdate(rawArgs) {
  const options = parseSubcommandOptions(rawArgs);
  if (options.help) {
    return commandHelp();
  }

  if (options.from === undefined || options.from.trim() === "") {
    console.error("missing --from <release-dir>");
    return 1;
  }

  const source = path.resolve(options.from);
  const sourceManifest = readReleaseMetadata(path.join(source, RELEASE_MANIFEST_NAME));
  if (sourceManifest === null) {
    console.error(`missing release manifest: ${path.join(source, RELEASE_MANIFEST_NAME)}`);
    return 1;
  }

  const version = sourceManifest.version;
  if (version === undefined || `${version}`.trim() === "") {
    console.error("release manifest is missing a version field");
    return 1;
  }

  const installRoot = installHomeFromArgs(options);
  const versionsRoot = path.join(installRoot, "versions");
  const targetRoot = path.join(versionsRoot, version);

  const currentLink = path.join(installRoot, "current");
  const previousLink = path.join(installRoot, "previous");
  const stagingRoot = path.join(versionsRoot, `.staging-${version}-${process.pid}-${Date.now()}`);

  const currentReal = realPathSafe(currentLink);
  const stagingExists = existsSync(stagingRoot);
  if (stagingExists) {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  if (currentReal === targetRoot && !options.force) {
    console.log(`already current: ${version}`);
    return 0;
  }

  ensureDir(versionsRoot);
  cpSync(source, stagingRoot, { recursive: true, dereference: true });
  if (existsSync(targetRoot)) {
    rmSync(targetRoot, { recursive: true, force: true });
  }
  renameSync(stagingRoot, targetRoot);

  if (!existsSync(path.join(targetRoot, "bin", "candy.mjs"))) {
    console.error(`invalid release payload: missing ${path.join(targetRoot, "bin", "candy.mjs")}`);
    return 1;
  }

  if (existsSync(previousLink)) {
    rmSync(previousLink, { recursive: true, force: true });
  }
  if (existsSync(currentLink)) {
    renameSync(currentLink, previousLink);
  }

  rebuildDirSymlink(path.resolve(targetRoot), currentLink);
  ensureCommandShim(installRoot);

  process.stdout.write(`installed candy ${version}\n`);
  process.stdout.write(`location: ${targetRoot}\n`);
  process.stdout.write(
    `release command: ${path.join(installRoot, "bin", process.platform === "win32" ? "candy.cmd" : "candy")}\n`,
  );
  return 0;
}

function commandRollback() {
  const options = parseSubcommandOptions(parseInvocation().commandArgs);
  const installRoot = installHomeFromArgs(options);
  const currentLink = path.join(installRoot, "current");
  const previousLink = path.join(installRoot, "previous");

  const current = realPathSafe(currentLink);
  const previous = realPathSafe(previousLink);
  if (current === null || previous === null) {
    console.error("rollback target unavailable");
    return 1;
  }

  if (current === previous) {
    console.error("rollback target is the same as current");
    return 1;
  }

  rebuildDirSymlink(previous, currentLink);
  rebuildDirSymlink(current, previousLink);

  process.stdout.write(`rollback complete: current now points to ${path.basename(previous)}\n`);
  return 0;
}

function runWithPinnedNode(args, options = {}) {
  const nodePath = process.env.CANDY_NODE?.trim() ?? undefined;
  const resolved = nodePath && existsSync(nodePath) ? nodePath : pinnedNodePath();
  if (resolved === undefined) {
    console.error(
      `Candy requires Node ${pinnedNode}; received ${process.version}. Run \`nvm use ${pinnedNode}\` first.`,
    );
    return 1;
  }

  const env = { ...process.env };
  env.PATH = `${path.dirname(resolved)}${path.delimiter}${env.PATH ?? ""}`;
  return run(resolved, args, options);
}

function pinnedNodePath() {
  const releaseNode = path.join(
    root,
    "node",
    "bin",
    process.platform === "win32" ? "node.exe" : "node",
  );
  if (existsSync(releaseNode)) {
    return releaseNode;
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

function buildCandy() {
  if (releaseMetadata !== null) {
    return 0;
  }

  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  return run(process.execPath, [tsc, "-b", "--pretty", "false"]);
}

function launch() {
  if (!existsSync(tuiEntrypoint)) {
    console.error(`Candy build finished but ${tuiEntrypoint} is missing.`);
    return 1;
  }

  const launchArgs = process.argv.slice(2);
  if (process.versions.node === pinnedNode) {
    return run(process.execPath, [tuiEntrypoint, ...launchArgs], { cwd: invocationCwd });
  }

  return runWithPinnedNode([tuiEntrypoint, ...launchArgs], { cwd: invocationCwd });
}

function main() {
  const { command, commandArgs, rawArgs } = parseInvocation();

  if (rawArgs.includes("--help") || rawArgs.includes("-h") || command === "help") {
    return commandHelp();
  }

  if (command === undefined && rawArgs.includes("--version")) {
    process.stdout.write(`${JSON.stringify(launchMetadata())}\n`);
    return 0;
  }

  if (command === "update") {
    return commandUpdate(commandArgs);
  }
  if (command === "rollback") {
    return commandRollback();
  }

  const buildStatus = buildCandy();
  if (buildStatus !== 0) {
    return buildStatus;
  }

  return launch();
}

process.exitCode = main();
