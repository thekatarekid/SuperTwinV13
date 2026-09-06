// ===========================================================================
// FIX-C2 — the verbatim matcher.
//
// The rule under test is unchanged and non-negotiable: no write without a
// verbatim quote over real events. What this file pins is the difference
// between a MODEL FABRICATING and a model punctuating — because treating the
// second as the first is what emptied a $3 hour into `bundle_attempts`.
//
// Every "matches" case below is a real string pair off the 13.11.5 install's
// `bundle_attempts.last_error`; every "still fails" case is the property that
// makes the rule worth having.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { normalizeQuote, normalizeText, quoteIsVerbatim, quoteSegments } from "./verbatim.js";

describe("quoteIsVerbatim — the plain case is unchanged", () => {
  it("an exact span matches; a span that is not there does not", () => {
    expect(quoteIsVerbatim("booking the villa", ["thinking about booking the villa"])).toBe(true);
    expect(quoteIsVerbatim("booked the villa", ["thinking about booking the villa"])).toBe(false);
  });

  it("whitespace and the model's outer quotation marks are not content", () => {
    expect(quoteIsVerbatim('"₹5,400/night   · pool"', ["Villa Sol – Anjuna · ₹5,400/night · pool"])).toBe(true);
  });
});

describe("quoteIsVerbatim — punctuation the model owns, not the source", () => {
  it("a typographic apostrophe matches an ASCII one, in both directions", () => {
    expect(quoteIsVerbatim("this Sunday’s 1pm", ["Reading that as next weekend since this Sunday's 1pm is taken"])).toBe(true);
    expect(quoteIsVerbatim("this Sunday's 1pm", ["Reading that as next weekend since this Sunday’s 1pm is taken"])).toBe(true);
  });

  it("curly double quotes, en/em dashes and NBSP all fold on both sides", () => {
    expect(quoteIsVerbatim("“Villa Sol” — Anjuna", ['He said "Villa Sol" - Anjuna tomorrow'])).toBe(true);
    expect(quoteIsVerbatim("2 guests", ["Sun Sep 13, 1:00pm. 2 guests, Pizza"])).toBe(true);
  });

  it("zero-width joiners and emoji variation selectors do not make a quote a lie", () => {
    const source = "Happy teacher's day Uncle and Aunty and didi !!🙏️";
    expect(quoteIsVerbatim("Happy teacher's day Uncle and Aunty and didi !!🙏", [source])).toBe(true);
    expect(quoteIsVerbatim("signup​ dono", ["Ye karlo signup dono"])).toBe(true);
  });
});

describe("quoteIsVerbatim — the model's own elisions and joins", () => {
  it("an ellipsis is a gap, and each side of it must still be verbatim", () => {
    const source = "Kaam start naui hua ab tak... Abhi tak to meeting stakeholders and understanding";
    expect(quoteIsVerbatim("Kaam start naui hua ab tak… meeting stakeholders", [source])).toBe(true);
    // The gap is a gap, not a licence: a span that is nowhere still fails.
    expect(quoteIsVerbatim("Kaam start naui hua ab tak… signed the contract", [source])).toBe(false);
    // ...and the spans must be IN ORDER. Reversed is a different claim.
    expect(quoteIsVerbatim("meeting stakeholders… Kaam start naui", [source])).toBe(false);
  });

  it("a quote stitched from two cited events verifies against those events", () => {
    expect(quoteIsVerbatim("Nice; Are waah", ["Nice", "Are waah"])).toBe(true);
    // But only over the events the model actually cited.
    expect(quoteIsVerbatim("Nice; Are waah", ["Nice", "kal milte hain"])).toBe(false);
  });
});

describe("quoteIsVerbatim — what must keep failing", () => {
  it("a rewording is not a quote", () => {
    expect(quoteIsVerbatim("₹5,400 per night", ["Villa Sol – Anjuna · ₹5,400/night · pool"])).toBe(false);
  });

  it("case is content", () => {
    expect(quoteIsVerbatim("villa sol – anjuna", ["Villa Sol – Anjuna · ₹5,400/night"])).toBe(false);
  });

  it("nothing, punctuation alone, or no cited text is never verbatim", () => {
    expect(quoteIsVerbatim("", ["anything at all"])).toBe(false);
    expect(quoteIsVerbatim("   ", ["anything at all"])).toBe(false);
    expect(quoteIsVerbatim("…", ["anything at all"])).toBe(false);
    expect(quoteIsVerbatim("real words", [])).toBe(false);
    expect(quoteIsVerbatim("real words", ["", ""])).toBe(false);
  });
});

describe("the pieces", () => {
  it("normalizeQuote strips the outer marks; normalizeText does not trim content", () => {
    expect(normalizeQuote('  "hello   there"  ')).toBe("hello there");
    expect(normalizeText("a\n\nb")).toBe("a b");
  });

  it("quoteSegments splits only at elision and join marks", () => {
    expect(quoteSegments("one two")).toEqual(["one two"]);
    expect(quoteSegments("one…two")).toEqual(["one", "two"]);
    expect(quoteSegments("one; two")).toEqual(["one", "two"]);
    // A slash is a character in the source, never a join mark.
    expect(quoteSegments("₹5,400/night")).toEqual(["₹5,400/night"]);
  });
});
