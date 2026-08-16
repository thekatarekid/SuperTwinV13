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

// ---------------------------------------------------------------------------
// [CODE] The four-way identity (arch §4.4.4)
//
//   total_input = cache_read + cache_creation + input_tokens
//
// `inputTokens` is NOT "the input": it counts only the tokens after the last
// cache breakpoint. Rendering it as the total is the bug that made a real
// 59,700-token call display as 17. Anything that wants "how much input did this
// cost" calls totalInputTokens(); anything that renders the parts renders all
// three AND the sum, via usageParts().
// ---------------------------------------------------------------------------

/** The weights `billableTokens` applies. Exported so the UI can state them. */
export const BILLABLE_WEIGHTS = {
  input: 1,
  cacheCreation: 1.25,
  cacheRead: 0.1,
  output: 1,
} as const;

export function totalInputTokens(u: Usage): number {
  return (
    u.cacheReadInputTokens + u.cacheCreationInputTokens + u.inputTokens
  );
}

/** The three input components plus their sum — never one without the others. */
export interface UsageParts {
  /** Tokens after the last cache breakpoint. Never label this "input total". */
  fresh: number;
  cacheWrite: number;
  cacheRead: number;
  /** fresh + cacheWrite + cacheRead. The honest "total input". */
  totalInput: number;
  output: number;
  billable: number;
}

export function usageParts(u: Usage): UsageParts {
  return {
    fresh: u.inputTokens,
    cacheWrite: u.cacheCreationInputTokens,
    cacheRead: u.cacheReadInputTokens,
    totalInput: totalInputTokens(u),
    output: u.outputTokens,
    billable: billableTokens(u),
  };
}

/** The identity is arithmetic, so this is a guard against bad row shapes. */
export function identityHolds(u: Usage & { totalInputTokens?: number }): boolean {
  if (u.totalInputTokens === undefined) return true;
  return u.totalInputTokens === totalInputTokens(u);
}

// ---------------------------------------------------------------------------
// [CODE] Caching reality (arch §4.4.3)
//
// Caching is measured, never assumed. A prompt shorter than its model's minimum
// cacheable prefix simply returns 0 in both cache fields — no error, no warning.
// Our haiku prompts are ~600–1,200 tokens against a 4,096 floor, so they will
// never cache and that is expected, not a defect to chase.
// ---------------------------------------------------------------------------

/** Minimum cacheable prefix by model family (§4.4.3.1). */
export const CACHE_MIN_PROMPT_TOKENS = {
  haiku: 4096,
  sonnet: 1024,
  opus: 1024,
} as const;

/** The minimum for a model id, or null when the family is unrecognised. */
export function cacheMinimumTokens(model: string | null | undefined): number | null {
  const m = (model ?? "").toLowerCase();
  if (m.includes("haiku")) return CACHE_MIN_PROMPT_TOKENS.haiku;
  if (m.includes("sonnet")) return CACHE_MIN_PROMPT_TOKENS.sonnet;
  if (m.includes("opus")) return CACHE_MIN_PROMPT_TOKENS.opus;
  return null;
}

/**
 * True when zero cache tokens are the *expected* outcome for this call: the
 * prompt is below the model's minimum cacheable prefix. Used to label a 0%
 * hit rate as documented behaviour rather than a broken cache.
 */
export function cacheBelowMinimum(
  model: string | null | undefined,
  promptTokens: number,
): boolean {
  const min = cacheMinimumTokens(model);
  return min !== null && promptTokens < min;
}

/**
 * Measured cache hit rate: the share of total input served from cache. Returns
 * null when nothing was spent — an unmeasured rate must not render as 0%.
 */
export function cacheHitRate(u: Usage): number | null {
  const total = totalInputTokens(u);
  if (total <= 0) return null;
  return u.cacheReadInputTokens / total;
}

// ---------------------------------------------------------------------------
// [CODE] Estimate before spending, project during it (arch §4.4.4.6)
//
// Both figures are extrapolations of COST THE CLI ALREADY REPORTED — a measured
// $/unit multiplied out. Neither consults a price table.
// ---------------------------------------------------------------------------

export interface SpendProjection {
  /** Cost the CLI has reported so far, verbatim-summed. */
  spentUsd: number;
  /** 0..1 — how much of the work is done. */
  fractionComplete: number;
  /** Projected total, or null while nothing is done (no basis to project on). */
  projectedTotalUsd: number | null;
  /** projectedTotal − spent, or null. Never negative. */
  remainingUsd: number | null;
}

export function projectSpend(params: {
  spentUsd: number;
  unitsDone: number;
  unitsTotal: number;
}): SpendProjection {
  const { spentUsd, unitsDone, unitsTotal } = params;
  const fractionComplete =
    unitsTotal > 0 ? Math.min(1, Math.max(0, unitsDone / unitsTotal)) : 0;
  if (unitsDone <= 0 || unitsTotal <= 0) {
    return { spentUsd, fractionComplete, projectedTotalUsd: null, remainingUsd: null };
  }
  const projectedTotalUsd = (spentUsd / unitsDone) * unitsTotal;
  return {
    spentUsd,
    fractionComplete,
    projectedTotalUsd,
    remainingUsd: Math.max(0, projectedTotalUsd - spentUsd),
  };
}

export interface SpendEstimate {
  eventCount: number;
  /** Measured billable tokens per event, from runs that already happened. */
  tokensPerEvent: number;
  /** Measured CLI cost per event. */
  usdPerEvent: number;
  projectedUsd: number;
  /** "measured" when history backed it; "none" when there is nothing to go on. */
  basis: "measured" | "none";
}

/**
 * Pre-flight estimate: event count × measured tokens-per-event (§4.4.4.6).
 * With no history there is no honest number, so it says so instead of guessing.
 */
export function estimateSpend(params: {
  eventCount: number;
  priorEvents: number;
  priorBillableTokens: number;
  priorCostUsd: number;
}): SpendEstimate {
  const { eventCount, priorEvents, priorBillableTokens, priorCostUsd } = params;
  if (priorEvents <= 0) {
    return {
      eventCount,
      tokensPerEvent: 0,
      usdPerEvent: 0,
      projectedUsd: 0,
      basis: "none",
    };
  }
  const tokensPerEvent = priorBillableTokens / priorEvents;
  const usdPerEvent = priorCostUsd / priorEvents;
  return {
    eventCount,
    tokensPerEvent,
    usdPerEvent,
    projectedUsd: usdPerEvent * eventCount,
    basis: "measured",
  };
}
