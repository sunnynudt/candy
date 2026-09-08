#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const marker = "# managed by Candy post-commit hook";

const repoRoot = getRepoRoot();
const existingHooksPath = getConfigGit();
const effectiveHooksPath = resolveHooksPath(existingHooksPath, repoRoot);

mkdirSync(effectiveHooksPath, { recursive: true });

const postCommitPath = path.join(effectiveHooksPath, "post-commit");
const legacyPath = path.join(effectiveHooksPath, "post-commit.candy-legacy");

if (existsSync(postCommitPath)) {
  const current = readFileSync(postCommitPath, "utf8");
  if (!current.includes(marker)) {
    const backupName = getAvailableBackupPath(legacyPath);
    renameSync(postCommitPath, backupName);
    writeHook(postCommitPath, path.basename(backupName));
  } else {
    console.log("post-commit hook already managed by Candy.");
  }
} else {
  writeHook(postCommitPath);
}

if (!existingHooksPath) {
  execSyncGit(["config", "--local", "core.hooksPath", ".githooks"], repoRoot);
}

chmodSync(postCommitPath, 0o755);

if (existingHooksPath && existingHooksPath !== ".githooks") {
  console.log(`existing core.hooksPath=${existingHooksPath}`);
  console.log(`Candy hook installed at ${path.relative(repoRoot, postCommitPath)}`);
} else {
  console.log("installed candy local hook path at .githooks");
  console.log("installed post-commit hook. Commit 后会自动执行 runtime-relevant 变更检测和可用时自动更新。当前会跳过 CI/环境变量禁用场景，不会阻塞 commit。");
}

function writeHook(targetPath, legacyFileName) {
  const legacyInvocation = legacyFileName
    ? `"$(dirname \"$0\")/${legacyFileName}" "$@" || true`
    : "";
  const script = `#!/usr/bin/env sh
set -eu

# ${marker}
if [ "\${CI:-}" = "1" ] || [ "\${CI:-}" = "true" ] || [ "\${CANDY_SKIP_AUTO_UPDATE:-}" = "1" ]; then
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "\${repo_root}" ]; then
  exit 0
fi

cd "$repo_root"
node scripts/package-tui-release-if-changed.mjs || true
${legacyInvocation}
`;
  writeFileSync(targetPath, script, "utf8");
}

function getRepoRoot() {
  const out = execSyncGit(["rev-parse", "--show-toplevel"]);
  return out.trim();
}

function getConfigGit() {
  try {
    const raw = execSyncGit(["config", "--get", "core.hooksPath"]);
    return raw.trim() || "";
  } catch {
    return "";
  }
}

function resolveHooksPath(existingHooksPath, repoRoot) {
  if (!existingHooksPath) {
    return path.join(repoRoot, ".githooks");
  }

  return path.isAbsolute(existingHooksPath)
    ? existingHooksPath
    : path.resolve(repoRoot, existingHooksPath);
}

function getAvailableBackupPath(candidate) {
  if (!existsSync(candidate)) {
    return candidate;
  }

  let index = 1;
  while (existsSync(`${candidate}.${index}`)) {
    index += 1;
  }
  return `${candidate}.${index}`;
}

function execSyncGit(args, cwd) {
  const commandCwd = cwd ?? process.cwd();
  return execFileSync("git", args, {
    cwd: commandCwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
