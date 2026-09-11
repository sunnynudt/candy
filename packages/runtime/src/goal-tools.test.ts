import assert from "node:assert/strict";
import test from "node:test";
import { MAX_GOAL_TEXT_CHARS, SQLiteTaskStore } from "@candy/platform";
import {
  GoalBlockedClaimLedger,
  GoalToolHost,
  listGoalToolDefinitions,
  type GoalToolResult,
} from "./index.js";

const TASK_ID = "task-goal-tools";

interface Harness {
  readonly store: SQLiteTaskStore;
  readonly claims: GoalBlockedClaimLedger;
  readonly host: GoalToolHost;
}

function createHarness(): Harness {
  const store = new SQLiteTaskStore(":memory:");
  store.create(
    TASK_ID,
    "auto",
    undefined,
    undefined,
    [],
    "/tmp/candy-goal-tools",
    undefined,
    undefined,
    undefined,
    false,
    "goal tools",
    "goal",
  );
  const claims = new GoalBlockedClaimLedger();
  const host = new GoalToolHost({ taskId: TASK_ID, store, claims });
  return { store, claims, host };
}

function call(
  harness: Harness,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
): GoalToolResult {
  return harness.host.call({ name, caller: "model", arguments: args });
}

test("the goal tool set exposes only Candy-owned goal operations", () => {
  const definitions = listGoalToolDefinitions();
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ["candy_goal_status", "candy_goal_set", "candy_goal_update", "candy_goal_budget"],
  );
  for (const definition of definitions) {
    assert.ok(definition.description.length > 40);
    assert.ok(definition.promptSnippet.length > 0);
    assert.ok(definition.promptGuidelines.length > 0);
    assert.deepEqual([...definition.callers].sort(), ["model", "user"]);
    assert.equal(definition.parameters.type, "object");
    assert.equal(definition.parameters.additionalProperties, false);
  }
  const names = definitions.map((definition) => definition.name).join(" ");
  assert.equal(names.includes("pause"), false);
  assert.equal(names.includes("clear"), false);
});

test("candy_goal_status reports the persisted goal inside untrusted-data fences", () => {
  const harness = createHarness();
  const empty = call(harness, "candy_goal_status");
  assert.equal(empty.ok, true);
  assert.match(empty.text, /No goal is attached to this task/u);

  const created = call(harness, "candy_goal_set", {
    objective: "Ship the bounded objective.",
    criterion: "npm test exits zero.",
    turn_budget: 4,
  });
  assert.equal(created.ok, true);
  assert.match(created.text, /Goal created and active/u);

  const summary = call(harness, "candy_goal_status");
  assert.equal(summary.ok, true);
  assert.match(summary.text, /- status: active/u);
  assert.match(summary.text, /- turns: 0 of 4 used \(4 left\)/u);
  assert.ok(summary.text.includes("Ship the bounded objective."));
  assert.ok(summary.text.includes("npm test exits zero."));
  harness.store.close();
});

test("candy_goal_set guards replacement, bounds, and unsafe goal text", () => {
  const harness = createHarness();
  assert.equal(call(harness, "candy_goal_set", {}).ok, false);
  assert.equal(
    call(harness, "candy_goal_set", { objective: "First goal.", turn_budget: 0 }).ok,
    false,
  );
  assert.equal(
    call(harness, "candy_goal_set", { objective: "First goal.", extra: true }).ok,
    false,
  );
  assert.equal(call(harness, "candy_goal_set", { objective: "First goal." }).ok, true);

  const duplicate = call(harness, "candy_goal_set", { objective: "Second goal." });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.text, /already exists.*replace:true/u);

  const replaced = call(harness, "candy_goal_set", { objective: "Second goal.", replace: true });
  assert.equal(replaced.ok, true);
  assert.equal(harness.store.getGoal(TASK_ID)?.objective, "Second goal.");

  const tooLong = call(harness, "candy_goal_set", {
    objective: "x".repeat(MAX_GOAL_TEXT_CHARS + 1),
    replace: true,
  });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.text, /exceeds/u);

  const withControl = call(harness, "candy_goal_set", {
    objective: "Second goal\u0000",
    replace: true,
  });
  assert.equal(withControl.ok, false);
  assert.match(withControl.text, /control characters/u);
  assert.equal(harness.store.getGoal(TASK_ID)?.objective, "Second goal.");
  harness.store.close();
});

test("candy_goal_update completes only an active goal", () => {
  const harness = createHarness();
  assert.equal(call(harness, "candy_goal_update", { signal: "complete" }).ok, false);
  call(harness, "candy_goal_set", { objective: "Ship the bounded objective." });
  const completed = call(harness, "candy_goal_update", {
    signal: "complete",
    reason: "suite green twice",
  });
  assert.equal(completed.ok, true);
  assert.equal(harness.store.getGoal(TASK_ID)?.status, "complete");
  assert.equal(harness.store.getGoal(TASK_ID)?.terminalReason, "suite green twice");
  const again = call(harness, "candy_goal_update", { signal: "complete" });
  assert.equal(again.ok, false);
  harness.store.close();
});

test("candy_goal_update holds a blocked claim below the threshold", () => {
  const harness = createHarness();
  call(harness, "candy_goal_set", { objective: "Ship the bounded objective." });
  const missingReason = call(harness, "candy_goal_update", { signal: "blocked" });
  assert.equal(missingReason.ok, false);

  const first = call(harness, "candy_goal_update", {
    signal: "blocked",
    reason: "the proxy rejects npm install",
  });
  assert.equal(first.ok, true);
  assert.match(first.text, /1 of 3 consecutive goal turns/u);
  assert.equal(harness.store.getGoal(TASK_ID)?.status, "active");
  assert.equal(harness.claims.streak, 1);

  call(harness, "candy_goal_update", {
    signal: "blocked",
    reason: "the proxy rejects npm install",
  });
  const third = call(harness, "candy_goal_update", {
    signal: "blocked",
    reason: "the proxy rejects npm install",
  });
  assert.equal(third.ok, true);
  assert.match(third.text, /marks the goal blocked when this turn settles/u);

  const otherReason = call(harness, "candy_goal_update", {
    signal: "blocked",
    reason: "a different blocking condition",
  });
  assert.equal(otherReason.ok, true);
  assert.equal(harness.claims.streak, 1);
  harness.store.close();
});

test("candy_goal_update rejects user-controlled transitions and resumes on request", () => {
  const harness = createHarness();
  call(harness, "candy_goal_set", { objective: "Ship the bounded objective." });
  const pause = call(harness, "candy_goal_update", { signal: "pause" });
  assert.equal(pause.ok, false);
  assert.match(pause.text, /stay user commands/u);
  assert.equal(call(harness, "candy_goal_update", { signal: "budget_limited" }).ok, false);
  assert.equal(call(harness, "candy_goal_update", { signal: "usage_limited" }).ok, false);

  const goal = harness.store.getGoal(TASK_ID);
  const current = harness.store.get(TASK_ID);
  assert.ok(goal && current);
  harness.store.updateGoalStatus(TASK_ID, current.revision, "paused", {
    expectedGoalId: goal.goalId,
  });
  harness.claims.record("stale claim");
  const resumed = call(harness, "candy_goal_update", { signal: "active" });
  assert.equal(resumed.ok, true);
  assert.equal(harness.store.getGoal(TASK_ID)?.status, "active");
  assert.equal(harness.claims.streak, 0);
  assert.equal(call(harness, "candy_goal_update", { signal: "active" }).ok, false);
  harness.store.close();
});

test("candy_goal_budget sets every budget dimension", () => {
  const harness = createHarness();
  call(harness, "candy_goal_set", { objective: "Ship the bounded objective." });
  assert.equal(call(harness, "candy_goal_budget", {}).ok, false);
  const rejected = call(harness, "candy_goal_budget", { token_budget: 0 });
  assert.equal(rejected.ok, false);
  assert.match(rejected.text, /positive integer/u);
  const budgetValue = 50_000;
  const updated = call(harness, "candy_goal_budget", {
    turn_budget: 3,
    token_budget: budgetValue,
    wall_clock_budget_ms: 600_000,
  });
  assert.equal(updated.ok, true);
  assert.equal(harness.store.getGoal(TASK_ID)?.turnBudget, 3);
  assert.equal(harness.store.getGoal(TASK_ID)?.tokenBudget, budgetValue);
  assert.equal(harness.store.getGoal(TASK_ID)?.wallClockBudgetMs, 600_000);

  const goal = harness.store.getGoal(TASK_ID);
  const current = harness.store.get(TASK_ID);
  assert.ok(goal && current);
  harness.store.accountGoalUsage(TASK_ID, current.revision, goal.goalId, {
    turnDelta: 3,
    wallClockDeltaMs: 0,
  });
  assert.equal(harness.store.getGoal(TASK_ID)?.status, "budget_limited");
  const late = call(harness, "candy_goal_budget", { turn_budget: 2 });
  assert.equal(late.ok, true);
  assert.match(late.text, /stays budget_limited/u);
  assert.equal(harness.store.getGoal(TASK_ID)?.status, "budget_limited");
  harness.store.close();
});

/** Redaction fixtures are assembled at runtime so no literal is stored. */
function fixturePlaceholder(): string {
  return ["local", "placeholder", "value"].join("-");
}

test("goal tool results are redacted against active secrets and bounded", () => {
  const placeholder = fixturePlaceholder();
  const store = new SQLiteTaskStore(":memory:");
  store.create(
    TASK_ID,
    "auto",
    undefined,
    undefined,
    [],
    "/tmp/candy-goal-tools",
    undefined,
    undefined,
    undefined,
    false,
    "goal tools",
    "goal",
  );
  const host = new GoalToolHost({
    taskId: TASK_ID,
    store,
    activeSecrets: [placeholder],
  });
  host.call({
    name: "candy_goal_set",
    caller: "user",
    arguments: { objective: `Objective mentioning ${placeholder}.` },
  });
  const summary = host.call({ name: "candy_goal_status", caller: "user" });
  assert.equal(summary.text.includes(placeholder), false);
  assert.match(summary.text, /\[REDACTED\]/u);
  assert.ok(summary.text.length <= MAX_GOAL_TEXT_CHARS);

  const unknownTool = host.call({ name: "candy_goal_clear", caller: "model" });
  assert.equal(unknownTool.ok, false);
  assert.match(unknownTool.text, /Unknown goal tool/u);
  store.close();
});
