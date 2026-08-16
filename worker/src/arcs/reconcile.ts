// ===========================================================================
// [CODE] Reconcile — the second phase of the two-phase commit. §11.2, item 2.5.
//
//   at EVERY COHORT BOUNDARY (bootstrap) and NIGHTLY (both modes):
//     ① compare provisional ↔ provisional AND ↔ committed
//     ② arc_key = sha1(sorted(top-3 anchor_entity_ids) │ normalize(label_stem))
//        → rebind to the same id or mint
//     ③ aging: quiet 3w → dormant · quiet 12w → archived
//     ④ user constraints (pin/move/split) are HARD WALLS
//     ⑤ compact merged-entity redirects into anchor sets
//     ⑥ every change → mutations rows, undoable as one run
//
// WHY ① IS ONE PASS AND NOT TWO. Bootstrap's cohorts run in parallel, so the
// twins of one trip come into existence at the same instant in different
// workers — "duplicates die the moment they are comparable, and a sequential
// pass can never provide this". Keying both provisionals and committed arcs the
// same way and grouping by that key compares all three populations at once:
// provisional↔provisional, provisional↔committed, and (through ⑤) two arcs
// whose anchors only became the same when an entity merge landed.
//
// WHY ⑤ COMES BEFORE ②. A merged entity changes the anchor set, which changes
// the top-3, which changes the key. Redirecting first means the key is computed
// from what the graph believes NOW; redirecting after would mint an id off a
// stale anchor and then never rebind to it again.
//
// ④ IS NOT ADVISORY. A user who split a thread has told this system something
// it could not derive. Reconcile PLANS AROUND the split (evals L-040): the
// episodes taken out never re-enter the arc they were taken from, and a pinned
// arc is exempt from the clock entirely. No amount of new evidence overrules a
// person about their own life.
//
// ⑥ makes the whole run one undoable unit: every write carries the same
// `run_id` on its `mutations` row, so "undo that reconcile" is a reverse replay
// over one id rather than a forensic exercise.
// ===========================================================================

import { createHash, randomUUID } from "node:crypto";

import { getDb } from "../db/connection.js";
import { logMutation } from "../entities/merge.js";
import { resolveEntityId } from "../entities/registry.js";
import { arcIdForKey, arcKey, type AnchorRef } from "./key.js";
import {
  ARC_ARCHIVED,
  ARC_DORMANT,
  ARC_LIVE,
  arcEpisodeIds,
  attachEpisode,
  commitArc,
  deleteProvisionalArcs,
  readArc,
  readArcByKey,
  readArcs,
  readProvisionalArcs,
  writeProvisionalArc,
  type ArcRow,
} from "./provisional.js";

/** §11.2 step ③, in weeks and in milliseconds. */
export const ARC_DORMANT_WEEKS = 3;
export const ARC_ARCHIVE_WEEKS = 12;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const ARC_DORMANT_MS = ARC_DORMANT_WEEKS * WEEK_MS;
export const ARC_ARCHIVE_MS = ARC_ARCHIVE_WEEKS * WEEK_MS;

/** The actor stamped on every mutation this module writes. */
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

function wallKey(arcId: string, episodeId: string): string {
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

// ---- episode facts ---------------------------------------------------------

interface EpisodeFacts {
  id: string;
  label: string | null;
  sourceId: string | null;
  anchors: AnchorRef[];
  startedAt: string | null;
  endedAt: string | null;
}

function parseIds(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Anchors, label and span for a set of episodes, with types off `entities`. */
export function readEpisodeFacts(episodeIds: readonly string[]): EpisodeFacts[] {
  if (episodeIds.length === 0) return [];
  const db = getDb();
  const placeholders = episodeIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, topic_label, source_id, entity_ids, started_at, ended_at
         FROM episodes WHERE id IN (${placeholders}) ORDER BY id`,
    )
    .all(...episodeIds) as {
    id: string;
    topic_label: string | null;
    source_id: string | null;
    entity_ids: string | null;
    started_at: string | null;
    ended_at: string | null;
  }[];

  const typeOf = new Map<string, string>();
  const allIds = [...new Set(rows.flatMap((r) => parseIds(r.entity_ids)))];
  if (allIds.length > 0) {
    const marks = allIds.map(() => "?").join(",");
    for (const e of db.prepare(`SELECT id, type FROM entities WHERE id IN (${marks})`).all(...allIds) as {
      id: string;
      type: string;
    }[]) {
      typeOf.set(e.id, e.type);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    label: r.topic_label,
    sourceId: r.source_id,
    anchors: parseIds(r.entity_ids).map((entityId) => ({ entityId, type: typeOf.get(entityId) ?? null })),
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }));
}

// ---- the plan --------------------------------------------------------------

export interface ReconcileGroup {
  arcKey: string;
  arcId: string;
  minted: boolean;
  episodeIds: string[];
  /** Provisional rows folded into this group. */
  provisionalIds: string[];
  label: string | null;
}

export interface AgeChange {
  arcId: string;
  from: string;
  to: string;
  quietDays: number;
}

export interface WallHit {
  kind: "pinned" | "welded" | "split";
  arcId: string;
  episodeId: string | null;
  detail: string;
}

export interface ReconcileResult {
  runId: string;
  batchId: string | null;
  groups: ReconcileGroup[];
  /** Provisional rows that turned out to be a duplicate of another. */
  merged: number;
  /** Groups that landed on an id that already existed. */
  rebound: number;
  minted: number;
  aged: AgeChange[];
  walls: WallHit[];
  redirects: Redirect[];
  mutations: number;
}

export interface ReconcileOptions {
  now?: number;
  /** Limit to one cohort boundary's provisionals. Omit for the nightly pass. */
  batchId?: string;
  /** Reuse a run id so several reconciles undo as one. */
  runId?: string;
}

/**
 * A split-derived key for the episodes a user took out of an arc with nowhere
 * to put them. Derived from the arc they left and the exact set that left, so
 * it is stable across runs and can never collide with the arc's own key.
 */
export function splitKey(fromArcId: string, episodeIds: readonly string[]): string {
  return createHash("sha1").update(`split|${fromArcId}|${[...episodeIds].sort().join(",")}`).digest("hex");
}

/** Run reconcile. Returns everything it changed; writes one mutation per change. */
export function reconcile(opts: ReconcileOptions = {}): ReconcileResult {
  const now = opts.now ?? Date.now();
  const runId = opts.runId ?? `rec_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const constraints = readUserConstraints();
  const redirects: Redirect[] = [];
  const walls: WallHit[] = [];
  let mutations = 0;

  const provisionals = readProvisionalArcs(opts.batchId);

  // ① + ⑤ + ② — key every provisional off anchors the graph believes NOW.
  interface Bucket {
    key: string;
    episodeIds: Set<string>;
    provisionalIds: string[];
    label: string | null;
    anchors: Map<string, AnchorRef>;
    sourceIds: Set<string>;
    startedAt: string | null;
    endedAt: string | null;
  }
  const buckets = new Map<string, Bucket>();

  for (const provisional of provisionals) {
    const facts = readEpisodeFacts(provisional.episodeIds);
    const rawAnchors = facts.flatMap((f) => f.anchors);
    const compacted = compactAnchors(rawAnchors);
    redirects.push(...compacted.redirects);
    const label = facts.find((f) => f.label !== null && f.label !== "")?.label ?? null;
    const key = arcKey(compacted.anchors, label);

    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        key,
        episodeIds: new Set(),
        provisionalIds: [],
        label,
        anchors: new Map(),
        sourceIds: new Set(),
        startedAt: null,
        endedAt: null,
      };
      buckets.set(key, bucket);
    }
    bucket.provisionalIds.push(provisional.id);
    for (const id of provisional.episodeIds) bucket.episodeIds.add(id);
    for (const anchor of compacted.anchors) bucket.anchors.set(anchor.entityId, anchor);
    for (const fact of facts) {
      if (fact.sourceId) bucket.sourceIds.add(fact.sourceId);
      bucket.startedAt = min(bucket.startedAt, fact.startedAt);
      bucket.endedAt = max(bucket.endedAt, fact.endedAt);
    }
    if (bucket.label === null) bucket.label = label;
  }

  const merged = provisionals.length - buckets.size;
  const groups: ReconcileGroup[] = [];
  let rebound = 0;
  let minted = 0;

  for (const bucket of [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const existing = readArcByKey(bucket.key);
    const targetId = existing?.id ?? arcIdForKey(bucket.key);

    // ④ HARD WALLS, applied to membership before anything is written.
    const admitted: string[] = [];
    const exiled: string[] = [];
    for (const episodeId of [...bucket.episodeIds].sort()) {
      const weld = constraints.welded.get(episodeId);
      if (weld !== undefined && weld !== targetId) {
        walls.push({
          kind: "welded",
          arcId: targetId,
          episodeId,
          detail: `the user moved this episode to ${weld}; reconcile leaves it there`,
        });
        attachEpisode({ arcId: weld, episodeId, addedBy: "user", signal: "user_move" });
        continue;
      }
      if (constraints.forbidden.has(wallKey(targetId, episodeId))) {
        walls.push({
          kind: "split",
          arcId: targetId,
          episodeId,
          detail: "the user split this episode out of that arc; it is never re-merged",
        });
        exiled.push(episodeId);
        continue;
      }
      admitted.push(episodeId);
    }

    if (admitted.length > 0) {
      const arc = commitArc({
        id: existing?.id,
        arcKey: bucket.key,
        label: bucket.label,
        labelSource: "derived",
        anchorEntityIds: [...bucket.anchors.keys()],
        sourceIds: [...bucket.sourceIds],
        startedAt: bucket.startedAt,
        lastEvidenceAt: bucket.endedAt,
        now,
      });
      if (existing === null) minted += 1;
      else rebound += 1;
      for (const episodeId of admitted) {
        attachEpisode({
          arcId: arc.id,
          episodeId,
          addedBy: "reconcile",
          signal: "arc_key",
          detail: { arc_key: bucket.key, run_id: runId },
        });
      }
      logMutation({
        actor: RECONCILE_ACTOR,
        runId,
        targetKind: "arc",
        targetId: arc.id,
        field: existing === null ? "mint" : "rebind",
        oldValue: existing === null ? null : { episodeIds: arcEpisodeIds(arc.id) },
        newValue: { arcKey: bucket.key, episodeIds: admitted, provisionals: bucket.provisionalIds },
        reason: `reconcile folded ${bucket.provisionalIds.length} provisional arc(s) into ${arc.id}`,
      });
      mutations += 1;
      groups.push({
        arcKey: bucket.key,
        arcId: arc.id,
        minted: existing === null,
        episodeIds: admitted,
        provisionalIds: bucket.provisionalIds,
        label: arc.userLabel ?? arc.label,
      });
    }

    // Episodes a split walled out keep waiting, under a key of their own so the
    // next run groups them together instead of re-proposing the merge.
    //
    // THE ROW'S ID IS DERIVED, NOT MINTED (item 2.6). A walled episode comes
    // back through this branch on every subsequent run, and a fresh `prov_`
    // uuid each time would churn the table forever — "run reconcile twice and
    // the second run changes nothing" has to hold for walled episodes too. A
    // key-derived id makes the re-write a no-op instead: the row is already
    // there, so it is left exactly as it was, timestamp included.
    let exileId: string | null = null;
    if (exiled.length > 0) {
      const exileKey = splitKey(targetId, exiled);
      exileId = `prov_split_${exileKey.slice(0, 16)}`;
      if (!bucket.provisionalIds.includes(exileId)) {
        writeProvisionalArc({
          id: exileId,
          batchId: opts.batchId ?? null,
          arcKeyCandidate: exileKey,
          episodeIds: exiled,
          now,
        });
      }
    }

    // …and it is exempt from the sweep, or the row just re-affirmed above would
    // be deleted by the same pass that wrote it.
    deleteProvisionalArcs(bucket.provisionalIds.filter((id) => id !== exileId));
  }

  // ③ AGING, over every committed arc.
  const aged = ageArcs({ now, runId, pinned: constraints.pinned, walls });
  mutations += aged.length;

  return {
    runId,
    batchId: opts.batchId ?? null,
    groups,
    merged: Math.max(0, merged),
    rebound,
    minted,
    aged,
    walls,
    redirects,
    mutations,
  };
}

function min(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function max(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

// ---- ③ the clock -----------------------------------------------------------

/**
 * What the clock would do to these arcs. Pure, so the eval harness can read the
 * decision without a database and so the boundary days are testable exactly.
 *
 * `>=` on both bars: the day an arc turns three weeks quiet, it is dormant.
 * An arc with no readable `last_evidence_at` is NEVER aged — an unknown age is
 * a data gap, not a silence.
 */
export function ageDecisions(
  arcs: readonly { id: string; state: string; lastEvidenceAt: string | null; userPinned?: number }[],
  now: number,
  pinned: ReadonlySet<string> = new Set(),
): AgeChange[] {
  const out: AgeChange[] = [];
  for (const arc of arcs) {
    if (arc.userPinned === 1 || pinned.has(arc.id)) continue;
    const at = arc.lastEvidenceAt === null ? NaN : Date.parse(arc.lastEvidenceAt);
    if (!Number.isFinite(at)) continue;
    const quiet = now - at;
    const want = quiet >= ARC_ARCHIVE_MS ? ARC_ARCHIVED : quiet >= ARC_DORMANT_MS ? ARC_DORMANT : ARC_LIVE;
    if (want === arc.state) continue;
    // The clock only ever moves forward. Evidence revives an arc, not silence.
    if (want === ARC_LIVE) continue;
    if (arc.state === ARC_ARCHIVED) continue;
    out.push({ arcId: arc.id, from: arc.state, to: want, quietDays: Math.floor(quiet / (24 * 60 * 60 * 1000)) });
  }
  return out.sort((a, b) => (a.arcId < b.arcId ? -1 : 1));
}

/** Apply the clock, one mutation per transition. */
export function ageArcs(opts: {
  now?: number;
  runId?: string | null;
  pinned?: ReadonlySet<string>;
  walls?: WallHit[];
}): AgeChange[] {
  const now = opts.now ?? Date.now();
  const arcs = readArcs();
  const pinned = opts.pinned ?? new Set([...arcs.filter((a) => a.userPinned === 1).map((a) => a.id)]);
  for (const arc of arcs) {
    if (pinned.has(arc.id) && opts.walls) {
      opts.walls.push({
        kind: "pinned",
        arcId: arc.id,
        episodeId: null,
        detail: "the user pinned this arc; the clock does not touch it",
      });
    }
  }

  const changes = ageDecisions(arcs, now, pinned);
  if (changes.length === 0) return changes;

  const db = getDb();
  const stamp = new Date(now).toISOString();
  const update = db.prepare(`UPDATE arcs SET state = @state, updated_at = @updatedAt WHERE id = @id`);
  db.transaction((list: readonly AgeChange[]) => {
    for (const change of list) {
      update.run({ id: change.arcId, state: change.to, updatedAt: stamp });
      logMutation({
        actor: RECONCILE_ACTOR,
        runId: opts.runId ?? null,
        targetKind: "arc",
        targetId: change.arcId,
        field: "state",
        oldValue: change.from,
        newValue: change.to,
        reason: `quiet ${change.quietDays}d`,
      });
    }
  })(changes);
  return changes;
}

/** Read an arc back after a reconcile — a convenience the executors lean on. */
export function reconciledArc(arcId: string): ArcRow | null {
  return readArc(arcId);
}
