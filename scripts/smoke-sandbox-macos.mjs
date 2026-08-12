import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createCandyWorkspaceOperations } from "@candy/pi-adapter";
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
    outsideReadBlocked: false,
    outsideWriteBlocked: false,
    symlinkReadBlocked: false,
    symlinkWriteBlocked: false,
    symlinkSwapBlocked: false,
    networkBlocked: false,
    descendantCancelled: false,
    descendantMarkerAbsent: false,
  },
};

if (!existsSync(runnerPath)) {
  execFileSync(
    "cargo",
    ["build", "--locked", "--manifest-path", path.join("native", "sandbox-runner", "Cargo.toml")],
    { stdio: "inherit" },
  );
}

const runner = new NativeProcessRunner(runnerPath);
const operations = createCandyWorkspaceOperations(workspace);
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

async function expectRejected(operation, message) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(message);
}

async function runNode(source, signal) {
  return runner.run({
    executable: process.execPath,
    args: ["-e", source],
    cwd: workspace,
    workspace,
    signal,
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

await mkdir(workspace, { recursive: true });
await mkdir(outside, { recursive: true });
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
    const networkResult = await runNode(
      `const net = require('node:net'); const socket = net.createConnection({host:'127.0.0.1', port:${address.port}}); socket.once('connect', () => { process.stdout.write('network-open'); process.exit(0); }); socket.once('error', () => { process.stdout.write('network-blocked'); process.exit(3); });`,
    );
    matrix.native.networkBlocked = networkResult.stdout === "network-blocked";
    if (!matrix.native.networkBlocked)
      throw new Error("macOS native no-network denial was not reproduced.");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }

  const descendantSource = `const fs = require('node:fs'); setTimeout(() => fs.writeFileSync(${JSON.stringify(descendantMarker)}, 'descendant-write'), 1200); setTimeout(() => {}, 5000);`;
  const parentSource = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], {stdio:'ignore'}); setTimeout(() => {}, 5000);`;
  const controller = new globalThis.AbortController();
  const pending = runNode(parentSource, controller.signal);
  await delay(150);
  controller.abort();
  const cancelled = await pending;
  matrix.native.descendantCancelled = cancelled.cancelled;
  await delay(1400);
  matrix.native.descendantMarkerAbsent = !existsSync(descendantMarker);
  if (!matrix.native.descendantCancelled || !matrix.native.descendantMarkerAbsent)
    throw new Error("macOS native runner did not prove descendant cancellation.");

  console.log(
    `macOS Sandbox Runner strict containment matrix passed: ${JSON.stringify({
      workspaceGuard: matrix.workspaceGuard,
      native: matrix.native,
      osWorkspaceContainment: "native-seatbelt-enforced",
      shellAuto: "disabled",
      shellAutoDebug: "disabled",
      independentSecurityReview: "blocked",
    })}`,
  );
} finally {
  await unlink(symlinkRoot).catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
