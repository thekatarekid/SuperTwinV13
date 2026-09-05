// ===========================================================================
// The digest lane planner: tier-3 streams, one week per call, empty weeks
// skipped, the current week waits (Product_V6 §23.2; S3.3).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planDigest, weekKey, weekStartMs } from "./digest.js";
import { append, msgAt, openScratchDb, setStreamTier, streamIdOf, type ScratchDb } from "./testutil.js";

let db: ScratchDb;
beforeEach(() => {
  db = openScratchDb("supertwin-digest-");
});
afterEach(() => db.close());

const at = (iso: string) => Date.parse(iso);

describe("planDigest", () => {
  it("one bundle per (tier-3 stream, ended week with new events); newest week first; current week and empty weeks skipped", () => {
    const NOW = at("2026-08-26T12:00:00Z"); // a Wednesday; the week of Mon 2026-08-24 is current
    append([
      msgAt("promo@g.us", at("2026-08-04T10:00:00Z"), "offer 1", { origin: "backfill" }), // week of 08-03
      msgAt("promo@g.us", at("2026-08-05T10:00:00Z"), "offer 2", { origin: "backfill" }),
      // week of 08-10: nothing → skipped
      msgAt("promo@g.us", at("2026-08-19T10:00:00Z"), "offer 3", { origin: "backfill" }), // week of 08-17
      msgAt("promo@g.us", at("2026-08-25T10:00:00Z"), "offer 4"), // current week → waits
      msgAt("fam@g.us", at("2026-08-19T11:00:00Z"), "tier-1 chat", { origin: "backfill" }), // not tier 3
    ]);
    setStreamTier(streamIdOf("wa", "promo@g.us"), "T3");

    const plan = planDigest({ nowMs: NOW });
    expect(plan.map((b) => [b.lane, b.day, b.events.length])).toEqual([
      ["digest", "2026-08-19", 1],
      ["digest", "2026-08-05", 2],
    ]);
    expect(plan.every((b) => b.streamId === streamIdOf("wa", "promo@g.us"))).toBe(true);
    expect(planDigest({ nowMs: NOW, includeCurrentWeek: true })).toHaveLength(3);
    expect(planDigest({ nowMs: NOW, limit: 1 })).toHaveLength(1);
  });

  it("weeks start on Monday 00:00 UTC", () => {
    expect(weekKey(at("2026-08-26T12:00:00Z"))).toBe("2026-08-24");
    expect(weekKey(at("2026-08-24T00:00:00Z"))).toBe("2026-08-24");
    expect(weekKey(at("2026-08-23T23:59:59Z"))).toBe("2026-08-17");
    expect(weekStartMs(at("2026-08-30T05:00:00Z"))).toBe(at("2026-08-24T00:00:00Z"));
  });

  it("a stream with no tier is never digested (unknown work is early work)", () => {
    append([msgAt("x@g.us", at("2026-08-04T10:00:00Z"), "hello", { origin: "backfill" })]);
    expect(planDigest({ nowMs: at("2026-08-26T12:00:00Z") })).toHaveLength(0);
  });
});
