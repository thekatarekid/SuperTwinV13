// ===========================================================================
// Build item 5.2 acceptance — the Contacts adapter against the REAL entity
// graph and resolution ladder (worker/src/entities/) over a temp DB.
//
// The proof, in order:
//   1. Ingest WhatsApp fixture events (jids → entities, derived phones filed).
//   2. Ingest calendar attendee metadata (emails filed, zero model calls).
//   3. Ingest the vCard fixture corpus through the adapter.
//   4. Contact phones/emails MERGE with WhatsApp identities at [CODE]:
//      every merge has a `resolution_decisions` row with a `code:` decider.
//   5. Cross-source identity precision ≥ 0.98 over a corpus with deliberate
//      near-miss traps — similar names, a shared landline, a no-country-code
//      number, a group-jid lookalike — with ZERO model calls, proven
//      structurally (this module cannot import a provider) AND by decider.
//   6. Order independence: contacts-first lands on the same partition.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeDb, getDb } from "../../db/connection.js";
import { runMigrations } from "../../db/index.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../../db/ingest.js";
import {
  bindCalendarAttendees,
  bindGroupParticipants,
  bindSelfIdentity,
  ensureMeEntity,
  meEntityId,
} from "../../entities/binding.js";
import { findIdentity } from "../../entities/identities.js";
import { listDecisions } from "../../entities/merge.js";
import { resolveEntityId } from "../../entities/registry.js";
import { resolveIdentity } from "../../entities/resolve.js";
import type { SourceEvent } from "../types.js";
import {
  ContactsAdapter,
  ingestContactCards,
  setContactsSelfEmail,
  type ContactsIngestReport,
} from "./adapter.js";
import { CONTACTS_SOURCE_ID } from "./manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "addressbook.vcf");

// ---- the WhatsApp side of the corpus ---------------------------------------

const WA = "whatsapp";
const SELF_JID = "911111111111@s.whatsapp.net";

/** jid user → ground-truth person label. */
const WA_ACTORS: { jid: string; name: string; label: string }[] = [
  { jid: "919812345001@s.whatsapp.net", name: "Rahul Arora", label: "rahul_arora" },
  { jid: "919812345002@s.whatsapp.net", name: "Rahul Mehta", label: "rahul_mehta" },
  { jid: "919812345003@s.whatsapp.net", name: "Priya Sharma", label: "priya" },
  { jid: "919812345004@s.whatsapp.net", name: "Amit Sharma", label: "amit_sharma" },
  { jid: "919812345005@s.whatsapp.net", name: "Amit Verma", label: "amit_verma" },
  { jid: "919812345006@s.whatsapp.net", name: "Sneha Kulkarni", label: "sneha" },
  { jid: "919812345007@s.whatsapp.net", name: "Dad", label: "dad" },
  { jid: "919812345008@s.whatsapp.net", name: "Mom", label: "mom" },
  { jid: "919812345009@s.whatsapp.net", name: "Vikram Singh", label: "vikram" },
  { jid: "14155550100@s.whatsapp.net", name: "Jake Miller", label: "jake" },
  { jid: "919812345010@s.whatsapp.net", name: "Ananya Rao", label: "ananya" },
  { jid: "919812345011@s.whatsapp.net", name: "Karan Malhotra", label: "karan" },
  { jid: "919812345012@s.whatsapp.net", name: "Deepa Nair", label: "deepa" },
  { jid: "919812345013@s.whatsapp.net", name: "Arjun Iyer", label: "arjun" },
  { jid: "919812345014@s.whatsapp.net", name: "Neha Gupta", label: "neha" },
  { jid: "919812345015@s.whatsapp.net", name: "Rohan Das", label: "rohan" },
  { jid: "919812345016@s.whatsapp.net", name: "Ishaan Bhat", label: "ishaan" },
  { jid: "919812345017@s.whatsapp.net", name: "Tanvi Joshi", label: "tanvi" },
  { jid: "919812345018@s.whatsapp.net", name: "Sameer Khan", label: "sameer" },
  { jid: "919812345019@s.whatsapp.net", name: "Pooja Reddy", label: "pooja" },
  { jid: "919812345020@s.whatsapp.net", name: "Aditya Menon", label: "aditya" },
];

const GROUP_JID = "911234567890-160@g.us";

// ---- ground truth: normalised identity value → person -----------------------
// The shared landline is deliberately ABSENT — it belongs to a household, not
// a person, and labelling it either way would beg the question under test.

const TRUTH: Record<string, string> = {
  // me
  me: "me",
  [SELF_JID]: "me",
  "+911111111111": "me",
  "card-me": "me",
  "me@example.com": "me",
  // whatsapp jids + derived phones
  ...Object.fromEntries(WA_ACTORS.map((a) => [a.jid, a.label])),
  ...Object.fromEntries(WA_ACTORS.map((a) => [`+${a.jid.split("@")[0]}`, a.label])),
  // contact cards
  "card-rahul-arora": "rahul_arora",
  "rahul.arora@gmail.com": "rahul_arora",
  "card-rahul-mehta": "rahul_mehta",
  "card-priya": "priya",
  "priya.sharma@gmail.com": "priya",
  "card-amit-sharma": "amit_sharma",
  "card-amit-verma": "amit_verma",
  "card-sneha": "sneha",
  "sneha.k@outlook.com": "sneha",
  "card-dad": "dad",
  "card-mom": "mom",
  "card-vicky": "vikram",
  "card-jake": "jake",
  "jake@miller.io": "jake",
  "card-ananya": "ananya",
  "card-karan": "karan",
  "card-deepa": "deepa",
  "card-arjun": "arjun",
  "card-neha": "neha",
  "card-rohan": "rohan",
  "card-ishaan": "ishaan",
  "card-tanvi": "tanvi",
  "card-sameer": "sameer",
  "card-pooja": "pooja",
  "card-aditya": "aditya",
  // traps: distinct people/things that must NOT merge with the above
  "card-vikram-college": "vikram_college",
  "+919899000222": "vikram_college",
  "card-jake-work": "jake_work",
  "4155550100": "jake_work",
  "card-society": "society",
  "911234567890": "society",
  [GROUP_JID]: "family_group",
  "card-rohit": "rohit",
  "+919899000111": "rohit",
  "rohit@sharma.in": "rohit",
  "card-pizza": "pizza",
  "9812345001": "pizza",
  "rahularora@gmail.com": "rahul_calendar_alt",
  "evt-1": "occasion",
};

// ---- helpers ----------------------------------------------------------------

function ingestWhatsApp(): void {
  upsertSource({ id: WA, type: WA, name: "WhatsApp" });
  ensureMeEntity();
  bindSelfIdentity({ sourceId: WA, kind: "jid", value: SELF_JID });
  upsertActor({ sourceId: WA, sourceExtId: SELF_JID, displayName: "Me", isSelf: true });
  let n = 0;
  for (const a of WA_ACTORS) {
    const streamId = upsertStream({ sourceId: WA, sourceExtId: a.jid, name: a.name, kind: "dm" });
    const actorId = upsertActor({ sourceId: WA, sourceExtId: a.jid, displayName: a.name });
    resolveIdentity({ sourceId: WA, kind: "jid", value: a.jid, displayName: a.name, seenAt: "2025-01-05T10:00:00Z" });
    insertEvent({
      externalId: `${a.jid}/MSG${(n += 1)}`,
      sourceId: WA,
      sourceType: WA,
      streamId,
      actorId,
      ts: "2025-01-05T10:00:00Z",
      kind: "message",
      text: `hello from ${a.name}`,
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    });
  }
  // The family group: metadata edges, and a group entity that must never gain
  // a phone (its jid is `@g.us` — `phoneFromJid` refuses it).
  const dad = WA_ACTORS.find((a) => a.label === "dad")!;
  const mom = WA_ACTORS.find((a) => a.label === "mom")!;
  bindGroupParticipants({
    sourceId: WA,
    group: { kind: "jid", value: GROUP_JID, displayName: "Family" },
    participants: [
      { kind: "jid", value: dad.jid },
      { kind: "jid", value: mom.jid },
    ],
  });
}

/** Calendar attendee metadata — the emails a card can later join on. */
function ingestCalendar(): void {
  bindCalendarAttendees({
    sourceId: "calendar",
    occasion: { kind: "account_id", value: "evt-1", displayName: "Dinner" },
    attendees: [
      { kind: "email", value: "priya.sharma@gmail.com" },
      { kind: "email", value: "sneha.k@outlook.com" },
      { kind: "email", value: "jake@miller.io" },
      // The trap: the same human's OTHER address. Dot-different, so nothing
      // at [CODE] may fold it into rahul.arora@gmail.com.
      { kind: "email", value: "rahularora@gmail.com" },
    ],
    seenAt: "2025-01-06T19:00:00Z",
  });
}

async function ingestContacts(): Promise<{ report: ContactsIngestReport; eventsInserted: number }> {
  upsertSource({ id: CONTACTS_SOURCE_ID, type: CONTACTS_SOURCE_ID, name: "Contacts" });
  setContactsSelfEmail("me@example.com");
  const adapter = new ContactsAdapter({ fixturePath: FIXTURE, now: "2025-01-15T00:00:00Z" });
  const streamId = upsertStream({
    sourceId: CONTACTS_SOURCE_ID,
    sourceExtId: "addressbook",
    name: "Address Book",
    kind: "addressbook",
  });
  const actorId = upsertActor({
    sourceId: CONTACTS_SOURCE_ID,
    sourceExtId: "owner",
    displayName: "Me",
    isSelf: true,
  });
  let eventsInserted = 0;
  adapter.onEvent((ev: SourceEvent) => {
    const res = insertEvent({
      externalId: ev.external_id,
      sourceId: CONTACTS_SOURCE_ID,
      sourceType: CONTACTS_SOURCE_ID,
      streamId,
      actorId,
      ts: ev.ts,
      kind: ev.kind,
      text: ev.text,
      mediaPath: null,
      rawJson: JSON.stringify(ev.raw ?? null),
      isHistorical: true,
    });
    if (res.inserted) eventsInserted += 1;
  });
  await adapter.backfill("all");
  const report = ingestContactCards(adapter.allCards());
  return { report, eventsInserted };
}

/** Ground-truth labels of the identity rows filed DIRECTLY on one entity row. */
function labelsOfEntityRow(entityRowId: string): Set<string> {
  const rows = getDb()
    .prepare(`SELECT value_norm FROM entity_identities WHERE entity_id = ?`)
    .all(entityRowId) as { value_norm: string }[];
  const labels = new Set<string>();
  for (const r of rows) {
    const label = TRUTH[r.value_norm];
    if (label !== undefined) labels.add(label);
  }
  return labels;
}

/** Labels across an entity AND everything merged into it. */
function labelsOfLiveEntity(entityId: string): Set<string> {
  const ids = getDb()
    .prepare(`SELECT id FROM entities WHERE id = ? OR merged_into = ?`)
    .all(entityId, entityId) as { id: string }[];
  const labels = new Set<string>();
  for (const row of ids) for (const l of labelsOfEntityRow(row.id)) labels.add(l);
  return labels;
}

function entityOf(sourceId: string, kind: "jid" | "phone" | "email" | "account_id", value: string): string | null {
  const row = findIdentity(sourceId, kind, value);
  return row ? resolveEntityId(row.entityId) : null;
}

// ---- setup ------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-contacts-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- the acceptance ---------------------------------------------------------

describe("5.2 acceptance — contacts merge with WhatsApp at [CODE]", () => {
  it("merges every true pair, refuses every trap: precision ≥ 0.98, zero model calls", async () => {
    ingestWhatsApp();
    ingestCalendar();
    const { report, eventsInserted } = await ingestContacts();

    // Every fixture card became a real event row.
    expect(report.cards).toBe(27);
    expect(eventsInserted).toBe(27);
    expect(report.modelCalls).toBe(0);

    // -- The merges. 20 cards join WhatsApp people by phone; priya/sneha/jake
    // additionally join their calendar-attendee email entities.
    expect(report.merges.length).toBe(24);

    // Every code merge is backed by a resolution_decisions row whose decider
    // is code:. NOTHING in this corpus was decided by a model or an agent.
    const sameDecisions = listDecisions("same");
    const codeSame = sameDecisions.filter((d) => (d.decidedBy ?? "").startsWith("code:"));
    expect(codeSame.length).toBeGreaterThanOrEqual(report.merges.length);
    expect(sameDecisions.length).toBe(codeSame.length);
    expect(listDecisions("unsure")).toEqual([]);
    for (const d of sameDecisions) {
      expect(d.decidedBy).not.toMatch(/^(ml|agent|llm):/);
    }

    // The named row of the acceptance: Rahul Arora's card merged into his
    // WhatsApp entity by normalised phone, decided by code:cross_source.
    const rahulMerge = report.merges.find((m) => m.cardUid === "card-rahul-arora");
    expect(rahulMerge).toBeDefined();
    expect(rahulMerge!.kind).toBe("phone");
    expect(rahulMerge!.valueNorm).toBe("+919812345001");
    const rahulDecision = sameDecisions.find(
      (d) =>
        (d.leftId === rahulMerge!.loser && d.rightId === rahulMerge!.winner) ||
        (d.leftId === rahulMerge!.winner && d.rightId === rahulMerge!.loser),
    );
    expect(rahulDecision).toBeDefined();
    expect(rahulDecision!.decidedBy).toBe("code:cross_source");

    // -- Precision over the decisions themselves: each side of every merge,
    // labelled by the identity rows filed directly on it, names one person —
    // and both sides name the SAME person.
    let correct = 0;
    for (const d of codeSame) {
      const left = labelsOfEntityRow(d.leftId);
      const right = labelsOfEntityRow(d.rightId);
      expect(left.size).toBeLessThanOrEqual(1);
      expect(right.size).toBeLessThanOrEqual(1);
      const ok =
        left.size === 1 && right.size === 1 ? [...left][0] === [...right][0] : true;
      if (ok) correct += 1;
    }
    expect(codeSame.length).toBeGreaterThanOrEqual(20);
    expect(correct / codeSame.length).toBeGreaterThanOrEqual(0.98);

    // -- Graph purity: no live entity mixes two ground-truth people.
    const live = getDb()
      .prepare(`SELECT id FROM entities WHERE merged_into IS NULL`)
      .all() as { id: string }[];
    for (const e of live) {
      const labels = labelsOfLiveEntity(e.id);
      expect(labels.size, `entity ${e.id} mixes ${[...labels].join(", ")}`).toBeLessThanOrEqual(1);
    }

    // -- The joins the thesis names, explicitly.
    // Phone: card ↔ WhatsApp jid.
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-rahul-arora")).toBe(
      entityOf(WA, "jid", "919812345001@s.whatsapp.net"),
    );
    // Similar names bind to the RIGHT similar name.
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-rahul-mehta")).toBe(
      entityOf(WA, "jid", "919812345002@s.whatsapp.net"),
    );
    // Email: card ↔ calendar attendee, three-way with WhatsApp.
    const priya = entityOf(WA, "jid", "919812345003@s.whatsapp.net");
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-priya")).toBe(priya);
    expect(entityOf("calendar", "email", "priya.sharma@gmail.com")).toBe(priya);
    // Self: the owner's card funnels into the canonical me.
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-me")).toBe(meEntityId());

    // -- The traps, one by one.
    // Same display name, different number: two Vikrams stay two people.
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-vikram-college")).not.toBe(
      entityOf(WA, "jid", "919812345009@s.whatsapp.net"),
    );
    // Shared landline: Mom and Dad stay two people, and the second card
    // records a conflict instead of a merge.
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-mom")).not.toBe(
      entityOf(CONTACTS_SOURCE_ID, "account_id", "card-dad"),
    );
    expect(
      report.conflicts.some(
        (c) => c.cardUid === "card-mom" && c.valueNorm === "+911126543210" && c.reason === "other_card_owns",
      ),
    ).toBe(true);
    // No country code, no guess: "9812345001" is not "+919812345001".
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-pizza")).not.toBe(
      entityOf(WA, "jid", "919812345001@s.whatsapp.net"),
    );
    // Same for the US number written without +1.
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-jake-work")).not.toBe(
      entityOf(WA, "jid", "14155550100@s.whatsapp.net"),
    );
    // A group jid never has a phone, so the lookalike lands nowhere near it.
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-society")).not.toBe(entityOf(WA, "jid", GROUP_JID));
    // Dot-different email addresses stay different addresses.
    expect(entityOf("calendar", "email", "rahularora@gmail.com")).not.toBe(
      entityOf(WA, "jid", "919812345001@s.whatsapp.net"),
    );
    // Nobody-on-WhatsApp mints and stays provisional, alone.
    const rohit = entityOf(CONTACTS_SOURCE_ID, "account_id", "card-rohit");
    expect(labelsOfLiveEntity(rohit!)).toEqual(new Set(["rohit"]));
  });

  it("is order-independent: contacts before WhatsApp lands on the same partition", async () => {
    // Contacts first — cards mint; jids and calendar emails then join INTO the
    // card entities via rung ② instead of the other way around.
    await ingestContacts();
    ingestCalendar();
    ingestWhatsApp();

    const live = getDb()
      .prepare(`SELECT id FROM entities WHERE merged_into IS NULL`)
      .all() as { id: string }[];
    for (const e of live) {
      const labels = labelsOfLiveEntity(e.id);
      expect(labels.size, `entity ${e.id} mixes ${[...labels].join(", ")}`).toBeLessThanOrEqual(1);
    }

    // The same joins hold, whichever side arrived first.
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-rahul-arora")).toBe(
      entityOf(WA, "jid", "919812345001@s.whatsapp.net"),
    );
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-priya")).toBe(
      entityOf("calendar", "email", "priya.sharma@gmail.com"),
    );
    // And the traps still refuse.
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-mom")).not.toBe(
      entityOf(CONTACTS_SOURCE_ID, "account_id", "card-dad"),
    );
    expect(entityOf(CONTACTS_SOURCE_ID, "account_id", "card-vikram-college")).not.toBe(
      entityOf(WA, "jid", "919812345009@s.whatsapp.net"),
    );
  });
});

// ---- zero model calls, structurally -----------------------------------------

describe("the contacts adapter is [CODE] with zero model calls", () => {
  it("imports no provider, no prompt and no embedder — structurally", () => {
    for (const file of ["adapter.ts", "manifest.ts", "vcard.ts"]) {
      const source = readFileSync(join(HERE, file), "utf8");
      const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/\/providers\//);
        expect(spec, `${file} imports ${spec}`).not.toMatch(/\/prompts\//);
        expect(spec, `${file} imports ${spec}`).not.toMatch(/\/retrieval\//);
        expect(spec, `${file} imports ${spec}`).not.toMatch(/\/media\//);
      }
    }
  });
});

// ---- the adapter surface ----------------------------------------------------

describe("ContactsAdapter emission", () => {
  it("emits one stream, the owner, and one contact event per card in range", async () => {
    const adapter = new ContactsAdapter({ fixturePath: FIXTURE, now: "2025-01-15T00:00:00Z" });
    const events: SourceEvent[] = [];
    let streams = 0;
    let selfActor = false;
    adapter.onStream(() => (streams += 1));
    adapter.onActor((a) => {
      if (a.is_self) selfActor = true;
    });
    adapter.onEvent((e) => events.push(e));
    await adapter.backfill("7d");
    expect(streams).toBe(1);
    expect(selfActor).toBe(true);
    expect(events.length).toBe(27); // all revs are 2025-01-10, inside 7d of `now`
    expect(new Set(events.map((e) => e.external_id)).size).toBe(27);
    expect(events.every((e) => e.kind === "contact" && e.from_me && e.is_historical)).toBe(true);
    expect(adapter.getStatus().importDone).toBe(true);
  });

  it("filters by range off the card REV", async () => {
    const adapter = new ContactsAdapter({ fixturePath: FIXTURE, now: "2025-03-01T00:00:00Z" });
    const events: SourceEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    await adapter.backfill("24h"); // revs are 2025-01-10 — all out of range
    expect(events.length).toBe(0);
  });
});
