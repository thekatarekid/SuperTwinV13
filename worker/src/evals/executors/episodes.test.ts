// ===========================================================================
// [CODE] The category-J executor seam (build item 2.1).
//
// The engine itself is tested next to the product (episodes/*.test.ts) and
// asserted 55 times over by evals/fixtures/J-*.json. What is tested here is the
// SEAM: that the executor reports what the product actually did, that the
// frozen [ML] layer really drives the real pre-flag, and that a scenario it
// cannot read fails the case loudly instead of quietly reporting nothing.
//
// It also measures item 2.1's acceptance number — the 1:1 default rate — over
// every J case at once, which no single fixture can do.
// ===========================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadFixture, validateFixture, type Fixture } from "../fixtures.js";
import type { Produced } from "../runner.js";
import { episodesExecutor } from "./episodes.js";

const GOLD = join(process.cwd(), "..", "evals", "fixtures");

function fixtureOf(over: Partial<Fixture["given"]> = {}): Fixture {
  return validateFixture(
    {
      id: "J-001",
      category: "J",
      layer: "episodes",
      call: "[CODE]",
      mode: "steady",
      given: {
        roster: ["a1=Rohan"],
        streams: [{ alias: "c1", name: "Rohan", kind: "dm", participants: ["self", "a1"] }],
        events: [
          { n: 1, ts: "2026-08-13T18:40+05:30", who: "a1", text: "goa dates?", c: "c1", topic: "goa" },
          { n: 2, ts: "2026-08-13T18:41+05:30", who: "self", text: "13th to 17th", c: "c1", topic: "goa" },
          { n: 3, ts: "2026-08-13T18:44+05:30", who: "a1", text: "vet on saturday", c: "c1", topic: "rabies" },
          { n: 4, ts: "2026-08-13T18:46+05:30", who: "self", text: "carry the card", c: "c1", topic: "rabies" },
        ],
        open: { episodes: [], loops: [] },
        db: { entities: [], claims: [], arcs: [] },
        ...over,
      },
      frozen_response: "",
      expect: {},
      assert: { mode: "no_throw" },
    },
    "<test>",
  );
}

function run(response: string, given?: Partial<Fixture["given"]>): Produced {
  return episodesExecutor({ fixture: fixtureOf(given), response, mode: "frozen" }) as Produced;
}

const SESSION = "session|id=s1|stream=c1|events=1-4|hash=h1";

describe("the episodes executor", () => {
  it("drives the real [ML] pre-flag off the frozen topic vectors", () => {
    const produced = run([SESSION, "run|session=s1", "#EP2 s1", "G|s1|1,2|new|-|0.9|goa", "G|s1|3,4|new|-|0.9|vet"].join("\n"));
    expect(produced.state.preflag_drift).toBe(true);
    expect(produced.state.preflag_reason).toBe("drift");
    expect(produced.state.decision).toBe("judged");
    expect(produced.metrics.model_calls).toBe(1);
  });

  it("reports the 1:1 default, and the zero call that goes with it", () => {
    const oneTopic = fixtureOf().given.events.map((e) => ({ ...e, topic: "goa" }));
    const produced = run([SESSION, "run|session=s1"].join("\n"), { events: oneTopic });
    expect(produced.state.preflag_reason).toBe("single_topic");
    expect(produced.state.decision).toBe("one_to_one");
    expect(produced.metrics.model_calls).toBe(0);
    expect(produced.metrics.one_to_one_rate).toBe(1);
    expect(produced.output.calls).toBeUndefined();
  });

  it("withholds the calibration row on request, and the pre-flag then measures nothing", () => {
    const produced = run(["calib|none=1", SESSION, "run|session=s1"].join("\n"));
    expect(produced.state.preflag_reason).toBe("uncalibrated");
    expect(produced.state.decision).toBe("one_to_one");
  });

  it("counts a replay as a hash-gate hit, not as a second call", () => {
    const produced = run(
      [SESSION, "run|session=s1", "rerun|session=s1|times=3", "#EP2 s1", "G|s1|1,2|new|-|0.9|goa", "G|s1|3,4|new|-|0.9|vet"].join("\n"),
    );
    expect(produced.state.decisions).toEqual(["judged", "hash_reuse", "hash_reuse", "hash_reuse"]);
    expect(produced.metrics.model_calls).toBe(1);
    expect(produced.state.stable_ids).toBe(true);
  });

  it("throws on a record it does not know, so the case fails instead of asserting nothing", () => {
    expect(() => run("teleport|c=c1")).toThrow(/unknown record/);
    expect(() => run("run|session=nope")).toThrow(/unknown session/);
    expect(() => run("session|id=s1|stream=c9|events=1")).toThrow(/unknown stream/);
  });
});

describe("the J corpus", () => {
  const ids = readdirSync(GOLD)
    .filter((f) => f.startsWith("J-") && f.endsWith(".json"))
    .sort();

  it("has all 55 rows authored, none left a stub", () => {
    expect(ids).toHaveLength(55);
    for (const file of ids) {
      const fixture = JSON.parse(readFileSync(join(GOLD, file), "utf8")) as Fixture;
      expect(fixture.stub).toBe(false);
    }
  });

  it("defaults to 1:1 on at least 60% of the sessions that pose the question", () => {
    // Item 2.1's acceptance. The population is every J case that runs a pass
    // WITHOUT a frozen P-EP2 answer waiting for it — i.e. every session the
    // corpus poses as ordinary. A split or attach case is a session that was
    // chosen precisely because it is not ordinary, and counting those would
    // measure the eval set's editorial slant, not the engine's thrift.
    let posed = 0;
    let defaulted = 0;
    for (const file of ids) {
      const fixture = loadFixture(join(GOLD, file));
      if (!fixture.frozen_response.includes("run|")) continue;
      if (fixture.frozen_response.includes("#EP2")) continue;
      const produced = episodesExecutor({ fixture, response: fixture.frozen_response, mode: "frozen" }) as Produced;
      posed += 1;
      if (produced.state.decision === "one_to_one") defaulted += 1;
      expect(produced.metrics.model_calls).toBe(0);
    }
    expect(posed).toBeGreaterThanOrEqual(20);
    expect(defaulted / posed).toBeGreaterThanOrEqual(0.6);
  });
});
