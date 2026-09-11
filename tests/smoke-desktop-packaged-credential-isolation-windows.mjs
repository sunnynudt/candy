import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log("Packaged Windows credential isolation smoke skipped: not Windows x64");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "out", "windows", "Candy", "Candy.exe");
if (!existsSync(executable)) throw new Error("Packaged Windows Candy executable is missing.");

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-credential-isolation-windows-"));
const home = path.join(fixtureRoot, "home");
const temporary = path.join(fixtureRoot, "tmp");
const appData = path.join(fixtureRoot, "appdata");
const localAppData = path.join(fixtureRoot, "localappdata");
await mkdir(home, { recursive: true });
await mkdir(temporary, { recursive: true });
await mkdir(appData, { recursive: true });
await mkdir(localAppData, { recursive: true });
const fixtureValue = "candy-packaged-credential-isolation-fixture";

const environment = cleanChildEnvironment(process.env);
environment.HOME = home;
environment.USERPROFILE = home;
environment.TEMP = temporary;
environment.TMP = temporary;
environment.APPDATA = appData;
environment.LOCALAPPDATA = localAppData;
environment.CANDY_APP_DATA_ROOT = localAppData;
environment.CANDY_DESKTOP_RUN = "1";
environment.CANDY_DESKTOP_CREDENTIAL_SMOKE = "1";
environment.CANDY_CREDENTIAL_FIXTURE_VALUE = fixtureValue;

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

const timeout = globalThis.setTimeout(() => {
  child.kill();
}, 30_000);
try {
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(
    exit.code,
    0,
    `Packaged Windows credential isolation smoke exited ${exit.code ?? "null"}/${exit.signal ?? "none"}: ${output}`,
  );
  assert.match(
    output,
    /Desktop credential smoke passed: renderer set\/presence\/delete only; complete value never observable/u,
    output,
  );
  assert.ok(
    !output.includes(fixtureValue),
    "Packaged process output contained the credential fixture value.",
  );
  console.log(
    "Packaged Windows credential isolation smoke passed: renderer cannot observe complete credential values",
  );
} finally {
  globalThis.clearTimeout(timeout);
  if (child.exitCode === null) child.kill();
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
