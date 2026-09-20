import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_DEBUG_TURN_INSTRUCTION,
  DEFAULT_AUTO_DEBUG_ROUNDS,
  DEFAULT_AUTO_DEBUG_STALL_LIMIT,
  MAX_AUTO_DEBUG_EVIDENCE_CHARS,
  boundAutoDebugEvidence,
  buildAutoDebugRoundPrompt,
  describeAutoDebugStop,
  runAutoDebugLoop,
} from "./auto-debug.js";
import type { LongRunningProgress, ValidatorResult } from "./v1.js";

test("both clients share one Auto Debug budget and banner", () => {
  assert.equal(DEFAULT_AUTO_DEBUG_ROUNDS, 6);
  assert.equal(DEFAULT_AUTO_DEBUG_STALL_LIMIT, 2);
  assert.match(AUTO_DEBUG_TURN_INSTRUCTION, /\[AUTO-DEBUG\]/u);
  assert.match(AUTO_DEBUG_TURN_INSTRUCTION, /validator/u);
});

test("round one repeats the goal and repair rounds carry bounded evidence", () => {
  const goal = `${AUTO_DEBUG_TURN_INSTRUCTION}Fix the failing suite`;
  assert.equal(buildAutoDebugRoundPrompt({ goal, round: 1, maxRounds: 6 }), goal);
  const repair = buildAutoDebugRoundPrompt({
    goal,
    round: 2,
    maxRounds: 6,
    evidence: "FAIL src/example.test.ts\n  expected 1 to equal 2",
  });
  assert.match(repair, /Fix the failing suite/u);
  assert.match(repair, /\[VERIFIER FAILED\] round 2 of 6; bounded evidence:/u);
  assert.match(repair, /expected 1 to equal 2/u);
  assert.match(repair, /Fix the root cause and re-verify/u);
});

test("repair evidence is redacted, sanitized, and bounded", () => {
  const placeholder = ["local", "placeholder", "value"].join("-");
  const shaped = ["tok", "en=", placeholder, " rejected"].join("");
  const withPlaceholder = boundAutoDebugEvidence(`${shaped} by the provider`, {
    activeSecrets: [placeholder],
  });
  assert.equal(withPlaceholder.includes(placeholder), false);
  assert.match(withPlaceholder, /\[REDACTED\]/u);
  assert.equal(boundAutoDebugEvidence("line\u0007one\u0000"), "line one");
  assert.equal(boundAutoDebugEvidence("   "), "(no validator evidence was captured)");
  const long = boundAutoDebugEvidence("x".repeat(5_000));
  assert.ok(long.length < 5_000);
  assert.ok(long.endsWith("[evidence truncated by Candy]"));
  assert.ok(long.length <= MAX_AUTO_DEBUG_EVIDENCE_CHARS + 64);
  const small = boundAutoDebugEvidence("0123456789".repeat(20), { maxEvidenceChars: 64 });
  assert.ok(small.length <= 64 + "\n[evidence truncated by Candy]".length);
});

/** A validator that fails with the given evidence until its script runs out. */
function scriptedValidator(
  script: readonly { readonly ok: boolean; readonly evidence: string }[],
): { run: (signal: AbortSignal) => Promise<ValidatorResult>; readonly calls: number[] } {
  const calls: number[] = [];
  let index = 0;
  return {
    calls,
    run: async (): Promise<ValidatorResult> => {
      calls.push(index);
      const step = script[Math.min(index, script.length - 1)] ?? { ok: true, evidence: "" };
      index += 1;
      return {
        ok: step.ok,
        fingerprint: `${step.ok ? "ok" : "fail"}:${step.evidence}`,
        evidence: step.evidence,
        durationMs: 1,
      };
    },
  };
}

test("the shared Auto Debug loop stops as soon as the validator passes", async () => {
  const prompts: string[] = [];
  const progress: LongRunningProgress[] = [];
  const validator = scriptedValidator([{ ok: true, evidence: "validator passed" }]);
  const result = await runAutoDebugLoop({
    goal: "Fix the failing suite",
    signal: new AbortController().signal,
    runTurn: async (round) => {
      prompts.push(round.prompt);
    },
    runValidator: (signal) => validator.run(signal),
    recordProgress: (entry) => progress.push(entry),
  });

  assert.equal(result.completed, true);
  assert.equal(result.stopReason, "validator_succeeded");
  assert.equal(result.rounds, 1);
  assert.deepEqual(prompts, ["Fix the failing suite"]);
  assert.equal(progress.at(-1)?.completed, true);
  assert.equal(progress.at(-1)?.rounds, 1);
});

test("repair rounds receive the previous round's validator evidence", async () => {
  const rounds: { readonly round: number; readonly repair: boolean; readonly prompt: string }[] =
    [];
  const validator = scriptedValidator([
    { ok: false, evidence: "first failure" },
    { ok: false, evidence: "second failure" },
    { ok: true, evidence: "validator passed" },
  ]);
  const result = await runAutoDebugLoop({
    goal: "Fix the failing suite",
    signal: new AbortController().signal,
    runTurn: async (round) => {
      rounds.push({ round: round.round, repair: round.repair, prompt: round.prompt });
    },
    runValidator: (signal) => validator.run(signal),
  });

  assert.equal(result.completed, true);
  assert.equal(result.rounds, 3);
  assert.deepEqual(
    rounds.map((entry) => entry.round),
    [1, 2, 3],
  );
  assert.equal(rounds[0]?.repair, false);
  assert.equal(rounds[0]?.prompt, "Fix the failing suite");
  assert.match(rounds[1]?.prompt ?? "", /\[VERIFIER FAILED\] round 2 of 6/u);
  assert.match(rounds[1]?.prompt ?? "", /first failure/u);
  assert.match(rounds[2]?.prompt ?? "", /second failure/u);
  // Every round still repeats the goal the task was created with.
  for (const entry of rounds) assert.match(entry.prompt, /Fix the failing suite/u);
});

test("the shared Auto Debug loop stops on a stalled fingerprint and on budget", async () => {
  const stalled = scriptedValidator([{ ok: false, evidence: "identical failure" }]);
  const stallResult = await runAutoDebugLoop({
    goal: "Fix the failing suite",
    signal: new AbortController().signal,
    runTurn: async () => undefined,
    runValidator: (signal) => stalled.run(signal),
  });
  assert.equal(stallResult.completed, false);
  assert.equal(stallResult.stopReason, "stall_detected");
  assert.equal(stallResult.rounds, DEFAULT_AUTO_DEBUG_STALL_LIMIT + 1);
  assert.equal(
    describeAutoDebugStop(stallResult),
    `validator evidence stalled after ${DEFAULT_AUTO_DEBUG_STALL_LIMIT + 1} rounds`,
  );

  let failure = 0;
  const budgetResult = await runAutoDebugLoop({
    goal: "Fix the failing suite",
    signal: new AbortController().signal,
    runTurn: async () => undefined,
    runValidator: async () => ({
      ok: false,
      fingerprint: `distinct-${(failure += 1)}`,
      evidence: `distinct failure ${failure}`,
      durationMs: 1,
    }),
  });
  assert.equal(budgetResult.completed, false);
  assert.equal(budgetResult.stopReason, "budget_exhausted");
  assert.equal(budgetResult.rounds, DEFAULT_AUTO_DEBUG_ROUNDS);
  assert.equal(
    describeAutoDebugStop(budgetResult),
    `budget exhausted after ${DEFAULT_AUTO_DEBUG_ROUNDS} rounds`,
  );
});

test("an aborted Auto Debug run stops instead of starting another round", async () => {
  const abort = new AbortController();
  const prompts: string[] = [];
  const result = await runAutoDebugLoop({
    goal: "Fix the failing suite",
    signal: abort.signal,
    runTurn: async (round) => {
      prompts.push(round.prompt);
      abort.abort(new Error("user cancelled"));
    },
    runValidator: async () => ({
      ok: false,
      fingerprint: "failure",
      evidence: "failure",
      durationMs: 1,
    }),
  });

  assert.equal(result.completed, false);
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.rounds, 1);
  assert.equal(prompts.length, 1, "no round starts after the run was cancelled");
});
