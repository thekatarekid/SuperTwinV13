// ===========================================================================
// [CODE] Arc persistence and the two-phase commit — arch §11.2, item 2.5.
//
//     continuous: new arcs are PROVISIONAL (no id, no surface)
//     at EVERY COHORT BOUNDARY (bootstrap) and NIGHTLY (both modes): reconcile
//
// THE POINT OF `provisional_arcs`. Bootstrap runs cohorts in PARALLEL. Two
// workers looking at two halves of the same trip will each conclude "this is a
// new thread", and a sequential dedupe cannot help them because neither exists
// yet when the other decides. So a new arc is not written to `arcs` at all: it
// is a row in `provisional_arcs` carrying a CANDIDATE key, invisible to every
// surface, until reconcile can compare it against its twins and against what is
// already committed (`./reconcile.ts`). Evals L-036..L-039.
//
// The second thing this buys is the first-paint guarantee. P-AG2 is not on the
// paint path (§9.5.1); when the ladder defers, the episode still lands
// somewhere — a provisional arc — and the UI is never blocked on a model call
// that has not happened.
//
// NO `spaces` TABLE. A promoted arc IS a space: `promoted`, `promotion_reason`,
// `archetype`, `archetype_source`, `status`, `ends_at`, `cadence`, `user_label`
// are FIELDS on `arcs`, and item 3.6 owns every one of them. Nothing in this
// file writes them — it creates the rows they will one day hang off, and
// `commitArc` is careful to leave them exactly as it found them.
//
// `state` (the thread's own aging: live|dormant|archived) is CODE-WRITTEN ONLY.
// No prompt sets it; `./reconcile.ts` is the only writer.
// ===========================================================================

import { randomUUID } from "node:crypto";

import { getDb } from "../db/connection.js";
import { arcIdForKey, arcKey, type AnchorRef } from "./key.js";
import type { LadderCandidate, LadderResult } from "./ladder.js";

/** `arcs.state` — the THREAD's own aging (§11.2 reconcile step ③). */
export const ARC_LIVE = "live";
export const ARC_DORMANT = "dormant";
export const ARC_ARCHIVED = "archived";

/** §11.2 rule 3 for candidate sets — arcs offered to one episode. */
export const MAX_ARC_CANDIDATES = 10;

// ---- rows ------------------------------------------------------------------

export interface ArcRow {
  id: string;
  arcKey: string;
  label: string | null;
  labelSource: string | null;
  anchorEntityIds: string[];
  sourceIds: string[];
  state: string;
  startedAt: string | null;
  lastEvidenceAt: string | null;
  promoted: number;
  userPinned: number;
  userLabel: string | null;
}

export interface ProvisionalArcRow {
  id: string;
  batchId: string | null;
  arcKeyCandidate: string | null;
  episodeIds: string[];
  createdAt: string;
}

function jsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toArcRow(r: Record<string, unknown>): ArcRow {
  return {
    id: String(r.id),
    arcKey: String(r.arc_key ?? ""),
    label: r.label === null || r.label === undefined ? null : String(r.label),
    labelSource: r.label_source === null || r.label_source === undefined ? null : String(r.label_source),
    anchorEntityIds: jsonArray(r.anchor_entity_ids),
    sourceIds: jsonArray(r.source_ids),
    state: String(r.state ?? ARC_LIVE),
    startedAt: r.started_at === null || r.started_at === undefined ? null : String(r.started_at),
    lastEvidenceAt:
      r.last_evidence_at === null || r.last_evidence_at === undefined ? null : String(r.last_evidence_at),
    promoted: Number(r.promoted ?? 0),
    userPinned: Number(r.user_pinned ?? 0),
    userLabel: r.user_label === null || r.user_label === undefined ? null : String(r.user_label),
  };
}

// ---- reads -----------------------------------------------------------------

export function readArc(id: string): ArcRow | null {
  const row = getDb().prepare(`SELECT * FROM arcs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? toArcRow(row) : null;
}

export function readArcByKey(key: string): ArcRow | null {
  const row = getDb().prepare(`SELECT * FROM arcs WHERE arc_key = ?`).get(key) as
    | Record<string, unknown>
    | undefined;
  return row ? toArcRow(row) : null;
}

/** Every committed arc, oldest key first. Provisional arcs are NOT here. */
export function readArcs(opts: { state?: string } = {}): ArcRow[] {
  const rows = (
    opts.state === undefined
      ? getDb().prepare(`SELECT * FROM arcs ORDER BY id`).all()
      : getDb().prepare(`SELECT * FROM arcs WHERE state = ? ORDER BY id`).all(opts.state)
  ) as Record<string, unknown>[];
  return rows.map(toArcRow);
}

/** The episode ids bound to an arc, in insertion order. */
export function arcEpisodeIds(arcId: string): string[] {
  const rows = getDb()
    .prepare(`SELECT episode_id FROM arc_episodes WHERE arc_id = ? ORDER BY episode_id`)
    .all(arcId) as { episode_id: string }[];
  return rows.map((r) => r.episode_id);
}

/**
 * The arcs an episode may be offered. Archived arcs are never candidates: an
 * arc the clock has retired cannot be joined without being revived first, and a
 * silent revival is how a twelve-week-dead thread swallows a new one.
 */
export function readArcCandidates(opts: { limit?: number } = {}): LadderCandidate[] {
  const limit = Math.max(0, Math.floor(opts.limit ?? MAX_ARC_CANDIDATES));
  if (limit === 0) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM arcs
        WHERE state <> ?
        ORDER BY COALESCE(last_evidence_at, started_at, created_at) DESC, id
        LIMIT ?`,
    )
    .all(ARC_ARCHIVED, limit) as Record<string, unknown>[];
  const arcs = rows.map(toArcRow);

  // The anchor TYPE is what rung ② weights, and an anchor that arrives without
  // one is scored at the weakest tier — so it is read here rather than left to
  // a default that would quietly turn every person into a topic.
  const typeOf = new Map<string, string>();
  const anchorIds = [...new Set(arcs.flatMap((a) => a.anchorEntityIds))];
  if (anchorIds.length > 0) {
    const marks = anchorIds.map(() => "?").join(",");
    for (const row of db.prepare(`SELECT id, type FROM entities WHERE id IN (${marks})`).all(...anchorIds) as {
      id: string;
      type: string;
    }[]) {
      typeOf.set(row.id, row.type);
    }
  }

  return arcs.map((arc) => ({
    arcId: arc.id,
    label: arc.userLabel ?? arc.label,
    sourceIds: arc.sourceIds,
    anchors: arc.anchorEntityIds.map((entityId) => ({ entityId, type: typeOf.get(entityId) ?? null })),
    bridgeIds: arcEpisodeIds(arc.id),
    cosine: null,
  }));
}

// ---- writes ----------------------------------------------------------------

export interface CommitArcParams {
  arcKey: string;
  label: string | null;
  labelSource?: string | null;
  anchorEntityIds: readonly string[];
  sourceIds: readonly string[];
  startedAt?: string | null;
  lastEvidenceAt?: string | null;
  /** Force an id — reconcile passes the id an existing key already holds. */
  id?: string;
  now?: number;
}

/**
 * Rebind to the same id, or mint. The key lookup comes FIRST: an arc whose key
 * has since moved (a user relabel, a fourth anchor outgrowing the third) keeps
 * the id it was surfaced under, which is the whole promise of §11.2's closing
 * paragraph. Only when no row holds the key is `arcIdForKey` used, and it is
 * derived rather than random so a full re-derivation on a clean database
 * reproduces the same ids (evals L-032..L-035).
 *
 * `user_label`, `user_pinned` and every promotion field are read but never
 * written here. A user's word survives every re-derivation.
 */
export function commitArc(params: CommitArcParams): ArcRow {
  const db = getDb();
  const now = params.now ?? Date.now();
  const stamp = new Date(now).toISOString();
  const existing = params.id !== undefined ? readArc(params.id) : readArcByKey(params.arcKey);

  if (existing !== null) {
    const anchors = [...new Set([...existing.anchorEntityIds, ...params.anchorEntityIds])].sort();
    const sources = [...new Set([...existing.sourceIds, ...params.sourceIds])].sort();
    const startedAt = earliest(existing.startedAt, params.startedAt ?? null);
    const lastEvidenceAt = latest(existing.lastEvidenceAt, params.lastEvidenceAt ?? null);
    db.prepare(
      `UPDATE arcs
          SET arc_key = @arcKey,
              label = COALESCE(@label, label),
              label_source = COALESCE(@labelSource, label_source),
              anchor_entity_ids = @anchors,
              source_ids = @sources,
              started_at = @startedAt,
              last_evidence_at = @lastEvidenceAt,
              updated_at = @updatedAt
        WHERE id = @id`,
    ).run({
      id: existing.id,
      arcKey: params.arcKey,
      label: params.label,
      labelSource: params.labelSource ?? null,
      anchors: JSON.stringify(anchors),
      sources: JSON.stringify(sources),
      startedAt,
      lastEvidenceAt,
      updatedAt: stamp,
    });
    return readArc(existing.id) as ArcRow;
  }

  const id = params.id ?? arcIdForKey(params.arcKey);
  db.prepare(
    `INSERT INTO arcs
       (id, arc_key, label, label_source, anchor_entity_ids, source_ids, state,
        started_at, last_evidence_at, promoted, user_pinned, created_at, updated_at)
     VALUES (@id, @arcKey, @label, @labelSource, @anchors, @sources, @state,
             @startedAt, @lastEvidenceAt, 0, 0, @createdAt, @updatedAt)`,
  ).run({
    id,
    arcKey: params.arcKey,
    label: params.label,
    labelSource: params.labelSource ?? null,
    anchors: JSON.stringify([...new Set(params.anchorEntityIds)].sort()),
    sources: JSON.stringify([...new Set(params.sourceIds)].sort()),
    state: ARC_LIVE,
    startedAt: params.startedAt ?? null,
    lastEvidenceAt: params.lastEvidenceAt ?? null,
    createdAt: stamp,
    updatedAt: stamp,
  });
  return readArc(id) as ArcRow;
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export interface AttachParams {
  arcId: string;
  episodeId: string;
  /** `bridge` | `overlap` | `adjudication` | `user` | `reconcile`. */
  addedBy: string;
  signal?: string | null;
  detail?: unknown;
}

/** Bind an episode to an arc. Idempotent: a replay lands on the same row. */
export function attachEpisode(params: AttachParams): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO arc_episodes (arc_id, episode_id, added_by, signal, signal_detail_json)
       VALUES (@arcId, @episodeId, @addedBy, @signal, @detail)`,
    )
    .run({
      arcId: params.arcId,
      episodeId: params.episodeId,
      addedBy: params.addedBy,
      signal: params.signal ?? null,
      detail: params.detail === undefined ? null : JSON.stringify(params.detail),
    });
}

export function detachEpisode(arcId: string, episodeId: string): void {
  getDb().prepare(`DELETE FROM arc_episodes WHERE arc_id = ? AND episode_id = ?`).run(arcId, episodeId);
}

// ---- provisional arcs ------------------------------------------------------

export interface ProvisionalParams {
  batchId?: string | null;
  arcKeyCandidate: string;
  episodeIds: readonly string[];
  id?: string;
  now?: number;
}

/**
 * A new arc, with NO id and NO surface. `id` here is the provisional row's own
 * primary key, not an arc id: nothing joins to it, nothing renders it, and it
 * ceases to exist the moment reconcile commits or merges it.
 */
export function writeProvisionalArc(params: ProvisionalParams): ProvisionalArcRow {
  const id = params.id ?? `prov_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const stamp = new Date(params.now ?? Date.now()).toISOString();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO provisional_arcs (id, batch_id, arc_key_candidate, episode_ids, created_at)
       VALUES (@id, @batchId, @key, @episodeIds, @createdAt)`,
    )
    .run({
      id,
      batchId: params.batchId ?? null,
      key: params.arcKeyCandidate,
      episodeIds: JSON.stringify([...params.episodeIds]),
      createdAt: stamp,
    });
  return {
    id,
    batchId: params.batchId ?? null,
    arcKeyCandidate: params.arcKeyCandidate,
    episodeIds: [...params.episodeIds],
    createdAt: stamp,
  };
}

export function readProvisionalArcs(batchId?: string): ProvisionalArcRow[] {
  const rows = (
    batchId === undefined
      ? getDb().prepare(`SELECT * FROM provisional_arcs ORDER BY created_at, id`).all()
      : getDb().prepare(`SELECT * FROM provisional_arcs WHERE batch_id = ? ORDER BY created_at, id`).all(batchId)
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    batchId: r.batch_id === null || r.batch_id === undefined ? null : String(r.batch_id),
    arcKeyCandidate:
      r.arc_key_candidate === null || r.arc_key_candidate === undefined ? null : String(r.arc_key_candidate),
    episodeIds: jsonArray(r.episode_ids),
    createdAt: String(r.created_at ?? ""),
  }));
}

export function deleteProvisionalArcs(ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(`DELETE FROM provisional_arcs WHERE id = ?`);
  let removed = 0;
  db.transaction((list: readonly string[]) => {
    for (const id of list) removed += stmt.run(id).changes;
  })(ids);
  return removed;
}

// ---- verdicts and questions ------------------------------------------------

export interface PersistArcVerdictParams {
  arcId: string | null;
  episodeId: string;
  runId?: string | null;
  decision: string;
  candidates: unknown;
  output: unknown;
  model?: string | null;
  now?: number;
}

/** Every ladder pass persists its verdict — replay REUSES it, never re-judges. */
export function persistArcVerdict(params: PersistArcVerdictParams): string {
  const id = `av_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  getDb()
    .prepare(
      `INSERT INTO arc_verdicts
         (id, arc_id, episode_id, run_id, decision, candidates_json, output_json, model, created_at)
       VALUES (@id, @arcId, @episodeId, @runId, @decision, @candidates, @output, @model, @createdAt)`,
    )
    .run({
      id,
      arcId: params.arcId,
      episodeId: params.episodeId,
      runId: params.runId ?? null,
      decision: params.decision,
      candidates: JSON.stringify(params.candidates ?? null),
      output: JSON.stringify(params.output ?? null),
      model: params.model ?? null,
      createdAt: new Date(params.now ?? Date.now()).toISOString(),
    });
  return id;
}

/** The `un` route: a question, never a retry and never a silent new arc. */
export function askArcQuestion(params: {
  episodeId: string;
  question: string;
  options?: readonly string[];
  now?: number;
}): string {
  const id = `q_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  getDb()
    .prepare(
      `INSERT INTO questions (id, kind, target_kind, target_id, question, options_json, status, asked_at)
       VALUES (@id, 'arc_binding', 'episode', @targetId, @question, @options, 'open', @askedAt)`,
    )
    .run({
      id,
      targetId: params.episodeId,
      question: params.question,
      options: params.options === undefined ? null : JSON.stringify([...params.options]),
      askedAt: new Date(params.now ?? Date.now()).toISOString(),
    });
  return id;
}

// ---- applying a ladder result ----------------------------------------------

export interface ApplyParams {
  /** Anchors and label of the episode, for the provisional key candidate. */
  anchors: readonly AnchorRef[];
  label: string | null;
  sourceId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  batchId?: string | null;
  runId?: string | null;
  model?: string | null;
  now?: number;
}

export interface ApplyResult {
  verdictId: string;
  /** Set only on a join — a `new` arc has no id until reconcile commits it. */
  arcId: string | null;
  provisionalId: string | null;
  questionId: string | null;
}

/**
 * Turn one `LadderResult` into rows. The ONLY function that writes arc
 * membership, and the place the two-phase commit is actually two-phase:
 *
 *   join      → `arc_episodes` now; the arc already exists and already surfaces
 *   new/defer → `provisional_arcs`; nothing surfaces until reconcile
 *   ask_user  → a question AND a provisional arc, so the episode has a home
 *               while the user is deciding and no arc is bound on a guess
 */
export function applyLadderResult(result: LadderResult, params: ApplyParams): ApplyResult {
  const now = params.now ?? Date.now();
  const verdictId = persistArcVerdict({
    arcId: result.arcId,
    episodeId: result.episodeId,
    runId: params.runId ?? null,
    decision: result.decision,
    candidates: {
      overlaps: result.overlaps.map((o) => ({ arc: o.arcId, score: o.score, shared: o.shared })),
      similarities: result.similarities.map((s) => ({ arc: s.arcId, score: s.decision.score })),
      nominated: result.nominated,
    },
    output: {
      rung: result.rung,
      reason: result.reason,
      bridge: result.bridge,
      verdict: result.verdict,
      demoted_reason: result.demotedReason,
      violations: result.violations,
      model_calls: result.modelCalls,
      ambient: result.ambient,
    },
    model: params.model ?? null,
    now,
  });

  if (result.decision === "join" && result.arcId !== null) {
    attachEpisode({
      arcId: result.arcId,
      episodeId: result.episodeId,
      addedBy: result.rung ?? "ladder",
      signal: result.rung,
      detail: { reason: result.reason, confidence: result.confidence, verdict_id: verdictId },
    });
    const arc = readArc(result.arcId);
    if (arc !== null) {
      commitArc({
        id: arc.id,
        arcKey: arc.arcKey,
        label: arc.label,
        labelSource: arc.labelSource,
        anchorEntityIds: params.anchors.map((a) => a.entityId),
        sourceIds: params.sourceId ? [params.sourceId] : [],
        startedAt: params.startedAt ?? null,
        lastEvidenceAt: params.endedAt ?? null,
        now,
      });
    }
    return { verdictId, arcId: result.arcId, provisionalId: null, questionId: null };
  }

  const provisional = writeProvisionalArc({
    batchId: params.batchId ?? null,
    arcKeyCandidate: arcKey(params.anchors, params.label),
    episodeIds: [result.episodeId],
    now,
  });

  const questionId =
    result.decision === "ask_user" && result.question !== null
      ? askArcQuestion({ episodeId: result.episodeId, question: result.question, now })
      : null;

  return { verdictId, arcId: null, provisionalId: provisional.id, questionId };
}
