// ===========================================================================
// The role-resolution ladder (V6 P1 S5.4) on a temp DB — zero model calls.
//
// Pure-ladder cases run without touching the store; persistence, revision and
// the questions the ladder opens run against migration 0206. Every case here
// is one rung of Product_V6_Phase1 §11.2, in the order the ladder walks them.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import {
  atMentionsInText,
  confirmsReceiver,
  currentResolution,
  MODEL_FLOOR,
  namesInText,
  recordResolution,
  resolvePronoun,
  resolveRoles,
  resolutionHistory,
  reviseResolution,
  splitByAudience,
  type ResolveContext,
  type RoleMessage,
} from "./roles.js";

const ROSTER = [
  { id: "self", name: "Aditya", aliases: ["aditya"] },
  { id: "rohan", name: "Rohan Mehta", aliases: ["rohan"] },
  { id: "tanvi", name: "Tanvi S", aliases: ["tanvi"] },
  { id: "k1", name: "Karan", aliases: ["karan"] },
];

function goaCtx(over: Partial<ResolveContext> = {}): ResolveContext {
  return {
    roster: ROSTER,
    stream: { key: "goa-gang@g.us", audience: ["self", "rohan", "tanvi", "k1"], isGroup: true },
    ...over,
  };
}

function msg(id: string, sender: string, text: string, extra: Partial<RoleMessage> = {}): RoleMessage {
  return { id, sender, text, ...extra };
}

describe("the ladder — pure rungs", () => {
  it("rung 1 (DM): receiver = the other party, confidence 1", () => {
    const r = resolveRoles(msg("e1", "rohan", "kal milte hain?"), {
      roster: ROSTER,
      stream: { key: "rohan@s.whatsapp.net", audience: ["self", "rohan"], isGroup: false },
    });
    expect(r.receiver).toEqual(["self"]);
    expect(r.rung).toBe("structural");
    expect(r.confidence).toBe(1);
  });

  it("ROL-01 rung 1 (@mention): receiver is the mentioned member, never the group", () => {
    const r = resolveRoles(msg("e1", "rohan", "@Karan bhai book your ticket today, price badh raha hai"), goaCtx());
    expect(r.receiver).toEqual(["k1"]);
    expect(r.rung).toBe("structural");
    expect(r.basis).toContain("@mention");
    expect(r.receiver).not.toContain("self");
  });

  it("ROL-01 rung 2 (named): 'aditya tu ho gaya na?' addresses self", () => {
    const r = resolveRoles(msg("e3", "rohan", "aditya tu ho gaya na?"), goaCtx());
    expect(r.receiver).toEqual(["self"]);
    expect(r.rung).toBe("named");
  });

  it("ROL-08 rung 1 (reply chain): an assent binds to the message it replies to, not the nearest question", () => {
    const prior = [
      msg("e10", "rohan", "villa A or B?"),
      msg("e11", "tanvi", "cab share from airport?"),
    ];
    const r = resolveRoles(msg("e12", "k1", "yes", { replyTo: "e11" }), goaCtx({ prior }));
    expect(r.boundTo).toBe("e11");
    expect(r.receiver).toEqual(["tanvi"]);
    expect(r.rung).toBe("reply");
  });

  it("ROL-02 broadcast: an unaddressed group message reaches the whole audience", () => {
    const r = resolveRoles(msg("e1", "tanvi", "guys weather forecast says rain 18th, carry jackets"), goaCtx());
    expect(r.rung).toBe("broadcast");
    expect(new Set(r.receiver)).toEqual(new Set(["self", "rohan", "k1"]));
    expect(r.status).toBe("resolved");
  });

  it("ROL-03 rung 7 (set test): a named member is a receiver, a named non-member is a third party", () => {
    const roster = [...ROSTER, { id: "dev", name: "Dev" }];
    const r = resolveRoles(msg("e1", "rohan", "tanvi ask dev if his anjuna villa contact is still active"), goaCtx({ roster }));
    expect(r.receiver).toEqual(["tanvi"]);
    expect(r.mentionedReceivers).toEqual(["tanvi"]);
    expect(r.thirdParties).toEqual(["dev"]);
    expect(r.basis).toContain("third party");
  });

  it("splitByAudience is pure set membership", () => {
    expect(splitByAudience(["a", "b", "c"], ["a", "c"])).toEqual({ inAudience: ["a", "c"], thirdParties: ["b"] });
  });

  it("ROL-06 rung 4/5: a generic address term contributes nothing; context decides", () => {
    const r = resolveRoles(msg("e1", "self", "bro send the payment link"), {
      ...goaCtx(),
      addressMemory: { bro: { rohan: 4 } },
      addressMemoryElsewhere: { bro: { k1: 3, sameer: 2 } },
      contextOwners: [{ keywords: ["payment link", "villa"], owner: "rohan", source: "ep_412: Rohan owns the villa booking" }],
    });
    expect(r.addressTerms[0]).toMatchObject({ term: "bro", class: "generic", mapsTo: null });
    expect(r.rung).toBe("context");
    expect(r.receiver).toEqual(["rohan"]);
    expect(r.basis).toContain("generic");
    expect(r.basis).toContain("ep_412");
  });

  it("ROL-06 with no context owner: unknown beats wrong, and a question is carried", () => {
    const r = resolveRoles(msg("e1", "self", "bro send the payment link"), {
      ...goaCtx(),
      addressMemory: { bro: { rohan: 4 } },
      addressMemoryElsewhere: { bro: { k1: 3, sameer: 2 } },
    });
    expect(r.status).toBe("unknown");
    expect(r.receiver).toEqual([]);
    expect(r.confidence).toBe(0);
    expect(r.question).toBeTruthy();
  });

  it("ROL-07 rung 4: a discriminating term in this group resolves the receiver", () => {
    const r = resolveRoles(msg("e1", "self", "boss can we push the demo to Friday?"), {
      roster: [{ id: "self", name: "Aditya" }, { id: "sameer", name: "Sameer" }, { id: "priya", name: "Priya" }],
      stream: { key: "falcon@g.us", audience: ["self", "sameer", "priya"], isGroup: true },
      addressMemory: { boss: { sameer: 6 } },
      addressMemoryElsewhere: {},
    });
    expect(r.rung).toBe("address_term");
    expect(r.receiver).toEqual(["sameer"]);
    expect(r.addressTerms[0]).toMatchObject({ class: "discriminating", mapsTo: "sameer" });
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("two observations is not enough to be discriminating", () => {
    const r = resolveRoles(msg("e1", "self", "boss can we push the demo to Friday?"), {
      roster: [{ id: "self", name: "Aditya" }, { id: "sameer", name: "Sameer" }],
      stream: { key: "falcon@g.us", audience: ["self", "sameer"], isGroup: true },
      addressMemory: { boss: { sameer: 2 } },
      addressMemoryElsewhere: {},
    });
    expect(r.addressTerms[0]!.class).toBe("generic");
  });

  it("rung 6 (model): accepted only above the floor, only inside the audience, and never over a higher rung", () => {
    const model = () => [{ id: "tanvi", confidence: 0.82, reason: "she owns the cab thread" }];
    const withModel = resolveRoles(msg("e1", "rohan", "please confirm the pickup time"), goaCtx({ model }));
    expect(withModel.rung).toBe("model");
    expect(withModel.receiver).toEqual(["tanvi"]);
    expect(withModel.confidence).toBeLessThan(0.9);

    const shaky = resolveRoles(msg("e1", "rohan", "please confirm the pickup time"), goaCtx({ model: () => [{ id: "tanvi", confidence: MODEL_FLOOR - 0.01 }] }));
    expect(shaky.status).toBe("unknown");

    const outside = resolveRoles(msg("e1", "rohan", "please confirm the pickup time"), goaCtx({ model: () => [{ id: "dev", confidence: 0.99 }] }));
    expect(outside.status).toBe("unknown");

    let called = 0;
    const higher = resolveRoles(msg("e1", "rohan", "@Karan book it"), goaCtx({
      model: () => {
        called += 1;
        return [{ id: "tanvi", confidence: 0.99 }];
      },
    }));
    expect(higher.rung).toBe("structural");
    expect(called).toBe(0);
  });

  it("namesInText / atMentionsInText match on word boundaries only", () => {
    expect(namesInText("karan is coming", ROSTER)).toEqual(["k1"]);
    expect(namesInText("karanjit is coming", ROSTER)).toEqual([]);
    expect(atMentionsInText("@Karan bhai", ROSTER)).toEqual(["k1"]);
  });
});

describe("pronouns", () => {
  it("ROL-04: one antecedent resolves", () => {
    const roster = [
      { id: "self", name: "Aditya" },
      { id: "ma", name: "Ma", pronoun: "she" as const },
      { id: "papa", name: "Papa", pronoun: "he" as const },
      { id: "isha", name: "Isha", pronoun: "she" as const },
    ];
    const prior = [msg("e1", "ma", "Isha ka convocation 14th ko hai")];
    const r = resolvePronoun(msg("e2", "papa", "she also needs the car that morning"), {
      roster,
      stream: { key: "family@g.us", audience: ["self", "ma", "papa", "isha"], isGroup: true },
      prior,
    });
    expect(r?.subject).toBe("isha");
    expect(r?.status).toBe("resolved");
    expect(r!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("ROL-05: two candidates → unknown plus a hint, never a coin flip", () => {
    const roster = [
      { id: "self", name: "Aditya" },
      { id: "k1", name: "Karan", pronoun: "he" as const },
      { id: "tanvi", name: "Tanvi", pronoun: "she" as const },
      { id: "riya", name: "Riya", pronoun: "she" as const },
    ];
    const prior = [msg("e1", "tanvi", "kitna hua total?"), msg("e2", "riya", "main kal dekh leti hoon")];
    const r = resolvePronoun(msg("e3", "k1", "she said she'll transfer her share tonight"), {
      roster,
      stream: { key: "goa-gang@g.us", audience: ["self", "k1", "tanvi", "riya"], isGroup: true },
      prior,
    });
    expect(r?.status).toBe("unknown");
    expect(r?.subject).toBeNull();
    expect(new Set(r!.hint)).toEqual(new Set(["tanvi", "riya"]));
    expect(r?.question).toContain("Tanvi");
  });

  it("a roster pronoun hint filters candidates; it is never inferred from a name", () => {
    const roster = [
      { id: "self", name: "Aditya" },
      { id: "k1", name: "Karan", pronoun: "he" as const },
      { id: "tanvi", name: "Tanvi", pronoun: "she" as const },
      { id: "rohan", name: "Rohan", pronoun: "he" as const },
    ];
    const prior = [msg("e1", "tanvi", "hi"), msg("e2", "rohan", "yo")];
    const r = resolvePronoun(msg("e3", "k1", "she said she'll pay"), {
      roster,
      stream: { key: "g@g.us", audience: ["self", "k1", "tanvi", "rohan"], isGroup: true },
      prior,
    });
    expect(r?.subject).toBe("tanvi");
  });

  it("no pronoun → null", () => {
    expect(resolvePronoun(msg("e1", "rohan", "book the villa"), goaCtx())).toBeNull();
  });
});

describe("persistence, questions and revision (0206)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "supertwin-roles-"));
    process.env.SUPERTWIN_HOME = tmpDir;
    process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
    closeDb();
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    delete process.env.SUPERTWIN_HOME;
    delete process.env.SUPERTWIN_DB_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a resolved verdict is one row with its rung and basis", () => {
    const r = resolveRoles(msg("e1", "rohan", "@Karan book your ticket"), goaCtx());
    const row = recordResolution({ resolution: r, streamKey: "goa-gang@g.us", evidence: [{ event_ids: ["e1"], quote: "@Karan book your ticket" }] });
    expect(row.receiver).toEqual(["k1"]);
    expect(row.rung).toBe("structural");
    expect(row.questionId).toBeNull();
    expect(currentResolution("e1")!.id).toBe(row.id);
  });

  it("an unknown verdict opens a question and links it", () => {
    const r = resolveRoles(msg("e9", "self", "bro send the payment link"), {
      ...goaCtx(),
      addressMemory: { bro: { rohan: 2 } },
      addressMemoryElsewhere: { bro: { k1: 3 } },
    });
    expect(r.status).toBe("unknown");
    const row = recordResolution({ resolution: r, streamKey: "goa-gang@g.us" });
    expect(row.status).toBe("unknown");
    expect(row.questionId).not.toBeNull();
    const q = getDb().prepare(`SELECT kind, status, question FROM questions WHERE id = ?`).get(row.questionId!) as {
      kind: string;
      status: string;
      question: string;
    };
    expect(q).toMatchObject({ kind: "roles", status: "open" });
  });

  it("ROL-10: a later confirmation writes a NEW row; yesterday's 0.65 is kept, not edited", () => {
    const first = recordResolution({
      resolution: {
        messageId: "e_court",
        sender: "self",
        audience: ["self", "k1", "rohan"],
        receiver: ["k1"],
        mentionedReceivers: [],
        thirdParties: [],
        status: "resolved",
        rung: "context",
        basis: "context: Karan books the courts",
        confidence: 0.65,
        addressTerms: [],
      },
      streamKey: "badminton@g.us",
      evidence: [{ event_ids: ["e_court"], quote: "book the court" }],
    });

    const later = msg("e_done", "k1", "court booked for sat 7am ✅");
    const verdict = confirmsReceiver({ receiver: ["k1"], subjectKeywords: ["court"] }, later);
    expect(verdict.confirms).toBe(true);

    const revised = reviseResolution({
      resolutionId: first.id,
      receiver: ["k1"],
      confidence: 0.95,
      basis: verdict.why,
      evidence: [{ event_ids: ["e_done"], quote: later.text }],
    });

    const history = resolutionHistory("e_court");
    expect(history).toHaveLength(2);
    expect(history[0]!.id).toBe(first.id);
    expect(history[0]!.confidence).toBe(0.65);
    expect(history[0]!.status).toBe("revised");
    expect(revised.revisedFrom).toBe(first.id);
    expect(revised.confidence).toBe(0.95);
    expect(revised.evidence).toHaveLength(2);
    expect(currentResolution("e_court")!.id).toBe(revised.id);
  });

  it("a revision answers the question the unknown opened", () => {
    const r = resolveRoles(msg("e_q", "self", "please send the deck"), goaCtx());
    const row = recordResolution({ resolution: r, streamKey: "goa-gang@g.us" });
    expect(row.questionId).not.toBeNull();
    reviseResolution({ resolutionId: row.id, receiver: ["rohan"], confidence: 0.9, basis: "user answered", evidence: [] });
    const q = getDb().prepare(`SELECT status FROM questions WHERE id = ?`).get(row.questionId!) as { status: string };
    expect(q.status).toBe("answered");
  });

  it("confirmsReceiver refuses off-subject and third-party 'done' messages", () => {
    expect(confirmsReceiver({ receiver: ["k1"], subjectKeywords: ["court"] }, msg("x", "rohan", "court booked ✅")).confirms).toBe(false);
    expect(confirmsReceiver({ receiver: ["k1"], subjectKeywords: ["court"] }, msg("x", "k1", "dinner booked ✅")).confirms).toBe(false);
    expect(confirmsReceiver({ receiver: ["k1", "rohan"], subjectKeywords: ["court"] }, msg("x", "k1", "court booked ✅")).confirms).toBe(false);
  });
});
