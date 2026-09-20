import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAppPaths, SQLiteTaskStore, type TaskMetadata } from "@candy/platform";
import { GoalToolHost } from "@candy/runtime";
import type { CandyGoalToolBridge } from "@candy/pi-adapter/goal-tools";
import { InteractiveTui, type TuiAgentEngine } from "./main.js";
import { FakeTerminal } from "./pi-tui-surface.js";

/** TUI with the explicit test workspace path used by the goal fixtures. */
class TestInteractiveTui extends InteractiveTui {
  public constructor(options: ConstructorParameters<typeof InteractiveTui>[0] = {}) {
    super(options);
  }
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

async function waitForOutput(
  terminal: FakeTerminal,
  pattern: RegExp,
  maxAttempts: number = 800,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const output = terminal.writes.join("");
    if (pattern.test(output)) return output;
    await sleep(1);
  }
  return terminal.writes.join("");
}

function taskStore(appDataRoot: string): SQLiteTaskStore {
  return new SQLiteTaskStore(path.join(resolveAppPaths(appDataRoot).state, "tasks.sqlite"));
}

/** Poll the durable task store instead of scraping the rendered transcript. */
async function waitForTask(
  appDataRoot: string,
  predicate: (task: TaskMetadata) => boolean,
  maxAttempts: number = 800,
): Promise<TaskMetadata | undefined> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const store = taskStore(appDataRoot);
    try {
      const match = store.list().find(predicate);
      if (match !== undefined) return match;
    } finally {
      store.close();
    }
    await sleep(5);
  }
  return undefined;
}

async function goalFixture(root: string): Promise<{ appDataRoot: string; workspace: string }> {
  const appDataRoot = path.join(root, "app-data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return { appDataRoot, workspace };
}

/** Invoke a model-facing goal tool exactly as the Pi session would. */
async function callGoalTool(
  tools: readonly { readonly name: string; readonly execute?: unknown }[] | undefined,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const tool = tools?.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} must be registered for a goal turn`);
  const execute = tool.execute as unknown as (
    id: string,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<{ readonly content: readonly { readonly text: string }[] }>;
  const result = await execute(`call-${name}`, args);
  return result.content[0]?.text ?? "";
}

/** The Pi bridge stays structural: Candy's goal tool host satisfies it as-is. */
test("Candy's goal tool host satisfies the Pi goal tool bridge", () => {
  const store = new SQLiteTaskStore(":memory:");
  store.create("task-bridge", "auto");
  const host = new GoalToolHost({ taskId: "task-bridge", store });
  const bridge: CandyGoalToolBridge = host;
  assert.equal(bridge.definitions.length, 4);
  assert.ok(bridge.definitions.some((definition) => definition.name === "candy_goal_update"));
  store.close();
});

test("/goal creates a Goal Task, continues it automatically, and completes it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-goal-complete-"));
  const { appDataRoot, workspace } = await goalFixture(root);
  const terminal = new FakeTerminal();
  const prompts: string[] = [];
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        prompts.push(input.prompt);
        assert.ok(input.goalTools, "goal turns register Candy's goal tool set");
        if (prompts.length >= 2) {
          // The model signals completion through Candy's goal tool.
          await callGoalTool(input.goalTools, "candy_goal_update", {
            signal: "complete",
            reason: "fixture audit passed",
          });
        }
        yield { type: "turn.started", taskId: input.taskId };
        yield { type: "assistant.delta", taskId: input.taskId, text: "slice done" };
        yield { type: "tool.started", taskId: input.taskId, tool: "candy_read" };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise = new TestInteractiveTui({
      appDataRoot,
      workspacePath: workspace,
      terminal,
      engine,
    }).run();
    await sleep(50);
    terminal.emitInput(":goal Make the fixture pass --criterion npm test exits zero --turns 4");
    terminal.emitInput("\r");
    const completed = await waitForTask(appDataRoot, (task) => task.state === "completed");
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    assert.ok(completed?.goal);
    assert.equal(completed.taskMode, "goal");
    assert.equal(completed.goal.status, "complete");
    assert.equal(completed.goal.terminalReason, "fixture audit passed");
    assert.equal(completed.goal.objective, "Make the fixture pass");
    assert.equal(completed.goal.completionCriterion, "npm test exits zero");
    assert.equal(completed.goal.turnBudget, 4);
    assert.equal(completed.goal.turnsUsed, 2);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0] ?? "", /\[GOAL\]/u);
    assert.match(prompts[0] ?? "", /Make the fixture pass/u);
    assert.match(prompts[1] ?? "", /Candy Goal continuation/u);
    assert.match(prompts[1] ?? "", /BEGIN CANDY GOAL OBJECTIVE/u);
    assert.match(prompts[1] ?? "", /- Goal turns: 1 of 4 used, 3 left\./u);
    const store = taskStore(appDataRoot);
    const run = store.getGoalRun(completed.taskId);
    assert.equal(run?.stopReason, "complete");
    // `rounds` counts policy-driven continuation turns; the starting user turn
    // is visible through `goal.turnsUsed` (2) and the accounting above.
    assert.equal(run?.rounds, 1);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exhausted goal budget wraps up once and leaves the task paused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-goal-budget-"));
  const { appDataRoot, workspace } = await goalFixture(root);
  const terminal = new FakeTerminal();
  const prompts: string[] = [];
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        prompts.push(input.prompt);
        assert.ok(input.goalTools, "the wrap-up turn still carries the goal tools");
        yield { type: "turn.started", taskId: input.taskId };
        yield { type: "tool.started", taskId: input.taskId, tool: "candy_edit" };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise = new TestInteractiveTui({
      appDataRoot,
      workspacePath: workspace,
      terminal,
      engine,
    }).run();
    await sleep(50);
    terminal.emitInput(":goal Fix the failing suite --turns 1");
    terminal.emitInput("\r");
    const paused = await waitForTask(
      appDataRoot,
      (task) => task.goal?.status === "budget_limited" && task.state === "paused",
    );
    const output = await waitForOutput(terminal, /goal budget exhausted/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    assert.ok(paused?.goal);
    // One counted goal turn plus the single wrap-up turn.
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /Final wrap-up turn/u);
    assert.match(prompts[1] ?? "", /Do not signal complete/u);
    assert.match(output, /paused: goal budget exhausted/u);
    const store = taskStore(appDataRoot);
    assert.equal(store.getGoalRun(paused.taskId)?.stopReason, "budget_limited");
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/goal pause stops the continuation and shows the paused goal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-goal-pause-"));
  const { appDataRoot, workspace } = await goalFixture(root);
  const terminal = new FakeTerminal();
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        yield { type: "turn.started", taskId: input.taskId };
        await sleep(200);
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise = new TestInteractiveTui({
      appDataRoot,
      workspacePath: workspace,
      terminal,
      engine,
    }).run();
    await sleep(50);
    terminal.emitInput(":goal Keep the fixture green --turns 5");
    terminal.emitInput("\r");
    const running = await waitForTask(
      appDataRoot,
      (task) => task.goal !== undefined && task.state === "running",
    );
    assert.ok(running?.goal);
    terminal.emitInput(":goal pause");
    terminal.emitInput("\r");
    const paused = await waitForTask(
      appDataRoot,
      (task) => task.goal?.status === "paused" && task.state === "paused",
    );
    terminal.emitInput(":goal");
    terminal.emitInput("\r");
    const summary = await waitForOutput(terminal, /state: paused/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    assert.ok(paused?.goal);
    assert.match(summary, /objective: Keep the fixture green/u);
    assert.match(summary, /turns: 0 of 5/u);
    assert.match(summary, /recovery: \/goal resume/u);
    const store = taskStore(appDataRoot);
    assert.equal(store.getGoalRun(paused.taskId)?.stopReason, "paused");
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/goal edit prefills the current goal command and re-opens it on submit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-goal-edit-"));
  const { appDataRoot, workspace } = await goalFixture(root);
  const terminal = new FakeTerminal();
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        yield { type: "turn.started", taskId: input.taskId };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise = new TestInteractiveTui({
      appDataRoot,
      workspacePath: workspace,
      terminal,
      engine,
    }).run();
    await sleep(50);
    terminal.emitInput(":goal Keep the fixture green --criterion npm test exits zero --turns 5");
    terminal.emitInput("\r");
    const created = await waitForTask(appDataRoot, (task) => task.goal !== undefined);
    assert.ok(created?.goal, "the fixture creates a goal");
    terminal.emitInput(":goal pause");
    terminal.emitInput("\r");
    await waitForTask(appDataRoot, (task) => task.goal?.status === "paused");

    terminal.emitInput(":goal edit");
    terminal.emitInput("\r");
    const prefilled = await waitForOutput(terminal, /goal edit: adjust the objective/u);
    // The prefilled line carries the objective and the current budgets, because
    // `/goal` reads an omitted budget as "no budget".
    assert.match(
      prefilled,
      /\/goal replace Keep the fixture green --criterion npm test exits zero --turns 5/u,
    );
    assert.doesNotMatch(prefilled, /goal edit: warning/u);

    // Submitting the prefilled command re-opens the goal through the same
    // validated `/goal replace` path. The task store is the reliable source of
    // truth here: the transcript scrolls a fast goal run past the message.
    terminal.emitInput("\r");
    const updated = await waitForTask(
      appDataRoot,
      (task) => task.goal !== undefined && task.goal.goalId !== created.goal?.goalId,
    );
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    assert.ok(updated?.goal, "submitting the prefilled command replaces the goal");
    assert.equal(updated.goal.objective, "Keep the fixture green");
    assert.equal(updated.goal.completionCriterion, "npm test exits zero");
    assert.equal(updated.goal.turnBudget, 5);
    assert.equal(updated.goal.status, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/goal edit warns when the goal text cannot round-trip through /goal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-goal-edit-warning-"));
  const { appDataRoot, workspace } = await goalFixture(root);
  const terminal = new FakeTerminal();
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        yield { type: "turn.started", taskId: input.taskId };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise = new TestInteractiveTui({
      appDataRoot,
      workspacePath: workspace,
      terminal,
      engine,
    }).run();
    await sleep(50);
    terminal.emitInput(":goal Keep the fixture green");
    terminal.emitInput("\r");
    const created = await waitForTask(appDataRoot, (task) => task.goal !== undefined);
    assert.ok(created?.goal, "the fixture creates a goal");
    terminal.emitInput(":goal pause");
    terminal.emitInput("\r");
    await waitForTask(appDataRoot, (task) => task.goal?.status === "paused");
    // A goal text authored outside the TUI (for example by the WebUI) can hold
    // tokens the `/goal` reader treats as options, and a wall-clock budget that
    // `--minutes` cannot express.
    const store = taskStore(appDataRoot);
    const current = store.get(created.taskId);
    assert.ok(current, "the goal task is persisted");
    store.setGoal(current.taskId, current.revision, {
      objective: "Keep --turns stable",
      wallClockBudgetMs: 90_000,
      replace: true,
    });
    store.close();

    terminal.emitInput(":goal edit");
    terminal.emitInput("\r");
    const output = await waitForOutput(terminal, /goal edit: warning/u);
    assert.match(output, /\/goal replace Keep --turns stable/u);
    assert.match(output, /--turns inside the goal text is read as a \/goal option/u);
    assert.match(output, /the wall-clock budget \(90000ms\) is not a whole number/u);

    // Submitting the warned-about text shows why the warning exists: the reader
    // rejects the stray option instead of silently cutting the objective.
    terminal.emitInput("\r");
    const rejected = await waitForOutput(terminal, /usage: \/goal \[/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    assert.match(rejected, /usage: \/goal \[/u);
    const after = taskStore(appDataRoot);
    assert.equal(after.get(created.taskId)?.goal?.objective, "Keep --turns stable");
    after.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queued user input wins the next goal turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-goal-yield-"));
  const { appDataRoot, workspace } = await goalFixture(root);
  const terminal = new FakeTerminal();
  const prompts: string[] = [];
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        prompts.push(input.prompt);
        yield { type: "turn.started", taskId: input.taskId };
        await sleep(200);
        yield { type: "turn.completed", taskId: input.taskId };
      },
      async followUp() {},
    };
    const runPromise = new TestInteractiveTui({
      appDataRoot,
      workspacePath: workspace,
      terminal,
      engine,
    }).run();
    await sleep(50);
    terminal.emitInput(":goal Keep the fixture green --turns 5");
    terminal.emitInput("\r");
    const running = await waitForTask(
      appDataRoot,
      (task) => task.goal !== undefined && task.state === "running",
    );
    assert.ok(running?.goal);
    terminal.emitInput("please check the logs first");
    terminal.emitInput("\r");
    await waitForOutput(terminal, /queued/u);
    const paused = await waitForTask(appDataRoot, (task) => task.state === "paused");
    const output = await waitForOutput(terminal, /yielded to your queued input/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    assert.ok(paused?.goal);
    // Only the starting user turn ran; the goal yielded instead of continuing.
    assert.equal(prompts.length, 1);
    assert.equal(paused.goal.status, "active");
    assert.match(output, /paused: goal continuation yielded/u);
    const store = taskStore(appDataRoot);
    assert.equal(store.getGoalRun(paused.taskId)?.stopReason, "user_stop");
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/goal replace resets the goal and /goal clear drops it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-goal-replace-"));
  const { appDataRoot, workspace } = await goalFixture(root);
  const terminal = new FakeTerminal();
  const prompts: string[] = [];
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        prompts.push(input.prompt);
        yield { type: "turn.started", taskId: input.taskId };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise = new TestInteractiveTui({
      appDataRoot,
      workspacePath: workspace,
      terminal,
      engine,
    }).run();
    await sleep(50);
    terminal.emitInput(":goal First objective --turns 1");
    terminal.emitInput("\r");
    const first = await waitForTask(appDataRoot, (task) => task.goal?.status === "budget_limited");
    assert.ok(first?.goal);
    terminal.emitInput(":goal replace Second objective --turns 8");
    terminal.emitInput("\r");
    const replaced = await waitForTask(
      appDataRoot,
      (task) => task.goal?.objective === "Second objective",
    );
    assert.ok(replaced?.goal);
    assert.equal(replaced.goal.status, "active");
    assert.equal(replaced.goal.turnBudget, 8);
    assert.equal(replaced.goal.turnsUsed, 0);
    assert.equal(replaced.goal.goalId === first.goal.goalId, false);
    terminal.emitInput(":goal clear");
    terminal.emitInput("\r");
    const cleared = await waitForTask(appDataRoot, (task) => task.goal === undefined);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    assert.ok(cleared);
    assert.equal(cleared.taskMode, "goal");
    // The replace started one continuation turn for the replacement goal.
    assert.ok(prompts.length >= 2);
    const store = taskStore(appDataRoot);
    assert.equal(store.getGoal(cleared.taskId), undefined);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repeated blocked claim blocks the goal and pauses the task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-goal-blocked-"));
  const { appDataRoot, workspace } = await goalFixture(root);
  const terminal = new FakeTerminal();
  const toolTexts: string[] = [];
  try {
    const engine: TuiAgentEngine = {
      async *runTurn(input) {
        const text = await callGoalTool(input.goalTools, "candy_goal_update", {
          signal: "blocked",
          reason: "the proxy rejects npm install",
        });
        toolTexts.push(text);
        yield { type: "turn.started", taskId: input.taskId };
        yield { type: "turn.completed", taskId: input.taskId };
      },
    };
    const runPromise = new TestInteractiveTui({
      appDataRoot,
      workspacePath: workspace,
      terminal,
      engine,
    }).run();
    await sleep(50);
    terminal.emitInput(":goal Make the proxy install work --turns 6");
    terminal.emitInput("\r");
    const blocked = await waitForTask(appDataRoot, (task) => task.goal?.status === "blocked");
    const output = await waitForOutput(terminal, /goal blocked after/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    assert.ok(blocked?.goal);
    assert.equal(blocked.state, "paused");
    assert.equal(blocked.goal.terminalReason, "the proxy rejects npm install");
    // The starting user turn counts toward the blocked audit, so three claims
    // (starting turn + two continuations) confirm the block, per §7.3.
    assert.equal(blocked.goal.turnsUsed, 3);
    assert.equal(toolTexts.length, 3);
    assert.match(toolTexts[0] ?? "", /1 of 3 consecutive goal turns/u);
    assert.match(toolTexts[1] ?? "", /2 of 3 consecutive goal turns/u);
    assert.match(toolTexts[2] ?? "", /marks the goal blocked when this turn settles/u);
    assert.match(output, /paused: goal blocked after 2 goal turn/u);
    const store = taskStore(appDataRoot);
    const run = store.getGoalRun(blocked.taskId);
    assert.equal(run?.stopReason, "blocked");
    assert.equal(run?.rounds, 2);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/goal rejects unsafe goal text and reports usage without a task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "candy-tui-goal-reject-"));
  const { appDataRoot, workspace } = await goalFixture(root);
  const terminal = new FakeTerminal();
  try {
    const runPromise = new TestInteractiveTui({
      appDataRoot,
      workspacePath: workspace,
      terminal,
      engine: {
        async *runTurn(input) {
          yield { type: "turn.started", taskId: input.taskId };
          yield { type: "turn.completed", taskId: input.taskId };
        },
      },
    }).run();
    await sleep(50);
    terminal.emitInput(":goal");
    terminal.emitInput("\r");
    const empty = await waitForOutput(terminal, /no task selected/u);
    assert.match(empty, /creates a Goal Task/u);
    const oversizedObjective = "x".repeat(4_100);
    terminal.emitInput(`:goal ${oversizedObjective}`);
    terminal.emitInput("\r");
    const oversized = await waitForOutput(terminal, /exceeds 4096 characters/u);
    terminal.emitInput(":goal Fix it --turns 0");
    terminal.emitInput("\r");
    const badBudget = await waitForOutput(terminal, /usage: \/goal/u);
    const credentialShaped = `${"sk"}-${"c".repeat(24)}`;
    terminal.emitInput(`:goal Ship it with ${credentialShaped}`);
    terminal.emitInput("\r");
    await waitForOutput(terminal, /credential-shaped content is forbidden/u);
    terminal.emitInput(":quit");
    terminal.emitInput("\r");
    await runPromise;

    assert.match(oversized, /goal objective rejected/u);
    assert.match(badBudget, /--turns/u);
    const store = taskStore(appDataRoot);
    assert.deepEqual(store.list(), []);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
