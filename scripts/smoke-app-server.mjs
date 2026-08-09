import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(root, "apps", "app-server", "dist", "main.js")], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stdin.end(
  '{"v":1,"kind":"command","commandId":"smoke-1","taskId":"task-1","expectedRevision":0,"command":{"type":"snapshot"}}\n',
);
await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`app-server exited ${code}`)),
  );
});
if (!output.includes('"kind":"event"') || !output.includes('"task-1"')) {
  throw new Error(`Unexpected app-server response: ${output}`);
}
console.log("app-server JSONL smoke ok");
