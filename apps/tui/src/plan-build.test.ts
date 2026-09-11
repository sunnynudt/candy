import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { resolveAppPaths, SQLiteTaskStore, type TaskMetadata } from "@candy/platform";
import {
  InteractiveTui,
  type InteractiveTuiOptions,
  type TuiAgentEngine,
  type TuiValidator,
} from "./main.js";
import { FakeTerminal } from "./pi-tui-surface.js";

const testWorkspace = await mkdtemp(path.join(tmpdir(), "candy-tui-plan-workspace-"));

class TestInteractiveTui extends InteractiveTui {
  public constructor(options: InteractiveTuiOptions = {}) {
    super({ workspacePath: testWorkspace, ...options });
  }
}

after(async () => {
  await rm(testWorkspace, { recursive: true, force: true });
});

async function waitForOutput(
  terminal: FakeTerminal,
  pattern: RegExp,
  maxAttempts: number = 5_000,
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

async function waitForValue<T>(
  value: () => T | undefined,
  description: string,
  maxAttempts: number = 5_000,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = value();
    if (current !== undefined) return current;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForTask(
  store: SQLiteTaskStore,
  predicate: (task: TaskMetadata) => boolean,
  description: string,
): Promise<TaskMetadata> {
  return waitForValue(() => store.list().find(predicate), description);
}

async function waitForAsyncValue<T>(
  value: () => Promise<T | undefined>,
  description: string,
  maxAttempts: number = 5_000,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await value();
    if (current !== undefined) return current;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function createTuiGitFixture(root: string): Promise<string> {
  const repository = path.join(root, "repository");
  await mkdir(repository);
  runGit(repository, ["init", "-q"]);
  await writeFile(path.join(repository, "README.md"), "base\n");
  runGit(repository, ["add", "README.md"]);
  runGit(repository, [
    "-c",
    "user.name=Candy Fixture",
    "-c",
    "user.email=candy-fixture@example.invalid",
    "commit",
    "-qm",
    "base",
  ]);
  return repository;
}

test("/plan runs a read-only planning turn and /build continues it with the current profile", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-plan-flow-"));
  const repository = await createTuiGitFixture(root);
  const terminal: FakeTerminal = new FakeTerminal();
  const profiles: Array<"read-only" | "auto" | undefined> = [];
  const prompts: string[] = [];
  let turn = 0;
  let store: SQLiteTaskStore | undefined;
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        turn += 1;
        profiles.push(input.approvalProfile);
        prompts.push(input.prompt);
        yield { type: "turn.started", taskId: input.taskId };
        yield {
          type: "assistant.delta",
          taskId: input.taskId,
          text: turn === 1 ? "plan: change README.md" : "implemented README.md",
        };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise: Promise<void> = new TestInteractiveTui({
      appDataRoot: path.join(root, "app-data"),
      workspacePath: repository,
      engine,
      terminal,
    }).run();
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    terminal.emitInput("/plan update the readme");
    terminal.emitInput("\r");
    store = new SQLiteTaskStore(
      path.join(resolveAppPaths(path.join(root, "app-data")).state, "tasks.sqlite"),
    );
    const planTask = await waitForTask(
      store,
      (task) => task.approvalProfile === "read-only",
      "the persisted plan task",
    );
    const taskId = planTask.taskId;
    await waitForValue(
      () => (turn === 1 && store?.get(taskId)?.state === "completed" ? true : undefined),
      "the completed planning turn",
    );
    assert.equal(profiles[0], "read-only");
    assert.match(prompts[0] ?? "", /\[PLAN-MODE\]/u);
    assert.doesNotMatch(prompts[0] ?? "", /\[BUILD-PHASE\]/u);
    assert.equal(planTask.trustedShell, false);

    terminal.emitInput(`/build ${taskId}`);
    terminal.emitInput("\r");
    await waitForValue(
      () => (turn === 2 && store?.get(taskId)?.state === "completed" ? true : undefined),
      "the completed build continuation",
    );
    const builtTask = store.get(taskId);
    assert.ok(builtTask);
    assert.equal(builtTask.approvalProfile, "auto");
    assert.equal(profiles[1], "auto");
    assert.match(prompts[1] ?? "", /\[BUILD-PHASE\]/u);
    assert.doesNotMatch(prompts[1] ?? "", /\[PLAN-MODE\]/u);

    terminal.emitInput("/quit");
    terminal.emitInput("\r");
    await runPromise;
    assert.equal(turn, 2);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bare /plan arms the next prompt and /build rejects a non-plan task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-plan-guards-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const profiles: Array<"read-only" | "auto" | undefined> = [];
  let turn = 0;
  let store: SQLiteTaskStore | undefined;
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        turn += 1;
        profiles.push(input.approvalProfile);
        yield { type: "turn.started", taskId: input.taskId };
        yield {
          type: "assistant.delta",
          taskId: input.taskId,
          text: turn === 1 ? "plan response" : "normal response",
        };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise: Promise<void> = new TestInteractiveTui({
      appDataRoot: root,
      engine,
      terminal,
    }).run();
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    // Bare /plan arms the next prompt.
    terminal.emitInput("/plan");
    terminal.emitInput("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("draft a plan for the fixture");
    terminal.emitInput("\r");
    store = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    const planTask = await waitForTask(
      store,
      (task) => task.approvalProfile === "read-only",
      "the bare /plan task",
    );
    await waitForValue(
      () => (turn === 1 && store?.get(planTask.taskId)?.state === "completed" ? true : undefined),
      "the bare /plan turn",
    );
    assert.equal(profiles[0], "read-only");

    // A normal (non-plan) task must reject /build.
    terminal.emitInput("/new normal task");
    terminal.emitInput("\r");
    const normalTask = await waitForTask(
      store,
      (task) => task.taskId !== planTask.taskId && task.approvalProfile === "auto",
      "the normal task",
    );
    const normalTaskId = normalTask.taskId;
    await waitForValue(
      () => (turn === 2 && store?.get(normalTaskId)?.state === "completed" ? true : undefined),
      "the normal task turn",
    );
    assert.equal(profiles[1], "auto");
    terminal.emitInput(`/build ${normalTaskId}`);
    terminal.emitInput("\r");
    const rejected = await waitForOutput(
      terminal,
      new RegExp(`task ${normalTaskId} is not a plan task; create one with /plan <prompt>`, "u"),
    );
    assert.match(rejected, /is not a plan task/u);

    terminal.emitInput("/quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("/undo restores the pre-turn state of an isolated worktree task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-undo-"));
  const repository = await createTuiGitFixture(root);
  const terminal: FakeTerminal = new FakeTerminal();
  let turn = 0;
  let store: SQLiteTaskStore | undefined;
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        turn += 1;
        await writeFile(path.join(input.cwd, "turn-one.txt"), turn === 1 ? "v1\n" : "v2\n");
        yield { type: "turn.started", taskId: input.taskId };
        yield {
          type: "assistant.delta",
          taskId: input.taskId,
          text: `turn ${turn} wrote the file`,
        };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise: Promise<void> = new TestInteractiveTui({
      appDataRoot: path.join(root, "app-data"),
      workspacePath: repository,
      engine,
      terminal,
    }).run();
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    terminal.emitInput("/worktree on");
    terminal.emitInput("\r");
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.emitInput("edit the fixture");
    terminal.emitInput("\r");
    store = new SQLiteTaskStore(
      path.join(resolveAppPaths(path.join(root, "app-data")).state, "tasks.sqlite"),
    );
    const task = await waitForTask(
      store,
      (candidate) => candidate.worktreePath !== undefined,
      "the isolated worktree task",
    );
    const taskId = task.taskId;
    const worktreePath = task.worktreePath;
    assert.ok(worktreePath);
    await waitForValue(
      () => (turn === 1 && store?.get(taskId)?.state === "completed" ? true : undefined),
      "the first isolated task turn",
    );
    assert.equal(await readFile(path.join(worktreePath, "turn-one.txt"), "utf8"), "v1\n");
    // The continuation captures the pre-turn state and then mutates it.
    terminal.emitInput("continue the task");
    terminal.emitInput("\r");
    await waitForValue(
      () => (turn === 2 && store?.get(taskId)?.state === "completed" ? true : undefined),
      "the second isolated task turn",
    );
    assert.equal(await readFile(path.join(worktreePath, "turn-one.txt"), "utf8"), "v2\n");
    terminal.emitInput("/undo");
    terminal.emitInput("\r");
    await waitForAsyncValue(
      async () =>
        (await readFile(path.join(worktreePath, "turn-one.txt"), "utf8")) === "v1\n"
          ? true
          : undefined,
      "the restored undo snapshot",
    );
    terminal.emitInput("/quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("/debug runs the bounded Auto Debug loop and completes when the validator passes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-debug-pass-"));
  const terminal: FakeTerminal = new FakeTerminal();
  const prompts: string[] = [];
  let turns = 0;
  let validatorRuns = 0;
  let store: SQLiteTaskStore | undefined;
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        turns += 1;
        prompts.push(input.prompt);
        yield { type: "turn.started", taskId: input.taskId };
        yield {
          type: "assistant.delta",
          taskId: input.taskId,
          text: `debug turn ${turns} applied`,
        };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const validator: TuiValidator = {
      run: async () => {
        validatorRuns += 1;
        return {
          ok: validatorRuns >= 3,
          fingerprint: `fp-${validatorRuns}`,
          evidence: `validator run ${validatorRuns}`,
          durationMs: 1,
        };
      },
    };
    const runPromise: Promise<void> = new TestInteractiveTui({
      appDataRoot: root,
      engine,
      validator,
      terminal,
    }).run();
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    terminal.emitInput("/debug --validator /bin/true -- make the test pass");
    terminal.emitInput("\r");
    store = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    const task = await waitForTask(
      store,
      (candidate) => candidate.taskMode === "debug",
      "the persisted debug task",
    );
    const taskId = task.taskId;
    await waitForValue(
      () =>
        turns === 3 && validatorRuns === 3 && store?.get(taskId)?.state === "completed"
          ? true
          : undefined,
      "the successful Auto Debug loop",
    );
    assert.equal(turns, 3);
    assert.equal(validatorRuns, 3);
    assert.match(prompts[0] ?? "", /\[AUTO-DEBUG\]/u);
    assert.match(prompts[1] ?? "", /\[VERIFIER FAILED\][\s\S]*validator run 1/u);
    assert.match(prompts[2] ?? "", /\[VERIFIER FAILED\][\s\S]*validator run 2/u);
    const run = store.getRun(taskId);
    assert.ok(run);
    assert.equal(run.completed, true);
    assert.equal(run.stopReason, "validator_succeeded");
    assert.equal(run.rounds, 3);
    terminal.emitInput("/quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("/debug stops on stalled validator evidence and leaves the task interrupted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-debug-stall-"));
  const terminal: FakeTerminal = new FakeTerminal();
  let validatorRuns = 0;
  let store: SQLiteTaskStore | undefined;
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        yield { type: "turn.started", taskId: input.taskId };
        yield {
          type: "assistant.delta",
          taskId: input.taskId,
          text: "stall turn response",
        };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const validator: TuiValidator = {
      run: async () => {
        validatorRuns += 1;
        return {
          ok: false,
          fingerprint: "same-fingerprint",
          evidence: "same evidence every round",
          durationMs: 1,
        };
      },
    };
    const runPromise: Promise<void> = new TestInteractiveTui({
      appDataRoot: root,
      engine,
      validator,
      terminal,
    }).run();
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    terminal.emitInput("/debug --validator /bin/true -- keep failing");
    terminal.emitInput("\r");
    store = new SQLiteTaskStore(path.join(resolveAppPaths(root).state, "tasks.sqlite"));
    const task = await waitForTask(
      store,
      (candidate) => candidate.taskMode === "debug",
      "the stalled debug task",
    );
    const taskId = task.taskId;
    await waitForValue(
      () => (validatorRuns === 3 && store?.get(taskId)?.state === "interrupted" ? true : undefined),
      "the stalled Auto Debug loop",
    );
    const run = store.getRun(taskId);
    assert.ok(run);
    assert.equal(run.stopReason, "stall_detected");
    assert.equal(run.rounds, 3);
    assert.equal(validatorRuns, 3);
    terminal.emitInput("/quit");
    terminal.emitInput("\r");
    await runPromise;
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
