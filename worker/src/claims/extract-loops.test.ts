// Evals N — LOOPS (75), read side, plus the Y / Q / Z lines, the
// zero-discard accounting invariant, and "parallel by episode, apply
// serialized". The claim half of the read side is in extract.test.ts.

import { describe, expect, it } from "vitest";

import { packPrompt, type PackEvent, type PackInput } from "../wire/pack.js";
import type { AliasTable } from "../wire/aliases.js";
import {
  extractInParallel,
  extractionAccounts,
  extractionCounts,
  mergeCl1Answers,
  parseCl1DeltaResponse,
  parseCl1Response,
  serializedResults,
} from "./extract.js";

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

// ---- N: loops --------------------------------------------------------------

describe("N — loops", () => {
  it("N-001..006 an explicit commitment parses in full", () => {
    const table = fixture();
    const answer = parseCl1Response(
      "T|2|self|a1|ex|i2t|l|d|2026-08-12|-|0.95|Send Pranjali the Goa villa link",
      table,
    );
    const loop = answer.loops[0];
    expect(loop.ownerId).toBe("self");
    expect(loop.counterpartyId).toBe("ent_pranjali");
    expect(loop.origin).toBe("explicit");
    expect(loop.direction).toBe("i_owe_them");
    expect(loop.stake).toBe("low");
    expect(loop.horizon).toBe("today");
    expect(loop.due).toBe("2026-08-12");
    expect(loop.recurrence).toBeNull();
    expect(loop.intent).toBe("Send Pranjali the Goa villa link");
  });

  it("N-007..014 a temporal-boundary loop keeps its due AND its recurrence", () => {
    const table = fixture();
    const answer = parseCl1Response(
      "T|3|a1|-|ex|slf|m|mo|2026-08-28|monthly||Pranjali's broadband renews",
      table,
    );
    const loop = answer.loops[0];
    expect(loop.due).toBe("2026-08-28");
    expect(loop.recurrence).toBe("monthly");
    expect(loop.confidence).toBe(0.9);
    expect(loop.direction).toBe("self");
    // owner is NOT the user — item 3.2 turns this into person context.
    expect(loop.ownerId).toBe("ent_pranjali");
    expect(loop.counterpartyId).toBeNull();
  });

  it("N-015..018 an R line is a claim, never a loop", () => {
    const table = fixture();
    const answer = parseCl1Response("R|1|a1|1p||-|Recommends trying Kalpaney", table);
    expect(answer.loops).toHaveLength(0);
    expect(answer.claims[0].kind).toBe("recommendation");
  });

  it.each(["H", "F", "P", "I"])("N-019..034 a %s line never becomes a loop", (tag) => {
    const table = fixture();
    const answer = parseCl1Response(`${tag}|1|self|1p||-|Does groceries every Sunday`, table);
    expect(answer.loops).toHaveLength(0);
    expect(answer.claims).toHaveLength(1);
  });

  it.each(["-", "", "–", "{due}"])("N-035..040 a vague due (%s) stays null", (due) => {
    const table = fixture();
    const answer = parseCl1Response(
      `T|2|self|a1|ex|i2t|m|w|${due}|-|0.8|Get dinner with Pranjali`,
      table,
    );
    expect(answer.loops[0].due).toBeNull();
  });

  it("N-035..040 a non-date in the due field is a violation, never an invented date", () => {
    const table = fixture();
    const answer = parseCl1Response("T|2|self|a1|ex|i2t|m|w|next week|-|0.8|Dinner", table);
    expect(answer.loops).toHaveLength(0);
    expect(answer.violations[0].rule).toBe("bad_date");
  });

  it.each([
    ["2026-08-12", "2026-08-28"],
    ["2026-01-30", "2026-02-28"],
    ["2025-11-02", "2025-11-28"],
    ["2026-03-15", "2026-03-28"],
    ["2026-06-01", "2026-06-28"],
    ["2026-09-20", "2026-09-28"],
  ])("N-041..046 'the 28th' in an episode dated %s stores %s as written", (episodeDate, due) => {
    const table = fixture(
      [{ id: "ev1", streamId: "str_pranjali", at: `${episodeDate}T09:00:00Z`, speakerId: "ent_pranjali", text: "renews on the 28th" }],
      episodeDate,
    );
    const answer = parseCl1Response(`T|1|a1|-|ex|slf|m|mo|${due}|monthly||Broadband renews`, table);
    // Code never re-anchors a date: the model resolved it against the episode's
    // own #D block, and what it wrote is what is stored.
    expect(answer.loops[0].due).toBe(due);
  });

  it("N-047..075 the parser writes no state, no triage and no party_pair", () => {
    const table = fixture();
    const answer = parseCl1Response(
      "T|2|self|a1|ex|i2t|l|d|2020-01-01|-|0.95|Send the villa link",
      table,
    );
    const keys = Object.keys(answer.loops[0]);
    expect(keys).not.toContain("state");
    expect(keys).not.toContain("triage");
    expect(keys).not.toContain("partyPair");
    // A past due is carried through untouched — deriving `lapsed` is item 3.2.
    expect(answer.loops[0].due).toBe("2020-01-01");
  });

  it("N-067..071 origin im survives verbatim", () => {
    const table = fixture();
    const answer = parseCl1Response("T|3|self|-|im|slf|m|mo|-|-|0.6|Move off ACT broadband", table);
    expect(answer.loops[0].origin).toBe("implicit");
  });

  it("an intent may contain a pipe — prose is the last field and is re-joined", () => {
    const table = fixture();
    const answer = parseCl1Response("T|2|self|a1|ex|i2t|l|d|-|-||Send the link | then confirm", table);
    expect(answer.loops[0].intent).toBe("Send the link | then confirm");
  });
});

// ---- Y, Q, Z ---------------------------------------------------------------

describe("summaries, questions and delta updates", () => {
  it("the Y line resolves its episode alias", () => {
    const packed = packPrompt({
      tz: "Asia/Kolkata",
      entities: ROSTER,
      streams: [{ id: "str_pranjali", name: "Pranjali", kind: "dm", participantIds: ["self", "ent_pranjali"] }],
      episodes: [{ id: "epi_1", label: "Goa villa", state: "op", streamId: "str_pranjali" }],
      events: [{ id: "ev1", streamId: "str_pranjali", at: "2026-08-12T15:40:00Z", speakerId: "self", text: "hi" }],
    });
    if (!packed.ok) throw new Error("packer refused");
    const answer = parseCl1Response("Y|e1|Pranjali started bhangra. She finds ACT overpriced.", packed.table);
    expect(answer.summaries[0].episodeId).toBe("epi_1");
    expect(answer.summaries[0].summary).toBe("Pranjali started bhangra. She finds ACT overpriced.");
  });

  it("an unknown episode alias is reported, never reassigned", () => {
    const table = fixture();
    const answer = parseCl1Response("Y|e4|Something happened.", table);
    expect(answer.summaries[0].episodeId).toBeNull();
    expect(answer.summaries[0].episodeAlias).toBe("e4");
  });

  it("a Q line lands in questions", () => {
    const table = fixture();
    const answer = parseCl1Response("Q|a1|Which Rohan is this?", table);
    expect(answer.questions[0].question).toBe("Which Rohan is this?");
  });

  it("a Z line in a pass-1 answer is counted, not applied", () => {
    const table = fixture();
    const answer = parseCl1Response("Z|H1|ctr|1|batch moved to Sunday", table);
    expect(answer.updates).toHaveLength(0);
    expect(answer.otherRecords).toHaveLength(1);
    expect(extractionAccounts(answer)).toBe(true);
  });

  it("a Z line in a delta answer resolves its ref and its change code", () => {
    const table = fixture();
    const answer = parseCl1DeltaResponse("Z|H1|ctr|1|batch moved from Saturday to Sunday", table, {
      H1: "clm_1",
    });
    expect(answer.updates[0].change).toBe("contradicted");
    expect(answer.updates[0].refId).toBe("clm_1");
    expect(answer.updates[0].eventIds).toEqual(["ev1"]);
  });

  it.each([
    ["ctr", "contradicted"],
    ["dat", "dated"],
    ["cmp", "completed"],
    ["cnl", "cancelled"],
    ["rfn", "refined"],
  ])("the Z change code %s decodes to %s", (code, stored) => {
    const table = fixture();
    const answer = parseCl1DeltaResponse(`Z|T1|${code}|1|note`, table, {});
    expect(answer.updates[0].change).toBe(stored);
    expect(answer.updates[0].refId).toBeNull();
  });
});

// ---- accounting and totality ------------------------------------------------

describe("zero model output discarded", () => {
  it("every record lands in exactly one bucket", () => {
    const table = fixture();
    const answer = parseCl1DeltaResponse(
      [
        "Y|e1|A summary.",
        "H|1|a1|1p|0.95|-|Attends bhangra classes on Saturdays",
        "T|2|self|a1|ex|i2t|l|d|2026-08-12|-|0.95|Send the villa link",
        "Q|a1|Which Rohan?",
        "Z|H1|ctr|1|moved to Sunday",
        "P|-|a1|1p||-|Prefers bhangra",
        "V|e1|jn|-|0.8|stray tag from another pass",
      ].join("\n"),
      table,
    );
    const counts = extractionCounts(answer);
    expect(counts).toMatchObject({
      claims: 1,
      loops: 1,
      summaries: 1,
      updates: 1,
      questions: 1,
      unsupported: 1,
      other: 1,
    });
    expect(extractionAccounts(answer)).toBe(true);
  });

  it("markdown wrappers do not cost a single claim (§5.7.1)", () => {
    const table = fixture();
    const answer = parseCl1Response(
      ["```", "**H|1|a1|1p|0.95|-|Attends bhangra classes on Saturdays**", "```"].join("\n"),
      table,
    );
    expect(answer.claims).toHaveLength(1);
    expect(answer.claims[0].raw).toContain("**");
  });

  it("never throws, on anything at all", () => {
    const table = fixture();
    for (const input of [null, undefined, 42, "||||||", " ", "H|", "not a wire line"]) {
      expect(() => parseCl1Response(input, table)).not.toThrow();
    }
  });

  it("prose lines are skipped and kept, never repaired", () => {
    const table = fixture();
    const answer = parseCl1Response(
      ["Here are the claims:", "H|1|a1|1p|0.95|-|Attends bhangra classes on Saturdays"].join("\n"),
      table,
    );
    expect(answer.claims).toHaveLength(1);
    expect(answer.skipped[0].raw).toBe("Here are the claims:");
  });

  it("merges a batch without deduping anything", () => {
    const table = fixture();
    const a = parseCl1Response("H|1|a1|1p||-|Attends bhangra", table);
    const b = parseCl1Response("H|1|a1|1p||-|Attends bhangra", table);
    expect(mergeCl1Answers([a, b]).claims).toHaveLength(2);
  });
});

// ---- parallel by episode, apply serialized ---------------------------------

describe("parallel by episode, apply serialized", () => {
  it("returns results in INPUT order however they finish", async () => {
    const delays = [40, 5, 25, 1];
    const slots = await extractInParallel(
      delays,
      async (ms, i) => {
        await new Promise((r) => setTimeout(r, ms));
        return i;
      },
      4,
    );
    expect(serializedResults(slots)).toEqual([0, 1, 2, 3]);
  });

  it("honours the concurrency width", async () => {
    let live = 0;
    let peak = 0;
    await extractInParallel(
      [1, 2, 3, 4, 5, 6],
      async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live -= 1;
      },
      2,
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("one bad episode never takes the batch down", async () => {
    const slots = await extractInParallel([1, 2, 3], async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(slots[1].ok).toBe(false);
    expect(slots[1].error?.message).toBe("boom");
    expect(serializedResults(slots)).toEqual([1, 3]);
  });

  it("an empty batch is not an error", async () => {
    expect(await extractInParallel([], async (x) => x)).toEqual([]);
  });
});
