// ===========================================================================
// Extract work queue — V6 P1 E1 (migration 0210_v6_extract_queue).
//
// Decide's queue is keyed on the SPACE, because Decide is a per-space pass.
// Extract is a per-EPISODE pass, so this queue is keyed on the episode: one
// row per episode, a re-commit merges into it (priority upgrades, never
// downgrades), and claiming flips it to 'running' so two drains can never
// run the same episode twice.
//
// Three things this queue owns that the Decide queue does not need:
//
//   THE WATERMARK. `finishExtract` stamps `episodes.extracted_at`, so "has
//   this episode ever been through the memory pass?" is a lookup, not an
//   inference over claims. An episode that yields nothing durable is still
//   extracted, and must never be paid for twice.
//
//   THE THREE-STRIKE LADDER. A released row keeps its place in the queue, so
//   a batch that fails for a reason that will not go away would be re-claimed
//   and re-paid-for every drain, forever. `releaseExtract` counts attempts and
//   the third one DEAD-LETTERS the row (status 'failed', last_error kept):
//   visible, countable, and never claimed again.
//
//   THE BACKLOG SEEDER. Extract had no caller until now, so on a home that
//   has been running for a while every committed episode is un-extracted. The
//   seeder is the upgrade path: it queues episodes `extracted_at` says are new
//   at BACKFILL priority, bounded per call, and it is idempotent — nothing to
//   seed means zero rows written and zero model calls.
//
// Everything here is code: no model call is made in this module.
// ===========================================================================

import { getDb } from "../db/connection.js";

export type ExtractPriority = "urgent" | "live" | "backfill";

const PRIORITY_RANK: Record<ExtractPriority, number> = { urgent: 0, live: 1, backfill: 2 };

/** Strikes before a batch's episodes are dead-lettered instead of re-paid-for. */
export const EXTRACT_MAX_ATTEMPTS = 3;

/**
 * Legacy `episode_events` rows store a RANGE (start..end rowid), not a member
 * id, so a range row's real size is unknown without a walk. The batcher only
 * needs an estimate to keep one call's input bounded; a range row is counted
 * as this many events rather than as one.
 */
export const RANGE_ROW_ESTIMATE = 10;

export interface ExtractQueueRow {
  episodeId: string;
  streamId: string | null;
  priority: ExtractPriority;
  status: "pending" | "running" | "failed";
  attempts: number;
}

export interface ExtractCandidate {
  episodeId: string;
  streamId?: string | null;
}

function priorityOf(v: string): ExtractPriority {
  return v === "urgent" || v === "backfill" ? v : "live";
}

function nowSql(): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
}

/**
 * Queue episodes for Extract. One row per episode: an episode already queued
 * keeps its row and takes the BEST priority of the two; an episode already
 * running is left alone (the running pass covers it, and finishing it must not
 * resurrect a row that was never re-enqueued). A dead-lettered row is revived
 * by a fresh enqueue — new events are a new reason to try.
 *
 * Returns the number of rows inserted or revived (not merges), so a caller can
 * say something true in the log without a second query.
 */
export function enqueueExtract(
  episodes: readonly (ExtractCandidate | string)[],
  priority: ExtractPriority = "live",
): number {
  const db = getDb();
  const read = db.prepare(
    `SELECT priority, status, attempts FROM extract_queue WHERE episode_id = ?`,
  );
  // Guarded rather than FK-throwing: a caller naming an episode that does not
  // exist (a commit report that lost a race, a replay) queues nothing and
  // costs the rest of the batch nothing.
  const insert = db.prepare(
    `INSERT INTO extract_queue (episode_id, stream_id, priority)
     SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM episodes WHERE id = ?)`,
  );
  const upgrade = db.prepare(
    `UPDATE extract_queue SET priority = ?, updated_at = ${nowSql()} WHERE episode_id = ?`,
  );
  const revive = db.prepare(
    `UPDATE extract_queue
        SET status = 'pending', attempts = 0, last_error = NULL, priority = ?,
            enqueued_at = ${nowSql()}, updated_at = ${nowSql()}
      WHERE episode_id = ?`,
  );
  let added = 0;
  for (const raw of episodes) {
    const cand: ExtractCandidate = typeof raw === "string" ? { episodeId: raw } : raw;
    if (typeof cand.episodeId !== "string" || cand.episodeId === "") continue;
    const existing = read.get(cand.episodeId) as
      | { priority: string; status: string; attempts: number }
      | undefined;
    if (existing === undefined) {
      added += insert.run(cand.episodeId, cand.streamId ?? null, priority, cand.episodeId).changes;
      continue;
    }
    const held = priorityOf(existing.priority);
    const kept = PRIORITY_RANK[priority] < PRIORITY_RANK[held] ? priority : held;
    if (existing.status === "failed") {
      revive.run(kept, cand.episodeId);
      added += 1;
    } else if (kept !== held) {
      upgrade.run(kept, cand.episodeId);
    }
  }
  return added;
}

/**
 * Claim up to `limit` pending episodes, best priority first, oldest first.
 * A claimed row is 'running' — a concurrent drain cannot double-run it.
 */
export function claimExtractBatch(limit: number): ExtractQueueRow[] {
  if (limit <= 0) return [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT episode_id, stream_id, priority, attempts FROM extract_queue
        WHERE status = 'pending'
        ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'live' THEN 1 ELSE 2 END, enqueued_at
        LIMIT ?`,
    )
    .all(limit) as { episode_id: string; stream_id: string | null; priority: string; attempts: number }[];
  const claim = db.prepare(
    `UPDATE extract_queue SET status = 'running', updated_at = ${nowSql()}
      WHERE episode_id = ? AND status = 'pending'`,
  );
  const claimed: ExtractQueueRow[] = [];
  for (const r of rows) {
    if (claim.run(r.episode_id).changes === 0) continue;
    claimed.push({
      episodeId: r.episode_id,
      streamId: r.stream_id,
      priority: priorityOf(r.priority),
      status: "running",
      attempts: r.attempts,
    });
  }
  return claimed;
}

/**
 * A finished pass: the rows go, and every episode it covered is stamped
 * `extracted_at` — including one that yielded nothing durable, which is a
 * fact about that episode and not a reason to pay for it again.
 */
export function finishExtract(episodeIds: readonly string[], now: Date = new Date()): void {
  if (episodeIds.length === 0) return;
  const db = getDb();
  const del = db.prepare(`DELETE FROM extract_queue WHERE episode_id = ? AND status = 'running'`);
  const stamp = db.prepare(`UPDATE episodes SET extracted_at = ? WHERE id = ?`);
  const iso = now.toISOString();
  const tx = db.transaction((ids: readonly string[]) => {
    for (const id of ids) {
      del.run(id);
      stamp.run(iso, id);
    }
  });
  tx(episodeIds);
}

/**
 * A failed pass: the work is kept, not lost — the rows go back to 'pending'
 * with one more strike. The third strike dead-letters them ('failed'), so a
 * batch that cannot succeed stops costing money while staying visible.
 *
 * Returns the episodes that were dead-lettered by this call.
 */
export function releaseExtract(episodeIds: readonly string[], error: string | null = null): string[] {
  if (episodeIds.length === 0) return [];
  const db = getDb();
  const read = db.prepare(`SELECT attempts FROM extract_queue WHERE episode_id = ? AND status = 'running'`);
  const back = db.prepare(
    `UPDATE extract_queue SET status = 'pending', attempts = ?, last_error = ?, updated_at = ${nowSql()}
      WHERE episode_id = ?`,
  );
  const dead = db.prepare(
    `UPDATE extract_queue SET status = 'failed', attempts = ?, last_error = ?, updated_at = ${nowSql()}
      WHERE episode_id = ?`,
  );
  const deadLettered: string[] = [];
  const tx = db.transaction((ids: readonly string[]) => {
    for (const id of ids) {
      const row = read.get(id) as { attempts: number } | undefined;
      if (row === undefined) continue; // not ours any more
      const attempts = row.attempts + 1;
      if (attempts >= EXTRACT_MAX_ATTEMPTS) {
        dead.run(attempts, error, id);
        deadLettered.push(id);
      } else {
        back.run(attempts, error, id);
      }
    }
  });
  tx(episodeIds);
  return deadLettered;
}

/** Rows waiting for a drain. The lookup that comes before any call. */
export function pendingExtractCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM extract_queue WHERE status = 'pending'`)
    .get() as { n: number };
  return row.n;
}

/** Rows the three-strike ladder gave up on. Countable, never claimed again. */
export function deadLetteredExtractCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM extract_queue WHERE status = 'failed'`)
    .get() as { n: number };
  return row.n;
}

/** Committed episodes that have never been through Extract. A pure lookup. */
export function unextractedEpisodeCount(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM episodes e
        WHERE e.extracted_at IS NULL
          AND EXISTS (SELECT 1 FROM episode_events ee WHERE ee.episode_id = e.id)`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * The upgrade path (and the answer to "the pass never ran on what is already
 * here"): queue up to `limit` committed, never-extracted episodes at BACKFILL
 * priority, newest first. Idempotent — an episode already queued, running or
 * dead-lettered is not queued again, and a home with nothing to seed writes
 * nothing.
 */
export function seedExtractBacklog(limit: number): number {
  if (limit <= 0) return 0;
  const rows = getDb()
    .prepare(
      `SELECT e.id, e.stream_id FROM episodes e
        WHERE e.extracted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM extract_queue q WHERE q.episode_id = e.id)
          AND EXISTS (SELECT 1 FROM episode_events ee WHERE ee.episode_id = e.id)
        ORDER BY COALESCE(e.last_ts, e.created_at) DESC
        LIMIT ?`,
    )
    .all(limit) as { id: string; stream_id: string | null }[];
  if (rows.length === 0) return 0;
  return enqueueExtract(
    rows.map((r) => ({ episodeId: r.id, streamId: r.stream_id })),
    "backfill",
  );
}

/**
 * Rough event count per episode, for the batcher's input ceiling. Explicit
 * membership rows (S3.1) are counted exactly; a legacy RANGE row is counted
 * as RANGE_ROW_ESTIMATE, because a range's real size needs a rowid walk and
 * the batcher only needs an upper-ish bound.
 */
export function episodeEventCounts(episodeIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (episodeIds.length === 0) return out;
  const ph = episodeIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT episode_id,
              SUM(CASE WHEN event_id IS NOT NULL THEN 1 ELSE 0 END) AS members,
              COUNT(*) AS rows_n
         FROM episode_events WHERE episode_id IN (${ph}) GROUP BY episode_id`,
    )
    .all(...episodeIds) as { episode_id: string; members: number; rows_n: number }[];
  for (const r of rows) {
    out.set(r.episode_id, r.members > 0 ? r.members : Math.max(1, r.rows_n) * RANGE_ROW_ESTIMATE);
  }
  for (const id of episodeIds) if (!out.has(id)) out.set(id, 1);
  return out;
}
