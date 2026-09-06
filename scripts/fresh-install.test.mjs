// ===========================================================================
// The pure half of scripts/fresh-install.mjs (Build V6 P1 §9 item 2) and
// scripts/screen-dedup-rate.mjs (§9 item 3).
//
// Neither script is importable-with-side-effects: `main()` runs only when the
// file is the process entry point, so importing them here boots no worker,
// spawns no sidecar and makes ZERO model calls. What is tested is the
// arithmetic the graduation report rests on — the tolerance bands, the day
// floors, the dedup tally — because a report whose maths is wrong is worse
// than no report.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  COST_TOLERANCE,
  FIRST_SPACE_BUDGET_MS,
  PRODUCTION_PORT,
  TIME_TOLERANCE,
  deviation,
  floorIso,
  parseArgs,
  withinTolerance,
} from "./fresh-install.mjs";
import { parseArgs as dedupArgs, tally } from "./screen-dedup-rate.mjs";

describe("fresh-install — the rails are in the argument parser", () => {
  it("refuses the production port outright (plan §1.3 rule 1)", () => {
    expect(() => parseArgs(["--port", String(PRODUCTION_PORT)])).toThrow(/refusing port 8013/);
  });

  it("refuses a port that is not a port", () => {
    expect(() => parseArgs(["--port", "not-a-number"])).toThrow(/not a port/);
  });

  it("defaults to a 30-day understand window and no fixed port", () => {
    const o = parseArgs([]);
    expect(o.understand).toBe("30d");
    expect(o.port).toBeNull();
    expect(o.stopBeforeConfirm).toBe(false);
  });

  it("--stop-before-confirm is the free walk of the funnel", () => {
    expect(parseArgs(["--stop-before-confirm"]).stopBeforeConfirm).toBe(true);
  });

  it("a flag with no value is an error, not a silent undefined", () => {
    expect(() => parseArgs(["--understand"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--nonsense"])).toThrow(/unknown flag/);
  });
});

describe("fresh-install — the window floor", () => {
  const now = Date.parse("2026-09-06T12:00:00.000Z");

  it("30d is exactly thirty days back", () => {
    expect(floorIso("30d", now)).toBe("2026-08-07T12:00:00.000Z");
  });

  it("every range the graduation flow offers is known", () => {
    for (const r of ["24h", "3d", "7d", "30d", "90d", "180d", "1y"]) {
      expect(() => floorIso(r, now)).not.toThrow();
    }
    expect(() => floorIso("all", now)).toThrow(/unsupported/);
  });
});

describe("fresh-install — the ±40% / ±30% bands", () => {
  it("the bands are the card's own accuracy labels", () => {
    expect(COST_TOLERANCE).toBe(0.4);
    expect(TIME_TOLERANCE).toBe(0.3);
    expect(FIRST_SPACE_BUDGET_MS).toBe(120_000);
  });

  it("holds at the edge and misses past it", () => {
    // $0.32 projected: $0.192 and $0.448 are exactly ±40%.
    expect(withinTolerance(0.32, 0.192, 0.4)).toBe(true);
    expect(withinTolerance(0.32, 0.448, 0.4)).toBe(true);
    expect(withinTolerance(0.32, 0.45, 0.4)).toBe(false);
    expect(withinTolerance(0.32, 0.19, 0.4)).toBe(false);
  });

  it("a projection of zero can only be met by zero — never a ratio", () => {
    expect(withinTolerance(0, 0, 0.4)).toBe(true);
    expect(withinTolerance(0, 0.01, 0.4)).toBe(false);
    expect(deviation(0, 5)).toBeNull();
  });

  it("an unmeasurable side is null, not a fake pass", () => {
    expect(withinTolerance(null, 1, 0.4)).toBeNull();
    expect(withinTolerance(1, undefined, 0.4)).toBeNull();
    expect(deviation(null, 1)).toBeNull();
  });

  it("deviation is signed: over is positive, under is negative", () => {
    expect(deviation(100, 130)).toBeCloseTo(0.3, 10);
    expect(deviation(100, 70)).toBeCloseTo(-0.3, 10);
  });
});

describe("screen-dedup-rate — the tally", () => {
  const frame = (t, extra = {}) => ({ t, ...extra });

  it("policy drops are not dedup — they were never events", () => {
    // The shipped fixtures/basic.json shape: 7 captures, 3 never-list drops,
    // 3 snapshots, 1 swallowed by the content+tree hash.
    const frames = [
      frame("ready"),
      frame("status"),
      frame("snapshot"),
      frame("snapshot"),
      frame("snapshot"),
      frame("drop", { reason: "private_window" }),
      frame("drop", { reason: "password_manager" }),
      frame("drop", { reason: "private_window" }),
    ];
    const t = tally(7, frames);
    expect(t.policyDrops).toBe(3);
    expect(t.dropReasons).toEqual(["password_manager", "private_window"]);
    expect(t.allowed).toBe(4);
    expect(t.snapshots).toBe(3);
    expect(t.suppressed).toBe(1);
    expect(t.dedupRate).toBeCloseTo(0.25, 10);
  });

  it("nothing allowed is no rate, not a rate of zero", () => {
    const t = tally(2, [frame("drop", { reason: "private_window" }), frame("drop", { reason: "private_window" })]);
    expect(t.allowed).toBe(0);
    expect(t.dedupRate).toBeNull();
  });

  it("every capture emitted means a dedup rate of zero", () => {
    const t = tally(2, [frame("snapshot"), frame("snapshot")]);
    expect(t.dedupRate).toBe(0);
  });

  it("its flags parse", () => {
    expect(dedupArgs(["--builtin"]).builtin).toBe(true);
    expect(dedupArgs(["--fixture", "/tmp/x.json"]).fixture).toBe("/tmp/x.json");
    expect(() => dedupArgs(["--nope"])).toThrow(/unknown flag/);
  });
});
