import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log("Packaged macOS Browser smoke skipped: not macOS arm64");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "out", "macos", "Candy.app", "Contents", "MacOS", "Candy");
if (!existsSync(executable)) throw new Error("Packaged macOS Desktop executable is missing.");

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-browser-macos-"));
const temporary = path.join(fixtureRoot, "tmp");
await mkdir(temporary);
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
    '<!doctype html><title>Candy browser fixture</title><main>Candy browser fixture</main><button id="fixture-click" type="button">Click fixture</button><form id="fixture-form"><input id="fixture-input"><button type="submit">Submit fixture</button></form><p id="fixture-status"></p><script>const input=document.querySelector("#fixture-input"),status=document.querySelector("#fixture-status");document.querySelector("#fixture-click").addEventListener("click",()=>status.textContent="clicked");input.addEventListener("input",()=>status.textContent=input.value);document.querySelector("#fixture-form").addEventListener("submit",event=>{event.preventDefault();status.textContent=input.value+" submitted";});</script>',
  );
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser fixture server failed.");

  const environment = cleanChildEnvironment(process.env);
  environment.HOME = fixtureRoot;
  environment.TMPDIR = temporary;
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
    child.kill("SIGTERM");
  }, 20_000);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  globalThis.clearTimeout(timeout);

  if (timedOut || exit.code !== 0 || !stdout.includes("packaged macOS Browser Workspace smoke ok"))
    throw new Error(
      `macOS Browser smoke exited with code ${exit.code ?? "null"} (${exit.signal ?? "no signal"}): ${stdout}\n${stderr}`,
    );
  console.log("packaged macOS Browser Workspace smoke passed: protected local fixture");
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
