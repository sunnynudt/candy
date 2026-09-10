import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  GoalStateError,
  GOAL_STATUSES,
  SQLiteTaskStore,
  assertGoalTransition,
  type CandyGoalStatus,
} from "./index.js";

function fixtureCredential(kind: "bearer" | "prefix"): string {
  // Construct credential-shaped strings at runtime so the source tree never
  // contains literal credential material.
  return kind === "bearer" ? `Bearer ${"a".repeat(20)}` : `sk-${"b".repeat(20)}`;
}

test("fresh sqlite stores use goal-aware schema 18", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-goal-fresh-schema-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    store.create("task-goal-fresh", "auto");
    store.close();

    const verified = new DatabaseSync(databasePath);
    assert.equal(
      (verified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      18,
    );
    const columns = (
      verified
        .prepare("SELECT name FROM pragma_table_info('task_metadata') WHERE name LIKE 'goal_%'")
        .all() as { name: string }[]
    ).map((column) => column.name);
    assert.deepEqual(columns, [
      "goal_id",
      "goal_objective",
      "goal_criterion",
      "goal_status",
      "goal_token_budget",
      "goal_turn_budget",
      "goal_wall_clock_budget_ms",
      "goal_tokens_used",
      "goal_turns_used",
      "goal_wall_clock_ms",
      "goal_terminal_reason",
      "goal_continuation_deferred",
      "goal_consecutive_no_progress",
    ]);
    const runTable = verified
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_goal_runs'")
      .get() as { name: string } | undefined;
    assert.equal(runTable?.name, "task_goal_runs");
    const freshRow = verified
      .prepare("SELECT goal_status FROM task_metadata WHERE task_id = 'task-goal-fresh'")
      .get() as { goal_status: string };
    assert.equal(freshRow.goal_status, "none");
    verified.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite migrates a v17 store to goal-aware schema 18 without inventing goals", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-goal-migrate-v17-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE task_metadata (
        task_id TEXT PRIMARY KEY NOT NULL,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        approval_profile TEXT NOT NULL,
        queue_order INTEGER,
        owner_id TEXT,
        model_id TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
        attachment_ids TEXT NOT NULL DEFAULT '[]',
        workspace_path TEXT NOT NULL DEFAULT '',
        validator_json TEXT,
        workspace_baseline TEXT,
        worktree_path TEXT,
        trusted_shell INTEGER NOT NULL DEFAULT 0,
        full_access INTEGER NOT NULL DEFAULT 0,
        push_policy TEXT NOT NULL DEFAULT 'deny',
        task_mode TEXT NOT NULL DEFAULT 'build',
        title TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY NOT NULL REFERENCES task_metadata(task_id) ON DELETE CASCADE,
        rounds INTEGER NOT NULL,
        evidence_count INTEGER NOT NULL,
        completed INTEGER NOT NULL,
        stop_reason TEXT NOT NULL,
        last_fingerprint_hash TEXT,
        evidence_summary TEXT
      );
      INSERT INTO task_metadata (
        task_id, revision, state, approval_profile, queue_order, model_id,
        attachment_ids, workspace_path, trusted_shell, full_access, push_policy,
        task_mode, title, created_at, updated_at
      ) VALUES (
        'task-legacy-v17', 3, 'paused', 'read-only', 1, 'deepseek-v4-flash',
        '[]', '/tmp/legacy', 0, 0, 'deny', 'debug', 'legacy task', 1, 2
      );
      PRAGMA user_version = 17;
    `);
    raw.close();

    const store = new SQLiteTaskStore(databasePath);
    const legacy = store.get("task-legacy-v17");
    assert.equal(legacy?.revision, 3);
    assert.equal(legacy?.state, "paused");
    assert.equal(legacy?.taskMode, "debug");
    assert.equal(legacy?.title, "legacy task");
    assert.equal(legacy?.goal, undefined);

    const withGoal = store.setGoal("task-legacy-v17", legacy?.revision ?? 0, {
      objective: "Migrated tasks may adopt a goal explicitly.",
    });
    assert.equal(withGoal.goal?.status, "active");
    store.close();

    const verified = new DatabaseSync(databasePath);
    assert.equal(
      (verified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      18,
    );
    verified.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("goal state machine allows exactly the declared transitions", () => {
  assert.equal(assertGoalTransition(undefined, { type: "set" }), "active");
  assert.equal(assertGoalTransition(undefined, { type: "set", replace: true }), "active");
  assert.equal(assertGoalTransition("complete", { type: "set" }), "active");
  assert.equal(assertGoalTransition("complete", { type: "set", replace: true }), "active");
  assert.equal(assertGoalTransition("active", { type: "set", replace: true }), "active");
  assert.throws(() => assertGoalTransition(undefined, { type: "clear" }), GoalStateError);
  assert.throws(() => assertGoalTransition("active", { type: "set" }), GoalStateError);
  assert.throws(() => assertGoalTransition("budget_limited", { type: "set" }), GoalStateError);
  assert.throws(() => assertGoalTransition("usage_limited", { type: "set" }), GoalStateError);
  assert.throws(() => assertGoalTransition("paused", { type: "set" }), GoalStateError);
  assert.throws(() => assertGoalTransition("blocked", { type: "set" }), GoalStateError);

  assert.equal(assertGoalTransition("active", { type: "pause" }), "paused");
  assert.equal(assertGoalTransition("active", { type: "block" }), "blocked");
  assert.equal(assertGoalTransition("active", { type: "complete" }), "complete");
  assert.equal(assertGoalTransition("active", { type: "budget_limit" }), "budget_limited");
  assert.equal(assertGoalTransition("active", { type: "usage_limit" }), "usage_limited");
  assert.equal(assertGoalTransition("paused", { type: "resume" }), "active");
  assert.equal(assertGoalTransition("blocked", { type: "resume" }), "active");

  const stable: readonly CandyGoalStatus[] = ["complete", "budget_limited", "usage_limited"];
  for (const status of stable) {
    assert.throws(() => assertGoalTransition(status, { type: "resume" }), GoalStateError);
    assert.throws(() => assertGoalTransition(status, { type: "pause" }), GoalStateError);
    assert.throws(() => assertGoalTransition(status, { type: "complete" }), GoalStateError);
    assert.equal(assertGoalTransition(status, { type: "clear" }), undefined);
    assert.equal(assertGoalTransition(status, { type: "set", replace: true }), "active");
  }
  for (const status of ["paused", "blocked"] as const) {
    assert.throws(() => assertGoalTransition(status, { type: "pause" }), GoalStateError);
    assert.throws(() => assertGoalTransition(status, { type: "complete" }), GoalStateError);
    assert.throws(() => assertGoalTransition(status, { type: "budget_limit" }), GoalStateError);
    assert.equal(assertGoalTransition(status, { type: "set", replace: true }), "active");
  }
  assert.equal(assertGoalTransition("active", { type: "clear" }), undefined);
  assert.equal(assertGoalTransition("paused", { type: "clear" }), undefined);
  assert.equal(assertGoalTransition("blocked", { type: "clear" }), undefined);
  assert.deepEqual(GOAL_STATUSES, [
    "active",
    "paused",
    "blocked",
    "budget_limited",
    "usage_limited",
    "complete",
  ]);
});

test("goal objective and budgets reject unbounded or unsafe input", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-goal-validation-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    const created = store.create("task-goal-validation", "auto");
    const revision = created.revision;

    assert.throws(
      () => store.setGoal("task-goal-validation", revision, { objective: "" }),
      /empty/u,
    );
    assert.throws(
      () => store.setGoal("task-goal-validation", revision, { objective: "   " }),
      /empty/u,
    );
    assert.throws(
      () => store.setGoal("task-goal-validation", revision, { objective: "x".repeat(4_097) }),
      /exceeds/u,
    );
    assert.throws(
      () => store.setGoal("task-goal-validation", revision, { objective: "a\u0000b" }),
      /control/u,
    );
    assert.throws(
      () =>
        store.setGoal("task-goal-validation", revision, {
          objective: fixtureCredential("bearer"),
        }),
      /credential/u,
    );
    assert.throws(
      () =>
        store.setGoal("task-goal-validation", revision, {
          objective: fixtureCredential("prefix"),
        }),
      /credential/u,
    );
    assert.throws(
      () =>
        store.setGoal("task-goal-validation", revision, {
          objective: "Valid goal.",
          completionCriterion: "y".repeat(4_097),
        }),
      /exceeds/u,
    );
    assert.throws(
      () =>
        store.setGoal("task-goal-validation", revision, {
          objective: "Valid goal.",
          turnBudget: 0,
        }),
      /positive safe integer/u,
    );
    assert.throws(
      () =>
        store.setGoal("task-goal-validation", revision, {
          objective: "Valid goal.",
          turnBudget: -1,
        }),
      /positive safe integer/u,
    );
    assert.throws(
      () =>
        store.setGoal("task-goal-validation", revision, {
          objective: "Valid goal.",
          wallClockBudgetMs: 1.5,
        }),
      /positive safe integer/u,
    );
    assert.throws(
      () =>
        store.setGoal("task-goal-validation", revision, {
          objective: "Valid goal.",
          tokenBudget: 100,
        }),
      /not yet supported/u,
    );
    const set = store.setGoal("task-goal-validation", revision, {
      objective: "Valid goal.",
      turnBudget: 3,
    });
    assert.equal(set.goal?.status, "active");
    assert.throws(
      () => store.updateGoalBudgets("task-goal-validation", set.revision, {}),
      /No goal budgets provided/u,
    );
    assert.throws(
      () => store.updateGoalBudgets("task-goal-validation", set.revision, { tokenBudget: 100 }),
      /not yet supported/u,
    );
    assert.throws(
      () =>
        store.accountGoalUsage("task-goal-validation", set.revision, set.goal?.goalId ?? "", {
          turnDelta: -1,
          wallClockDeltaMs: 0,
        }),
      /invalid/u,
    );
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("goal storage round-trips across restart and fences stale writes", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-goal-store-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    const created = store.create(
      "task-goal-store",
      "auto",
      1,
      "deepseek-v4-flash",
      [],
      process.cwd(),
      undefined,
      undefined,
      undefined,
      false,
      "Goal store",
      "goal",
    );
    assert.equal(created.taskMode, "goal");
    assert.equal(created.goal, undefined);

    const set = store.setGoal("task-goal-store", created.revision, {
      objective: "Implement the verifiable P0 goal slice.",
      completionCriterion: "platform goal tests pass",
      turnBudget: 5,
      wallClockBudgetMs: 60_000,
    });
    assert.equal(set.goal?.status, "active");
    assert.equal(set.goal?.objective, "Implement the verifiable P0 goal slice.");
    assert.equal(set.goal?.completionCriterion, "platform goal tests pass");
    assert.equal(set.goal?.turnBudget, 5);
    assert.equal(set.goal?.wallClockBudgetMs, 60_000);
    assert.equal(set.goal?.tokenBudget, null);
    assert.equal(set.goal?.turnsUsed, 0);
    assert.equal(set.goal?.wallClockMs, 0);
    assert.equal(set.goal?.continuationDeferred, false);
    assert.equal(set.goal?.consecutiveNoProgress, 0);
    assert.equal(store.getGoal("task-goal-store")?.goalId, set.goal?.goalId);

    assert.throws(
      () => store.setGoal("task-goal-store", set.revision, { objective: "duplicate" }),
      GoalStateError,
    );
    assert.throws(
      () =>
        store.setGoal("task-goal-store", created.revision, {
          objective: "stale",
          replace: true,
        }),
      /stale or missing/u,
    );

    const used = store.accountGoalUsage("task-goal-store", set.revision, set.goal?.goalId ?? "", {
      turnDelta: 2,
      wallClockDeltaMs: 1_500,
    });
    assert.equal(used.goal?.turnsUsed, 2);
    assert.equal(used.goal?.wallClockMs, 1_500);

    const deferred = store.setGoalContinuationDeferred(
      "task-goal-store",
      used.revision,
      used.goal?.goalId ?? "",
      true,
    );
    assert.equal(deferred.goal?.continuationDeferred, true);

    const paused = store.updateGoalStatus("task-goal-store", deferred.revision, "paused");
    assert.equal(paused.goal?.status, "paused");

    const budgetSet = store.updateGoalBudgets("task-goal-store", paused.revision, {
      turnBudget: 1,
    });
    assert.equal(budgetSet.goal?.status, "paused");
    store.close();

    // Inject counters directly to exercise the resume reset path across restart.
    const raw = new DatabaseSync(databasePath);
    raw.exec(
      "UPDATE task_metadata SET goal_continuation_deferred = 1, goal_consecutive_no_progress = 3 WHERE task_id = 'task-goal-store'",
    );
    raw.close();

    const reopened = new SQLiteTaskStore(databasePath);
    const loaded = reopened.getGoal("task-goal-store");
    assert.equal(loaded?.status, "paused");
    assert.equal(loaded?.continuationDeferred, true);
    assert.equal(loaded?.consecutiveNoProgress, 3);
    const resumed = reopened.updateGoalStatus(
      "task-goal-store",
      reopened.get("task-goal-store")?.revision ?? 0,
      "active",
    );
    assert.equal(resumed.goal?.status, "active");
    assert.equal(resumed.goal?.continuationDeferred, false);
    assert.equal(resumed.goal?.consecutiveNoProgress, 0);

    const limited = reopened.accountGoalUsage(
      "task-goal-store",
      resumed.revision,
      resumed.goal?.goalId ?? "",
      { turnDelta: 1, wallClockDeltaMs: 0 },
    );
    assert.equal(limited.goal?.status, "budget_limited");
    assert.equal(limited.goal?.terminalReason, "turn budget exhausted");
    assert.equal(limited.goal?.turnsUsed, 3);
    assert.throws(
      () => reopened.updateGoalStatus("task-goal-store", limited.revision, "active"),
      GoalStateError,
    );

    const replaced = reopened.setGoal("task-goal-store", limited.revision, {
      objective: "A fresh goal",
      replace: true,
    });
    assert.throws(
      () =>
        reopened.updateGoalStatus("task-goal-store", replaced.revision, "paused", {
          expectedGoalId: "stale-goal-id",
        }),
      /changed before/u,
    );
    assert.throws(
      () =>
        reopened.setGoal("task-goal-store", replaced.revision, {
          objective: "still duplicates",
        }),
      GoalStateError,
    );
    const replacementGoalId = replaced.goal?.goalId;
    assert.ok(replacementGoalId);
    const cleared = reopened.clearGoal("task-goal-store", replaced.revision, {
      expectedGoalId: replacementGoalId,
    });
    assert.equal(cleared.goal, undefined);
    assert.throws(() => reopened.clearGoal("task-goal-store", cleared.revision), GoalStateError);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("goal budgets flip an active goal to budget_limited when usage already exceeds them", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-goal-budget-limit-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    const created = store.create("task-goal-budget", "auto");
    const set = store.setGoal("task-goal-budget", created.revision, {
      objective: "Budgeted goal.",
    });
    const used = store.accountGoalUsage("task-goal-budget", set.revision, set.goal?.goalId ?? "", {
      turnDelta: 2,
      wallClockDeltaMs: 50_000,
    });
    assert.equal(used.goal?.status, "active");

    const limited = store.updateGoalBudgets("task-goal-budget", used.revision, {
      turnBudget: 2,
      wallClockBudgetMs: 60_000,
    });
    assert.equal(limited.goal?.status, "budget_limited");
    assert.equal(limited.goal?.terminalReason, "turn budget exhausted");
    assert.equal(limited.goal?.turnBudget, 2);

    const wallLimited = store.updateGoalBudgets(
      "task-goal-budget",
      limited.revision,
      { wallClockBudgetMs: 40_000 },
      { expectedGoalId: limited.goal?.goalId },
    );
    assert.equal(wallLimited.goal?.status, "budget_limited");
    assert.equal(wallLimited.goal?.wallClockBudgetMs, 40_000);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a completed goal accepts a fresh plain set and goal runs persist independently", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-goal-runs-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    const created = store.create("task-goal-runs", "auto");
    const first = store.setGoal("task-goal-runs", created.revision, {
      objective: "First objective.",
    });
    const firstGoalId = first.goal?.goalId;
    assert.ok(firstGoalId);
    const completed = store.updateGoalStatus("task-goal-runs", first.revision, "complete", {
      reason: "audit passed",
      expectedGoalId: firstGoalId,
    });
    assert.equal(completed.goal?.status, "complete");
    assert.equal(completed.goal?.terminalReason, "audit passed");
    assert.throws(
      () => store.updateGoalStatus("task-goal-runs", completed.revision, "paused"),
      GoalStateError,
    );

    const second = store.setGoal("task-goal-runs", completed.revision, {
      objective: "Second objective.",
    });
    assert.equal(second.goal?.status, "active");
    assert.notEqual(second.goal?.goalId, first.goal?.goalId);

    store.recordGoalRun({
      taskId: "task-goal-runs",
      rounds: 1,
      turnsUsed: 1,
      wallClockMs: 1_000,
      completed: false,
      stopReason: "running",
      evidenceSummary: "one bounded slice",
    });
    assert.equal(store.getGoalRun("task-goal-runs")?.rounds, 1);
    assert.equal(store.getGoalRun("task-goal-runs")?.stopReason, "running");
    assert.throws(
      () =>
        store.recordGoalRun({
          taskId: "task-goal-runs",
          rounds: 1,
          turnsUsed: 1,
          wallClockMs: 1_000,
          completed: false,
          stopReason: "running",
          evidenceSummary: "x".repeat(4_097),
        }),
      /evidence summary/u,
    );
    assert.throws(
      () =>
        store.recordGoalRun({
          taskId: "task-goal-runs",
          rounds: 1,
          turnsUsed: -1,
          wallClockMs: 1_000,
          completed: false,
          stopReason: "running",
        }),
      /turns are invalid/u,
    );
    store.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.equal(reopened.getGoal("task-goal-runs")?.objective, "Second objective.");
    assert.equal(reopened.getGoalRun("task-goal-runs")?.evidenceSummary, "one bounded slice");
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("goal no-progress counter is CAS- and goal-id-guarded", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-goal-no-progress-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    const created = store.create("task-goal-no-progress", "auto");
    assert.throws(
      () => store.setGoalNoProgress("task-goal-no-progress", created.revision, "any", 1),
      GoalStateError,
    );
    const set = store.setGoal("task-goal-no-progress", created.revision, { objective: "Counter." });
    const goalId = set.goal?.goalId ?? "";
    const first = store.setGoalNoProgress("task-goal-no-progress", set.revision, goalId, 2);
    assert.equal(first.goal?.consecutiveNoProgress, 2);
    assert.throws(
      () => store.setGoalNoProgress("task-goal-no-progress", set.revision, goalId, 3),
      /revision is stale/u,
    );
    assert.throws(
      () => store.setGoalNoProgress("task-goal-no-progress", first.revision, "other-goal", 3),
      /goal changed/u,
    );
    assert.throws(
      () => store.setGoalNoProgress("task-goal-no-progress", first.revision, goalId, -1),
      /no-progress counter is invalid/u,
    );
    const reset = store.setGoalNoProgress("task-goal-no-progress", first.revision, goalId, 0);
    assert.equal(reset.goal?.consecutiveNoProgress, 0);
    store.close();

    const reopened = new SQLiteTaskStore(databasePath);
    assert.equal(reopened.getGoal("task-goal-no-progress")?.consecutiveNoProgress, 0);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a completed goal keeps its terminal reason across later usage and budget writes", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "candy-goal-terminal-reason-"));
  const databasePath = path.join(directory, "state", "tasks.sqlite");
  try {
    const store = new SQLiteTaskStore(databasePath);
    const created = store.create("task-goal-terminal", "auto");
    const set = store.setGoal("task-goal-terminal", created.revision, { objective: "Ship it." });
    assert.ok(set.goal);
    const completed = store.updateGoalStatus("task-goal-terminal", set.revision, "complete", {
      expectedGoalId: set.goal.goalId,
      reason: "audit passed",
    });
    assert.equal(completed.goal?.terminalReason, "audit passed");
    // A late accounting or budget write must not erase an already recorded
    // terminal reason; only an explicit non-terminal transition clears it.
    const accounted = store.accountGoalUsage(
      "task-goal-terminal",
      completed.revision,
      set.goal.goalId,
      { turnDelta: 1, wallClockDeltaMs: 1_000 },
    );
    assert.equal(accounted.goal?.terminalReason, "audit passed");
    const budgeted = store.updateGoalBudgets(
      "task-goal-terminal",
      accounted.revision,
      { turnBudget: 9 },
      { expectedGoalId: set.goal.goalId },
    );
    assert.equal(budgeted.goal?.terminalReason, "audit passed");
    assert.equal(budgeted.goal?.status, "complete");

    // An explicit resume back to `active` is the one path that clears it.
    const createdSecond = store.create("task-goal-resume", "auto");
    const secondSet = store.setGoal("task-goal-resume", createdSecond.revision, {
      objective: "Ship it again.",
    });
    assert.ok(secondSet.goal);
    const blocked = store.updateGoalStatus("task-goal-resume", secondSet.revision, "blocked", {
      expectedGoalId: secondSet.goal.goalId,
      reason: "same obstacle",
    });
    assert.equal(blocked.goal?.terminalReason, "same obstacle");
    const resumed = store.updateGoalStatus("task-goal-resume", blocked.revision, "active", {
      expectedGoalId: secondSet.goal.goalId,
    });
    assert.equal(resumed.goal?.status, "active");
    assert.equal(resumed.goal?.terminalReason, undefined);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
