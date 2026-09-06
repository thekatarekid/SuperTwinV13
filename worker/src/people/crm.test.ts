// ===========================================================================
// The personal CRM (V6 P1 S5.4) on a temp DB — zero model calls.
//
//   address terms   discriminating vs generic, DM and group memories apart
//   provisional     mention-born people, merge forward on an identifier
//   drag            merge / split by drag, undo always
//   radar           who owes a reply, and when the twin starts acting
//   card            circle · loops · radar · dates · tone · how I know them
//   who I am        built by processing, no form
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { writeClaimVersion } from "../claims/store.js";
import { putIdentity } from "../entities/identities.js";
import { isNegativePair, readDecision } from "../entities/merge.js";
import { createEntity, mergedAliasIds, resolveEntityId, setCircle } from "../entities/registry.js";
import { SELF_ENTITY_ID } from "../db/migrations/0201_v6_graph.js";
import { addressTermsForScope, classifyAddressTerm, leadingAddressTerm, observeAddressTerm } from "./address-terms.js";
import { buildPersonCard, effectiveDateMode, nextOccurrence } from "./card.js";
import { aliasChips, markDifferent, mergeByDrag, splitByDrag, undoDrag } from "./drag.js";
import { anchorsOf, candidatesForName, mergeForwardOnIdentifier, mintProvisionalPerson, unknownNameMentions } from "./provisional.js";
import { computeRadar, leadDaysFor, looksLikeAsk, setRadarLead } from "./radar.js";
import { buildWhoIAm } from "./who-i-am.js";

const NOW = new Date("2026-09-06T05:30:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-crm-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  getDb().prepare(`INSERT INTO sources (id, type, display_name) VALUES ('src_wa', 'whatsapp', 'WhatsApp')`).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function stream(id: string, key: string, label: string, kind = "group"): string {
  getDb()
    .prepare(`INSERT INTO streams (id, source_id, external_key, label, stream_kind) VALUES (?, 'src_wa', ?, ?, ?)`)
    .run(id, key, label, kind);
  return id;
}

function event(row: {
  id: string;
  streamId: string;
  streamKey: string;
  ts: string;
  text: string;
  actor: string;
  actorEntityId?: string | null;
  roles?: unknown;
  origin?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO events (id, source_id, stream_id, ts, tz, kind, text, is_self, enrichment_state,
                           actor_entity_id, ingested_at, stream_key, actor, roles_json, origin)
       VALUES (?, 'src_wa', ?, ?, 'Asia/Kolkata', 'wa.message', ?, ?, 'none', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.streamId,
      row.ts,
      row.text,
      row.actor === "self" ? 1 : 0,
      row.actorEntityId ?? null,
      NOW.toISOString(),
      row.streamKey,
      row.actor,
      row.roles ? JSON.stringify(row.roles) : null,
      row.origin ?? "live",
    );
}

// ---- address terms ---------------------------------------------------------

describe("address terms — CRM-04", () => {
  it("leadingAddressTerm only takes a leading vocative", () => {
    expect(leadingAddressTerm("bro send the link")).toBe("bro");
    expect(leadingAddressTerm("oye chotu idhar aa")).toBe("chotu");
    expect(leadingAddressTerm("send the link bro")).toBeNull();
    expect(leadingAddressTerm("please send it")).toBeNull();
  });

  it("a term used for two people anywhere is generic — zero addressee evidence", () => {
    const goa = stream("str_goa", "goa-gang@g.us", "Goa gang");
    const falcon = stream("str_falcon", "falcon@g.us", "Falcon");
    const rohan = createEntity({ type: "person", canonical: "Rohan" });
    const sameer = createEntity({ type: "person", canonical: "Sameer" });
    for (let i = 0; i < 4; i += 1) observeAddressTerm({ term: "bro", streamKey: "goa-gang@g.us", addresseeId: rohan.id });
    for (let i = 0; i < 3; i += 1) observeAddressTerm({ term: "bro", streamKey: "falcon@g.us", addresseeId: sameer.id });
    const here = classifyAddressTerm("bro", "goa-gang@g.us");
    expect(here.class).toBe("generic");
    expect(here.mapsTo).toBeNull();
    expect(here.distinctAddressees).toBe(2);
    expect(goa).toBe("str_goa");
    expect(falcon).toBe("str_falcon");
  });

  it("ROL-07: a term used for one person, three times or more, in one scope is discriminating", () => {
    stream("str_falcon", "falcon@g.us", "Falcon");
    const sameer = createEntity({ type: "person", canonical: "Sameer" });
    let last = classifyAddressTerm("boss", "falcon@g.us");
    for (let i = 0; i < 6; i += 1) last = observeAddressTerm({ term: "boss", streamKey: "falcon@g.us", addresseeId: sameer.id });
    expect(last.class).toBe("discriminating");
    expect(last.mapsTo).toBe(sameer.id);
    expect(classifyAddressTerm("boss", "falcon@g.us")).toMatchObject({ class: "discriminating", mapsTo: sameer.id });
    expect(addressTermsForScope({ streamKey: "falcon@g.us" }).map((t) => t.term)).toContain("boss");
  });

  it("a second addressee turns a discriminating term back to generic", () => {
    stream("str_falcon", "falcon@g.us", "Falcon");
    const sameer = createEntity({ type: "person", canonical: "Sameer" });
    const priya = createEntity({ type: "person", canonical: "Priya" });
    for (let i = 0; i < 4; i += 1) observeAddressTerm({ term: "boss", streamKey: "falcon@g.us", addresseeId: sameer.id });
    const after = observeAddressTerm({ term: "boss", streamKey: "falcon@g.us", addresseeId: priya.id });
    expect(after.class).toBe("generic");
    expect(classifyAddressTerm("boss", "falcon@g.us").class).toBe("generic");
  });

  it("DM memory and group memory are kept apart", () => {
    stream("str_falcon", "falcon@g.us", "Falcon");
    const sameer = createEntity({ type: "person", canonical: "Sameer" });
    for (let i = 0; i < 3; i += 1) observeAddressTerm({ term: "boss", streamKey: "falcon@g.us", addresseeId: sameer.id });
    // The DM scope has never heard the term.
    expect(addressTermsForScope({ personEntityId: sameer.id })).toEqual([]);
    for (let i = 0; i < 3; i += 1) observeAddressTerm({ term: "chief", personEntityId: sameer.id, addresseeId: sameer.id });
    expect(addressTermsForScope({ personEntityId: sameer.id }).map((t) => t.term)).toEqual(["chief"]);
    expect(addressTermsForScope({ streamKey: "falcon@g.us" }).map((t) => t.term)).toEqual(["boss"]);
  });

  it("a scope that resolves to neither a stream nor a person is refused", () => {
    expect(() => observeAddressTerm({ term: "bro", streamKey: "nope@g.us", addresseeId: "x" })).toThrow(/resolves to no stream/);
  });
});

// ---- provisional people ----------------------------------------------------

describe("provisional people — ROL-09 / CRM-03", () => {
  const roster = [
    { id: "self", name: "Aditya" },
    { id: "isha", name: "Isha" },
    { id: "ma", name: "Ma" },
  ];

  it("unknownNameMentions finds a mention-born name and its anchors", () => {
    const found = unknownNameMentions("Vivaan ke school ka annual day 5th Sept ko hai, sab aana", roster);
    expect(found.map((f) => f.name)).toEqual(["Vivaan"]);
    expect(found[0]!.hints.join(" ")).toMatch(/child\/school/);
    expect(unknownNameMentions("Isha ke school ka annual day", roster)).toEqual([]);
  });

  it("mints one provisional person and appends anchors on a second mention", () => {
    const first = mintProvisionalPerson({
      name: "Vivaan",
      mentionedBy: "isha",
      streamKey: "family@g.us",
      phrases: ["Vivaan ke school ka annual day 5th Sept ko hai"],
      eventIds: ["e1"],
      relationshipHint: { relation: "child_of", of: "isha", confidence: 0.6 },
    });
    expect(first.created).toBe(true);
    expect(first.entity.provisional).toBe(true);

    const second = mintProvisionalPerson({ name: "Vivaan", mentionedBy: "ma", streamKey: "family@g.us", phrases: ["he's performing!!"] });
    expect(second.created).toBe(false);
    expect(second.entity.id).toBe(first.entity.id);
    const anchors = anchorsOf(first.entity.id);
    expect(anchors).toHaveLength(2);
    expect(JSON.stringify(anchors)).toContain("family@g.us");

    // The relationship hint stays a hint: it is a decision reason, never a claim.
    const reason = (getDb().prepare(`SELECT reason FROM decisions WHERE target_id = ? AND action = 'create'`).get(first.entity.id) as { reason: string }).reason;
    expect(reason).toContain("likely child of isha (0.6)");
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM claims WHERE subject_id = ?`).get(first.entity.id)).toEqual({ n: 0 });
  });

  it("CRM-03: an identifier merges the name-only person forward, exactly once", () => {
    const provisional = mintProvisionalPerson({ name: "Vivaan", mentionedBy: "isha", streamKey: "family@g.us", phrases: ["Vivaan ke school"] }).entity;
    const identified = createEntity({ type: "person", canonical: "Vivaan", provisional: true });
    putIdentity({ entityId: identified.id, sourceId: "src_wa", kind: "phone", value: "+919812345678", decidedBy: "code:ingest" });

    expect(candidatesForName("Vivaan", { provisionalOnly: true }).map((c) => c.id)).toContain(provisional.id);
    const result = mergeForwardOnIdentifier({ identifiedEntityId: identified.id, name: "Vivaan", kind: "phone", value: "+919812345678" });
    expect(result.outcome).toBe("merged");
    expect(resolveEntityId(provisional.id)).toBe(identified.id);
    expect(mergedAliasIds(identified.id)).toContain(provisional.id);
    // A second identifier for the same person finds nothing left to merge.
    expect(mergeForwardOnIdentifier({ identifiedEntityId: identified.id, name: "Vivaan", kind: "phone", value: "+919812345678" }).outcome).toBe("none");
  });

  it("two same-name candidates queue a question instead of merging", () => {
    const a = createEntity({ type: "person", canonical: "Vivaan", provisional: true });
    const b = createEntity({ type: "person", canonical: "Vivaan", provisional: true });
    const identified = createEntity({ type: "person", canonical: "Vivaan", provisional: true });
    putIdentity({ entityId: identified.id, sourceId: "src_wa", kind: "phone", value: "+919800000000", decidedBy: "code:ingest" });
    const r = mergeForwardOnIdentifier({ identifiedEntityId: identified.id, name: "Vivaan", kind: "phone", value: "+919800000000" });
    expect(r.outcome).toBe("queued");
    expect(new Set(r.candidates)).toEqual(new Set([a.id, b.id]));
    expect(resolveEntityId(a.id)).toBe(a.id);
    const q = getDb().prepare(`SELECT kind, status FROM questions WHERE id = ?`).get(r.questionId!) as { kind: string; status: string };
    expect(q).toMatchObject({ kind: "identity", status: "open" });
  });
});

// ---- merge and split by drag ----------------------------------------------

describe("merge and split by drag, with undo", () => {
  function pair(): { a: string; b: string } {
    const a = createEntity({ type: "person", canonical: "Rahul Mehta" });
    const b = createEntity({ type: "person", canonical: "Rahul M" });
    return { a: a.id, b: b.id };
  }

  it("a drag merges, and the undo splits back", () => {
    const { a, b } = pair();
    const merged = mergeByDrag({ loser: b, winner: a });
    expect(merged.ok).toBe(true);
    expect(resolveEntityId(b)).toBe(a);
    expect(aliasChips(a).map((c) => c.id)).toEqual([b]);
    expect(merged.undoId).toBeTruthy();

    const undone = undoDrag(merged.undoId!);
    expect(undone.ok).toBe(true);
    expect(undone.action).toBe("split");
    expect(resolveEntityId(b)).toBe(b);
    expect(aliasChips(a)).toEqual([]);
  });

  it("a drag splits an alias out, and the undo merges it back through the negative pair", () => {
    const { a, b } = pair();
    mergeByDrag({ loser: b, winner: a });
    const split = splitByDrag({ entityId: b });
    expect(split.ok).toBe(true);
    expect(resolveEntityId(b)).toBe(b);
    // The split is a permanent "different" — automation may not re-propose it.
    expect(isNegativePair(a, b)).toBe(true);

    const undone = undoDrag(split.undoId!);
    expect(undone.ok).toBe(true);
    expect(undone.action).toBe("merge");
    expect(resolveEntityId(b)).toBe(a);
    expect(readDecision(a, b)).toMatchObject({ verdict: "same", decidedBy: "user" });
  });

  it("undo is idempotent by state, never by a flag", () => {
    const { a, b } = pair();
    const merged = mergeByDrag({ loser: b, winner: a });
    expect(undoDrag(merged.undoId!).ok).toBe(true);
    const second = undoDrag(merged.undoId!);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_applied");
  });

  it("a merge through a user's 'different' verdict is refused, with the rule named", () => {
    const { a, b } = pair();
    markDifferent(a, b);
    const merged = mergeByDrag({ loser: b, winner: a });
    expect(merged.ok).toBe(false);
    expect(merged.refused).toBe("negative_pair");
    expect(merged.summary).toContain("different people");
    expect(resolveEntityId(b)).toBe(b);
  });

  it("nonsense gestures are refused, not applied", () => {
    const { a } = pair();
    expect(mergeByDrag({ loser: a, winner: a }).refused).toBe("same_entity");
    expect(mergeByDrag({ loser: "ent_nope", winner: a }).refused).toBe("missing");
    expect(splitByDrag({ entityId: a }).refused).toBe("not_merged");
    expect(undoDrag("mut_nope").reason).toBe("unknown_mutation");
  });
});

// ---- the follow-up radar ---------------------------------------------------

describe("the follow-up radar — CRM-01 / CRM-02", () => {
  it("CRM-01: Sameer asked on Tuesday, coworker lead 3 days → the twin starts Friday", () => {
    const sid = stream("str_sameer", "sameer@s.whatsapp.net", "Sameer", "dm");
    const sameer = createEntity({ type: "person", canonical: "Sameer" });
    setCircle(sameer.id, "coworkers", { decidedBy: "code:circles" });
    event({ id: "e1", streamId: sid, streamKey: "sameer@s.whatsapp.net", ts: "2026-09-01T05:00:00.000Z", text: "hey, done with the deck?", actor: "contact:sameer", actorEntityId: sameer.id });

    const radar = computeRadar(NOW);
    expect(radar).toHaveLength(1);
    const entry = radar[0]!;
    expect(entry.direction).toBe("i_owe");
    expect(entry.personId).toBe(sameer.id);
    expect(entry.circle).toBe("coworkers");
    expect(entry.leadDays).toBe(3);
    expect(entry.followUpAt.slice(0, 10)).toBe("2026-09-04");
    expect(entry.overdue).toBe(true);
  });

  it("the direction flips when the user asked last", () => {
    const sid = stream("str_rohan", "rohan@s.whatsapp.net", "Rohan", "dm");
    const rohan = createEntity({ type: "person", canonical: "Rohan" });
    event({ id: "e1", streamId: sid, streamKey: "rohan@s.whatsapp.net", ts: "2026-09-02T05:00:00.000Z", text: "hi", actor: "contact:rohan", actorEntityId: rohan.id });
    event({ id: "e2", streamId: sid, streamKey: "rohan@s.whatsapp.net", ts: "2026-09-03T05:00:00.000Z", text: "did you transfer the advance?", actor: "self" });
    const radar = computeRadar(NOW);
    expect(radar[0]).toMatchObject({ direction: "they_owe", personId: rohan.id });
  });

  it("CRM-02: a 180-member group the user never replied in has no radar", () => {
    const sid = stream("str_soc", "sunrise-402@g.us", "Sunrise Apartments 402");
    event({
      id: "e1",
      streamId: sid,
      streamKey: "sunrise-402@g.us",
      ts: "2026-09-01T05:00:00.000Z",
      text: "can everyone keep buckets filled sunday?",
      actor: "contact:secretary",
      roles: { audience: Array.from({ length: 180 }, (_, i) => `m${i}`) },
    });
    expect(computeRadar(NOW)).toEqual([]);
  });

  it("a settled exchange is no debt, and eval rows never enter the radar", () => {
    const sid = stream("str_x", "x@s.whatsapp.net", "X", "dm");
    const x = createEntity({ type: "person", canonical: "X" });
    event({ id: "e1", streamId: sid, streamKey: "x@s.whatsapp.net", ts: "2026-09-01T05:00:00.000Z", text: "did you send it?", actor: "contact:x", actorEntityId: x.id });
    event({ id: "e2", streamId: sid, streamKey: "x@s.whatsapp.net", ts: "2026-09-01T06:00:00.000Z", text: "yes done", actor: "self" });
    expect(computeRadar(NOW)).toEqual([]);

    const eid = stream("str_ev", "eval@s.whatsapp.net", "Eval", "dm");
    event({ id: "e3", streamId: eid, streamKey: "eval@s.whatsapp.net", ts: "2026-09-01T05:00:00.000Z", text: "any update?", actor: "contact:z", origin: "eval" });
    expect(computeRadar(NOW)).toEqual([]);
  });

  it("looksLikeAsk separates a question from an acknowledgement", () => {
    expect(looksLikeAsk("any update?")).toBe(true);
    expect(looksLikeAsk("kab aa rahe ho")).toBe(true);
    expect(looksLikeAsk("ok done")).toBe(false);
    expect(looksLikeAsk("")).toBe(false);
  });

  it("a learned per-person lead time beats the circle default", () => {
    const p = createEntity({ type: "person", canonical: "Sameer" });
    setCircle(p.id, "coworkers", { decidedBy: "code:circles" });
    expect(leadDaysFor(p.id, "coworkers")).toEqual({ days: 3, source: "coworkers circle default" });
    setRadarLead(p.id, 1, "user set it on the card");
    expect(leadDaysFor(p.id, "coworkers")).toMatchObject({ days: 1 });
    expect(leadDaysFor(null, null)).toMatchObject({ days: 5 });
  });
});

// ---- the person card -------------------------------------------------------

describe("the person card", () => {
  it("reads circle, loops, radar, tone and how I know them at request time", () => {
    const sid = stream("str_sameer", "sameer@s.whatsapp.net", "Sameer", "dm");
    const sameer = createEntity({ type: "person", canonical: "Sameer" });
    putIdentity({ entityId: sameer.id, sourceId: "src_wa", kind: "phone", value: "+919811111111", decidedBy: "code:ingest" });
    setCircle(sameer.id, "coworkers", { decidedBy: "code:circles", reason: "work vocabulary" });
    writeClaimVersion({
      claimKey: `person.${sameer.id}.relationship`,
      kind: "relationship",
      subjectId: sameer.id,
      text: "manager at Falcon",
      confidence: 0.9,
      statedAt: "2026-08-01T00:00:00.000Z",
      evidence: [{ quote: "my manager Sameer", event_ids: [] }],
      decidedBy: "llm:extract",
    });
    event({ id: "e1", streamId: sid, streamKey: "sameer@s.whatsapp.net", ts: "2026-09-01T05:00:00.000Z", text: "hey, done with the deck?", actor: "contact:sameer", actorEntityId: sameer.id });
    getDb()
      .prepare(`INSERT INTO tasks (id, title, type, owner, owner_entity_id, status, created_by) VALUES ('t1', 'send the deck', 'explicit', 'self', ?, 'open', 'llm:decide')`)
      .run(sameer.id);

    const card = buildPersonCard(sameer.id, NOW)!;
    expect(card.name).toBe("Sameer");
    expect(card.circle).toBe("coworkers");
    expect(card.circleDecidedBy).toBe("code:circles");
    expect(card.identities.map((i) => i.kind)).toContain("phone");
    expect(card.relationships[0]!.text).toBe("manager at Falcon");
    expect(card.lastContext).toMatchObject({ text: "hey, done with the deck?", byThem: true });
    expect(card.openLoops.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(card.radar).toHaveLength(1);
    expect(card.radarLeadDays.days).toBe(3);
    expect(card.business).toBeNull();
    expect(card.dates).toEqual([]);
  });

  it("a provisional person's card shows its anchors and no identifiers", () => {
    const p = mintProvisionalPerson({ name: "Vivaan", mentionedBy: "isha", streamKey: "family@g.us", phrases: ["Vivaan ke school ka annual day"] }).entity;
    const card = buildPersonCard(p.id, NOW)!;
    expect(card.provisional).toBe(true);
    expect(card.identities.every((i) => i.kind === "alias")).toBe(true);
    expect(JSON.stringify(card.howIKnow)).toContain("family@g.us");
  });

  it("dates carry plan-or-wish: the circle decides, a per-date value overrides", () => {
    expect(effectiveDateMode("family", { mode: null, lead_days: null })).toMatchObject({ mode: "plan", leadDays: 14 });
    expect(effectiveDateMode("friends", { mode: null, lead_days: null })).toMatchObject({ mode: "wish", leadDays: 0 });
    expect(effectiveDateMode(null, { mode: null, lead_days: null })).toMatchObject({ mode: "wish", source: "default (no circle)" });
    expect(effectiveDateMode("friends", { mode: "plan", lead_days: 10 })).toMatchObject({ mode: "plan", leadDays: 10, source: "set for this date" });
    expect(nextOccurrence(9, 20, null, NOW)).toBe("2026-09-20");
    expect(nextOccurrence(1, 4, null, NOW)).toBe("2027-01-04");
    expect(nextOccurrence(3, 2, 2026, NOW)).toBe("2026-03-02");
  });

  it("a merged person's card is served under the survivor", () => {
    const a = createEntity({ type: "person", canonical: "Rahul Mehta" });
    const b = createEntity({ type: "person", canonical: "Rahul M" });
    mergeByDrag({ loser: b.id, winner: a.id });
    const card = buildPersonCard(b.id, NOW)!;
    expect(card.id).toBe(a.id);
    expect(card.mergedAliases).toEqual([b.id]);
    expect(buildPersonCard("ent_nope", NOW)).toBeNull();
  });
});

// ---- who I am --------------------------------------------------------------

describe("the Who I am card", () => {
  it("is empty until processing lands something — there is no form", () => {
    const card = buildWhoIAm();
    expect(card.empty).toBe(true);
    expect(card.filledBy).toBe("processing");
    expect(card.emptyNote).toContain("no form");
  });

  it("sorts processing's claims into basics, life, narrative and traits, and lists people by circle", () => {
    const claims: [string, "fact" | "preference" | "narrative", string][] = [
      ["self.home", "fact", "lives in Bengaluru"],
      ["self.job", "fact", "works as an engineer at Falcon"],
      ["self.coffee", "preference", "drinks filter coffee, never instant"],
      ["self.story", "narrative", "spent August planning a Goa trip"],
    ];
    for (const [key, kind, text] of claims) {
      writeClaimVersion({
        claimKey: key,
        kind,
        subjectId: SELF_ENTITY_ID,
        text,
        confidence: 0.8,
        statedAt: "2026-08-20T00:00:00.000Z",
        evidence: [{ quote: text, event_ids: ["e1"] }],
        decidedBy: "llm:extract",
      });
    }
    const ma = createEntity({ type: "person", canonical: "Ma" });
    setCircle(ma.id, "family", { decidedBy: "code:circles" });

    const card = buildWhoIAm();
    expect(card.empty).toBe(false);
    expect(card.basics.map((l) => l.text)).toContain("lives in Bengaluru");
    expect(card.life.map((l) => l.text)).toContain("works as an engineer at Falcon");
    expect(card.traits.map((l) => l.text)).toContain("drinks filter coffee, never instant");
    expect(card.narrative.map((l) => l.text)).toEqual(["spent August planning a Goa trip"]);
    expect(card.people.family.map((p) => p.name)).toEqual(["Ma"]);
    expect(card.life.some((l) => l.source === "circles" && l.text.startsWith("family:"))).toBe(true);
    // Every claim line points at the claim a correction would edit.
    expect(card.basics.every((l) => l.claimKey !== null && l.editable)).toBe(true);
    expect(card.counts).toMatchObject({ claims: 4, people: 1 });
  });
});
