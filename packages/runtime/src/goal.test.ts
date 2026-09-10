import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SQLiteTaskStore, type TaskGoalSnapshot } from "@candy/platform";
import {
  CandyRuntime,
  DEFAULT_GOAL_BLOCKED_TURN_LIMIT,
  DEFAULT_GOAL_NO_PROGRESS_LIMIT,
  DeterministicAgentEngine,
  GOAL_CONVERGENCE_RATIO,
  GoalBlockedClaimLedger,
  GoalContinuationRunner,
  GoalControlError,
  IDLE_GOAL_SIGNALS,
  UnavailableBrowserCapability,
  evaluateGoalContinuation,
  goalBudgetState,
  type GoalContinuationSignals,
  type GoalContinuationStore,
  type GoalTurnCallback,
  type GoalTurnContext,
} from "./index.js";

const TASK_ID = "task-goal-policy";

class TestClock {
  #now = 0;

  public now(): number {
    return this.#now;
  }

  public advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}

function goalSnapshot(overrides: Partial<TaskGoalSnapshot> = {}): TaskGoalSnapshot {
  return {
    goalId: "11111111-1111-4111-8111-111111111111",
    objective: "Ship the bounded objective.",
    status: "active",
    turnBudget: null,
    wallClockBudgetMs: null,
    tokenBudget: null,
    turnsUsed: 0,
    wallClockMs: 0,
    tokensUsed: 0,
    continuationDeferred: false,
    consecutiveNoProgress: 0,
    ...overrides,
  };
}

function signals(overrides: Partial<GoalContinuationSignals> = {}): GoalContinuationSignals {
  return { ...IDLE_GOAL_SIGNALS, ...overrides };
}

interface Harness {
  readonly store: SQLiteTaskStore;
  readonly clock: TestClock;
  readonly claims: GoalBlockedClaimLedger;
  readonly runner: GoalContinuationRunner;
  setSignals(next: GoalContinuationSignals): void;
}

function createHarness(options: {
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
  readonly noProgressLimit?: number;
  readonly blockedTurnLimit?: number;
  readonly wrapUpTurn?: boolean;
}): Harness {
  const store = new SQLiteTaskStore(":memory:");
  const clock = new TestClock();
  store.create(
    TASK_ID,
    "auto",
    undefined,
    undefined,
    [],
    "/tmp/candy-goal-workspace",
    undefined,
    undefined,
    undefined,
    false,
    "goal task",
    "goal",
  );
  const created = store.get(TASK_ID);
  assert.ok(created);
  store.setGoal(TASK_ID, created.revision, {
    objective: "Ship the bounded objective.",
    ...(options.turnBudget === undefined ? {} : { turnBudget: options.turnBudget }),
    ...(options.wallClockBudgetMs === undefined
      ? {}
      : { wallClockBudgetMs: options.wallClockBudgetMs }),
  });
  const claims = new GoalBlockedClaimLedger();
  let current = signals();
  const runner = new GoalContinuationRunner({
    taskId: TASK_ID,
    store: store as unknown as GoalContinuationStore,
    clock,
    signals: () => current,
    claims,
    ...(options.noProgressLimit === undefined ? {} : { noProgressLimit: options.noProgressLimit }),
    ...(options.blockedTurnLimit === undefined
      ? {}
      : { blockedTurnLimit: options.blockedTurnLimit }),
    ...(options.wrapUpTurn === undefined ? {} : { wrapUpTurn: options.wrapUpTurn }),
  });
  return {
    store,
    clock,
    claims,
    runner,
    setSignals: (next) => {
      current = next;
    },
  };
}

/** The real platform store satisfies the policy's store seam structurally. */
test("the platform goal store satisfies the runtime continuation store seam", () => {
  const store = new SQLiteTaskStore(":memory:");
  const seam: GoalContinuationStore = store;
  assert.equal(typeof seam.getGoal, "function");
  assert.equal(typeof seam.accountGoalUsage, "function");
  assert.equal(typeof seam.setGoalNoProgress, "function");
  store.close();
});

test("goal budgets expose remaining turns, remaining wall clock, and convergence", () => {
  assert.deepEqual(goalBudgetState(goalSnapshot()), {
    remainingTurns: null,
    remainingWallClockMs: null,
    nearBudget: false,
  });
  assert.deepEqual(goalBudgetState(goalSnapshot({ turnBudget: 10, turnsUsed: 3 })), {
    remainingTurns: 7,
    remainingWallClockMs: null,
    nearBudget: false,
  });
  const near = goalBudgetState(
    goalSnapshot({ wallClockBudgetMs: 1_000, wallClockMs: 800, turnsUsed: 1, turnBudget: 10 }),
  );
  assert.equal(near.nearBudget, true);
  assert.equal(near.remainingWallClockMs, 200);
  const atThreshold = goalBudgetState(
    goalSnapshot({ turnBudget: 4, turnsUsed: Math.ceil(4 * GOAL_CONVERGENCE_RATIO) }),
  );
  assert.equal(atThreshold.nearBudget, true);
  assert.equal(atThreshold.remainingTurns, 1);
});

test("continuation evaluation applies goal lifecycle before idle gates", () => {
  assert.deepEqual(evaluateGoalContinuation(undefined, signals()), {
    continue: false,
    reason: "no_goal",
  });
  assert.deepEqual(evaluateGoalContinuation(goalSnapshot({ status: "paused" }), signals()), {
    continue: false,
    reason: "goal_paused",
  });
  assert.deepEqual(evaluateGoalContinuation(goalSnapshot({ status: "blocked" }), signals()), {
    continue: false,
    reason: "goal_blocked",
  });
  assert.deepEqual(evaluateGoalContinuation(goalSnapshot({ status: "complete" }), signals()), {
    continue: false,
    reason: "goal_complete",
  });
  assert.deepEqual(
    evaluateGoalContinuation(goalSnapshot({ status: "budget_limited" }), signals()),
    { continue: false, reason: "goal_budget_limited" },
  );
  assert.deepEqual(evaluateGoalContinuation(goalSnapshot({ status: "usage_limited" }), signals()), {
    continue: false,
    reason: "goal_usage_limited",
  });
  assert.deepEqual(
    evaluateGoalContinuation(goalSnapshot({ status: "paused" }), signals({ turnActive: true })),
    { continue: false, reason: "goal_paused" },
  );
});

test("continuation evaluation yields to shutdown, ownership, user turns, and approvals", () => {
  const goal = goalSnapshot({ turnBudget: 5 });
  assert.equal(
    continuationReason(evaluateGoalContinuation(goal, signals({ shuttingDown: true }))),
    "shutting_down",
  );
  assert.equal(
    continuationReason(evaluateGoalContinuation(goal, signals({ ownershipHeld: false }))),
    "ownership_lost",
  );
  assert.equal(
    continuationReason(evaluateGoalContinuation(goal, signals({ turnActive: true }))),
    "turn_active",
  );
  assert.equal(
    continuationReason(evaluateGoalContinuation(goal, signals({ pendingApproval: true }))),
    "pending_approval",
  );
  assert.equal(
    continuationReason(evaluateGoalContinuation(goal, signals({ queuedUserInput: true }))),
    "queued_user_input",
  );
  assert.equal(
    continuationReason(evaluateGoalContinuation(goal, signals({ awaitingUserInput: true }))),
    "awaiting_user_input",
  );
  assert.equal(
    continuationReason(
      evaluateGoalContinuation(
        goalSnapshot({ turnBudget: 5, continuationDeferred: true }),
        signals(),
      ),
    ),
    "continuation_deferred",
  );
  assert.equal(
    continuationReason(
      evaluateGoalContinuation(goalSnapshot({ turnBudget: 2, turnsUsed: 2 }), signals()),
    ),
    "budget_exhausted",
  );
  assert.deepEqual(
    evaluateGoalContinuation(goalSnapshot({ turnBudget: 5, turnsUsed: 1 }), signals()),
    {
      continue: true,
      turn: 2,
      remainingTurns: 4,
      remainingWallClockMs: null,
      nearBudget: false,
    },
  );
});

function continuationReason(
  decision: ReturnType<typeof evaluateGoalContinuation>,
): string | undefined {
  return decision.continue ? undefined : decision.reason;
}

test("blocked claims only repeat while the same reason and no progress hold", () => {
  const ledger = new GoalBlockedClaimLedger();
  assert.equal(ledger.record("the proxy rejects npm install"), 1);
  assert.equal(ledger.record("the proxy rejects npm install"), 2);
  assert.equal(ledger.record("the registry is unreachable"), 1);
  assert.equal(ledger.reason, "the registry is unreachable");
  ledger.reset();
  assert.equal(ledger.streak, 0);
  assert.deepEqual(ledger.snapshot(), { turns: 0 });
  assert.throws(() => ledger.record("   "), /needs a reason/u);
});

test("defaults keep the reviewed conservative values", () => {
  assert.equal(DEFAULT_GOAL_NO_PROGRESS_LIMIT, 3);
  assert.equal(DEFAULT_GOAL_BLOCKED_TURN_LIMIT, 3);
  assert.equal(GOAL_CONVERGENCE_RATIO, 0.75);
});

test("the runner accounts the starting user turn in the goal budget", () => {
  const harness = createHarness({ turnBudget: 3 });
  harness.runner.accountUserTurn(1_500);
  const goal = harness.store.getGoal(TASK_ID);
  assert.equal(goal?.turnsUsed, 1);
  assert.equal(goal?.wallClockMs, 1_500);
  assert.equal(harness.runner.evaluate().continue, true);
  harness.store.close();
});

test("the runner stops when a goal turn completes", async () => {
  const harness = createHarness({ turnBudget: 4 });
  const turn: GoalTurnCallback = async (context: GoalTurnContext) => {
    harness.clock.advance(2_000);
    const goal = harness.store.getGoal(TASK_ID);
    assert.ok(goal);
    const current = harness.store.get(TASK_ID);
    assert.ok(current);
    harness.store.updateGoalStatus(TASK_ID, current.revision, "complete", {
      expectedGoalId: goal.goalId,
      reason: "audited",
    });
    assert.equal(context.phase, "continuation");
    assert.equal(context.turn, 1);
    assert.match(context.message.text, /Candy Goal continuation/u);
    return { toolActivations: 2, workspaceFingerprint: "a" };
  };
  const result = await harness.runner.run(turn, new AbortController().signal, {
    store: { record: (progress) => harness.store.recordGoalRun(progress) },
  });
  assert.equal(result.stopReason, "complete");
  assert.equal(result.completed, true);
  assert.equal(result.rounds, 1);
  assert.equal(result.turnsUsed, 1);
  assert.equal(result.wallClockMs, 2_000);
  assert.equal(harness.store.getGoal(TASK_ID)?.status, "complete");
  assert.equal(harness.store.getGoalRun(TASK_ID)?.stopReason, "complete");
  harness.store.close();
});

test("the runner holds a repeated blocked claim until the threshold", async () => {
  const harness = createHarness({ turnBudget: 6 });
  const reasons: string[] = [];
  const turn: GoalTurnCallback = async () => {
    reasons.push("same reason");
    harness.claims.record("same reason");
    return { toolActivations: 0, workspaceFingerprint: "a" };
  };
  const result = await harness.runner.run(turn, new AbortController().signal, {
    store: { record: (progress) => harness.store.recordGoalRun(progress) },
  });
  assert.equal(result.stopReason, "blocked");
  assert.equal(result.rounds, DEFAULT_GOAL_BLOCKED_TURN_LIMIT);
  assert.equal(reasons.length, 3);
  const goal = harness.store.getGoal(TASK_ID);
  assert.equal(goal?.status, "blocked");
  assert.equal(goal?.terminalReason, "same reason");
  assert.equal(harness.store.getGoalRun(TASK_ID)?.stopReason, "blocked");
  harness.store.close();
});

test("observable progress clears a pending blocked claim", async () => {
  const harness = createHarness({ turnBudget: 6, blockedTurnLimit: 2 });
  const turn: GoalTurnCallback = async (context) => {
    if (context.turn === 1) {
      harness.claims.record("registry is unreachable");
      return { toolActivations: 0, workspaceFingerprint: "a" };
    }
    if (context.turn === 2) {
      // The claim recorded in turn 1 is still pending while this turn runs.
      assert.equal(harness.claims.streak, 1);
      return { toolActivations: 1, workspaceFingerprint: "b" };
    }
    if (context.turn === 3) {
      // Turn 2's observable progress cleared the claim before turn 3 started.
      assert.equal(harness.claims.streak, 0);
      const goal = harness.store.getGoal(TASK_ID);
      const current = harness.store.get(TASK_ID);
      assert.ok(goal && current);
      harness.store.updateGoalStatus(TASK_ID, current.revision, "complete", {
        expectedGoalId: goal.goalId,
      });
      return { toolActivations: 1, workspaceFingerprint: "c" };
    }
    throw new Error("unexpected turn");
  };
  const result = await harness.runner.run(turn, new AbortController().signal, undefined);
  assert.equal(result.stopReason, "complete");
  assert.equal(result.rounds, 3);
  harness.store.close();
});

test("the runner counts no-progress turns without pausing the goal", async () => {
  const harness = createHarness({ turnBudget: 4 });
  const turn: GoalTurnCallback = async (context) => {
    const goal = harness.store.getGoal(TASK_ID);
    const current = harness.store.get(TASK_ID);
    assert.ok(goal && current);
    if (context.turn === 4) {
      assert.equal(goal.consecutiveNoProgress, 2);
      harness.store.updateGoalStatus(TASK_ID, current.revision, "complete", {
        expectedGoalId: goal.goalId,
      });
    }
    return { toolActivations: 0, workspaceFingerprint: "a" };
  };
  const result = await harness.runner.run(turn, new AbortController().signal, undefined);
  assert.equal(result.stopReason, "complete");
  assert.equal(result.rounds, 4);
  assert.equal(result.noProgressStreak, 3);
  assert.equal(harness.store.getGoal(TASK_ID)?.consecutiveNoProgress, 3);
  harness.store.close();
});

test("the runner flips budget_limited, runs one wrap-up turn, and never auto-completes", async () => {
  const harness = createHarness({ turnBudget: 2 });
  const phases: string[] = [];
  const turn: GoalTurnCallback = async (context) => {
    phases.push(context.phase);
    if (context.phase === "wrap_up") assert.match(context.message.text, /Final wrap-up turn/u);
    return { toolActivations: 1, workspaceFingerprint: `f${context.turn}` };
  };
  const result = await harness.runner.run(turn, new AbortController().signal, {
    store: { record: (progress) => harness.store.recordGoalRun(progress) },
  });
  assert.equal(result.stopReason, "budget_limited");
  assert.equal(result.completed, false);
  assert.equal(result.rounds, 2);
  assert.deepEqual(phases, ["continuation", "continuation", "wrap_up"]);
  assert.equal(harness.store.getGoal(TASK_ID)?.status, "budget_limited");
  assert.equal(harness.store.getGoalRun(TASK_ID)?.stopReason, "budget_limited");
  harness.store.close();
});

test("the runner stops on the wall-clock budget, not only on turns", async () => {
  const harness = createHarness({ wallClockBudgetMs: 5_000 });
  const turn: GoalTurnCallback = async () => {
    harness.clock.advance(2_500);
    return { toolActivations: 1, workspaceFingerprint: "a" };
  };
  const result = await harness.runner.run(turn, new AbortController().signal, undefined);
  assert.equal(result.stopReason, "budget_limited");
  assert.equal(result.rounds, 2);
  assert.equal(result.wallClockMs, 5_000);
  assert.equal(harness.store.getGoal(TASK_ID)?.status, "budget_limited");
  harness.store.close();
});

test("the runner yields when the user owns the next move", async () => {
  const harness = createHarness({ turnBudget: 4 });
  harness.setSignals(signals({ queuedUserInput: true }));
  const result = await harness.runner.run(
    async () => {
      throw new Error("the runner must not start a turn");
    },
    new AbortController().signal,
    undefined,
  );
  assert.equal(result.stopReason, "user_stop");
  assert.equal(result.yieldedTo, "queued_user_input");
  assert.equal(result.rounds, 0);
  assert.equal(harness.store.getGoal(TASK_ID)?.status, "active");
  harness.store.close();
});

test("the runner pauses the goal on a provider failure and reports a sanitized category", async () => {
  const harness = createHarness({ turnBudget: 4 });
  const result = await harness.runner.run(
    async () => {
      throw new GoalControlError("paused", "provider authentication failed");
    },
    new AbortController().signal,
    undefined,
  );
  assert.equal(result.stopReason, "paused");
  assert.equal(result.failureCategory, "provider_failure");
  assert.equal(result.completed, false);
  const goal = harness.store.getGoal(TASK_ID);
  assert.equal(goal?.status, "paused");
  // A paused goal is resumable, so the platform store keeps no terminal reason;
  // the sanitized category travels on the run result instead.
  assert.equal(goal?.terminalReason, undefined);
  harness.store.close();
});

test("an unexpected error is a runtime error category, and cancellation keeps the goal active", async () => {
  const harness = createHarness({ turnBudget: 4 });
  const failed = await harness.runner.run(
    async () => {
      throw new Error("engine exploded");
    },
    new AbortController().signal,
    undefined,
  );
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.failureCategory, "runtime_error");
  assert.equal(harness.store.getGoal(TASK_ID)?.status, "paused");

  const resumed = harness.store.get(TASK_ID);
  assert.ok(resumed?.goal);
  harness.store.updateGoalStatus(TASK_ID, resumed.revision, "active", {
    expectedGoalId: resumed.goal.goalId,
  });
  const controller = new AbortController();
  controller.abort(new GoalControlError("cancelled"));
  const cancelled = await harness.runner.run(
    async () => ({ toolActivations: 1 }),
    controller.signal,
  );
  assert.equal(cancelled.stopReason, "cancelled");
  assert.equal(harness.store.getGoal(TASK_ID)?.status, "active");
  harness.store.close();
});

test("a goal cleared mid-run stops continuation", async () => {
  const harness = createHarness({ turnBudget: 4 });
  const result = await harness.runner.run(async () => {
    const current = harness.store.get(TASK_ID);
    assert.ok(current);
    harness.store.clearGoal(TASK_ID, current.revision);
    return { toolActivations: 1, workspaceFingerprint: "a" };
  }, new AbortController().signal);
  assert.equal(result.stopReason, "user_stop");
  assert.equal(result.yieldedTo, "no_goal");
  assert.equal(harness.store.getGoal(TASK_ID), undefined);
  harness.store.close();
});

test("the runner requires the task to exist before it can continue a goal", () => {
  const store = new SQLiteTaskStore(":memory:");
  assert.throws(
    () =>
      new GoalContinuationRunner({
        taskId: "task-missing",
        store,
        clock: new TestClock(),
        signals: () => signals(),
      }),
    /metadata is missing/u,
  );
  store.close();
});

test("the policy drives the deterministic runtime engine turn by turn", async () => {
  const harness = createHarness({ turnBudget: 3 });
  const engine = new DeterministicAgentEngine(harness.clock, "slice done");
  const runtime = new CandyRuntime(engine, new UnavailableBrowserCapability());
  const prompts: string[] = [];
  const turn: GoalTurnCallback = async (context) => {
    prompts.push(context.message.text);
    const observations = await runtime.runReadOnlyTurn(
      { taskId: context.taskId, prompt: context.message.text, cwd: "/tmp/candy-goal-workspace" },
      new AbortController().signal,
    );
    assert.deepEqual(
      observations.map((observation) => observation.type),
      ["turn.started", "assistant.delta", "turn.completed"],
    );
    const goal = harness.store.getGoal(TASK_ID);
    const current = harness.store.get(TASK_ID);
    assert.ok(goal && current);
    if (context.turn === 2) {
      harness.store.updateGoalStatus(TASK_ID, current.revision, "complete", {
        expectedGoalId: goal.goalId,
        reason: "deterministic engine reported the audit",
      });
    }
    return { toolActivations: 1, workspaceFingerprint: `slice-${context.turn}` };
  };
  const result = await harness.runner.run(turn, new AbortController().signal, {
    store: { record: (progress) => harness.store.recordGoalRun(progress) },
  });
  assert.equal(result.stopReason, "complete");
  assert.equal(result.rounds, 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /Automatic turn 2/u);
  harness.store.close();
});

test("a restarted goal keeps its usage and continues only on an explicit resume", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-goal-restart-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const first = new SQLiteTaskStore(databasePath);
    first.create(
      TASK_ID,
      "auto",
      undefined,
      undefined,
      [],
      process.cwd(),
      undefined,
      undefined,
      undefined,
      false,
      "goal task",
      "goal",
    );
    const created = first.get(TASK_ID);
    assert.ok(created);
    first.setGoal(TASK_ID, created.revision, { objective: "Survive a restart.", turnBudget: 3 });
    const before = first.get(TASK_ID);
    assert.ok(before);
    new GoalContinuationRunner({
      taskId: TASK_ID,
      store: first,
      clock: new TestClock(),
      signals: () => signals(),
    }).accountUserTurn(1_200);
    first.close();

    const reopened = new SQLiteTaskStore(databasePath);
    const goal = reopened.getGoal(TASK_ID);
    assert.equal(goal?.objective, "Survive a restart.");
    assert.equal(goal?.turnsUsed, 1);
    assert.equal(goal?.wallClockMs, 1_200);
    assert.equal(goal?.status, "active");
    const resumed = new GoalContinuationRunner({
      taskId: TASK_ID,
      store: reopened,
      clock: new TestClock(),
      signals: () => signals(),
    });
    const decision = resumed.evaluate();
    assert.equal(decision.continue, true);
    assert.equal(decision.continue ? decision.turn : undefined, 2);

    // A crash keeps the goal active for an explicit resume; a paused goal does
    // not continue until the user resumes it, and budget_limited needs a new goal.
    assert.ok(goal);
    reopened.updateGoalStatus(TASK_ID, reopened.get(TASK_ID)?.revision ?? 0, "paused", {
      expectedGoalId: goal.goalId,
    });
    assert.equal(resumed.evaluate().continue, false);
    const paused = reopened.get(TASK_ID);
    assert.ok(paused);
    reopened.updateGoalStatus(TASK_ID, paused.revision, "active", { expectedGoalId: goal.goalId });
    assert.equal(resumed.evaluate().continue, true);
    const active = reopened.get(TASK_ID);
    assert.ok(active);
    reopened.updateGoalStatus(TASK_ID, active.revision, "budget_limited", {
      expectedGoalId: goal.goalId,
      reason: "budget exhausted",
    });
    const limited = reopened.get(TASK_ID);
    assert.ok(limited);
    assert.throws(
      () =>
        reopened.updateGoalStatus(TASK_ID, limited.revision, "active", {
          expectedGoalId: goal.goalId,
        }),
      /invalid/iu,
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
