// ===========================================================================
// [CODE] Promotion, against the database — build item 3.6, arch §11.3.
//
// `./promote.ts` holds the RULES and touches no schema. This file is the other
// half: it reads what an arc actually is, and it writes the eight fields that
// make it a space —
//
//     promoted · promotion_reason · archetype · archetype_source
//     status   · ends_at          · cadence   · user_label
//
// — with an `UPDATE arcs SET …`. There is no `INSERT`, no `DELETE`, and no
// second table. Promotion and demotion are the same statement with different
// values, the id never moves, and every flip leaves a `mutations` row so the
// whole sweep is one undoable run (§11.2 ⑥).
//
// `arcs.state` (the THREAD's aging) belongs to `./reconcile.ts` and is never
// touched here. `arcs.status` (the SPACE's, derived from member loops) belongs
// here and is never touched there. Two clocks, two owners, one table.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { meEntityId } from "../entities/binding.js";
import { logMutation } from "../entities/merge.js";
import { isArchetype, reviseArchetype, type Archetype, type ArchetypeSource } from "./archetype.js";
import { applySpacesCap } from "./constraints.js";
import {
  applyRecurrenceCap,
  isPromotionRoute,
  promotionVerdict,
  REFERENCE_EDGE_KINDS,
  type Cadence,
  type PromotionEdge,
  type PromotionEpisode,
  type PromotionInput,
  type PromotionLoop,
  type PromotionVerdict,
} from "./promote.js";

/** Every promotion write carries this actor, so the sweep is one undoable unit. */
export const PROMOTION_ACTOR = "code:promote";

function jsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

// ---- reads -----------------------------------------------------------------

function readLoops(arcId: string): PromotionLoop[] {
  return (
    getDb()
      .prepare(
        `SELECT id, state, origin, party_pair, owner_id, counterparty_id, recurrence, due_utc
           FROM loops WHERE arc_id = ? ORDER BY id`,
      )
      .all(arcId) as Record<string, unknown>[]
  ).map((r) => ({
    id: String(r.id),
    state: r.state === null || r.state === undefined ? null : String(r.state),
    origin: r.origin === null || r.origin === undefined ? null : String(r.origin),
    partyPair: r.party_pair === null || r.party_pair === undefined ? null : String(r.party_pair),
    ownerId: r.owner_id === null || r.owner_id === undefined ? null : String(r.owner_id),
    counterpartyId:
      r.counterparty_id === null || r.counterparty_id === undefined ? null : String(r.counterparty_id),
    recurrence: r.recurrence === null || r.recurrence === undefined ? null : String(r.recurrence),
    dueUtc: r.due_utc === null || r.due_utc === undefined ? null : String(r.due_utc),
  }));
}

function readEpisodes(arcId: string, self: string | null): PromotionEpisode[] {
  return (
    getDb()
      .prepare(
        `SELECT e.id AS id, e.started_at AS started_at, e.entity_ids AS entity_ids
           FROM arc_episodes ae JOIN episodes e ON e.id = ae.episode_id
          WHERE ae.arc_id = ? ORDER BY e.started_at, e.id`,
      )
      .all(arcId) as Record<string, unknown>[]
  ).map((r) => {
    const entityIds = jsonArray(r.entity_ids);
    return {
      id: String(r.id),
      startedAt: r.started_at === null || r.started_at === undefined ? null : String(r.started_at),
      entityIds,
      selfParticipated: self !== null && entityIds.includes(self),
    };
  });
}

/** Active `has`/`located_at` edges whose SOURCE is me, with the target's type. */
function readSelfEdges(self: string | null): PromotionEdge[] {
  if (self === null) return [];
  const marks = REFERENCE_EDGE_KINDS.map(() => "?").join(", ");
  return (
    getDb()
      .prepare(
        `SELECT ee.kind AS kind, ee.subtype AS subtype, ee.status AS status,
                ee.dst_entity_id AS entity_id, en.type AS entity_type
           FROM entity_edges ee LEFT JOIN entities en ON en.id = ee.dst_entity_id
          WHERE ee.src_entity_id = ? AND ee.status = 'active' AND ee.kind IN (${marks})`,
      )
      .all(self, ...REFERENCE_EDGE_KINDS) as Record<string, unknown>[]
  ).map((r) => ({
    entityId: String(r.entity_id),
    kind: String(r.kind),
    subtype: r.subtype === null || r.subtype === undefined ? null : String(r.subtype),
    status: r.status === null || r.status === undefined ? null : String(r.status),
    entityType: r.entity_type === null || r.entity_type === undefined ? null : String(r.entity_type),
  }));
}

export interface ReadInputOptions {
  now?: number | string | Date;
  /** Passed in when a sweep already read it once — one query, not one per arc. */
  selfEdges?: readonly PromotionEdge[];
  selfEntityId?: string | null;
}

/** Everything §11.3 needs about one arc, assembled from the tables that hold it. */
export function readPromotionInput(arcId: string, opts: ReadInputOptions = {}): PromotionInput | null {
  const row = getDb().prepare(`SELECT * FROM arcs WHERE id = ?`).get(arcId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const self = opts.selfEntityId !== undefined ? opts.selfEntityId : meEntityId();
  const reason = row.promotion_reason;
  const archetype = row.archetype;
  const cadence = row.cadence;
  return {
    arcId,
    anchorEntityIds: jsonArray(row.anchor_entity_ids),
    loops: readLoops(arcId),
    episodes: readEpisodes(arcId, self),
    selfEdges: opts.selfEdges ?? readSelfEdges(self),
    userPinned: Number(row.user_pinned ?? 0) === 1,
    lastEvidenceAt:
      row.last_evidence_at === null || row.last_evidence_at === undefined
        ? null
        : String(row.last_evidence_at),
    wasPromoted: Number(row.promoted ?? 0) === 1,
    previousReason: isPromotionRoute(reason) ? reason : null,
    archetype: isArchetype(archetype) ? archetype : null,
    archetypeSource:
      row.archetype_source === null || row.archetype_source === undefined
        ? null
        : (String(row.archetype_source) as ArchetypeSource),
    cadence: cadence === "one_time" || cadence === "recurring" ? (cadence as Cadence) : null,
    endsAt: row.ends_at === null || row.ends_at === undefined ? null : String(row.ends_at),
    session: { selfEntityId: self, participantEntityIds: [] },
    now: opts.now,
  };
}

// ---- writes ----------------------------------------------------------------

/** The eight fields item 3.6 owns. Nothing outside this list is ever written. */
export const PROMOTION_FIELDS = [
  "promoted",
  "promotion_reason",
  "archetype",
  "archetype_source",
  "status",
  "ends_at",
  "cadence",
  "user_label",
] as const;

export interface ApplyOptions {
  actor?: string;
  runId?: string | null;
}

export interface AppliedChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ApplyResult {
  arcId: string;
  changes: AppliedChange[];
  verdict: PromotionVerdict;
}

/**
 * The field flip. One `UPDATE`, one row, one id — and a `mutations` row per
 * field so "why did this stop being a space?" is answerable after the fact.
 */
export function applyPromotionVerdict(verdict: PromotionVerdict, opts: ApplyOptions = {}): ApplyResult {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM arcs WHERE id = ?`).get(verdict.arcId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`promote: no arc ${JSON.stringify(verdict.arcId)}`);

  const next: Record<string, unknown> = {
    promoted: verdict.promoted ? 1 : 0,
    promotion_reason: verdict.promotionReason,
    archetype: verdict.archetype,
    archetype_source: verdict.archetype === null ? null : verdict.archetypeSource,
    status: verdict.status,
    ends_at: verdict.endsAt,
    cadence: verdict.cadence,
    user_label: row.user_label ?? null,
  };

  const changes: AppliedChange[] = [];
  for (const field of PROMOTION_FIELDS) {
    const from = row[field] ?? null;
    const to = next[field] ?? null;
    if (from === to) continue;
    changes.push({ field, from, to });
  }
  if (changes.length === 0) return { arcId: verdict.arcId, changes, verdict };

  db.prepare(
    `UPDATE arcs
        SET promoted = ?, promotion_reason = ?, archetype = ?, archetype_source = ?,
            status = ?, ends_at = ?, cadence = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(
    next.promoted,
    next.promotion_reason,
    next.archetype,
    next.archetype_source,
    next.status,
    next.ends_at,
    next.cadence,
    verdict.arcId,
  );

  const actor = opts.actor ?? PROMOTION_ACTOR;
  for (const change of changes) {
    logMutation({
      actor,
      runId: opts.runId ?? null,
      targetKind: "arc",
      targetId: verdict.arcId,
      field: change.field,
      oldValue: change.from,
      newValue: change.to,
      reason:
        change.field === "promoted"
          ? verdict.promoted
            ? `promoted via ${verdict.promotionReason}`
            : verdict.party.blocked
              ? "party rule: no loop involves you"
              : "no promotion route qualifies"
          : `promotion sweep (${verdict.promotionReason ?? "none"})`,
    });
  }
  return { arcId: verdict.arcId, changes, verdict };
}

// ---- the sweep -------------------------------------------------------------

export interface PromotionSweep {
  verdicts: PromotionVerdict[];
  applied: ApplyResult[];
  promoted: number;
  demoted: number;
  blockedByParty: number;
  /** Promoted arcs carrying a recorded route. Must equal `promoted`. */
  justified: number;
}

export interface SweepOptions extends ApplyOptions {
  now?: number | string | Date;
  /** Compute without writing — what the Spaces tab asks for a preview. */
  dryRun?: boolean;
}

/**
 * Re-derive promotion for every arc. Called at reconcile: promotion is a pure
 * function of loops, edges, episodes and the clock, so it is safe to run as
 * often as the evidence changes and it always converges on the same answer.
 */
export function promoteArcs(opts: SweepOptions = {}): PromotionSweep {
  const self = meEntityId();
  const selfEdges = readSelfEdges(self);
  const ids = (getDb().prepare(`SELECT id, last_evidence_at FROM arcs ORDER BY id`).all() as {
    id: string;
    last_evidence_at: string | null;
  }[]);

  const lastEvidence = new Map<string, string | null>();
  const raw: PromotionVerdict[] = [];
  for (const { id, last_evidence_at } of ids) {
    lastEvidence.set(id, last_evidence_at);
    const input = readPromotionInput(id, { now: opts.now, selfEdges, selfEntityId: self });
    if (input) raw.push(promotionVerdict(input));
  }

  // The recurrence cap first (§11.3, ~10 live), then the corpus-wide spaces
  // cap (Phase 3 gate, ≤ 45 live) — pinned spaces exempt from both.
  const verdicts = applySpacesCap(applyRecurrenceCap(raw, lastEvidence), lastEvidence);
  const applied: ApplyResult[] = [];
  if (opts.dryRun !== true) {
    for (const verdict of verdicts) applied.push(applyPromotionVerdict(verdict, opts));
  }
  return {
    verdicts,
    applied,
    promoted: verdicts.filter((v) => v.promoted).length,
    demoted: verdicts.filter((v) => v.demoted).length,
    blockedByParty: verdicts.filter((v) => v.party.blocked).length,
    justified: verdicts.filter((v) => v.promoted && v.promotionReason !== null).length,
  };
}

// ---- user gestures ---------------------------------------------------------

/** 📌 The user route. A pin is a hard wall: no evidence overrules a person. */
export function pinArc(arcId: string, opts: ApplyOptions = {}): ApplyResult {
  return setPin(arcId, true, opts);
}

export function unpinArc(arcId: string, opts: ApplyOptions = {}): ApplyResult {
  return setPin(arcId, false, opts);
}

function setPin(arcId: string, pinned: boolean, opts: ApplyOptions): ApplyResult {
  const db = getDb();
  const row = db.prepare(`SELECT user_pinned FROM arcs WHERE id = ?`).get(arcId) as
    | { user_pinned: number }
    | undefined;
  if (!row) throw new Error(`promote: no arc ${JSON.stringify(arcId)}`);
  const before = Number(row.user_pinned ?? 0);
  const after = pinned ? 1 : 0;
  if (before !== after) {
    db.prepare(`UPDATE arcs SET user_pinned = ? WHERE id = ?`).run(after, arcId);
    logMutation({
      actor: opts.actor ?? "user",
      runId: opts.runId ?? null,
      targetKind: "arc",
      targetId: arcId,
      field: "user_pinned",
      oldValue: before,
      newValue: after,
      reason: pinned ? "user pinned this thread" : "user unpinned this thread",
    });
  }
  const input = readPromotionInput(arcId);
  if (!input) throw new Error(`promote: no arc ${JSON.stringify(arcId)}`);
  return applyPromotionVerdict(promotionVerdict(input), opts);
}

/** The user's own words for the space. Model output is never edited into it. */
export function setUserLabel(arcId: string, label: string | null, opts: ApplyOptions = {}): void {
  const db = getDb();
  const row = db.prepare(`SELECT user_label FROM arcs WHERE id = ?`).get(arcId) as
    | { user_label: string | null }
    | undefined;
  if (!row) throw new Error(`promote: no arc ${JSON.stringify(arcId)}`);
  if ((row.user_label ?? null) === (label ?? null)) return;
  db.prepare(`UPDATE arcs SET user_label = ? WHERE id = ?`).run(label, arcId);
  logMutation({
    actor: opts.actor ?? "user",
    runId: opts.runId ?? null,
    targetKind: "arc",
    targetId: arcId,
    field: "user_label",
    oldValue: row.user_label ?? null,
    newValue: label,
    reason: "user renamed this space",
  });
}

export interface ArchetypeWrite {
  changed: boolean;
  blocked: boolean;
  archetype: Archetype | null;
  source: ArchetypeSource;
  transition: string | null;
}

/**
 * §11.3: archetype is revisable, and **the transition is recorded with a
 * reason**. That record is the `mutations` row this writes — evals P-049.
 */
export function setArchetype(
  arcId: string,
  next: Archetype,
  source: ArchetypeSource,
  reason: string,
  opts: ApplyOptions = {},
): ArchetypeWrite {
  const db = getDb();
  const row = db.prepare(`SELECT archetype, archetype_source FROM arcs WHERE id = ?`).get(arcId) as
    | { archetype: string | null; archetype_source: string | null }
    | undefined;
  if (!row) throw new Error(`promote: no arc ${JSON.stringify(arcId)}`);

  const revision = reviseArchetype({
    current: isArchetype(row.archetype) ? row.archetype : null,
    currentSource: (row.archetype_source ?? "code") as ArchetypeSource,
    next,
    nextSource: source,
    reason,
  });
  if (!revision.changed || revision.archetype === null) {
    return {
      changed: false,
      blocked: revision.blocked,
      archetype: revision.archetype,
      source: revision.source,
      transition: null,
    };
  }
  db.prepare(
    `UPDATE arcs SET archetype = ?, archetype_source = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
  ).run(revision.archetype, revision.source, arcId);
  logMutation({
    actor: opts.actor ?? (source === "user" ? "user" : PROMOTION_ACTOR),
    runId: opts.runId ?? null,
    targetKind: "arc",
    targetId: arcId,
    field: "archetype",
    oldValue: revision.transition?.from ?? null,
    newValue: revision.archetype,
    reason,
  });
  return {
    changed: true,
    blocked: false,
    archetype: revision.archetype,
    source: revision.source,
    transition: reason,
  };
}

// ---- the Spaces view -------------------------------------------------------

export interface SpaceRow {
  id: string;
  label: string | null;
  userLabel: string | null;
  promotionReason: string | null;
  archetype: string | null;
  archetypeSource: string | null;
  status: string | null;
  endsAt: string | null;
  cadence: string | null;
  lastEvidenceAt: string | null;
}

/**
 * `/api/spaces` is a FILTERED VIEW OVER `arcs` (build item 3.10). It is a
 * `WHERE promoted = 1`, not a table — which is the whole architecture in one
 * SQL statement.
 */
export function readSpaces(opts: { includeArchived?: boolean } = {}): SpaceRow[] {
  const where = opts.includeArchived === true ? `promoted = 1` : `promoted = 1 AND status != 'archived'`;
  return (
    getDb()
      .prepare(
        `SELECT id, label, user_label, promotion_reason, archetype, archetype_source,
                status, ends_at, cadence, last_evidence_at
           FROM arcs WHERE ${where} ORDER BY last_evidence_at DESC, id`,
      )
      .all() as Record<string, unknown>[]
  ).map((r) => ({
    id: String(r.id),
    label: r.label === null || r.label === undefined ? null : String(r.label),
    userLabel: r.user_label === null || r.user_label === undefined ? null : String(r.user_label),
    promotionReason:
      r.promotion_reason === null || r.promotion_reason === undefined ? null : String(r.promotion_reason),
    archetype: r.archetype === null || r.archetype === undefined ? null : String(r.archetype),
    archetypeSource:
      r.archetype_source === null || r.archetype_source === undefined ? null : String(r.archetype_source),
    status: r.status === null || r.status === undefined ? null : String(r.status),
    endsAt: r.ends_at === null || r.ends_at === undefined ? null : String(r.ends_at),
    cadence: r.cadence === null || r.cadence === undefined ? null : String(r.cadence),
    lastEvidenceAt:
      r.last_evidence_at === null || r.last_evidence_at === undefined ? null : String(r.last_evidence_at),
  }));
}
