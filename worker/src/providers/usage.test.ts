import { describe, it, expect } from "vitest";

import {
  billableTokens,
  cacheBelowMinimum,
  cacheHitRate,
  cacheMinimumTokens,
  emptyUsage,
  estimateSpend,
  hasSpend,
  identityHolds,
  projectSpend,
  sumUsage,
  totalCachedInputTokens,
  totalInputTokens,
  usageParts,
} from "./usage.js";
import type { Usage } from "./types.js";

/** The measured 2-turn media-shaped run (see parser.test.ts fixtures). */
const REAL_RUN: Usage = {
  inputTokens: 18,
  cacheCreationInputTokens: 10651,
  cacheReadInputTokens: 48000,
  outputTokens: 206,
  costUsd: 0.02715,
};

describe("billableTokens", () => {
  it("weights 1-hour cache writes at 2x and cache reads at 0.1x", () => {
    // 18 + 10651*2.0 + 48000*0.1 + 206 — the writes are unattributed here, and
    // an unattributed write bills at the 1-hour rate this build's CLI charges.
    expect(billableTokens(REAL_RUN)).toBe(26326);
  });

  it("stays far under the raw sum, which is what would trip the quota gate", () => {
    const raw =
      REAL_RUN.inputTokens +
      REAL_RUN.cacheCreationInputTokens +
      REAL_RUN.cacheReadInputTokens +
      REAL_RUN.outputTokens;
    expect(raw).toBe(58875);
    expect(billableTokens(REAL_RUN)).toBeLessThan(raw / 2);
  });

  it("is 0 for an empty accounting", () => {
    expect(billableTokens(emptyUsage())).toBe(0);
  });

  it("does not apply Claude's 10% price to provider-neutral cached input", () => {
    expect(
      billableTokens({ ...emptyUsage(), inputTokens: 100, cachedInputTokens: 80 }),
    ).toBe(100);
  });
});

describe("sumUsage", () => {
  it("adds every token field", () => {
    const a: Usage = {
      inputTokens: 10,
      cacheCreationInputTokens: 10472,
      cacheReadInputTokens: 18764,
      outputTokens: 149,
    };
    const b: Usage = {
      inputTokens: 8,
      cacheCreationInputTokens: 179,
      cacheReadInputTokens: 29236,
      outputTokens: 57,
    };
    expect(sumUsage(a, b)).toEqual({
      inputTokens: 18,
      cacheCreationInputTokens: 10651,
      cacheReadInputTokens: 48000,
      outputTokens: 206,
    });
  });

  it("leaves cost absent unless a side reported one", () => {
    expect(sumUsage(emptyUsage(), emptyUsage()).costUsd).toBeUndefined();
    expect(sumUsage(emptyUsage(), REAL_RUN).costUsd).toBeCloseTo(0.02715);
    expect(sumUsage(REAL_RUN, REAL_RUN).costUsd).toBeCloseTo(0.0543);
  });

  it("preserves absent cached input and sums it only when reported", () => {
    expect(sumUsage(emptyUsage(), emptyUsage()).cachedInputTokens).toBeUndefined();
    expect(
      sumUsage(
        { ...emptyUsage(), cachedInputTokens: 0 },
        { ...emptyUsage(), cachedInputTokens: 120 },
      ).cachedInputTokens,
    ).toBe(120);
  });
});

describe("hasSpend", () => {
  it("sees cache-only spend, which is where the tokens actually are", () => {
    expect(hasSpend(emptyUsage())).toBe(false);
    expect(hasSpend({ ...emptyUsage(), cacheReadInputTokens: 48000 })).toBe(
      true,
    );
    expect(hasSpend({ ...emptyUsage(), cachedInputTokens: 1 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Arch §4.4.4 — the identity, and the bug it exists to stop.
// ---------------------------------------------------------------------------

describe("totalInputTokens", () => {
  it("U-001: is cache_read + cache_creation + input_tokens", () => {
    expect(totalInputTokens(REAL_RUN)).toBe(58_669);
    expect(totalInputTokens(REAL_RUN)).toBe(
      REAL_RUN.cacheReadInputTokens +
        REAL_RUN.cacheCreationInputTokens +
        REAL_RUN.inputTokens,
    );
  });

  it("U-002: is not input_tokens — that field is post-breakpoint only", () => {
    // The prior bug: this real call displayed as "17 input tokens".
    expect(REAL_RUN.inputTokens).toBe(18);
    expect(totalInputTokens(REAL_RUN)).toBeGreaterThan(
      REAL_RUN.inputTokens * 1000,
    );
  });

  it("is 0 for an empty accounting", () => {
    expect(totalInputTokens(emptyUsage())).toBe(0);
  });

  it("does not double-count provider-neutral cached input, which is an input subset", () => {
    const usage = { ...emptyUsage(), inputTokens: 100, cachedInputTokens: 80 };
    expect(totalInputTokens(usage)).toBe(100);
    expect(totalCachedInputTokens(usage)).toBe(80);
    expect(usage.cacheReadInputTokens).toBe(0);
  });

  it("retains both cache-read fields in a mixed-provider aggregate", () => {
    const usage = {
      ...emptyUsage(),
      inputTokens: 100,
      cacheReadInputTokens: 20,
      cachedInputTokens: 80,
    };
    expect(totalInputTokens(usage)).toBe(120);
    expect(totalCachedInputTokens(usage)).toBe(100);
    expect(usageParts(usage)).toMatchObject({
      fresh: 20,
      cacheWrite: 0,
      cacheRead: 100,
      totalInput: 120,
    });
    expect(cacheHitRate(usage)).toBeCloseTo(100 / 120, 10);
  });
});

describe("usageParts", () => {
  it("U-003: hands back the three components AND their sum together", () => {
    const p = usageParts(REAL_RUN);
    expect(p).toEqual({
      fresh: 18,
      cacheWrite: 10_651,
      cacheRead: 48_000,
      totalInput: 58_669,
      output: 206,
      billable: 26_326,
    });
    // The sum is derived from the parts, so no surface can show one without
    // the other and read as two separate spends.
    expect(p.fresh + p.cacheWrite + p.cacheRead).toBe(p.totalInput);
  });

  it("identityHolds rejects a row whose stated total disagrees", () => {
    expect(identityHolds(REAL_RUN)).toBe(true);
    expect(identityHolds({ ...REAL_RUN, totalInputTokens: 58_669 })).toBe(true);
    expect(identityHolds({ ...REAL_RUN, totalInputTokens: 18 })).toBe(false);
  });

  it("reports provider-neutral cached input as cache read without repricing it", () => {
    expect(
      usageParts({ ...emptyUsage(), inputTokens: 100, cachedInputTokens: 80 }),
    ).toEqual({
      fresh: 20,
      cacheWrite: 0,
      cacheRead: 80,
      totalInput: 100,
      output: 0,
      billable: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// Arch §4.4.3 — caching is measured, never assumed.
// ---------------------------------------------------------------------------

describe("cache minimums", () => {
  it("knows the per-family minimum cacheable prefix", () => {
    expect(cacheMinimumTokens("claude-haiku-4.5")).toBe(4096);
    expect(cacheMinimumTokens("claude-sonnet-5")).toBe(1024);
    expect(cacheMinimumTokens("claude-opus-4.1")).toBe(1024);
    expect(cacheMinimumTokens("some-other-model")).toBeNull();
    expect(cacheMinimumTokens(null)).toBeNull();
  });

  it("U-011: a 1.2k-token haiku prompt is below the floor — 0 cache is expected", () => {
    expect(cacheBelowMinimum("claude-haiku-4.5", 1200)).toBe(true);
    expect(cacheBelowMinimum("claude-haiku-4.5", 5000)).toBe(false);
    // The same prompt on sonnet is over its 1,024 floor and should cache.
    expect(cacheBelowMinimum("claude-sonnet-5", 1200)).toBe(false);
  });

  it("makes no claim about a family it does not know", () => {
    expect(cacheBelowMinimum("mystery-model", 10)).toBe(false);
  });
});

describe("cacheHitRate", () => {
  it("U-012: is measured off the four fields", () => {
    expect(cacheHitRate(REAL_RUN)).toBeCloseTo(48_000 / 58_669, 10);
  });

  it("is null when nothing ran — an unmeasured rate is not 0%", () => {
    expect(cacheHitRate(emptyUsage())).toBeNull();
  });

  it("is 0 when a real call genuinely cached nothing", () => {
    expect(
      cacheHitRate({ ...emptyUsage(), inputTokens: 1200, outputTokens: 90 }),
    ).toBe(0);
  });

  it("uses provider-neutral cached input when that is what the provider reports", () => {
    expect(
      cacheHitRate({ ...emptyUsage(), inputTokens: 100, cachedInputTokens: 80 }),
    ).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// Arch §4.4.4.6 — estimate before spending, project during it.
// ---------------------------------------------------------------------------

describe("projectSpend", () => {
  it("U-010: extrapolates spend-to-date over the remaining work", () => {
    const p = projectSpend({ spentUsd: 2.21, unitsDone: 1000, unitsTotal: 4000 });
    expect(p.fractionComplete).toBeCloseTo(0.25, 10);
    expect(p.projectedTotalUsd!).toBeCloseTo(8.84, 10);
    expect(p.remainingUsd!).toBeCloseTo(6.63, 10);
  });

  it("projects nothing while nothing is done", () => {
    const p = projectSpend({ spentUsd: 0.2, unitsDone: 0, unitsTotal: 500 });
    expect(p.projectedTotalUsd).toBeNull();
    expect(p.remainingUsd).toBeNull();
    expect(p.fractionComplete).toBe(0);
  });

  it("never reports negative work left, or more than 100% done", () => {
    const p = projectSpend({ spentUsd: 9, unitsDone: 500, unitsTotal: 400 });
    expect(p.fractionComplete).toBe(1);
    expect(p.remainingUsd).toBe(0);
  });
});

describe("estimateSpend", () => {
  it("U-009: event count x measured tokens-per-event", () => {
    const e = estimateSpend({
      eventCount: 3000,
      priorEvents: 1000,
      priorBillableTokens: 5_000_000,
      priorCostUsd: 2,
    });
    expect(e.basis).toBe("measured");
    expect(e.tokensPerEvent).toBe(5000);
    expect(e.usdPerEvent).toBeCloseTo(0.002, 10);
    expect(e.projectedUsd).toBeCloseTo(6, 10);
  });

  it("declines to guess with no history behind it", () => {
    const e = estimateSpend({
      eventCount: 3000,
      priorEvents: 0,
      priorBillableTokens: 0,
      priorCostUsd: 0,
    });
    expect(e.basis).toBe("none");
    expect(e.projectedUsd).toBe(0);
  });
});
