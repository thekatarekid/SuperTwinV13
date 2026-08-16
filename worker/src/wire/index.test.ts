import { describe, expect, it } from "vitest";

import {
  accountingHolds,
  lineViolations,
  mergeRepair,
  noWireLinesViolation,
  parseWire,
  repairRequest,
  roundTrip,
  serialize,
} from "./index.js";

// A seeded PRNG: a totality suite that cannot be reproduced is a rumour.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOUP_TOKENS = [
  "T", "F", "Y", "V", "J", "?", "X", "K", "**", "```", "#", "-", "|", "||", "a1", "a9", "self",
  "+Rahul Arora", "1p", "i2t", "{due:2026-08-08}", "{conf:0.8}", "{due}", "0.9", "", "12-15",
  "7,8,c-f", "2026-09-15", "prose text", "—", "\t", "ünicode", "sideways", "s1", "H1", "e1",
  "op", "dn", "one", "rec", "tx", "au", "monthly", "  ", "0", "1.4", "zzzzzz", "🙂",
];

function randomSoup(rnd: () => number): string {
  const lines = 1 + Math.floor(rnd() * 6);
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    const n = Math.floor(rnd() * 14);
    const parts: string[] = [];
    for (let j = 0; j < n; j += 1) parts.push(SOUP_TOKENS[Math.floor(rnd() * SOUP_TOKENS.length)]);
    out.push(parts.join(rnd() < 0.7 ? "|" : " "));
  }
  return out.join("\n");
}

function randomBytes(rnd: () => number): string {
  const len = Math.floor(rnd() * 120);
  let s = "";
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(Math.floor(rnd() * 0x2f00));
  return s;
}

const FULL_T_LINE = "T|2|self|a1|ex|i2t|l|d|2026-08-12|-|0.95|Send Pranjali the Goa villa link";

describe("totality — the parser never throws (§5.8.5)", () => {
  it("survives 5,000 random token soups", () => {
    const rnd = mulberry32(0xc0ffee);
    for (let i = 0; i < 5000; i += 1) {
      const soup = randomSoup(rnd);
      expect(() => parseWire(soup)).not.toThrow();
    }
  });

  it("survives 2,000 random byte strings", () => {
    const rnd = mulberry32(0xbadf00d);
    for (let i = 0; i < 2000; i += 1) {
      const bytes = randomBytes(rnd);
      expect(() => parseWire(bytes)).not.toThrow();
    }
  });

  it('survives "", "|", "||||||", null and undefined', () => {
    for (const input of ["", "|", "||||||", null, undefined, 0, 42, [], {}, NaN, true]) {
      expect(() => parseWire(input)).not.toThrow();
      const r = parseWire(input);
      expect(accountingHolds(r)).toBe(true);
    }
  });

  it("survives every truncation prefix of a full T| line — violation, never a throw", () => {
    for (let i = 0; i <= FULL_T_LINE.length; i += 1) {
      const prefix = FULL_T_LINE.slice(0, i);
      expect(() => parseWire(prefix)).not.toThrow();
      const r = parseWire(prefix);
      expect(accountingHolds(r)).toBe(true);
      // Either it parsed or it was rejected — but it was never silently lost.
      expect(r.counts.accepted + r.violations.length).toBeGreaterThan(0);
    }
  });

  it("survives pathological repetition", () => {
    for (const input of ["|".repeat(5000), "T|".repeat(2000), "\n".repeat(1000), "*".repeat(4000), "T|1-zzzzzz|a1"]) {
      expect(() => parseWire(input)).not.toThrow();
      expect(accountingHolds(parseWire(input))).toBe(true);
    }
  });
});

describe("accounting invariant (§5.8.4)", () => {
  it("accepted + violations + skipped == non-blank lines over 2,000 random inputs", () => {
    const rnd = mulberry32(0x5eed);
    for (let i = 0; i < 2000; i += 1) {
      const text = i % 3 === 0 ? randomBytes(rnd) : randomSoup(rnd);
      const r = parseWire(text);
      const c = r.counts;
      expect(c.accepted + c.violations + c.skipped).toBe(c.nonBlankLines);
      expect(c.accepted).toBe(r.records.length);
      expect(c.violations).toBe(lineViolations(r).length);
      expect(c.skipped).toBe(r.skipped.length);
      expect(c.blank + c.nonBlankLines).toBe(c.lines);
    }
  });

  it("holds on a mixed batch of good, bad and decorative lines", () => {
    const text = [
      "Here is what I found:",
      "",
      "```",
      "# Claims",
      "H|1|a1|1p|0.95|-|Attends bhangra classes on Saturdays",
      "K|1|unknown tag",
      "- a bulleted note",
      "T|2|self|a1|ex|i2t|l|d|2026-08-12|-|0.95|Send the villa link",
      "H|1|a1|second_person|0.9|-|wrong enum",
      "```",
    ].join("\n");
    const r = parseWire(text);
    expect(r.counts.accepted).toBe(2);
    expect(r.counts.violations).toBe(2);
    expect(r.counts.skipped).toBe(5);
    expect(r.counts.nonBlankLines).toBe(9);
    expect(accountingHolds(r)).toBe(true);
  });

  it("nothing is silently dropped — every skipped line keeps its bytes", () => {
    const text = "# heading\n- bullet note\njust prose";
    const r = parseWire(text);
    expect(r.skipped.map((s) => s.raw)).toEqual(["# heading", "- bullet note", "just prose"]);
    expect(r.skipped.map((s) => s.line)).toEqual([1, 2, 3]);
  });
});

describe("violations quote the model (§5.8.1)", () => {
  it("carries a 1-based line number and the ORIGINAL raw text", () => {
    const text = ["Y|e1|fine", "", "**H|1|a1|nonsense_word|0.9|-|text**"].join("\n");
    const r = parseWire(text);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].line).toBe(3);
    expect(r.violations[0].raw).toBe("**H|1|a1|nonsense_word|0.9|-|text**");
    expect(r.violations[0].rule).toBe("bad_enum");
    expect(r.violations[0].scope).toBe("line");
  });

  it("a broken tag on a line containing | is a violation, not a repair", () => {
    const r = parseWire("KK|1|a1|1p|0.9|-|text");
    expect(lineViolations(r)[0].rule).toBe("unknown_tag");
  });
});

describe("emphasis (§5.7.1 — the 212-violation lesson)", () => {
  it("**T|1|…** parses AND increments the strip counter", () => {
    const r = parseWire("**T|1|self|a1|ex|i2t|l|d|2026-08-12|-|0.95|Send the villa link**");
    expect(r.counts.accepted).toBe(1);
    expect(r.counts.violations).toBe(0);
    expect(r.counts.emphasisStripped).toBe(1);
    expect(r.records[0].tag).toBe("T");
    expect(r.records[0].values.intent).toBe("Send the villa link");
    expect(r.records[0].raw).toBe("**T|1|self|a1|ex|i2t|l|d|2026-08-12|-|0.95|Send the villa link**");
  });

  it("an unclosed opener parses too", () => {
    const r = parseWire("**Y|e1|the summary");
    expect(r.counts.accepted).toBe(1);
    expect(r.counts.emphasisStripped).toBe(1);
  });

  it("212 emphasised lines produce 212 records and zero violations", () => {
    const text = Array.from({ length: 212 }, (_, i) => `**Y|e${i + 1}|summary ${i + 1}**`).join("\n");
    const r = parseWire(text);
    expect(r.counts.accepted).toBe(212);
    expect(r.counts.violations).toBe(0);
    expect(r.counts.emphasisStripped).toBe(212);
  });
});

describe("no_wire_lines (§5.8.3)", () => {
  it("emits EXACTLY ONE violation when the whole answer was prose", () => {
    const text = [
      "I looked at the conversation.",
      "There are three things worth extracting here.",
      "",
      "But I could not put them in the format you asked for.",
    ].join("\n");
    const r = parseWire(text);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].rule).toBe("no_wire_lines");
    expect(r.violations[0].scope).toBe("response");
    expect(r.violations[0].line).toBe(1);
    expect(r.violations[0].raw).toBe(text);
    expect(r.counts.responseViolations).toBe(1);
    expect(accountingHolds(r)).toBe(true);
  });

  it("is one for the answer, not one per line, however long the prose", () => {
    const r = parseWire(Array.from({ length: 300 }, (_, i) => `sentence number ${i}`).join("\n"));
    expect(r.violations).toHaveLength(1);
  });

  it("does not fire when any line was judged", () => {
    expect(parseWire("Y|e1|ok\nprose").violations).toHaveLength(0);
    expect(parseWire("K|1|bad\nprose").violations.map((v) => v.rule)).toEqual(["unknown_tag"]);
  });

  it("builds the same violation standalone", () => {
    expect(noWireLinesViolation("hello")).toMatchObject({ line: 1, rule: "no_wire_lines", raw: "hello" });
  });
});

describe("bounded repair (§5.8.2)", () => {
  const first = parseWire(
    [
      "H|1|a1|1p|0.95|-|Attends bhangra classes on Saturdays",
      "H|2|a1|second_person|0.9|-|wrong enum",
      "Y|e1|episode summary",
      "T|3|self|a1|ex|i2t|l|d|not a date|-|0.9|broken due",
      "C|img1|a menu",
    ].join("\n"),
  );

  it("re-asks only the failing lines, quoting them", () => {
    expect(first.counts.accepted).toBe(3);
    expect(first.counts.violations).toBe(2);
    const prompt = repairRequest(first.violations);
    expect(prompt).toContain("line 2 — bad_enum");
    expect(prompt).toContain("line 4 — bad_date");
    expect(prompt).not.toContain("Attends bhangra");
    expect(prompt).not.toContain("episode summary");
  });

  it("keeps round-1 accepted lines and merges round 2", () => {
    const second = parseWire(
      [
        "H|2|a1|ao|0.9|-|wrong enum",
        "T|3|self|a1|ex|i2t|l|d|2026-08-12|-|0.9|broken due",
      ].join("\n"),
    );
    const merged = mergeRepair(first, second);
    expect(merged.records).toHaveLength(5);
    expect(merged.violations).toHaveLength(0);
    expect(merged.rounds).toBe(2);
  });

  it("a second failure leaves the violations in the result — there is no third round", () => {
    const second = parseWire("H|2|a1|still_wrong|0.9|-|wrong enum");
    const merged = mergeRepair(first, second);
    expect(merged.records).toHaveLength(3);
    expect(merged.violations.map((v) => v.rule)).toEqual(["bad_enum", "bad_date", "bad_enum"]);
    expect(merged.rounds).toBe(2);
  });
});

describe("round trip helper", () => {
  it("normalises then holds", () => {
    const text = "H|1|a1|1p||-|Attends bhangra classes\nprose line\nY|e1|a | b";
    const once = roundTrip(text);
    expect(once).toBe("H|1|a1|1p|0.9|-|Attends bhangra classes\nY|e1|a | b");
    expect(roundTrip(once)).toBe(once);
    expect(serialize(parseWire(once).records)).toBe(once);
  });
});
