import assert from "node:assert/strict";
import test from "node:test";
import { SQLiteTaskStore } from "@candy/platform";
import {
  DEFAULT_GOAL_NO_PROGRESS_LIMIT,
  GoalBlockedClaimLedger,
  GoalContinuationRunner,
  GoalControlError,
  IDLE_GOAL_SIGNALS,
  buildGoalContinuationPrompt,
  buildGoalWrapUpPrompt,
  listGoalToolDefinitions,
  type GoalContinuationPrompt,
  type GoalContinuationSignals,
  type GoalPromptUsage,
  type GoalRunResult,
} from "./index.js";
import {
  GOAL_AUDIT_RULES_FIXTURE,
  GOAL_AUDIT_SCENARIOS,
  goalAuditRuleText,
  type GoalAuditScenario,
  type GoalAuditSurface,
} from "./goal-audit-fixture.js";

const TASK_ID = "task-goal-audit";

const SAMPLE_USAGE: GoalPromptUsage = {
  turn: 1,
  turnsUsed: 0,
  turnBudget: 4,
  remainingTurns: 4,
  wallClockMs: 0,
  wallClockBudgetMs: 600_000,
  remainingWallClockMs: 600_000,
  nearBudget: false,
  noProgressStreak: 0,
  noProgressLimit: 3,
};

function surfaceText(surface: GoalAuditSurface): string {
  switch (surface) {
    case "continuation_prompt":
      return buildGoalContinuationPrompt({ objective: "Fixture objective.", usage: SAMPLE_USAGE })
        .text;
    case "continuation_prompt_near_budget":
      return buildGoalContinuationPrompt({
        objective: "Fixture objective.",
        usage: { ...SAMPLE_USAGE, nearBudget: true },
      }).text;
    case "wrap_up_prompt":
      return buildGoalWrapUpPrompt({
        objective: "Fixture objective.",
        usage: { ...SAMPLE_USAGE, nearBudget: true },
      }).text;
    default:
      return listGoalToolDefinitions()
        .map((definition) =>
          [definition.description, definition.promptSnippet, ...definition.promptGuidelines].join(
            "\n",
          ),
        )
        .join("\n");
  }
}

test("every audit fixture rule is present on each surface it claims", () => {
  for (const fixture of GOAL_AUDIT_RULES_FIXTURE) {
    const rule = goalAuditRuleText(fixture);
    assert.ok(rule.length > 20, `${fixture.id} resolved to a stub rule`);
    for (const surface of fixture.requiredSurfaces) {
      const text = surfaceText(surface);
      if (surface === "goal_tools") {
        assert.ok(
          fixture.toolAnchors !== undefined && fixture.toolAnchors.length > 0,
          `${fixture.id} claims the tool surface without anchors`,
        );
        for (const anchor of fixture.toolAnchors ?? [])
          assert.ok(
            text.toLowerCase().includes(anchor.toLowerCase()),
            `${fixture.id} anchor "${anchor}" missing from ${surface}`,
          );
        continue;
      }
      assert.ok(text.includes(rule), `${fixture.id} rule missing from ${surface}`);
    }
  }
});

test("the audit fixture covers completion, blocked, behavior, convergence, and wrap-up rules", () => {
  const contracts = new Set(GOAL_AUDIT_RULES_FIXTURE.map((fixture) => fixture.contract));
  assert.deepEqual([...contracts].sort(), [
    "behavior",
    "blocked",
    "completion",
    "convergence",
    "wrap_up",
  ]);
  const ids = GOAL_AUDIT_RULES_FIXTURE.map((fixture) => fixture.id);
  assert.equal(new Set(ids).size, ids.length);
});

interface ScenarioRun {
  readonly result: GoalRunResult;
  readonly messages: readonly GoalContinuationPrompt[];
  readonly wrapUpTurns: number;
  readonly goalStatus: string;
  readonly persistedNoProgress: number;
  readonly recordedStopReason: string | undefined;
}

async function runScenario(scenario: GoalAuditScenario): Promise<ScenarioRun> {
  const store = new SQLiteTaskStore(":memory:");
  const now = { value: 0 };
  const clock = { now: () => now.value };
  store.create(
    TASK_ID,
    "auto",
    undefined,
    undefined,
    [],
    "/tmp/candy-goal-audit",
    undefined,
    undefined,
    undefined,
    false,
    "audit scenario",
    "goal",
  );
  const created = store.get(TASK_ID);
  assert.ok(created);
  store.setGoal(TASK_ID, created.revision, scenario.goal);
  const claims = new GoalBlockedClaimLedger();
  const signals: GoalContinuationSignals = { ...IDLE_GOAL_SIGNALS, ...scenario.signals };
  const messages: GoalContinuationPrompt[] = [];
  let wrapUpTurns = 0;
  let index = 0;
  const runner = new GoalContinuationRunner({
    taskId: TASK_ID,
    store,
    clock,
    signals: () => signals,
    claims,
    noProgressLimit: scenario.noProgressLimit ?? DEFAULT_GOAL_NO_PROGRESS_LIMIT,
  });
  const result = await runner.run(
    async (context) => {
      const scripted = scenario.turns[index];
      index += 1;
      if (scripted === undefined)
        throw new Error(`scenario ${scenario.id} ran out of scripted turns`);
      messages.push(context.message);
      if (context.phase === "wrap_up") wrapUpTurns += 1;
      if (scripted.failWith !== undefined)
        throw new GoalControlError(scripted.failWith.stopReason, "scripted scenario stop");
      if (scripted.blockedClaim !== undefined) claims.record(scripted.blockedClaim);
      if (scripted.completeClaim === true) {
        const goal = store.getGoal(TASK_ID);
        const current = store.get(TASK_ID);
        assert.ok(goal && current);
        store.updateGoalStatus(TASK_ID, current.revision, "complete", {
          expectedGoalId: goal.goalId,
        });
      }
      now.value += 1_000;
      return {
        toolActivations: scripted.toolActivations,
        ...(scripted.workspaceFingerprint === undefined
          ? {}
          : { workspaceFingerprint: scripted.workspaceFingerprint }),
      };
    },
    new AbortController().signal,
    { store: { record: (progress) => store.recordGoalRun(progress) } },
  );
  const run: ScenarioRun = {
    result,
    messages,
    wrapUpTurns,
    goalStatus: store.getGoal(TASK_ID)?.status ?? "none",
    persistedNoProgress: store.getGoal(TASK_ID)?.consecutiveNoProgress ?? 0,
    recordedStopReason: store.getGoalRun(TASK_ID)?.stopReason,
  };
  store.close();
  return run;
}

test("the audit fixture scenarios hold against the real goal state machine", async () => {
  assert.ok(GOAL_AUDIT_SCENARIOS.length >= 6);
  for (const scenario of GOAL_AUDIT_SCENARIOS) {
    const run = await runScenario(scenario);
    const expected = scenario.expected;
    assert.equal(run.result.stopReason, expected.stopReason, `${scenario.id} stop reason`);
    assert.equal(run.result.completed, expected.completed, `${scenario.id} completed flag`);
    assert.equal(run.result.rounds, expected.rounds, `${scenario.id} rounds`);
    assert.equal(run.goalStatus, expected.goalStatus, `${scenario.id} goal status`);
    assert.equal(
      run.recordedStopReason,
      expected.stopReason,
      `${scenario.id} recorded stop reason`,
    );
    if (expected.yieldedTo !== undefined)
      assert.equal(run.result.yieldedTo, expected.yieldedTo, `${scenario.id} yield reason`);
    if (expected.failureCategory !== undefined)
      assert.equal(run.result.failureCategory, expected.failureCategory, `${scenario.id} category`);
    if (expected.wrapUpTurns !== undefined)
      assert.equal(run.wrapUpTurns, expected.wrapUpTurns, `${scenario.id} wrap-up turns`);
    if (expected.persistedNoProgress !== undefined)
      assert.equal(
        run.persistedNoProgress,
        expected.persistedNoProgress,
        `${scenario.id} persisted no-progress`,
      );
    if (expected.noProgressNoticeFromTurn !== undefined) {
      const noticed = run.messages.find((message) =>
        message.text.includes("consecutive goal turns changed nothing"),
      );
      assert.ok(noticed, `${scenario.id} expected a no-progress notice`);
      assert.equal(noticed.usage.turn, expected.noProgressNoticeFromTurn);
    }
  }
});
