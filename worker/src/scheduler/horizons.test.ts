// ===========================================================================
// Modes, the horizon ladder, the adaptive ramp and pacing (arch §8.1–§8.3,
// §9.1, §9.2, §9.5.3, §9.7; evals T-013, T-015, T-016).
//
// The two things worth proving here are the ramp formula and the SIZING AXIS:
// cohort 0 closes on expected output tokens, so four noisy sessions and four
// quiet ones must produce different cohorts.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  BASE_BUDGET,
  BASE_OUTPUT_TOKENS,
  MAX_BUDGET,
  MAX_OUTPUT_TOKENS,
  cohortBudget,
  densityFactor,
  expectedOutputTokens,
  fillCohort,
  horizonLadder,
  horizonWindow,
  modeAfterBackfill,
  modeParams,
  nextHorizon,
  paceCohort,
  remainingMinutes,
  shrinkToDeadline,
  type SessionSize,
} from "./horizons.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

describe("operating modes (§8.1)", () => {
  it("seals immediately in bootstrap and debounces in steady", () => {
    expect(modeParams("bootstrap").sealImmediate).toBe(true);
    expect(modeParams("steady").sealImmediate).toBe(false);
  });

  it("runs the live delta trigger in steady state only (§8.3 guard 3)", () => {
    expect(modeParams("steady").liveTrigger).toBe(true);
    expect(modeParams("bootstrap").liveTrigger).toBe(false);
    expect(modeParams("reprocess").liveTrigger).toBe(false);
  });

  it("looks ahead 2 cohorts in bootstrap and 1 in steady (§9.4 rule 3)", () => {
    expect(modeParams("bootstrap").enrichLookahead).toBe(2);
    expect(modeParams("steady").enrichLookahead).toBe(1);
  });

  it("batches questions during an import, not after (§9.7 rule 4)", () => {
    expect(modeParams("bootstrap").questionsBatched).toBe(true);
    expect(modeParams("steady").questionsBatched).toBe(false);
  });

  it("flips to steady only when every stream says backfill_complete", () => {
    expect(modeAfterBackfill([{ backfillComplete: true }, { backfillComplete: false }])).toBe("bootstrap");
    expect(modeAfterBackfill([{ backfillComplete: true }, { backfillComplete: true }])).toBe("steady");
  });
});

describe("the horizon ladder (§9.2)", () => {
  it("descends live -> older", () => {
    expect(horizonLadder()).toEqual(["live", "h24", "d7", "d30", "d90", "y1", "older"]);
  });

  it("is contiguous — each rung starts where the one above ended", () => {
    const ladder = horizonLadder();
    for (let i = 1; i < ladder.length; i += 1) {
      const above = horizonWindow(ladder[i - 1]!, NOW);
      const below = horizonWindow(ladder[i]!, NOW);
      expect(below.hi).toBe(above.lo);
    }
  });

  it("leaves `older` unbounded at the bottom", () => {
    expect(horizonWindow("older", NOW).lo).toBe(Number.NEGATIVE_INFINITY);
    expect(nextHorizon("older")).toBeNull();
    expect(nextHorizon("live")).toBe("h24");
  });
});

describe("the adaptive ramp — cohort_budget(seq) = min(MAX, BASE x 2^seq)", () => {
  it("starts small at seq 0 (T-015)", () => {
    expect(cohortBudget(0)).toEqual({
      sessions: BASE_BUDGET.sessions,
      tokens: BASE_BUDGET.tokens,
      outputTokens: BASE_OUTPUT_TOKENS,
    });
  });

  it("doubles at seq 1 (T-016)", () => {
    expect(cohortBudget(1)).toEqual({ sessions: 8, tokens: 12_000, outputTokens: 1_200 });
  });

  it("walks 4 -> 8 -> 16 -> 24 and stops at the ceiling", () => {
    expect([0, 1, 2, 3, 4, 9].map((s) => cohortBudget(s).sessions)).toEqual([4, 8, 16, 24, 24, 24]);
    expect(cohortBudget(9).tokens).toBe(MAX_BUDGET.tokens);
    expect(cohortBudget(9).outputTokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("never overflows on an absurd seq", () => {
    expect(cohortBudget(1e9)).toEqual(cohortBudget(9));
  });
});

describe("sizing by expected OUTPUT tokens, not session count (§9.5.3 rule 2, T-013)", () => {
  const quiet = (id: string): SessionSize => ({ id, eventCount: 8, charCount: 8 * 55 });
  const noisy = (id: string): SessionSize => ({ id, eventCount: 40, charCount: 40 * 90 });

  it("estimates ~600 output tokens for four quiet sessions", () => {
    const four = ["a", "b", "c", "d"].map(quiet);
    const total = four.reduce((n, s) => n + expectedOutputTokens(s), 0);
    expect(total).toBeGreaterThanOrEqual(400);
    expect(total).toBeLessThanOrEqual(700);
  });

  it("takes all four quiet sessions into cohort 0", () => {
    const fill = fillCohort(["a", "b", "c", "d", "e"].map(quiet), cohortBudget(0));
    expect(fill.taken.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    expect(fill.closedBy).toBe("sessions");
  });

  it("takes FEWER noisy sessions for the same budget — the axis is output, not count", () => {
    const fill = fillCohort(["a", "b", "c", "d"].map(noisy), cohortBudget(0));
    expect(fill.taken.map((s) => s.id)).toEqual(["a"]);
    expect(fill.closedBy).toBe("output_tokens");
    // Session count would have taken all four; the output estimate takes one.
    expect(fillCohort(["a", "b", "c", "d"].map(quiet), cohortBudget(0)).taken).toHaveLength(4);
  });

  it("weighs density, so the same event count can be a different cohort", () => {
    expect(densityFactor(quiet("q"))).toBeLessThan(densityFactor(noisy("n")));
    expect(expectedOutputTokens({ id: "x", eventCount: 10, charCount: 600 })).toBeLessThan(
      expectedOutputTokens({ id: "y", eventCount: 10, charCount: 1_800 }),
    );
  });

  it("always takes at least one session — an empty cohort is a stalled pipeline", () => {
    const huge: SessionSize = { id: "huge", eventCount: 500, charCount: 500 * 200 };
    const fill = fillCohort([huge, quiet("b")], cohortBudget(0));
    expect(fill.taken.map((s) => s.id)).toEqual(["huge"]);
  });

  it("shrinks the OUTPUT budget to meet a deadline, never the stage list (§9.5.4 rule 2)", () => {
    const shrunk = shrinkToDeadline(cohortBudget(3), 10, 50);
    expect(shrunk.outputTokens).toBe(500);
    expect(shrunk.sessions).toBe(cohortBudget(3).sessions);
    // Comfortably inside the deadline: nothing is shrunk.
    expect(shrinkToDeadline(cohortBudget(0), 60, 50).outputTokens).toBe(BASE_OUTPUT_TOKENS);
  });
});

describe("pacing against the quota window (§9.7 rule 2)", () => {
  it("weighs billable tokens rather than summing raw ones", () => {
    const decision = paceCohort({
      inputTokens: 1_000,
      outputTokens: 600,
      cacheCreationTokens: 4_000,
      cacheReadTokens: 20_000,
      spentInWindow: 0,
      windowLimit: 1_000_000,
      windowRemainingMs: 0,
    });
    // 1000 + 4000*2.0 + 20000*0.1 + 600 = 11,600, not the raw 25,600.
    expect(decision.billable).toBe(11_600);
    expect(decision.admit).toBe(true);
  });

  it("degrades a large import to slower, never to failed", () => {
    const decision = paceCohort({
      inputTokens: 5_000,
      outputTokens: 1_000,
      spentInWindow: 99_000,
      windowLimit: 100_000,
      windowRemainingMs: 120_000,
    });
    expect(decision.admit).toBe(false);
    expect(decision.reason).toBe("paced");
    expect(decision.delayMs).toBe(120_000);
  });

  it("admits a cohort too big for any window rather than refusing it forever", () => {
    const decision = paceCohort({
      inputTokens: 500_000,
      outputTokens: 0,
      spentInWindow: 0,
      windowLimit: 100_000,
      windowRemainingMs: 60_000,
    });
    expect(decision.admit).toBe(true);
    expect(decision.reason).toBe("window_exhausted");
  });

  it("reports a remaining estimate only once a rate has been measured", () => {
    expect(remainingMinutes(1_204, 3_028, 130)).toBe(15);
    expect(remainingMinutes(0, 100, 0)).toBeNull();
  });
});
