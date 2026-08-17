import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const acceptanceRoot = path.join(root, "out", "acceptance", "macos");
const npmScript = process.env.npm_execpath;
const baselineMacosVersion = "26.5.2";
const acceptanceMode = process.argv.includes("--baseline") ? "baseline" : "current";
const reportFileName = acceptanceMode === "baseline" ? "baseline-latest.md" : "latest.md";
const acceptanceTarget =
  acceptanceMode === "baseline"
    ? `macOS ${baselineMacosVersion} arm64 regression baseline`
    : "current macOS Tahoe 26.x arm64 host";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("macOS acceptance requires macOS arm64.");
}
if (!npmScript) {
  throw new Error("Run macOS acceptance through npm so the pinned npm executable is explicit.");
}

const startedAt = new Date();
const revision = runCapture("git", ["rev-parse", "HEAD"]);
const lockfileDigest = createHash("sha256")
  .update(await readFile(path.join(root, "package-lock.json")))
  .digest("hex");
const macosVersion = runCapture("/usr/bin/sw_vers", ["-productVersion"]);
const architecture = runCapture("/usr/bin/uname", ["-m"]);
const cleanWorktree = runCapture("git", ["status", "--porcelain"]) === "";
const targetMatches =
  acceptanceMode === "baseline"
    ? macosVersion === baselineMacosVersion
    : isCurrentMacosVersion(macosVersion);
if (!targetMatches || architecture !== "arm64") {
  const reason =
    acceptanceMode === "baseline"
      ? `macOS baseline acceptance requires ${baselineMacosVersion} on arm64; received ${macosVersion} on ${architecture}.`
      : `current macOS acceptance requires Tahoe 26.x at or above ${baselineMacosVersion} on arm64; received ${macosVersion} on ${architecture}.`;
  await writeBlockedReport({
    startedAt,
    revision,
    lockfileDigest,
    macosVersion,
    architecture,
    cleanWorktree,
    reason,
    acceptanceMode,
  });
  throw new Error(reason);
}
const steps = [
  "check:toolchain",
  "check",
  "check:native",
  "measure:tui:responsiveness",
  "smoke:tui:launcher",
  "smoke:tui:credentials",
  "smoke:tui:pi",
  "smoke:tui:pi:tool",
  "smoke:tui-task",
  "smoke:tui:journey:macos",
  "smoke:tui:terminal:macos",
];
const results = [];

for (const script of steps) {
  const result = await runNpmScript(script);
  results.push(result);
}

const passed = results.filter((result) => result.status === "pass").length;
const failed = results.filter((result) => result.status === "fail").length;
const finishedAt = new Date();
const report = [
  "# Candy macOS Apple Silicon Acceptance Run",
  "",
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${finishedAt.toISOString()}`,
  `- Source revision: \`${revision}\``,
  `- Lockfile SHA-256: \`${lockfileDigest}\``,
  `- Acceptance mode: \`${acceptanceMode}\``,
  `- Acceptance target: ${acceptanceTarget}`,
  `- macOS product version: \`${macosVersion}\``,
  `- Architecture: \`${architecture}\``,
  `- Node: \`${process.version}\``,
  `- Worktree clean at start: \`${cleanWorktree ? "yes" : "no"}\``,
  "",
  `This is a deterministic TUI-only smoke run for the ${acceptanceTarget}. The exact host version is recorded above. It does not run live providers, inspect other tool credentials, or claim Trusted Shell G2, exact-baseline compatibility, Windows parity, V2 Desktop/Browser completion, or final V1 acceptance.`,
  "",
  `Summary: ${passed} passed, ${failed} failed.`,
  "",
  "| Step | Status | Duration |",
  "| --- | --- | ---: |",
  ...results.map(
    (result) =>
      `| \`npm run ${result.script}\` | ${result.status === "pass" ? "Pass" : "Fail"} | ${result.durationMs} ms |`,
  ),
  "",
  "## Separately tracked provider evidence",
  "",
  "- Live DeepSeek and MiniMax provider matrices are established and reported by their provider-specific Gate runs; this deterministic command does not rerun or downgrade them.",
  "",
  "## Remaining external gates",
  "",
  acceptanceMode === "baseline"
    ? "- Current macOS Tahoe 26.x primary acceptance evidence (run npm run acceptance:macos)."
    : `- Exact macOS ${baselineMacosVersion} Apple Silicon regression evidence (run npm run acceptance:macos:baseline when that host is available).`,
  acceptanceMode === "baseline"
    ? "- macOS Trusted Shell Auto Personal Preview evidence is current-host-only; Windows Trusted Shell, Shell-based Auto Debug, and exact-baseline compatibility remain separate gates."
    : "- Windows Trusted Shell, Shell-based Auto Debug, exact 26.5.2 compatibility, and signed release acceptance remain separate gates.",
  "- Windows 11 TUI evidence, exact macOS 26.5.2 baseline evidence, and platform-specific Trusted Shell G2 evidence remain separate gates.",
  "- Live DeepSeek/MiniMax provider contracts and provider cancellation evidence remain separate gates.",
  "- Electron Desktop and Browser Workspace acceptance is V2 and is not part of this report.",
  "",
].join("\n");

await mkdir(acceptanceRoot, { recursive: true });
const reportPath = path.join(acceptanceRoot, reportFileName);
await writeFile(reportPath, report, "utf8");
console.log(`macOS acceptance report: ${path.relative(root, reportPath)}`);

if (failed > 0) process.exitCode = 1;

async function runNpmScript(script) {
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [npmScript, "run", script], {
      cwd: root,
      env: cleanChildEnvironment(process.env),
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) =>
      resolve({ script, status: "fail", durationMs: Date.now() - started, error }),
    );
    child.once("exit", (code, signal) =>
      resolve({
        script,
        status: code === 0 ? "pass" : "fail",
        durationMs: Date.now() - started,
        ...(code === 0 ? {} : { error: `${code ?? "null"}/${signal ?? "no signal"}` }),
      }),
    );
  });
  if (result.status === "fail")
    console.error(
      `acceptance step failed: npm run ${script} (${result.error?.message ?? result.error})`,
    );
  return result;
}

function runCapture(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isCurrentMacosVersion(value) {
  const parsed = parseMacosVersion(value);
  const baseline = parseMacosVersion(baselineMacosVersion);
  return (
    parsed !== undefined &&
    baseline !== undefined &&
    parsed.major === 26 &&
    compareMacosVersions(parsed, baseline) >= 0
  );
}

function parseMacosVersion(value) {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length < 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    return undefined;
  }
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

function compareMacosVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

async function writeBlockedReport({
  startedAt,
  revision,
  lockfileDigest,
  macosVersion,
  architecture,
  cleanWorktree,
  reason,
  acceptanceMode,
}) {
  const finishedAt = new Date();
  const report = [
    "# Candy macOS Apple Silicon Acceptance Run",
    "",
    `- Started: ${startedAt.toISOString()}`,
    `- Finished: ${finishedAt.toISOString()}`,
    `- Source revision: \`${revision}\``,
    `- Lockfile SHA-256: \`${lockfileDigest}\``,
    `- Acceptance mode: \`${acceptanceMode}\``,
    `- Acceptance target: ${acceptanceTarget}`,
    `- macOS product version: \`${macosVersion}\``,
    `- Architecture: \`${architecture}\``,
    `- Node: \`${process.version}\``,
    `- Worktree clean at start: \`${cleanWorktree ? "yes" : "no"}\``,
    "",
    `This ${acceptanceMode} acceptance run is Blocked before execution because its target host is unavailable. No acceptance step ran and no Pass or Fail result was produced for the macOS target.`,
    "",
    "Summary: 0 passed, 0 failed, 1 blocked.",
    "",
    "| Step | Status | Duration |",
    "| --- | --- | ---: |",
    "| macOS target preflight | Blocked | 0 ms |",
    "",
    "## Blocker",
    "",
    `- ${reason}`,
    "- The report is current-HEAD preflight evidence only; it is not macOS acceptance evidence.",
    "",
  ].join("\n");
  await mkdir(acceptanceRoot, { recursive: true });
  const reportPath = path.join(acceptanceRoot, reportFileName);
  await writeFile(reportPath, report, "utf8");
  console.error(`macOS acceptance report: ${path.relative(root, reportPath)} (Blocked preflight)`);
}
