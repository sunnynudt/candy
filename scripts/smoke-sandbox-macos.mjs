import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createCandyBashOperations, createCandyWorkspaceOperations } from "@candy/pi-adapter";
import { NativeProcessRunner } from "@candy/platform";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("macOS Sandbox Runner strict containment matrix skipped: not macOS arm64");
  process.exit(0);
}

const root = await mkdtemp(path.join(os.tmpdir(), "candy-sandbox-g2-macos-"));
const workspace = path.join(root, "workspace");
const outside = path.join(root, "outside");
const runnerPath = path.resolve(
  "native",
  "sandbox-runner",
  "target",
  "debug",
  "candy-sandbox-runner",
);
const matrix = {
  workspaceGuard: {
    outsideReadRejected: false,
    outsideWriteRejected: false,
    symlinkReadRejected: false,
    symlinkWriteRejected: false,
  },
  native: {
    validatorSucceeded: false,
    gitWorktreeSucceeded: false,
    gitMetadataWriteBlocked: false,
    gitRefUpdateBlocked: false,
    gitReflogWriteBlocked: false,
    outsideReadBlocked: false,
    outsideWriteBlocked: false,
    symlinkReadBlocked: false,
    symlinkWriteBlocked: false,
    symlinkSwapBlocked: false,
    networkBlockedByDefault: false,
    networkEnabledByExplicitCapability: false,
    descendantCancelled: false,
    descendantMarkerAbsent: false,
    ordinaryDescendantMarkerAbsent: false,
    parentExitLauncherKilled: false,
    parentExitMarkerAbsent: false,
  },
};

execFileSync(
  "cargo",
  ["build", "--locked", "--manifest-path", path.join("native", "sandbox-runner", "Cargo.toml")],
  { stdio: "inherit" },
);

const runner = new NativeProcessRunner(runnerPath);
const operations = createCandyWorkspaceOperations(workspace);
const shellOperations = createCandyBashOperations(workspace, { runner });
const outsideRead = path.join(outside, "read.txt");
const outsideWrite = path.join(outside, "native-write.txt");
const symlinkRoot = path.join(workspace, "link");
const symlinkRead = path.join(symlinkRoot, "read.txt");
const symlinkWrite = path.join(symlinkRoot, "native-write.txt");
const swapRoot = path.join(workspace, "swap");
const swapBackup = path.join(workspace, "swap-before-link");
const swapDestination = path.join(outside, "swap-destination");
const swapMarker = path.join(swapDestination, "race.txt");
const descendantMarker = path.join(workspace, "descendant-marker.txt");
const ordinaryDescendantMarker = path.join(workspace, "ordinary-descendant-marker.txt");
const parentExitMarker = path.join(workspace, "parent-exit-marker.txt");
let parentExitLauncher;

async function expectRejected(operation, message) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(message);
}

async function runNode(source, signal, network = false, allowProcessExec = false) {
  return runner.run({
    executable: process.execPath,
    args: ["-e", source],
    cwd: workspace,
    workspace,
    network,
    allowProcessExec,
    processExecPaths: allowProcessExec ? [path.dirname(process.execPath)] : [],
    signal,
  });
}

async function runShell(command, signal, network = false) {
  return runner.run({
    executable: "/bin/bash",
    args: ["--noprofile", "--norc", "-c", command],
    cwd: workspace,
    workspace,
    network,
    allowProcessExec: true,
    processExecPaths: [path.dirname(process.execPath)],
    environment: {
      HOME: workspace,
      PATH: "/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    readOnlyPaths: [
      path.join(workspace, ".git"),
      path.join(repository, ".git"),
      path.join(repository, ".git", "worktrees", path.basename(workspace)),
    ],
    signal,
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

await mkdir(outside, { recursive: true });
const repository = path.join(root, "repository");
await mkdir(repository, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
await writeFile(path.join(repository, "README.md"), "git-worktree-fixture\n", "utf8");
execFileSync("git", ["add", "README.md"], { cwd: repository });
execFileSync(
  "git",
  [
    "-c",
    "user.name=Candy Fixture",
    "-c",
    "user.email=candy@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ],
  { cwd: repository },
);
execFileSync(
  "git",
  ["worktree", "add", "-q", "--detach", "--lock", "--reason", "candy:smoke", workspace, "main"],
  { cwd: repository },
);
await writeFile(outsideRead, "outside-read-fixture", "utf8");
await mkdir(swapDestination, { recursive: true });
await writeFile(path.join(workspace, "inside.txt"), "inside-fixture", "utf8");
await symlink(outside, symlinkRoot, "dir");

try {
  await expectRejected(
    () => operations.readFile(outsideRead),
    "WorkspaceGuard allowed a non-workspace read.",
  );
  matrix.workspaceGuard.outsideReadRejected = true;
  await expectRejected(
    () => operations.writeFile(outsideWrite, "guard-write"),
    "WorkspaceGuard allowed a non-workspace write.",
  );
  matrix.workspaceGuard.outsideWriteRejected = true;
  await expectRejected(
    () => operations.readFile(symlinkRead),
    "WorkspaceGuard allowed a symlinked read.",
  );
  matrix.workspaceGuard.symlinkReadRejected = true;
  await expectRejected(
    () => operations.writeFile(symlinkWrite, "guard-write"),
    "WorkspaceGuard allowed a symlinked write.",
  );
  matrix.workspaceGuard.symlinkWriteRejected = true;

  const validator = await runNode("process.stdout.write('validator-ok');");
  matrix.native.validatorSucceeded = validator.code === 0 && validator.stdout === "validator-ok";
  if (!matrix.native.validatorSucceeded)
    throw new Error("macOS native runner rejected the supported validator fixture.");

  const gitStatus = await runShell(
    "git status --short --branch && git rev-parse --show-toplevel && printf git-worktree-ok",
  );
  matrix.native.gitWorktreeSucceeded =
    gitStatus.code === 0 &&
    gitStatus.stdout.includes("git-worktree-ok") &&
    gitStatus.stdout.includes(workspace);
  if (!matrix.native.gitWorktreeSucceeded)
    throw new Error("The macOS native runner rejected a real Git Task Worktree.");

  const gitCommit = await runShell(
    "git -c user.name=Candy -c user.email=candy@example.invalid commit --allow-empty -qm blocked-commit",
  );
  matrix.native.gitMetadataWriteBlocked =
    gitCommit.code !== 0 && /Operation not permitted|Permission denied/u.test(gitCommit.stderr);
  if (!matrix.native.gitMetadataWriteBlocked)
    throw new Error("The macOS native runner allowed a Git metadata write.");

  const gitRefUpdate = await runShell("git update-ref refs/heads/main HEAD");
  matrix.native.gitRefUpdateBlocked =
    gitRefUpdate.code !== 0 &&
    /Operation not permitted|Permission denied/u.test(gitRefUpdate.stderr);
  if (!matrix.native.gitRefUpdateBlocked)
    throw new Error("The macOS native runner allowed a Git ref update.");

  const gitReflog = await runShell("git reflog expire --all");
  matrix.native.gitReflogWriteBlocked =
    gitReflog.code !== 0 && /Operation not permitted|Permission denied/u.test(gitReflog.stderr);
  if (!matrix.native.gitReflogWriteBlocked)
    throw new Error("The macOS native runner allowed a Git reflog write.");

  const rawRead = await runNode(
    `const fs = require('node:fs'); process.stdout.write(fs.readFileSync(${JSON.stringify(outsideRead)}, 'utf8'));`,
  );
  matrix.native.outsideReadBlocked =
    rawRead.code !== 0 && rawRead.stdout !== "outside-read-fixture";
  if (!matrix.native.outsideReadBlocked)
    throw new Error("The macOS native runner allowed a workspace-external read.");

  const rawWrite = await runNode(
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(outsideWrite)}, 'native-write'); process.stdout.write('write-ok');`,
  );
  matrix.native.outsideWriteBlocked = rawWrite.code !== 0 && !existsSync(outsideWrite);
  if (!matrix.native.outsideWriteBlocked)
    throw new Error("The macOS native runner allowed a workspace-external write.");

  const rawSymlinkRead = await runNode(
    `const fs = require('node:fs'); process.stdout.write(fs.readFileSync(${JSON.stringify(symlinkRead)}, 'utf8'));`,
  );
  matrix.native.symlinkReadBlocked =
    rawSymlinkRead.code !== 0 && rawSymlinkRead.stdout !== "outside-read-fixture";
  if (!matrix.native.symlinkReadBlocked)
    throw new Error("The macOS native runner allowed a symlinked external read.");

  const rawSymlinkWrite = await runNode(
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(symlinkWrite)}, 'symlink-write'); process.stdout.write('write-ok');`,
  );
  matrix.native.symlinkWriteBlocked = rawSymlinkWrite.code !== 0 && !existsSync(symlinkWrite);
  if (!matrix.native.symlinkWriteBlocked)
    throw new Error("The macOS native runner allowed a symlinked external write.");

  await mkdir(swapRoot);
  const rawSymlinkSwap = await runNode(
    `const fs = require('node:fs'); fs.lstatSync(${JSON.stringify(swapRoot)}); fs.renameSync(${JSON.stringify(swapRoot)}, ${JSON.stringify(swapBackup)}); fs.symlinkSync(${JSON.stringify(swapDestination)}, ${JSON.stringify(swapRoot)}, 'dir'); fs.writeFileSync(${JSON.stringify(path.join(swapRoot, "race.txt"))}, 'swap-write'); process.stdout.write('swap-ok');`,
  );
  matrix.native.symlinkSwapBlocked = rawSymlinkSwap.code !== 0 && !existsSync(swapMarker);
  if (!matrix.native.symlinkSwapBlocked)
    throw new Error("The macOS native runner allowed a symlink-swap external write.");

  const server = net.createServer((socket) => socket.end("unexpected-connect"));
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("G2 network fixture failed to listen.");
    const offlineNetworkResult = await runNode(
      `const net = require('node:net'); const socket = net.createConnection({host:'127.0.0.1', port:${address.port}}); socket.once('connect', () => { process.stdout.write('network-open'); process.exit(0); }); socket.once('error', () => { process.stdout.write('network-blocked'); process.exit(3); });`,
    );
    matrix.native.networkBlockedByDefault = offlineNetworkResult.stdout === "network-blocked";
    if (!matrix.native.networkBlockedByDefault)
      throw new Error("macOS native no-network denial was not reproduced.");
    const elevatedNetworkResult = await runNode(
      `const net = require('node:net'); const socket = net.createConnection({host:'127.0.0.1', port:${address.port}}); socket.once('connect', () => { process.stdout.write('network-open'); socket.end(); }); socket.once('error', () => { process.stdout.write('network-blocked'); process.exit(3); });`,
      undefined,
      true,
    );
    matrix.native.networkEnabledByExplicitCapability =
      elevatedNetworkResult.stdout === "network-open";
    if (!matrix.native.networkEnabledByExplicitCapability)
      throw new Error("macOS native explicit network capability was not reproduced.");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }

  const descendantSource = `const fs = require('node:fs'); setTimeout(() => fs.writeFileSync(${JSON.stringify(descendantMarker)}, 'descendant-write'), 1200); setTimeout(() => {}, 5000);`;
  const parentSource = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {stdio:'ignore'}); setTimeout(() => {}, 5000);`;
  const controller = new globalThis.AbortController();
  const pending = runNode(parentSource, controller.signal, false, true);
  await delay(150);
  controller.abort();
  const cancelled = await pending;
  matrix.native.descendantCancelled = cancelled.cancelled;
  await delay(1400);
  matrix.native.descendantMarkerAbsent = !existsSync(descendantMarker);
  if (!matrix.native.descendantCancelled || !matrix.native.descendantMarkerAbsent)
    throw new Error("macOS native runner did not prove descendant cancellation.");

  const ordinaryDescendantSource = `const fs = require('node:fs'); setTimeout(() => fs.writeFileSync(${JSON.stringify(ordinaryDescendantMarker)}, 'ordinary-descendant-write'), 1200); setTimeout(() => {}, 5000);`;
  const ordinaryShell = await shellOperations.exec(
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify(ordinaryDescendantSource)} & exit 0`,
    workspace,
    { onData: () => undefined },
  );
  await delay(1400);
  matrix.native.ordinaryDescendantMarkerAbsent =
    ordinaryShell.exitCode === 0 && !existsSync(ordinaryDescendantMarker);
  if (!matrix.native.ordinaryDescendantMarkerAbsent)
    throw new Error("Trusted Shell left a descendant after ordinary command completion.");

  const parentExitSource = `const fs = require('node:fs'); setTimeout(() => fs.writeFileSync(${JSON.stringify(parentExitMarker)}, 'parent-exit-write'), 1200); setTimeout(() => {}, 5000);`;
  const launcherSource = `import { NativeProcessRunner } from "@candy/platform";
const runner = new NativeProcessRunner(${JSON.stringify(runnerPath)}, "darwin");
await runner.run({ executable: process.execPath, args: ["-e", ${JSON.stringify(parentExitSource)}], cwd: ${JSON.stringify(workspace)}, workspace: ${JSON.stringify(workspace)} });`;
  parentExitLauncher = spawn(process.execPath, ["--input-type=module", "-e", launcherSource], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  await delay(150);
  parentExitLauncher.kill("SIGKILL");
  await new Promise((resolve) => parentExitLauncher.once("close", resolve));
  matrix.native.parentExitLauncherKilled = true;
  await delay(1400);
  matrix.native.parentExitMarkerAbsent = !existsSync(parentExitMarker);
  if (!matrix.native.parentExitMarkerAbsent)
    throw new Error("macOS native runner left a descendant after its parent exited.");

  console.log(
    `macOS Sandbox Runner strict containment matrix passed: ${JSON.stringify({
      workspaceGuard: matrix.workspaceGuard,
      native: matrix.native,
      osWorkspaceContainment: "native-seatbelt-enforced",
      macosTuiTrustedShellAuto: "implementation-only; independent-g2-review-blocked",
      shellAutoDebug: "disabled",
      independentSecurityReview: "blocked",
    })}`,
  );
} finally {
  parentExitLauncher?.kill("SIGKILL");
  await unlink(symlinkRoot).catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
