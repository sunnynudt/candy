import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_TOKEN_USAGE,
  addTokenUsage,
  billableTokens,
  isTokenUsage,
  normalizeTokenUsage,
} from "./usage.js";

test("billable tokens count fresh input plus output, never cached replays", () => {
  assert.equal(billableTokens(EMPTY_TOKEN_USAGE), 0);
  assert.equal(billableTokens({ input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 }), 1_200);
  // Cache reads are the provider's discounted context replay: they are part of
  // `input` and are not billed twice.
  assert.equal(billableTokens({ input: 1_000, output: 200, cacheRead: 800, cacheWrite: 0 }), 400);
  // A provider that reports more cache reads than input never goes negative.
  assert.equal(billableTokens({ input: 100, output: 50, cacheRead: 500, cacheWrite: 0 }), 50);
});

test("token usage adds field-wise and normalizes provider quirks", () => {
  const total = addTokenUsage(
    { input: 10, output: 2, cacheRead: 3, cacheWrite: 1 },
    { input: 5, output: 7, cacheRead: 0, cacheWrite: 4 },
  );
  assert.deepEqual(total, { input: 15, output: 9, cacheRead: 3, cacheWrite: 5 });
  assert.deepEqual(normalizeTokenUsage({ input: 1.4, output: Number.NaN }), {
    input: 1,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(isTokenUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), true);
  assert.equal(isTokenUsage({ input: 1, output: 2, cacheRead: 3 }), false);
  assert.equal(isTokenUsage({ input: -1, output: 2, cacheRead: 3, cacheWrite: 4 }), false);
});
