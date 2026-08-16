// ===========================================================================
// [CODE] Structural binding — rungs ① and ② of the resolution ladder, the `me`
// entity, metadata edges, and mention recording. Build item 1.5, arch §10.3.
//
// Everything in this file is EXACT. Not "high confidence", not "calibrated" —
// exact. A jid that has been seen before is the same person; a normalised phone
// that appears in two sources is one person. Neither needs a model, and neither
// may be second-guessed by one.
//
//   ① exact (source_id, kind, value_norm) ─────────────► BIND   conf 1.0
//   ② cross-source exact, PHONE or EMAIL only ─────────► BIND   conf 1.0
//     nothing matched ──────────────────────────────────► MINT provisional
//
// Rungs ③ (calibrated similarity), ④ (P-AG1) and ⑤ (ask the user) belong to
// item 1.10; `similarityRungAvailable` is the gate this file offers them, and
// it answers `false` whenever calibration is missing — a similarity threshold
// is measured or it is not used.
//
// METADATA EDGES ARE FREE. A group participant list and a calendar attendee
// list are relationship facts the source already told us. They are written at
// confidence 1.0 with ZERO model calls, BEFORE any model runs, so a bootstrap
// has a real graph within seconds.
//
// UNKNOWN BEATS WRONG. A mention with no roster candidate, or with two live
// ones, is filed with `entity_id NULL` and a hint. A hint is a name string and
// a name string is NEVER an id.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { readCalib, type CalibUseCase } from "../db/calib.js";
import { getDb } from "../db/connection.js";
import { writeEdge, METADATA_DECIDER, type EdgeRow } from "./edges.js";
import {
  findCrossSource,
  findIdentity,
  isCrossSourceKind,
  normaliseIdentityValue,
  phoneFromJid,
  putIdentity,
  type IdentityKind,
} from "./identities.js";
import { mergeEntities } from "./merge.js";
import {
  createEntity,
  resolveEntityId,
  touchEntity,
  type EntityType,
} from "./registry.js";

// ---- the `me` entity -------------------------------------------------------

/** The anchor identity of the singleton. `system` scopes it away from any source. */
const ME_SOURCE = "system";
const ME_KIND: IdentityKind = "alias";
const ME_VALUE = "me";

/**
 * Create (or find) the ONE canonical `me`. Called at install, and idempotent
 * afterwards — every caller that needs the id may call it.
 */
export function ensureMeEntity(): string {
  const existing = findIdentity(ME_SOURCE, ME_KIND, ME_VALUE);
  if (existing) return resolveEntityId(existing.entityId)!;
  const me = createEntity({ type: "person", canonical: "me", provisional: false, userPinned: true });
  putIdentity({
    entityId: me.id,
    sourceId: ME_SOURCE,
    kind: ME_KIND,
    value: ME_VALUE,
    confidence: 1,
    decidedBy: "code:install",
  });
  return me.id;
}

export function meEntityId(): string | null {
  const row = findIdentity(ME_SOURCE, ME_KIND, ME_VALUE);
  return row ? resolveEntityId(row.entityId) : null;
}

export function isSelfEntity(entityId: string): boolean {
  const me = meEntityId();
  return me !== null && resolveEntityId(entityId) === me;
}

export interface SelfIdentityParams {
  sourceId: string;
  kind: IdentityKind;
  value: string;
}

/**
 * Bind a manifest's `self_identity` into `me`. WhatsApp's self jid, the Gmail
 * account, the device id and the Contacts "me" card all land on the same row.
 *
 * If the value was already bound to some other entity — an import that met "me"
 * as just another sender before the manifest was read — that entity is MERGED
 * into `me` rather than left as a second self. The merge is a tombstone, so
 * nothing that already referenced it breaks.
 */
export function bindSelfIdentity(params: SelfIdentityParams): string {
  const me = ensureMeEntity();
  const existing = findIdentity(params.sourceId, params.kind, params.value);
  if (existing) {
    const owner = resolveEntityId(existing.entityId);
    if (owner && owner !== me) {
      mergeEntities({ loser: owner, winner: me, actor: "code:self", reason: "self identity" });
    }
    return me;
  }
  putIdentity({
    entityId: me,
    sourceId: params.sourceId,
    kind: params.kind,
    value: params.value,
    confidence: 1,
    decidedBy: "code:self",
  });
  if (params.kind === "jid") {
    const phone = phoneFromJid(params.value);
    if (phone) {
      putIdentity({
        entityId: me,
        sourceId: params.sourceId,
        kind: "phone",
        value: phone,
        confidence: 1,
        decidedBy: "code:self",
      });
    }
  }
  return me;
}

/** `events.is_self` is DERIVED, never taken from a source's own opinion. */
export function setEventActorEntity(eventId: string, entityId: string): void {
  const resolved = resolveEntityId(entityId);
  if (!resolved) return;
  getDb()
    .prepare(`UPDATE events SET actor_entity_id = ?, is_self = ? WHERE id = ?`)
    .run(resolved, isSelfEntity(resolved) ? 1 : 0, eventId);
}

// ---- rungs ① and ② ---------------------------------------------------------

export type BindRung = "exact" | "cross_source" | "mint";

export interface BindResult {
  entityId: string;
  rung: BindRung;
  /** `code:exact` · `code:cross_source` · `code:mint`. Recorded on the identity row. */
  decidedBy: string;
  confidence: number;
  minted: boolean;
  /** Extra identity kinds filed alongside — a jid's phone, and nothing else. */
  derived: IdentityKind[];
}

export interface BindParams {
  sourceId: string;
  kind: IdentityKind;
  value: string;
  /** The type to mint when nothing matched. Defaults to `person`. */
  type?: EntityType;
  subtype?: string | null;
  displayName?: string | null;
  seenAt?: string | null;
}

/**
 * The whole of structural binding. Never guesses: the only three outcomes are
 * an exact hit, a cross-source exact hit on a normalised phone or email, and a
 * freshly minted provisional entity. Handle strings NEVER take rung ②.
 */
export function bindIdentity(params: BindParams): BindResult {
  const valueNorm = normaliseIdentityValue(params.kind, params.value);
  if (valueNorm === "") throw new Error(`bindIdentity: ${params.kind} value normalised to empty`);

  const derived: IdentityKind[] = [];
  const jidPhone = params.kind === "jid" ? phoneFromJid(params.value) : null;

  // ① exact (source_id, kind, value_norm)
  const exact = findIdentity(params.sourceId, params.kind, valueNorm);
  if (exact) {
    const entityId = resolveEntityId(exact.entityId)!;
    if (jidPhone) derived.push(...fileDerivedPhone(entityId, params.sourceId, jidPhone, "code:exact"));
    if (params.seenAt) touchEntity(entityId, params.seenAt);
    return { entityId, rung: "exact", decidedBy: "code:exact", confidence: 1, minted: false, derived };
  }

  // ② cross-source exact — phone and email only. A handle is a string two
  // strangers can both own, so it stays inside its source forever.
  const crossValue = jidPhone ?? (isCrossSourceKind(params.kind) ? params.value : null);
  const crossKind: IdentityKind = jidPhone ? "phone" : params.kind;
  if (crossValue !== null) {
    const hits = findCrossSource(crossKind, crossValue);
    const owners = new Set(hits.map((h) => resolveEntityId(h.entityId)).filter((v): v is string => v !== null));
    if (owners.size === 1) {
      const entityId = [...owners][0];
      putIdentity({
        entityId,
        sourceId: params.sourceId,
        kind: params.kind,
        value: params.value,
        confidence: 1,
        decidedBy: "code:cross_source",
      });
      if (jidPhone) derived.push(...fileDerivedPhone(entityId, params.sourceId, jidPhone, "code:cross_source"));
      if (params.seenAt) touchEntity(entityId, params.seenAt);
      return {
        entityId,
        rung: "cross_source",
        decidedBy: "code:cross_source",
        confidence: 1,
        minted: false,
        derived,
      };
    }
    // Two entities already hold this number. That is not a code decision; it
    // is a merge question, and it belongs on a higher rung.
  }

  // Nothing matched. Mint provisional — a new identity is a new entity until
  // some later rung says otherwise.
  const minted = createEntity({
    type: params.type ?? "person",
    subtype: params.subtype ?? null,
    canonical: params.displayName ?? null,
    provisional: true,
    seenAt: params.seenAt ?? null,
  });
  putIdentity({
    entityId: minted.id,
    sourceId: params.sourceId,
    kind: params.kind,
    value: params.value,
    confidence: 1,
    decidedBy: "code:mint",
  });
  if (jidPhone) derived.push(...fileDerivedPhone(minted.id, params.sourceId, jidPhone, "code:mint"));
  return { entityId: minted.id, rung: "mint", decidedBy: "code:mint", confidence: 1, minted: true, derived };
}

/**
 * A WhatsApp jid contains a phone number. Filing it as its own `phone` identity
 * is what lets a later Contacts import join on rung ② with no model call — and
 * it is the ONLY derivation this file performs.
 */
function fileDerivedPhone(
  entityId: string,
  sourceId: string,
  phone: string,
  decidedBy: string,
): IdentityKind[] {
  const already = findIdentity(sourceId, "phone", phone);
  if (already) return [];
  putIdentity({ entityId, sourceId, kind: "phone", value: phone, confidence: 1, decidedBy });
  return ["phone"];
}

/** Rung ③ is available only when the embedder floor for this use case is measured. */
export function similarityRungAvailable(model: string, useCase: CalibUseCase): boolean {
  return readCalib(model, useCase) !== null;
}

// ---- metadata edges — free, exact, before any model runs -------------------

export interface MetadataMember {
  kind: IdentityKind;
  value: string;
  displayName?: string | null;
}

export interface GroupParticipantsParams {
  sourceId: string;
  /** The group itself, as the source names it (`…@g.us`, a calendar id, …). */
  group: MetadataMember & { subtype?: string | null };
  participants: readonly MetadataMember[];
  seenAt?: string | null;
}

export interface MetadataEdgeResult {
  containerEntityId: string;
  memberEntityIds: string[];
  edges: EdgeRow[];
  /** Always 0. That is the point of this path. */
  modelCalls: 0;
}

/**
 * A group's participant list → `affiliated_with:member`, confidence 1.0,
 * `decided_by = code:metadata`, no quote and no model. Runs before enrichment,
 * before P-EP1, before anything.
 */
export function bindGroupParticipants(params: GroupParticipantsParams): MetadataEdgeResult {
  const group = bindIdentity({
    sourceId: params.sourceId,
    kind: params.group.kind,
    value: params.group.value,
    type: "group",
    subtype: params.group.subtype ?? null,
    displayName: params.group.displayName ?? null,
    seenAt: params.seenAt ?? null,
  });
  const memberEntityIds: string[] = [];
  const edges: EdgeRow[] = [];
  for (const p of params.participants) {
    const member = bindIdentity({
      sourceId: params.sourceId,
      kind: p.kind,
      value: p.value,
      type: "person",
      displayName: p.displayName ?? null,
      seenAt: params.seenAt ?? null,
    });
    memberEntityIds.push(member.entityId);
    if (member.entityId === group.entityId) continue;
    edges.push(
      writeEdge({
        kind: "affiliated_with",
        subtype: "member",
        srcEntityId: member.entityId,
        dstEntityId: group.entityId,
        confidence: 1,
        decidedBy: METADATA_DECIDER,
        validFrom: params.seenAt ?? null,
      }).edge,
    );
  }
  return { containerEntityId: group.entityId, memberEntityIds, edges, modelCalls: 0 };
}

export interface CalendarAttendeesParams {
  sourceId: string;
  occasion: MetadataMember & { subtype?: string | null };
  attendees: readonly (MetadataMember & { role?: string })[];
  seenAt?: string | null;
}

/** A calendar invite's attendee list → `participates_in:attendee`. Same deal. */
export function bindCalendarAttendees(params: CalendarAttendeesParams): MetadataEdgeResult {
  const occasion = bindIdentity({
    sourceId: params.sourceId,
    kind: params.occasion.kind,
    value: params.occasion.value,
    type: "occasion",
    subtype: params.occasion.subtype ?? null,
    displayName: params.occasion.displayName ?? null,
    seenAt: params.seenAt ?? null,
  });
  const memberEntityIds: string[] = [];
  const edges: EdgeRow[] = [];
  for (const a of params.attendees) {
    const person = bindIdentity({
      sourceId: params.sourceId,
      kind: a.kind,
      value: a.value,
      type: "person",
      displayName: a.displayName ?? null,
      seenAt: params.seenAt ?? null,
    });
    memberEntityIds.push(person.entityId);
    if (person.entityId === occasion.entityId) continue;
    edges.push(
      writeEdge({
        kind: "participates_in",
        subtype: a.role ?? "attendee",
        srcEntityId: person.entityId,
        dstEntityId: occasion.entityId,
        confidence: 1,
        decidedBy: METADATA_DECIDER,
        validFrom: params.seenAt ?? null,
      }).edge,
    );
  }
  return { containerEntityId: occasion.entityId, memberEntityIds, edges, modelCalls: 0 };
}

// ---- mentions --------------------------------------------------------------

export interface MentionRow {
  id: string;
  eventId: string;
  spanStart: number | null;
  spanEnd: number | null;
  surfaceText: string | null;
  entityId: string | null;
  entityHint: string | null;
  newEntityJson: string | null;
  confidence: number | null;
  decidedBy: string | null;
}

export interface RecordMentionParams {
  eventId: string;
  surface: string;
  /** null when the referent is unknown or ambiguous. UNKNOWN BEATS WRONG. */
  entityId?: string | null;
  hint?: string | null;
  confidence: number;
  decidedBy: string;
  spanStart?: number | null;
  spanEnd?: number | null;
  newEntity?: unknown;
}

export function recordMention(params: RecordMentionParams): MentionRow {
  const entityId = params.entityId ? resolveEntityId(params.entityId) : null;
  if (params.entityId && !entityId) throw new Error(`recordMention: no entity ${params.entityId}`);
  if (!params.decidedBy) throw new Error("recordMention: decided_by is required");
  const id = `mnt_${randomBytes(12).toString("hex")}`;
  getDb()
    .prepare(
      `INSERT INTO mentions (id, event_id, span_start, span_end, surface_text, entity_id,
                             new_entity_json, entity_hint, confidence, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      params.eventId,
      params.spanStart ?? null,
      params.spanEnd ?? null,
      params.surface,
      entityId,
      params.newEntity === undefined ? null : JSON.stringify(params.newEntity),
      params.hint ?? null,
      params.confidence,
      params.decidedBy,
    );
  return readMention(id)!;
}

export function readMention(id: string): MentionRow | null {
  const row = getDb()
    .prepare(
      `SELECT id, event_id, span_start, span_end, surface_text, entity_id, new_entity_json,
              entity_hint, confidence, decided_by
         FROM mentions WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        event_id: string;
        span_start: number | null;
        span_end: number | null;
        surface_text: string | null;
        entity_id: string | null;
        new_entity_json: string | null;
        entity_hint: string | null;
        confidence: number | null;
        decided_by: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    spanStart: row.span_start,
    spanEnd: row.span_end,
    surfaceText: row.surface_text,
    entityId: row.entity_id,
    entityHint: row.entity_hint,
    newEntityJson: row.new_entity_json,
    confidence: row.confidence,
    decidedBy: row.decided_by,
  };
}

export function mentionsOfEvent(eventId: string): MentionRow[] {
  return (
    getDb().prepare(`SELECT id FROM mentions WHERE event_id = ? ORDER BY id`).all(eventId) as { id: string }[]
  ).map((r) => readMention(r.id)!);
}

export function mentionsOfEntity(entityId: string): MentionRow[] {
  const resolved = resolveEntityId(entityId);
  if (!resolved) return [];
  return (
    getDb().prepare(`SELECT id FROM mentions WHERE entity_id = ? ORDER BY id`).all(resolved) as { id: string }[]
  ).map((r) => readMention(r.id)!);
}

/**
 * `[voice note, transcription pending]` and friends. UNKNOWN content, not empty
 * content: nothing may be extracted from one, and nothing may treat it as an
 * acknowledgement either.
 */
export function isPendingPlaceholder(text: string): boolean {
  return /^\s*\[[^\]]*\b(?:pending|unavailable)\b[^\]]*\]\s*$/i.test(String(text ?? ""));
}

// ---- aliases and roster hits ----------------------------------------------

export interface AliasParams {
  entityId: string;
  sourceId: string | null;
  alias: string;
  /** A verbatim line the alias was used in. An alias with no usage is a guess. */
  eventId: string;
  quote: string;
  confidence?: number;
  decidedBy?: string;
}

/**
 * "Babbu" is not a new person, it is a name for one. It becomes an `alias`
 * identity on the entity it refers to, with the line it was used in kept as
 * evidence — so the Entities surface can answer "why does this say Babbu".
 */
export function recordAliasIdentity(params: AliasParams): { identityId: string; entityId: string } {
  const entityId = resolveEntityId(params.entityId);
  if (!entityId) throw new Error(`recordAliasIdentity: no entity ${params.entityId}`);
  const quote = String(params.quote ?? "").trim();
  if (quote === "") throw new Error("recordAliasIdentity: no quote — no evidence, no alias");
  const row = putIdentity({
    entityId,
    sourceId: params.sourceId,
    kind: "alias",
    value: params.alias,
    confidence: params.confidence ?? 0.9,
    decidedBy: params.decidedBy ?? "llm:p-ep1",
  });
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO evidence (subject_kind, subject_id, event_id, quote)
       VALUES ('identity', ?, ?, ?)`,
    )
    .run(row.id, params.eventId, quote);
  return { identityId: row.id, entityId };
}

export interface RosterEntry {
  entityId: string;
  label: string;
  aliases?: readonly string[];
}

/** Exact, case- and whitespace-insensitive. Nothing fuzzy happens at `[CODE]`. */
export function rosterCandidates(roster: readonly RosterEntry[], surface: string): RosterEntry[] {
  const want = normaliseIdentityValue("alias", surface);
  if (want === "") return [];
  return roster.filter(
    (r) =>
      normaliseIdentityValue("alias", r.label) === want ||
      (r.aliases ?? []).some((a) => normaliseIdentityValue("alias", a) === want),
  );
}

export type MentionOutcome = "bound" | "unknown" | "ambiguous";

export interface RosterMentionParams {
  eventId: string;
  surface: string;
  roster: readonly RosterEntry[];
  hint?: string | null;
  spanStart?: number | null;
  spanEnd?: number | null;
  /** The confidence a single exact roster hit is recorded at. */
  confidence?: number;
}

export interface RosterMentionResult {
  mention: MentionRow;
  outcome: MentionOutcome;
  candidates: string[];
}

/**
 * One exact roster candidate binds. Zero or two file the mention with
 * `entity_id NULL` and a hint, because a coin-flip between two Amits is a wrong
 * answer half the time and a question is right every time.
 */
export function bindRosterMention(params: RosterMentionParams): RosterMentionResult {
  const hits = rosterCandidates(params.roster, params.surface);
  const candidates = hits.map((h) => h.entityId);
  const outcome: MentionOutcome = hits.length === 1 ? "bound" : hits.length === 0 ? "unknown" : "ambiguous";
  const mention = recordMention({
    eventId: params.eventId,
    surface: params.surface,
    entityId: outcome === "bound" ? candidates[0] : null,
    hint: outcome === "bound" ? (params.hint ?? null) : (params.hint ?? params.surface),
    confidence: outcome === "bound" ? (params.confidence ?? 0.95) : 0.5,
    decidedBy: outcome === "bound" ? "code:roster" : "code:unresolved",
    spanStart: params.spanStart ?? null,
    spanEnd: params.spanEnd ?? null,
  });
  return { mention, outcome, candidates };
}
