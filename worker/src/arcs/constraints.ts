// ===========================================================================
// [CODE] What reconcile is NOT free to decide — arch §11.2 steps ④ and ⑤.
// Split out of `./reconcile.ts` by concern (build rule 3).
//
//   ④ USER CONSTRAINTS ARE HARD WALLS. A user who split a thread, moved an
//     episode or pinned an arc has told this system something it could not
//     derive. These are read as constraints and PLANNED AROUND, never scored
//     against new evidence. No amount of it overrules a person about their
//     own life.
//
//   ⑤ MERGED-ENTITY REDIRECTS. An entity merge changes an anchor set, which
//     changes the top-3, which changes `arc_key`. Both populations have to be
//     compacted — the provisionals of this pass AND what is already committed
//     — or the provisional hashes off the survivor while the arc it belongs
//     to still hashes off the loser, and reconcile mints a duplicate of a
//     thread the user is already looking at.
//
// Everything here is read-mostly: `compactCommittedArcs` is the only writer,
// and it moves a key and an anchor set, never an id and never a membership.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { meEntityId } from "../entities/binding.js";
import { logMutation } from "../entities/merge.js";
import { resolveEntityId } from "../entities/registry.js";
import { arcKey, type AnchorRef } from "./key.js";
import {
  REFERENCE_EDGE_KINDS,
  ROUTE_PRECEDENCE,
  type PromotionRoute,
  type PromotionVerdict,
} from "./promote.js";
import { readArcByKey, readArcs } from "./provisional.js";

/** The actor stamped on every mutation reconcile writes. */
export const RECONCILE_ACTOR = "reconcile";

// ---- ④ user constraints ----------------------------------------------------

export interface UserConstraints {
  /** Arcs the user pinned. Exempt from the clock (step ③). */
  pinned: Set<string>;
  /** episode id → the arc the user welded it to. Nothing may move it. */
  welded: Map<string, string>;
  /** `<arcId> <episodeId>` pairs the user took apart. Never re-merged. */
  forbidden: Set<string>;
}

/** The `forbidden` set's member shape. One place, so both files agree. */
export function wallKey(arcId: string, episodeId: string): string {
  return `${arcId} ${episodeId}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The walls, read off `arcs.user_pinned` and the `mutations` rows a user action
 * left behind. Two shapes, both written by the surface that performs the action:
 *
 *   field `move`  target = the DESTINATION arc, new `{episodeIds}`
 *   field `split` target = the arc they were taken OUT of,
 *                 new `{episodeIds, toArcId?}`
 *
 * A split with a destination is also a weld; a split without one only forbids.
 */
export function readUserConstraints(): UserConstraints {
  const db = getDb();
  const pinned = new Set(
    (db.prepare(`SELECT id FROM arcs WHERE user_pinned = 1`).all() as { id: string }[]).map((r) => r.id),
  );
  const welded = new Map<string, string>();
  const forbidden = new Set<string>();

  const rows = db
    .prepare(
      `SELECT target_id, field, new_json FROM mutations
        WHERE actor = 'user' AND target_kind = 'arc' AND field IN ('move', 'split')
        ORDER BY ts, rowid`,
    )
    .all() as { target_id: string; field: string; new_json: string | null }[];

  for (const row of rows) {
    let payload: unknown = null;
    try {
      payload = row.new_json === null ? null : JSON.parse(row.new_json);
    } catch {
      continue;
    }
    const record = (payload ?? {}) as Record<string, unknown>;
    const episodeIds = stringList(record.episodeIds);
    if (episodeIds.length === 0) continue;

    if (row.field === "move") {
      for (const episodeId of episodeIds) welded.set(episodeId, row.target_id);
      continue;
    }
    const to = typeof record.toArcId === "string" ? record.toArcId : null;
    for (const episodeId of episodeIds) {
      forbidden.add(wallKey(row.target_id, episodeId));
      if (to !== null) welded.set(episodeId, to);
    }
  }

  return { pinned, welded, forbidden };
}

// ---- ⑤ merged-entity redirects ---------------------------------------------

export interface Redirect {
  from: string;
  to: string;
}

/**
 * Compact an anchor set through `entities.merged_into`. An entity the graph has
 * never heard of is KEPT as itself, not dropped: an unknown id is a data gap,
 * and dropping it would silently move an arc's key.
 */
export function compactAnchors(anchors: readonly AnchorRef[]): {
  anchors: AnchorRef[];
  redirects: Redirect[];
} {
  const out: AnchorRef[] = [];
  const redirects: Redirect[] = [];
  for (const anchor of anchors) {
    let to = anchor.entityId;
    try {
      to = resolveEntityId(anchor.entityId) ?? anchor.entityId;
    } catch {
      to = anchor.entityId;
    }
    if (to !== anchor.entityId) redirects.push({ from: anchor.entityId, to });
    out.push({ ...anchor, entityId: to });
  }
  return { anchors: out, redirects };
}

/**
 * ⑤ applied to what is ALREADY COMMITTED, and not only to the provisionals of
 * this pass. Without this the header's own claim above — "two arcs whose
 * anchors only became the same when an entity merge landed" — is not true: a
 * committed arc anchored on the LOSER of a merge keeps a stale anchor id
 * forever, its key never moves, and the next provisional carrying the SURVIVOR
 * hashes to a different key and mints a SECOND arc for the same thread.
 *
 * The arc keeps its id (§11.2's closing paragraph) and only its key and anchor
 * set move. It is skipped entirely when no redirect fires, which is what makes
 * a second run over the same graph a no-op (item 2.6).
 */
export function compactCommittedArcs(opts: {
  now: number;
  runId: string;
  redirects: Redirect[];
}): { rekeyed: number; mutations: number; collisions: string[] } {
  const db = getDb();
  const arcs = readArcs();
  const collisions: string[] = [];
  let rekeyed = 0;
  let mutations = 0;

  const typeOf = new Map<string, string>();
  const allIds = [...new Set(arcs.flatMap((a) => a.anchorEntityIds))];
  if (allIds.length > 0) {
    const marks = allIds.map(() => "?").join(",");
    for (const e of db.prepare(`SELECT id, type FROM entities WHERE id IN (${marks})`).all(...allIds) as {
      id: string;
      type: string;
    }[]) {
      typeOf.set(e.id, e.type);
    }
  }

  const update = db.prepare(
    `UPDATE arcs SET arc_key = @arcKey, anchor_entity_ids = @anchors, updated_at = @updatedAt WHERE id = @id`,
  );

  for (const arc of arcs) {
    if (arc.anchorEntityIds.length === 0) continue;
    const compacted = compactAnchors(
      arc.anchorEntityIds.map((entityId) => ({ entityId, type: typeOf.get(entityId) ?? null })),
    );
    if (compacted.redirects.length === 0) continue;

    const key = arcKey(compacted.anchors, arc.label);
    const anchors = [...new Set(compacted.anchors.map((a) => a.entityId))].sort();
    if (key === arc.arcKey && anchors.join(",") === [...arc.anchorEntityIds].sort().join(",")) continue;

    // `arcs.arc_key` is UNIQUE. Two committed arcs collapsing onto one key is a
    // merge of two SURFACED threads, which moves episodes and user corrections
    // and is not this pass's business — it is reported, never done silently.
    const holder = readArcByKey(key);
    if (holder !== null && holder.id !== arc.id) {
      collisions.push(arc.id);
      continue;
    }

    opts.redirects.push(...compacted.redirects);
    update.run({
      id: arc.id,
      arcKey: key,
      anchors: JSON.stringify(anchors),
      updatedAt: new Date(opts.now).toISOString(),
    });
    logMutation({
      actor: RECONCILE_ACTOR,
      runId: opts.runId,
      targetKind: "arc",
      targetId: arc.id,
      field: "anchors",
      oldValue: { arcKey: arc.arcKey, anchorEntityIds: arc.anchorEntityIds },
      newValue: { arcKey: key, anchorEntityIds: anchors },
      reason: `compacted ${compacted.redirects.length} merged-entity redirect(s) into the anchor set`,
    });
    rekeyed += 1;
    mutations += 1;
  }

  return { rekeyed, mutations, collisions };
}

// ---- the spaces cap ---------------------------------------------------------
//
// Phase 3 gate / §14.3 row 11: "total spaces ≤ 45" on the reference corpus —
// the prior system surfaced 87 and buried the ten that mattered. §11.3 already
// caps the loosest route (recurrence, ~10 live) inside `promote.ts`; this is
// the outer wall over the WHOLE live population, and it lives in this file
// because the one thing it must never do is evict a user constraint: a pinned
// arc is a hard wall (step ④ above), so `usr` spaces are exempt even when that
// leaves the population over the cap. No amount of tidiness overrules a person.

/** "total spaces ≤ 45" — the live (non-archived) population, corpus-wide. */
export const SPACES_LIVE_CAP = 45;

function msOf(value: string | null | undefined): number {
  if (typeof value !== "string" || value.trim() === "") return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Lower is stronger: an open loop beats an anchor beats a rhythm. */
function routeStrength(verdict: PromotionVerdict): number {
  const recorded = verdict.promotionReason;
  const at = recorded === null ? -1 : ROUTE_PRECEDENCE.indexOf(recorded);
  return at === -1 ? ROUTE_PRECEDENCE.length : at;
}

/**
 * Applied AFTER the recurrence cap, over the verdicts of one sweep. When more
 * than `cap` live spaces would surface, the weakest-justified, stalest ones go
 * back to being browsable threads — the same field flip as any demotion, id
 * unchanged, nothing deleted. Never evicted: `usr` spaces (a pin is a user
 * constraint) and archived spaces (already off the surfaced list).
 */
export function applySpacesCap(
  verdicts: readonly PromotionVerdict[],
  lastEvidenceAt: ReadonlyMap<string, string | null>,
  cap: number = SPACES_LIVE_CAP,
): PromotionVerdict[] {
  const live = verdicts.filter((v) => v.promoted && v.status !== "archived");
  if (live.length <= cap) return [...verdicts];

  const exempt = live.filter((v) => v.routes.includes("usr"));
  const contenders = live.filter((v) => !v.routes.includes("usr"));
  const keep = Math.max(0, cap - exempt.length);

  // Strongest justification first, then freshest evidence, then stable id.
  const ranked = [...contenders].sort((a, b) => {
    const strength = routeStrength(a) - routeStrength(b);
    if (strength !== 0) return strength;
    const freshness = msOf(lastEvidenceAt.get(b.arcId)) - msOf(lastEvidenceAt.get(a.arcId));
    return freshness !== 0 ? freshness : a.arcId.localeCompare(b.arcId);
  });
  const evicted = new Set(ranked.slice(keep).map((v) => v.arcId));

  return verdicts.map((v) => {
    if (!evicted.has(v.arcId)) return v;
    const reason: PromotionRoute | null = v.promotionReason;
    const evidence = { ...v.evidence };
    if (reason !== null) {
      evidence[reason] = {
        ...evidence[reason],
        qualifies: false,
        detail: `${evidence[reason].detail} — beyond the ${cap} live spaces cap`,
      };
    }
    return {
      ...v,
      promoted: false,
      promotionReason: null,
      routes: [],
      status: null,
      statusReason: null,
      livesOn: "thread" as const,
      demoted: true,
      retained: false,
      evidence,
    };
  });
}

// ---- space justification and label audits -----------------------------------
//
// Measured the way `entities/audit.ts` measures: against the ROWS THAT LANDED,
// never against the in-memory verdict that wrote them. The Phase 3 gate box
// asks ">90% holding a live loop or a reference anchor" — so the audit
// re-derives both facts from `loops` and `entity_edges`, and a promotion bug
// that stamps a flattering `promotion_reason` cannot hide behind it.

export interface SpaceJustification {
  arcId: string;
  /** Holds a live (open) loop, counted from `loops` rows. */
  liveLoop: boolean;
  /** Anchored on an entity I have an active has/located_at edge to. */
  referenceAnchor: boolean;
  justified: boolean;
}

function anchorsOf(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

interface LiveSpaceRow {
  id: string;
  label: string | null;
  user_label: string | null;
  anchor_entity_ids: string | null;
}

function readLiveSpaces(): LiveSpaceRow[] {
  return getDb()
    .prepare(
      `SELECT id, label, user_label, anchor_entity_ids
         FROM arcs WHERE promoted = 1 AND (status IS NULL OR status != 'archived') ORDER BY id`,
    )
    .all() as LiveSpaceRow[];
}

/** Every live space, and whether the tables (not the verdict) justify it. */
export function auditSpaceJustifications(): SpaceJustification[] {
  const db = getDb();
  const self = meEntityId();
  const marks = REFERENCE_EDGE_KINDS.map(() => "?").join(", ");
  const anchored: ReadonlySet<string> =
    self === null
      ? new Set()
      : new Set(
          (
            db
              .prepare(
                `SELECT dst_entity_id AS id FROM entity_edges
                  WHERE src_entity_id = ? AND status = 'active' AND kind IN (${marks})`,
              )
              .all(self, ...REFERENCE_EDGE_KINDS) as { id: string }[]
          ).map((r) => r.id),
        );
  const openArcs = new Set(
    (
      db.prepare(`SELECT DISTINCT arc_id FROM loops WHERE state = 'open' AND arc_id IS NOT NULL`).all() as {
        arc_id: string;
      }[]
    ).map((r) => r.arc_id),
  );

  return readLiveSpaces().map((row) => {
    const liveLoop = openArcs.has(row.id);
    const referenceAnchor = anchorsOf(row.anchor_entity_ids).some((id) => anchored.has(id));
    return { arcId: row.id, liveLoop, referenceAnchor, justified: liveLoop || referenceAnchor };
  });
}

/** justified / live, or null when there are no live spaces — `no data`, not 1.0. */
export function spaceJustificationRate(): number | null {
  const all = auditSpaceJustifications();
  if (all.length === 0) return null;
  return all.filter((a) => a.justified).length / all.length;
}

// §14.2 `labels` row: "space labels containing no anchor entity where one
// exists". Denominator = live spaces whose anchor set names at least one entity
// with a canonical name; numerator = those whose rendered label (the user's
// word first, then the derived one) contains none of them.

export interface SpaceLabelAudit {
  arcId: string;
  label: string | null;
  anchors: string[];
  /** True when the label names none of its anchors. */
  anchorless: boolean;
}

export function auditSpaceLabels(): SpaceLabelAudit[] {
  const db = getDb();
  const out: SpaceLabelAudit[] = [];
  for (const row of readLiveSpaces()) {
    const anchorIds = anchorsOf(row.anchor_entity_ids);
    if (anchorIds.length === 0) continue;
    const marks = anchorIds.map(() => "?").join(", ");
    const canonicals = (
      db.prepare(`SELECT canonical FROM entities WHERE id IN (${marks})`).all(...anchorIds) as {
        canonical: string | null;
      }[]
    )
      .map((r) => r.canonical)
      .filter((c): c is string => typeof c === "string" && c.trim() !== "");
    if (canonicals.length === 0) continue;
    const label = row.user_label ?? row.label;
    const haystack = (label ?? "").toLowerCase();
    const anchorless = !canonicals.some((c) => haystack.includes(c.toLowerCase()));
    out.push({ arcId: row.id, label, anchors: anchorIds, anchorless });
  }
  return out;
}

/** anchorless / auditable, or null when no live space has a named anchor. */
export function anchorlessLabelRate(): number | null {
  const all = auditSpaceLabels();
  if (all.length === 0) return null;
  return all.filter((a) => a.anchorless).length / all.length;
}

