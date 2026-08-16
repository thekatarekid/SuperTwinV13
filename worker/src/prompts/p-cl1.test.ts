// Evals M — CLAIMS (95) and N — LOOPS (75), prompt side.
//
// A prompt is code: the rules that decide whether a sentence becomes a claim,
// a loop, or nothing at all live in this string, and they are asserted here as
// literally as the parser's behaviour is asserted next door. The §12.4 worked
// example is replayed end to end at the bottom — the same episode, the same
// expected lines, read back through the real alias table.

import { beforeEach, describe, expect, it } from "vitest";

import { packPrompt, type PackInput } from "../wire/pack.js";
import { parseCl1Response, extractionAccounts } from "../claims/extract.js";
import { resetLegendCache } from "./legend.js";
import {
  buildCl1Prompt,
  buildCl1System,
  cl1Batches,
  cl1Legend,
  cl1SendOptions,
  P_CL1,
  P_CL1_SYSTEM,
  P_CL1_TAGS,
} from "./p-cl1.js";

beforeEach(() => {
  resetLegendCache();
});

// §12.4's worked example, transcribed.
const EXAMPLE: PackInput = {
  tz: "Asia/Kolkata",
  entities: [
    { id: "ent_pranjali", name: "Pranjali Sachdeva" },
    { id: "ent_rahul", name: "Rahul Arora" },
    { id: "ent_act", name: "ACT broadband", type: "thing" },
    { id: "ent_goa", name: "Goa trip", type: "occasion" },
    { id: "ent_indiranagar", name: "Indiranagar", type: "place" },
  ],
  streams: [
    { id: "str_pranjali", name: "Pranjali", kind: "dm", participantIds: ["self", "ent_pranjali"] },
  ],
  loops: [
    { id: "loop_1", intent: "Confirm villa to Rohan", ownerId: "self", due: "2026-08-20", state: "op", streamId: "str_pranjali" },
  ],
  events: [
    { id: "ev1", streamId: "str_pranjali", at: "2026-08-12T15:40:00Z", speakerId: "ent_pranjali", text: "i've started bhangra classes on saturdays, it's so much better than the gym" },
    { id: "ev2", streamId: "str_pranjali", at: "2026-08-12T15:42:00Z", speakerId: "self", text: "nice. i'll send you that villa link for Goa tonight, remind me if i forget" },
    { id: "ev3", streamId: "str_pranjali", at: "2026-08-12T15:46:00Z", speakerId: "ent_pranjali", text: "also my broadband renews on the 28th, ACT is way overpriced" },
    { id: "ev4", streamId: "str_pranjali", at: "2026-08-12T15:47:00Z", speakerId: "self", text: "ok" },
  ],
};

// ---- settings (§12.4) ------------------------------------------------------

describe("P-CL1 settings", () => {
  it("transcribes §12.4 exactly", () => {
    expect(P_CL1.model).toBe("sonnet-5");
    expect(P_CL1.turns).toBe(1);
    expect(P_CL1.tools).toBe("none");
    expect(P_CL1.thinking).toBe("off");
    expect(P_CL1.timeoutSeconds).toBe(180);
    expect(P_CL1.maxEpisodesPerCall).toBe(4);
    expect(P_CL1.maxInputTokens).toBe(10_000);
    expect(P_CL1.maxOutputTokens).toBe(6_000);
    expect(P_CL1.role).toBe("extract");
  });

  it("fixes the provider knobs so no call site can raise them", () => {
    expect(cl1SendOptions()).toEqual({
      model: "sonnet-5",
      maxTurns: 1,
      timeoutMs: 180_000,
      maxOutputTokens: 6_000,
      thinkingBudget: "off",
      plainCompletion: true,
    });
  });

  it("never sends more than four episodes in one call", () => {
    expect(cl1Batches([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
    expect(cl1Batches([])).toEqual([]);
    expect(cl1Batches([1, 2, 3], 0).every((b) => b.length === 1)).toBe(true);
  });
});

// ---- the tags --------------------------------------------------------------

describe("P-CL1 tags — the kind IS the tag", () => {
  it("emits the eight claim tags, T, Y and Q — and no kind field", () => {
    expect([...P_CL1_TAGS]).toEqual(["Y", "F", "P", "B", "O", "I", "R", "H", "W", "T", "Q"]);
    expect(P_CL1_TAGS).not.toContain("Z");
    // No `<kind>` slot anywhere in the OUTPUT template: the tag carries it.
    expect(P_CL1_SYSTEM).not.toContain("<kind>");
    expect(cl1Legend()).not.toContain("<kind>");
  });

  it("the legend prints the eight claim kinds as ONE shape group", () => {
    const legend = cl1Legend();
    expect(legend).toContain("F=claim.fact");
    expect(legend).toContain("W=claim.workflow");
    // One template line for all eight, not eight identical rows.
    expect(legend.match(/<events> \| <subject> \| <attribution>/g)).toHaveLength(1);
  });

  it("the legend carries the enums those tags reference and no others", () => {
    const legend = cl1Legend();
    for (const e of ["attribution", "origin", "direction", "stake", "horizon"]) {
      expect(legend).toContain(e);
    }
    expect(legend).toContain("1p=first_person");
    expect(legend).toContain("q3=quoted_third_party");
    expect(legend).not.toContain("change");
  });

  it("is byte-stable across calls — a drifting prefix is a silent cache miss", () => {
    expect(cl1Legend()).toBe(cl1Legend());
    expect(buildCl1System()).toBe(buildCl1System());
    expect(buildCl1System().startsWith(cl1Legend())).toBe(true);
  });
});

// ---- M: the claim rules ----------------------------------------------------

describe("M — the SYSTEM half states the claim rules", () => {
  it("M-001..020 names all eight kinds against their tags", () => {
    for (const row of [
      "F fact   P preference   B belief   O opinion",
      "I interest   R recommendation   H habit   W workflow",
    ]) {
      expect(P_CL1_SYSTEM).toContain(row);
    }
    expect(P_CL1_SYSTEM).toContain("The TAG is the kind");
  });

  it("M-021..048 lists the four attribution values", () => {
    expect(P_CL1_SYSTEM).toContain("1p first-person");
    expect(P_CL1_SYSTEM).toContain("ao about-other");
    expect(P_CL1_SYSTEM).toContain("rs reported speech");
    expect(P_CL1_SYSTEM).toContain("q3 quoted/forwarded content the speaker did not author");
  });

  it("M-049..061 demands resolved third person, with the worked pronouns", () => {
    expect(P_CL1_SYSTEM).toContain("RESOLVED THIRD PERSON");
    expect(P_CL1_SYSTEM).toContain('Never leave "me", "she",');
    expect(P_CL1_SYSTEM).toContain('If self says "I love X", the subject is me and the');
    expect(P_CL1_SYSTEM).toContain("text is \"Loves X\"");
  });

  it("M-062..069 excludes logistics chatter by name", () => {
    expect(P_CL1_SYSTEM).toContain('No claims for logistics chatter ("ok", "sent", "reaching")');
  });

  it("M-070..075 says unknown beats wrong, and how to write the hint", () => {
    expect(P_CL1_SYSTEM).toContain("UNKNOWN BEATS WRONG");
    expect(P_CL1_SYSTEM).toContain('Write the hint as "+<hint>" in the subject field');
    expect(P_CL1_SYSTEM).toContain("NEVER pick the nearest roster alias to avoid a blank");
  });

  it("M-076..081 bounds valid_from to a stated boundary", () => {
    expect(P_CL1_SYSTEM).toContain("valid_from only when the episode states a time bound");
  });

  it("M-088..091 makes evidence mandatory", () => {
    expect(P_CL1_SYSTEM).toContain("Every claim and loop MUST cite ≥1 event");
  });

  it("M-092..095 forbids age filtering — judge from the episode, not from now", () => {
    expect(P_CL1_SYSTEM).toContain("Episodes arrive out of chronological order by design");
    expect(P_CL1_SYSTEM).toContain("using the episode's own date for relative time");
  });

  it("claims are unconditional — both outputs, never a choice", () => {
    expect(P_CL1_SYSTEM).toContain("For EVERY episode produce TWO independent outputs. Never choose between them.");
    expect(P_CL1_SYSTEM).toContain("A) CLAIMS — always.");
  });
});

// ---- N: the loop rules -----------------------------------------------------

describe("N — the SYSTEM half states the loop rules", () => {
  it("N-019..034 requires BOTH intent and an unresolved end state", () => {
    expect(P_CL1_SYSTEM).toContain(
      "B) LOOPS — ONLY when BOTH are present: evidence of INTENT and an UNRESOLVED\n   END STATE.",
    );
  });

  it("lists exactly four generators, and no fifth", () => {
    for (const g of [
      "1. an explicit commitment with an open end",
      "2. a fact with a TEMPORAL BOUNDARY",
      "3. a recurring obligation",
      "4. the user declaring one",
    ]) {
      expect(P_CL1_SYSTEM).toContain(g);
    }
    expect(P_CL1_SYSTEM).not.toContain("5.");
  });

  it("N-007..014 names the temporal-boundary generators and says extract them everywhere", () => {
    expect(P_CL1_SYSTEM).toContain("lease, passport, warranty, renewal,");
    expect(P_CL1_SYSTEM).toContain("subscription, policy, appointment");
    expect(P_CL1_SYSTEM).toContain("Extract them wherever they appear");
    expect(P_CL1_SYSTEM).toContain("These are the highest-value loops");
  });

  it("N-015..018 keeps a recommendation a claim until the user commits", () => {
    expect(P_CL1_SYSTEM).toContain("NO loop for a recommendation someone made. That is an R claim.");
    expect(P_CL1_SYSTEM).toContain("It becomes\n     a loop only when the user commits");
  });

  it("N-029..034 rules out the capability guess", () => {
    expect(P_CL1_SYSTEM).toContain("NO loop for something you merely could help with — that is a capability");
    expect(P_CL1_SYSTEM).toContain("guess, not the person's intent");
  });

  it("N-035..040 forbids inventing a due date", () => {
    expect(P_CL1_SYSTEM).toContain('due: ISO date, or "-". NEVER invent one.');
    expect(P_CL1_SYSTEM).toContain('"soon"/"next week" → "-" unless');
  });

  it("N-041..046 anchors relative dates on the EPISODE", () => {
    expect(P_CL1_SYSTEM).toContain("Resolve relative dates against the EPISODE's date");
  });

  it("N-067..071 is conservative about implicit origin", () => {
    expect(P_CL1_SYSTEM).toContain("origin ex when stated by anyone present, im when you inferred it");
    expect(P_CL1_SYSTEM).toContain("a false suggestion costs more than a missed one");
  });

  it("N-047..075 forbids the model writing state, triage or party_pair at all", () => {
    expect(P_CL1_SYSTEM).toContain("State, triage and party_pair are NEVER yours to write.");
    expect(P_CL1_SYSTEM).not.toContain("op|lt|dn|lp|dr");
  });
});

// ---- the Y line ------------------------------------------------------------

describe("the Y summary", () => {
  it("is emitted in pass 1, which is what makes delta `summary` mode free", () => {
    expect(P_CL1_SYSTEM).toContain("C) SUMMARY — one Y line per episode, 2-3 self-contained sentences.");
    expect(P_CL1_SYSTEM).toContain("It is reused\n   as context when this episode is re-read later");
    expect(P_CL1_SYSTEM).toContain("Describe, do not editorialise");
  });
});

// ---- the USER half ---------------------------------------------------------

describe("the packed USER half", () => {
  it("is §12.4's shape: #R, #C, #T, #D, events, #COV", () => {
    const prompt = buildCl1Prompt(EXAMPLE);
    expect(prompt).not.toBeNull();
    const user = (prompt as NonNullable<typeof prompt>).user;
    expect(user).toContain("#R a1=Pranjali Sachdeva");
    expect(user).toContain("a3=ACT broadband [thg]");
    expect(user).toContain("#C c1 Pranjali | dm | self,a1");
    expect(user).toContain("#T t1 Confirm villa to Rohan | me | 2026-08-20 | op");
    expect(user).toContain("#D 2026-08-12 Wed | Asia/Kolkata");
    expect(user).toContain("#COV c1=4");
  });

  it("N-041..046 prints the EPISODE's date, which is what 'the 28th' resolves against", () => {
    for (const date of ["2026-01-30", "2025-11-02", "2026-09-20"]) {
      const prompt = buildCl1Prompt({
        ...EXAMPLE,
        events: [
          { id: "ev1", streamId: "str_pranjali", at: `${date}T09:00:00Z`, speakerId: "ent_pranjali", text: "renews on the 28th" },
        ],
      });
      expect((prompt as NonNullable<typeof prompt>).user).toContain(`#D ${date}`);
    }
  });

  it("M-092..095 packs a 2019 episode exactly like a 2026 one — no age gate", () => {
    const old = buildCl1Prompt({
      ...EXAMPLE,
      events: [{ id: "ev1", streamId: "str_pranjali", at: "2019-06-03T09:00:00Z", speakerId: "self", text: "my lease ends in Nov 2027" }],
    });
    expect(old).not.toBeNull();
    expect((old as NonNullable<typeof old>).stats.events).toBe(1);
  });

  it("refuses rather than truncating a roster over the packer's cap (§5.9.3)", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `ent_${i}`, name: `Person ${i}` }));
    expect(buildCl1Prompt({ ...EXAMPLE, entities: many })).toBeNull();
  });

  it("sends no JSON in either direction", () => {
    const prompt = buildCl1Prompt(EXAMPLE) as NonNullable<ReturnType<typeof buildCl1Prompt>>;
    expect(prompt.system).not.toContain("{\"");
    expect(prompt.user).not.toContain("{\"");
    expect(prompt.system).toContain("No JSON, no prose");
  });
});

// ---- the §12.4 worked example, end to end ----------------------------------

describe("§12.4's worked example round trips", () => {
  it("reads the EXPECTED block back against the real alias table", () => {
    const prompt = buildCl1Prompt(EXAMPLE) as NonNullable<ReturnType<typeof buildCl1Prompt>>;
    const expected = [
      "Y|e1|Pranjali has started Saturday bhangra classes and prefers them to the gym. Aditya offered to send her a Goa villa link the same night. Her broadband renews on the 28th and she finds ACT overpriced.",
      "H|1|a1|1p|0.95|-|Attends bhangra classes on Saturdays",
      "P|1|a1|1p||-|Prefers bhangra classes over the gym",
      "O|3|a3|ao||-|Pranjali considers ACT broadband overpriced",
      "T|2|self|a1|ex|i2t|l|d|2026-08-12|-|0.95|Send Pranjali the Goa villa link",
      "T|3|a1|-|ex|slf|m|mo|2026-08-28|monthly||Pranjali's broadband renews",
    ].join("\n");

    const answer = parseCl1Response(expected, prompt.table);

    expect(answer.claims.map((c) => c.kind)).toEqual(["habit", "preference", "opinion"]);
    expect(answer.claims[0].confidence).toBe(0.95);
    // "the P line has an EMPTY confidence field, meaning 0.9".
    expect(answer.claims[1].confidence).toBe(0.9);
    expect(answer.claims[2].subjectId).toBe("ent_act");
    expect(answer.claims[2].attribution).toBe("about_other");

    expect(answer.loops).toHaveLength(2);
    expect(answer.loops[0].ownerId).toBe("self");
    expect(answer.loops[0].counterpartyId).toBe("ent_pranjali");
    // "the second T is owner=a1 → party_pair oo by code → NOT the user's task."
    expect(answer.loops[1].ownerId).toBe("ent_pranjali");
    expect(answer.loops[1].counterpartyId).toBeNull();
    expect(answer.loops[1].recurrence).toBe("monthly");
    // "the 28th resolved against the EPISODE's date, not today's."
    expect(answer.loops[1].due).toBe("2026-08-28");

    // "event 4 'ok' produced nothing." — no claim cites it.
    const cited = new Set(answer.claims.flatMap((c) => c.eventIds));
    expect(cited.has("ev4")).toBe(false);
    // "t1 was supplied as context and correctly NOT re-emitted."
    expect(answer.loops.some((l) => l.intent === "Confirm villa to Rohan")).toBe(false);
    // "bhangra produced a habit claim and NO loop — no open end state."
    expect(answer.loops.some((l) => /bhangra/i.test(l.intent))).toBe(false);

    expect(answer.summaries).toHaveLength(1);
    expect(answer.unsupported).toHaveLength(0);
    expect(answer.violations).toHaveLength(0);
    expect(extractionAccounts(answer)).toBe(true);
  });

  it("event ids never appear in the answer — that is the whole saving (§5)", () => {
    const prompt = buildCl1Prompt(EXAMPLE) as NonNullable<ReturnType<typeof buildCl1Prompt>>;
    const answer = parseCl1Response("H|1|a1|1p|0.95|-|Attends bhangra classes on Saturdays", prompt.table);
    expect(answer.claims[0].raw).not.toContain("ev1");
    expect(answer.claims[0].eventIds).toEqual(["ev1"]);
  });

  it("the packed prompt is far smaller than the ids it stands in for", () => {
    const packed = packPrompt(EXAMPLE);
    expect(packed.ok).toBe(true);
    if (packed.ok) expect(packed.text).not.toContain("str_pranjali");
  });
});
