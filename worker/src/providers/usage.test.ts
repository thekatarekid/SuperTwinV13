import { describe, it, expect } from "vitest";

import { billableTokens, emptyUsage, hasSpend, sumUsage } from "./usage.js";
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
  it("weights cache writes at 1.25x and cache reads at 0.1x", () => {
    // 18 + 10651*1.25 + 48000*0.1 + 206
    expect(billableTokens(REAL_RUN)).toBe(18338);
  });

  it("stays far under the raw sum, which is what would trip the quota gate", () => {
    const raw =
      REAL_RUN.inputTokens +
      REAL_RUN.cacheCreationInputTokens +
      REAL_RUN.cacheReadInputTokens +
      REAL_RUN.outputTokens;
    expect(raw).toBe(58875);
    expect(billableTokens(REAL_RUN)).toBeLessThan(raw / 3);
  });

  it("is 0 for an empty accounting", () => {
    expect(billableTokens(emptyUsage())).toBe(0);
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
});

describe("hasSpend", () => {
  it("sees cache-only spend, which is where the tokens actually are", () => {
    expect(hasSpend(emptyUsage())).toBe(false);
    expect(hasSpend({ ...emptyUsage(), cacheReadInputTokens: 48000 })).toBe(
      true,
    );
  });
});
