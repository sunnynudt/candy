import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_DEBUG_TURN_INSTRUCTION,
  DEFAULT_AUTO_DEBUG_ROUNDS,
  DEFAULT_AUTO_DEBUG_STALL_LIMIT,
  MAX_AUTO_DEBUG_EVIDENCE_CHARS,
  boundAutoDebugEvidence,
  buildAutoDebugRoundPrompt,
} from "./auto-debug.js";

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
