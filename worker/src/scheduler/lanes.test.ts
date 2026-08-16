// ===========================================================================
// The two lanes, stalls, pauses and the live trigger (arch §8.3, §9.4, §9.6,
// §9.7; evals T-012, T-017…T-030).
//
// The load-bearing assertion is the one that is easiest to lose: LANE U NEVER
// WAITS FOR LANE E. It is tested by giving U a queue whose enrichment has not
// started at all and requiring U to run anyway, with placeholders.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  CONVERSATION_GAP_MS,
  IdleTracker,
  LIVE_INTERVAL_MAX_MS,
  LIVE_INTERVAL_MIN_MS,
  LIVE_PASSES_PER_HOUR,
  REPROCESS_MAX,
  clampLiveInterval,
  consolidationAtSeal,
  deltaPassCost,
  effectiveInterval,
  episodePassPlan,
  formatCountdown,
  laneSlots,
  laneTick,
  liveTrigger,
  mediaOrderInversions,
  pauseState,
  understandingBlocked,
  wholeSessionPassCost,
  type CohortLaneState,
} from "./lanes.js";

const cohort = (id: string, over: Partial<CohortLaneState> = {}): CohortLaneState => ({
  cohortId: id,
  enriched: false,
  understood: false,
  unreadAttachments: 0,
  ...over,
});

describe("slot reservation (§9.5.3 rule 1, T-012)", () => {
  it("gives Lane E ZERO slots during first paint", () => {
    expect(laneSlots(8, false)).toEqual({ enrichment: 0, understanding: 8 });
  });

  it("resumes the 40/60 split once first paint completes", () => {
    expect(laneSlots(10, true)).toEqual({ enrichment: 4, understanding: 6 });
  });
});

describe("the two lanes never block each other (§9.4)", () => {
  it("runs understanding on a cohort whose enrichment has not started", () => {
    const queue = [cohort("c0", { unreadAttachments: 3 })];
    const steps = laneTick(queue, { mode: "bootstrap" });
    const u = steps.find((s) => s.lane === "understanding");
    expect(u?.cohortId).toBe("c0");
    // Unread attachments become explicit placeholders, never a wait (§9.6 r7).
    expect(u?.placeholders).toBe(3);
    expect(understandingBlocked(queue, steps)).toEqual([]);
  });

  it("keeps Lane E two cohorts ahead in bootstrap and one in steady", () => {
    const queue = [cohort("c0"), cohort("c1"), cohort("c2")];
    const boot = laneTick(queue, { mode: "bootstrap" }).filter((s) => s.lane === "enrichment");
    const steady = laneTick(queue, { mode: "steady" }).filter((s) => s.lane === "enrichment");
    expect(boot.map((s) => s.cohortId)).toEqual(["c0", "c1"]);
    expect(steady.map((s) => s.cohortId)).toEqual(["c0"]);
  });

  it("keeps E going while U is paused on quota, deepening the lookahead", () => {
    const queue = [cohort("c0"), cohort("c1")];
    const steps = laneTick(queue, { mode: "bootstrap", pausedLanes: ["understanding"] });
    expect(steps.every((s) => s.lane === "enrichment")).toBe(true);
    expect(understandingBlocked(queue, steps, ["understanding"])).toEqual([]);
  });

  it("keeps U going while E is paused", () => {
    const steps = laneTick([cohort("c0")], { mode: "bootstrap", pausedLanes: ["enrichment"] });
    expect(steps.map((s) => s.lane)).toEqual(["understanding"]);
  });

  it("names the blocked cohort if U ever sits out an unpaused tick", () => {
    const queue = [cohort("c0")];
    expect(understandingBlocked(queue, [])).toEqual(["c0"]);
  });
});

describe("the no-stall clock (§9.7 rule 1, T-023…T-025)", () => {
  it("measures the longest silence between completed units", () => {
    const t = new IdleTracker(0);
    t.beat(20_000);
    t.beat(50_000);
    const report = t.report(95_000);
    expect(report.maxIdleGapSeconds).toBe(45);
  });

  it("excludes a quota pause — a countdown is not a stall (§9.4 rule 5)", () => {
    const t = new IdleTracker(0);
    t.beat(10_000);
    t.pause({ fromMs: 10_000, toMs: 130_000, reason: "quota" });
    t.beat(140_000);
    expect(t.report(140_000).maxIdleGapSeconds).toBe(10);
    expect(t.report(140_000).pausedSeconds).toBe(120);
  });

  it("subtracts only the OVERLAP, so silence around a pause still counts", () => {
    const t = new IdleTracker(0);
    t.pause({ fromMs: 30_000, toMs: 90_000, reason: "quota" });
    t.beat(150_000);
    expect(t.report(150_000).maxIdleGapSeconds).toBe(90);
  });

  it("closes the final gap against now, not against the last beat", () => {
    const t = new IdleTracker(0);
    t.beat(1_000);
    expect(t.report(100_000).maxIdleGapSeconds).toBe(99);
  });
});

describe("a pause renders a countdown (§14.0 rule 2, T-026)", () => {
  it("says what it is waiting for and for how long", () => {
    const state = pauseState({ fromMs: 0, toMs: 252_000, reason: "quota" }, 0);
    expect(state.label).toBe("paused — rate limit, resumes in 04:12");
    expect(state.remainingSeconds).toBe(252);
  });

  it("never spends the unit's retry budget on an outage (§4.6)", () => {
    expect(pauseState({ fromMs: 0, toMs: 60_000, reason: "quota" }, 0).retryBudgetSpent).toBe(false);
  });

  it("clears once the pause has expired", () => {
    expect(pauseState({ fromMs: 0, toMs: 60_000, reason: "quota" }, 60_000).paused).toBe(false);
  });

  it("formats mm:ss", () => {
    expect(formatCountdown(5)).toBe("00:05");
    expect(formatCountdown(3_599)).toBe("59:59");
  });
});

describe("the live trigger (§8.3, T-017…T-021)", () => {
  const base = {
    mode: "steady" as const,
    liveIntervalMs: 30_000,
    quietMs: 0,
    newEvents: 0,
    passesThisHour: 0,
  };

  it("fires after live_interval of quiet, visible within interval + 15 s", () => {
    const decision = liveTrigger({ ...base, quietMs: 30_000 });
    expect(decision.fires).toBe(true);
    expect(decision.reason).toBe("quiet");
    expect(decision.visibilitySeconds).toBeLessThanOrEqual(30 + 15);
  });

  it("also fires on K new events", () => {
    expect(liveTrigger({ ...base, newEvents: 10 }).reason).toBe("event_count");
  });

  it("never fires in bootstrap — immediate-seal owns that path (guard 3)", () => {
    expect(liveTrigger({ ...base, mode: "bootstrap", quietMs: 600_000 }).fires).toBe(false);
  });

  it("effectively never fires at a 6 h interval (T-018)", () => {
    const decision = liveTrigger({ ...base, liveIntervalMs: LIVE_INTERVAL_MAX_MS, quietMs: 5 * 3_600_000, newEvents: 40 });
    expect(decision.fires).toBe(false);
    expect(decision.intervalMs).toBe(CONVERSATION_GAP_MS);
  });

  it("clamps the setting to 30 s – 6 h", () => {
    expect(clampLiveInterval(1_000)).toBe(LIVE_INTERVAL_MIN_MS);
    expect(clampLiveInterval(99 * 3_600_000)).toBe(LIVE_INTERVAL_MAX_MS);
  });

  it("lengthens the interval on a 50-message burst and SAYS SO (guard 1, T-020)", () => {
    const busy = effectiveInterval(30_000, 50);
    expect(busy.backpressure).toBe(true);
    expect(busy.intervalMs).toBe(120_000);
    expect(busy.label).toBe("high activity — batching every 2 min");
    // A calm stream is not throttled and shows no label.
    expect(effectiveInterval(30_000, 2)).toEqual({ intervalMs: 30_000, backpressure: false, label: "" });
  });

  it("does not stretch a torrent — the base interval already collects full batches", () => {
    expect(effectiveInterval(30_000, 400).intervalMs).toBe(30_000);
  });

  it("shows the stretched interval on the trigger decision, not just in a label", () => {
    const decision = liveTrigger({ ...base, quietMs: 40_000, eventsInLastTenMinutes: 50 });
    expect(decision.intervalMs).toBe(120_000);
    expect(decision.fires).toBe(false); // 40 s of quiet does not clear 2 min
    expect(decision.backpressureLabel).toMatch(/high activity/);
  });

  it("caps at 20 passes per stream per hour (guard 2, T-021)", () => {
    const decision = liveTrigger({ ...base, quietMs: 60_000, passesThisHour: LIVE_PASSES_PER_HOUR });
    expect(decision.fires).toBe(false);
    expect(decision.reason).toBe("capped");
  });
});

describe("delta extraction is mandatory (§8.3, T-019)", () => {
  it("scales linearly in session length where a whole re-read is quadratic", () => {
    const delta40 = deltaPassCost(40);
    const whole40 = wholeSessionPassCost(40);
    expect(delta40.growth).toBe("linear");
    expect(delta40.inputTokens).toBeLessThan(whole40.inputTokens);

    // Doubling the session doubles delta cost; the whole-read path more than
    // doubles — that is the O(n) vs O(n^2) claim, measured.
    const ratioDelta = deltaPassCost(80).inputTokens / delta40.inputTokens;
    const ratioWhole = wholeSessionPassCost(80).inputTokens / whole40.inputTokens;
    expect(ratioDelta).toBeLessThan(2.1);
    expect(ratioWhole).toBeGreaterThan(ratioDelta);
  });

  it("skips consolidation at seal when the hash is unchanged (T-022)", () => {
    expect(consolidationAtSeal({ contentHash: "h1", lastConsolidatedHash: "h1" })).toEqual({
      runs: false,
      reason: "hash_unchanged",
    });
    expect(consolidationAtSeal({ contentHash: "h2", lastConsolidatedHash: "h1" }).runs).toBe(true);
    expect(consolidationAtSeal({ contentHash: "h1", lastConsolidatedHash: null }).runs).toBe(true);
  });
});

describe("media never blocks text (§9.6, T-028…T-030)", () => {
  it("gives an episode with media exactly two passes", () => {
    const plan = episodePassPlan({ hasMedia: true, pendingEnrichment: 2, reprocessCount: 0 });
    expect(plan.passes).toBe(2);
    expect(plan.flaggedForReconcile).toBe(false);
  });

  it("leaves a text-only episode at one pass", () => {
    expect(episodePassPlan({ hasMedia: false, pendingEnrichment: 0, reprocessCount: 0 }).passes).toBe(1);
  });

  it("bounds reprocessing at 3 and flags the episode instead of looping", () => {
    const plan = episodePassPlan({ hasMedia: true, pendingEnrichment: 0, reprocessCount: REPROCESS_MAX });
    expect(plan.passes).toBe(REPROCESS_MAX);
    expect(plan.flaggedForReconcile).toBe(true);
    expect(episodePassPlan({ hasMedia: true, pendingEnrichment: 0, reprocessCount: 1, lateArrivals: 5 }).passes).toBe(
      REPROCESS_MAX,
    );
  });

  it("orders the media queue by cohort priority, never FIFO (§9.6 rule 1)", () => {
    const byPriority = [
      { id: "hour-old", priority: 4_000_999_000 },
      { id: "from-2023", priority: 4_000_100_000 },
    ];
    expect(mediaOrderInversions(byPriority)).toEqual([]);
    expect(mediaOrderInversions([...byPriority].reverse())).toEqual([{ before: "from-2023", after: "hour-old" }]);
  });
});
