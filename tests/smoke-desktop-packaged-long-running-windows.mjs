import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log("Packaged Windows long-running smoke skipped: not Windows x64");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "out", "windows", "Candy");
const executable = path.join(bundle, "Candy.exe");
const packagedNode = path.join(bundle, "resources", "node", "node.exe");
const sandboxRunner = path.join(bundle, "resources", "native", "candy-sandbox-runner.exe");
if (!existsSync(executable) || !existsSync(packagedNode) || !existsSync(sandboxRunner))
  throw new Error("Packaged Windows long-running runtime is incomplete.");

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-packaged-long-running-windows-"));
const home = path.join(fixtureRoot, "home");
const temporary = path.join(fixtureRoot, "tmp");
const appData = path.join(fixtureRoot, "appdata");
const localAppData = path.join(fixtureRoot, "localappdata");
const workspace = path.join(fixtureRoot, "workspace");
const marker = path.join(fixtureRoot, "validator-calls.txt");
await mkdir(home, { recursive: true });
await mkdir(temporary, { recursive: true });
await mkdir(appData, { recursive: true });
await mkdir(localAppData, { recursive: true });
await mkdir(workspace);

const validatorScript = [
  "const fs = require('node:fs');",
  "const marker = process.argv[1];",
  "const count = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split(/\\r?\\n/).filter(Boolean).length : 0;",
  "fs.appendFileSync(marker, String(count + 1) + '\\n');",
  "process.stdout.write(count === 0 ? 'validator-fail' : 'validator-pass');",
  "process.exit(count === 0 ? 1 : 0);",
].join(" ");
const environment = cleanChildEnvironment(process.env);
environment.HOME = home;
environment.USERPROFILE = home;
environment.TEMP = temporary;
environment.TMP = temporary;
environment.APPDATA = appData;
environment.LOCALAPPDATA = localAppData;
environment.CANDY_APP_DATA_ROOT = localAppData;
environment.CANDY_DESKTOP_RUN = "1";
environment.CANDY_DESKTOP_LONG_RUNNING_SMOKE = "1";
environment.CANDY_LONG_RUNNING_WORKSPACE = workspace;
environment.CANDY_LONG_RUNNING_VALIDATOR_EXECUTABLE = packagedNode;
environment.CANDY_LONG_RUNNING_VALIDATOR_ARGS = JSON.stringify(["-e", validatorScript, marker]);
environment.CANDY_SANDBOX_RUNNER = sandboxRunner;

let output = "";
const child = spawn(executable, [], {
  cwd: root,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});
const timeout = globalThis.setTimeout(() => child.kill(), 30_000);
try {
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(
    exit.code,
    0,
    `Packaged Windows long-running smoke exited ${exit.code ?? "null"}/${exit.signal ?? "none"}: ${output}`,
  );
  const resultLine = output
    .split(/\r?\n/u)
    .find((line) => line.startsWith("CANDY_LONG_RUNNING_RESULT "));
  assert.ok(resultLine, `Packaged Windows long-running result was not emitted: ${output}`);
  const result = JSON.parse(resultLine.slice("CANDY_LONG_RUNNING_RESULT ".length));
  assert.equal(result.state, "completed");
  assert.equal(result.steeringProjected, true);
  assert.match(result.rendererEvidence, /validator-pass/u);
  assert.equal(result.evidenceSummary.includes("validator-pass"), true);
  assert.equal((await readFile(marker, "utf8")).trim(), "1\n2".trim());
  console.log(
    "Packaged Windows long-running smoke passed: approval wait, steering, validator-only completion, and final Desktop evidence projection",
  );
} finally {
  globalThis.clearTimeout(timeout);
  if (child.exitCode === null) child.kill();
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
