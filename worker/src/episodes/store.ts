// ===========================================================================
// [CODE] Episode persistence — the `episodes`, `episode_sessions` and
// `episode_verdicts` tables of migration 0020. Build item 2.1.
//
// Split out of `./engine.ts` so the decision logic stays readable without SQL
// in the middle of it, and so the engine's rules can be tested on plain values.
//
// The one idea that shapes every function here: THE VERDICT IS THE RECORD.
// §11.1's hash gate says a session whose `content_hash` has already been judged
// reuses that judgment and makes no call — so verdicts are keyed to content,
// not to a session id, and `readVerdictForHash` joins through `sessions` to
// find one. A re-segmentation that produced the same members with the same text
// therefore costs nothing, while a late caption (which MOVES the hash) is
// correctly a new question.
//
// Writes are idempotent by construction. Replay re-applies a stored verdict
// over the same rows and must land on exactly the state the first run left, or
// the determinism gate is measuring nothing.
// ===========================================================================

import { randomUUID } from "node:crypto";

import { getDb } from "../db/connection.js";
import { EPISODE_OPEN, EPISODE_QUIET_MS } from "./aging.js";

/** §11.1 rule 3 — "candidate sets stay at 5–10 real items". */
export const MAX_EPISODE_CANDIDATES = 10;

/** An open episode of ONE stream, as P-EP2 is allowed to see it. */
export interface OpenEpisodeCandidate {
  id: string;
  streamId: string | null;
  topicLabel: string | null;
  /** Last activity — what the 14-day clock is measured from. */
  lastActiveAt: string | null;
  entityIds: string[];
}

export interface EpisodeRow {
  id: string;
  streamId: string | null;
  sourceId: string | null;
  topicLabel: string | null;
  labelSource: string | null;
  sessionIds: string[];
  eventIds: string[];
  entityIds: string[];
  arcState: string | null;
  outcome: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** What `episode_verdicts` holds for one session's pass. */
export interface StoredVerdict {
  id: string;
  episodeId: string | null;
  sessionId: string;
  runId: string | null;
  decision: string | null;
  candidates: unknown;
  output: unknown;
  model: string | null;
  createdAt: string;
}

export interface PersistVerdictParams {
  id?: string;
  episodeId: string | null;
  sessionId: string;
  runId?: string | null;
  decision: string;
  candidates: unknown;
  output: unknown;
  model?: string | null;
  createdAt?: string;
}

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Never throw on stored text: a verdict that cannot be parsed is reported
    // as the raw string it is, so the row is still visible to a human.
    return raw;
  }
}

// ---- candidates ------------------------------------------------------------

/**
 * The open episodes P-EP2 may attach this session to.
 *
 * STREAM-SCOPED, always (§11.1 rule 3). Cross-stream grouping is an arc, and
 * offering another stream's episode here is exactly the mistake that would
 * turn topic matching into arc work one attach at a time.
 *
 * The 14-day clock is applied on read as well as on write: an episode that has
 * gone quiet is not a candidate even if `ageEpisodes` has not run yet, so a
 * missed nightly pass can never produce an attach the aging rule forbids.
 */
export function readOpenEpisodes(
  streamId: string,
  opts: { now?: number; limit?: number } = {},
): OpenEpisodeCandidate[] {
  const limit = Math.max(0, Math.floor(opts.limit ?? MAX_EPISODE_CANDIDATES));
  if (limit === 0 || typeof streamId !== "string" || streamId === "") return [];
  const rows = getDb()
    .prepare(
      `SELECT id,
              stream_id                       AS stream_id,
              topic_label                     AS topic_label,
              entity_ids                      AS entity_ids,
              COALESCE(ended_at, started_at)  AS last_active_at
         FROM episodes
        WHERE stream_id = @streamId
          AND (arc_state IS NULL OR arc_state = '${EPISODE_OPEN}')
        ORDER BY COALESCE(ended_at, started_at) DESC, id ASC
        LIMIT @limit`,
    )
    .all({ streamId, limit }) as {
    id: string;
    stream_id: string | null;
    topic_label: string | null;
    entity_ids: string | null;
    last_active_at: string | null;
  }[];

  const now = opts.now ?? Date.now();
  const out: OpenEpisodeCandidate[] = [];
  for (const row of rows) {
    const at = row.last_active_at === null ? Number.NaN : Date.parse(row.last_active_at);
    if (Number.isFinite(at) && now - at >= EPISODE_QUIET_MS) continue;
    out.push({
      id: row.id,
      streamId: row.stream_id,
      topicLabel: row.topic_label,
      lastActiveAt: row.last_active_at,
      entityIds: parseJsonArray(row.entity_ids),
    });
  }
  return out;
}

export function readEpisode(id: string): EpisodeRow | null {
  const row = getDb()
    .prepare(
      `SELECT id, stream_id, source_id, topic_label, label_source, session_ids,
              event_ids, entity_ids, arc_state, outcome, started_at, ended_at
         FROM episodes WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    streamId: (row.stream_id as string | null) ?? null,
    sourceId: (row.source_id as string | null) ?? null,
    topicLabel: (row.topic_label as string | null) ?? null,
    labelSource: (row.label_source as string | null) ?? null,
    sessionIds: parseJsonArray(row.session_ids),
    eventIds: parseJsonArray(row.event_ids),
    entityIds: parseJsonArray(row.entity_ids),
    arcState: (row.arc_state as string | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
  };
}

export function readEpisodesOfStream(streamId: string): EpisodeRow[] {
  const ids = getDb()
    .prepare(`SELECT id FROM episodes WHERE stream_id = ? ORDER BY started_at, id`)
    .all(streamId) as { id: string }[];
  return ids.map((r) => readEpisode(r.id)).filter((r): r is EpisodeRow => r !== null);
}

export function readEpisodesOfSession(sessionId: string): string[] {
  const rows = getDb()
    .prepare(`SELECT episode_id AS id FROM episode_sessions WHERE session_id = ? ORDER BY episode_id`)
    .all(sessionId) as { id: string }[];
  return rows.map((r) => r.id);
}

// ---- the hash gate ---------------------------------------------------------

function toStoredVerdict(row: Record<string, unknown>): StoredVerdict {
  return {
    id: row.id as string,
    episodeId: (row.episode_id as string | null) ?? null,
    sessionId: row.session_id as string,
    runId: (row.run_id as string | null) ?? null,
    decision: (row.decision as string | null) ?? null,
    candidates: parseJson(row.candidates_json),
    output: parseJson(row.output_json),
    model: (row.model as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

const VERDICT_COLUMNS = `id, episode_id, session_id, run_id, decision, candidates_json, output_json, model, created_at`;

/**
 * §11.1's hash gate. Understanding is keyed on CONTENT: any session whose
 * `content_hash` matches has already answered this question, whatever its id.
 * Newest verdict wins — a re-judge (a repair round, a user correction) is the
 * answer that stands. A `one_to_one_fallback` never qualifies: it is the
 * engine's model-free stopgap for a LOST call, not an answer to the content
 * question, and reusing one by hash would copy it into a sibling session as a
 * permanent `hash_reuse` verdict that `rejudgeFallbackSessions` can never see.
 */
export function readVerdictForHash(contentHash: string): StoredVerdict | null {
  if (typeof contentHash !== "string" || contentHash === "") return null;
  const row = getDb()
    .prepare(
      `SELECT ${VERDICT_COLUMNS.split(", ")
        .map((c) => `v.${c}`)
        .join(", ")}
         FROM episode_verdicts v
         JOIN sessions s ON s.id = v.session_id
        WHERE s.content_hash = ?
          AND COALESCE(v.decision, '') != 'one_to_one_fallback'
        ORDER BY v.created_at DESC, v.rowid DESC
        LIMIT 1`,
    )
    .get(contentHash) as Record<string, unknown> | undefined;
  return row ? toStoredVerdict(row) : null;
}

export function readVerdictForSession(sessionId: string): StoredVerdict | null {
  const row = getDb()
    .prepare(
      `SELECT ${VERDICT_COLUMNS} FROM episode_verdicts
        WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionId) as Record<string, unknown> | undefined;
  return row ? toStoredVerdict(row) : null;
}

/**
 * Bind a verdict to the episode it produced. A separate step because
 * `episode_verdicts.episode_id` is a foreign key: the verdict is written first
 * (it is the reason the episode exists at all), so the row it points at cannot
 * exist yet at insert time.
 */
export function setVerdictEpisode(verdictId: string, episodeId: string | null): void {
  getDb().prepare(`UPDATE episode_verdicts SET episode_id = ? WHERE id = ?`).run(episodeId, verdictId);
}

export function countVerdicts(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM episode_verdicts`).get() as { n: number };
  return row.n;
}

export function persistVerdict(params: PersistVerdictParams): string {
  const id = params.id ?? `ev_${randomUUID()}`;
  const createdAt = params.createdAt ?? new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO episode_verdicts
         (id, episode_id, session_id, run_id, decision, candidates_json, output_json, model, created_at)
       VALUES (@id, @episodeId, @sessionId, @runId, @decision, @candidates, @output, @model, @createdAt)
       ON CONFLICT(id) DO UPDATE SET
         episode_id      = excluded.episode_id,
         decision        = excluded.decision,
         candidates_json = excluded.candidates_json,
         output_json     = excluded.output_json,
         model           = excluded.model`,
    )
    .run({
      id,
      episodeId: params.episodeId,
      sessionId: params.sessionId,
      runId: params.runId ?? null,
      decision: params.decision,
      candidates: JSON.stringify(params.candidates ?? null),
      output: JSON.stringify(params.output ?? null),
      model: params.model ?? null,
      createdAt,
    });
  return id;
}

// ---- retraction ------------------------------------------------------------

/** What `retractVerdict` undid, so the caller can log it honestly. */
export interface VerdictRetraction {
  verdictId: string;
  sessionId: string;
  /** Episodes this verdict alone was holding up — gone with it. */
  episodesDeleted: string[];
  /** Episodes that survived with the retracted session's membership removed. */
  episodesUpdated: string[];
}

/**
 * Take one verdict — and everything it wrote — back out, so the session can be
 * judged again. The inverse of `runEpisodePass`'s write path, for the ONE case
 * where re-judging is legitimate: a `one_to_one_fallback` is a model-free
 * verdict wearing a normal verdict's clothes, and both gates that keep a judged
 * session settled (the queue's verdict check, §11.1's hash gate) read the row
 * this deletes. Membership rows carry the verdict's stamp (`episode_sessions.
 * verdict_id`), so only what THIS verdict landed is removed; an episode with
 * members left is rebuilt from its remaining sessions, an empty one is deleted
 * (its arc memberships and embeddings cascade). Null when the verdict does not
 * exist — retracting twice is a no-op, not an error.
 */
export function retractVerdict(verdictId: string): VerdictRetraction | null {
  const db = getDb();
  const run = db.transaction((): VerdictRetraction | null => {
    const verdict = db
      .prepare(`SELECT id, session_id FROM episode_verdicts WHERE id = ?`)
      .get(verdictId) as { id: string; session_id: string } | undefined;
    if (verdict === undefined) return null;
    const sessionId = verdict.session_id;

    const memberships = db
      .prepare(`SELECT episode_id FROM episode_sessions WHERE session_id = ? AND verdict_id = ?`)
      .all(sessionId, verdictId) as { episode_id: string }[];
    db.prepare(`DELETE FROM episode_sessions WHERE session_id = ? AND verdict_id = ?`).run(sessionId, verdictId);

    const removedEventIds = new Set(
      parseJsonArray(
        (db.prepare(`SELECT event_ids FROM sessions WHERE id = ?`).get(sessionId) as
          | { event_ids: string | null }
          | undefined)?.event_ids ?? null,
      ),
    );

    const episodesDeleted: string[] = [];
    const episodesUpdated: string[] = [];
    for (const m of memberships) {
      const episode = readEpisode(m.episode_id);
      if (episode === null) continue;
      const remaining = db
        .prepare(`SELECT session_id FROM episode_sessions WHERE episode_id = ?`)
        .all(m.episode_id) as { session_id: string }[];
      if (remaining.length === 0) {
        // The verdict was this episode's whole reason to exist.
        db.prepare(`DELETE FROM episodes WHERE id = ?`).run(m.episode_id);
        episodesDeleted.push(m.episode_id);
        continue;
      }
      // Events belong to exactly one session, so subtracting the retracted
      // session's events is exact even when other verdicts split THEIR
      // sessions across episodes. Entities may be shared, so those are
      // re-derived from the remaining members; the span from the remaining
      // events' own instants, the way segment spans are built.
      const keptMembers = new Set(remaining.map((r) => r.session_id));
      const sessionIds = episode.sessionIds.filter((id) => keptMembers.has(id));
      for (const id of remaining.map((r) => r.session_id)) if (!sessionIds.includes(id)) sessionIds.push(id);
      const eventIds = episode.eventIds.filter((id) => !removedEventIds.has(id));
      let entityIds: string[] = [];
      let startedAt: string | null = null;
      let endedAt: string | null = null;
      if (sessionIds.length > 0) {
        const marks = sessionIds.map(() => "?").join(",");
        const rows = db
          .prepare(`SELECT id, participant_entity_ids FROM sessions WHERE id IN (${marks})`)
          .all(...sessionIds) as { id: string; participant_entity_ids: string | null }[];
        for (const row of rows) entityIds = mergeIds(entityIds, parseJsonArray(row.participant_entity_ids));
      }
      if (eventIds.length > 0) {
        const marks = eventIds.map(() => "?").join(",");
        const span = db
          .prepare(`SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM events WHERE id IN (${marks})`)
          .get(...eventIds) as { lo: string | null; hi: string | null };
        startedAt = span.lo;
        endedAt = span.hi;
      }
      db.prepare(
        `UPDATE episodes
            SET session_ids = @sessionIds, event_ids = @eventIds, entity_ids = @entityIds,
                started_at = @startedAt, ended_at = @endedAt, updated_at = @updatedAt
          WHERE id = @id`,
      ).run({
        id: m.episode_id,
        sessionIds: JSON.stringify(sessionIds),
        eventIds: JSON.stringify(eventIds),
        entityIds: JSON.stringify(entityIds),
        startedAt,
        endedAt,
        updatedAt: new Date().toISOString(),
      });
      episodesUpdated.push(m.episode_id);
    }

    db.prepare(`DELETE FROM episode_verdicts WHERE id = ?`).run(verdictId);
    return { verdictId, sessionId, episodesDeleted, episodesUpdated };
  });
  return run();
}

// ---- writes ----------------------------------------------------------------

/** One segment's worth of membership, ready to land. */
export interface EpisodeWrite {
  id: string;
  streamId: string;
  sourceId?: string | null;
  topicLabel: string | null;
  labelSource: string | null;
  sessionId: string;
  eventIds: string[];
  entityIds?: string[];
  startedAt: string | null;
  endedAt: string | null;
  /** `attach` re-uses an existing row; `new` mints one. */
  addedBy: string;
  verdictId?: string | null;
}

function mergeIds(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const id of incoming) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function minIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * Land one segment: mint or extend the episode, then bind the session to it.
 *
 * Membership MERGES rather than replaces, and the merge is order-preserving and
 * duplicate-free — replaying the same verdict a second time writes exactly the
 * same row, which is what the determinism gate checks. An attach never rewrites
 * a label the user set (`label_source = 'user'` is left alone).
 */
export function writeEpisode(write: EpisodeWrite, opts: { now?: number } = {}): EpisodeRow {
  const db = getDb();
  const stamp = new Date(opts.now ?? Date.now()).toISOString();
  const existing = readEpisode(write.id);

  if (existing === null) {
    db.prepare(
      `INSERT INTO episodes
         (id, stream_id, source_id, topic_label, label_source, session_ids, event_ids,
          entity_ids, arc_state, outcome, started_at, ended_at, created_at, updated_at)
       VALUES (@id, @streamId, @sourceId, @topicLabel, @labelSource, @sessionIds, @eventIds,
               @entityIds, @arcState, NULL, @startedAt, @endedAt, @createdAt, @updatedAt)`,
    ).run({
      id: write.id,
      streamId: write.streamId,
      sourceId: write.sourceId ?? null,
      topicLabel: write.topicLabel,
      labelSource: write.labelSource,
      sessionIds: JSON.stringify([write.sessionId]),
      eventIds: JSON.stringify(write.eventIds),
      entityIds: JSON.stringify(write.entityIds ?? []),
      arcState: EPISODE_OPEN,
      startedAt: write.startedAt,
      endedAt: write.endedAt,
      createdAt: stamp,
      updatedAt: stamp,
    });
  } else {
    const label = existing.labelSource === "user" ? existing.topicLabel : (write.topicLabel ?? existing.topicLabel);
    const labelSource = existing.labelSource === "user" ? "user" : (write.labelSource ?? existing.labelSource);
    db.prepare(
      `UPDATE episodes
          SET topic_label  = @topicLabel,
              label_source = @labelSource,
              session_ids  = @sessionIds,
              event_ids    = @eventIds,
              entity_ids   = @entityIds,
              started_at   = @startedAt,
              ended_at     = @endedAt,
              updated_at   = @updatedAt
        WHERE id = @id`,
    ).run({
      id: write.id,
      topicLabel: label,
      labelSource,
      sessionIds: JSON.stringify(mergeIds(existing.sessionIds, [write.sessionId])),
      eventIds: JSON.stringify(mergeIds(existing.eventIds, write.eventIds)),
      entityIds: JSON.stringify(mergeIds(existing.entityIds, write.entityIds ?? [])),
      startedAt: minIso(existing.startedAt, write.startedAt),
      endedAt: maxIso(existing.endedAt, write.endedAt),
      updatedAt: stamp,
    });
  }

  db.prepare(
    `INSERT INTO episode_sessions (episode_id, session_id, added_by, verdict_id)
     VALUES (@episodeId, @sessionId, @addedBy, @verdictId)
     ON CONFLICT(episode_id, session_id) DO UPDATE SET
       added_by   = excluded.added_by,
       verdict_id = excluded.verdict_id`,
  ).run({
    episodeId: write.id,
    sessionId: write.sessionId,
    addedBy: write.addedBy,
    verdictId: write.verdictId ?? null,
  });

  const landed = readEpisode(write.id);
  if (landed === null) throw new Error(`writeEpisode: episode ${write.id} vanished after write`);
  return landed;
}
