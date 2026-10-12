import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCandyBashOperations } from "../dist/index.js";

/**
 * Mirrors the native runner's rule: a write grant must never contain the task
 * workspace, because that would widen the command beyond the task's own tree.
 */
function grantContainsWorkspace(grant: string, workspace: string): boolean {
  const relative = path.relative(grant, workspace);
  if (relative === "") return true;
  if (relative === "..") return false;
  return !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * A Candy Task Worktree created under the repository's own
 * `.git/candy-worktrees/` directory can itself be the selected workspace. The
 * worktree's Git common directory is then an ancestor of the workspace, and the
 * runner refuses a write grant that contains the workspace. Candy used to send
 * that grant anyway, so every local command failed with `invalid_path` and
 * `candy_bash` was unusable in such a workspace.
 */
test("Candy Bash downgrades a Git grant that contains the task workspace", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "candy-nested-worktree-"));
  const commonDirectory = path.join(repository, ".git");
  const workspace = path.join(commonDirectory, "candy-worktrees", "task");
  const gitDirectory = path.join(commonDirectory, "worktrees", "task");
  await mkdir(workspace, { recursive: true });
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(path.join(workspace, ".git"), `gitdir: ${gitDirectory}\n`);
  await writeFile(path.join(gitDirectory, "commondir"), "../..\n");
  let writablePaths: readonly string[] | undefined;
  let readOnlyPaths: readonly string[] | undefined;
  let runnerCalled = false;
  const operations = createCandyBashOperations(workspace, {
    bashPath: "/bin/bash",
    exists: () => true,
    trustedGitCommonDirectory: commonDirectory,
    runner: {
      run: async (request) => {
        runnerCalled = true;
        writablePaths = request.writablePaths;
        readOnlyPaths = request.readOnlyPaths;
        return { code: 0, signal: null, stdout: "", stderr: "", cancelled: false };
      },
    },
  });

  await operations.exec("git status --short", workspace, { onData: () => undefined });

  assert.equal(runnerCalled, true);
  const canonicalWorkspace = await realpath(workspace);
  const grants = writablePaths ?? [];
  // This worktree's own gitdir holds its index, so that grant stays required.
  assert.ok(grants.includes(await realpath(gitDirectory)));
  // The Git common directory contains the workspace, so it becomes a read-only
  // grant instead of a write grant the runner would refuse.
  assert.equal(grants.includes(await realpath(commonDirectory)), false);
  assert.ok((readOnlyPaths ?? []).includes(await realpath(commonDirectory)));
  for (const grant of grants) {
    assert.equal(grantContainsWorkspace(await realpath(grant), canonicalWorkspace), false);
  }
});

/**
 * The downgrade must not change the ordinary linked-Worktree case, where the
 * gitdir and the Git common directory both stay outside the task workspace and
 * still need an explicit write grant.
 */
test("Candy Bash still grants Git metadata outside the task workspace", async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "candy-linked-worktree-"));
  const commonDirectory = path.join(repository, ".git");
  const workspace = path.join(repository, "candy-worktrees", "task");
  const gitDirectory = path.join(commonDirectory, "worktrees", "task");
  await mkdir(workspace, { recursive: true });
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(path.join(workspace, ".git"), `gitdir: ${gitDirectory}\n`);
  await writeFile(path.join(gitDirectory, "commondir"), "../..\n");
  let writablePaths: readonly string[] | undefined;
  const operations = createCandyBashOperations(workspace, {
    bashPath: "/bin/bash",
    exists: () => true,
    trustedGitCommonDirectory: commonDirectory,
    runner: {
      run: async (request) => {
        writablePaths = request.writablePaths;
        return { code: 0, signal: null, stdout: "", stderr: "", cancelled: false };
      },
    },
  });

  await operations.exec("git status --short", workspace, { onData: () => undefined });

  const expectedGrants = [await realpath(gitDirectory), await realpath(commonDirectory)];
  assert.deepEqual(writablePaths, expectedGrants);
});
