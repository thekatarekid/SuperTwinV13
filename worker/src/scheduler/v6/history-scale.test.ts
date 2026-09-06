// ===========================================================================
// C6 · the history lane is size-independent (Build V6 P1 §7.1; BND-01..03).
//
// The lane used to crash on ordinary data: `splitAtLargestGap` re-sliced the
// day at every recursion level and kept the FIRST maximum gap, so a stream
// with an even cadence — messages a second apart, browser visits, screen
// frames — sheared one event at a time. Depth O(n), quadratic work, and
// `RangeError: Maximum call stack size exceeded` from ~8,000 events on a day,
// dead-lettering exactly the busiest days. The bundle key then spread the
// whole part into Math.min/Math.max, which throws above ~100k events.
//
// Every case here is deterministic and reaches no model.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bundleKey, type BundleEvent } from "./bundle.js";
import { HISTORY_SPLIT_CHARS, HISTORY_SPLIT_EVENTS, planHistory, splitAtLargestGap } from "./history.js";
import { append, msgAt, openScratchDb, type ScratchDb } from "./testutil.js";

const T = Date.parse("2026-08-20T09:00:00.000Z");

function ev(rowid: number, atMs: number, text: string): BundleEvent {
  return {
    rowid,
    id: `e${rowid}`,
    sourceId: "wa",
    streamId: "wa:st:scale@g.us",
    ts: new Date(atMs).toISOString(),
    kind: "wa.message",
    text,
    actor: "contact:karan",
    origin: "backfill",
    ageBand: "A",
    rolesJson: null,
    payloadJson: null,
  };
}

/** n events at a perfectly even cadence — the shape that used to overflow. */
function evenCadence(n: number, chars = 40, stepMs = 1_000): BundleEvent[] {
  return Array.from({ length: n }, (_, i) => ev(i + 1, T + i * stepMs, "x".repeat(chars)));
}

describe("C6 · splitAtLargestGap survives a large day", () => {
  it("an even cadence does not overflow the stack — it halves, it does not shear", () => {
    // 8,000 events at one per second is a live group chat or one screen
    // session. The recursive-slice reading threw RangeError here.
    const parts = splitAtLargestGap(evenCadence(8_000));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.events.length).toBeLessThanOrEqual(HISTORY_SPLIT_EVENTS);
      expect(p.events.reduce((n, e) => n + (e.text ?? "").length, 0)).toBeLessThanOrEqual(HISTORY_SPLIT_CHARS);
    }
    // It sheared one event at a time before: n - (parts-of-cap) parts.
    expect(parts.length).toBeLessThan(100);
  });

  it("identical timestamps (no inactivity anywhere) still terminate and bound", () => {
    const flat = Array.from({ length: 5_000 }, (_, i) => ev(i + 1, T, "y".repeat(20)));
    const parts = splitAtLargestGap(flat);
    for (const p of parts) expect(p.events.length).toBeLessThanOrEqual(HISTORY_SPLIT_EVENTS);
    expect(parts.reduce((n, p) => n + p.events.length, 0)).toBe(5_000);
  });

  it("caps EVENTS as well as characters — 20k empty-text rows never ride as one part", () => {
    // Browser visits and screen frames carry almost no text: the char cap
    // alone bounded nothing, and the whole day went to the packer as one part.
    const tiny = Array.from({ length: 20_000 }, (_, i) => ev(i + 1, T + i * 1_000, ""));
    const parts = splitAtLargestGap(tiny);
    expect(parts.length).toBeGreaterThanOrEqual(20_000 / HISTORY_SPLIT_EVENTS);
    for (const p of parts) expect(p.events.length).toBeLessThanOrEqual(HISTORY_SPLIT_EVENTS);
  });

  it("is linear enough that a big day is not a hang (4k events under a second)", () => {
    const started = Date.now();
    splitAtLargestGap(evenCadence(4_000));
    expect(Date.now() - started).toBeLessThan(1_000); // was ~11,000 ms
  });

  it("keeps BND-02: a genuine silence still wins the cut, and parts stay in time order", () => {
    const events = [
      ...Array.from({ length: 40 }, (_, i) => ev(i + 1, T + i * 1_000, "a".repeat(500))),
      // A four-hour silence — the one real inactivity gap in the day.
      ...Array.from({ length: 40 }, (_, i) => ev(100 + i, T + 4 * 3_600_000 + i * 1_000, "b".repeat(500))),
    ];
    const parts = splitAtLargestGap(events);
    expect(parts).toHaveLength(2);
    expect(parts[0].events.every((e) => (e.text ?? "").startsWith("a"))).toBe(true);
    expect(parts[1].events.every((e) => (e.text ?? "").startsWith("b"))).toBe(true);
    expect(Date.parse(parts[0].to!)).toBeLessThan(Date.parse(parts[1].from!));
  });

  it("every event is emitted exactly once, in time order", () => {
    const parts = splitAtLargestGap(evenCadence(3_000));
    const rowids = parts.flatMap((p) => p.events.map((e) => e.rowid));
    expect(rowids).toHaveLength(3_000);
    expect(new Set(rowids).size).toBe(3_000);
    expect([...rowids].sort((a, b) => a - b)).toEqual(rowids);
  });
});

describe("C6 · bundle-key construction is size-independent", () => {
  it("keys a 200,000-event bundle — the spread threw above ~100k", () => {
    const events = Array.from({ length: 200_000 }, (_, i) => ev(i + 1, T + i, ""));
    expect(() => Math.min(...events.map((e) => e.rowid))).toThrow(RangeError); // the old construction
    expect(bundleKey({ streamId: "wa:st:scale@g.us", events })).toBe("wa:st:scale@g.us:1-200000");
  });
});

describe("C6 · planHistory plans a busy day instead of crashing on it", () => {
  let db: ScratchDb;
  beforeEach(() => {
    db = openScratchDb("supertwin-history-scale-");
  });
  afterEach(() => db.close());

  it("2,000 backfill messages at an even cadence plan into bounded parts", () => {
    append(
      Array.from({ length: 2_000 }, (_, i) =>
        msgAt("scale@g.us", T + i * 1_000, `msg ${i} ${"x".repeat(40)}`, { origin: "backfill" }),
      ),
    );
    const plan = planHistory();
    expect(plan.length).toBeGreaterThan(1);
    const keys = new Set<string>();
    for (const b of plan) {
      expect(b.lane).toBe("history");
      expect(b.events.length).toBeLessThanOrEqual(HISTORY_SPLIT_EVENTS);
      keys.add(bundleKey(b));
    }
    // Distinct keys: the in-flight registry and bundle_attempts key on this.
    expect(keys.size).toBe(plan.length);
    expect(plan.reduce((n, b) => n + b.events.length, 0)).toBe(2_000);
    expect(plan.every((b) => b.partCount === plan.length)).toBe(true);
  });
});
