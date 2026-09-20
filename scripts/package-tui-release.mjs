#!/usr/bin/env node

import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const PI_VERSION = "0.84.1";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  commandHelp();
  process.exit(0);
}

const shortRevision = gitValue(["rev-parse", "HEAD"])?.slice(0, 12) ?? "working-tree";
const platform = args.platform ?? process.platform;
const architecture = args.arch ?? process.arch;
const releaseVersion = sanitizeVersion(
  args.version ?? `${packageJson.version}-${platform}-${architecture}.${shortRevision}`,
);

const outputRoot = path.resolve(args.output ?? path.join(root, "out", "tui-release"));
const stagingRoot = path.join(outputRoot, `.staging-${process.pid}-${Date.now()}`);
const releaseRoot = path.join(outputRoot, `candy-${releaseVersion}`);

ensureTypeScriptBuild();

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });

await copyWithRuntimeDependencies();
await copySandboxRunner();
await makeBinBootstrap();
await writeManifest();
await writeInstallScripts();

await rm(releaseRoot, { recursive: true, force: true });
await rename(stagingRoot, releaseRoot);

process.stdout.write(`package complete: ${releaseRoot}\n`);
process.stdout.write(`release version: ${releaseVersion}\n`);
process.stdout.write(
  `install: ${path.join(releaseRoot, process.platform === "win32" ? "install.cmd" : "install.sh")}\n`,
);

/**
 * Ship the Candy Sandbox Runner inside the release payload.
 *
 * `resolveNativeProcessRunnerPath` resolves the runner next to the TUI module
 * (`apps/tui/native`). A release published without it loses offline local
 * commands, the native validator, and Full access as soon as Candy is launched
 * from outside the source checkout, so the payload carries its own runner
 * instead of depending on the launch directory.
 */
async function copySandboxRunner() {
  if (platform !== process.platform) {
    throw new Error(
      `Packaging ${platform} from ${process.platform} would omit the Candy Sandbox Runner; package on a ${platform} host instead.`,
    );
  }
  const nativeName = platform === "win32" ? "candy-sandbox-runner.exe" : "candy-sandbox-runner";
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      path.join(root, "native", "sandbox-runner", "Cargo.toml"),
    ],
    { stdio: "inherit" },
  );
  const source = path.join(root, "native", "sandbox-runner", "target", "debug", nativeName);
  if (!existsSync(source)) {
    throw new Error(`Candy Sandbox Runner build did not produce ${source}.`);
  }
  const target = path.join(stagingRoot, "apps", "tui", "native", nativeName);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target);
  if (platform !== "win32") await chmod(target, 0o755);
}

function parseArgs(rawArgs) {
  const options = {
    output: undefined,
    help: false,
    version: undefined,
    platform: undefined,
    arch: undefined,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      return options;
    }

    if (arg === "--output") {
      options.output = rawArgs[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
      continue;
    }

    if (arg === "--version") {
      options.version = rawArgs[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
      continue;
    }

    if (arg === "--platform") {
      options.platform = rawArgs[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      options.platform = arg.slice("--platform=".length);
      continue;
    }

    if (arg === "--arch") {
      options.arch = rawArgs[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--arch=")) {
      options.arch = arg.slice("--arch=".length);
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function commandHelp() {
  process.stdout.write(`Usage:\n`);
  process.stdout.write(
    `  node scripts/package-tui-release.mjs [--version <version>] [--platform <platform>] [--arch <arch>] [--output <path>]\n`,
  );
  process.stdout.write(`\n`);
  process.stdout.write(
    `--version  Version string for the release payload (defaults to package version + sha)\n`,
  );
  process.stdout.write(`--platform platform    e.g. darwin / win32\n`);
  process.stdout.write(`--arch architecture    e.g. arm64 / x64\n`);
  process.stdout.write(`--output path         Output root (default: out/tui-release)\n`);
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

function ensureTypeScriptBuild() {
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) {
    throw new Error("TypeScript compiler is required. Run npm ci first.");
  }

  execFileSync(process.execPath, [tsc, "-b", "--pretty", "false"], {
    cwd: root,
    stdio: "inherit",
  });
}

async function copyWithRuntimeDependencies() {
  const copies = [
    ["package.json", "package.json"],
    ["package-lock.json", "package-lock.json"],
    ["apps/tui", "apps/tui"],
    ["packages", "packages"],
    ["scripts/candy.mjs", "scripts/candy.mjs"],
  ];

  for (const [sourceRel, targetRel] of copies) {
    await cp(path.join(root, sourceRel), path.join(stagingRoot, targetRel), {
      recursive: true,
      dereference: false,
      force: true,
    });
  }

  const nodeSource = path.join(root, "node_modules");
  const nodeTarget = path.join(stagingRoot, "node_modules");
  const excludedNodeFolders = new Set([
    ".bin",
    "@eslint",
    "@types",
    "electron",
    "eslint",
    "prettier",
    "typescript",
    "typescript-eslint",
  ]);

  await cp(nodeSource, nodeTarget, {
    recursive: true,
    force: true,
    filter: (sourcePath) => {
      const relative = path.relative(nodeSource, sourcePath);
      if (relative.length === 0) {
        return true;
      }
      const top = relative.split(path.sep)[0];
      if (excludedNodeFolders.has(top)) {
        return false;
      }
      return true;
    },
  });
}

async function makeBinBootstrap() {
  const binRoot = path.join(stagingRoot, "bin");
  await mkdir(binRoot, { recursive: true });
  await cp(path.join(stagingRoot, "scripts", "candy.mjs"), path.join(binRoot, "candy.mjs"), {
    force: true,
  });
}

async function writeManifest() {
  const manifest = {
    kind: "candy-release",
    product: "candy",
    version: releaseVersion,
    packageVersion: packageJson.version,
    revision: shortRevision,
    platform,
    architecture,
    builtAt: new Date().toISOString(),
    node: process.version,
    pinnedNode: packageJson.engines?.node ?? "22.23.2",
    piVersion: PI_VERSION,
  };

  await writeFile(
    path.join(stagingRoot, "candy-release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function writeInstallScripts() {
  const installSh = `#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/bin/candy.mjs" update --from "$SCRIPT_DIR"\n`;
  const installShPath = path.join(stagingRoot, "install.sh");
  await writeFile(installShPath, `${installSh}\n`);
  await chmod(installShPath, 0o755);

  const installCmd = `@echo off\r\nnode "%~dp0bin\\candy.mjs" update --from "%~dp0"\r\n`;
  await writeFile(path.join(stagingRoot, "install.cmd"), `${installCmd}\n`);
}

function sanitizeVersion(value) {
  const safe = `${value}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.+_-]/gu, "-")
    .replace(/-+/gu, "-");
  return safe.replace(/^-+|-+$/gu, "").replace(/\.+$/u, "");
}
