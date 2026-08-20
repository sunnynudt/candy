import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  throw new Error("Trusted Shell dogfood requires macOS arm64.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const journeyRoot = await mkdtemp(path.join(os.tmpdir(), "candy-trusted-shell-dogfood-"));
const workspace = path.join(journeyRoot, "fixture workspace");
const appDataRoot = path.join(journeyRoot, "app-data");
const temporaryRoot = path.join(journeyRoot, "tmp");
const outsideSentinel = path.join(journeyRoot, "outside-sentinel.txt");
const ptyLog = path.join(journeyRoot, "pty.log");
const resultPath = path.join(journeyRoot, "result.txt");
const childPath = path.join(root, "tests", "trusted-shell-journey-child.mjs");
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
  CANDY_DOGFOOD_CHILD: childPath,
  CANDY_DOGFOOD_LAUNCH_DIR: journeyRoot,
  CANDY_DOGFOOD_NODE: process.execPath,
  CANDY_DOGFOOD_PTY_LOG: ptyLog,
  CANDY_DOGFOOD_RESULT: resultPath,
  CANDY_DOGFOOD_WORKSPACE: workspace,
  CANDY_JOURNEY_WORKSPACE: workspace,
  CANDY_SANDBOX_RUNNER: nativeRunnerPath,
  // Keep the real HOME only for the Candy-owned macOS Keychain adapter. The
  // child writes sessions and task state only below appDataRoot.
  HOME: process.env.HOME ?? os.homedir(),
  TMPDIR: temporaryRoot,
  TERM: "xterm-256color",
};

await mkdir(path.join(workspace, "src"), { recursive: true });
await mkdir(path.join(workspace, "test"), { recursive: true });
await mkdir(temporaryRoot, { recursive: true });
await writeFile(
  path.join(workspace, "README.md"),
  "This fixture has one small repair and one failing-test diagnosis. Keep changes narrow.\n",
  "utf8",
);
await writeFile(path.join(workspace, "src", "value.mjs"), "export const value = 1;\n", "utf8");
await writeFile(
  path.join(workspace, "test", "value.test.mjs"),
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n\ntest('value is repaired', () => assert.equal(value, 2));\n",
  "utf8",
);
await writeFile(
  path.join(workspace, "src", "diagnosis.mjs"),
  "export function readiness() { return 'broken'; }\n",
  "utf8",
);
await writeFile(
  path.join(workspace, "test", "diagnosis.test.mjs"),
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readiness } from '../src/diagnosis.mjs';\n\ntest('readiness reports ready', () => assert.equal(readiness(), 'ready'));\n",
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
execFileSync("git", ["-C", workspace, "commit", "-qm", "dogfood fixture baseline"], {
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
  for (const key of ["understanding_task_id", "repair_task_id", "diagnosis_task_id"]) {
    if (!/^task-[a-z0-9]+$/u.test(result[key] ?? ""))
      throw new Error(`Invalid dogfood task id: ${key}.`);
  }

  const localValue = await readFile(path.join(workspace, "src", "value.mjs"), "utf8");
  const localDiagnosis = await readFile(path.join(workspace, "src", "diagnosis.mjs"), "utf8");
  if (
    localValue !== "export const value = 1;\n" ||
    localDiagnosis !== "export function readiness() { return 'broken'; }\n"
  )
    throw new Error("Dogfood changed the Local Workspace instead of its Task Worktrees.");
  const afterHead = gitCapture(["-C", workspace, "rev-parse", "HEAD"]);
  const afterTree = gitCapture(["-C", workspace, "write-tree"]);
  if (afterHead !== beforeHead) throw new Error("Dogfood created a commit.");
  if (afterTree !== beforeTree) throw new Error("Dogfood changed the Git index.");
  if (gitCapture(["-C", workspace, "diff", "--cached"]) !== "")
    throw new Error("Dogfood staged changes.");
  if (digest(await readFile(outsideSentinel)) !== outsideDigest)
    throw new Error("Dogfood changed an external sentinel.");

  const appPaths = resolveAppPaths(appDataRoot);
  const store = new SQLiteTaskStore(path.join(appPaths.state, "tasks.sqlite"));
  const tasks = Object.fromEntries(
    ["understanding_task_id", "repair_task_id", "diagnosis_task_id"].map((key) => [
      key,
      store.get(result[key]),
    ]),
  );
  for (const [key, task] of Object.entries(tasks)) {
    if (task?.state !== "completed" || task.trustedShell !== true)
      throw new Error(`${key} did not persist completed Trusted Shell state.`);
    if (
      task.worktreePath === undefined ||
      !path.resolve(task.worktreePath).startsWith(path.resolve(appPaths.worktrees) + path.sep)
    )
      throw new Error(`${key} did not persist a Candy-owned Task Worktree.`);
  }
  const understandingFiles = await readTaskFiles(tasks.understanding_task_id);
  const repairFiles = await readTaskFiles(tasks.repair_task_id);
  const diagnosisFiles = await readTaskFiles(tasks.diagnosis_task_id);
  const categoryChecks = {
    repositoryUnderstanding:
      understandingFiles.value === "export const value = 1;\n" &&
      understandingFiles.diagnosis === "export function readiness() { return 'broken'; }\n",
    smallRepair:
      repairFiles.value === "export const value = 2;\n" &&
      repairFiles.diagnosis === "export function readiness() { return 'broken'; }\n",
    failingTestDiagnosis:
      diagnosisFiles.value === "export const value = 1;\n" &&
      diagnosisFiles.diagnosis === "export function readiness() { return 'ready'; }\n",
  };
  if (!Object.values(categoryChecks).every(Boolean))
    throw new Error("One or more dogfood category repairs escaped its isolated Task Worktree.");
  const diagnosisWorktree = tasks.diagnosis_task_id?.worktreePath;
  if (diagnosisWorktree === undefined)
    throw new Error("Failing-test diagnosis did not retain its isolated Task Worktree.");
  const diagnosis = await readFile(path.join(diagnosisWorktree, "src", "diagnosis.mjs"), "utf8");
  if (diagnosis !== "export function readiness() { return 'ready'; }\n")
    throw new Error("Failing-test diagnosis repair was not applied in its Task Worktree.");
  const transcriptChecks = {
    understanding: ["candy_read", "candy_bash"],
    repair: ["candy_read", "candy_edit", "candy_bash"],
    diagnosis: ["candy_read", "candy_edit", "candy_bash"],
  };
  const transcriptChecksPassed = {};
  for (const [label, markers] of Object.entries(transcriptChecks)) {
    const taskId = result[`${label}_task_id`];
    const transcript = store.transcript(taskId);
    transcriptChecksPassed[label] = markers.every(
      (marker) => transcript?.some((entry) => entry.text.includes(marker)) === true,
    );
    if (!transcriptChecksPassed[label]) throw new Error(`${label} transcript lacks tool evidence.`);
  }
  const dogfoodTaskTranscripts = Object.keys(transcriptChecks).map((label) =>
    store.transcript(result[`${label}_task_id`]),
  );
  const offlineShellOnly = dogfoodTaskTranscripts.every(
    (transcript) => !transcript?.some((entry) => entry.text.includes("candy_bash_network")),
  );
  if (!offlineShellOnly) throw new Error("Dogfood unexpectedly used a network shell tool.");
  const categoryScore = `${Object.values(categoryChecks).filter(Boolean).length}/3`;
  store.close();

  const ptyOutput = await readFile(ptyLog);
  const appDataFiles = await collectFiles(appDataRoot);
  const activeSecret = resolveCredential("deepseek");
  if (activeSecret === undefined)
    throw new Error("Candy DeepSeek credential was unavailable after dogfood.");
  try {
    assertNoSensitiveData(
      Buffer.concat([ptyOutput, ...(await readAll(appDataFiles))]),
      activeSecret.value,
    );
  } finally {
    activeSecret.release();
  }
  const evidence = {
    sourceRevision: gitCapture(["rev-parse", "HEAD"]),
    lockfileSha256: lockfileDigest,
    macos: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    architecture: process.arch,
    node: process.version,
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
    realProvider: true,
    realPiAgentLoop: true,
    trustedShellGate: "macos-arm64-g2-approved-normal-composition-root",
    dogfoodCategories: categoryChecks,
    categoryScore,
    safetyFailures: Object.values({
      ...categoryChecks,
      ...transcriptChecksPassed,
      localWorkspaceUnchanged:
        localValue === "export const value = 1;\n" &&
        localDiagnosis === "export function readiness() { return 'broken'; }\n",
      gitHeadUnchanged: afterHead === beforeHead,
      gitIndexUnchanged: afterTree === beforeTree,
    }).filter((passed) => !passed).length,
    offlineShellOnly,
    taskWorktreeIsolation: true,
    gitHeadUnchanged: afterHead === beforeHead,
    gitIndexUnchanged: afterTree === beforeTree,
    externalSentinelUnchanged: true,
    credentialFreeEvidence: true,
  };
  await writeDogfoodEvidence(evidence);
  console.log(JSON.stringify(evidence));
} finally {
  await rm(journeyRoot, { recursive: true, force: true });
}

async function runExpect() {
  return await new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/expect",
      ["-f", path.join(root, "tests", "smoke-tui-trusted-shell-dogfood-macos.exp")],
      { cwd: root, env: environment, maxBuffer: 128 * 1024 },
    );
    const stderr = [];
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
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
        if (separator < 1) throw new Error("Dogfood result is malformed.");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function readTaskFiles(task) {
  return {
    value: await readFile(path.join(task.worktreePath, "src", "value.mjs"), "utf8"),
    diagnosis: await readFile(path.join(task.worktreePath, "src", "diagnosis.mjs"), "utf8"),
  };
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
    throw new Error("Credential-shaped content entered dogfood evidence.");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeDogfoodEvidence(evidence) {
  const evidenceRoot = path.join(root, "out", "acceptance", "macos");
  await mkdir(evidenceRoot, { recursive: true });
  const report = [
    "# macOS Trusted Shell Auto dogfood categories",
    "",
    "- Status: Pass",
    `- Source revision: \`${evidence.sourceRevision}\``,
    `- Lockfile SHA-256: \`${evidence.lockfileSha256}\``,
    `- macOS: \`${evidence.macos}\` (${evidence.architecture})`,
    `- Node: \`${evidence.node}\``,
    `- npm: \`${evidence.npm}\``,
    "- Provider: DeepSeek Flash through the production Candy Pi Agent Engine",
    "- Capability gate: macOS arm64 G2-approved normal TUI composition root",
    "- Categories: repository understanding, small repair, and failing-test diagnosis in three isolated Candy Task Worktrees; result 3/3",
    "- Safety: zero failures; no Local Workspace mutation, commit, index mutation, external-sentinel mutation, or credential-shaped evidence",
    "- Credential values, prompts, raw provider payloads, and terminal logs are not retained in this report.",
    "",
  ].join("\n");
  await writeFile(path.join(evidenceRoot, "trusted-shell-auto-dogfood-latest.md"), report, "utf8");
}
