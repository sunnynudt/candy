import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnvironment } from "@candy/platform";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const acceptanceRoot = path.join(root, "out", "acceptance", "windows");
const npmScript = process.env.npm_execpath;
const electronOverride = process.env.ELECTRON_OVERRIDE_DIST_PATH;

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Windows acceptance requires Windows x64.");
if (!npmScript) throw new Error("Run Windows acceptance through npm.");
if (!electronOverride)
  throw new Error("Set ELECTRON_OVERRIDE_DIST_PATH to the verified Electron runtime first.");

const startedAt = new Date();
const revision = runCapture("git", ["rev-parse", "HEAD"]);
const lockfileDigest = createHash("sha256")
  .update(await readFile(path.join(root, "package-lock.json")))
  .digest("hex");
const cleanWorktree = runCapture("git", ["status", "--porcelain"]) === "";
const steps = [
  "check:toolchain",
  "check",
  "check:native",
  "smoke:native:windows",
  "smoke:credential-manager:windows",
  "smoke:tui-task",
  "smoke:app-server",
  "smoke:recovery:windows",
  "smoke:desktop",
  "smoke:desktop:packaged:windows",
  "smoke:browser:windows",
  "smoke:credential-manager:packaged:windows",
  "measure:windows:responsiveness",
];
const results = [];

for (const script of steps) results.push(await runNpmScript(script));

const passed = results.filter((result) => result.status === "pass").length;
const failed = results.filter((result) => result.status === "fail").length;
const finishedAt = new Date();
const report = [
  "# Candy Windows 11 Pro x64 Deterministic Acceptance Run",
  "",
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${finishedAt.toISOString()}`,
  `- Source revision: \`${revision}\``,
  `- Lockfile SHA-256: \`${lockfileDigest}\``,
  `- Platform: Windows ${os.arch()} (${os.version()})`,
  `- Node: \`${process.version}\``,
  "- Electron runtime: `43.2.0` verified local Windows x64 distribution",
  `- Worktree clean at start: \`${cleanWorktree ? "yes" : "no"}\``,
  "",
  "This is a sanitized deterministic Windows implementation and smoke run. It does not run live providers, inspect other tool credentials, or claim signed packaging, Browser acceptance, native security acceptance, complete ACC-01..12, cross-platform support, or final V1 acceptance.",
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
  "## Required Windows evidence still open",
  "",
  "- Windows signed Desktop installation, packaged active-owner/tool interruption recovery, and packaged Browser evidence; the unsigned packaged JSONL smoke is recorded separately.",
  "- Full Windows Credential Manager lifecycle for the already-present DeepSeek account; the synthetic empty MiniMax account was tested and real credentials were not changed.",
  "- Windows G2 OS-level no-network and arbitrary-command workspace containment, runtime reparse/race prevention, packaging, and independent security review. Shell Auto and Shell Auto Debug remain disabled.",
  "- Browser Workspace site authorization, observation revisions, Take Control, downloads, and adversarial page matrix.",
  "- Remaining ACC-01..12 Windows journeys, complete ACC-12 metrics, live MiniMax/Token Plan entitlement, Windows signing identity, and product-owner acceptance.",
  "",
].join("\n");

await mkdir(acceptanceRoot, { recursive: true });
await writeFile(path.join(acceptanceRoot, "latest.md"), report, "utf8");
console.log(
  `Windows acceptance report: out/acceptance/windows/latest.md (${passed} passed, ${failed} failed)`,
);
if (failed > 0) process.exitCode = 1;

async function runNpmScript(script) {
  const started = Date.now();
  const environment = cleanChildEnvironment(process.env);
  environment.ELECTRON_OVERRIDE_DIST_PATH = electronOverride;
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [npmScript, "run", script], {
      cwd: root,
      env: environment,
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
