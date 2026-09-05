// ===========================================================================
// BND-04 · cold idle flush, BND-05 · cold max, BND-06 · floor, BND-07 ·
// novelty, GATE-08 · bootstrapping (GoldenEvals V6 P1 §5.5 / §5.6). Pure
// clock arithmetic; no DB, no model.
// ===========================================================================

import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_PARAMS,
  CHAR_CAP,
  ColdWindow,
  effectiveParams,
  FLUSH_FLOOR_MS,
  FRESHNESS_PRESETS,
  isBootstrapping,
  MAX_WINDOW_MS,
  presetParams,
} from "./cold.js";

const T0 = 1_700_000_000_000;
const S = 1_000;
const DAY = 86_400_000;

function ev(rowid: number, atMs: number, key: string, chars = 40, streamId = "wa:st:a") {
  return { rowid, id: `e${rowid}`, streamId, contentKey: key, chars, atMs };
}

describe("BND-04 · cold idle flush", () => {
  it("events at 0, 10, 20 s then silence → one flush at 320 s (300 s idle from the last)", () => {
    const w = new ColdWindow(FRESHNESS_PRESETS.balanced);
    w.add(ev(1, T0, "a"));
    w.add(ev(2, T0 + 10 * S, "b"));
    w.add(ev(3, T0 + 20 * S, "c"));
    expect(w.dueAt()).toEqual({ atMs: T0 + 320 * S, trigger: "cold" });
    expect(w.due(T0 + 45 * S)).toBeNull(); // wrong: flush-at-45s
    expect(w.due(T0 + 319 * S)).toBeNull();
    expect(w.due(T0 + 320 * S)).toEqual({ trigger: "cold" });
    const f = w.flush(T0 + 320 * S);
    expect(f.events.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(w.dueAt()).toBeNull(); // nothing left, nothing flushes
  });
});

describe("BND-05 · cold max", () => {
  it("continuous events every 10 s → flush at 540 s", () => {
    const w = new ColdWindow(FRESHNESS_PRESETS.balanced);
    let flushedAt: number | null = null;
    for (let t = 0; t <= 600 && flushedAt === null; t += 10) {
      w.add(ev(t / 10 + 1, T0 + t * S, `k${t}`));
      if (w.due(T0 + t * S)) flushedAt = t;
    }
    expect(flushedAt).toBe(540);
  });

  it("max never exceeds 600 s, whatever the preset asks", () => {
    const w = new ColdWindow();
    w.setParams({ idleMs: 900_000, maxMs: 1_800_000 });
    expect(w.currentParams).toEqual({ idleMs: MAX_WINDOW_MS, maxMs: MAX_WINDOW_MS });
  });
});

describe("BND-06 · floor", () => {
  it("two hot events 5 s apart: the second rides the next flush, at least 30 s later", () => {
    const w = new ColdWindow(FRESHNESS_PRESETS.balanced);
    w.add(ev(1, T0, "a"));
    w.urge("hot");
    expect(w.due(T0)).toEqual({ trigger: "hot" });
    w.flush(T0);
    w.add(ev(2, T0 + 5 * S, "b"));
    w.urge("hot");
    expect(w.due(T0 + 5 * S)).toBeNull();
    expect(w.dueAt()).toEqual({ atMs: T0 + FLUSH_FLOOR_MS, trigger: "hot" });
    expect(w.due(T0 + 30 * S)).toEqual({ trigger: "hot" });
    expect(FLUSH_FLOOR_MS).toBe(30_000);
  });
});

describe("BND-07 · novelty", () => {
  it("repeated content never resets the timer and never counts; heartbeats alone never flush", () => {
    const w = new ColdWindow(FRESHNESS_PRESETS.balanced);
    w.add(ev(1, T0, "frame-A", 500, "screen:st:x"));
    // Heartbeats: the same frame every 10 s for two minutes.
    for (let t = 10; t <= 120; t += 10) expect(w.add(ev(1 + t / 10, T0 + t * S, "frame-A", 500, "screen:st:x"))).toBe(false);
    // The idle clock still runs from the FIRST (only content-new) event.
    expect(w.dueAt()).toEqual({ atMs: T0 + 300 * S, trigger: "cold" });
    expect(w.snapshot().newCount).toBe(1);
    expect(w.snapshot().chars).toBe(500);
    const f = w.flush(T0 + 300 * S);
    expect(f.events).toHaveLength(13); // repeats ride along with the one new event

    // Heartbeats only, afterwards: nothing ever flushes (wrong: heartbeat-keeps-alive).
    for (let t = 310; t <= 1200; t += 10) w.add(ev(100 + t / 10, T0 + t * S, "frame-A", 500, "screen:st:x"));
    expect(w.dueAt()).toBeNull();
    expect(w.due(T0 + 1200 * S)).toBeNull();
  });

  it("a seeded key (from the log) is a repeat on first sight", () => {
    const w = new ColdWindow();
    w.markSeen("screen:st:x", "frame-A");
    expect(w.add(ev(1, T0, "frame-A", 500, "screen:st:x"))).toBe(false);
    expect(w.dueAt()).toBeNull();
  });

  it("an empty accumulator never flushes", () => {
    const w = new ColdWindow();
    expect(w.dueAt()).toBeNull();
    expect(w.due(T0 + DAY)).toBeNull();
  });
});

describe("20k-char cap forces a cut", () => {
  it("content past the cap is due at once and the flush leaves the overflow for next time", () => {
    const w = new ColdWindow(FRESHNESS_PRESETS.balanced);
    for (let i = 1; i <= 6; i++) w.add(ev(i, T0 + i * S, `k${i}`, 4_000));
    expect(w.capped).toBe(true);
    expect(w.dueAt()).toEqual({ atMs: T0 + 6 * S, trigger: "cap" });
    const f = w.flush(T0 + 6 * S);
    expect(f.events.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]); // 20,000 chars exactly
    expect(f.remaining).toBe(1);
    expect(w.snapshot().newCount).toBe(1);
    expect(CHAR_CAP).toBe(20_000);
  });
});

describe("GATE-08 · bootstrapping and presets", () => {
  it("under 20 spaces → 60/180; past the 20th space AND day 8 → the preset (300/540)", () => {
    const first = T0;
    expect(isBootstrapping({ spaces: 3, firstConsentMs: first, nowMs: first + 10 * DAY })).toBe(true);
    expect(isBootstrapping({ spaces: 20, firstConsentMs: first, nowMs: first + 3 * DAY })).toBe(true); // still day 3
    expect(isBootstrapping({ spaces: 20, firstConsentMs: first, nowMs: first + 7 * DAY })).toBe(false); // day 8
    expect(effectiveParams("balanced", { spaces: 5, firstConsentMs: first, nowMs: first + 30 * DAY })).toEqual(BOOTSTRAP_PARAMS);
    expect(effectiveParams("balanced", { spaces: 25, firstConsentMs: first, nowMs: first + 30 * DAY })).toEqual({ idleMs: 300_000, maxMs: 540_000 });
    expect(BOOTSTRAP_PARAMS).toEqual({ idleMs: 60_000, maxMs: 180_000 });
  });

  it("presets: Live 120/180 · Balanced 300/540 · Relaxed 420/600; unknown → Balanced", () => {
    expect(presetParams("live")).toEqual({ idleMs: 120_000, maxMs: 180_000 });
    expect(presetParams("balanced")).toEqual({ idleMs: 300_000, maxMs: 540_000 });
    expect(presetParams("relaxed")).toEqual({ idleMs: 420_000, maxMs: 600_000 });
    expect(presetParams(null)).toEqual(presetParams("balanced"));
    expect(presetParams("turbo")).toEqual(presetParams("balanced"));
  });

  it("the bootstrapping window flushes cold events at 60 s idle", () => {
    const w = new ColdWindow(BOOTSTRAP_PARAMS);
    w.add(ev(1, T0, "a"));
    expect(w.dueAt()).toEqual({ atMs: T0 + 60 * S, trigger: "cold" });
  });
});
