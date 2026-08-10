import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "out", "windows", "Candy", "Candy.exe");
const server = createServer((request, response) => {
  if (request.url === "/redirect") {
    response.writeHead(302, { Location: "http://localhost:9/blocked" });
    response.end();
    return;
  }
  if (request.url === "/download") {
    response.writeHead(200, {
      "Content-Disposition": "attachment; filename=fixture.txt",
      "Content-Type": "text/plain",
    });
    response.end("browser download fixture");
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><title>Candy browser fixture</title><main>Candy browser fixture</main>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Browser fixture server failed.");

const environment = cleanChildEnvironment(process.env);
environment.CANDY_BROWSER_SMOKE = "1";
environment.CANDY_BROWSER_FIXTURE_URL = `http://localhost:${address.port}/`;
const child = spawn(executable, [], {
  cwd: root,
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
}, 20_000);
const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
globalThis.clearTimeout(timeout);
server.close();

if (timedOut || exit.code !== 0 || !stdout.includes("packaged Windows Browser Workspace smoke ok"))
  throw new Error(
    `Windows Browser smoke exited with code ${exit.code ?? "null"} (${exit.signal ?? "no signal"}): ${stdout}\n${stderr}`,
  );
console.log("packaged Windows Browser Workspace smoke passed: protected local fixture");
