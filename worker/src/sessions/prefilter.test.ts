import { describe, expect, it } from "vitest";

import { collapseFrames, NO_COLLAPSE } from "./prefilter.js";
import type { SegEvent } from "./segment.js";

const T0 = Date.parse("2026-08-10T04:00:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();

function frame(n: number, offsetMs: number, phash: string | null): SegEvent {
  return { external_id: `f${n}`, ts: at(offsetMs), actor: "screen", kind: "frame", text: "", phash };
}

const SAME = "ffffffffffffffff";
const OTHER = "0000000000000000";

describe("the perceptual collapse", () => {
  it("keeps one frame per run and records what it swallowed", () => {
    const frames = Array.from({ length: 200 }, (_, i) => frame(i + 1, i * 2_000, SAME));
    const out = collapseFrames(frames, 6, Infinity);
    expect(out.events.map((e) => e.external_id)).toEqual(["f1"]);
    expect(out.removed).toBe(199);
    expect(out.collapsedInto.get("f1")).toEqual({ count: 199, span_ms: 199 * 2_000 });
  });

  it("starts a new run when the frame actually changes", () => {
    const out = collapseFrames(
      [frame(1, 0, SAME), frame(2, 2_000, SAME), frame(3, 4_000, OTHER), frame(4, 6_000, OTHER)],
      6,
      Infinity,
    );
    expect(out.events.map((e) => e.external_id)).toEqual(["f1", "f3"]);
    expect(out.removed).toBe(2);
  });

  it("does NOT collapse across a gap wider than the silence window", () => {
    // Two identical frames either side of a two-minute silence are the same
    // thing seen twice, and the silence between them is itself a boundary.
    const out = collapseFrames([frame(1, 0, SAME), frame(2, 120_000, SAME)], 6, 90_000);
    expect(out.events).toHaveLength(2);
    expect(out.removed).toBe(0);
  });

  it("honours the distance threshold", () => {
    const near = "fffffffffffffffe"; // one bit away
    expect(collapseFrames([frame(1, 0, SAME), frame(2, 1_000, near)], 6, Infinity).removed).toBe(1);
    expect(collapseFrames([frame(1, 0, SAME), frame(2, 1_000, near)], 0, Infinity).removed).toBe(0);
  });

  it("passes through frames that carry no hash — an unmeasurable rule must not fire", () => {
    const out = collapseFrames([frame(1, 0, null), frame(2, 1_000, null), frame(3, 2_000, null)], 6, Infinity);
    expect(out.events).toHaveLength(3);
    expect(out.removed).toBe(0);
  });

  it("ignores a hash that is not 16 hex chars rather than throwing", () => {
    const out = collapseFrames([frame(1, 0, "nonsense"), frame(2, 1_000, "nonsense")], 6, Infinity);
    expect(out.events).toHaveLength(2);
  });

  it("is empty-safe and byte-identical on a re-run", () => {
    expect(collapseFrames([], 6, Infinity)).toEqual(NO_COLLAPSE);
    const frames = Array.from({ length: 40 }, (_, i) => frame(i + 1, i * 1_000, i < 20 ? SAME : OTHER));
    const once = collapseFrames(frames, 6, Infinity);
    const twice = collapseFrames(frames, 6, Infinity);
    expect(twice.events.map((e) => e.external_id)).toEqual(once.events.map((e) => e.external_id));
    expect(twice.removed).toBe(once.removed);
  });
});
