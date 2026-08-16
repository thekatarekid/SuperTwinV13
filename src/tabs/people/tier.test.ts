// The computed contact tier (build item 3.10).
//
//   inner_circle  bidirectional ≥8 of the last 12 weeks
//   active        bidirectional in the last 4 weeks
//   dormant       3 months
//   archived      12 months

import { describe, expect, it } from "vitest";

import { deriveTier, reciprocityLabel, tierAgreement } from "./tier";
import type { ContactStats } from "../../lib/people-client";

function stats(over: Partial<ContactStats> = {}): ContactStats {
  return {
    bidirectionalWeeks12: 0,
    bidirectionalLast4Weeks: false,
    daysSinceContact: null,
    reciprocity: null,
    reciprocityWindow: null,
    rhythmLabel: null,
    ...over,
  };
}

describe("deriveTier", () => {
  it("inner circle at exactly 8 of 12 weeks — the threshold is inclusive", () => {
    const d = deriveTier(stats({ bidirectionalWeeks12: 8 }));
    expect(d.tier).toBe("inner_circle");
    expect(d.because).toBe("both ways in 8 of the last 12 weeks");
  });

  it("7 of 12 weeks is not inner circle", () => {
    expect(deriveTier(stats({ bidirectionalWeeks12: 7, bidirectionalLast4Weeks: true })).tier).toBe(
      "active",
    );
  });

  it("active on a bidirectional exchange in the last 4 weeks", () => {
    const d = deriveTier(stats({ bidirectionalLast4Weeks: true, daysSinceContact: 9 }));
    expect(d.tier).toBe("active");
    expect(d.because).toContain("4 weeks");
  });

  it("dormant at 3 months, archived at 12", () => {
    expect(deriveTier(stats({ daysSinceContact: 91 })).tier).toBe("dormant");
    expect(deriveTier(stats({ daysSinceContact: 200 })).tier).toBe("dormant");
    expect(deriveTier(stats({ daysSinceContact: 365 })).tier).toBe("archived");
  });

  it("no contact on record archives, and says so rather than printing a number", () => {
    const d = deriveTier(stats());
    expect(d.tier).toBe("archived");
    expect(d.because).toBe("no contact on record");
  });

  it("recent but one-sided contact stays active — silence is not overstated", () => {
    expect(deriveTier(stats({ daysSinceContact: 40 })).tier).toBe("active");
  });

  it("every tier ships an explanation — a badge with no arithmetic is not shippable", () => {
    for (const s of [
      stats({ bidirectionalWeeks12: 10 }),
      stats({ bidirectionalLast4Weeks: true }),
      stats({ daysSinceContact: 120 }),
      stats({ daysSinceContact: 400 }),
      stats(),
    ]) {
      expect(deriveTier(s).because.length).toBeGreaterThan(0);
    }
  });
});

describe("tierAgreement", () => {
  it("is silent when the worker and the numbers agree", () => {
    expect(tierAgreement("inner_circle", stats({ bidirectionalWeeks12: 9 }))).toBeNull();
  });

  it("names the disagreement rather than quietly preferring one side", () => {
    const note = tierAgreement("inner_circle", stats({ daysSinceContact: 400 }));
    expect(note).toBe("worker says inner_circle, these numbers say archived");
  });
});

describe("reciprocityLabel", () => {
  it("is never a bare ratio — the window travels with it", () => {
    expect(reciprocityLabel(stats({ reciprocity: 0.6, reciprocityWindow: "12 weeks" }))).toBe(
      "you sent 60% over 12 weeks",
    );
  });

  it("is null when nothing was measured", () => {
    expect(reciprocityLabel(stats())).toBeNull();
  });
});
