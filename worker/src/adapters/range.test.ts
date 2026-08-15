// ===========================================================================
// Range → cutoff mapping tests (contract §4). Table-driven; must match the Go
// daemon's rangeCutoff(range, now). Pure, no DB.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  inRange,
  rangeCutoffIso,
  rangeCutoffMs,
} from "./source-adapter.js";
import { isRange, RANGES, type Range } from "./types.js";

// Fixed "now" so the table is deterministic.
const NOW = Date.parse("2026-07-02T00:00:00.000Z"); // ms
const DAY = 24 * 60 * 60 * 1000;

describe("rangeCutoffMs", () => {
  const cases: Array<{ range: Range; expectMs: number }> = [
    { range: "24h", expectMs: NOW - 1 * DAY },
    { range: "3d", expectMs: NOW - 3 * DAY },
    { range: "7d", expectMs: NOW - 7 * DAY },
    { range: "30d", expectMs: NOW - 30 * DAY },
    { range: "90d", expectMs: NOW - 90 * DAY },
    { range: "180d", expectMs: NOW - 180 * DAY },
    { range: "1y", expectMs: NOW - 365 * DAY },
    { range: "all", expectMs: 0 },
  ];

  for (const { range, expectMs } of cases) {
    it(`${range} -> ${expectMs}`, () => {
      expect(rangeCutoffMs(range, NOW)).toBe(expectMs);
    });
  }

  it("covers every Range value in the enum (no gaps)", () => {
    for (const r of RANGES) {
      expect(Number.isFinite(rangeCutoffMs(r, NOW))).toBe(true);
    }
  });

  it("all => epoch 0 (no cutoff)", () => {
    expect(rangeCutoffMs("all", NOW)).toBe(0);
    expect(rangeCutoffIso("all", NOW)).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("inRange predicate (chat + message filter, §4)", () => {
  it("includes ts >= cutoff, excludes older", () => {
    const cutoff = rangeCutoffMs("7d", NOW);
    expect(inRange(cutoff, "7d", NOW)).toBe(true); // boundary is inclusive
    expect(inRange(cutoff + 1, "7d", NOW)).toBe(true);
    expect(inRange(cutoff - 1, "7d", NOW)).toBe(false);
  });

  it("all includes everything at/after epoch", () => {
    expect(inRange(0, "all", NOW)).toBe(true); // epoch is the cutoff for `all`
    expect(inRange(Date.parse("2005-01-01T00:00:00.000Z"), "all", NOW)).toBe(true);
    expect(inRange(NOW, "all", NOW)).toBe(true);
  });
});

describe("isRange guard", () => {
  it("accepts valid ranges, rejects junk", () => {
    expect(isRange("24h")).toBe(true);
    expect(isRange("all")).toBe(true);
    expect(isRange("2d")).toBe(false);
    expect(isRange("")).toBe(false);
    expect(isRange(7)).toBe(false);
    expect(isRange(null)).toBe(false);
  });
});
