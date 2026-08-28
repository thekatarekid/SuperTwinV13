// ===========================================================================
// Decide work queue (build P1.4, spec §6.3.2).
//
// `(space_id, pending_episode_ids, priority)` — space_id is the PRIMARY KEY,
// so there is at most ONE queued entry per space and new episodes MERGE IN.
// Priority ladder: urgent > live > backfill; merging keeps the HIGHEST
// priority either enqueue asked for. Claiming flips status to 'running';
// finishing deletes the row unless new episodes merged in while it ran, in
// which case it flips back to 'pending' with only the new ids.
// ===========================================================================

import { getDb } from "../db/connection.js";

export type DecidePriority = "urgent" | "live" | "backfill";

const PRIORITY_RANK: Record<DecidePriority, number> = { urgent: 0, live: 1, backfill: 2 };

export interface DecideQueueRow {
  spaceId: string;
  episodeIds: string[];
  priority: DecidePriority;
  status: "pending" | "running";
}

function parseIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function priorityOf(v: string): DecidePriority {
  return v === "urgent" || v === "backfill" ? v : "live";
}

/** Enqueue episodes for a space — merge-in, never a second row. */
export function enqueueDecide(
  spaceId: string,
  episodeIds: readonly string[],
  priority: DecidePriority = "live",
): DecideQueueRow {
  const db = getDb();
  const existing = db
    .prepare(`SELECT pending_episode_ids, priority, status FROM decide_queue WHERE space_id = ?`)
    .get(spaceId) as { pending_episode_ids: string; priority: string; status: string } | undefined;
  if (existing) {
    const merged = [...new Set([...parseIds(existing.pending_episode_ids), ...episodeIds])];
    const held = priorityOf(existing.priority);
    const kept = PRIORITY_RANK[priority] < PRIORITY_RANK[held] ? priority : held;
    db.prepare(
      `UPDATE decide_queue
          SET pending_episode_ids = ?, priority = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE space_id = ?`,
    ).run(JSON.stringify(merged), kept, spaceId);
    return {
      spaceId,
      episodeIds: merged,
      priority: kept,
      status: existing.status === "running" ? "running" : "pending",
    };
  }
  const ids = [...new Set(episodeIds)];
  db.prepare(
    `INSERT INTO decide_queue (space_id, pending_episode_ids, priority) VALUES (?, ?, ?)`,
  ).run(spaceId, JSON.stringify(ids), priority);
  return { spaceId, episodeIds: ids, priority, status: "pending" };
}

/**
 * Claim up to `limit` pending spaces, best priority first, oldest first.
 * Claimed rows flip to 'running' — a concurrent drain cannot double-run a
 * space (serial per space by construction).
 */
export function claimDecideBatch(limit: number): DecideQueueRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT space_id, pending_episode_ids, priority FROM decide_queue
        WHERE status = 'pending'
        ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'live' THEN 1 ELSE 2 END, enqueued_at
        LIMIT ?`,
    )
    .all(limit) as { space_id: string; pending_episode_ids: string; priority: string }[];
  const claimed: DecideQueueRow[] = [];
  for (const r of rows) {
    const info = db
      .prepare(
        `UPDATE decide_queue
            SET status = 'running', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE space_id = ? AND status = 'pending'`,
      )
      .run(r.space_id);
    if (info.changes > 0) {
      claimed.push({
        spaceId: r.space_id,
        episodeIds: parseIds(r.pending_episode_ids),
        priority: priorityOf(r.priority),
        status: "running",
      });
    }
  }
  return claimed;
}

/**
 * Finish one claimed space. Episodes that merged in WHILE it ran survive: the
 * row flips back to 'pending' holding only the unprocessed ids; otherwise the
 * row is deleted.
 */
export function finishDecide(spaceId: string, processedEpisodeIds: readonly string[]): void {
  const db = getDb();
  const row = db
    .prepare(`SELECT pending_episode_ids FROM decide_queue WHERE space_id = ? AND status = 'running'`)
    .get(spaceId) as { pending_episode_ids: string } | undefined;
  if (!row) return;
  const processed = new Set(processedEpisodeIds);
  const remaining = parseIds(row.pending_episode_ids).filter((id) => !processed.has(id));
  if (remaining.length === 0) {
    db.prepare(`DELETE FROM decide_queue WHERE space_id = ? AND status = 'running'`).run(spaceId);
  } else {
    db.prepare(
      `UPDATE decide_queue
          SET status = 'pending', pending_episode_ids = ?,
              enqueued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE space_id = ?`,
    ).run(JSON.stringify(remaining), spaceId);
  }
}

/** Release a claimed space back to pending (a failed run keeps its work). */
export function releaseDecide(spaceId: string): void {
  getDb()
    .prepare(
      `UPDATE decide_queue
          SET status = 'pending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE space_id = ? AND status = 'running'`,
    )
    .run(spaceId);
}

export function pendingDecideCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM decide_queue WHERE status = 'pending'`)
    .get() as { n: number };
  return row.n;
}
