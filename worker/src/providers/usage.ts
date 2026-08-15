// Token arithmetic over the Usage contract. Kept out of types.ts so that module
// stays declaration-only, and out of any single provider so the adapter, the
// quota gate and the run log all bill from ONE implementation.

import type { Usage } from "./types.js";

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  };
}

/** Combine two accountings — per-turn totals, or two attempts of one run. */
export function sumUsage(a: Usage, b: Usage): Usage {
  const out: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationInputTokens:
      a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  // Absent cost stays absent: a run that never reported one must not look like
  // it cost $0.
  if (a.costUsd !== undefined || b.costUsd !== undefined) {
    out.costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  }
  return out;
}

/**
 * Input-token equivalent actually billed. A cache read costs ~10% of a fresh
 * input token and a cache write ~125%, and the bulk of every run is cache, so
 * the quota gate counts this instead of the raw sum — raw would trip the window
 * roughly ten times sooner than real spend and lock the user out of chat.
 */
export function billableTokens(u: Usage): number {
  return Math.round(
    u.inputTokens +
      u.cacheCreationInputTokens * 1.25 +
      u.cacheReadInputTokens * 0.1 +
      u.outputTokens,
  );
}

/** True when anything at all was spent — used to prefer real numbers over 0. */
export function hasSpend(u: Usage): boolean {
  return (
    u.inputTokens > 0 ||
    u.cacheCreationInputTokens > 0 ||
    u.cacheReadInputTokens > 0 ||
    u.outputTokens > 0
  );
}
