// ===========================================================================
// [CODE] The Contacts adapter (build item 5.2) — fixture-driven, model-free.
//
// Two halves, both deliberately small:
//
//   1. `ContactsAdapter` — a `SourceAdapter` fed by vCard-like fixtures
//      instead of a daemon. It emits the address book as one stream, the
//      owner as its one actor, and one `contact` event per card. Nothing
//      here knows what a phone number means.
//
//   2. `ingestContactCards` — the graph walk. A card is a source-asserted
//      fact sheet: THIS name goes with THESE phones and emails. The walk
//      binds the card's UID as a source-scoped `account_id`, then runs each
//      phone/email through the EXISTING resolution machinery
//      (worker/src/entities/) — rung ① exact, rung ② cross-source on
//      normalised phone/email only. When a card identity lands on an entity
//      another source already minted (a WhatsApp jid's derived phone), the
//      card's entity MERGES into it at [CODE]: `mergeEntities` writes the
//      tombstone and the `resolution_decisions` row, confidence 1.0, zero
//      model calls. No similarity, no agent, no queue is ever consulted here.
//
// THE SHARED-NUMBER GUARD. Two contact cards that share a landline are a
// household, not one person. Before a cross-card merge, the walk checks
// whether the entity on the other side already carries a DIFFERENT contacts
// card (`account_id`); if it does, the number is shared and NOTHING merges —
// precision beats recall at [CODE], always. The same guard is what keeps a
// duplicate-card import from chaining two people together.
// ===========================================================================

import { readFileSync } from "node:fs";

import { setSelfIdentity } from "../../db/ingest.js";
import { bindIdentity, bindSelfIdentity } from "../../entities/binding.js";
import {
  findCrossSource,
  findIdentity,
  identitiesOf,
  normaliseEmail,
  normaliseIdentityValue,
  putIdentity,
  type IdentityKind,
} from "../../entities/identities.js";
import { mergeEntities } from "../../entities/merge.js";
import { resolveEntityId } from "../../entities/registry.js";
import type { SourceAdapter } from "../source-adapter.js";
import { rangeCutoffMs } from "../source-adapter.js";
import type {
  Actor,
  AdapterStatus,
  Range,
  SourceEvent,
  StatusUpdate,
  Stream,
} from "../types.js";
import { CONTACTS_SOURCE_ID, CONTACTS_STREAM_EXT_ID, selfEmail } from "./manifest.js";
import { parseVcards, type ContactCard } from "./vcard.js";

/** The one actor an address book has: its owner. */
export const OWNER_EXT_ID = "owner";

// ---------------------------------------------------------------------------
// Half 1 — the fixture-driven SourceAdapter
// ---------------------------------------------------------------------------

export interface ContactsAdapterOptions {
  /** Path to a vCard-like fixture file. Exactly one of path/text is required. */
  fixturePath?: string;
  /** Inline fixture text (tests). */
  vcardText?: string;
  /** `ts` for cards without a REV. Defaults to construction time. */
  now?: string;
}

function cardText(card: ContactCard): string {
  const lines = [card.fn];
  for (const p of card.phones) lines.push(`tel: ${p}`);
  for (const e of card.emails) lines.push(`email: ${e}`);
  return lines.filter((l) => l !== "").join("\n");
}

/** One card → one source-neutral `contact` event. */
export function cardToEvent(card: ContactCard, fallbackTs: string): SourceEvent {
  return {
    external_id: `${CONTACTS_STREAM_EXT_ID}/${card.uid}`,
    stream_ext_id: CONTACTS_STREAM_EXT_ID,
    actor_ext_id: OWNER_EXT_ID,
    ts: card.rev ?? fallbackTs,
    kind: "contact",
    text: cardText(card),
    from_me: true,
    is_historical: true,
    raw: { vcard: card.raw },
  };
}

export class ContactsAdapter implements SourceAdapter {
  readonly sourceId = CONTACTS_SOURCE_ID;
  readonly sourceType = CONTACTS_SOURCE_ID;

  private readonly cards: ContactCard[];
  private readonly now: string;
  private paused = false;
  private connected = false;
  private importDone = false;
  private importRange: Range | undefined;
  private eventCbs: ((e: SourceEvent) => void)[] = [];
  private streamCbs: ((s: Stream) => void)[] = [];
  private actorCbs: ((a: Actor) => void)[] = [];
  private statusCbs: ((s: StatusUpdate) => void)[] = [];

  constructor(opts: ContactsAdapterOptions) {
    const text =
      opts.vcardText ?? (opts.fixturePath !== undefined ? readFileSync(opts.fixturePath, "utf8") : null);
    if (text === null) {
      throw new Error("ContactsAdapter: one of fixturePath or vcardText is required");
    }
    this.cards = parseVcards(text);
    this.now = opts.now ?? new Date().toISOString();
  }

  /** The parsed fixture, for the ingest walk and tests. */
  allCards(): readonly ContactCard[] {
    return this.cards;
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.emitStatus({ type: "status", state: "online" });
  }

  /** A fixture needs no pairing; it is online the moment it is read. */
  async startPairing(): Promise<void> {
    await this.connect();
  }

  async backfill(range: Range): Promise<void> {
    if (!this.connected) await this.connect();
    this.importRange = range;
    const cutoff = rangeCutoffMs(range, Date.parse(this.now));
    for (const s of this.streamCbs) {
      s({ source_ext_id: CONTACTS_STREAM_EXT_ID, name: "Address Book", kind: "addressbook", is_business: false });
    }
    for (const a of this.actorCbs) {
      a({ source_ext_id: OWNER_EXT_ID, display_name: "Me", is_self: true });
    }
    let emitted = 0;
    for (const card of this.cards) {
      if (this.paused) break;
      // A card with no REV has no age; it is always in range.
      if (card.rev !== null && Date.parse(card.rev) < cutoff) continue;
      const ev = cardToEvent(card, this.now);
      for (const cb of this.eventCbs) cb(ev);
      emitted += 1;
    }
    this.importDone = true;
    this.emitStatus({ type: "backfill_complete", range, chats: 1, messages: emitted });
  }

  /** Widening backwards is just a re-run: card events dedupe on external_id. */
  async extend(range: Range): Promise<void> {
    await this.backfill(range);
  }

  async pause(paused: boolean): Promise<void> {
    this.paused = paused;
  }

  async logout(): Promise<void> {
    this.connected = false;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  onEvent(cb: (e: SourceEvent) => void): void {
    this.eventCbs.push(cb);
  }
  onStream(cb: (s: Stream) => void): void {
    this.streamCbs.push(cb);
  }
  onActor(cb: (a: Actor) => void): void {
    this.actorCbs.push(cb);
  }
  onStatus(cb: (s: StatusUpdate) => void): void {
    this.statusCbs.push(cb);
  }

  getStatus(): AdapterStatus {
    return {
      state: this.connected ? "online" : "starting",
      paired: true,
      paused: this.paused,
      importDone: this.importDone,
      ...(this.importRange !== undefined ? { importRange: this.importRange } : {}),
    };
  }

  private emitStatus(s: StatusUpdate): void {
    for (const cb of this.statusCbs) cb(s);
  }
}

// ---------------------------------------------------------------------------
// Half 2 — the [CODE] graph walk
// ---------------------------------------------------------------------------

export interface CardMerge {
  cardUid: string;
  /** The identity that drove the merge. */
  kind: IdentityKind;
  valueNorm: string;
  winner: string;
  loser: string;
}

export interface CardConflict {
  cardUid: string;
  kind: IdentityKind;
  valueNorm: string;
  /** Why nothing merged: shared number, ambiguous owners, or a stored `different`. */
  reason: "other_card_owns" | "ambiguous_owners" | "merge_refused";
}

export interface ContactsIngestReport {
  cards: number;
  /** Cross-entity merges performed, each backed by a `resolution_decisions` row. */
  merges: CardMerge[];
  /** Identities that resolved onto an existing entity without needing a merge. */
  joins: number;
  /** Identities filed fresh onto the card's own entity. */
  filed: number;
  conflicts: CardConflict[];
  /** Always 0. That is the point of this path — and of Phase 5. */
  modelCalls: 0;
}

/** The entity that currently owns `(kind, value)` — rung ① then rung ②. */
function ownerOf(kind: IdentityKind, value: string): { entityId: string | null; ambiguous: boolean } {
  const exact = findIdentity(CONTACTS_SOURCE_ID, kind, value);
  if (exact) return { entityId: resolveEntityId(exact.entityId), ambiguous: false };
  // Rung ② — `findCrossSource` returns [] for every kind but phone/email,
  // so a handle-shaped value could never sneak across a source here.
  const owners = new Set(
    findCrossSource(kind, value)
      .map((h) => resolveEntityId(h.entityId))
      .filter((v): v is string => v !== null),
  );
  if (owners.size > 1) return { entityId: null, ambiguous: true };
  return { entityId: owners.size === 1 ? [...owners][0] : null, ambiguous: false };
}

/** Does `entityId` already carry a DIFFERENT contacts card? Then the number is shared. */
function otherCardOwns(entityId: string, cardUid: string): boolean {
  const uidNorm = normaliseIdentityValue("account_id", cardUid);
  return identitiesOf(entityId).some(
    (r) => r.sourceId === CONTACTS_SOURCE_ID && r.kind === "account_id" && r.valueNorm !== uidNorm,
  );
}

/** `true` when this card is the owner's own (its email is the manifest self). */
function isSelfCard(card: ContactCard): boolean {
  const self = selfEmail();
  if (self === null) return false;
  return card.emails.some((e) => normaliseEmail(e) === normaliseEmail(self));
}

/**
 * Ingest one card into the entity graph. Every decision in here is exact:
 * rung ① and rung ② of the ladder, plus the card's own assertion that its
 * identities belong to one person. `decided_by` on the merge is
 * `code:cross_source`, and `mergeEntities` writes the `resolution_decisions`
 * verdict — the row the acceptance test reads back.
 */
export function ingestContactCard(card: ContactCard, report: ContactsIngestReport): void {
  const seenAt = card.rev;

  if (isSelfCard(card)) {
    // The owner's own card: every identity funnels into the canonical `me`.
    bindSelfIdentity({ sourceId: CONTACTS_SOURCE_ID, kind: "account_id", value: card.uid });
    for (const p of card.phones) {
      if (normaliseIdentityValue("phone", p) === "") continue;
      bindSelfIdentity({ sourceId: CONTACTS_SOURCE_ID, kind: "phone", value: p });
    }
    for (const e of card.emails) {
      bindSelfIdentity({ sourceId: CONTACTS_SOURCE_ID, kind: "email", value: e });
    }
    return;
  }

  // The card itself: a source-scoped account_id. Exact on re-import, minted
  // provisional on first sight — a new card is a new person until an exact
  // phone/email says otherwise.
  const cardBind = bindIdentity({
    sourceId: CONTACTS_SOURCE_ID,
    kind: "account_id",
    value: card.uid,
    type: "person",
    displayName: card.fn === "" ? null : card.fn,
    seenAt,
  });
  let entity = cardBind.entityId;

  const identities: { kind: IdentityKind; value: string }[] = [
    ...card.phones.map((value) => ({ kind: "phone" as const, value })),
    ...card.emails.map((value) => ({ kind: "email" as const, value })),
  ];

  for (const { kind, value } of identities) {
    const valueNorm = normaliseIdentityValue(kind, value);
    if (valueNorm === "") continue;

    const owner = ownerOf(kind, value);
    if (owner.ambiguous) {
      // Two live entities already hold this value. That is a question for a
      // higher rung, not a coin flip for this one.
      report.conflicts.push({ cardUid: card.uid, kind, valueNorm, reason: "ambiguous_owners" });
      continue;
    }

    const here = resolveEntityId(entity)!;
    if (owner.entityId === null) {
      // Nobody owns this value yet. It belongs on the card's entity — filed
      // directly, NOT via `bindIdentity`, which would mint a stray entity for
      // a value the card already accounts for. `code:metadata` because a card
      // is source metadata: exact, confidence 1.0, no model.
      putIdentity({
        entityId: here,
        sourceId: CONTACTS_SOURCE_ID,
        kind,
        value,
        confidence: 1,
        decidedBy: "code:metadata",
        ...(seenAt !== null ? { decidedAt: seenAt } : {}),
      });
      report.filed += 1;
      continue;
    }
    if (owner.entityId === here) {
      // Already ours (a re-import, or an earlier identity of this card
      // merged us into the owner). File the contacts-scoped row; idempotent
      // on (source, kind, value_norm).
      putIdentity({
        entityId: here,
        sourceId: CONTACTS_SOURCE_ID,
        kind,
        value,
        confidence: 1,
        decidedBy: "code:metadata",
        ...(seenAt !== null ? { decidedAt: seenAt } : {}),
      });
      report.joins += 1;
      continue;
    }

    if (otherCardOwns(owner.entityId, card.uid)) {
      // A DIFFERENT card already claims this value: a shared landline or a
      // duplicate import. NOTHING merges — precision beats recall at [CODE].
      report.conflicts.push({ cardUid: card.uid, kind, valueNorm, reason: "other_card_owns" });
      continue;
    }

    // Rung ② fired: the card's normalised phone/email names an entity some
    // other source minted. Merge the card into it — tombstone, mutation and
    // `resolution_decisions` row, confidence 1.0, zero model calls.
    const merge = mergeEntities({
      loser: here,
      winner: owner.entityId,
      actor: "code:cross_source",
      reason: `contacts card ${card.uid}: ${kind} ${valueNorm} matches across sources`,
    });
    if (!merge.merged) {
      // A stored `different` (or a racing decision) refused it. Permanent
      // verdicts outrank this walk, exactly as they outrank every rung.
      report.conflicts.push({ cardUid: card.uid, kind, valueNorm, reason: "merge_refused" });
      continue;
    }
    report.merges.push({ cardUid: card.uid, kind, valueNorm, winner: merge.winner, loser: merge.loser });
    entity = merge.winner;
    // File the contacts-scoped identity row on the merged entity, so a
    // re-import hits rung ① instead of re-deriving the merge.
    putIdentity({
      entityId: merge.winner,
      sourceId: CONTACTS_SOURCE_ID,
      kind,
      value,
      confidence: 1,
      decidedBy: "code:cross_source",
      ...(seenAt !== null ? { decidedAt: seenAt } : {}),
    });
  }
}

/**
 * The whole import: every card, in fixture order. Order-independent by
 * construction — every decision is an exact lookup plus a guarded merge, so
 * ingesting contacts before WhatsApp lands on the same graph (the jid's
 * derived phone then joins INTO the card's entity via rung ② instead).
 */
export function ingestContactCards(cards: readonly ContactCard[]): ContactsIngestReport {
  const report: ContactsIngestReport = {
    cards: cards.length,
    merges: [],
    joins: 0,
    filed: 0,
    conflicts: [],
    modelCalls: 0,
  };
  for (const card of cards) ingestContactCard(card, report);
  return report;
}

/** Persist how "me" appears in this source (the manifest's lazy getter reads it back). */
export function setContactsSelfEmail(email: string): void {
  setSelfIdentity(CONTACTS_SOURCE_ID, email);
}
