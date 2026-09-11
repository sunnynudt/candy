import { containsCredentialMaterial } from "./credential-guard.js";

/**
 * Goal Task state machine, types, and validation (P0). Goal Tasks are a
 * Long-running Task strategy on top of the Candy agent loop; this module only
 * defines the durable goal contract. Continuation policy, tools, and UI live
 * in later slices and reuse these rules through the platform package.
 *
 * The persisted status column uses `'none'` only as the sentinel for "no
 * goal"; the exported statuses below are the real Candy goal states.
 */
export const GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "usage_limited",
  "complete",
] as const;

export type CandyGoalStatus = (typeof GOAL_STATUSES)[number];

/** Bounded goal text length, aligned with the TUI turn message bound. */
export const MAX_GOAL_TEXT_CHARS = 4_096;

/** Goal budgets are optional and positive-safe-integer bounded. */
export interface TaskGoalBudgets {
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
  /** Token budget is reserved for P4 and rejected before then. */
  readonly tokenBudget?: number;
}

/** Read model of the durable goal state attached to one task. */
export interface TaskGoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: CandyGoalStatus;
  readonly turnBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly tokenBudget: number | null;
  readonly turnsUsed: number;
  readonly wallClockMs: number;
  readonly tokensUsed: number;
  readonly terminalReason?: string;
  readonly continuationDeferred: boolean;
  readonly consecutiveNoProgress: number;
}

export type GoalTransitionEvent =
  | { readonly type: "set"; readonly replace?: boolean }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "block"; readonly reason?: string }
  | { readonly type: "complete"; readonly reason?: string }
  | { readonly type: "budget_limit"; readonly reason?: string }
  | { readonly type: "usage_limit"; readonly reason?: string }
  | { readonly type: "clear" };

/** Signals an illegal goal state transition. */
export class GoalStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GoalStateError";
  }
}

/**
 * Validate one goal transition against the P0 transfer table. `undefined`
 * means the task currently has no goal. Returns the resulting goal status,
 * or `undefined` when the goal is cleared.
 *
 * - No goal: only `set` starts a goal (active).
 * - `complete` accepts a plain `set` (a finished goal may start a new one).
 * - Any other existing-goal state needs `set` with `replace: true`.
 * - Only `active` may pause/block/complete/hit a budget or usage limit.
 * - `paused`/`blocked` may `resume` back to `active`.
 * - `budget_limited`/`usage_limited`/terminal states never resume in P0;
 *   the user clears and sets a new goal instead.
 * - `clear` is only valid while a goal exists.
 */
export function assertGoalTransition(
  current: CandyGoalStatus | undefined,
  event: GoalTransitionEvent,
): CandyGoalStatus | undefined {
  if (event.type === "clear") {
    if (current === undefined) {
      throw new GoalStateError("Task has no goal to clear.");
    }
    return undefined;
  }
  if (event.type === "set") {
    if (current === undefined || event.replace === true || current === "complete") {
      return "active";
    }
    throw new GoalStateError(`Task already has a ${current} goal; set replace=true to replace it.`);
  }
  if (current === undefined) {
    throw new GoalStateError("Task has no goal for this transition.");
  }
  if (current === "active") {
    switch (event.type) {
      case "pause":
        return "paused";
      case "block":
        return "blocked";
      case "complete":
        return "complete";
      case "budget_limit":
        return "budget_limited";
      case "usage_limit":
        return "usage_limited";
      default:
        break;
    }
  } else if (current === "paused" || current === "blocked") {
    if (event.type === "resume") return "active";
  }
  throw new GoalStateError(`Goal transition from ${current} via ${event.type} is invalid.`);
}

/** True when the text carries control characters other than ordinary whitespace. */
function containsGoalControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0) return true;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
    if (code === 127) return true;
  }
  return false;
}

function assertGoalText(value: string, field: string): void {
  if (value.length === 0 || value.trim().length === 0) {
    throw new Error(`${field} is empty.`);
  }
  if (value.length > MAX_GOAL_TEXT_CHARS) {
    throw new Error(`${field} exceeds ${MAX_GOAL_TEXT_CHARS} characters.`);
  }
  if (containsGoalControlCharacter(value)) {
    throw new Error(`${field} contains control characters.`);
  }
  if (containsCredentialMaterial(value)) {
    throw new Error(`${field} contains credential material.`);
  }
}

/** Validate a bounded, sanitized goal objective before persistence. */
export function assertGoalObjective(objective: string): void {
  assertGoalText(objective, "Goal objective");
}

/** Validate a bounded completion criterion; absence is expressed by callers. */
export function assertGoalCompletionCriterion(criterion: string): void {
  assertGoalText(criterion, "Completion criterion");
}

/** Budgets must be positive safe integers when provided. */
export function assertGoalBudget(budget: number): void {
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new Error("Goal budget must be a positive safe integer.");
  }
}

/** Token budgets are enforced in the same accounting paths as turns and wall clock. */
