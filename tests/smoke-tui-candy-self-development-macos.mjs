import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
  throw new Error("Candy self-development dogfood requires macOS arm64.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const journeyRoot = await mkdtemp(path.join(os.tmpdir(), "candy-self-development-"));
const workspace = path.join(journeyRoot, "candy-source-worktree");
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
  CANDY_SELF_DEV_CHILD: childPath,
  CANDY_SELF_DEV_LAUNCH_DIR: journeyRoot,
  CANDY_SELF_DEV_NODE: process.execPath,
  CANDY_SELF_DEV_PTY_LOG: ptyLog,
  CANDY_SELF_DEV_RESULT: resultPath,
  CANDY_SELF_DEV_WORKSPACE: workspace,
  CANDY_JOURNEY_WORKSPACE: workspace,
  CANDY_SANDBOX_RUNNER: nativeRunnerPath,
  HOME: process.env.HOME ?? os.homedir(),
  TMPDIR: temporaryRoot,
  TERM: "xterm-256color",
};

await mkdir(temporaryRoot, { recursive: true });
await writeFile(outsideSentinel, "outside self-development fixture remains unchanged\n", "utf8");
execFileSync("git", ["worktree", "add", "--detach", workspace, "HEAD"], {
  cwd: root,
  env: environment,
  stdio: ["ignore", "ignore", "pipe"],
});

const beforeHead = gitCapture(["-C", workspace, "rev-parse", "HEAD"]);
const beforeTree = gitCapture(["-C", workspace, "write-tree"]);
const beforeStatus = gitCapture(["-C", workspace, "status", "--porcelain"]);
const outsideDigest = digest(await readFile(outsideSentinel));
const lockfileDigest = createHash("sha256")
  .update(await readFile(path.join(root, "package-lock.json")))
  .digest("hex");

try {
  await runExpect();
  const result = parseResult(await readFile(resultPath, "utf8"));
  if (!/^task-[a-z0-9]+$/u.test(result.task_id ?? ""))
    throw new Error("Self-development task id is invalid.");

  const store = new SQLiteTaskStore(path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"));
  const task = store.get(result.task_id);
  const transcript = store.transcript(result.task_id) ?? [];
  if (task?.state !== "completed" || task.trustedShell !== true)
    throw new Error("Self-development task did not complete through Trusted Shell.");
  if (task.worktreePath === undefined)
    throw new Error("Self-development task lacks a Task Worktree.");
  const taskWorktree = await realpath(task.worktreePath);
  const appWorktreesRoot = await realpath(
    path.resolve(resolveAppPaths(appDataRoot).worktrees),
  ).catch(() => path.resolve(resolveAppPaths(appDataRoot).worktrees));
  const projectWorktreesRoot = await realpath(
    path.join(workspace, ".git", "candy-worktrees"),
  ).catch(() => path.resolve(path.join(workspace, ".git", "candy-worktrees")));
  if (
    !taskWorktree.startsWith(`${appWorktreesRoot}${path.sep}`) &&
    !taskWorktree.startsWith(`${projectWorktreesRoot}${path.sep}`)
  )
    throw new Error("Self-development task escaped Candy-owned Task Worktrees.");

  const note = await readFile(
    path.join(taskWorktree, "docs/implementation/self-development-dogfood-note.md"),
    "utf8",
  );
  if (
    note !==
    "# Candy self-development dogfood\nVerified by the real Candy TUI and DeepSeek Pi Agent Engine.\n"
  )
    throw new Error("Self-development change did not match the bounded requested content.");

  const toolTexts = transcript.filter((entry) => entry.role === "tool").map((entry) => entry.text);
  const assistantTexts = transcript
    .filter((entry) => entry.role === "assistant")
    .map((entry) => entry.text);
  const readEvidence = toolTexts.filter((text) => text.includes("candy_read")).length;
  const bashEvidence = toolTexts.filter((text) => text.includes("candy_bash")).length;
  if (readEvidence < 1 || bashEvidence < 2)
    throw new Error(
      `Self-development transcript lacks repository-read and verification evidence (read=${readEvidence}, bash=${bashEvidence}).`,
    );
  if (
    assistantTexts.length === 0 ||
    !transcript.some((entry) => entry.text.includes("self-development-dogfood-note.md"))
  )
    throw new Error("Self-development transcript lacks discussion or review evidence.");
  if (toolTexts.some((text) => text.includes("读取网络资源")))
    throw new Error("Self-development dogfood unexpectedly used a network shell tool.");

  const credential = resolveCredential("deepseek", environment);
  if (credential === undefined) throw new Error("Candy DeepSeek credential was unavailable.");
  const ptyOutput = await readFile(ptyLog);
  const appDataFiles = await collectFiles(appDataRoot);
  try {
    assertNoSensitiveData(ptyOutput, credential.value, "pty");
    const appDataContents = await readAll(appDataFiles);
    for (const [index, content] of appDataContents.entries()) {
      const relativePath = path.relative(appDataRoot, appDataFiles[index]);
      const scanShape = !relativePath.startsWith(`worktrees${path.sep}`);
      assertNoSensitiveData(content, credential.value, `app-data/${relativePath}`, scanShape);
    }
  } finally {
    credential.release();
  }
  store.close();

  const afterHead = gitCapture(["-C", workspace, "rev-parse", "HEAD"]);
  const afterTree = gitCapture(["-C", workspace, "write-tree"]);
  const afterStatus = gitCapture(["-C", workspace, "status", "--porcelain"]);
  if (afterHead !== beforeHead || afterTree !== beforeTree || afterStatus !== beforeStatus)
    throw new Error("Candy self-development changed the selected source workspace.");
  if (digest(await readFile(outsideSentinel)) !== outsideDigest)
    throw new Error("Candy self-development changed an external sentinel.");

  const evidence = {
    sourceRevision: gitCapture(["rev-parse", "HEAD"]),
    lockfileSha256: lockfileDigest,
    macos: execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    architecture: process.arch,
    node: process.version,
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
    realProvider: true,
    realPiAgentLoop: true,
    taskId: result.task_id,
    selfDevelopment: true,
    repositoryUnderstanding: readEvidence >= 1,
    discussionAndReview: assistantTexts.length > 0,
    modificationInTaskWorktree: true,
    verificationEvidence: bashEvidence >= 2,
    readToolEvidenceCount: readEvidence,
    bashToolEvidenceCount: bashEvidence,
    restartHistory: true,
    taskWorktreeIsolation: true,
    sourceWorkspaceUnchanged:
      afterHead === beforeHead && afterTree === beforeTree && afterStatus === beforeStatus,
    externalSentinelUnchanged: true,
    offlineShellOnly: true,
    credentialFreeEvidence: true,
  };
  await writeEvidence(evidence);
  console.log(JSON.stringify(evidence));
} finally {
  const canonicalJourneyRoot = await realpath(journeyRoot).catch(() => path.resolve(journeyRoot));
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    env: environment,
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((worktreePath) => worktreePath.startsWith(`${canonicalJourneyRoot}${path.sep}`));
  for (const worktreePath of worktrees) {
    execFileSync("git", ["worktree", "remove", "-f", "-f", worktreePath], {
      cwd: root,
      env: environment,
      stdio: "ignore",
    });
  }
  await rm(journeyRoot, { recursive: true, force: true });
}

async function runExpect() {
  await new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/expect",
      ["-f", path.join(root, "tests", "smoke-tui-candy-self-development-macos.exp")],
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
        if (separator < 1) throw new Error("Self-development result is malformed.");
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

function assertNoSensitiveData(value, activeSecret, label, scanShape = true) {
  const credentialPattern =
    /Bearer\s+[A-Za-z0-9._~+/=-]{16,}|\b(?:sk-(?:proj-)?|ds-|minimax-)[A-Za-z0-9._-]{16,}\b/iu;
  const text = value.toString("utf8");
  if (activeSecret.length > 0 && text.includes(activeSecret))
    throw new Error(`Active provider credential entered self-development evidence (${label}).`);
  if (scanShape && credentialPattern.test(text))
    throw new Error(
      `Credential-shaped content entered self-development evidence (shape scan, ${label}).`,
    );
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeEvidence(evidence) {
  const evidenceRoot = path.join(root, "out", "acceptance", "macos");
  await mkdir(evidenceRoot, { recursive: true });
  const report = [
    "# macOS Candy self-development dogfood",
    "",
    "- Status: Pass",
    `- Source revision: \`${evidence.sourceRevision}\``,
    `- Lockfile SHA-256: \`${evidence.lockfileSha256}\``,
    `- macOS: \`${evidence.macos}\` (${evidence.architecture})`,
    `- Node: \`${evidence.node}\``,
    `- npm: \`${evidence.npm}\``,
    "- Provider: real DeepSeek through the production Candy Pi Agent Engine",
    "- Scope: Candy source checkout selected as workspace; requested change remained in a Candy-owned Task Worktree",
    "- Evidence: repository understanding, discussion, modification, verification, diff review, restart history, and credential-free isolation",
    "- Credential values, prompts, raw provider payloads, and terminal logs are not retained in this report.",
    "",
  ].join("\n");
  await writeFile(path.join(evidenceRoot, "candy-self-development-latest.md"), report, "utf8");
}
