// ===========================================================================
// Query planning (docs/v6-spec.md §1). The measured fact this exists for: of
// 90 candidate rows for the repro question, 88 matched ONLY on do/have/
// anything/on, and bm25 spent five of eight slots on them.
// ===========================================================================

process.env.TZ = "Asia/Kolkata";

import { describe, it, expect } from "vitest";

import { planQuery, stemPrefix, STOPWORDS } from "./query.js";

const FRIDAY = new Date("2026-07-31T09:00:00Z");

const plan = (q: string) => planQuery(q, FRIDAY);

describe("stopwords", () => {
  it("keeps what the question is about and drops what it is made of", () => {
    const p = plan("Do i have anything planned on sunday");
    expect(p.terms).toEqual(["planned", "sunday"]);
    expect(p.dropped).toEqual(["do", "have", "anything", "on"]);
    // "i" never gets as far as the list: single characters are not searched.
    expect(p.dropped).not.toContain("i");
  });

  it("knows the function words of the languages the chats are in", () => {
    const p = plan("kal ka plan kya hai bhai");
    expect(p.terms).toEqual(["kal", "plan", "bhai"]);
    expect(p.dropped).toEqual(["ka", "kya", "hai"]);
    // Marathi too — these chats switch language mid-sentence.
    expect(STOPWORDS.has("aahe")).toBe(true);
    expect(STOPWORDS.has("kuthe")).toBe(true);
  });

  it("searches the stopwords when they are all there is", () => {
    // Better a weak search than no search: this still finds "have you eaten".
    const p = plan("did you have it");
    expect(p.terms).toEqual(["did", "you", "have", "it"]);
    expect(p.match).toContain('"have"');
  });

  it("never drops a word that could be the question", () => {
    for (const word of ["book", "booking", "pay", "plan", "call", "send"]) {
      expect(STOPWORDS.has(word)).toBe(false);
    }
  });

  it("collapses repeats and is case-insensitive", () => {
    expect(plan("Lunch lunch LUNCH").terms).toEqual(["lunch"]);
  });
});

describe("stems", () => {
  it("reaches the other tense of the same word", () => {
    // "booked oye kake" from a question about a booking.
    expect(stemPrefix("booked")).toBe("book");
    expect(stemPrefix("booking")).toBe("book");
    expect(stemPrefix("planned")).toBe("plann");
    expect(stemPrefix("flights")).toBe("flight");
  });

  it("refuses a stem short enough to match half the corpus", () => {
    expect(stemPrefix("used")).toBeNull(); // "us" + prefix
    expect(stemPrefix("sunday")).toBeNull(); // nothing to strip
    expect(stemPrefix("जाना")).toBeNull(); // the suffix rules are English
  });

  it("puts the stem in the expression as a prefix term", () => {
    expect(plan("who booked it").match).toContain('"book"*');
  });
});

describe("the match expression", () => {
  it("carries the terms, the stems and every spelling of the dates", () => {
    const p = plan("Do i have anything planned on sunday");
    expect(p.match).toContain('"planned"');
    expect(p.match).toContain('"sunday"');
    expect(p.match).toContain('"02 aug 2026"');
    expect(p.match).toContain('"2026 08 02"');
    expect(p.match.split(" OR ").length).toBeGreaterThan(10);
  });

  it("adds the weekday NAME of a date the question gave in other words", () => {
    // A chat writes "saturday", not "01 Aug".
    const p = plan("anything on tomorrow");
    expect(p.phrases).toContain("saturday");
    expect(p.match).toContain('"saturday"');
  });

  it("never emits a phrase with no tokens in it", () => {
    // "--" survives sanitising but tokenizes to nothing, and an empty phrase is
    // an FTS5 syntax error, which used to mean a chat turn with no retrieval.
    expect(plan("-- ?? !!").match).toBe("");
    expect(plan("   ").match).toBe("");
    expect(plan("").match).toBe("");
  });

  it("offers the stem as a name candidate, because questions are possessive", () => {
    // sanitize() eats the apostrophe, and `pranjalis` resolves to nobody —
    // which is the whole of why "how is pranjali's health" found no chat.
    const p = plan("how is pranjali's health");
    expect(p.terms).toEqual(["pranjalis", "health"]);
    expect(p.names).toEqual(["pranjalis", "health", "pranjali"]);

    // A name that needs no stemming is offered exactly once — the rest of the
    // content words come along, and resolve to nobody, which costs one lookup.
    expect(plan("what did pranjali say").names).toEqual(["pranjali", "say"]);
  });

  it("cannot be escaped out of", () => {
    const p = plan('lunch" OR events_fts MATCH "x');
    expect(p.match).not.toContain('""');
    // Every fragment is a quoted phrase; the operator words are just words.
    expect(p.terms).toEqual(["lunch", "events_fts", "match"]);
    expect(p.match).toBe('"lunch" OR "events_fts" OR "match"');
  });
});
