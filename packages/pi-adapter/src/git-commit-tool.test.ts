import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCandyWorkspaceTools } from "./index.js";

function runGit(args: readonly string[], cwd: string): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function createGitRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  runGit(["init", "-q"], root);
  runGit(["config", "user.email", "candy-test@example.invalid"], root);
  runGit(["config", "user.name", "Candy Test"], root);
  await writeFile(path.join(root, "initial.txt"), "base\n", "utf8");
  runGit(["add", "-A"], root);
  runGit(["commit", "-q", "-m", "initial"], root);
}

function findCommitTool(
  root: string,
  pushPolicy: "deny" | "allow" = "deny",
  activeValues: readonly string[] = [],
) {
  const tools = createCandyWorkspaceTools(root, "auto", undefined, undefined, activeValues, {
    git: { pushPolicy, activeSecrets: activeValues },
  });
  const tool = tools.find((entry) => entry.name === "candy_git_commit");
  assert.ok(tool, "candy_git_commit tool is registered");
  return tool;
}

async function invoke(tool: { execute: unknown }, message: string, push = false): Promise<string> {
  const exec = tool.execute as (
    callId: string,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<unknown>;
  const result = (await exec(
    "git-call",
    push ? { message, push: true } : { message },
    new AbortController().signal,
  )) as { content: readonly { text: string }[] };
  return result.content.map((part) => part.text).join("");
}

test("candy_git_commit stages and commits workspace changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-commit-"));
  try {
    await createGitRepo(root);
    await writeFile(path.join(root, "initial.txt"), "updated\n", "utf8");
    const tool = findCommitTool(root);
    const output = await invoke(tool, "update initial file");
    assert.match(output, /committed [0-9a-f]{7,12}: update initial file/u);
    assert.equal(runGit(["log", "-1", "--format=%s"], root), "update initial file");
    assert.equal(runGit(["status", "--porcelain"], root), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candy_git_commit rejects a credential-shaped working diff before commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-credential-"));
  try {
    await createGitRepo(root);
    const fakeValue = "s" + "k" + "-" + "a".repeat(24);
    await writeFile(path.join(root, "leak.txt"), `${fakeValue}\n`, "utf8");
    const before = runGit(["rev-parse", "HEAD"], root);
    const tool = findCommitTool(root);
    await assert.rejects(invoke(tool, "leak"), /credentials are forbidden/u);
    assert.equal(runGit(["rev-parse", "HEAD"], root), before);
    assert.equal(runGit(["diff", "--cached", "--name-only"], root), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candy_git_commit rejects an active value in the working diff", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-active-value-"));
  try {
    await createGitRepo(root);
    const activeValue = "a".repeat(24);
    await writeFile(path.join(root, "leak.txt"), `prefix-${activeValue}\n`, "utf8");
    const tool = findCommitTool(root, "deny", [activeValue]);
    await assert.rejects(invoke(tool, "leak"), /credentials are forbidden/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candy_git_commit rejects an overlong commit message", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-long-"));
  try {
    await createGitRepo(root);
    await writeFile(path.join(root, "initial.txt"), "x\n", "utf8");
    const tool = findCommitTool(root);
    await assert.rejects(
      invoke(tool, "m".repeat(201)),
      /commit message is outside the allowed bounds/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candy_git_commit rejects control characters in the message", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-control-"));
  try {
    await createGitRepo(root);
    await writeFile(path.join(root, "initial.txt"), "x\n", "utf8");
    const tool = findCommitTool(root);
    await assert.rejects(invoke(tool, "bad\u0007message"), /control characters/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candy_git_commit rejects push when the task policy denies it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-push-deny-"));
  try {
    await createGitRepo(root);
    await writeFile(path.join(root, "initial.txt"), "y\n", "utf8");
    const before = runGit(["rev-parse", "HEAD"], root);
    const tool = findCommitTool(root, "deny");
    await assert.rejects(invoke(tool, "should not commit", true), /push is not authorized/u);
    assert.equal(runGit(["rev-parse", "HEAD"], root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candy_git_commit pushes after commit when the task policy allows it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-push-allow-"));
  const remoteRoot = await mkdtemp(path.join(tmpdir(), "candy-git-remote-"));
  try {
    await createGitRepo(root);
    const bareRemote = path.join(remoteRoot, "origin.git");
    runGit(["init", "-q", "--bare", bareRemote], remoteRoot);
    runGit(["remote", "add", "origin", bareRemote], root);
    runGit(["push", "-q", "-u", "origin", "HEAD"], root);
    await writeFile(path.join(root, "initial.txt"), "pushed change\n", "utf8");
    const tool = findCommitTool(root, "allow");
    const output = await invoke(tool, "commit and push", true);
    assert.match(output, /pushed .* to origin/u);
    const repoHead = runGit(["rev-parse", "HEAD"], root);
    assert.equal(runGit(["rev-parse", "HEAD"], bareRemote), repoHead);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

test("candy_git_commit reports a clean workspace without creating a commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-clean-"));
  try {
    await createGitRepo(root);
    const before = runGit(["rev-parse", "HEAD"], root);
    const tool = findCommitTool(root);
    const output = await invoke(tool, "no changes");
    assert.match(output, /no changes to commit/u);
    assert.equal(runGit(["rev-parse", "HEAD"], root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candy_git_commit is not registered outside a Git repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-git-nonrepo-"));
  try {
    const tools = createCandyWorkspaceTools(root, "auto", undefined, undefined, [], {
      git: { pushPolicy: "deny" },
    });
    assert.equal(
      tools.some((entry) => entry.name === "candy_git_commit"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
