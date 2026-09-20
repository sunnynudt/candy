import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

if (process.platform !== "win32" || process.arch !== "x64") {
  console.log("Packaged Windows coding-journey smoke skipped: not Windows x64");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "out", "windows", "Candy");
const executable = path.join(bundle, "Candy.exe");
const packagedNode = path.join(bundle, "resources", "node", "node.exe");
if (!existsSync(executable) || !existsSync(packagedNode))
  throw new Error("Packaged Windows coding-journey runtime is incomplete.");

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-coding-journey-windows-"));
const home = path.join(fixtureRoot, "home");
const temporary = path.join(fixtureRoot, "tmp");
const appData = path.join(fixtureRoot, "appdata");
const localAppData = path.join(fixtureRoot, "localappdata");
const workspace = path.join(fixtureRoot, "workspace");
await mkdir(home, { recursive: true });
await mkdir(temporary, { recursive: true });
await mkdir(appData, { recursive: true });
await mkdir(localAppData, { recursive: true });
await mkdir(workspace);

const git = (args, cwd = workspace) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
git(["init", "-q"]);
await writeFile(path.join(workspace, "README.md"), "base fixture\n", "utf8");
git(["add", "README.md"]);
git([
  "-c",
  "user.name=Candy Fixture",
  "-c",
  "user.email=candy-fixture@example.invalid",
  "commit",
  "-qm",
  "base",
]);
const base = git(["rev-parse", "HEAD"]).trim();

const environment = cleanChildEnvironment(process.env);
environment.HOME = home;
environment.USERPROFILE = home;
environment.TEMP = temporary;
environment.TMP = temporary;
environment.APPDATA = appData;
environment.LOCALAPPDATA = localAppData;
environment.CANDY_APP_DATA_ROOT = localAppData;
environment.CANDY_DESKTOP_RUN = "1";
environment.CANDY_DESKTOP_CODING_JOURNEY_SMOKE = "1";
environment.CANDY_CODING_JOURNEY_WORKSPACE = workspace;
environment.CANDY_CODING_JOURNEY_VALIDATOR_EXECUTABLE = packagedNode;
environment.CANDY_SANDBOX_RUNNER = path.join(
  bundle,
  "resources",
  "native",
  "candy-sandbox-runner.exe",
);

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
const timeout = globalThis.setTimeout(() => child.kill(), 90_000);
try {
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(
    exit.code,
    0,
    `Packaged Windows coding-journey smoke exited ${exit.code ?? "null"}/${exit.signal ?? "none"}: ${output}`,
  );
  const resultLine = output
    .split(/\r?\n/u)
    .find((line) => line.startsWith("CANDY_CODING_JOURNEY_RESULT "));
  assert.ok(resultLine, `Coding-journey result was not emitted: ${output}`);
  const result = JSON.parse(resultLine.slice("CANDY_CODING_JOURNEY_RESULT ".length));
  assert.equal(result.state, "completed");
  assert.equal(result.reopened, true);
  assert.equal(result.applied, true);
  assert.ok(
    result.changedFiles >= 2,
    "Coding-journey did not project tracked and untracked files.",
  );
  assert.ok(result.transcriptEntries >= 3, "Coding-journey transcript was not preserved.");

  const readme = await readFile(path.join(workspace, "README.md"), "utf8");
  assert.ok(readme.includes("changed by task"), "Local README was not updated by Apply.");
  const untracked = await readFile(path.join(workspace, "new.txt"), "utf8");
  assert.ok(untracked.includes("untracked by task"), "Local untracked file was not transferred.");
  const status = git(["status", "--porcelain"]);
  assert.match(status, / M README\.md/u, "README change must remain uncommitted.");
  assert.match(status, /^\?\? new\.txt$/mu, "new.txt must remain untracked/uncommitted.");
  const head = git(["rev-parse", "HEAD"]).trim();
  assert.equal(head, base, "Apply must not create a commit.");
  console.log(
    "Packaged Windows coding-journey smoke passed: create, stream, edit, validator, diff review, Apply, reopen transcript",
  );
} finally {
  globalThis.clearTimeout(timeout);
  if (child.exitCode === null) child.kill();
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
