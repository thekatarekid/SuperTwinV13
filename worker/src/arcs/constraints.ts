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
import { logMutation } from "../entities/merge.js";
import { resolveEntityId } from "../entities/registry.js";
import { arcKey, type AnchorRef } from "./key.js";
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

