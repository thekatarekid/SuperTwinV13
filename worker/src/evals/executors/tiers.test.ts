// ===========================================================================
// [CODE] The category-B executor seam (build item 1.2).
//
// The tiering behaviour itself is tested next to the product (tiers/*.test.ts)
// and asserted 50 times over by evals/fixtures/B-*.json. What is tested here is
// the SEAM: that the executor reports what the product actually did, in the
// shape the fixtures assert on, and that a scenario it cannot read fails the
// case loudly instead of quietly reporting nothing.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { validateFixture, type Fixture } from "../fixtures.js";
import type { Produced } from "../runner.js";
import { tiersExecutor } from "./tiers.js";

function fixtureOf(over: Partial<Fixture["given"]> = {}): Fixture {
  return validateFixture(
    {
      id: "B-001",
      category: "B",
      layer: "tiers",
      call: "[CODE]",
      mode: "steady",
      given: {
        roster: ["a1=Pranjali"],
        streams: [{ alias: "c1", name: "Pranjali", kind: "dm", participants: ["self", "a1"] }],
        events: [{ n: 1, ts: "2026-08-14T09:10+05:30", who: "a1", text: "saturday?", c: "c1" }],
        open: { episodes: [], loops: [] },
        db: { entities: [], claims: [], arcs: [] },
        ...over,
      },
      frozen_response: "assign",
      expect: {},
      assert: { mode: "no_throw" },
    },
    "<test>",
  );
}

function run(response: string, given?: Partial<Fixture["given"]>): Produced {
  return tiersExecutor({ fixture: fixtureOf(given), response, mode: "frozen" }) as Produced;
}

describe("the tiers executor", () => {
  it("reports the tier the product stored, not one it computed for the report", () => {
    const produced = run("assign");
    expect(produced.state.tier).toBe("T1");
    expect(produced.state.stored_tier).toBe("T1");
    expect(produced.state.rule).toBe("dm_person");
    expect(produced.state.coverage_assertion).toBe("passed");
    expect(produced.metrics.tier_coverage).toBe(1);
  });

  it("drives P-TI1 through the real prompt and the real parser", () => {
    const produced = run(
      "assign\n#TI1\nJ|c1|pm|0.83|campaign copy with one order notice",
      {
        roster: ["a20=Myntra"],
        streams: [{ alias: "c1", name: "Myntra", kind: "biz", participants: ["self", "a20"] }],
        events: [
          { n: 1, ts: "2026-08-14T09:10+05:30", who: "a20", text: "End of season sale. 50% off", c: "c1" },
          { n: 2, ts: "2026-08-14T10:10+05:30", who: "a20", text: "Your order MY8817 has been shipped", c: "c1" },
        ],
      },
    );
    expect(produced.state.tier).toBe("T4");
    expect(produced.state.tier_source).toBe("p-ti1");
    expect(produced.state.model_calls).toBe(1);
    expect(produced.metrics.value).toBe(0.83);
  });

  it("reads the doc's loose horizon spellings rather than failing a case over a typo", () => {
    const produced = run(
      "cohort|id=k1|tier=T1|horizon=holder|age_min=576000\ncohort|id=k2|tier=T2|horizon=h7d|age_min=1\ndrain",
      { streams: [], events: [] },
    );
    expect(produced.state.order).toEqual(["k1", "k2"]);
  });

  it("throws on a record it does not know, so the case fails instead of asserting nothing", () => {
    expect(() => run("teleport|c=c1")).toThrow(/unknown record/);
    expect(() => run("cohort|id=k1|tier=T9|horizon=live")).toThrow(/not a tier/);
    expect(() => run("cohort|id=k1|tier=T1|horizon=yesterday")).toThrow(/not a horizon/);
  });
});
