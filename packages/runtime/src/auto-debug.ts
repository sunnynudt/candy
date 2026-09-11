import { redactCredentialMaterial } from "@candy/platform";
import {
  LongRunningTaskRunner,
  type LongRunningProgress,
  type LongRunningResult,
  type ValidatorResult,
} from "./v1.js";

/**
 * Shared Auto Debug policy and driver (P5, completed in P6).
 *
 * Auto Debug is a Long-running Task strategy driven by an explicit validator.
 * Both clients (TUI and the app-server/WebUI backend) start their own task and
 * project their own protocol/transcript, but they run the *same* loop from
 * here: round budget, stall limit, evidence bound, repair prompt contract, and
 * stop reasons. The two surfaces drifted apart before this module existed (the
 * TUI used 6 rounds while the app-server used 3) and then still duplicated the
 * loop body, so `runAutoDebugLoop` is the single place that decides when a
 * round starts, what it receives, and when the run stops.
 */

/** Rounds a single Auto Debug run may take before Candy stops as exhausted. */
export const DEFAULT_AUTO_DEBUG_ROUNDS = 6;

/** Consecutive identical validator fingerprints before Candy stops as stalled. */
export const DEFAULT_AUTO_DEBUG_STALL_LIMIT = 2;

/** Bound for validator evidence injected into a repair round. */
export const MAX_AUTO_DEBUG_EVIDENCE_CHARS = 4_096;

/**
 * Banner the clients prepend to the user's goal when a debug task is created.
 * The validator contract is what the model cannot infer from the goal alone.
 */
export const AUTO_DEBUG_TURN_INSTRUCTION =
  "[AUTO-DEBUG] Make the change and verify it with the configured validator. After each of your turns the validator runs automatically; when it fails, the next turn receives the bounded failure evidence and you must fix the root cause. Keep changes minimal and do not remove unrelated work.\n";

export interface AutoDebugRoundInput {
  /** The task's stored prompt: the goal (round 1) that later rounds repeat. */
  readonly goal: string;
  /** 1-based round number. */
  readonly round: number;
  readonly maxRounds: number;
  /** Redacted-on-entry evidence from the previous validator run. */
  readonly evidence?: string | undefined;
  readonly activeSecrets?: readonly string[];
  /** Evidence bound; tests and future slices may lower it deterministically. */
  readonly maxEvidenceChars?: number;
}

/**
 * Build the prompt for one Auto Debug round: the goal on round 1, and the goal
 * plus bounded, redacted verifier evidence on every repair round.
 */
export function buildAutoDebugRoundPrompt(input: AutoDebugRoundInput): string {
  if (input.round <= 1) return input.goal;
  return [
    input.goal,
    "",
    `[VERIFIER FAILED] round ${input.round} of ${input.maxRounds}; bounded evidence:`,
    boundAutoDebugEvidence(input.evidence, input),
    "",
    "Fix the root cause and re-verify; do not change unrelated files.",
  ].join("\n");
}

/** Redact, sanitize, and bound verifier evidence before it reaches the model. */
export function boundAutoDebugEvidence(
  evidence: string | undefined,
  input: Pick<AutoDebugRoundInput, "activeSecrets" | "maxEvidenceChars"> = {},
): string {
  const redacted = redactCredentialMaterial(evidence ?? "", input.activeSecrets ?? []);
  const cleaned = redacted
    .split("")
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0 || (code < 32 && code !== 9 && code !== 10) ? " " : character;
    })
    .join("")
    .trim();
  if (cleaned.length === 0) return "(no validator evidence was captured)";
  const bound = Math.max(64, input.maxEvidenceChars ?? MAX_AUTO_DEBUG_EVIDENCE_CHARS);
  return cleaned.length <= bound
    ? cleaned
    : `${cleaned.slice(0, bound)}\n[evidence truncated by Candy]`;
}

/** One round handed to a client's turn runner. */
export interface AutoDebugRound {
  /** 1-based round number. */
  readonly round: number;
  readonly maxRounds: number;
  /** True when the round repeats the goal with bounded verifier evidence. */
  readonly repair: boolean;
  /** Ready-to-run prompt: the goal, plus evidence on repair rounds. */
  readonly prompt: string;
}

export interface AutoDebugLoopOptions {
  /** The task's stored prompt: the goal round 1 starts from. */
  readonly goal: string;
  /**
   * Run one model turn for this round. The client owns the transcript, the
   * phase label, steering, and provider error mapping for its own surface.
   */
  readonly runTurn: (round: AutoDebugRound, signal: AbortSignal) => Promise<void>;
  /** Run the configured validator and return its evidence for the next round. */
  readonly runValidator: (signal: AbortSignal) => Promise<ValidatorResult>;
  readonly signal: AbortSignal;
  readonly maxRounds?: number;
  readonly stallLimit?: number;
  /** Persist round progress (the client owns its run store projection). */
  readonly recordProgress?: (progress: LongRunningProgress) => void;
}

/**
 * The Auto Debug loop both clients share: model turn, validator, bail on
 * evidence stall or round budget, and feed the previous round's evidence into
 * the next repair prompt. Clients inject only their turn and validator
 * callbacks, so the round budget, stall limit, prompt contract, and stop
 * reasons cannot drift apart between the TUI and the app-server again.
 */
export async function runAutoDebugLoop(options: AutoDebugLoopOptions): Promise<LongRunningResult> {
  const maxRounds = options.maxRounds ?? DEFAULT_AUTO_DEBUG_ROUNDS;
  const stallLimit = options.stallLimit ?? DEFAULT_AUTO_DEBUG_STALL_LIMIT;
  const runner = new LongRunningTaskRunner(maxRounds, stallLimit);
  let evidence: string | undefined;
  return runner.run(
    async (round, signal) => {
      const repair = round > 1;
      await options.runTurn(
        {
          round,
          maxRounds,
          repair,
          prompt: buildAutoDebugRoundPrompt({ goal: options.goal, round, maxRounds, evidence }),
        },
        signal,
      );
    },
    {
      run: async (signal) => {
        const result = await options.runValidator(signal);
        // Kept raw: the client redacts with its own active-secret set on entry
        // and the next prompt builder redacts again on the way out.
        evidence = result.evidence;
        return result;
      },
    },
    options.signal,
    options.recordProgress === undefined
      ? undefined
      : { store: { record: options.recordProgress } },
  );
}

/** Shared wording for a non-passing Auto Debug stop. */
export function describeAutoDebugStop(result: LongRunningResult): string {
  if (result.stopReason === "budget_exhausted")
    return `budget exhausted after ${result.rounds} rounds`;
  if (result.stopReason === "stall_detected")
    return `validator evidence stalled after ${result.rounds} rounds`;
  return result.stopReason;
}
