import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createCandyWorkspaceOperations } from "@candy/pi-adapter";
import { MacSandboxRunner } from "@candy/runtime";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("macOS Sandbox Runner G2 negative matrix skipped: not macOS arm64");
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
    outsideReadEscaped: false,
    outsideWriteEscaped: false,
    symlinkReadEscaped: false,
    symlinkWriteEscaped: false,
    symlinkSwapEscaped: false,
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

const runner = new MacSandboxRunner(runnerPath);
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

  const rawRead = await runNode(
    `const fs = require('node:fs'); process.stdout.write(fs.readFileSync(${JSON.stringify(outsideRead)}, 'utf8'));`,
  );
  matrix.native.outsideReadEscaped =
    rawRead.code === 0 && rawRead.stdout === "outside-read-fixture";
  if (!matrix.native.outsideReadEscaped)
    throw new Error(
      "The current macOS Seatbelt profile changed; review G2 evidence before proceeding.",
    );

  const rawWrite = await runNode(
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(outsideWrite)}, 'native-write'); process.stdout.write('write-ok');`,
  );
  matrix.native.outsideWriteEscaped =
    rawWrite.code === 0 &&
    rawWrite.stdout === "write-ok" &&
    (await readFile(outsideWrite, "utf8")) === "native-write";
  if (!matrix.native.outsideWriteEscaped)
    throw new Error(
      "The current macOS native runner did not reproduce the outside-workspace write gap.",
    );

  const rawSymlinkRead = await runNode(
    `const fs = require('node:fs'); process.stdout.write(fs.readFileSync(${JSON.stringify(symlinkRead)}, 'utf8'));`,
  );
  matrix.native.symlinkReadEscaped =
    rawSymlinkRead.code === 0 && rawSymlinkRead.stdout === "outside-read-fixture";
  if (!matrix.native.symlinkReadEscaped)
    throw new Error("The current macOS native runner did not reproduce the symlink read gap.");

  const rawSymlinkWrite = await runNode(
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(symlinkWrite)}, 'symlink-write'); process.stdout.write('write-ok');`,
  );
  matrix.native.symlinkWriteEscaped =
    rawSymlinkWrite.code === 0 &&
    rawSymlinkWrite.stdout === "write-ok" &&
    (await readFile(symlinkWrite, "utf8")) === "symlink-write";
  if (!matrix.native.symlinkWriteEscaped)
    throw new Error("The current macOS native runner did not reproduce the symlink write gap.");

  await mkdir(swapRoot);
  const rawSymlinkSwap = await runNode(
    `const fs = require('node:fs'); fs.lstatSync(${JSON.stringify(swapRoot)}); fs.renameSync(${JSON.stringify(swapRoot)}, ${JSON.stringify(swapBackup)}); fs.symlinkSync(${JSON.stringify(swapDestination)}, ${JSON.stringify(swapRoot)}, 'dir'); fs.writeFileSync(${JSON.stringify(path.join(swapRoot, "race.txt"))}, 'swap-write'); process.stdout.write('swap-ok');`,
  );
  matrix.native.symlinkSwapEscaped =
    rawSymlinkSwap.code === 0 &&
    rawSymlinkSwap.stdout === "swap-ok" &&
    (await readFile(swapMarker, "utf8")) === "swap-write";
  if (!matrix.native.symlinkSwapEscaped)
    throw new Error("The current macOS native runner did not reproduce the symlink-swap path gap.");

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
    `macOS Sandbox Runner G2 negative matrix passed: ${JSON.stringify({
      workspaceGuard: matrix.workspaceGuard,
      native: matrix.native,
      osWorkspaceContainment: "not-proven: allow default permits raw escape",
      shellAuto: "disabled",
      shellAutoDebug: "disabled",
      independentSecurityReview: "blocked",
    })}`,
  );
} finally {
  await unlink(symlinkRoot).catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
