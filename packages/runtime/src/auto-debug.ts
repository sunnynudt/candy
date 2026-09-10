import { redactCredentialMaterial } from "@candy/platform";

/**
 * Shared Auto Debug round policy (P5).
 *
 * Auto Debug is a Long-running Task strategy driven by an explicit validator.
 * Both clients (TUI and the app-server/WebUI backend) run their own turn loop,
 * but the round budget, the evidence bound, and the repair prompt contract are
 * shared here so the two surfaces cannot drift apart again (the TUI used 6
 * rounds while the app-server used 3 before this module existed).
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
  readonly evidence?: string;
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
