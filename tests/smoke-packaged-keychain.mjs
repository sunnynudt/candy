import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resources = path.join(root, "out", "macos", "Candy.app", "Contents", "Resources");
const nodeExecutable = path.join(resources, "node", "bin", "node");
const appRoot = path.join(resources, "app");
if (!existsSync(nodeExecutable) || !existsSync(appRoot))
  throw new Error("Packaged Node runtime or app root is missing.");

const probe = String.raw`import { KeyringCredentialStore } from "@candy/platform";
const store = new KeyringCredentialStore();
for (const name of ["deepseek", "minimax-cn"]) {
  const before = store.has(name);
  if (before === "absent") {
    store.set(name, "candy-packaged-keychain-fixture");
    const afterSet = store.has(name);
    store.delete(name);
    const afterDelete = store.has(name);
    console.log(name + ": before=" + before + " afterSet=" + afterSet + " afterDelete=" + afterDelete);
  } else {
    console.log(name + ": before=" + before + " untouched=true");
  }
}`;
const child = spawn(nodeExecutable, ["--input-type=module", "-e", probe], {
  cwd: appRoot,
  env: cleanChildEnvironment(process.env),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
const probePassed = ["deepseek", "minimax-cn"].every(
  (name) =>
    stdout.includes(`${name}: before=present untouched=true`) ||
    stdout.includes(`${name}: before=absent afterSet=present afterDelete=absent`),
);
if (exit.code !== 0 || !probePassed) {
  const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  throw new Error(
    `Packaged Keychain smoke failed (${exit.code ?? "null"}/${exit.signal ?? "no signal"}): ${details}`,
  );
}
console.log("packaged macOS Keychain smoke ok");
