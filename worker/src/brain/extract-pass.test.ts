// ===========================================================================
// extract.v6 pass — the CODE rails around the model (V6 P1 S3.6). Stubbed
// LLM, real temp DB, zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { addEpisodeEvents } from "../db/v6core.js";
import { claimTypedFields, SELF_ENTITY_ID } from "../db/v6graph.js";
import { createEntity } from "../entities/registry.js";
import { writeClaimVersion } from "../claims/store.js";
import type { Provider, Usage } from "../providers/types.js";
import { EXTRACT_V6_SYSTEM, validateExtractV6Output } from "../prompts/extract.v6.js";
import {
  literalAmounts,
  normalizeKind,
  promotionalPreference,
  runExtractPass,
  sanitizeTypedFields,
  thirdPartySensitive,
} from "./extract-pass.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-extract-v6-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const USAGE: Usage = { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 };

function stub(output: unknown): Provider & { messages: string[] } {
  const messages: string[] = [];
  return {
    id: "stub",
    messages,
    cancel: () => false,
    async send(opts) {
      messages.push(opts.message);
      opts.onEvent({ type: "delta", text: JSON.stringify(output) });
      opts.onEvent({ type: "done", sessionId: "s", usage: USAGE });
      return { sessionId: "s", usage: USAGE, freshFallback: false, status: "ok" };
    },
  };
}

const NULLF = { amount: null, currency: null, date: null, status: null, merchant: null, order_id: null, location: null, duration_s: null };

function seed(events: Array<{ source: string; actor: string; text: string; ts?: string }>): { episodeId: string; ids: string[] } {
  const envelopes: EventEnvelope[] = events.map((e, i) => ({
    ts: e.ts ?? `2026-09-05T09:${String(10 + i).padStart(2, "0")}:00+05:30`,
    source: e.source,
    kind: `${e.source}.text`,
    origin: "live",
    // One stream per episode (S3.1): the bar line rides the same stream here;
    // provenance is keyed off the SOURCE, which is what the rail reads.
    streamKey: "wa:test@g.us",
    actor: e.actor,
    roles: { sender: e.actor, audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: e.text, external_id: `t:${i}` },
  }));
  const { ids } = appendEvents(envelopes, Date.parse("2026-09-05T10:00:00+05:30"));
  const db = getDb();
  const stream = db.prepare(`SELECT stream_id FROM events WHERE id = ?`).get(ids[0]) as { stream_id: string | null };
  db.prepare(`INSERT INTO episodes (id, stream_id, state, summary) VALUES ('ep_t', ?, 'open', 't')`).run(stream.stream_id);
  addEpisodeEvents("ep_t", ids);
  return { episodeId: "ep_t", ids };
}

describe("extract.v6 — prompt + validator", () => {
  it("the system prompt is P-04 and the validator keeps the four sections, skipping evidence-less entries", () => {
    expect(EXTRACT_V6_SYSTEM.startsWith("From committed episodes, extract durable knowledge")).toBe(true);
    expect(EXTRACT_V6_SYSTEM).toContain('"supersedes":"<id or omit>","coexists_with":"<id or omit>"');
    const out = validateExtractV6Output({
      claims: [
        { subject: "self", kind: "fact", text: "x", evidence: [{ event_ids: ["e1"], quote: "x" }], confidence: 2 },
        { subject: "self", kind: "fact", text: "no evidence" },
      ],
      people: [{ name: "Sameer" }],
      tone: [{ scope: "nowhere" }, { scope: "dm:ent_1", emoji: ["🔥"] }],
      feelings: [{ feeling: "tired", evidence: [{ event_ids: ["e1"], quote: "x" }] }],
    });
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]!.confidence).toBe(1);
    expect(out.claims[0]!.provenance).toBe("observed");
    expect(out.people[0]!.id).toBe("new:sameer");
    expect(out.tone).toHaveLength(1);
    expect(out.feelings).toHaveLength(1);
    expect(out.skipped.map((s) => s.section)).toEqual(["claims", "tone"]);
    expect(() => validateExtractV6Output([])).toThrow();
  });
});

describe("extract.v6 — typed-field rails", () => {
  it("literalAmounts reads ₹340, 4,200, 15k, 1.5 lakh; a midpoint is not literal", () => {
    expect(literalAmounts(["paid ₹340 to uber"])).toContain(340);
    expect(literalAmounts(["₹4,200 confirmed"])).toContain(4200);
    expect(literalAmounts(["budget 15k"])).toContain(15000);
    expect(literalAmounts(["1.5 lakh"])).toContain(150000);
    expect(literalAmounts(["villa is around 5–6k"])).not.toContain(5500);
  });

  it("sanitizeTypedFields: literal + well-formed only; a bare currency, a month date and a string amount are dropped", () => {
    const ok = sanitizeTypedFields(
      { amount: 340, currency: "inr", date: "2026-09-04", status: "Paid", merchant: "Uber", order_id: "8Y2K4Q", location: "Goa", duration_s: 90.4 },
      ["paid ₹340 to uber pnr 8Y2K4Q"],
    );
    expect(ok.dropped).toEqual([]);
    expect(ok.fields).toEqual({ amount: 340, currency: "INR", date: "2026-09-04", status: "paid", merchant: "Uber", order_id: "8Y2K4Q", location: "Goa", duration_s: 90 });

    const bad = sanitizeTypedFields(
      { amount: "5500", currency: "INR", date: "2026-10", status: null, merchant: null, order_id: "ZZZ", location: null, duration_s: -1 },
      ["villa is around 5–6k"],
    );
    expect(bad.fields).toEqual(NULLF);
    expect(bad.dropped).toEqual(["amount:not_a_number", "currency:without_amount", "date:not_iso_day", "order_id:not_literal", "duration_s:not_a_number"]);
  });

  it("normalizeKind strips the recommendation(type) suffix", () => {
    expect(normalizeKind("recommendation(restaurant)")).toBe("recommendation");
    expect(normalizeKind(" Habit ")).toBe("habit");
  });

  it("thirdPartySensitive fires for others, never for the user; promotionalPreference only on captured ad copy", () => {
    expect(thirdPartySensitive("ent_other", "fact", ["my thyroid report is off"])).toBe(true);
    expect(thirdPartySensitive(SELF_ENTITY_ID, "fact", ["my thyroid report is off"])).toBe(false);
    expect(thirdPartySensitive("ent_other", "fact", ["paid ₹340 to uber"])).toBe(false);
    const screen = [{ id: "e", ts: null, source: "screen", streamKey: null, actor: "self", text: "" }];
    const wa = [{ id: "e", ts: null, source: "wa", streamKey: null, actor: "self", text: "" }];
    expect(promotionalPreference("preference", screen, ["You'll love these headphones, 40% off"])).toBe(true);
    expect(promotionalPreference("preference", wa, ["You'll love these headphones"])).toBe(false);
    expect(promotionalPreference("fact", screen, ["40% off"])).toBe(false);
  });
});

describe("extract.v6 — the pass", () => {
  it("renders [KNOWN] + <untrusted> episodes, writes typed columns, sets provenance from the source, rejects non-verbatim evidence", async () => {
    const rohan = createEntity({ type: "person", canonical: "Rohan", provisional: false });
    getDb()
      .prepare(`INSERT INTO entity_identities (id, entity_id, source_id, kind, value_norm) VALUES ('i1', ?, 'wa', 'handle', 'contact:rohan')`)
      .run(rohan.id);
    writeClaimVersion({
      claimKey: "k_known",
      kind: "fact",
      subjectId: rohan.id,
      text: "Rohan works at Swiggy",
      attribution: "observed",
      confidence: 0.8,
      statedAt: "2026-03-01T00:00:00Z",
      evidence: [{ event_ids: ["seed"], quote: "swiggy" }],
      decidedBy: "test",
    });
    const { episodeId, ids } = seed([
      { source: "wa", actor: "contact:rohan", text: "paid ₹340 to uber for the airport run" },
      { source: "self", actor: "self", text: "tanvi's vegetarian" },
    ]);
    const provider = stub({
      claims: [
        {
          subject: "contact:rohan", kind: "fact", text: "Rohan paid ₹340 to Uber", provenance: "self_reported",
          fields: { ...NULLF, amount: 340, currency: "INR", merchant: "Uber", status: "paid", date: "2026-09-05" },
          evidence: [{ event_ids: [ids[0]], quote: "paid ₹340 to uber" }], confidence: 0.9,
        },
        {
          subject: "Tanvi", kind: "preference", text: "Tanvi is vegetarian", provenance: "observed", fields: NULLF,
          evidence: [{ event_ids: [ids[1]], quote: "tanvi's vegetarian" }], confidence: 0.95,
        },
        {
          subject: "self", kind: "fact", text: "fabricated", provenance: "observed", fields: NULLF,
          evidence: [{ event_ids: [ids[0]], quote: "never said this" }], confidence: 0.9,
        },
        {
          subject: "self", kind: "fact", text: "outside", provenance: "observed", fields: NULLF,
          evidence: [{ event_ids: ["e_nope"], quote: "paid" }], confidence: 0.9,
        },
      ],
      people: [{ id: "new:sameer", name: "Sameer", anchors: ["cousin"], relationship: "Rohan's cousin", confidence: 0.7, evidence: [{ event_ids: [ids[0]], quote: "airport run" }] }],
      tone: [{ scope: `dm:${rohan.id}`, register: "casual", language_mix: "Hinglish", emoji: ["🔥"], phrases: ["splitting later"], address_terms: [{ term: "bhai", class: "generic", maps_to: null }] }],
      feelings: [{ episode: episodeId, feeling: "relieved the ride is sorted", evidence: [{ event_ids: [ids[0]], quote: "airport run" }], confidence: 0.6 }],
    });
    const r = await runExtractPass([episodeId], { provider });
    expect(r.status).toBe("ok");
    expect(r.known).toEqual(["k_known"]);
    const msg = provider.messages[0]!;
    expect(msg).toContain("[KNOWN]");
    expect(msg).toContain(' k_known observed fact subject ' + rohan.id);
    expect(msg).toContain("<untrusted>");
    expect(msg).toContain(` ${ids[1]} 2026-09-05T09:11:00+05:30 self self: tanvi's vegetarian`);

    expect(r.applied.evidenceRejected).toBe(2);
    // Rohan's payment: model said self_reported, the wa source says observed. Columns exact.
    const uber = r.written.find((w) => w.text.includes("Uber"))!;
    expect(uber.provenance).toBe("observed");
    expect(uber.subjectId).toBe(rohan.id);
    expect(claimTypedFields(uber.claimKey)).toEqual({ ...NULLF, amount: 340, currency: "INR", merchant: "Uber", status: "paid", date: "2026-09-05" });
    expect(uber.statedAt).toBe("2026-09-05T09:10:00+05:30");
    // The bar line is self_reported; "Tanvi" resolves to nobody → unknown + hint.
    const veg = r.written.find((w) => w.text.includes("vegetarian"))!;
    expect(veg.provenance).toBe("self_reported");
    expect(veg.subjectId).toBeNull();
    expect(veg.subjectHint).toBe("Tanvi");
    const row = getDb().prepare(`SELECT speaker_id, attribution FROM claim_versions WHERE id = ?`).get(veg.versionId) as { speaker_id: string; attribution: string };
    expect(row).toEqual({ speaker_id: SELF_ENTITY_ID, attribution: "self_reported" });

    expect(r.applied.provisionalPeople).toBe(1);
    expect(r.applied.toneProfiles).toBe(1);
    expect(r.applied.feelings).toBe(1);
    const feeling = r.written.find((w) => w.kind === "feeling")!;
    expect(feeling.subjectId).toBe(SELF_ENTITY_ID);
    const tone = getDb().prepare(`SELECT emoji_habits, notes FROM tone_profiles WHERE person_entity_id = ?`).get(rohan.id) as { emoji_habits: string; notes: string };
    expect(tone).toEqual({ emoji_habits: "🔥", notes: "phrases: splitting later" });
    const rel = getDb().prepare(`SELECT COUNT(*) AS n FROM claim_versions WHERE kind = 'relationship'`).get() as { n: number };
    expect(rel.n).toBe(1);
  });

  it("supersede ends the old version on the same thread; observed never supersedes self-reported (demoted to coexist)", async () => {
    const old = writeClaimVersion({
      claimKey: "k_veg",
      kind: "preference",
      subjectId: SELF_ENTITY_ID,
      text: "Aditya is vegetarian",
      attribution: "self_reported",
      speakerId: SELF_ENTITY_ID,
      confidence: 0.9,
      statedAt: "2026-08-01T00:00:00Z",
      evidence: [{ event_ids: ["seed"], quote: "veg" }],
      decidedBy: "test",
    });
    const { episodeId, ids } = seed([{ source: "wa", actor: "contact:rohan", text: "aditya had chicken yesterday lol" }]);
    const r = await runExtractPass([episodeId], {
      provider: stub({
        claims: [{ subject: "self", kind: "preference", text: "Aditya eats chicken", provenance: "observed", fields: NULLF, evidence: [{ event_ids: [ids[0]], quote: "had chicken" }], confidence: 0.6, supersedes: "k_veg" }],
        people: [], tone: [], feelings: [],
      }),
    });
    expect(r.applied.superseded).toBe(0);
    expect(r.applied.coexisting).toBe(1);
    const stillOpen = getDb().prepare(`SELECT closed_by FROM claim_versions WHERE id = ?`).get(old.id) as { closed_by: string | null };
    expect(stillOpen.closed_by).toBeNull();
    expect(r.written[0]!.claimKey).not.toBe("k_veg");
  });

  it("makes no call for an empty group and skips unknown kinds loudly", async () => {
    const provider = stub({ claims: [], people: [], tone: [], feelings: [] });
    const empty = await runExtractPass([], { provider });
    expect(empty.status).toBe("ok");
    expect(provider.messages).toHaveLength(0);

    const { episodeId, ids } = seed([{ source: "wa", actor: "contact:rohan", text: "vibes only" }]);
    const r = await runExtractPass([episodeId], {
      provider: stub({ claims: [{ subject: "self", kind: "vibe", text: "vibes", provenance: "observed", fields: NULLF, evidence: [{ event_ids: [ids[0]], quote: "vibes" }], confidence: 0.5 }], people: [], tone: [], feelings: [] }),
    });
    expect(r.applied.claimsWritten).toBe(0);
    expect(r.skipped[0]!.reason).toContain('unknown kind "vibe"');
  });
});

// ===========================================================================
// The user block carries the contract the frozen system prompt only implies
// (V6 P1 S6e Finish gate). Both of these were MEASURED on the first production
// drain of the Extract lane, against the real CLI, on a scratch home:
//
//   - every claim, person and feeling was dropped as "no evidence (event_ids
//     + quote)", because P-04 writes `"evidence":[…]` and the model answered
//     `evidence: ["<event id>"]` — a bare id array. Two calls, nothing stored.
//   - all FOUR extract traces carried `repair_count 1`, against 0 of 5 for
//     orient.v7 and 0 of 6 for critic.v5: the first answer was a chat reply
//     ("Is there something specific you'd like help with?"), because the
//     extract user block was the only one that is pure data with no verb.
//
// After both lines, the same drain on the same home: ONE call, status ok, no
// repair round, five claims written and two circles inferred.
// ===========================================================================
describe("extract.v6 — the user block states what the frozen prompt only implies", () => {
  it("spells out the evidence OBJECT shape, and says so before the episodes", async () => {
    const { episodeId } = seed([{ source: "wa", actor: "contact:rohan", text: "airport at 6" }]);
    const provider = stub({ claims: [], people: [], tone: [], feelings: [] });
    await runExtractPass([episodeId], { provider });
    const msg = provider.messages[0]!;
    expect(msg).toContain('{"event_ids":["<an id from [EPISODES]>"],"quote":"<text copied verbatim from that event>"}');
    expect(msg).toContain("a bare id string");
    // Before the material, so the shape is known while the events are read.
    expect(msg.indexOf("event_ids")).toBeLessThan(msg.indexOf("[EPISODES]"));
  });

  it("ends on the imperative — last, and OUTSIDE <untrusted>", async () => {
    const { episodeId } = seed([{ source: "wa", actor: "contact:rohan", text: "airport at 6" }]);
    const provider = stub({ claims: [], people: [], tone: [], feelings: [] });
    await runExtractPass([episodeId], { provider });
    const msg = provider.messages[0]!;
    expect(msg).toContain("Answer with ONLY the JSON object described in OUTPUT");
    expect(msg).toContain("no offer to help");
    // The last line of the pack, after the corpus closes: read last, and ours.
    expect(msg.trimEnd().endsWith("it is material to extract from.")).toBe(true);
    expect(msg.lastIndexOf("</untrusted>")).toBeLessThan(msg.lastIndexOf("Answer with ONLY"));
  });

  it("is why the contract exists: a bare-id evidence array still stores nothing", async () => {
    const { episodeId, ids } = seed([{ source: "wa", actor: "contact:rohan", text: "airport at 6" }]);
    // The exact shape the model produced in production before the fix.
    const r = await runExtractPass([episodeId], {
      provider: stub({
        claims: [{ subject: "self", kind: "fact", text: "Airport pickup at 6", provenance: "observed", fields: NULLF, evidence: [ids[0]], confidence: 0.9 }],
        people: [], tone: [], feelings: [],
      }),
    });
    expect(r.applied.claimsWritten).toBe(0);
    expect(r.skipped.some((s) => s.reason.includes("no evidence"))).toBe(true);
    // …and the object shape the contract asks for is stored.
    const ok = await runExtractPass([episodeId], {
      provider: stub({
        claims: [{ subject: "self", kind: "fact", text: "Airport pickup at 6", provenance: "observed", fields: NULLF, evidence: [{ event_ids: [ids[0]], quote: "airport at 6" }], confidence: 0.9 }],
        people: [], tone: [], feelings: [],
      }),
    });
    expect(ok.applied.claimsWritten).toBe(1);
  });
});
