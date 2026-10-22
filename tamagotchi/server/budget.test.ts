import { describe, expect, it } from "vitest";
import { GenerationBudget } from "./budget.ts";

describe("GenerationBudget", () => {
  it("enforces the hourly and daily ceilings and recovers as time passes", () => {
    let now = 0;
    const b = new GenerationBudget(2, 3, () => now);
    expect(b.take()).toBeNull();
    expect(b.take()).toBeNull();
    expect(b.take()).toMatch(/Hourly limit/);
    now += 3_600_001;
    expect(b.take()).toBeNull();
    expect(b.take()).toMatch(/Daily limit/);
    now += 86_400_001;
    expect(b.take()).toBeNull();
  });
});
