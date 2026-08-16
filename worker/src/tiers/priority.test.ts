// ===========================================================================
// The scheduler's primary sort key (arch §9.3; evals B-040…B-046).
//
// Two things are under test and both are ordering, not filtering: that the
// composed priority sorts T1 live -> … -> T4 older with no field bleeding into
// its neighbour, and that the live exception fires for T1/T2 only, at a cohort
// boundary, never mid-cohort.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  CohortQueue,
  HORIZONS,
  TIERS,
  computePriority,
  horizonFor,
  horizonWeight,
  preempts,
  recencySlot,
  tierOfPriority,
  tierOrderViolations,
  tierWeight,
  type Cohort,
} from "./priority.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe("ranks", () => {
  it("counts down in urgency and up in value, because the queue is priority DESC", () => {
    expect(tierWeight("T1")).toBeGreaterThan(tierWeight("T2"));
    expect(tierWeight("T2")).toBeGreaterThan(tierWeight("T3"));
    expect(tierWeight("T3")).toBeGreaterThan(tierWeight("T4"));
    expect(horizonWeight("live")).toBeGreaterThan(horizonWeight("older"));
  });

  it("recovers the tier from a priority", () => {
    for (const tier of TIERS) {
      expect(tierOfPriority(computePriority({ tier, horizon: "d7", ts: ago(0), now: NOW }))).toBe(tier);
    }
  });
});

describe("the composed priority", () => {
  it("orders T1 live -> T1 h24 -> … -> T4 older, tier first", () => {
    const order: { tier: (typeof TIERS)[number]; horizon: (typeof HORIZONS)[number] }[] = [];
    for (const tier of TIERS) for (const horizon of HORIZONS) order.push({ tier, horizon });

    const priorities = order.map((o) => computePriority({ ...o, ts: ago(0), now: NOW }));
    for (let i = 1; i < priorities.length; i += 1) {
      expect(priorities[i - 1]).toBeGreaterThan(priorities[i]!);
    }
  });

  it("never lets recency outrank a horizon, or a horizon outrank a tier", () => {
    // The newest possible T2 event against the oldest possible T1 one.
    const t1Ancient = computePriority({ tier: "T1", horizon: "older", ts: ago(50 * 365 * 86_400_000), now: NOW });
    const t2Live = computePriority({ tier: "T2", horizon: "live", ts: ago(0), now: NOW });
    expect(t1Ancient).toBeGreaterThan(t2Live);

    const h24Newest = computePriority({ tier: "T1", horizon: "h24", ts: ago(0), now: NOW });
    const liveOldest = computePriority({ tier: "T1", horizon: "live", ts: ago(3_599_000), now: NOW });
    expect(liveOldest).toBeGreaterThan(h24Newest);
  });

  it("keeps the recency term inside its own field", () => {
    expect(recencySlot(ago(0), NOW)).toBe(999_999);
    expect(recencySlot(ago(40 * 365 * 86_400_000), NOW)).toBe(0);
    expect(recencySlot("not a date", NOW)).toBe(0);
  });

  it("buckets an instant into the horizon it belongs to", () => {
    expect(horizonFor(ago(60_000), NOW)).toBe("live");
    expect(horizonFor(ago(5 * 3_600_000), NOW)).toBe("h24");
    expect(horizonFor(ago(3 * 86_400_000), NOW)).toBe("d7");
    expect(horizonFor(ago(20 * 86_400_000), NOW)).toBe("d30");
    expect(horizonFor(ago(60 * 86_400_000), NOW)).toBe("d90");
    expect(horizonFor(ago(200 * 86_400_000), NOW)).toBe("y1");
    expect(horizonFor(ago(800 * 86_400_000), NOW)).toBe("older");
  });
});

describe("the live exception (§9.3)", () => {
  it("is granted to T1 and T2 and refused to T3 and T4", () => {
    expect(preempts("T1", "live")).toBe(true);
    expect(preempts("T2", "live")).toBe(true);
    expect(preempts("T3", "live")).toBe(false);
    expect(preempts("T4", "live")).toBe(false);
    expect(preempts("T1", "h24")).toBe(false);
  });
});

describe("the cohort queue", () => {
  const planned: Cohort[] = [
    { id: "k1", tier: "T1", horizon: "h24", ts: ago(2 * 3_600_000) },
    { id: "k2", tier: "T1", horizon: "older", ts: ago(400 * 86_400_000) },
    { id: "k3", tier: "T2", horizon: "h24", ts: ago(3 * 3_600_000) },
    { id: "k4", tier: "T4", horizon: "h24", ts: ago(4 * 3_600_000) },
  ];

  it("exhausts a tier before starting the next", () => {
    const q = new CohortQueue(NOW);
    for (const c of planned) q.push(c);
    const order = q.drain().map((r) => r.id);
    expect(order).toEqual(["k1", "k2", "k3", "k4"]);
    expect(tierOrderViolations(q.history(), planned)).toEqual([]);
  });

  it("lets a T1 live cohort in at the NEXT boundary, one cohort late", () => {
    const q = new CohortQueue(NOW);
    for (const c of planned) q.push(c);
    q.next(); // k1 is in flight
    q.arrive({ id: "live1", tier: "T1", horizon: "live", ts: ago(30_000) });
    const record = q.next()!;
    expect(record.id).toBe("live1");
    expect(record.preempted).toBe(true);
    expect(record.delay).toBe(1);
  });

  it("lets a T2 live cohort pre-empt a T1 backfill", () => {
    const q = new CohortQueue(NOW);
    q.push({ id: "k2", tier: "T1", horizon: "older", ts: ago(400 * 86_400_000) });
    q.push({ id: "k2b", tier: "T1", horizon: "older", ts: ago(500 * 86_400_000) });
    q.next();
    q.arrive({ id: "bank", tier: "T2", horizon: "live", ts: ago(10_000) });
    const record = q.next()!;
    expect(record.id).toBe("bank");
    expect(record.delay).toBe(1);
  });

  it("makes a T4 blast wait its turn — a promotional blast never interrupts a history import", () => {
    const q = new CohortQueue(NOW);
    for (const c of planned) q.push(c);
    q.next(); // k1 in flight
    q.arrive({ id: "blast", tier: "T4", horizon: "live", ts: ago(5_000) });
    // It waits for every higher tier and only then takes its place inside T4,
    // where `live` is simply the most urgent horizon. No exception, no jump.
    const after = [q.next()!, q.next()!, q.next()!, q.next()!].map((r) => r.id);
    expect(after).toEqual(["k2", "k3", "blast", "k4"]);
    expect(q.history().find((r) => r.id === "blast")!.preempted).toBe(false);
  });

  it("counts a T2 cohort that ran while T1 was still pending as a violation", () => {
    // The inversion the gate is about, built by hand so the counter is proven
    // to be able to fail.
    const order = [
      { id: "k3", tier: "T2" as const, horizon: "h24" as const, priority: 0, preempted: false, delay: 0 },
      { id: "k1", tier: "T1" as const, horizon: "h24" as const, priority: 0, preempted: false, delay: 0 },
    ];
    expect(tierOrderViolations(order, planned)).toEqual([
      { ran: "k3", whileWaiting: "k1" },
      { ran: "k3", whileWaiting: "k2" },
    ]);
  });
});
