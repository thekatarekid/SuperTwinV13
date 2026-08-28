import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { calendarBlock, fixtureSeed, seededFixtureIds } from "./seeds.js";

const FIXTURE_DIR = join(__dirname, "..", "..", "..", "..", "evals", "v13");

describe("fixture seeds", () => {
  it("every seed names a real fixture", () => {
    for (const id of seededFixtureIds()) {
      expect(existsSync(join(FIXTURE_DIR, `${id}.json`)), `${id}.json missing`).toBe(true);
    }
  });

  it("seeds carry state and/or items, never empty", () => {
    for (const id of seededFixtureIds()) {
      const seed = fixtureSeed(id)!;
      const hasState = typeof seed.state === "string" && seed.state.trim() !== "";
      const hasItems = Array.isArray(seed.items) && seed.items.length > 0;
      expect(hasState || hasItems, `${id} seed is empty`).toBe(true);
    }
  });

  it("unknown ids have no seed", () => {
    expect(fixtureSeed("NOPE-99")).toBeUndefined();
  });

  it("calendar block computes real weekdays", () => {
    const block = calendarBlock(new Date("2026-08-28T10:00:00Z"));
    expect(block).toContain("TODAY is 2026-08-28 (Friday)");
    expect(block).toContain("2026-09-01=Tue");
    expect(block).toContain("2026-12-01=Tue");
  });
});
