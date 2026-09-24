import { describe, expect, it } from "vitest";
import { Animator } from "./animator.ts";

describe("Animator", () => {
  it("keeps eyes closed and head down while sleeping", () => {
    const a = new Animator(() => 0.5);
    a.mood = "sleeping";
    const p = a.frame(1000);
    expect(p.blink).toEqual([1, 1]);
    expect(p.pitch).toBeGreaterThan(0.2);
  });

  it("blinks from time to time when awake", () => {
    const a = new Animator(() => 0.5);
    let closed = 0;
    for (let t = 0; t < 10_000; t += 16) if (a.frame(t).blink[0] > 0.5) closed++;
    expect(closed).toBeGreaterThan(3);
    expect(closed).toBeLessThan(200); // eyes are mostly open
  });

  it("plays a reaction and then returns to idle", () => {
    const a = new Animator(() => 0.5);
    a.frame(0);
    a.react("eat", 100);
    const chewing = [200, 260, 330, 400].map((t) => a.frame(t).mouth);
    expect(Math.max(...chewing)).toBeGreaterThan(0.5);
    expect(a.frame(5000).mouth).toBe(0);
  });

  it("opens the mouth while talking", () => {
    const a = new Animator(() => 0.5);
    a.talk = 0.8;
    expect(a.frame(100).mouth).toBeCloseTo(0.8);
  });
});

describe("Animator arms", () => {
  it("raises both arms to celebrate when playing and one to wave", () => {
    const a = new Animator(() => 0.5);
    a.react("play", 0);
    const [l, r] = a.frame(800).arms;
    expect(l).toBeGreaterThan(0.6);
    expect(r).toBeGreaterThan(0.6);
    a.react("wave", 1000);
    const w = a.frame(1800).arms;
    expect(w[0]).toBe(0);
    expect(w[1]).toBeGreaterThan(0.5);
    expect(a.frame(9000).arms).toEqual([0, 0]);
  });
});
