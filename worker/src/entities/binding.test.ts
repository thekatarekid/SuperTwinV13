// ===========================================================================
// Structural binding (build item 1.5, arch §10.3; evals G, H, I).
//
// The three cases the build doc names are the first three blocks: a
// cross-source phone join, a handle collision that must NOT bind, and the `me`
// entity that every source's self identity funnels into.
//
// After that: metadata edges (free, exact, zero model calls), mentions
// (unknown beats wrong), and the similarity rung, which is unavailable — not
// "defaulted" — while calibration is missing.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { putCalib } from "../db/calib.js";
import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import {
  bindCalendarAttendees,
  bindGroupParticipants,
  bindIdentity,
  bindRosterMention,
  bindSelfIdentity,
  ensureMeEntity,
  isPendingPlaceholder,
  isSelfEntity,
  meEntityId,
  mentionsOfEvent,
  recordAliasIdentity,
  recordMention,
  rosterCandidates,
  setEventActorEntity,
  similarityRungAvailable,
} from "./binding.js";
import { edgesFrom } from "./edges.js";
import { findIdentity, identitiesOf } from "./identities.js";
import { createEntity, getEntity, listEntities } from "./registry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-ent-bind-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function event(text: string): string {
  seq += 1;
  const streamId = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Ghar+", kind: "group" });
  const actorId = upsertActor({ sourceId: "whatsapp", sourceExtId: "a1", displayName: "a1" });
  return insertEvent({
    externalId: `c1/b${seq}`,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    streamId,
    actorId,
    ts: "2026-08-14T09:10:00+05:30",
    kind: "message",
    text,
    mediaPath: null,
    rawJson: null,
    isHistorical: true,
  }).id;
}

const PRANJALI_JID = "919800000001@s.whatsapp.net";

describe("rung ① — exact (source, kind, value)", () => {
  it("binds a known jid appearing in a new group, with no mint", () => {
    const first = bindIdentity({ sourceId: "whatsapp", kind: "jid", value: PRANJALI_JID, displayName: "Pranjali" });
    expect(first.rung).toBe("mint");

    const again = bindIdentity({ sourceId: "whatsapp", kind: "jid", value: "919800000001:14@S.WHATSAPP.NET" });
    expect(again.rung).toBe("exact");
    expect(again.entityId).toBe(first.entityId);
    expect(again.minted).toBe(false);
    expect(listEntities({ type: "person" })).toHaveLength(1);
  });

  it("records decided_by and confidence on every bind", () => {
    const bound = bindIdentity({ sourceId: "whatsapp", kind: "jid", value: PRANJALI_JID });
    expect(bound.decidedBy).toBe("code:mint");
    expect(bound.confidence).toBe(1);
    for (const row of identitiesOf(bound.entityId)) {
      expect(row.decidedBy).toBeTruthy();
      expect(row.confidence).toBe(1);
    }
  });
});

describe("rung ② — cross-source, phone and email only", () => {
  it("joins a Contacts phone to the same person as a WhatsApp jid", () => {
    const wa = bindIdentity({ sourceId: "whatsapp", kind: "jid", value: PRANJALI_JID, displayName: "Pranjali" });
    // The jid's phone was filed alongside it — that is what makes the join free.
    expect(wa.derived).toEqual(["phone"]);

    const contacts = bindIdentity({
      sourceId: "contacts",
      kind: "phone",
      value: "+91 98000 00001",
      displayName: "Pranjali Sachdeva",
    });
    expect(contacts.rung).toBe("cross_source");
    expect(contacts.decidedBy).toBe("code:cross_source");
    expect(contacts.confidence).toBe(1);
    expect(contacts.entityId).toBe(wa.entityId);
    expect(listEntities({ type: "person" })).toHaveLength(1);
  });

  it("joins a Gmail From to a calendar attendee on the same email", () => {
    const gmail = bindIdentity({ sourceId: "gmail", kind: "email", value: "Pranjali@X.com" });
    const cal = bindIdentity({ sourceId: "calendar", kind: "email", value: "pranjali@x.com" });
    expect(cal.rung).toBe("cross_source");
    expect(cal.entityId).toBe(gmail.entityId);
  });

  it("does NOT bind the same handle across two sources", () => {
    const slack = bindIdentity({ sourceId: "slack", kind: "handle", value: "@rahul" });
    const x = bindIdentity({ sourceId: "x", kind: "handle", value: "@rahul" });
    expect(x.rung).toBe("mint");
    expect(x.entityId).not.toBe(slack.entityId);
    expect(listEntities({ type: "person" })).toHaveLength(2);
  });

  it("does not bind when two entities already hold the same number", () => {
    const a = createEntity({ type: "person" });
    const b = createEntity({ type: "person" });
    for (const [entity, source] of [
      [a, "s1"],
      [b, "s2"],
    ] as const) {
      bindIdentity({ sourceId: source, kind: "phone", value: "+919800000009" });
      getDb()
        .prepare(`UPDATE entity_identities SET entity_id = ? WHERE source_id = ?`)
        .run(entity.id, source);
    }
    const third = bindIdentity({ sourceId: "s3", kind: "phone", value: "+919800000009" });
    // Ambiguous is a question for a higher rung, never a code merge.
    expect(third.rung).toBe("mint");
  });
});

describe("the `me` entity", () => {
  it("is a singleton every self identity funnels into", () => {
    const me = ensureMeEntity();
    expect(ensureMeEntity()).toBe(me);

    bindSelfIdentity({ sourceId: "whatsapp", kind: "jid", value: "919999900000@s.whatsapp.net" });
    bindSelfIdentity({ sourceId: "gmail", kind: "email", value: "me@x.com" });
    bindSelfIdentity({ sourceId: "device", kind: "device_id", value: "MAC-001" });
    bindSelfIdentity({ sourceId: "contacts", kind: "phone", value: "+919999900000" });

    expect(meEntityId()).toBe(me);
    expect(listEntities({ type: "person" }).map((e) => e.id)).toEqual([me]);
    expect(identitiesOf(me).length).toBeGreaterThanOrEqual(5);
    expect(getEntity(me)?.provisional).toBe(false);
  });

  it("absorbs an entity that was minted for `me` before the manifest was read", () => {
    const early = bindIdentity({ sourceId: "whatsapp", kind: "jid", value: "919999900000@s.whatsapp.net" });
    const me = bindSelfIdentity({ sourceId: "whatsapp", kind: "jid", value: "919999900000@s.whatsapp.net" });
    expect(me).not.toBe(early.entityId);
    expect(getEntity(early.entityId)?.id).toBe(me);
    expect(listEntities({ type: "person" })).toHaveLength(1);
  });

  it("derives events.is_self from the binding, not from the source", () => {
    const me = ensureMeEntity();
    const other = bindIdentity({ sourceId: "whatsapp", kind: "jid", value: PRANJALI_JID });
    const mine = event("i'll send you that villa link tonight");
    const theirs = event("i've started bhangra classes");
    setEventActorEntity(mine, me);
    setEventActorEntity(theirs, other.entityId);

    const rows = getDb()
      .prepare(`SELECT id, is_self FROM events WHERE id IN (?, ?)`)
      .all(mine, theirs) as { id: string; is_self: number }[];
    expect(rows.find((r) => r.id === mine)?.is_self).toBe(1);
    expect(rows.find((r) => r.id === theirs)?.is_self).toBe(0);
    expect(isSelfEntity(me)).toBe(true);
    expect(isSelfEntity(other.entityId)).toBe(false);
  });
});

describe("metadata edges are free and exact", () => {
  it("turns a group participant list into member edges with zero model calls", () => {
    const res = bindGroupParticipants({
      sourceId: "whatsapp",
      group: { kind: "jid", value: "120363001@g.us", displayName: "Ghar+", subtype: "family" },
      participants: [
        { kind: "jid", value: PRANJALI_JID, displayName: "Pranjali" },
        { kind: "jid", value: "919800000002@s.whatsapp.net", displayName: "Rahul" },
      ],
      seenAt: "2026-08-14T00:00:00Z",
    });
    expect(res.modelCalls).toBe(0);
    expect(res.edges).toHaveLength(2);
    for (const edge of res.edges) {
      expect(edge.kind).toBe("affiliated_with");
      expect(edge.subtype).toBe("member");
      expect(edge.confidence).toBe(1);
      expect(edge.decidedBy).toBe("code:metadata");
      expect(edge.dstEntityId).toBe(res.containerEntityId);
    }
    expect(getEntity(res.containerEntityId)?.type).toBe("group");
  });

  it("turns calendar attendees into participates_in edges", () => {
    const res = bindCalendarAttendees({
      sourceId: "calendar",
      occasion: { kind: "account_id", value: "evt-9001", displayName: "Gargi's 40th", subtype: "party" },
      attendees: [
        { kind: "email", value: "gargi@x.com", displayName: "Gargi" },
        { kind: "email", value: "mansi@x.com", displayName: "Mansi", role: "organizer" },
      ],
    });
    expect(res.modelCalls).toBe(0);
    const kinds = res.edges.map((e) => `${e.kind}:${e.subtype}`);
    expect(kinds).toEqual(["participates_in:attendee", "participates_in:organizer"]);
    expect(getEntity(res.containerEntityId)?.type).toBe("occasion");
  });

  it("is idempotent — a re-import does not duplicate the graph", () => {
    const args = {
      sourceId: "whatsapp",
      group: { kind: "jid" as const, value: "120363001@g.us", displayName: "Ghar+" },
      participants: [{ kind: "jid" as const, value: PRANJALI_JID }],
    };
    const first = bindGroupParticipants(args);
    const second = bindGroupParticipants(args);
    expect(second.edges[0].id).toBe(first.edges[0].id);
    expect(edgesFrom(first.memberEntityIds[0], { kind: "affiliated_with" })).toHaveLength(1);
  });
});

describe("mentions — unknown beats wrong", () => {
  const roster = () => [
    { entityId: createEntity({ type: "person", canonical: "Pranjali" }).id, label: "Pranjali", aliases: ["Praj"] },
  ];

  it("binds a single exact roster hit above 0.9", () => {
    const r = roster();
    const ev = event("ask Pranjali about the Goa trip");
    const res = bindRosterMention({ eventId: ev, surface: "Pranjali", roster: r });
    expect(res.outcome).toBe("bound");
    expect(res.mention.entityId).toBe(r[0].entityId);
    expect(res.mention.confidence).toBeGreaterThanOrEqual(0.9);
    expect(res.mention.decidedBy).toBe("code:roster");
  });

  it("matches a known alias as the same roster entry", () => {
    const r = roster();
    expect(rosterCandidates(r, "praj").map((c) => c.entityId)).toEqual([r[0].entityId]);
  });

  it("files a hint and no entity when nothing matches", () => {
    const ev = event("the broker found a 2BHK near the metro");
    const res = bindRosterMention({ eventId: ev, surface: "the broker", roster: roster() });
    expect(res.outcome).toBe("unknown");
    expect(res.mention.entityId).toBeNull();
    expect(res.mention.entityHint).toBe("the broker");
  });

  it("asks rather than picks when two candidates are live", () => {
    const r = [
      { entityId: createEntity({ type: "person", canonical: "Amit (gym)" }).id, label: "Amit" },
      { entityId: createEntity({ type: "person", canonical: "Amit (office)" }).id, label: "Amit" },
    ];
    const ev = event("tell Amit we're running late");
    const res = bindRosterMention({ eventId: ev, surface: "Amit", roster: r });
    expect(res.outcome).toBe("ambiguous");
    expect(res.mention.entityId).toBeNull();
    expect(res.candidates).toHaveLength(2);
  });

  it("an alias is an identity row on the person, not a new entity", () => {
    const shaurya = createEntity({ type: "person", canonical: "Shaurya" });
    const ev = event("Babbu said he'll come by evening");
    const res = recordAliasIdentity({
      entityId: shaurya.id,
      sourceId: "whatsapp",
      alias: "Babbu",
      eventId: ev,
      quote: "Babbu said he'll come by evening",
    });
    expect(res.entityId).toBe(shaurya.id);
    expect(listEntities({ type: "person" })).toHaveLength(1);
    expect(findIdentity("whatsapp", "alias", "babbu")?.entityId).toBe(shaurya.id);
    const evidence = getDb()
      .prepare(`SELECT quote FROM evidence WHERE subject_kind = 'identity' AND subject_id = ?`)
      .all(res.identityId) as { quote: string }[];
    expect(evidence.map((e) => e.quote)).toEqual(["Babbu said he'll come by evening"]);
  });

  it("refuses an alias with no quote", () => {
    const e = createEntity({ type: "person" });
    const ev = event("hi");
    expect(() =>
      recordAliasIdentity({ entityId: e.id, sourceId: "whatsapp", alias: "Babbu", eventId: ev, quote: "  " }),
    ).toThrow(/no evidence, no alias/);
  });

  it("reads a pending placeholder as unknown, not as empty", () => {
    expect(isPendingPlaceholder("[voice note, transcription pending]")).toBe(true);
    expect(isPendingPlaceholder("[image, description pending]")).toBe(true);
    expect(isPendingPlaceholder("ok")).toBe(false);
    const ev = event("[voice note, transcription pending]");
    expect(mentionsOfEvent(ev)).toEqual([]);
  });

  it("keeps every mention it is given, hint and all", () => {
    const ev = event("Rahul's cousin is coming");
    recordMention({
      eventId: ev,
      surface: "Rahul's cousin",
      entityId: null,
      hint: "Rahul's cousin, unnamed",
      confidence: 0.5,
      decidedBy: "llm:p-ep1",
    });
    const rows = mentionsOfEvent(ev);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBeNull();
    expect(rows[0].entityHint).toBe("Rahul's cousin, unnamed");
  });
});

describe("the similarity rung", () => {
  it("is unavailable until the floor for that use case is measured", () => {
    expect(similarityRungAvailable("Xenova/multilingual-e5-small", "entity_name")).toBe(false);
    putCalib({
      model: "Xenova/multilingual-e5-small",
      useCase: "entity_name",
      floor: 0.8,
      measuredAt: "2026-08-14T00:00:00Z",
      nPairs: 1200,
    });
    expect(similarityRungAvailable("Xenova/multilingual-e5-small", "entity_name")).toBe(true);
    // Measured for one use case is not measured for another.
    expect(similarityRungAvailable("Xenova/multilingual-e5-small", "arc_topic")).toBe(false);
  });
});
