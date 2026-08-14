import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanChildEnvironment,
  resolveAppPaths,
  resolveCredential,
  SQLiteTaskStore,
} from "@candy/platform";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Trusted Shell TUI journey requires macOS arm64.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const attempt = readArgument("--attempt") ?? "1";
if (!/^[1-3]$/u.test(attempt)) throw new Error("Trusted Shell journey attempt must be 1, 2, or 3.");
const journeyRoot = await mkdtemp(path.join(os.tmpdir(), "candy-trusted-shell-pty-"));
const workspace = path.join(journeyRoot, "fixture workspace");
const appDataRoot = path.join(journeyRoot, "app-data");
const temporaryRoot = path.join(journeyRoot, "tmp");
const outsideSentinel = path.join(journeyRoot, "outside-sentinel.txt");
const ptyLog = path.join(journeyRoot, "pty.log");
const resultPath = path.join(journeyRoot, "result.txt");
const childPath = path.join(root, "scripts", "trusted-shell-journey-child.mjs");
const nativeRunnerPath = path.join(
  root,
  "native",
  "sandbox-runner",
  "target",
  "debug",
  "candy-sandbox-runner",
);
const environment = {
  ...cleanChildEnvironment(process.env),
  CANDY_APP_DATA_ROOT: appDataRoot,
  CANDY_JOURNEY_CHILD: childPath,
  CANDY_JOURNEY_LAUNCH_DIR: journeyRoot,
  CANDY_JOURNEY_NODE: process.execPath,
  CANDY_JOURNEY_PTY_LOG: ptyLog,
  CANDY_JOURNEY_RESULT: resultPath,
  CANDY_JOURNEY_WORKSPACE: workspace,
  CANDY_SANDBOX_RUNNER: nativeRunnerPath,
  // Keep the real HOME only for the Candy-owned macOS Keychain adapter. The
  // child never writes there; app-data, sessions, attachments, worktrees,
  // stdout/stderr, and temporary files stay under journeyRoot.
  HOME: process.env.HOME ?? os.homedir(),
  TMPDIR: temporaryRoot,
  TERM: "xterm-256color",
};

await mkdir(path.join(workspace, "src"), { recursive: true });
await mkdir(path.join(workspace, "test"), { recursive: true });
await mkdir(temporaryRoot, { recursive: true });
await writeFile(path.join(workspace, "README.md"), "A tiny failing Candy fixture.\n", "utf8");
await writeFile(path.join(workspace, "src", "value.mjs"), "export const value = 1;\n", "utf8");
await writeFile(
  path.join(workspace, "test", "value.test.mjs"),
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n\ntest('value is repaired', () => assert.equal(value, 2));\n",
  "utf8",
);
await writeFile(outsideSentinel, "outside fixture remains unchanged\n", "utf8");
execFileSync("git", ["init", "-q", workspace], { env: environment });
execFileSync("git", ["-C", workspace, "config", "user.email", "candy-issue-3@example.invalid"], {
  env: environment,
});
execFileSync("git", ["-C", workspace, "config", "user.name", "Candy Issue 3 Fixture"], {
  env: environment,
});
execFileSync("git", ["-C", workspace, "add", "README.md", "src", "test"], { env: environment });
execFileSync("git", ["-C", workspace, "commit", "-qm", "failing fixture baseline"], {
  env: environment,
});

const beforeHead = gitCapture(["-C", workspace, "rev-parse", "HEAD"]);
const beforeTree = gitCapture(["-C", workspace, "write-tree"]);
const outsideDigest = digest(await readFile(outsideSentinel));
const lockfileDigest = createHash("sha256")
  .update(await readFile(path.join(root, "package-lock.json")))
  .digest("hex");

try {
  await runExpect();
  const result = parseResult(await readFile(resultPath, "utf8"));
  if (!/^task-[a-z0-9]+$/u.test(result.coding_task_id ?? ""))
    throw new Error("Coding task id is invalid.");
  if (!/^task-[a-z0-9]+$/u.test(result.cancel_task_id ?? ""))
    throw new Error("Cancellation task id is invalid.");
  if (!/^network-[a-z0-9]+$/u.test(result.network_approval_id ?? ""))
    throw new Error("Network approval id is invalid.");

  const value = await readFile(path.join(workspace, "src", "value.mjs"), "utf8");
  if (value !== "export const value = 2;\n") throw new Error("Real Pi edit was not applied.");
  const afterHead = gitCapture(["-C", workspace, "rev-parse", "HEAD"]);
  const afterTree = gitCapture(["-C", workspace, "write-tree"]);
  if (afterHead !== beforeHead) throw new Error("The real journey created a commit.");
  if (afterTree !== beforeTree) throw new Error("The real journey changed the Git index.");
  if (gitCapture(["-C", workspace, "diff", "--cached"]) !== "")
    throw new Error("The real journey staged changes.");
  if (digest(await readFile(outsideSentinel)) !== outsideDigest)
    throw new Error("The real journey changed an external sentinel.");

  const store = new SQLiteTaskStore(path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"));
  const coding = store.get(result.coding_task_id);
  const cancelled = store.get(result.cancel_task_id);
  const transcript = store.transcript(result.coding_task_id);
  if (coding?.state !== "completed" || coding.trustedShell !== true)
    throw new Error("The completed task did not persist Trusted Shell state.");
  if (cancelled?.state !== "cancelled" || cancelled.trustedShell !== true)
    throw new Error("The cancelled task did not recover safely.");
  if (coding.ownerId !== undefined || cancelled.ownerId !== undefined)
    throw new Error("Restarted task state retained an execution owner.");
  const toolTexts =
    transcript?.filter((entry) => entry.role === "tool").map((entry) => entry.text) ?? [];
  const offlineBashRuns = toolTexts.filter((text) => text.includes("candy_bash:ok")).length;
  if (offlineBashRuns < 2)
    throw new Error(
      "The real coding journey did not run offline Bash for diagnosis and verification.",
    );
  if (!toolTexts.some((text) => text.includes("candy_search:ok")))
    throw new Error("The real coding journey did not use the Candy search tool.");
  const networkRuns = toolTexts.filter((text) => text.includes("candy_bash_network:")).length;
  if (networkRuns !== 1 || !toolTexts.some((text) => text.includes("candy_bash_network:ok")))
    throw new Error("Network Bash was not exactly one approved command.");
  store.close();

  const ptyOutput = await readFile(ptyLog);
  const journeyFiles = await collectFiles(journeyRoot);
  const activeSecret = resolveCredential("deepseek");
  if (activeSecret === undefined)
    throw new Error("Candy DeepSeek credential was unavailable after the live run.");
  try {
    assertNoSensitiveData(
      Buffer.concat([ptyOutput, ...(await readAll(journeyFiles))]),
      activeSecret.value,
    );
  } finally {
    activeSecret.release();
  }
  const evidence = {
    attempt,
    sourceRevision: gitCapture(["rev-parse", "HEAD"]),
    lockfileSha256: lockfileDigest,
    macos: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    architecture: process.arch,
    node: process.version,
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
    codingTask: result.coding_task_id,
    cancelledTask: result.cancel_task_id,
    networkApproval: result.network_approval_id,
    realProvider: true,
    realPiAgentLoop: true,
    trustedShellAuto: true,
    trustedShellGate: "macos-arm64-g2-approved-normal-composition-root",
    offlineShellAuto: true,
    oneCommandNetworkApproval: networkRuns === 1,
    cancellationAndRestart: coding.ownerId === undefined && cancelled.ownerId === undefined,
    gitHeadUnchanged: afterHead === beforeHead,
    gitIndexUnchanged: afterTree === beforeTree,
    credentialFreeEvidence: true,
  };
  await writeTrustedShellEvidence(evidence);
  console.log(JSON.stringify(evidence));
} finally {
  await rm(journeyRoot, { recursive: true, force: true });
}

async function runExpect() {
  return await new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/expect",
      ["-f", path.join(root, "scripts", "smoke-tui-trusted-shell-macos.exp")],
      { cwd: root, env: environment, maxBuffer: 128 * 1024 },
    );
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      else
        reject(
          new Error(
            `expect exited ${code ?? "null"}/${signal ?? "none"}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
    });
  });
}

function gitCapture(args) {
  return execFileSync("git", args, { cwd: root, env: environment, encoding: "utf8" }).trim();
}

function parseResult(value) {
  return Object.fromEntries(
    value
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error("Journey result is malformed.");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function readAll(files) {
  return await Promise.all(files.map((filePath) => readFile(filePath)));
}

function assertNoSensitiveData(value, activeSecret) {
  const credentialPattern =
    /Bearer\s+[A-Za-z0-9._~+/=-]{16,}|\b(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,}\b/iu;
  const text = value.toString("utf8");
  if (credentialPattern.test(text) || (activeSecret.length > 0 && text.includes(activeSecret)))
    throw new Error("Credential-shaped content entered Trusted Shell journey evidence.");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function writeTrustedShellEvidence(evidence) {
  const evidenceRoot = path.join(root, "out", "acceptance", "macos");
  await mkdir(evidenceRoot, { recursive: true });
  const report = [
    "# macOS Trusted Shell Auto real TUI journey",
    "",
    `- Status: Pass`,
    `- Attempt: ${evidence.attempt}`,
    `- Source revision: \`${evidence.sourceRevision}\``,
    `- Lockfile SHA-256: \`${evidence.lockfileSha256}\``,
    `- macOS: \`${evidence.macos}\` (${evidence.architecture})`,
    `- Node: \`${evidence.node}\``,
    `- npm: \`${evidence.npm}\``,
    "- Provider: DeepSeek Flash through the production Candy Pi Agent Engine",
    "- Capability gate: macOS arm64 G2-approved normal TUI composition root",
    "- Evidence: offline Shell auto, one-command network approval, validator, Apply, cancellation, restart task recovery, unchanged Git HEAD/index, and sanitized credential scan",
    "- Credential values, paths outside the temporary fixture, prompts, raw provider payloads, and terminal logs are not retained in this report.",
    "",
  ].join("\n");
  await writeFile(
    path.join(evidenceRoot, `trusted-shell-auto-attempt-${evidence.attempt}-latest.md`),
    report,
    "utf8",
  );
}
