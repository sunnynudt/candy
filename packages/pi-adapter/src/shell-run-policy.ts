/**
 * Local-command (shell) run policy for the Candy Pi Adapter.
 *
 * This module owns what a `candy_bash` / `candy_bash_network` run is allowed to
 * be: the cleared child environment, and the OS-profile path policy that the
 * native Sandbox Runner applies as bounded subpath rules. It contains no tool
 * schema, no task state, and no approval decision; those stay in the adapter.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { cleanChildEnvironment } from "@candy/platform";
import type { CandyBashPathSeam } from "./index.js";

export function wrapCandyShellCommand(command: string): string {
  return [
    'trap \'status=$?; trap - EXIT; for pid in $(jobs -pr); do kill "$pid" 2>/dev/null || true; done; exit "$status"\' EXIT',
    command,
  ].join("\n");
}

export function createCandyShellEnvironment(
  workspaceRoot: string,
  activeSecrets: readonly string[],
  bashPath?: string,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(cleanChildEnvironment(process.env, activeSecrets)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (process.platform === "darwin") {
    environment.HOME = workspaceRoot;
    environment.PATH = [
      path.dirname(process.execPath),
      "/Library/Developer/CommandLineTools/usr/bin",
      environment.PATH,
      "/usr/bin",
      "/bin",
    ]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(":");
    environment.GIT_CONFIG_NOSYSTEM = "1";
  } else if (process.platform === "win32") {
    // Git Bash must not inherit the user's profile, Git configuration, or
    // arbitrary PATH entries. The native runner receives the same directories
    // as process-execution policy roots.
    environment.HOME = workspaceRoot;
    environment.USERPROFILE = workspaceRoot;
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_CONFIG_GLOBAL = "NUL";
    delete environment.Path;
    const runtimeDirectory = path.dirname(realpathSync.native(process.execPath));
    const gitBin = bashPath === undefined ? undefined : path.dirname(bashPath);
    const gitRoot = gitBin === undefined ? undefined : path.dirname(gitBin);
    environment.PATH = [
      runtimeDirectory,
      gitRoot === undefined ? undefined : path.join(gitRoot, "cmd"),
      gitBin,
      gitRoot === undefined ? undefined : path.join(gitRoot, "usr", "bin"),
      gitRoot === undefined ? undefined : path.join(gitRoot, "mingw64", "bin"),
    ]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(";");
  }
  return environment;
}

/**
 * Full access keeps normal HOME and PATH semantics, but only after Candy has
 * removed every active provider credential from the child environment.
 */
export function createCandyFullAccessEnvironment(
  activeSecrets: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(cleanChildEnvironment(process.env, activeSecrets)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * Split the shell run's path policy into the paths the OS profile may only
 * read and the task-owned Git metadata it may also write.
 *
 * A linked Worktree keeps its gitdir and common directory outside the selected
 * workspace, so the structural Git subcommands Candy's command policy already
 * allows (`git branch`, `git checkout`, `git merge`, ...) need an explicit
 * write grant there. The `.git` marker itself stays read-only: repointing a
 * Worktree at another repository is never part of a task, and a repository
 * whose own `.git` directory lives inside the workspace needs no extra grant.
 *
 * A grant is downgraded to read-only when the workspace is itself a Candy Task
 * Worktree created under the repository's `.git/candy-worktrees/` directory.
 * Such a worktree's Git common directory is an ancestor of the workspace, and
 * the native runner refuses any write grant that would widen a command beyond
 * the task's own tree. The workspace keeps its own write access, and reading the
 * repository metadata stays no wider than an ordinary workspace whose `.git`
 * directory sits inside it, so Git still resolves the repository.
 *
 * Commit and push are not part of this grant: `containsShellPublicationAction`
 * still refuses them in a local command, and they remain available only
 * through `candy_git_commit` and the task's push policy.
 */
export function resolveCandyShellRunPaths(
  root: string,
  trustedGitCommonDirectory: string | undefined,
  trustedDependencyDirectory: string | undefined,
): { readonly readOnlyPaths: readonly string[]; readonly writablePaths: readonly string[] } {
  const marker = path.join(root, ".git");
  const markerMetadata = trySync(() => lstatSync(marker));
  const runtimeRoot = resolveCandyNodeRuntimeRoot();
  const readOnlyPaths: string[] = [
    ...(runtimeRoot === undefined ? [] : [runtimeRoot]),
    ...(trustedDependencyDirectory === undefined ? [] : [trustedDependencyDirectory]),
  ];
  const writablePaths: string[] = [];
  const settle = () => ({
    readOnlyPaths: [...new Set(readOnlyPaths)],
    writablePaths: [...new Set(writablePaths)],
  });
  if (markerMetadata === undefined) return settle();
  if (markerMetadata.isSymbolicLink())
    throw new Error("Local command Git metadata marker cannot be a symbolic link.");
  if (markerMetadata.isDirectory()) {
    // The repository's own `.git` directory lives inside the workspace, which
    // is already writable. Pinning it read-only would refuse Candy's own
    // structural Git subcommands, and granting it again would be redundant.
    return settle();
  }
  if (!markerMetadata.isFile()) return settle();
  readOnlyPaths.push(marker);
  const contents = trySync(() => readFileSync(marker, "utf8")) ?? "";
  const target = contents.match(/^gitdir:\s*(.+?)\s*$/mu)?.[1];
  if (target === undefined) return settle();
  const gitDirectory = trySync(() =>
    realpathSync.native(
      path.isAbsolute(target) ? target : path.resolve(path.dirname(marker), target),
    ),
  );
  if (gitDirectory === undefined) return settle();
  if (trustedGitCommonDirectory === undefined)
    throw new Error("Local command Git metadata has no Candy-approved common directory.");
  const trustedCommonDirectory = trySync(() => realpathSync.native(trustedGitCommonDirectory));
  if (trustedCommonDirectory === undefined || !isPathWithin(trustedCommonDirectory, gitDirectory))
    throw new Error("Local command Git metadata is outside Candy's approved repository.");
  const gitMetadataPaths = [gitDirectory];
  const commondir = trySync(() => readFileSync(path.join(gitDirectory, "commondir"), "utf8")) ?? "";
  const commonTarget = commondir.trim();
  if (commonTarget.length > 0) {
    const commonDirectory = trySync(() =>
      realpathSync.native(
        path.isAbsolute(commonTarget) ? commonTarget : path.resolve(gitDirectory, commonTarget),
      ),
    );
    if (commonDirectory === undefined || commonDirectory !== trustedCommonDirectory)
      throw new Error("Local command Git common directory changed.");
    gitMetadataPaths.push(commonDirectory);
  }
  // A path inside the workspace is already read/write for this run. A path that
  // contains the workspace cannot be a write grant: the native runner refuses
  // that request outright, which used to make every local command fail with
  // `invalid_path`. It is still granted read-only, which never widens writes
  // and keeps Git able to resolve the repository.
  const canonicalRoot = trySync(() => realpathSync.native(root)) ?? root;
  for (const entry of gitMetadataPaths) {
    if (isPathWithin(root, entry)) continue;
    if (isPathWithin(entry, canonicalRoot)) {
      readOnlyPaths.push(entry);
      continue;
    }
    writablePaths.push(entry);
  }
  return settle();
}

export function resolveCandyShellProcessExecPath(): string {
  const executable = trySync(() => realpathSync.native(process.execPath));
  if (executable === undefined)
    throw new Error("Candy could not canonicalize the local-command runtime executable.");
  return path.dirname(executable);
}

export function resolveCandyShellProcessExecPaths(
  bashPath: string,
  runtimeDirectory: string,
  pathImpl: CandyBashPathSeam,
  exists: (candidate: string) => boolean,
  trustedDependencyDirectory: string | undefined,
): readonly string[] {
  const gitBin = pathImpl.dirname(bashPath);
  const gitRoot = pathImpl.dirname(gitBin);
  const candidates = [
    runtimeDirectory,
    gitBin,
    pathImpl.join(gitRoot, "usr", "bin"),
    pathImpl.join(gitRoot, "mingw64", "bin"),
    pathImpl.join(gitRoot, "cmd"),
    pathImpl.join(gitRoot, "libexec", "git-core"),
    resolveCandyNodeRuntimeNpmBinDirectory(),
    trustedDependencyDirectory,
  ];
  return [
    ...new Set(
      candidates.filter(
        (candidate): candidate is string => candidate !== undefined && exists(candidate),
      ),
    ),
  ];
}

function trySync<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function resolveCandyNodeRuntimeRoot(): string | undefined {
  const executable = trySync(() => realpathSync.native(process.execPath));
  if (executable === undefined) return undefined;
  const binDirectory = path.dirname(executable);
  if (path.basename(binDirectory) !== "bin") return undefined;
  const runtimeRoot = path.dirname(binDirectory);
  const npmCli = path.join(runtimeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return (trySync(() => lstatSync(npmCli))?.isFile() ?? false) ? runtimeRoot : undefined;
}

function resolveCandyNodeRuntimeNpmBinDirectory(): string | undefined {
  const runtimeRoot = resolveCandyNodeRuntimeRoot();
  if (runtimeRoot === undefined) return undefined;
  const npmCli = path.join(runtimeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return trySync(() => realpathSync.native(path.dirname(npmCli)));
}
