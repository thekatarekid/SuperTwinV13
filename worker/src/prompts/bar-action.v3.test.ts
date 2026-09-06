// ===========================================================================
// bar-action.v3 — the contract v2 stated but never showed (V6 P1 S6 gate).
//
// USR-03 puts "add task: buy sunscreen for goa" in front of TWO active spaces
// that both contain "Goa". v2 told the model to list `space_candidates` and
// then showed it exactly one worked example, which ended in a `space_hint` —
// so the model filed a coin flip on all three S6 runs and breached the hard
// `guess_rate = 0` gate. v3 adds the second example.
//
// Zero model calls: these assert the prompt TEXT and the shared parser.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  BAR_ACTION_V2_INSTRUCTIONS,
  BAR_ACTION_V2_VERSION,
} from "./bar-action.v2.js";
import {
  BAR_ACTION_V3_INSTRUCTIONS,
  BAR_ACTION_V3_VERSION,
  parseActionOutput,
} from "./bar-action.v3.js";

describe("bar-action.v3", () => {
  it("is a NEW version — v2 stays in the tree and stays reproducible", () => {
    expect(BAR_ACTION_V3_VERSION).toBe("bar-action.v3");
    expect(BAR_ACTION_V2_VERSION).toBe("bar-action.v2");
    expect(BAR_ACTION_V3_INSTRUCTIONS).not.toBe(BAR_ACTION_V2_INSTRUCTIONS);
  });

  it("SHOWS the ambiguous case, not only states it", () => {
    // v2's failure was pedagogical, not logical: the rule was there.
    expect(BAR_ACTION_V2_INSTRUCTIONS).toContain("space_candidates");
    // v3 carries a worked example that ends in space_candidates and, in that
    // example, no space_hint at all.
    const exampleB = BAR_ACTION_V3_INSTRUCTIONS.slice(BAR_ACTION_V3_INSTRUCTIONS.indexOf("Example B"));
    const jsonLine = exampleB.split("\n").find((l) => l.trimStart().startsWith("{"))!;
    expect(jsonLine).toContain('"space_candidates":["sp_goa_dec","sp_goa_wedding"]');
    // The OBJECT carries no space_hint — that is the whole lesson. (The prose
    // above it says the words "NO \"space_hint\"", which is why this asserts on
    // the JSON line rather than the whole example.)
    expect(jsonLine).not.toContain("space_hint");
    // ...and it names the trap in words a model can match on.
    expect(BAR_ACTION_V3_INSTRUCTIONS).toContain("DO NOT PICK");
    expect(BAR_ACTION_V3_INSTRUCTIONS).toContain("A shared word in two space");
  });

  it("keeps every contract v2 established", () => {
    for (const clause of [
      '"verb"',
      '"title" — REQUIRED',
      '"risky"',
      "create_space",
      "create_task",
      "remind",
      "execute",
      "one JSON object on one line",
      // The maxTurns:1 hardening — a preamble spends the only turn (USR-02).
      'FIRST character must be "{"',
      "you\nget ONE turn",
      "Guessing wrong is worse than asking",
    ]) {
      expect(BAR_ACTION_V3_INSTRUCTIONS, clause).toContain(clause);
    }
  });

  it("both worked examples parse through the SHARED v1 parser", () => {
    const a = parseActionOutput(
      '{"verb":"remind","title":"Renew car insurance","due":"2026-09-05","risky":false,"space_hint":"sp_money"}',
    );
    expect(a?.verb).toBe("remind");
    expect(a?.space_hint).toBe("sp_money");

    const b = parseActionOutput(
      '{"verb":"create_task","title":"Buy sunscreen for Goa","risky":false,"space_candidates":["sp_goa_dec","sp_goa_wedding"]}',
    );
    expect(b?.verb).toBe("create_task");
    expect(b?.space_hint).toBeUndefined();
    expect(b?.space_candidates).toEqual(["sp_goa_dec", "sp_goa_wedding"]);
  });
});
