// ===========================================================================
// [CODE] Entity registry — the closed vocabulary and the entity row itself.
// Build item 1.5; architecture §10.3.
//
// Two closed sets live here and nowhere else:
//
//   9 TYPES     person group org place thing media_work document occasion topic
//   7 EDGE KINDS related_to affiliated_with has located_at part_of
//                participates_in about
//
// They are the same sets the STW-2 wire enums encode (`per`, `rel`, …), and
// this module asserts that at load: a vocabulary that drifts from the wire is a
// vocabulary that silently drops model output, which rule 9 forbids.
//
// SUBTYPES CARRY FLAVOUR. The 16-type draft in §10.3's table folded into 9 by
// pushing product/service/app_site/vehicle/account/pet/health_item/food_item
// down into `thing` subtypes. A relationship is NEVER a type: "doctor" is
// `related_to:doctor` between two people, not a `doctor` type.
//
// IDS ARE MINTED. `ent_` + 24 random hex. Never a name, never a jid, never a
// phone — a derived id is a merge you can never undo and a rename you can never
// perform.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { ENUMS } from "../wire/tolerance.js";

// ---- the closed type set ---------------------------------------------------

export const ENTITY_TYPES = [
  "person",
  "group",
  "org",
  "place",
  "thing",
  "media_work",
  "document",
  "occasion",
  "topic",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Relationship rings (spec §7.3.2). Inferred from content, tone, claims and
 * metadata — reply volume is only ever one weak signal — and user-editable.
 * Circles drive processing boosts, drafting tone, nudge thresholds,
 * task-applicability and brief inclusion; they are never a claim.
 */
export const CIRCLES = [
  "partner",
  "family",
  "close_friends",
  "friends",
  "coworkers",
  "important_services",
  "old_batchmates",
  "acquaintances",
  "businesses",
] as const;
export type Circle = (typeof CIRCLES)[number];

export function isCircle(value: unknown): value is Circle {
  return typeof value === "string" && (CIRCLES as readonly string[]).includes(value);
}

/**
 * Closed subtype list per type. An empty list means the type takes no subtype
 * at all — `person` and `topic` are what they are, and a "subtype" on either
 * would be a relationship or a claim wearing a schema field.
 */
export const ENTITY_SUBTYPES: Readonly<Record<EntityType, readonly string[]>> = {
  person: [],
  group: ["family", "friends", "work", "community", "event"],
  org: ["company", "hospital", "clinic", "school", "government", "vendor", "restaurant_chain"],
  place: ["city", "area", "venue", "restaurant", "home", "office", "address"],
  // The seven folded types land here as flavour, not as types of their own.
  thing: [
    "product",
    "service",
    "subscription",
    "plan",
    "app",
    "website",
    "vehicle",
    "account",
    "pet",
    "health_item",
    "food_item",
    "device",
  ],
  media_work: ["film", "show", "song", "album", "video", "book", "article", "podcast", "game"],
  document: ["doc", "sheet", "slide", "note", "pdf", "form"],
  occasion: ["birthday", "wedding", "trip", "festival", "party", "appointment", "meeting"],
  topic: [],
};

// ---- the closed edge set ---------------------------------------------------

export const EDGE_KINDS = [
  "related_to",
  "affiliated_with",
  "has",
  "located_at",
  "part_of",
  "participates_in",
  "about",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * Closed subtype list per edge kind. An empty list means the kind carries no
 * subtype — `part_of` and `about` are already the whole relation.
 *
 * `related_to` absorbs family, social, work and care roles: the draft's
 * `family_of`/`social_of`/`works_with`/`provides_care` are one kind with a
 * subtype, because "who is this person to me" is one question. `has` absorbs
 * `owns`, `pet_of` and `subscribes_to` for the same reason.
 */
export const EDGE_SUBTYPES: Readonly<Record<EdgeKind, readonly string[]>> = {
  related_to: [
    "mother",
    "father",
    "sibling",
    "spouse",
    "child",
    "grandparent",
    "cousin",
    "in_law",
    "aunt_uncle",
    "niece_nephew",
    "friend",
    "roommate",
    "neighbor",
    "acquaintance",
    "colleague",
    "manager",
    "report",
    "cofounder",
    "client",
    "doctor",
    "therapist",
    "trainer",
    "cook",
    "domestic_help",
  ],
  affiliated_with: ["member", "employee", "founder", "contractor", "student", "patient", "resident"],
  has: ["owns", "subscribes"],
  located_at: ["current", "past"],
  part_of: [],
  participates_in: ["organizer", "attendee", "guest_of_honor", "invitee"],
  about: [],
};

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === "string" && (ENTITY_TYPES as readonly string[]).includes(value);
}

export function isEdgeKind(value: unknown): value is EdgeKind {
  return typeof value === "string" && (EDGE_KINDS as readonly string[]).includes(value);
}

/** `null`/`undefined` is valid for every type; a non-empty subtype must be listed. */
export function isEntitySubtype(type: EntityType, subtype: string | null | undefined): boolean {
  if (subtype === null || subtype === undefined || subtype === "") return true;
  return ENTITY_SUBTYPES[type].includes(subtype);
}

export function isEdgeSubtype(kind: EdgeKind, subtype: string | null | undefined): boolean {
  if (subtype === null || subtype === undefined || subtype === "") return true;
  return EDGE_SUBTYPES[kind].includes(subtype);
}

// The wire enums are the model-facing spelling of these same two sets. If they
// ever diverge, a model answer that is perfectly legal on the wire would be
// rejected here — output dropped by code, which is exactly what rule 9 and the
// `all_model_output_discarded` gate exist to prevent. Fail at import instead.
function assertMatchesWire(): void {
  const wireTypes = ENUMS.entity_type.entries.map((e) => e.stored);
  const wireEdges = ENUMS.edge_kind.entries.map((e) => e.stored);
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
  if (!same(wireTypes, ENTITY_TYPES)) {
    throw new Error(`entity registry: type set drifted from the wire enum (${wireTypes.join(",")})`);
  }
  if (!same(wireEdges, EDGE_KINDS)) {
    throw new Error(`entity registry: edge set drifted from the wire enum (${wireEdges.join(",")})`);
  }
}
assertMatchesWire();

// ---- minted ids ------------------------------------------------------------

/**
 * `ent_` + 24 random hex. Deliberately NOT a hash of anything: a name-derived
 * id makes two people called Rahul the same row forever, and a jid-derived id
 * makes "Papa's new number" a different person no merge can heal.
 */
export function mintEntityId(): string {
  return `ent_${randomBytes(12).toString("hex")}`;
}

export function isEntityId(value: unknown): value is string {
  return typeof value === "string" && /^ent_[0-9a-f]{24}$/.test(value);
}

// ---- rows ------------------------------------------------------------------

export interface EntityRow {
  id: string;
  type: EntityType;
  subtype: string | null;
  canonical: string | null;
  provisional: boolean;
  mergedInto: string | null;
  userPinned: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** Relationship ring (spec §7.3.2). Null = unassigned. */
  circle: Circle | null;
}

interface RawEntityRow {
  id: string;
  type: string;
  subtype: string | null;
  canonical: string | null;
  provisional: number;
  merged_into: string | null;
  user_pinned: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  circle: string | null;
}

function hydrate(row: RawEntityRow | undefined): EntityRow | null {
  if (!row) return null;
  if (!isEntityType(row.type)) {
    throw new Error(`entity ${row.id}: stored type ${JSON.stringify(row.type)} is outside the closed set`);
  }
  return {
    id: row.id,
    type: row.type,
    subtype: row.subtype,
    canonical: row.canonical,
    provisional: row.provisional !== 0,
    mergedInto: row.merged_into,
    userPinned: row.user_pinned !== 0,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    circle: isCircle(row.circle) ? row.circle : null,
  };
}

const SELECT = `SELECT id, type, subtype, canonical, provisional, merged_into, user_pinned,
                       first_seen_at, last_seen_at, circle
                  FROM entities`;

export interface CreateEntityParams {
  type: EntityType;
  subtype?: string | null;
  canonical?: string | null;
  /** Model- and metadata-minted entities are provisional until a second touch. */
  provisional?: boolean;
  userPinned?: boolean;
  seenAt?: string | null;
  /** Only ever supplied by the me-entity bootstrap and by tests. */
  id?: string;
}

export function createEntity(params: CreateEntityParams): EntityRow {
  if (!isEntityType(params.type)) {
    throw new Error(`createEntity: ${JSON.stringify(params.type)} is not one of the 9 types`);
  }
  const subtype = params.subtype ?? null;
  if (!isEntitySubtype(params.type, subtype)) {
    throw new Error(`createEntity: ${JSON.stringify(subtype)} is not a subtype of ${params.type}`);
  }
  const id = params.id ?? mintEntityId();
  const seen = params.seenAt ?? null;
  getDb()
    .prepare(
      `INSERT INTO entities (id, type, subtype, canonical, provisional, user_pinned,
                             first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      params.type,
      subtype === "" ? null : subtype,
      params.canonical ?? null,
      params.provisional === false ? 0 : 1,
      params.userPinned ? 1 : 0,
      seen,
      seen,
    );
  return readEntityRaw(id)!;
}

/** The row exactly as stored — tombstone included. Use `getEntity` to follow merges. */
export function readEntityRaw(id: string): EntityRow | null {
  return hydrate(getDb().prepare(`${SELECT} WHERE id = ?`).get(id) as RawEntityRow | undefined);
}

/**
 * Follow `merged_into` to the surviving id. O(1) in practice — merges point at
 * a live entity, and a merge of an already-merged loser is re-pointed at write
 * time by `merge.ts` — but the walk is bounded anyway so a hand-edited DB
 * cannot hang a read.
 */
export function resolveEntityId(id: string): string | null {
  let current: string | null = id;
  for (let hop = 0; hop < 16 && current; hop += 1) {
    const row = getDb().prepare(`SELECT merged_into FROM entities WHERE id = ?`).get(current) as
      | { merged_into: string | null }
      | undefined;
    if (!row) return null;
    if (row.merged_into === null) return current;
    current = row.merged_into;
  }
  throw new Error(`entity ${id}: merged_into chain did not terminate in 16 hops`);
}

/**
 * The survivor plus every tombstone that redirects into it, sorted. Merges are
 * lazy by design — the loser's identity and edge rows stay put until reconcile
 * compacts them — so a read that only looked at the survivor's own id would
 * lose half the graph for as long as compaction lagged.
 */
export function mergedAliasIds(entityId: string): string[] {
  const survivor = resolveEntityId(entityId);
  if (!survivor) return [];
  const out = new Set<string>([survivor]);
  let frontier = [survivor];
  for (let depth = 0; depth < 16 && frontier.length > 0; depth += 1) {
    const marks = frontier.map(() => "?").join(",");
    const rows = getDb()
      .prepare(`SELECT id FROM entities WHERE merged_into IN (${marks})`)
      .all(...frontier) as { id: string }[];
    frontier = rows.map((r) => r.id).filter((id) => !out.has(id));
    for (const id of frontier) out.add(id);
  }
  return [...out].sort();
}

/** The surviving row for an id, following any tombstone. */
export function getEntity(id: string): EntityRow | null {
  const resolved = resolveEntityId(id);
  return resolved === null ? null : readEntityRaw(resolved);
}

/** Widens `first_seen_at` / `last_seen_at` — never narrows either. */
export function touchEntity(id: string, seenAt: string): void {
  const target = resolveEntityId(id);
  if (!target) return;
  getDb()
    .prepare(
      `UPDATE entities
          SET first_seen_at = CASE WHEN first_seen_at IS NULL OR ? < first_seen_at THEN ? ELSE first_seen_at END,
              last_seen_at  = CASE WHEN last_seen_at  IS NULL OR ? > last_seen_at  THEN ? ELSE last_seen_at  END
        WHERE id = ?`,
    )
    .run(seenAt, seenAt, seenAt, seenAt, target);
}

export function renameEntity(id: string, canonical: string | null): void {
  const target = resolveEntityId(id);
  if (!target) return;
  getDb().prepare(`UPDATE entities SET canonical = ? WHERE id = ?`).run(canonical, target);
}

export function setEntityType(id: string, type: EntityType, subtype: string | null = null): void {
  if (!isEntityType(type)) throw new Error(`setEntityType: ${JSON.stringify(type)} is not one of the 9 types`);
  if (!isEntitySubtype(type, subtype)) {
    throw new Error(`setEntityType: ${JSON.stringify(subtype)} is not a subtype of ${type}`);
  }
  const target = resolveEntityId(id);
  if (!target) return;
  getDb()
    .prepare(`UPDATE entities SET type = ?, subtype = ? WHERE id = ?`)
    .run(type, subtype === "" ? null : subtype, target);
}

/** A second evidence event or a user touch takes an entity out of `provisional`. */
export function confirmEntity(id: string): void {
  const target = resolveEntityId(id);
  if (!target) return;
  getDb().prepare(`UPDATE entities SET provisional = 0 WHERE id = ?`).run(target);
}

export function pinEntity(id: string, pinned = true): void {
  const target = resolveEntityId(id);
  if (!target) return;
  getDb()
    .prepare(`UPDATE entities SET user_pinned = ?, provisional = CASE WHEN ? THEN 0 ELSE provisional END WHERE id = ?`)
    .run(pinned ? 1 : 0, pinned ? 1 : 0, target);
}

export interface ListEntitiesFilter {
  type?: EntityType;
  /** Tombstones are excluded by default — a merged entity is not a second entity. */
  includeMerged?: boolean;
  provisional?: boolean;
}

export function listEntities(filter: ListEntitiesFilter = {}): EntityRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (!filter.includeMerged) where.push("merged_into IS NULL");
  if (filter.provisional !== undefined) {
    where.push("provisional = ?");
    args.push(filter.provisional ? 1 : 0);
  }
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id`;
  return (getDb().prepare(sql).all(...args) as RawEntityRow[]).map((r) => hydrate(r)!);
}

export function countEntities(filter: ListEntitiesFilter = {}): number {
  return listEntities(filter).length;
}

// ---- circles (spec §7.3.2) -------------------------------------------------

/**
 * Assign (or clear, with null) an entity's circle. Follows merges to the
 * survivor, and records a decisions row so the change is reversible and shows
 * under "why?" (build convention 1.4).
 */
export function setCircle(
  id: string,
  circle: Circle | null,
  opts: { decidedBy?: string; runId?: string | null; reason?: string | null; confidence?: number | null } = {},
): void {
  if (circle !== null && !isCircle(circle)) {
    throw new Error(`setCircle: ${JSON.stringify(circle)} is not one of the 9 circles`);
  }
  const target = resolveEntityId(id);
  if (!target) throw new Error(`setCircle: no entity ${id}`);
  const before = readEntityRaw(target);
  getDb().prepare(`UPDATE entities SET circle = ? WHERE id = ?`).run(circle, target);
  writeDecision({
    pass: opts.decidedBy ?? "user",
    runId: opts.runId ?? null,
    targetKind: "entity",
    targetId: target,
    action: "set_circle",
    old: { circle: before?.circle ?? null },
    new: { circle },
    reason: opts.reason ?? null,
    confidence: opts.confidence ?? null,
  });
}

/** The stored circle of the merge-resolved entity, or null. */
export function circleOf(id: string): Circle | null {
  const target = resolveEntityId(id);
  if (!target) return null;
  return readEntityRaw(target)?.circle ?? null;
}
