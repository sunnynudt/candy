import {
  type CandyGoalStatus,
  type Clock,
  type GoalRunStopReason,
  type TaskGoalRunMetadata,
  type TaskGoalSnapshot,
  type TaskMetadata,
} from "@candy/platform";
import { createHash } from "node:crypto";
import {
  MAX_GOAL_CONTINUATION_CHARS,
  buildGoalContinuationPrompt,
  buildGoalWrapUpPrompt,
  type GoalContinuationPrompt,
  type GoalPromptUsage,
} from "./goal-message.js";

/**
 * Shared Goal Task continuation policy (P1).
 *
 * A Goal Task is a Long-running Task strategy: while the task is idle and its
 * goal is `active`, Candy starts the next turn itself, reusing the same Pi
 * session. This module owns the reusable policy — condition evaluation, turn
 * and wall-clock budgets, stop reasons, and the no-progress counter — so the
 * TUI and the app-server turn loops do not each grow their own copy.
 *
 * Shape mirrors `LongRunningTaskRunner` in `v1.ts`: one runner drives turns,
 * asks a host callback for the current idle signals, and reports progress
 * through a binding. The durable goal state, its state machine, and every
 * write path stay in `@candy/platform` (P0); this module only reads them and
 * applies transitions the state machine already allows.
 *
 * Deliberate limits for this slice:
 * - The token dimension stays rejected until P4 (usage telemetry is not wired).
 * - No-progress counting only counts; it never auto-pauses a goal.
 * - Provider/runtime failures pause the goal; user-initiated stops leave the
 *   goal state untouched so an explicit resume continues the same goal.
 */

/** Consecutive no-tool, unchanged-workspace turns before Candy reports them. */
export const DEFAULT_GOAL_NO_PROGRESS_LIMIT = 3;

/** Consecutive identical blocked claims required before the goal is blocked. */
export const DEFAULT_GOAL_BLOCKED_TURN_LIMIT = 3;

/** Fraction of an enabled budget that triggers Candy's convergence notice. */
export const GOAL_CONVERGENCE_RATIO = 0.75;

/** Final goal-run stop reasons; `running` is only used for interim records. */
export type GoalContinuationStopReason = Exclude<GoalRunStopReason, "running">;

/** Why the continuation loop declined to start another goal turn. */
export type GoalContinuationSkipReason =
  | "no_goal"
  | "goal_paused"
  | "goal_blocked"
  | "goal_complete"
  | "goal_budget_limited"
  | "goal_usage_limited"
  | "shutting_down"
  | "ownership_lost"
  | "turn_active"
  | "pending_approval"
  | "queued_user_input"
  | "awaiting_user_input"
  | "continuation_deferred"
  | "budget_exhausted";

/** Sanitized failure category a host may show next to a `/resume` path. */
export type GoalFailureCategory = "provider_failure" | "runtime_error";

/** What the host observed about the task when the last turn settled. */
export interface GoalContinuationSignals {
  readonly turnActive: boolean;
  readonly queuedUserInput: boolean;
  readonly pendingApproval: boolean;
  /** The last turn explicitly asked the user something and is waiting. */
  readonly awaitingUserInput: boolean;
  readonly ownershipHeld: boolean;
  readonly shuttingDown: boolean;
}

/** Idle signals for a host that has nothing pending. */
export const IDLE_GOAL_SIGNALS: GoalContinuationSignals = {
  turnActive: false,
  queuedUserInput: false,
  pendingApproval: false,
  awaitingUserInput: false,
  ownershipHeld: true,
  shuttingDown: false,
};

export interface GoalBudgetState {
  readonly remainingTurns: number | null;
  readonly remainingWallClockMs: number | null;
  readonly remainingTokens: number | null;
  readonly nearBudget: boolean;
}

export type GoalContinuationDecision =
  | {
      readonly continue: true;
      /** 1-based number of the goal turn the continuation would start. */
      readonly turn: number;
      readonly remainingTurns: number | null;
      readonly remainingWallClockMs: number | null;
      readonly remainingTokens: number | null;
      readonly nearBudget: boolean;
    }
  | { readonly continue: false; readonly reason: GoalContinuationSkipReason };

/** Remaining budget and convergence state for one goal snapshot. */
export function goalBudgetState(
  goal: TaskGoalSnapshot,
  ratio: number = GOAL_CONVERGENCE_RATIO,
): GoalBudgetState {
  const remainingTurns = goal.turnBudget === null ? null : goal.turnBudget - goal.turnsUsed;
  const remainingWallClockMs =
    goal.wallClockBudgetMs === null ? null : goal.wallClockBudgetMs - goal.wallClockMs;
  const remainingTokens = goal.tokenBudget === null ? null : goal.tokenBudget - goal.tokensUsed;
  const nearTurnBudget =
    goal.turnBudget !== null && goal.turnBudget > 0 && goal.turnsUsed / goal.turnBudget >= ratio;
  const nearWallClockBudget =
    goal.wallClockBudgetMs !== null &&
    goal.wallClockBudgetMs > 0 &&
    goal.wallClockMs / goal.wallClockBudgetMs >= ratio;
  const nearTokenBudget =
    goal.tokenBudget !== null &&
    goal.tokenBudget > 0 &&
    goal.tokensUsed / goal.tokenBudget >= ratio;
  return {
    remainingTurns,
    remainingWallClockMs,
    remainingTokens,
    nearBudget: nearTurnBudget || nearWallClockBudget || nearTokenBudget,
  };
}

/**
 * Decide whether Candy may start another automatic goal turn. Precedence is
 * deliberate: goal lifecycle first, then shutdown and ownership, then the
 * activity gates that keep a user turn or approval boundary from racing the
 * continuation, then Candy's own deferral marker.
 */
export function evaluateGoalContinuation(
  goal: TaskGoalSnapshot | undefined,
  signals: GoalContinuationSignals,
  ratio: number = GOAL_CONVERGENCE_RATIO,
): GoalContinuationDecision {
  if (goal === undefined) return { continue: false, reason: "no_goal" };
  if (goal.status !== "active") return { continue: false, reason: statusSkipReason(goal.status) };
  if (signals.shuttingDown) return { continue: false, reason: "shutting_down" };
  if (!signals.ownershipHeld) return { continue: false, reason: "ownership_lost" };
  if (signals.turnActive) return { continue: false, reason: "turn_active" };
  if (signals.pendingApproval) return { continue: false, reason: "pending_approval" };
  if (signals.queuedUserInput) return { continue: false, reason: "queued_user_input" };
  if (signals.awaitingUserInput) return { continue: false, reason: "awaiting_user_input" };
  if (goal.continuationDeferred) return { continue: false, reason: "continuation_deferred" };
  const budget = goalBudgetState(goal, ratio);
  if (budget.remainingTurns !== null && budget.remainingTurns <= 0)
    return { continue: false, reason: "budget_exhausted" };
  if (budget.remainingWallClockMs !== null && budget.remainingWallClockMs <= 0)
    return { continue: false, reason: "budget_exhausted" };
  if (budget.remainingTokens !== null && budget.remainingTokens <= 0)
    return { continue: false, reason: "budget_exhausted" };
  return {
    continue: true,
    turn: goal.turnsUsed + 1,
    remainingTurns: budget.remainingTurns,
    remainingWallClockMs: budget.remainingWallClockMs,
    remainingTokens: budget.remainingTokens,
    nearBudget: budget.nearBudget,
  };
}

function statusSkipReason(status: CandyGoalStatus): GoalContinuationSkipReason {
  switch (status) {
    case "paused":
      return "goal_paused";
    case "blocked":
      return "goal_blocked";
    case "complete":
      return "goal_complete";
    case "budget_limited":
      return "goal_budget_limited";
    default:
      return "goal_usage_limited";
  }
}

/** Map a skip reason onto the durable goal-run stop reason Candy records. */
function skipStopReason(reason: GoalContinuationSkipReason): GoalContinuationStopReason {
  switch (reason) {
    case "goal_paused":
      return "paused";
    case "goal_blocked":
      return "blocked";
    case "goal_complete":
      return "complete";
    case "goal_budget_limited":
    case "budget_exhausted":
      return "budget_limited";
    case "goal_usage_limited":
      return "usage_limited";
    default:
      return "user_stop";
  }
}

/**
 * Tracks the model's blocked claims for the current execution span. A claim
 * alone never blocks the goal: the policy applies `blocked` only after the
 * configured number of consecutive goal turns report the same reason, and a
 * resume starts a fresh span, so the count restarts.
 */
export class GoalBlockedClaimLedger {
  #reason: string | undefined;
  #streak = 0;

  public get streak(): number {
    return this.#streak;
  }

  public get reason(): string | undefined {
    return this.#reason;
  }

  /** Record one blocked claim and return the current consecutive streak. */
  public record(reason: string): number {
    const normalized = reason.trim();
    if (normalized.length === 0) throw new Error("A blocked claim needs a reason.");
    if (this.#reason !== undefined && this.#reason === normalized) this.#streak += 1;
    else {
      this.#reason = normalized;
      this.#streak = 1;
    }
    return this.#streak;
  }

  /** Clear the claim after observable progress or after a user resume. */
  public reset(): void {
    this.#reason = undefined;
    this.#streak = 0;
  }

  public snapshot(): { readonly turns: number; readonly reason?: string } {
    return this.#reason === undefined
      ? { turns: this.#streak }
      : { turns: this.#streak, reason: this.#reason };
  }
}

/** Signals a host-initiated stop that the goal policy must classify. */
export type GoalControlStopReason =
  "paused" | "cancelled" | "interrupted" | "usage_limited" | "user_stop";

/** Mirrors `LongRunningControlError`: a host tells the policy why it stopped. */
export class GoalControlError extends Error {
  public constructor(
    public readonly stopReason: GoalControlStopReason,
    message: string = `Goal continuation stopped: ${stopReason}.`,
  ) {
    super(message);
    this.name = "GoalControlError";
  }
}

/** Durable goal reads and writes the policy needs; `SQLiteTaskStore` satisfies it. */
export interface GoalContinuationStore {
  get(taskId: string): TaskMetadata | undefined;
  getGoal(taskId: string): TaskGoalSnapshot | undefined;
  updateGoalStatus(
    taskId: string,
    expectedRevision: number,
    status: CandyGoalStatus,
    options?: { readonly expectedGoalId?: string; readonly reason?: string },
  ): TaskMetadata;
  accountGoalUsage(
    taskId: string,
    expectedRevision: number,
    expectedGoalId: string,
    usage: {
      readonly turnDelta: number;
      readonly wallClockDeltaMs: number;
      readonly tokenDelta?: number;
    },
  ): TaskMetadata;
  setGoalNoProgress(
    taskId: string,
    expectedRevision: number,
    expectedGoalId: string,
    consecutiveNoProgress: number,
  ): TaskMetadata;
  recordGoalRun(progress: TaskGoalRunMetadata): void;
}

export interface GoalContinuationProgressStore {
  record(progress: TaskGoalRunMetadata): void;
}

export interface GoalContinuationProgressBinding {
  readonly store: GoalContinuationProgressStore;
}

/**
 * What a completed goal turn reports. `toolActivations` counts tool calls
 * other than the goal tool set, so a turn that only asserts `blocked` is not
 * mistaken for progress. `tokensUsed` is the turn's *billable* token count
 * (see `billableTokens` in `usage.ts`), or omitted when the provider reported
 * no usage.
 */
export interface GoalTurnReport {
  readonly toolActivations: number;
  readonly tokensUsed?: number;
  /** Host workspace fingerprint after the turn; omit when the host cannot compute one. */
  readonly workspaceFingerprint?: string;
}

export interface GoalTurnContext {
  readonly taskId: string;
  /** 1-based goal turn number within the whole goal, not within this run. */
  readonly turn: number;
  readonly goal: TaskGoalSnapshot;
  readonly message: GoalContinuationPrompt;
  /** `wrap_up` marks the single final turn after a budget was exhausted. */
  readonly phase: "continuation" | "wrap_up";
  readonly remainingTurns: number | null;
  readonly remainingWallClockMs: number | null;
}

export type GoalTurnCallback = (
  context: GoalTurnContext,
  signal: AbortSignal,
) => Promise<GoalTurnReport>;

export interface GoalRunResult {
  /** True only when the goal reached `complete`. */
  readonly completed: boolean;
  readonly stopReason: GoalContinuationStopReason;
  /** Set when the loop yielded to the user or the host instead of a goal state. */
  readonly yieldedTo?: GoalContinuationSkipReason;
  readonly rounds: number;
  readonly turnsUsed: number;
  readonly wallClockMs: number;
  /** Billable tokens recorded for the whole goal. */
  readonly tokensUsed: number;
  readonly noProgressStreak: number;
  readonly failureCategory?: GoalFailureCategory;
}

export interface GoalContinuationOptions {
  readonly taskId: string;
  readonly store: GoalContinuationStore;
  readonly clock: Clock;
  /** Read the current idle signals; called before every continuation turn. */
  readonly signals: () => GoalContinuationSignals;
  readonly claims?: GoalBlockedClaimLedger;
  readonly noProgressLimit?: number;
  readonly blockedTurnLimit?: number;
  /** Run one bounded wrap-up turn when a budget is exhausted (default true). */
  readonly wrapUpTurn?: boolean;
  readonly activeSecrets?: readonly string[];
  readonly maxPromptChars?: number;
}

interface GoalRunState {
  rounds: number;
  turnsUsed: number;
  wallClockMs: number;
  tokensUsed: number;
  noProgressStreak: number;
  lastFingerprint: string | undefined;
}

export class GoalContinuationRunner {
  readonly #options: GoalContinuationOptions;
  readonly #claims: GoalBlockedClaimLedger;
  readonly #noProgressLimit: number;
  readonly #blockedTurnLimit: number;
  readonly #wrapUpTurn: boolean;
  #noProgressStreak: number;
  #lastFingerprint: string | undefined;

  public constructor(options: GoalContinuationOptions) {
    this.#options = options;
    this.#claims = options.claims ?? new GoalBlockedClaimLedger();
    this.#noProgressLimit = options.noProgressLimit ?? DEFAULT_GOAL_NO_PROGRESS_LIMIT;
    this.#blockedTurnLimit = options.blockedTurnLimit ?? DEFAULT_GOAL_BLOCKED_TURN_LIMIT;
    this.#wrapUpTurn = options.wrapUpTurn ?? true;
    if (!Number.isSafeInteger(this.#noProgressLimit) || this.#noProgressLimit < 0)
      throw new Error("Goal no-progress limit is invalid.");
    if (!Number.isSafeInteger(this.#blockedTurnLimit) || this.#blockedTurnLimit < 1)
      throw new Error("Goal blocked-turn limit is invalid.");
    const goal = options.store.getGoal(options.taskId);
    this.#noProgressStreak = goal?.consecutiveNoProgress ?? 0;
    this.#lastFingerprint = undefined;
    this.#claims.reset();
  }

  /** Blocked claims recorded by the goal tool set, shared with this runner. */
  public get claims(): GoalBlockedClaimLedger {
    return this.#claims;
  }

  public get taskId(): string {
    return this.#options.taskId;
  }

  /** Current evaluation against the persisted goal and the host signals. */
  public evaluate(): GoalContinuationDecision {
    return evaluateGoalContinuation(this.#goal(), this.#options.signals());
  }

  /**
   * Account the user-initiated goal turn that started or resumed the goal.
   * Candy's accepted default counts the starting user turn in the turn budget.
   */
  public accountUserTurn(
    wallClockMs: number,
    options: { readonly tokensUsed?: number } = {},
  ): void {
    this.#account({
      turnDelta: 1,
      wallClockDeltaMs: wallClockMs,
      ...(options.tokensUsed === undefined ? {} : { tokenDelta: options.tokensUsed }),
    });
  }

  /**
   * Drive automatic continuation turns until the goal leaves `active`, the
   * user takes the next move, a budget is exhausted, or a failure pauses the
   * goal. Every stop persists a goal-run record with its stop reason.
   */
  public async run(
    turnCallback: GoalTurnCallback,
    signal: AbortSignal,
    progress?: GoalContinuationProgressBinding,
  ): Promise<GoalRunResult> {
    const initial = this.#goal();
    const state: GoalRunState = {
      rounds: 0,
      turnsUsed: initial?.turnsUsed ?? 0,
      wallClockMs: initial?.wallClockMs ?? 0,
      tokensUsed: initial?.tokensUsed ?? 0,
      noProgressStreak: this.#noProgressStreak,
      lastFingerprint: this.#lastFingerprint,
    };

    for (;;) {
      if (signal.aborted)
        return this.#finish(state, stopReasonFromSignal(signal), false, progress, {});
      const goal = this.#goal();
      if (goal === undefined)
        return this.#finish(state, "user_stop", false, progress, { yieldedTo: "no_goal" });
      if (goal.status !== "active") {
        const reason = statusSkipReason(goal.status);
        // The starting user turn can consume the last allowed goal turn, so an
        // exhausted budget still gets its single wrap-up turn before stopping.
        if (goal.status === "budget_limited" && this.#wrapUpTurn && state.rounds === 0) {
          const wrapUpUsage = this.#usage(goal, goal.turnsUsed + 1, goalBudgetState(goal));
          try {
            await this.#runTurn(
              goal.turnsUsed + 1,
              "wrap_up",
              wrapUpUsage,
              goal,
              turnCallback,
              signal,
            );
          } catch (error) {
            return this.#finishFailure(state, error, signal, progress);
          }
        }
        return this.#finish(state, skipStopReason(reason), goal.status === "complete", progress, {
          yieldedTo: reason,
        });
      }
      const decision = evaluateGoalContinuation(goal, this.#options.signals());
      if (!decision.continue)
        return this.#finish(state, skipStopReason(decision.reason), false, progress, {
          yieldedTo: decision.reason,
        });
      if (this.#claims.streak >= this.#blockedTurnLimit) {
        const reason = this.#claims.reason ?? "repeated blocking condition";
        this.#transition("blocked", goal.goalId, reason);
        return this.#finish(state, "blocked", false, progress, {});
      }

      const turn = state.rounds + 1;
      const usage = this.#usage(goal, turn, decision);
      const turnStartedAt = this.#options.clock.now();
      let report: GoalTurnReport;
      try {
        report = await this.#runTurn(turn, "continuation", usage, goal, turnCallback, signal);
      } catch (error) {
        return this.#finishFailure(state, error, signal, progress);
      }
      state.rounds = turn;
      const accounted = this.#account({
        turnDelta: 1,
        wallClockDeltaMs: Math.max(0, this.#options.clock.now() - turnStartedAt),
        ...(report.tokensUsed === undefined ? {} : { tokenDelta: report.tokensUsed }),
      });
      if (accounted !== undefined) {
        state.turnsUsed = accounted.turnsUsed;
        state.wallClockMs = accounted.wallClockMs;
        state.tokensUsed = accounted.tokensUsed;
      }
      const previousFingerprint = state.lastFingerprint;
      state.noProgressStreak = nextNoProgressStreak(
        state.noProgressStreak,
        previousFingerprint,
        report,
        this.#noProgressLimit,
      );
      if (report.workspaceFingerprint !== undefined)
        state.lastFingerprint = report.workspaceFingerprint;
      if (hasObservableProgress(previousFingerprint, report)) this.#claims.reset();
      this.#noProgressStreak = state.noProgressStreak;
      this.#lastFingerprint = state.lastFingerprint;
      this.#persistNoProgress(state);
      this.#persistRun(state, "running", false, progress);

      const after = this.#goal();
      if (after === undefined)
        return this.#finish(state, "user_stop", false, progress, { yieldedTo: "no_goal" });
      if (after.status === "complete") return this.#finish(state, "complete", true, progress, {});
      if (after.status === "blocked") return this.#finish(state, "blocked", false, progress, {});
      if (after.status === "usage_limited")
        return this.#finish(state, "usage_limited", false, progress, {});
      if (after.status === "paused") return this.#finish(state, "paused", false, progress, {});
      if (after.status === "budget_limited") {
        // One bounded wrap-up turn, then the loop stops: Candy never continues
        // substantive work past an exhausted budget and never auto-completes.
        if (this.#wrapUpTurn) {
          const wrapUpUsage = this.#usage(after, turn + 1, goalBudgetState(after));
          try {
            await this.#runTurn(turn + 1, "wrap_up", wrapUpUsage, after, turnCallback, signal);
          } catch (error) {
            return this.#finishFailure(state, error, signal, progress);
          }
        }
        return this.#finish(state, "budget_limited", false, progress, {});
      }
    }
  }

  #goal(): TaskGoalSnapshot | undefined {
    return this.#options.store.getGoal(this.#options.taskId);
  }

  #usage(
    goal: TaskGoalSnapshot,
    turn: number,
    budget: {
      readonly remainingTurns: number | null;
      readonly remainingWallClockMs: number | null;
      readonly remainingTokens: number | null;
      readonly nearBudget: boolean;
    },
  ): GoalPromptUsage {
    const claim = this.#claims.streak;
    return {
      turn,
      turnsUsed: goal.turnsUsed,
      turnBudget: goal.turnBudget,
      remainingTurns: budget.remainingTurns,
      wallClockMs: goal.wallClockMs,
      wallClockBudgetMs: goal.wallClockBudgetMs,
      remainingWallClockMs: budget.remainingWallClockMs,
      tokensUsed: goal.tokensUsed,
      tokenBudget: goal.tokenBudget,
      remainingTokens: budget.remainingTokens,
      nearBudget: budget.nearBudget,
      noProgressStreak: this.#noProgressStreak,
      noProgressLimit: this.#noProgressLimit,
      ...(claim > 0 && claim < this.#blockedTurnLimit
        ? { pendingBlockedClaim: { turns: claim, limit: this.#blockedTurnLimit } }
        : {}),
    };
  }

  async #runTurn(
    turnNumber: number,
    phase: "continuation" | "wrap_up",
    usage: GoalPromptUsage,
    goal: TaskGoalSnapshot,
    turn: GoalTurnCallback,
    signal: AbortSignal,
  ): Promise<GoalTurnReport> {
    const input = {
      objective: goal.objective,
      usage,
      maxChars: this.#options.maxPromptChars ?? MAX_GOAL_CONTINUATION_CHARS,
      ...(goal.completionCriterion === undefined
        ? {}
        : { completionCriterion: goal.completionCriterion }),
      ...(this.#options.activeSecrets === undefined
        ? {}
        : { activeSecrets: this.#options.activeSecrets }),
    };
    const message =
      phase === "wrap_up" ? buildGoalWrapUpPrompt(input) : buildGoalContinuationPrompt(input);
    return turn(
      {
        taskId: this.#options.taskId,
        turn: turnNumber,
        goal,
        message,
        phase,
        remainingTurns: usage.remainingTurns,
        remainingWallClockMs: usage.remainingWallClockMs,
      },
      signal,
    );
  }

  #transition(status: CandyGoalStatus, goalId: string, reason: string): void {
    const current = this.#options.store.get(this.#options.taskId);
    if (current?.goal === undefined) return;
    try {
      this.#options.store.updateGoalStatus(this.#options.taskId, current.revision, status, {
        expectedGoalId: goalId,
        reason,
      });
    } catch {
      // The goal state machine rejected the transition because the goal moved
      // on concurrently (user clear/pause, or a later goal id). The policy
      // never overrides a newer durable state.
    }
  }

  #account(delta: {
    readonly turnDelta: number;
    readonly wallClockDeltaMs: number;
    readonly tokenDelta?: number;
  }): TaskGoalSnapshot | undefined {
    const current = this.#options.store.get(this.#options.taskId);
    const goal = current?.goal;
    if (current === undefined || goal === undefined) return undefined;
    try {
      return (
        this.#options.store.accountGoalUsage(
          this.#options.taskId,
          current.revision,
          goal.goalId,
          delta,
        ).goal ?? undefined
      );
    } catch {
      return undefined;
    }
  }

  #persistNoProgress(state: GoalRunState): void {
    const current = this.#options.store.get(this.#options.taskId);
    const goal = current?.goal;
    if (current === undefined || goal === undefined) return;
    if (goal.consecutiveNoProgress === state.noProgressStreak) return;
    try {
      this.#options.store.setGoalNoProgress(
        this.#options.taskId,
        current.revision,
        goal.goalId,
        state.noProgressStreak,
      );
    } catch {
      // A concurrent goal change owns the counter now; the next turn re-reads it.
    }
  }

  #persistRun(
    state: GoalRunState,
    stopReason: GoalRunStopReason,
    completed: boolean,
    progress?: GoalContinuationProgressBinding,
  ): void {
    if (progress === undefined) return;
    progress.store.record({
      taskId: this.#options.taskId,
      rounds: state.rounds,
      turnsUsed: state.turnsUsed,
      wallClockMs: state.wallClockMs,
      completed,
      stopReason,
      ...(state.lastFingerprint === undefined
        ? {}
        : { lastFingerprintHash: fingerprintHash(state.lastFingerprint) }),
      evidenceSummary: runSummary(state, stopReason),
    });
  }

  #finish(
    state: GoalRunState,
    stopReason: GoalContinuationStopReason,
    completed: boolean,
    progress: GoalContinuationProgressBinding | undefined,
    extra: {
      readonly yieldedTo?: GoalContinuationSkipReason;
      readonly failureCategory?: GoalFailureCategory;
    },
  ): GoalRunResult {
    this.#persistRun(state, stopReason, completed, progress);
    return {
      completed,
      stopReason,
      rounds: state.rounds,
      turnsUsed: state.turnsUsed,
      wallClockMs: state.wallClockMs,
      tokensUsed: state.tokensUsed,
      noProgressStreak: state.noProgressStreak,
      ...(extra.yieldedTo === undefined ? {} : { yieldedTo: extra.yieldedTo }),
      ...(extra.failureCategory === undefined ? {} : { failureCategory: extra.failureCategory }),
    };
  }

  #finishFailure(
    state: GoalRunState,
    error: unknown,
    signal: AbortSignal,
    progress: GoalContinuationProgressBinding | undefined,
  ): GoalRunResult {
    const stopReason = stopReasonFromError(error, signal);
    const failureCategory: GoalFailureCategory | undefined =
      stopReason === "paused"
        ? "provider_failure"
        : stopReason === "error"
          ? "runtime_error"
          : undefined;
    const goal = this.#goal();
    if (goal === undefined) {
      // Nothing durable to move; the run result still carries the stop reason.
    } else if (stopReason === "paused" || stopReason === "error") {
      // A provider or runtime failure needs an explicit user resume.
      this.#transition("paused", goal.goalId, "provider or runtime failure");
    } else if (stopReason === "usage_limited") {
      this.#transition("usage_limited", goal.goalId, "usage limit reached");
    }
    // Cancellation, interruption, and user stops leave the goal state alone: the
    // task stopped, and an explicit resume continues the same goal.
    return this.#finish(state, stopReason, false, progress, {
      ...(failureCategory === undefined ? {} : { failureCategory }),
    });
  }
}

function stopReasonFromSignal(signal: AbortSignal): GoalContinuationStopReason {
  return signal.reason instanceof GoalControlError ? signal.reason.stopReason : "cancelled";
}

function stopReasonFromError(error: unknown, signal: AbortSignal): GoalContinuationStopReason {
  if (error instanceof GoalControlError) return error.stopReason;
  if (signal.aborted) return stopReasonFromSignal(signal);
  return "error";
}

function fingerprintHash(fingerprint: string): string {
  return createHash("sha256").update(fingerprint).digest("hex");
}

function seconds(milliseconds: number): string {
  return `${Math.round(milliseconds / 1_000)}s`;
}

function runSummary(state: GoalRunState, stopReason: GoalRunStopReason): string {
  return (
    `goal ${stopReason}: ${state.rounds} goal turn(s), ${state.turnsUsed} turn(s) used, ` +
    `${seconds(state.wallClockMs)} active wall clock, ${state.tokensUsed} billable token(s), ` +
    `${state.noProgressStreak} no-progress turn(s)`
  ).slice(0, 4_096);
}

/**
 * Count a goal turn as no-progress only when Candy can see that nothing
 * changed: no tool activity and an identical, known workspace fingerprint.
 */
function nextNoProgressStreak(
  previous: number,
  lastFingerprint: string | undefined,
  report: GoalTurnReport,
  limit: number,
): number {
  if (limit === 0) return 0;
  const unchanged =
    report.toolActivations === 0 &&
    report.workspaceFingerprint !== undefined &&
    lastFingerprint !== undefined &&
    report.workspaceFingerprint === lastFingerprint;
  return unchanged ? previous + 1 : 0;
}

/** Observable progress clears a pending blocked claim. */
function hasObservableProgress(
  lastFingerprint: string | undefined,
  report: GoalTurnReport,
): boolean {
  if (report.toolActivations > 0) return true;
  if (report.workspaceFingerprint === undefined) return false;
  return lastFingerprint !== undefined && report.workspaceFingerprint !== lastFingerprint;
}
