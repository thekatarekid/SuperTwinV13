// ===========================================================================
// The G/H/I world builder (build item 1.5).
//
// The eval suite exercises this end to end 150 times; what is tested here is
// the plumbing that a failing case would otherwise blame on the product: the
// three-part `frozen_response`, the label discipline that lets an expectation
// name `a1` when the row says `ent_4f…`, and the roster's `[plc]` typing.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { runEntityCase } from "./entity-script.js";
import { splitScript } from "./entity-world.js";
import type { Fixture } from "../fixtures.js";

function fixture(frozen: string, given?: Partial<Fixture["given"]>): Fixture {
  return {
    id: "G-901",
    category: "G",
    layer: "entities",
    call: "[CODE]",
    mode: "steady",
    given: {
      roster: [],
      streams: [],
      events: [],
      open: { episodes: [], loops: [] },
      db: { entities: [], claims: [], arcs: [] },
      ...given,
    },
    frozen_response: frozen,
    expect: {},
    assert: { mode: "state" },
  };
}

describe("the three-part frozen response", () => {
  it("splits script, wire and post-script", () => {
    const parts = splitScript(["me", "#WIRE", "M|1|x|-|0.5", "#POST", "compact"].join("\n"));
    expect(parts.script.map((l) => l.tag)).toEqual(["me"]);
    expect(parts.wire).toBe("M|1|x|-|0.5");
    expect(parts.post.map((l) => l.tag)).toEqual(["compact"]);
  });

  it("treats a response with no dividers as script only", () => {
    const parts = splitScript("bind|as=p|src=s|kind=phone|v=+919800000001");
    expect(parts.script).toHaveLength(1);
    expect(parts.wire).toBe("");
    expect(parts.post).toEqual([]);
  });

  it("refuses a field without an `=` rather than guessing what was meant", () => {
    expect(() => splitScript("bind|src")).toThrow(/field without '='/);
  });
});

describe("labels", () => {
  it("reports the label an expectation can name, not the minted id", () => {
    const produced = runEntityCase(
      fixture(
        [
          "bind|as=p|src=whatsapp|kind=jid|v=919800000001@s.whatsapp.net|name=Pranjali",
          "bind|as=c|src=contacts|kind=phone|v=+919800000001|name=Pranjali Sachdeva",
        ].join("\n"),
      ),
      [
        "bind|as=p|src=whatsapp|kind=jid|v=919800000001@s.whatsapp.net|name=Pranjali",
        "bind|as=c|src=contacts|kind=phone|v=+919800000001|name=Pranjali Sachdeva",
      ].join("\n"),
    );
    // Both binds land on one entity, and it keeps the label it was first given.
    expect(produced.state.last_bound_to).toBe("p");
    expect(produced.state.distinct_entities).toBe(1);
    expect((produced.output.entities as { as: string }[]).map((e) => e.as)).toEqual(["p"]);
  });

  it("types a roster entry from its `[code]` suffix", () => {
    const given = { roster: ["a1=Rahul", "a2=Indiranagar [plc]"] };
    const produced = runEntityCase(fixture("", given), "");
    expect(produced.output.entities).toEqual([
      { as: "a1", type: "person", subtype: null, canonical: "Rahul" },
      { as: "a2", type: "place", subtype: null, canonical: "Indiranagar" },
    ]);
  });

  it("refuses a roster type outside the nine", () => {
    expect(() => runEntityCase(fixture("", { roster: ["a1=Zomato [app_site]"] }), "")).toThrow(
      /names no known type/,
    );
  });
});

describe("the model seam", () => {
  it("counts a P-EP1 answer as exactly one model call, and a script as none", () => {
    const script = "bind|as=p|src=whatsapp|kind=jid|v=919800000001@s.whatsapp.net|name=Pranjali";
    expect(runEntityCase(fixture(script), script).state.model_calls).toBe(0);

    const withWire = `${script}\n#WIRE\nN|k1|Indiranagar|plc|area`;
    expect(runEntityCase(fixture(withWire), withWire).state.model_calls).toBe(1);
  });

  it("counts a claim line rather than throwing on it — another pass owns it", () => {
    const given = { roster: ["a1=Rahul"], events: [{ n: 1, ts: "2026-08-14T09:10+05:30", who: "a1", text: "hi" }] };
    const frozen = "#WIRE\nO|1|a1|ao|0.8|-|Rahul is impossible to plan with";
    const produced = runEntityCase(fixture(frozen, given), frozen);
    expect(produced.state.other_lines).toBe(1);
    expect(produced.output.edges).toEqual([]);
  });
});
