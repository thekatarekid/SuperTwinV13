// The source-contribution timeline — arch §14.4, "the core visual".

import { describe, expect, it } from "vitest";

import { buildTimeline, timelineSources } from "./timeline";
import type { ArcContribution } from "../../lib/threads-client";

const c = (episodeId: string, sourceLabel: string, at: string): ArcContribution => ({
  episodeId,
  sourceLabel,
  at,
});

describe("buildTimeline", () => {
  it("orders contributions in time and spreads them 0…1 across the span", () => {
    const timeline = buildTimeline([
      c("ep_3", "cal", "2025-09-01T00:00:00.000Z"),
      c("ep_1", "wa", "2025-06-01T00:00:00.000Z"),
      c("ep_2", "web", "2025-07-16T12:00:00.000Z"),
    ]);

    expect(timeline).not.toBeNull();
    expect(timeline!.marks.map((m) => m.sourceLabel)).toEqual(["wa", "web", "cal"]);
    expect(timeline!.marks[0].offset).toBe(0);
    expect(timeline!.marks[2].offset).toBe(1);
    expect(timeline!.marks[1].offset).toBeGreaterThan(0.4);
    expect(timeline!.marks[1].offset).toBeLessThan(0.6);
  });

  it("labels the ends from the data, never from today", () => {
    const timeline = buildTimeline([
      c("ep_1", "wa", "2025-06-04T00:00:00.000Z"),
      c("ep_2", "mmt", "2025-09-20T00:00:00.000Z"),
    ]);
    expect(timeline!.startAt).toBe("2025-06-04T00:00:00.000Z");
    expect(timeline!.endAt).toBe("2025-09-20T00:00:00.000Z");
    expect(timeline!.startLabel).not.toBe(timeline!.endLabel);
  });

  it("centres a zero-width span instead of dividing by zero", () => {
    const timeline = buildTimeline([c("ep_1", "wa", "2025-06-01T00:00:00.000Z")]);
    expect(timeline!.marks).toHaveLength(1);
    expect(timeline!.marks[0].offset).toBe(0.5);
  });

  it("drops an unreadable timestamp rather than placing a dot at a guess", () => {
    const timeline = buildTimeline([
      c("ep_1", "wa", "2025-06-01T00:00:00.000Z"),
      c("ep_bad", "web", "not a date"),
    ]);
    expect(timeline!.marks.map((m) => m.episodeId)).toEqual(["ep_1"]);
  });

  it("returns null when nothing is dated — no axis rather than a false one", () => {
    expect(buildTimeline([c("ep_bad", "web", "")])).toBeNull();
    expect(buildTimeline([])).toBeNull();
  });
});

describe("timelineSources", () => {
  it("lists each source once, in the order it first contributed", () => {
    const timeline = buildTimeline([
      c("ep_1", "wa", "2025-06-01T00:00:00.000Z"),
      c("ep_2", "wa", "2025-06-02T00:00:00.000Z"),
      c("ep_3", "web", "2025-06-03T00:00:00.000Z"),
    ]);
    expect(timelineSources(timeline!)).toEqual(["wa", "web"]);
  });
});
