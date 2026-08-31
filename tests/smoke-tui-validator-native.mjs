// Model-free validator lifecycle smoke: real TUI + real native sandbox runner.
// Reproduces the acceptance path that the dogfood PTY journey exercises
// (`:validate` after a completed task), with a deliberately long failing-test
// evidence body. The `validator <status>:` anchor must stay visible in the
// terminal byte stream even though the evidence overflows the transcript
// viewport (regression: the anchor scrolled out and the PTY smoke timed out).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandValidator } from "@candy/runtime";
import { NativeProcessRunner } from "@candy/platform";
import { InteractiveTui } from "../apps/tui/dist/main.js";
import { FakeTerminal } from "../apps/tui/dist/pi-tui-surface.js";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Native validator smoke requires macOS arm64.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = path.join(
  root,
  "native",
  "sandbox-runner",
  "target",
  "debug",
  "candy-sandbox-runner",
);
if (!existsSync(runnerPath))
  throw new Error(
    `Native sandbox runner is missing; build it with npm run check:native: ${runnerPath}`,
  );

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "candy-tui-validator-native-"));
const workspace = path.join(fixtureRoot, "workspace");
await mkdir(path.join(workspace, "src"), { recursive: true });
await mkdir(path.join(workspace, "test"), { recursive: true });
execFileSync("git", ["init", "-q", workspace]);
execFileSync("git", ["-C", workspace, "config", "user.email", "candy-validator@example.invalid"]);
execFileSync("git", ["-C", workspace, "config", "user.name", "Candy Validator Fixture"]);
await writeFile(path.join(workspace, "README.md"), "validator fixture\n", "utf8");
execFileSync("git", ["-C", workspace, "add", "README.md"]);
execFileSync("git", ["-C", workspace, "commit", "-qm", "validator fixture baseline"]);
await writeFile(path.join(workspace, "src", "value.mjs"), "export const value = 1;\n", "utf8");
await writeFile(
  path.join(workspace, "test", "value.test.mjs"),
  "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n\ntest('value is repaired', () => assert.equal(value, 2));\n",
  "utf8",
);

const validator = {
  run: (command, executionPath, signal, activeSecrets) =>
    new CommandValidator(new NativeProcessRunner(runnerPath)).run(
      command,
      executionPath,
      signal,
      {},
      activeSecrets ?? [],
    ),
};

const terminal = new FakeTerminal();
const tui = new InteractiveTui({
  appDataRoot: path.join(fixtureRoot, "app-data"),
  workspacePath: workspace,
  terminal,
  validator,
  engine: {
    async *runTurn(input) {
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  },
});

const watchdog = globalThis.setTimeout(() => {
  console.error("validator terminal state did not appear; tail output:");
  console.error(terminal.writes.join("").slice(-2000));
  process.exit(1);
}, 60_000);

const runPromise = tui.run();
await new Promise((resolve) => globalThis.setImmediate(resolve));
const send = async (value) => {
  terminal.emitInput(value);
  terminal.emitInput("\r");
};
const waitFor = async (pattern, label, maxMs = 45_000) => {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const output = terminal.writes.join("");
    if (pattern.test(output)) return output;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
};

try {
  await send(`:workspace ${workspace}`);
  await waitFor(/workspace selected:/u, "workspace selection");
  await send(":profile auto");
  await waitFor(/profile auto/u, "Auto profile");
  await send(`:validator ${process.execPath} --test test/value.test.mjs`);
  await waitFor(/validator configured/u, "validator configuration");
  await send(":new");
  await send("run the failing fixture test");
  await waitFor(/completed/u, "task completion");

  await send(":validate");
  await waitFor(/validator running:/u, "validator start");
  const output = await waitFor(/validator fail:/u, "validator fail state line");
  assert.match(output, /validator fail:/u);
  assert.match(output, /# fail 1/u, "the native runner evidence must show the failing test");
  // The status anchor must be rendered in the visible viewport tail, not
  // scrolled out by the long evidence body.
  assert.match(terminal.writes.slice(-4).join(""), /validator fail:/u);
  console.log("validator lifecycle: running -> fail (evidence visible)");

  await send(":quit");
  await runPromise;
  globalThis.clearTimeout(watchdog);
  console.log("native validator smoke passed");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
