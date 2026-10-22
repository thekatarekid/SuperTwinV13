import { describe, expect, it } from "vitest";
import { act, lineFor, moodOf, newStats, tick } from "./state.ts";

const H = 3_600_000;

describe("pet stats", () => {
  it("decays over real time and bottoms out at 0", () => {
    const s = newStats(0);
    const later = tick(s, 2 * H);
    expect(later.food).toBeCloseTo(66);
    expect(later.joy).toBeCloseTo(68);
    expect(later.energy).toBeCloseTo(70);
    const days = tick(s, 72 * H);
    expect([days.food, days.joy, days.energy]).toEqual([0, 0, 0]);
  });

  it("restores energy while asleep and wakes up when rested", () => {
    const tired = { ...newStats(0), energy: 20, asleep: true };
    const mid = tick(tired, 2 * H);
    expect(mid.energy).toBeCloseTo(70);
    expect(mid.asleep).toBe(true);
    const rested = tick(tired, 4 * H);
    expect(rested.energy).toBe(100);
    expect(rested.asleep).toBe(false);
  });

  it("feeding, playing and sleeping change stats with sensible refusals", () => {
    const s = { ...newStats(0), food: 40 };
    expect(act(s, "feed", 0).stats.food).toBe(65);
    expect(act({ ...s, food: 99 }, "feed", 0).accepted).toBe(false);
    const played = act(s, "play", 0);
    expect(played.stats.joy).toBe(100);
    expect(played.stats.energy).toBe(70);
    expect(act({ ...s, energy: 5 }, "play", 0).reason).toMatch(/tired/);
    expect(act({ ...s, energy: 95 }, "sleep", 0).accepted).toBe(false);
    const asleep = act({ ...s, energy: 50 }, "sleep", 0).stats;
    expect(asleep.asleep).toBe(true);
    expect(act(asleep, "feed", 0).accepted).toBe(false);
    expect(act(asleep, "wake", 0).stats.asleep).toBe(false);
  });

  it("derives a mood in priority order", () => {
    const base = newStats(0);
    expect(moodOf({ ...base, asleep: true, food: 0 })).toBe("sleeping");
    expect(moodOf({ ...base, food: 10, energy: 10 })).toBe("hungry");
    expect(moodOf({ ...base, energy: 10 })).toBe("tired");
    expect(moodOf({ ...base, joy: 10 })).toBe("sad");
    expect(moodOf(base)).toBe("happy");
    expect(moodOf({ ...base, food: 50 })).toBe("okay");
  });

  it("has a line for every mood", () => {
    for (const m of ["sleeping", "hungry", "tired", "sad", "happy", "okay"] as const) expect(lineFor(m, "Kid", 0.9)).toBeTruthy();
    expect(lineFor("happy", "Kid", 0.1)).toContain("Kid");
  });
});
