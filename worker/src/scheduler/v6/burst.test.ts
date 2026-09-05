// ===========================================================================
// GATE-06 · burst, GATE-07 · burst is per stream (GoldenEvals V6 P1 §5.6).
// Pure arithmetic on timestamps and content keys; no DB, no model.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { BURST_K, BURST_WINDOW_MS, BurstTracker } from "./burst.js";

const T0 = 1_700_000_000_000;
const S = 1_000;

describe("GATE-06 · burst", () => {
  it("4 distinct product pages on one stream within 150 s → BURST on the 4th", () => {
    const b = new BurstTracker();
    const stream = "browser:croma.com";
    expect(b.note(stream, T0, "tv-1").burst).toBe(false);
    expect(b.note(stream, T0 + 50 * S, "tv-2").burst).toBe(false);
    expect(b.note(stream, T0 + 100 * S, "tv-3").burst).toBe(false);
    const fourth = b.note(stream, T0 + 150 * S, "tv-4");
    expect(fourth).toMatchObject({ burst: true, runLength: 4, counted: true });
    expect(BURST_K).toBe(4);
    expect(BURST_WINDOW_MS).toBe(180_000);
  });

  it("only 3 pages stays cold", () => {
    const b = new BurstTracker();
    const stream = "browser:croma.com";
    b.note(stream, T0, "tv-1");
    b.note(stream, T0 + 50 * S, "tv-2");
    expect(b.note(stream, T0 + 100 * S, "tv-3").burst).toBe(false);
  });

  it("4 pages of which 2 share a content hash stays cold — only 2 content-new (wrong: burst-on-repeats)", () => {
    const b = new BurstTracker();
    const stream = "browser:croma.com";
    expect(b.note(stream, T0, "tv-1").counted).toBe(true);
    expect(b.note(stream, T0 + 40 * S, "tv-1").counted).toBe(false);
    expect(b.note(stream, T0 + 80 * S, "tv-2").counted).toBe(true);
    const fourth = b.note(stream, T0 + 120 * S, "tv-2");
    expect(fourth.counted).toBe(false);
    expect(fourth.burst).toBe(false);
    expect(fourth.runLength).toBe(2);
  });

  it("the window slides: 4 pages spread past 180 s never burst", () => {
    const b = new BurstTracker();
    const stream = "browser:croma.com";
    b.note(stream, T0, "a");
    b.note(stream, T0 + 70 * S, "b");
    b.note(stream, T0 + 140 * S, "c");
    expect(b.note(stream, T0 + 200 * S, "d").burst).toBe(false); // "a" fell out of the window
    expect(b.runLength(stream, T0 + 200 * S)).toBe(3);
  });

  it("a flush resets the run — the condition is 'with no flush yet'", () => {
    const b = new BurstTracker();
    const stream = "browser:croma.com";
    b.note(stream, T0, "a");
    b.note(stream, T0 + 10 * S, "b");
    b.note(stream, T0 + 20 * S, "c");
    b.reset();
    expect(b.note(stream, T0 + 30 * S, "d").burst).toBe(false);
  });
});

describe("GATE-07 · burst is per stream", () => {
  it("2 pages on croma and 2 on amazon within 150 s stay cold", () => {
    const b = new BurstTracker();
    expect(b.note("browser:croma.com", T0, "c1").burst).toBe(false);
    expect(b.note("browser:amazon.in", T0 + 30 * S, "a1").burst).toBe(false);
    expect(b.note("browser:croma.com", T0 + 60 * S, "c2").burst).toBe(false);
    const last = b.note("browser:amazon.in", T0 + 90 * S, "a2");
    expect(last.burst).toBe(false);
    expect(b.runLength("browser:croma.com", T0 + 90 * S)).toBe(2);
    expect(b.runLength("browser:amazon.in", T0 + 90 * S)).toBe(2);
  });
});
