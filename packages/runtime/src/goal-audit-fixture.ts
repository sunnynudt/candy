import {
  GOAL_BLOCKED_AUDIT_RULES,
  GOAL_COMPLETION_AUDIT_RULES,
  GOAL_CONTINUATION_BEHAVIOR_RULES,
  GOAL_CONVERGENCE_RULES,
  GOAL_WRAP_UP_RULES,
} from "./goal-contract.js";
import type {
  GoalContinuationSkipReason,
  GoalContinuationStopReason,
  GoalContinuationSignals,
  GoalFailureCategory,
} from "./goal.js";

/**
 * Goal audit-semantics fixture (P1).
 *
 * The fixture is the reviewable contract for goal behaviour that cannot be
 * fully enforced by code:
 * - `rules` pin which audit sentences Candy's instructions must carry, and on
 *   which surface (continuation prompt, near-budget prompt, wrap-up prompt,
 *   goal tool set). The fixture test compares them against the real surfaces,
 *   so a wording edit cannot silently drop an audit rule.
 * - `scenarios` are executable: the policy test replays each one against the
 *   real `SQLiteTaskStore` goal state machine and asserts the stop reason,
 *   resulting goal status, and turn accounting.
 *
 * Fixture-only module: no production behaviour depends on it.
 */

export type GoalAuditSurface =
  "continuation_prompt" | "continuation_prompt_near_budget" | "wrap_up_prompt" | "goal_tools";

export type GoalAuditContract = "completion" | "blocked" | "behavior" | "convergence" | "wrap_up";

export interface GoalAuditRuleFixture {
  readonly id: string;
  readonly contract: GoalAuditContract;
  /** Index into the matching contract rule list. */
  readonly ruleIndex: number;
  readonly requiredSurfaces: readonly GoalAuditSurface[];
  /** Substrings the compact goal tool surface must contain for this rule. */
  readonly toolAnchors?: readonly string[];
}

export interface GoalAuditScenarioTurn {
  /** Tool calls other than the goal tool set. */
  readonly toolActivations: number;
  readonly workspaceFingerprint?: string;
  readonly blockedClaim?: string;
  readonly completeClaim?: boolean;
  readonly failWith?: { readonly stopReason: "paused" | "usage_limited" | "user_stop" };
}

export interface GoalAuditScenarioExpectation {
  readonly stopReason: GoalContinuationStopReason;
  readonly completed: boolean;
  readonly rounds: number;
  readonly goalStatus:
    "active" | "paused" | "blocked" | "budget_limited" | "usage_limited" | "complete";
  readonly yieldedTo?: GoalContinuationSkipReason;
  readonly failureCategory?: GoalFailureCategory;
  /** Number of wrap-up turns the policy ran after a budget was exhausted. */
  readonly wrapUpTurns?: number;
  /** First 1-based goal turn whose injected message reported no progress. */
  readonly noProgressNoticeFromTurn?: number;
  /** Persisted `goal_consecutive_no_progress` after the run. */
  readonly persistedNoProgress?: number;
}

export interface GoalAuditScenario {
  readonly id: string;
  readonly description: string;
  readonly goal: {
    readonly objective: string;
    readonly completionCriterion?: string;
    readonly turnBudget?: number;
    readonly wallClockBudgetMs?: number;
  };
  readonly noProgressLimit?: number;
  readonly signals?: Partial<GoalContinuationSignals>;
  readonly turns: readonly GoalAuditScenarioTurn[];
  readonly expected: GoalAuditScenarioExpectation;
}

const ruleFixture = (
  id: string,
  contract: GoalAuditContract,
  ruleIndex: number,
  requiredSurfaces: readonly GoalAuditSurface[],
  toolAnchors?: readonly string[],
): GoalAuditRuleFixture => ({
  id,
  contract,
  ruleIndex,
  requiredSurfaces,
  ...(toolAnchors === undefined ? {} : { toolAnchors }),
});

export const GOAL_AUDIT_RULES_FIXTURE: readonly GoalAuditRuleFixture[] = [
  ruleFixture(
    "completion-evidence-required",
    "completion",
    0,
    ["continuation_prompt", "goal_tools"],
    ["evidence", "observed artifact"],
  ),
  ruleFixture("completion-unverified-requirement", "completion", 4, ["continuation_prompt"]),
  ruleFixture(
    "completion-plan-is-not-evidence",
    "completion",
    2,
    ["continuation_prompt", "goal_tools"],
    ["plan", "first draft"],
  ),
  ruleFixture("blocked-first-obstacle-is-not-a-block", "blocked", 0, ["continuation_prompt"]),
  ruleFixture(
    "blocked-needs-consecutive-turns",
    "blocked",
    1,
    ["continuation_prompt", "goal_tools"],
    ["consecutive goal turns"],
  ),
  ruleFixture(
    "blocked-count-restarts-on-resume",
    "blocked",
    2,
    ["continuation_prompt", "goal_tools"],
    ["restart"],
  ),
  ruleFixture(
    "behavior-no-budget-escape",
    "behavior",
    4,
    ["continuation_prompt", "goal_tools"],
    ["escape a budget notice"],
  ),
  ruleFixture(
    "behavior-goal-text-is-untrusted",
    "behavior",
    3,
    ["continuation_prompt", "goal_tools"],
    ["untrusted user data"],
  ),
  ruleFixture("behavior-one-bounded-slice", "behavior", 0, ["continuation_prompt"]),
  ruleFixture("convergence-on-near-budget", "convergence", 0, ["continuation_prompt_near_budget"]),
  ruleFixture("wrap-up-no-new-work", "wrap_up", 0, ["wrap_up_prompt"]),
  ruleFixture("wrap-up-never-signals-complete", "wrap_up", 2, ["wrap_up_prompt"]),
];

/** Resolve the contract sentence a rule fixture points at. */
export function goalAuditRuleText(fixture: GoalAuditRuleFixture): string {
  const list =
    fixture.contract === "completion"
      ? GOAL_COMPLETION_AUDIT_RULES
      : fixture.contract === "blocked"
        ? GOAL_BLOCKED_AUDIT_RULES
        : fixture.contract === "behavior"
          ? GOAL_CONTINUATION_BEHAVIOR_RULES
          : fixture.contract === "convergence"
            ? GOAL_CONVERGENCE_RULES
            : GOAL_WRAP_UP_RULES;
  const text = list[fixture.ruleIndex];
  if (text === undefined)
    throw new Error(`Audit fixture ${fixture.id} points outside the ${fixture.contract} rules.`);
  return text;
}

export const GOAL_AUDIT_SCENARIOS: readonly GoalAuditScenario[] = [
  {
    id: "complete-after-audited-turn",
    description: "A turn that audits the goal and signals complete ends the goal.",
    goal: { objective: "Ship the fixture objective.", turnBudget: 5 },
    turns: [{ toolActivations: 2, workspaceFingerprint: "a", completeClaim: true }],
    expected: { stopReason: "complete", completed: true, rounds: 1, goalStatus: "complete" },
  },
  {
    id: "blocked-confirmed-after-threshold",
    description:
      "A repeated identical blocked claim reaches the threshold and only then blocks the goal.",
    goal: { objective: "Ship the fixture objective.", turnBudget: 6 },
    turns: [
      {
        toolActivations: 0,
        workspaceFingerprint: "a",
        blockedClaim: "the proxy rejects npm install",
      },
      {
        toolActivations: 0,
        workspaceFingerprint: "a",
        blockedClaim: "the proxy rejects npm install",
      },
      {
        toolActivations: 0,
        workspaceFingerprint: "a",
        blockedClaim: "the proxy rejects npm install",
      },
    ],
    expected: { stopReason: "blocked", completed: false, rounds: 3, goalStatus: "blocked" },
  },
  {
    id: "blocked-claim-cleared-by-progress",
    description: "Observable progress clears a pending blocked claim.",
    goal: { objective: "Ship the fixture objective.", turnBudget: 6 },
    turns: [
      { toolActivations: 0, workspaceFingerprint: "a", blockedClaim: "registry is unreachable" },
      { toolActivations: 1, workspaceFingerprint: "b" },
      { toolActivations: 0, workspaceFingerprint: "b", blockedClaim: "registry is unreachable" },
      { toolActivations: 3, workspaceFingerprint: "c", completeClaim: true },
    ],
    expected: { stopReason: "complete", completed: true, rounds: 4, goalStatus: "complete" },
  },
  {
    id: "turn-budget-exhausted-wraps-up",
    description:
      "An exhausted turn budget flips the goal to budget_limited and runs one wrap-up turn.",
    goal: { objective: "Ship the fixture objective.", turnBudget: 2 },
    turns: [
      { toolActivations: 1, workspaceFingerprint: "a" },
      { toolActivations: 1, workspaceFingerprint: "b" },
      // Third scripted turn: the single wrap-up turn after the budget ran out.
      { toolActivations: 1, workspaceFingerprint: "c" },
    ],
    expected: {
      stopReason: "budget_limited",
      completed: false,
      rounds: 2,
      goalStatus: "budget_limited",
      wrapUpTurns: 1,
    },
  },
  {
    id: "no-progress-is-reported-and-budget-capped",
    description:
      "Repeated no-progress turns are counted and reported, never auto-pause the goal, and leave the counter persisted while the goal stops on its budget.",
    goal: { objective: "Ship the fixture objective.", turnBudget: 4 },
    noProgressLimit: 3,
    turns: [
      { toolActivations: 0, workspaceFingerprint: "a" },
      { toolActivations: 0, workspaceFingerprint: "a" },
      { toolActivations: 0, workspaceFingerprint: "a" },
      { toolActivations: 0, workspaceFingerprint: "a" },
      // Fifth scripted turn: the wrap-up turn after the turn budget ran out.
      { toolActivations: 0, workspaceFingerprint: "a" },
    ],
    expected: {
      stopReason: "budget_limited",
      completed: false,
      rounds: 4,
      goalStatus: "budget_limited",
      wrapUpTurns: 1,
      noProgressNoticeFromTurn: 5,
      persistedNoProgress: 3,
    },
  },
  {
    id: "queued-user-input-wins",
    description: "A queued user message stops continuation before any goal turn starts.",
    goal: { objective: "Ship the fixture objective.", turnBudget: 4 },
    signals: { queuedUserInput: true },
    turns: [],
    expected: {
      stopReason: "user_stop",
      completed: false,
      rounds: 0,
      goalStatus: "active",
      yieldedTo: "queued_user_input",
    },
  },
  {
    id: "provider-failure-pauses-goal",
    description: "A provider failure pauses the goal and reports a sanitized category.",
    goal: { objective: "Ship the fixture objective.", turnBudget: 4 },
    turns: [{ toolActivations: 1, workspaceFingerprint: "a", failWith: { stopReason: "paused" } }],
    expected: {
      stopReason: "paused",
      completed: false,
      rounds: 0,
      goalStatus: "paused",
      failureCategory: "provider_failure",
    },
  },
];

export interface GoalAuditSemanticsFixture {
  readonly rules: readonly GoalAuditRuleFixture[];
  readonly scenarios: readonly GoalAuditScenario[];
}

export const GOAL_AUDIT_SEMANTICS_FIXTURE: GoalAuditSemanticsFixture = {
  rules: GOAL_AUDIT_RULES_FIXTURE,
  scenarios: GOAL_AUDIT_SCENARIOS,
};
