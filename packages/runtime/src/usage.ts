/**
 * Provider token usage shared by the adapter, the runtime goal policy, and the
 * platform budget store (P4).
 *
 * The adapter reports provider usage verbatim (Pi's `Usage` shape minus cost);
 * Candy derives one billable number from it with {@link billableTokens}. The
 * billable口径 is deliberately a single pure function: it is the only place a
 * later slice has to change if a live provider contract check disagrees.
 */

/** Tokens a provider reported for one model call. */
export interface ProviderTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const EMPTY_TOKEN_USAGE: ProviderTokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Clamp unknown or provider-quirk values into a non-negative token record. */
export function normalizeTokenUsage(usage: Partial<ProviderTokenUsage>): ProviderTokenUsage {
  return {
    input: nonNegativeInteger(usage.input ?? 0),
    output: nonNegativeInteger(usage.output ?? 0),
    cacheRead: nonNegativeInteger(usage.cacheRead ?? 0),
    cacheWrite: nonNegativeInteger(usage.cacheWrite ?? 0),
  };
}

/** Field-wise sum, used to accumulate every model call inside one turn. */
export function addTokenUsage(
  left: ProviderTokenUsage,
  right: ProviderTokenUsage,
): ProviderTokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  };
}

/**
 * Candy's provisional billable-token口径: fresh input (input beyond cache reads)
 * plus output. `cacheWrite` is part of `input` and `cacheRead` is the provider's
 * discounted context replay, so neither is counted twice.
 *
 * Live contract check: `npm run gate:live:deepseek --confirm-live` must confirm
 * that `input` already includes cached tokens for the selected provider; if a
 * provider reports them separately, this function is the only place to change.
 */
export function billableTokens(usage: ProviderTokenUsage): number {
  return Math.max(0, usage.input - usage.cacheRead) + usage.output;
}

/** True when a value is a complete, non-negative token record. */
export function isTokenUsage(value: unknown): value is ProviderTokenUsage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (["input", "output", "cacheRead", "cacheWrite"] as const).every((key) => {
    const field = record[key];
    return typeof field === "number" && Number.isSafeInteger(field) && field >= 0;
  });
}
