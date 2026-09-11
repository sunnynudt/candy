import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAppPaths, SQLiteTaskStore } from "@candy/platform";
import {
  InteractiveTui,
  isFullAccessAvailableOnHost,
  type InteractiveTuiOptions,
  type TuiAgentEngine,
} from "./main.js";
import { FakeTerminal } from "./pi-tui-surface.js";

function createGitWorkspace(root: string): string {
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "candy-test@example.invalid"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Candy Test"], { cwd: repo });
  writeFileSync(path.join(repo, "readme.md"), "# fixture\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  return repo;
}

const shellRunner = {
  run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", cancelled: false }),
};

async function waitForOutput(
  terminal: FakeTerminal,
  pattern: RegExp,
  maxAttempts: number = 500,
): Promise<string> {
  for (let attempt: number = 0; attempt < maxAttempts; attempt += 1) {
    const output: string = terminal.writes.join("");
    if (pattern.test(output)) return output;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 1);
    });
  }
  return terminal.writes.join("");
}

class FullAccessHarness extends InteractiveTui {
  public constructor(options: InteractiveTuiOptions) {
    super({ fullAccessAvailable: true, shellRunner, ...options });
  }
}

test("Full access keeps current-workspace placement: tasks work directly with the wide sandbox", async () => {
  if (!isFullAccessAvailableOnHost()) return;
  const root = await mkdtemp(path.join(tmpdir(), "candy-full-current-"));
  const repository = createGitWorkspace(root);
  const appDataRoot = path.join(root, "app-data");
  const terminal: FakeTerminal = new FakeTerminal();
  const observed: { fullAccess: boolean | undefined; cwd: string }[] = [];
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      observed.push({ fullAccess: input.fullAccess, cwd: input.cwd });
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const runPromise = new FullAccessHarness({
      appDataRoot,
      workspacePath: repository,
      terminal,
      engine,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("/access current");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /访问模式：当前工作区/u);
    terminal.emitInput("/access full");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /Full access warning/u);
    terminal.emitInput("/access full confirm");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /Full access is now the default/u);
    terminal.emitInput("run direct with wide sandbox");
    terminal.emitInput("\r");
    const created = await waitForOutput(terminal, /Full access enabled by default/u);
    const taskId = created.match(/created (task-[a-z0-9]+)/u)?.[1];
    assert.ok(taskId, "task id should be printed");
    await waitForOutput(terminal, new RegExp(`${taskId} completed`, "u"));
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.fullAccess, true);
    assert.equal(observed[0]?.cwd, realpathSync(repository));
    const store = new SQLiteTaskStore(
      path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"),
    );
    const task = store.get(taskId);
    assert.equal(task?.fullAccess, true);
    assert.equal(task?.worktreePath, undefined);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Full access default survives /access current and restarts; /access safe exits it", async () => {
  if (!isFullAccessAvailableOnHost()) return;
  const root = await mkdtemp(path.join(tmpdir(), "candy-full-current-persist-"));
  const repository = createGitWorkspace(root);
  const appDataRoot = path.join(root, "app-data");
  const terminal: FakeTerminal = new FakeTerminal();
  const engine: TuiAgentEngine = {
    async *runTurn(input) {
      yield { type: "turn.started", taskId: input.taskId };
      yield { type: "turn.completed", taskId: input.taskId };
    },
  };
  try {
    const runPromise = new FullAccessHarness({
      appDataRoot,
      workspacePath: repository,
      terminal,
      engine,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("/access full");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /Full access warning/u);
    terminal.emitInput("/access full confirm");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /Full access is now the default/u);
    terminal.emitInput("/access current");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /访问模式：当前工作区/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    const afterRestart = new FakeTerminal();
    const afterRestartRun = new FullAccessHarness({
      appDataRoot,
      workspacePath: repository,
      terminal: afterRestart,
      engine,
    }).run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await waitForOutput(afterRestart, /⚠ FULL ACCESS/u);
    afterRestart.emitInput("/access current");
    afterRestart.emitInput("\r");
    await waitForOutput(afterRestart, /访问模式：当前工作区/u);
    const store = new SQLiteTaskStore(
      path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"),
    );
    assert.equal(store.fullAccessDefaultEnabled(), true);
    afterRestart.emitInput("/access safe");
    afterRestart.emitInput("\r");
    await waitForOutput(afterRestart, /访问模式：安全工作区/u);
    assert.equal(store.fullAccessDefaultEnabled(), false);
    afterRestart.emitInput(":quit");
    afterRestart.emitInput("\r");
    await afterRestartRun;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
