import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "out", "windows", "Candy", "Candy.exe");
const sandboxRunner = path.join(
  root,
  "out",
  "windows",
  "Candy",
  "resources",
  "native",
  "candy-sandbox-runner.exe",
);
if (!existsSync(executable)) throw new Error("Packaged Windows Candy executable is missing.");
if (!existsSync(sandboxRunner)) throw new Error("Packaged Windows Sandbox Runner is missing.");

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

let timedOut = false;
const timeout = globalThis.setTimeout(() => {
  timedOut = true;
  child.kill();
}, 20_000);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
globalThis.clearTimeout(timeout);

if (timedOut || exit.code !== 0) {
  throw new Error(
    `Packaged Windows Desktop smoke exited with code ${exit.code ?? "null"} (${exit.signal ?? "no signal"}): ${stderr}`,
  );
}
console.log("packaged unsigned Windows Desktop app-server JSONL smoke ok");
