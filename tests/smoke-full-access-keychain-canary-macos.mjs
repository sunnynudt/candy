import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeProcessRunner } from "@candy/platform";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("macOS Full access Keychain canary skipped: requires macOS arm64");
  process.exit(0);
}

const securityExecutable = "/usr/bin/security";
const runnerPath = path.resolve(
  "native",
  "sandbox-runner",
  "target",
  "debug",
  "candy-sandbox-runner",
);
if (!existsSync(securityExecutable)) throw new Error("macOS security CLI is unavailable.");
if (!existsSync(runnerPath)) throw new Error("macOS Full access Sandbox Runner is missing.");

const root = await mkdtemp(path.join(os.tmpdir(), "candy-full-access-keychain-canary-"));
const workspace = path.join(root, "workspace");
const keychainPath = path.join(root, "canary.keychain-db");
const entropy = randomBytes(32).toString("base64url");
const account = `candy-full-access-${entropy.slice(0, 16)}`;
const service = `candy-full-access-${entropy.slice(16, 32)}`;
const keychainPassword = randomBytes(32).toString("base64url");
const canaryValue = randomBytes(32).toString("base64url");
let keychainCreated = false;

function runSecurity(args, phase) {
  try {
    execFileSync(securityExecutable, args, { stdio: "ignore" });
  } catch {
    throw new Error(`Keychain canary ${phase} failed.`);
  }
}

function deleteCanaryKeychain() {
  runSecurity(["delete-keychain", keychainPath], "cleanup");
  if (existsSync(keychainPath)) throw new Error("Keychain canary cleanup did not remove its file.");
  keychainCreated = false;
}

let primaryError;
try {
  await mkdir(workspace, { recursive: true });
  runSecurity(["create-keychain", "-p", keychainPassword, keychainPath], "creation");
  keychainCreated = true;
  runSecurity(["unlock-keychain", "-p", keychainPassword, keychainPath], "unlock");
  runSecurity(
    ["add-generic-password", "-a", account, "-s", service, "-w", canaryValue, keychainPath],
    "canary write",
  );
  // No `-w` and no captured output: this proves host-side availability while
  // ensuring that neither the canary value nor Keychain metadata enters evidence.
  runSecurity(["find-generic-password", "-a", account, "-s", service, keychainPath], "readback");

  const result = await new NativeProcessRunner(runnerPath).run({
    executable: securityExecutable,
    args: ["find-generic-password", "-a", account, "-s", service, keychainPath],
    cwd: workspace,
    workspace,
    network: true,
    fullAccess: true,
  });
  assert.notEqual(result.code, 0, "Full access must not reach a Keychain canary.");
  assert.equal(result.stdout.includes(canaryValue), false, "Canary value entered task stdout.");
  assert.equal(result.stderr.includes(canaryValue), false, "Canary value entered task stderr.");

  deleteCanaryKeychain();
} catch (error) {
  primaryError = error;
}
let cleanupError;
if (keychainCreated) {
  try {
    deleteCanaryKeychain();
  } catch {
    cleanupError = new Error(
      "Keychain canary cleanup failed; its temporary Keychain was retained.",
    );
  }
}
if (cleanupError === undefined) {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    cleanupError = new Error("Keychain canary temporary-directory cleanup failed.");
  }
}
if (cleanupError !== undefined) throw cleanupError;
if (primaryError !== undefined) throw primaryError;
console.log(
  "macOS Full access Keychain canary passed: host readback succeeded, task read was denied, and the temporary Keychain was deleted.",
);
