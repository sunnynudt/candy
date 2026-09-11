import { execFileSync } from "node:child_process";

const expectedNode = "v22.23.2";
const expectedNpm = "10.9.8";

function npmVersion() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("Run this check through npm so the selected npm executable is unambiguous.");
  }

  return execFileSync(process.execPath, [npmCli, "--version"], {
    encoding: "utf8",
  }).trim();
}

const actualNpm = npmVersion();
const failures = [];

if (process.version !== expectedNode) {
  failures.push(`Node must be ${expectedNode}; received ${process.version}.`);
}

if (actualNpm !== expectedNpm) {
  failures.push(`npm must be ${expectedNpm}; received ${actualNpm}.`);
}

if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}

console.log(`toolchain ok: Node ${process.version}, npm ${actualNpm}`);
