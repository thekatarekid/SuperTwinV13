// ===========================================================================
// judge.v1 — pick and quote (V6 P1 S5.5, Prompts P-09). The prompt asks for
// verbatim quotes; CODE enforces it. These are the two enforcement rules the
// bar rests on for `uncited_claim = 0`: an id the judge invented is dropped,
// and a "quote" that is not actually in its passage is dropped. Zero model
// calls — the raw strings are the model's half, written out.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { isVerbatim, packJudgeInput, parseJudgeOutput, type JudgePassage } from "./judge.v1.js";

const PASSAGES: JudgePassage[] = [
  { id: "e_2288", text: "max 6k a night yaar, we can't do more", meta: "you · 2026-08-24 · wa:goa-gang" },
  { id: "e_2290", text: "keep it under 20k pp all in", meta: "Rohan · 2026-08-24 · wa:goa-gang" },
  { id: "e_2291", text: "lunch tomorrow?", meta: "Karan · 2026-08-25 · wa:goa-gang" },
];

describe("isVerbatim", () => {
  it("is whitespace-insensitive and case-insensitive, not meaning-insensitive", () => {
    expect(isVerbatim("max 6k a night", PASSAGES[0]!.text)).toBe(true);
    expect(isVerbatim("MAX   6k  a night", PASSAGES[0]!.text)).toBe(true);
    expect(isVerbatim("six thousand a night", PASSAGES[0]!.text)).toBe(false);
    expect(isVerbatim("", PASSAGES[0]!.text)).toBe(false);
  });
});

describe("parseJudgeOutput", () => {
  it("keeps results whose quote really is in their passage", () => {
    const out = parseJudgeOutput(
      `{"results":[{"id":"e_2288","quote":"max 6k a night","why":"the user's cap"},` +
        `{"id":"e_2290","quote":"under 20k pp","why":"Rohan's total"}],` +
        `"answer":"₹6k max per night — you said so on Aug 24; Rohan framed it as under ₹20k per person."}`,
      PASSAGES,
    );
    expect(out.results.map((r) => r.id)).toEqual(["e_2288", "e_2290"]);
    expect(out.dropped).toEqual([]);
    expect(out.answer).toContain("₹6k");
  });

  it("drops an invented id — the bar can only cite what it retrieved", () => {
    const out = parseJudgeOutput(`{"results":[{"id":"e_9999","quote":"whatever","why":"…"}],"answer":"₹8k a night"}`, PASSAGES);
    expect(out.results).toEqual([]);
    expect(out.dropped).toEqual([{ id: "e_9999", reason: "unknown_id" }]);
  });

  it("drops a paraphrase presented as a quote", () => {
    const out = parseJudgeOutput(
      `{"results":[{"id":"e_2288","quote":"the budget is six thousand rupees a night","why":"…"}],"answer":"₹6k"}`,
      PASSAGES,
    );
    expect(out.results).toEqual([]);
    expect(out.dropped[0]!.reason).toBe("not_verbatim");
  });

  it("drops an empty quote and de-dupes a repeated id", () => {
    const out = parseJudgeOutput(
      `{"results":[{"id":"e_2291","quote":"","why":"x"},{"id":"e_2288","quote":"max 6k","why":"a"},{"id":"e_2288","quote":"a night","why":"b"}],"answer":null}`,
      PASSAGES,
    );
    expect(out.results.map((r) => r.id)).toEqual(["e_2288"]);
    expect(out.dropped[0]!.reason).toBe("empty_quote");
    expect(out.answer).toBeNull();
  });

  it("caps at five results and survives junk", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: PASSAGES[i % 3]!.id, quote: PASSAGES[i % 3]!.text.slice(0, 8), why: "x" }));
    const out = parseJudgeOutput(JSON.stringify({ results: many, answer: "…" }), PASSAGES);
    expect(out.results.length).toBeLessThanOrEqual(5);
    expect(parseJudgeOutput("nothing", PASSAGES)).toEqual({ results: [], answer: null, dropped: [] });
    expect(parseJudgeOutput("{oops}", PASSAGES)).toEqual({ results: [], answer: null, dropped: [] });
  });

  it("treats an empty or \"null\" answer as no answer at all", () => {
    expect(parseJudgeOutput(`{"results":[],"answer":""}`, PASSAGES).answer).toBeNull();
    expect(parseJudgeOutput(`{"results":[],"answer":"null"}`, PASSAGES).answer).toBeNull();
  });
});

describe("packJudgeInput", () => {
  it("numbers the passages and shows each id and its attribution", () => {
    const packed = packJudgeInput("how much per night?", PASSAGES);
    expect(packed).toContain("QUESTION how much per night?");
    expect(packed).toContain("[1] id=e_2288 (you · 2026-08-24 · wa:goa-gang)");
    expect(packed).toContain("max 6k a night yaar");
    expect(packed).toContain("[3] id=e_2291");
  });
});
