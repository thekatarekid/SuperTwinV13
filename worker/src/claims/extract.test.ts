// Evals M — CLAIMS (95), read side.
//
// The prompt half of the category is asserted in prompts/p-cl1.test.ts; this
// file asserts what CODE does with the answer: the tag is the kind, the enums
// decode, an off-roster subject becomes a hint and never an id, an empty
// confidence is 0.9, and an evidence-free claim is rejected without being
// deleted. Evals N and the accounting invariant are in extract-loops.test.ts.

import { describe, expect, it } from "vitest";

import { packPrompt, type PackEvent, type PackInput } from "../wire/pack.js";
import type { AliasTable } from "../wire/aliases.js";
import {
  CLAIM_KIND_BY_TAG,
  CLAIM_TAGS,
  claimKindForTag,
  extractionAccounts,
  isClaimTag,
  parseCl1Response,
  resolveTarget,
  strayPronouns,
  targetEntityId,
  targetHint,
} from "./extract.js";

// ---- fixtures --------------------------------------------------------------

const ROSTER = [
  { id: "ent_pranjali", name: "Pranjali Sachdeva" },
  { id: "ent_rahul", name: "Rahul Arora" },
  { id: "ent_act", name: "ACT broadband", type: "thing" },
];

function fixture(events: PackEvent[] = [], date = "2026-08-12"): AliasTable {
  const input: PackInput = {
    tz: "Asia/Kolkata",
    entities: ROSTER,
    streams: [
      { id: "str_pranjali", name: "Pranjali", kind: "dm", participantIds: ["self", "ent_pranjali"] },
    ],
    events:
      events.length > 0
        ? events
        : [
            { id: "ev1", streamId: "str_pranjali", at: `${date}T15:40:00Z`, speakerId: "ent_pranjali", text: "hi" },
            { id: "ev2", streamId: "str_pranjali", at: `${date}T15:42:00Z`, speakerId: "self", text: "hello" },
            { id: "ev3", streamId: "str_pranjali", at: `${date}T15:46:00Z`, speakerId: "ent_pranjali", text: "renewal" },
            { id: "ev4", streamId: "str_pranjali", at: `${date}T15:47:00Z`, speakerId: "self", text: "ok" },
          ],
  };
  const packed = packPrompt(input);
  if (!packed.ok) throw new Error("fixture roster over cap");
  return packed.table;
}

// ---- M: the tag is the kind (M-001..020) -----------------------------------

describe("M — the claim kind is the tag", () => {
  it("maps all eight tags and nothing else", () => {
    expect(CLAIM_TAGS).toEqual(["F", "P", "B", "O", "I", "R", "H", "W"]);
    expect(Object.values(CLAIM_KIND_BY_TAG)).toEqual([
      "fact",
      "preference",
      "belief",
      "opinion",
      "interest",
      "recommendation",
      "habit",
      "workflow",
    ]);
    expect(claimKindForTag("T")).toBeNull();
    expect(claimKindForTag("kind")).toBeNull();
    expect(isClaimTag("Z")).toBe(false);
  });

  it.each([
    ["H", "habit", "Attends bhangra classes on Saturdays"],
    ["P", "preference", "Prefers bhangra classes over the gym"],
    ["O", "opinion", "Considers ACT broadband overpriced"],
    ["B", "belief", "Believes therapy helps"],
    ["R", "recommendation", "Recommends Kalpaney"],
    ["I", "interest", "Interested in local LLM setups"],
    ["F", "fact", "Lease ends in November 2027"],
    ["W", "workflow", "Drafts before sending"],
  ])("M-001..020 %s parses as %s", (tag, kind, text) => {
    const table = fixture();
    const answer = parseCl1Response(`${tag}|1|self|1p||-|${text}`, table);
    expect(answer.claims).toHaveLength(1);
    expect(answer.claims[0].kind).toBe(kind);
    expect(answer.claims[0].tag).toBe(tag);
    expect(answer.claims[0].text).toBe(text);
    expect(answer.claims[0].subjectId).toBe("self");
    expect(extractionAccounts(answer)).toBe(true);
  });

  it("does not carry a kind field anywhere on the wire", () => {
    const table = fixture();
    const answer = parseCl1Response("H|1|self|1p||-|Attends bhangra classes on Saturdays", table);
    expect(Object.keys(answer.claims[0])).not.toContain("kindField");
    // The record's own decoded fields carry no `kind` — the tag was the kind.
    expect(Object.keys(answer.parse.records[0].values)).not.toContain("kind");
  });
});

// ---- M: attribution (M-021..048) -------------------------------------------

describe("M — attribution", () => {
  it.each([
    ["1p", "first_person"],
    ["ao", "about_other"],
    ["rs", "reported_speech"],
    ["q3", "quoted_third_party"],
  ])("M-021..048 %s decodes to %s", (code, stored) => {
    const table = fixture();
    const answer = parseCl1Response(`H|1|a1|${code}|0.8|-|Attends bhangra classes on Saturdays`, table);
    expect(answer.claims[0].attribution).toBe(stored);
    expect(answer.claims[0].subjectId).toBe("ent_pranjali");
  });

  it("accepts the stored long form and drifted spelling (§5.4)", () => {
    const table = fixture();
    for (const spelling of ["first_person", "FIRST PERSON", "firstperson", "self"]) {
      const answer = parseCl1Response(`P|1|a1|${spelling}||-|Prefers X`, table);
      expect(answer.claims[0].attribution).toBe("first_person");
    }
  });

  it("a genuinely wrong word is a violation, never a silent default", () => {
    const table = fixture();
    const answer = parseCl1Response("P|1|a1|thirdperson||-|Prefers X", table);
    expect(answer.claims).toHaveLength(0);
    expect(answer.violations[0].rule).toBe("bad_enum");
    // The rejected line is quoted verbatim so repair re-asks exactly it.
    expect(answer.violations[0].raw).toBe("P|1|a1|thirdperson||-|Prefers X");
  });
});

// ---- M: resolved third person (M-049..061) ---------------------------------

describe("M — resolved third person", () => {
  it("M-049..055 flags a stray first person, and never rewrites it", () => {
    const table = fixture();
    const answer = parseCl1Response("P|1|self|1p||-|I love chole bhature", table);
    expect(answer.claims[0].stray).toEqual(["i"]);
    expect(answer.claims[0].text).toBe("I love chole bhature");
  });

  it("M-049..055 a resolved claim carries no stray pronoun", () => {
    const table = fixture();
    const answer = parseCl1Response("P|1|self|1p||-|Loves chole bhature", table);
    expect(answer.claims[0].stray).toEqual([]);
  });

  it.each(["she", "he", "they", "there", "here", "my", "we", "your"])(
    "M-056..061 flags the stray pronoun %s",
    (word) => {
      expect(strayPronouns(`Something about ${word} today`)).toContain(word);
    },
  );

  it("does not flag a named subject or a possessive on a name", () => {
    expect(strayPronouns("Pranjali's broadband renews on the 28th")).toEqual([]);
    expect(strayPronouns("Considers ACT broadband overpriced")).toEqual([]);
  });

  it("handles curly apostrophes the way a model types them", () => {
    expect(strayPronouns("I’ve started bhangra")).toEqual(["i've"]);
  });
});

// ---- M: logistics chatter (M-062..069) -------------------------------------

describe("M — logistics chatter", () => {
  it("M-062..069 an answer that emits nothing for 'ok' parses to zero claims", () => {
    const table = fixture();
    // Only the Y line: the model read four events and judged event 4 empty.
    const answer = parseCl1Response("Y|e1|Nothing of substance was said.", table);
    expect(answer.claims).toHaveLength(0);
    expect(answer.loops).toHaveLength(0);
    expect(answer.summaries).toHaveLength(1);
    expect(extractionAccounts(answer)).toBe(true);
  });

  it("never invents a claim to fill an empty answer", () => {
    const table = fixture();
    const answer = parseCl1Response("", table);
    expect(answer.claims).toHaveLength(0);
    // One response-scoped verdict for the whole answer, not one per line.
    expect(answer.violations).toHaveLength(1);
    expect(answer.violations[0].rule).toBe("no_wire_lines");
  });
});

// ---- M: unknown beats wrong (M-070..075) -----------------------------------

describe("M — unknown beats wrong", () => {
  it("M-070..075 an off-roster named subject becomes a hint, never an id", () => {
    const table = fixture();
    const answer = parseCl1Response("F|1|+Rohan Mehta|ao||-|Rohan Mehta moved to Pune", table);
    expect(answer.claims[0].subjectId).toBeNull();
    expect(answer.claims[0].subjectHint).toBe("Rohan Mehta");
  });

  it("M-070..075 a description is just as good a hint", () => {
    const table = fixture();
    const answer = parseCl1Response("F|1|+Pranjali's landlord|ao||-|The landlord raised the rent", table);
    expect(answer.claims[0].subjectId).toBeNull();
    expect(answer.claims[0].subjectHint).toBe("Pranjali's landlord");
  });

  it("a bare '-' subject is an answer, not a failure", () => {
    const table = fixture();
    const answer = parseCl1Response("F|1|-|ao||-|Someone moved to Pune", table);
    expect(answer.claims[0].subject.kind).toBe("absent");
    expect(answer.claims[0].subjectId).toBeNull();
    expect(answer.claims[0].subjectHint).toBeNull();
  });

  it("an alias outside the roster resolves to null by range check, never to a name", () => {
    const table = fixture();
    const answer = parseCl1Response("F|1|a9|ao||-|Someone moved to Pune", table);
    expect(answer.claims[0].subject.kind).toBe("unresolved");
    expect(answer.claims[0].subjectId).toBeNull();
    expect(answer.claims[0].subjectHint).toBeNull();
  });

  it("resolveTarget covers every branch", () => {
    const table = fixture();
    expect(resolveTarget("self", table).kind).toBe("self");
    expect(targetEntityId(resolveTarget("a2", table))).toBe("ent_rahul");
    expect(targetHint(resolveTarget("+X", table))).toBe("X");
    expect(resolveTarget("", table).kind).toBe("absent");
    expect(resolveTarget("zzz", table).kind).toBe("unresolved");
  });
});

// ---- M: valid_from (M-076..081) --------------------------------------------

describe("M — bitemporal valid_from", () => {
  it("M-076..081 a stated boundary lands in valid_from", () => {
    const table = fixture();
    const answer = parseCl1Response("P|1|self|1p||2026-09-01|Is vegetarian", table);
    expect(answer.claims[0].validFrom).toBe("2026-09-01");
  });

  it("no stated boundary means null — never today, never a default", () => {
    const table = fixture();
    for (const field of ["-", "", "—"]) {
      const answer = parseCl1Response(`P|1|self|1p||${field}|Is vegetarian`, table);
      expect(answer.claims[0].validFrom).toBeNull();
    }
  });

  it("a wrapped {valid_from:…} unwraps; a mismatched key is a violation (§5.7.3)", () => {
    const table = fixture();
    const ok = parseCl1Response("P|1|self|1p||{valid_from:2026-09-01}|Is vegetarian", table);
    expect(ok.claims[0].validFrom).toBe("2026-09-01");
    const bad = parseCl1Response("P|1|self|1p||{conf:0.8}|Is vegetarian", table);
    expect(bad.claims).toHaveLength(0);
    expect(bad.violations[0].rule).toBe("token_key_mismatch");
  });

  it("valid_to is never written here — closing a window belongs to the write path", () => {
    const table = fixture();
    const answer = parseCl1Response("P|1|self|1p||2026-09-01|Is vegetarian", table);
    expect(Object.keys(answer.claims[0])).not.toContain("validTo");
  });
});

// ---- M: confidence (M-082..087) --------------------------------------------

describe("M — confidence", () => {
  it("M-082..087 an empty confidence field is 0.9", () => {
    const table = fixture();
    const answer = parseCl1Response("P|1|a1|1p||-|Prefers bhangra classes over the gym", table);
    expect(answer.claims[0].confidence).toBe(0.9);
  });

  it("a stated confidence is kept exactly", () => {
    const table = fixture();
    const answer = parseCl1Response("H|1|a1|1p|0.95|-|Attends bhangra classes on Saturdays", table);
    expect(answer.claims[0].confidence).toBe(0.95);
  });

  it("a confidence outside [0,1] is a violation, not a clamp", () => {
    const table = fixture();
    const answer = parseCl1Response("H|1|a1|1p|1.4|-|Attends bhangra", table);
    expect(answer.claims).toHaveLength(0);
    expect(answer.violations[0].rule).toBe("bad_confidence");
  });
});

// ---- M: evidence is mandatory (M-088..091) ---------------------------------

describe("M — evidence is mandatory", () => {
  it("M-088..091 a claim citing no event is rejected for the write path", () => {
    const table = fixture();
    const answer = parseCl1Response("P|-|a1|1p||-|Prefers bhangra classes over the gym", table);
    expect(answer.claims).toHaveLength(0);
    expect(answer.unsupported).toHaveLength(1);
    expect(answer.unsupported[0].reason).toBe("no_evidence");
  });

  it("M-088..091 the rejected line is KEPT verbatim — discarded output is zero", () => {
    const table = fixture();
    const raw = "P|-|a1|1p||-|Prefers bhangra classes over the gym";
    const answer = parseCl1Response(raw, table);
    expect(answer.unsupported[0].raw).toBe(raw);
    expect(extractionAccounts(answer)).toBe(true);
  });

  it("an event alias outside the prompt is unplaceable, not evidence", () => {
    const table = fixture();
    const answer = parseCl1Response("P|zz|a1|1p||-|Prefers bhangra", table);
    expect(answer.claims).toHaveLength(0);
    expect(answer.unsupported[0].unresolvedEvents).toEqual(["zz"]);
  });

  it("a loop citing no event is rejected the same way", () => {
    const table = fixture();
    const answer = parseCl1Response("T|-|self|a1|ex|i2t|l|d|2026-08-12|-|0.95|Send the villa link", table);
    expect(answer.loops).toHaveLength(0);
    expect(answer.unsupported[0].tag).toBe("T");
  });

  it("partial evidence still counts: one placeable event is enough", () => {
    const table = fixture();
    const answer = parseCl1Response("P|1,zz|a1|1p||-|Prefers bhangra", table);
    expect(answer.claims).toHaveLength(1);
    expect(answer.claims[0].eventIds).toEqual(["ev1"]);
    expect(answer.claims[0].unresolvedEvents).toEqual(["zz"]);
  });
});

// ---- M: no age filtering (M-092..095) --------------------------------------

describe("M — claims are never age-filtered", () => {
  it.each(["2024-02-11", "2019-06-03", "2026-08-12"])(
    "M-092..095 an episode dated %s parses identically",
    (date) => {
      const table = fixture(
        [
          { id: "ev1", streamId: "str_pranjali", at: `${date}T09:00:00Z`, speakerId: "self", text: "my lease ends in Nov 2027" },
        ],
        date,
      );
      const answer = parseCl1Response("F|1|self|1p||-|Lease ends in November 2027", table);
      expect(answer.claims).toHaveLength(1);
      expect(answer.claims[0].eventIds).toEqual(["ev1"]);
    },
  );

  it("nothing in a parsed claim mentions ingested_at or an arrival order", () => {
    const table = fixture();
    const answer = parseCl1Response("F|1|self|1p||-|Lease ends in November 2027", table);
    const keys = Object.keys(answer.claims[0]);
    expect(keys).not.toContain("ingestedAt");
    expect(keys).not.toContain("statedAt");
  });
});

