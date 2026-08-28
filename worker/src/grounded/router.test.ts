// ===========================================================================
// Bar intent router parse contracts (build P4.1, spec §14.8.1). Offline:
// only the parse halves of bar-intent.v1 and bar-action.v1 — the traced
// call itself is exercised by the USR live evals, not unit tests.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { parseIntentOutput, packIntentInput } from "../prompts/bar-intent.v1.js";
import { parseActionOutput, packActionInput } from "../prompts/bar-action.v1.js";

describe("parseIntentOutput (bar-intent.v1)", () => {
  it("parses each of the four intents", () => {
    for (const intent of ["search", "question", "action", "correction"] as const) {
      expect(parseIntentOutput(`{"intent":"${intent}"}`)).toBe(intent);
    }
  });

  it("defaults to search on garbage, prose and unknown intents (ambiguity rule)", () => {
    expect(parseIntentOutput("")).toBe("search");
    expect(parseIntentOutput("I think this is a question")).toBe("search");
    expect(parseIntentOutput(`{"intent":"chat"}`)).toBe("search");
    expect(parseIntentOutput(`{"intent": 4}`)).toBe("search");
    expect(parseIntentOutput("{broken json")).toBe("search");
  });

  it("finds the object inside a prefixed line", () => {
    expect(parseIntentOutput(`Sure: {"intent":"action"}`)).toBe("action");
  });

  it("packs the utterance verbatim", () => {
    expect(packIntentInput("plan a hampi trek")).toBe("UTTERANCE plan a hampi trek");
  });
});

describe("parseActionOutput (bar-action.v1)", () => {
  it("parses a full create_space plan", () => {
    const out = parseActionOutput(
      `{"verb":"create_space","title":"Hampi trek Oct","risky":false,"goal":"trek","chapters":["Travel","Stay"],"first_tasks":["book train"]}`,
    );
    expect(out).toEqual({
      verb: "create_space",
      title: "Hampi trek Oct",
      risky: false,
      goal: "trek",
      chapters: ["Travel", "Stay"],
      first_tasks: ["book train"],
    });
  });

  it("parses candidates for the ask-once path", () => {
    const out = parseActionOutput(
      `{"verb":"create_task","title":"buy sunscreen","space_candidates":["sp_a","sp_b"],"risky":false}`,
    );
    expect(out?.space_candidates).toEqual(["sp_a", "sp_b"]);
  });

  it("returns null for a missing verb/title — never invents a mutation", () => {
    expect(parseActionOutput(`{"verb":"create_task"}`)).toBeNull();
    expect(parseActionOutput(`{"title":"x"}`)).toBeNull();
    expect(parseActionOutput(`{"verb":"fly","title":"x"}`)).toBeNull();
    expect(parseActionOutput("no json here")).toBeNull();
  });

  it("packs date, spaces and sweep into the variable half", () => {
    const packed = packActionInput({
      text: "plan a hampi trek",
      today: "2026-08-29",
      spaces: [{ id: "sp_goa", label: "Goa trip" }],
      sweep: ["[evt e1] hampi mention"],
    });
    expect(packed).toContain("TODAY 2026-08-29");
    expect(packed).toContain("sp_goa");
    expect(packed).toContain("[evt e1] hampi mention");
    expect(packed).toContain("UTTERANCE plan a hampi trek");
  });
});
