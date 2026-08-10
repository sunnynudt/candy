import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "out", "macos", "Candy.app", "Contents", "MacOS", "Candy");
if (!existsSync(executable)) throw new Error("Packaged Candy executable is missing.");

const environment = cleanChildEnvironment(process.env);
environment.CANDY_DESKTOP_SMOKE = "1";
const child = spawn(executable, [], {
  cwd: root,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timeout = globalThis.setTimeout(() => child.kill("SIGTERM"), 15_000);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
globalThis.clearTimeout(timeout);

if (exit.code !== 0)
  throw new Error(
    `Packaged Desktop smoke exited with code ${exit.code ?? "null"} (${exit.signal ?? "no signal"}): ${stderr}`,
  );
console.log("packaged macOS Desktop app-server JSONL smoke ok");
