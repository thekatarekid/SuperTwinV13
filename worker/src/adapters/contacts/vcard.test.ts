// ===========================================================================
// The vCard-like parser (build item 5.2): the subset it reads, the folding it
// unfolds, and the guessing it refuses to do.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { parseRev, parseVcards } from "./vcard.js";

const CARD = `BEGIN:VCARD
VERSION:3.0
UID:card-1
FN:Rahul Arora
TEL;TYPE=CELL:+91 98123 45001
TEL;TYPE=CELL:+91 98123 45001
EMAIL;TYPE=HOME:rahul.
 arora@gmail.com
REV:20250110T090000Z
END:VCARD`;

describe("parseVcards", () => {
  it("reads UID, FN, TEL, EMAIL and REV", () => {
    const cards = parseVcards(CARD);
    expect(cards).toHaveLength(1);
    expect(cards[0].uid).toBe("card-1");
    expect(cards[0].fn).toBe("Rahul Arora");
    expect(cards[0].phones).toEqual(["+91 98123 45001"]); // duplicate dropped
    expect(cards[0].rev).toBe("2025-01-10T09:00:00.000Z");
  });

  it("unfolds RFC-6350 folded lines", () => {
    expect(parseVcards(CARD)[0].emails).toEqual(["rahul.arora@gmail.com"]);
  });

  it("does NOT normalise values — that is the graph's job, done once", () => {
    // The phone leaves the parser exactly as the fixture wrote it.
    expect(parseVcards(CARD)[0].phones[0]).toContain(" ");
  });

  it("parses multiple cards in file order and accepts CRLF", () => {
    const two = `${CARD}\r\n${CARD.replace("card-1", "card-2").replace("Rahul Arora", "Priya")}`;
    const cards = parseVcards(two);
    expect(cards.map((c) => c.uid)).toEqual(["card-1", "card-2"]);
  });

  it("drops a card with neither UID nor FN, and falls back to FN as uid", () => {
    const anon = "BEGIN:VCARD\nTEL:+911234\nEND:VCARD";
    expect(parseVcards(anon)).toHaveLength(0);
    const named = "BEGIN:VCARD\nFN:Only Name\nEND:VCARD";
    expect(parseVcards(named)[0].uid).toBe("Only Name");
  });

  it("skips malformed lines instead of guessing", () => {
    const messy = "BEGIN:VCARD\nUID:u1\nNO_COLON_HERE\nTEL:+911234\nEND:VCARD";
    const cards = parseVcards(messy);
    expect(cards).toHaveLength(1);
    expect(cards[0].phones).toEqual(["+911234"]);
  });
});

describe("parseRev", () => {
  it("reads vCard basic format and ISO-8601, and refuses garbage", () => {
    expect(parseRev("20250110T090000Z")).toBe("2025-01-10T09:00:00.000Z");
    expect(parseRev("2025-01-10T09:00:00Z")).toBe("2025-01-10T09:00:00.000Z");
    expect(parseRev("last tuesday")).toBeNull();
    expect(parseRev("")).toBeNull();
  });
});
