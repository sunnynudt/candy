import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
const candidates = [
  path.join(home, ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo"),
  "cargo",
];
const cargo = candidates.find((candidate) => candidate === "cargo" || existsSync(candidate));
if (!cargo) throw new Error("Cargo is required for the native protocol check.");
const result = spawnSync(
  cargo,
  ["check", "--manifest-path", "native/sandbox-runner/Cargo.toml", "--locked"],
  {
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
