import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "out", "windows", "Candy");
const nodeExecutable = path.join(packageRoot, "resources", "node", "node.exe");
const fixture = path.join(packageRoot, "resources", "app-server", "credential-smoke.mjs");
if (!existsSync(nodeExecutable))
  throw new Error("Packaged Node runtime is missing; run npm run package:desktop:windows first.");

await writeFile(
  fixture,
  `import { KeyringCredentialStore } from "@candy/platform";

const store = new KeyringCredentialStore();
const deepseekBefore = store.has("deepseek");
if (store.has("minimax-cn") !== "absent") throw new Error("MiniMax fixture account was not empty.");
store.set("minimax-cn", "candy-packaged-fixture-value");
if (store.has("minimax-cn") !== "present") throw new Error("MiniMax fixture set failed.");
store.replace("minimax-cn", "candy-packaged-fixture-replacement");
if (store.has("minimax-cn") !== "present") throw new Error("MiniMax fixture replace failed.");
store.delete("minimax-cn");
if (store.has("minimax-cn") !== "absent") throw new Error("MiniMax fixture delete failed.");
if (store.has("deepseek") !== deepseekBefore) throw new Error("DeepSeek presence changed.");
console.log("packaged Windows Credential Manager lifecycle smoke ok: deepseek presence unchanged; minimax absent-present-present-absent");
`,
  "utf8",
);

const environment = cleanChildEnvironment(process.env);
const child = spawn(nodeExecutable, [fixture], {
  cwd: path.join(packageRoot, "resources", "app-server"),
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

let timedOut = false;
const timeout = globalThis.setTimeout(() => {
  timedOut = true;
  child.kill();
}, 15_000);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
globalThis.clearTimeout(timeout);
await rm(fixture, { force: true });

if (
  timedOut ||
  exit.code !== 0 ||
  !stdout.includes("packaged Windows Credential Manager lifecycle smoke ok")
)
  throw new Error(
    `Packaged Windows Credential Manager smoke exited with code ${exit.code ?? "null"} (${exit.signal ?? "no signal"}): ${stdout}\n${stderr}`,
  );
console.log("packaged Windows Credential Manager smoke passed: bundled Node/keyring lifecycle");
