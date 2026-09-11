import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NativeProcessRunner } from "@candy/platform";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("macOS Full access smoke skipped: requires macOS arm64");
  process.exit(0);
}

const root = await mkdtemp(path.join(os.tmpdir(), "candy-full-access-macos-"));
const workspace = path.join(root, "workspace");
const outside = path.join(root, "outside");
const runnerPath = path.resolve(
  "native",
  "sandbox-runner",
  "target",
  "debug",
  "candy-sandbox-runner",
);
const outsideMarker = path.join(outside, "outside-marker.txt");
const cancelledMarker = path.join(outside, "cancelled-descendant-marker.txt");
const parentLossMarker = path.join(outside, "parent-loss-marker.txt");
const probeVariable = "CANDY_FULL_ACCESS_SMOKE_SECRET";
const activeSecret = `full-access-smoke-${randomBytes(16).toString("hex")}`;
const matrix = {
  outsideFilesystem: false,
  loopbackNetwork: false,
  credentialProbeAbsent: false,
  cancelledDescendantAbsent: false,
  parentLossDescendantAbsent: false,
};

function delay(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function waitForClose(child) {
  await Promise.race([
    once(child, "close"),
    delay(5_000).then(() => {
      throw new Error("Full access launcher did not exit after termination.");
    }),
  ]);
}

async function runFullAccess(runner, args, options = {}) {
  return await runner.run({
    executable: process.execPath,
    args,
    cwd: workspace,
    workspace,
    network: true,
    fullAccess: true,
    allowProcessExec: true,
    activeSecrets: [activeSecret],
    ...options,
  });
}

await mkdir(workspace, { recursive: true });
await mkdir(outside, { recursive: true });
execFileSync(
  "cargo",
  ["build", "--locked", "--manifest-path", path.join("native", "sandbox-runner", "Cargo.toml")],
  { stdio: "inherit" },
);
if (!existsSync(runnerPath)) throw new Error("macOS Full access Sandbox Runner is missing.");

const runner = new NativeProcessRunner(runnerPath);
const originalProbe = process.env[probeVariable];
try {
  const outsideWrite = await runFullAccess(runner, [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], 'full-access-outside-write'); process.stdout.write('outside-write-ok');",
    outsideMarker,
  ]);
  assert.equal(outsideWrite.code, 0);
  assert.equal(outsideWrite.stdout, "outside-write-ok");
  assert.equal(await readFile(outsideMarker, "utf8"), "full-access-outside-write");
  matrix.outsideFilesystem = true;

  const server = createServer((socket) => socket.end("full-access-loopback-ok"));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Full access loopback fixture is unavailable.");
    const network = await runFullAccess(runner, [
      "-e",
      "const net=require('node:net'); const socket=net.createConnection({host:'127.0.0.1',port:Number(process.argv[1])}); socket.setEncoding('utf8'); socket.once('data',(body)=>{process.stdout.write(body);socket.end();}); socket.once('error',()=>process.exit(1));",
      String(address.port),
    ]);
    assert.equal(network.code, 0);
    assert.equal(network.stdout, "full-access-loopback-ok");
    matrix.loopbackNetwork = true;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }

  process.env[probeVariable] = activeSecret;
  const credentialProbe = await runFullAccess(runner, [
    "-e",
    `process.stdout.write(process.env.${probeVariable} ?? 'absent')`,
  ]);
  assert.equal(credentialProbe.code, 0);
  assert.equal(credentialProbe.stdout, "absent");
  matrix.credentialProbeAbsent = true;
  if (originalProbe === undefined) delete process.env[probeVariable];
  else process.env[probeVariable] = originalProbe;

  const cancelledChild = `const fs=require('node:fs'); setTimeout(()=>fs.writeFileSync(process.argv[1],'cancelled-descendant-survived'),1200); setTimeout(()=>{},5000);`;
  const cancelledParent = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(cancelledChild)},process.argv[1]],{detached:true,stdio:'ignore'}); child.unref(); setTimeout(()=>{},5000);`;
  const controller = new globalThis.AbortController();
  const pendingCancellation = runFullAccess(runner, ["-e", cancelledParent, cancelledMarker], {
    signal: controller.signal,
  });
  await delay(150);
  controller.abort();
  const cancelled = await pendingCancellation;
  assert.equal(cancelled.cancelled, true);
  await delay(1400);
  assert.equal(
    existsSync(cancelledMarker),
    false,
    "Full access left a detached descendant after cancellation.",
  );
  matrix.cancelledDescendantAbsent = true;

  const parentLossChild = `const fs=require('node:fs'); setTimeout(()=>fs.writeFileSync(process.argv[1],'parent-loss-descendant-survived'),1200); setTimeout(()=>{},5000);`;
  const launcherSource = `import { NativeProcessRunner } from '@candy/platform'; const runner=new NativeProcessRunner(${JSON.stringify(runnerPath)}); await runner.run({executable:process.execPath,args:['-e',${JSON.stringify(parentLossChild)},${JSON.stringify(parentLossMarker)}],cwd:${JSON.stringify(workspace)},workspace:${JSON.stringify(workspace)},network:true,fullAccess:true,allowProcessExec:true});`;
  const launcher = spawn(process.execPath, ["--input-type=module", "-e", launcherSource], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  await delay(150);
  const launcherClosed = waitForClose(launcher);
  assert.equal(launcher.kill("SIGKILL"), true);
  await launcherClosed;
  await delay(1400);
  assert.equal(
    existsSync(parentLossMarker),
    false,
    "Full access left a process after parent loss.",
  );
  matrix.parentLossDescendantAbsent = true;

  console.log(`macOS Full access smoke passed: ${JSON.stringify(matrix)}`);
  console.log(
    "The disposable Keychain canary is intentionally excluded: it requires a separately confirmed, reversible local credential-store operation.",
  );
} finally {
  if (originalProbe === undefined) delete process.env[probeVariable];
  else process.env[probeVariable] = originalProbe;
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
