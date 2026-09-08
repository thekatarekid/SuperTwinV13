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
  // it cost $0. The TTL split follows the same rule — a side whose wire carried
  // no breakdown must not be recorded as having written 0 five-minute tokens.
  if (a.costUsd !== undefined || b.costUsd !== undefined) {
    out.costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  }
  if (a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined) {
    out.cachedInputTokens =
      (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0);
  }
  if (
    a.cacheCreation5mInputTokens !== undefined ||
    b.cacheCreation5mInputTokens !== undefined
  ) {
    out.cacheCreation5mInputTokens =
      (a.cacheCreation5mInputTokens ?? 0) + (b.cacheCreation5mInputTokens ?? 0);
  }
  if (
    a.cacheCreation1hInputTokens !== undefined ||
    b.cacheCreation1hInputTokens !== undefined
  ) {
    out.cacheCreation1hInputTokens =
      (a.cacheCreation1hInputTokens ?? 0) + (b.cacheCreation1hInputTokens ?? 0);
  }
  return out;
}

/** The write half by TTL, plus whatever the wire never attributed to one. */
export interface CacheWriteParts {
  fiveMinute: number;
  oneHour: number;
  /** cacheCreation − the two above. Priced at `cacheCreationUnsplit`. */
  unsplit: number;
}

export function cacheWriteParts(u: Usage): CacheWriteParts {
  const fiveMinute = u.cacheCreation5mInputTokens ?? 0;
  const oneHour = u.cacheCreation1hInputTokens ?? 0;
  return {
    fiveMinute,
    oneHour,
    // Never negative: a wire that reports parts exceeding the total is broken,
    // and clamping keeps a broken line from crediting the bill.
    unsplit: Math.max(0, u.cacheCreationInputTokens - fiveMinute - oneHour),
  };
}

/**
 * Input-token equivalent actually billed. A cache read costs ~10% of a fresh
 * input token; a cache WRITE costs 125% at the 5-minute TTL and 200% at the
 * 1-hour TTL. The bulk of every run is cache, so the quota gate counts this
 * instead of the raw sum — raw would trip the window roughly ten times sooner
 * than real spend and lock the user out of chat.
 *
 * The two write TTLs are weighted apart because this build's CLI writes 1-HOUR
 * entries and flat-1.25 billing therefore under-counted by 31.5%. Two
 * independent measurements say so: the wire fixture in
 * claude-local/parser.test.ts carries `ephemeral_1h_input_tokens: 10472` with
 * `ephemeral_5m` at 0, and a least-squares fit of the stored real runs recovers
 * $2.04/MTok for the write against a $2.00 list price. Anything the wire did
 * not break out is therefore priced at the 1-hour rate too — see
 * BILLABLE_WEIGHTS.cacheCreationUnsplit.
 */
export function billableTokens(u: Usage): number {
  const w = BILLABLE_WEIGHTS;
  const c = cacheWriteParts(u);
  return Math.round(
    u.inputTokens * w.input +
      c.fiveMinute * w.cacheCreation5m +
      c.oneHour * w.cacheCreation1h +
      c.unsplit * w.cacheCreationUnsplit +
      u.cacheReadInputTokens * w.cacheRead +
      u.outputTokens * w.output,
  );
}

/** True when anything at all was spent — used to prefer real numbers over 0. */
export function hasSpend(u: Usage): boolean {
  return (
    u.inputTokens > 0 ||
    u.cacheCreationInputTokens > 0 ||
    u.cacheReadInputTokens > 0 ||
    (u.cachedInputTokens ?? 0) > 0 ||
    u.outputTokens > 0
  );
}

// ---------------------------------------------------------------------------
// [CODE] The four-way identity (arch §4.4.4)
//
//   Claude: total_input = cache_read + cache_creation + input_tokens
//   ChatGPT: total_input = input_tokens; cached_input is a subset
//
// Claude's `inputTokens` is NOT "the input": it counts only tokens after the
// last cache breakpoint. ChatGPT's `inputTokens` already includes its optional
// `cachedInputTokens` subset. Anything that wants the provider-correct total
// calls totalInputTokens(); anything rendering parts uses usageParts().
// ---------------------------------------------------------------------------

/** The weights `billableTokens` applies. Exported so the UI can state them. */
export const BILLABLE_WEIGHTS = {
  input: 1,
  /** 5-minute cache write. */
  cacheCreation5m: 1.25,
  /** 1-hour cache write — what this build's CLI actually writes. */
  cacheCreation1h: 2,
  /**
   * Cache writes the wire never attributed to a TTL. Priced at the 1-hour rate
   * because that is what the stored runs measure: a flat 1.25 here reads
   * 734,513 billable tokens over a dataset whose real figure is 1,072,001.
   */
  cacheCreationUnsplit: 2,
  cacheRead: 0.1,
  output: 1,
} as const;

export function totalInputTokens(u: Usage): number {
  return u.cacheReadInputTokens + u.cacheCreationInputTokens + u.inputTokens;
}

/**
 * Cache reads reported across the two provider-specific fields. They remain
 * separate in Usage because pricing is provider-specific, but are one logical
 * component when displaying total input or calculating a measured hit rate.
 */
export function totalCachedInputTokens(u: Usage): number {
  return u.cacheReadInputTokens + (u.cachedInputTokens ?? 0);
}

/** The three input components plus their sum — never one without the others. */
export interface UsageParts {
  /** Provider-normalized input not served from cache. */
  fresh: number;
  cacheWrite: number;
  cacheRead: number;
  /** fresh + cacheWrite + cacheRead. The honest "total input". */
  totalInput: number;
  output: number;
  billable: number;
}

export function usageParts(u: Usage): UsageParts {
  const providerNeutralCacheRead = u.cachedInputTokens ?? 0;
  return {
    // ChatGPT reports cachedInputTokens as a subset of inputTokens. Claude's
    // cacheReadInputTokens is separate from inputTokens. Normalize the display
    // parts without changing either provider's stored accounting semantics.
    fresh: Math.max(0, u.inputTokens - providerNeutralCacheRead),
    cacheWrite: u.cacheCreationInputTokens,
    cacheRead: totalCachedInputTokens(u),
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
  return totalCachedInputTokens(u) / total;
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
