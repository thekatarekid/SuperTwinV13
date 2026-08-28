// ===========================================================================
// EXTRACT v1 (build P1.4, spec §8.3): output validation is tolerant per entry
// — a malformed claim is skipped and reported, never a thrown batch; evidence
// is mandatory per claim; tone updates need a scope.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { EXTRACT_V1_SYSTEM, validateExtractOutput } from "./extract.v1.js";

describe("extract.v1", () => {
  it("carries the spec §8.3 core verbatim markers", () => {
    expect(EXTRACT_V1_SYSTEM).toContain("UNKNOWN BEATS WRONG");
    expect(EXTRACT_V1_SYSTEM).toContain("an ad is NEVER a preference");
    expect(EXTRACT_V1_SYSTEM).toContain("JSON only.");
  });

  it("throws on a non-object top level (the repair trigger)", () => {
    expect(() => validateExtractOutput([])).toThrow(/single JSON object/);
    expect(() => validateExtractOutput("claims")).toThrow();
  });

  it("accepts a full well-formed output", () => {
    const out = validateExtractOutput({
      claims: [
        {
          kind: "preference",
          subject: "ent_1",
          text: "prefers window seats",
          relation: "new",
          evidence: [{ event_ids: ["e1"], quote: "window seat pls" }],
          confidence: 0.8,
          valid_from: "2026-08-01",
        },
      ],
      provisional_people: [{ name: "Sameer", hint: "Rohan's cousin" }],
      tone: [
        {
          person: "ent_1",
          register: "casual",
          language_mix: "Hinglish",
          address_terms: [{ term: "bro", class: "generic" }],
        },
      ],
    });
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].relation).toBe("new");
    expect(out.provisional_people[0].name).toBe("Sameer");
    expect(out.tone[0].address_terms?.[0]).toEqual({ term: "bro", class: "generic" });
    expect(out.skipped).toHaveLength(0);
  });

  it("skips (never throws on) claims without evidence — no evidence, no write", () => {
    const out = validateExtractOutput({
      claims: [
        { kind: "fact", subject: "ent_1", text: "no proof", confidence: 0.9 },
        {
          kind: "fact",
          subject: "ent_1",
          text: "with proof",
          evidence: [{ event_ids: ["e2"], quote: "said so" }],
          confidence: 0.9,
        },
      ],
    });
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].text).toBe("with proof");
    expect(out.skipped).toEqual([
      expect.objectContaining({ section: "claims", reason: "no evidence quote" }),
    ]);
  });

  it("degrades an unknown relation to 'new' and defaults missing sections", () => {
    const out = validateExtractOutput({
      claims: [
        {
          kind: "fact",
          subject: "ent_1",
          text: "x",
          relation: "supersedes",
          evidence: [{ event_ids: [], quote: "q" }],
        },
      ],
    });
    expect(out.claims[0].relation).toBe("new");
    expect(out.provisional_people).toEqual([]);
    expect(out.tone).toEqual([]);
  });

  it("skips tone entries with neither person nor stream scope", () => {
    const out = validateExtractOutput({ tone: [{ register: "casual" }] });
    expect(out.tone).toHaveLength(0);
    expect(out.skipped[0].section).toBe("tone");
  });
});
