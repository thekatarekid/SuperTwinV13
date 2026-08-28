import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CATEGORIES,
  FixtureError,
  coverageGaps,
  isSelfTestId,
  loadDirectory,
  loadFixture,
  parseFixture,
  validateFixture,
} from "./fixtures.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SELFTEST = join(ROOT, "evals", "selftest");

/** The evals doc §2 fixture, verbatim, as the base every mutation starts from. */
function docExample(): Record<string, unknown> {
  return {
    id: "M-014",
    category: "M",
    layer: "claims",
    call: "P-CL1",
    mode: "steady",
    given: {
      roster: ["a1=Pranjali Sachdeva", "a3=ACT broadband [thg]"],
      streams: [{ alias: "c1", name: "Pranjali", kind: "dm", participants: ["self", "a1"] }],
      events: [
        { n: 1, ts: "2026-08-12T21:10+05:30", who: "a1", text: "i've started bhangra classes on saturdays" },
      ],
      open: { episodes: [], loops: [] },
      db: { entities: [], claims: [], arcs: [] },
    },
    frozen_response: "H|1|a1|1p|0.95|-|Attends bhangra classes on Saturdays",
    expect: {
      claims: [
        {
          kind: "habit",
          subject: "a1",
          attribution: "1p",
          text: "Attends bhangra classes on Saturdays",
          party_pair: "oo",
          evidence: [1],
        },
      ],
      loops: [],
    },
    assert: {
      mode: "set_equal",
      on: ["kind", "subject", "attribution", "party_pair"],
      gate: "claim_subject_accuracy",
    },
  };
}

function problemsOf(mutate: (f: Record<string, unknown>) => void): string[] {
  const fixture = docExample();
  mutate(fixture);
  try {
    validateFixture(fixture, "test.json");
  } catch (err) {
    if (err instanceof FixtureError) return err.problems;
    throw err;
  }
  return [];
}

describe("the §2 fixture schema", () => {
  it("accepts the evals doc's own example unchanged", () => {
    const fixture = validateFixture(docExample(), "M-014.json");
    expect(fixture.id).toBe("M-014");
    expect(fixture.assert.mode).toBe("set_equal");
    expect(fixture.assert.gate).toBe("claim_subject_accuracy");
    expect(fixture.given.events[0]!.n).toBe(1);
  });

  it("rejects a field that is not in §2 — a typo is not a fixture", () => {
    expect(problemsOf((f) => (f.expects = {}))).toEqual(["expects is not a field of the §2 fixture schema"]);
  });

  it("rejects a bad id, an unknown category, and a mismatched pair", () => {
    expect(problemsOf((f) => (f.id = "m-14"))[0]).toContain("must look like");
    expect(problemsOf((f) => (f.category = "Z"))[0]).toContain("not one of the 22 categories");
    expect(problemsOf((f) => (f.category = "N"))[0]).toContain("does not match the id prefix");
  });

  it("rejects a roster entry that is not alias=name", () => {
    expect(problemsOf((f) => ((f.given as { roster: string[] }).roster = ["Pranjali"]))[0]).toContain(
      'must look like "a1=Name"',
    );
  });

  it("rejects duplicate and non-positive event numbers", () => {
    const dupe = problemsOf((f) => {
      const given = f.given as { events: unknown[] };
      given.events = [
        { n: 1, ts: "t", who: "a1", text: "x" },
        { n: 1, ts: "t", who: "a1", text: "y" },
      ];
    });
    expect(dupe).toEqual(["given.events[1].n duplicate event number 1"]);
    expect(problemsOf((f) => ((f.given as { events: unknown[] }).events = [{ n: 0, ts: "t", who: "a", text: "b" }]))[0])
      .toContain("positive integer");
  });

  it("rejects an assertion mode outside §3 and a gate outside §14.2", () => {
    expect(problemsOf((f) => ((f.assert as { mode: string }).mode = "roughly"))[0]).toContain("must be one of");
    expect(problemsOf((f) => ((f.assert as { gate: string }).gate = "vibes"))[0]).toContain(
      "is not a gate in architecture §14.2",
    );
  });

  it("requires a bound on budget and an expect on everything that compares", () => {
    expect(problemsOf((f) => ((f.assert as { mode: string }).mode = "budget"))).toContain(
      "assert.bound is required for mode 'budget'",
    );
    expect(problemsOf((f) => (f.expect = {}))[0]).toContain("has nothing to compare");
  });

  it("reports every problem at once, not just the first", () => {
    const problems = problemsOf((f) => {
      f.id = "nope";
      f.mode = "whenever";
      (f.assert as { mode: string }).mode = "roughly";
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it("names the file in a JSON syntax error", () => {
    expect(() => parseFixture("{ not json", "B-001.json")).toThrow(/B-001\.json: invalid fixture/);
  });

  it("insists the file is named after the id", () => {
    expect(() => loadFixture(join(SELFTEST, "A-901.json"))).not.toThrow();
  });
});

describe("the self-test fixture set", () => {
  it("loads the 10 hand-written fixtures and covers all 7 assertion modes", () => {
    const loaded = loadDirectory(SELFTEST);
    expect(loaded.errors).toEqual([]);
    expect(loaded.fixtures).toHaveLength(10);
    const modes = new Set(loaded.fixtures.map((f) => f.assert.mode));
    expect([...modes].sort()).toEqual(["absent", "budget", "contains", "exact", "no_throw", "set_equal", "state"]);
  });

  it("uses the reserved 900+ block so it never counts as coverage", () => {
    const loaded = loadDirectory(SELFTEST);
    expect(loaded.fixtures.every((f) => isSelfTestId(f.id))).toBe(true);
    expect(coverageGaps(loaded.fixtures)).toHaveLength(CATEGORIES.length);
  });
});
