// ===========================================================================
// [CODE] Dual watermarks per stream (arch §2.2 note 1, §6; build item 1.1).
//
// A stream is read from BOTH ends at once and the two cursors must never touch:
//
//   live_high_ts    the newest event ingested live. Moves FORWARD only.
//   backfill_low_ts the oldest event ingested from history. Moves BACKWARD only.
//
// The direction rules are the whole point. Backfill arrives with higher rowids
// and older timestamps (§3.3 rule 8), so a single "last seen" cursor would be
// dragged backwards by every history page and the live tail would be re-read
// forever. Two cursors, each monotone in its own direction, and neither is ever
// rewound by the other: a history page landing mid-conversation cannot move
// `live_high_ts`, and a live message cannot lift `backfill_low_ts`.
//
// `backfill_complete` is sticky — history is only pushed once, so a stream that
// finished its import stays finished.
// ===========================================================================

import type Database from "better-sqlite3";

import { getDb } from "./connection.js";

export interface Watermark {
  stream_id: string;
  live_high_ts: string | null;
  live_high_external_id: string | null;
  backfill_low_ts: string | null;
  backfill_complete: boolean;
}

interface RawWatermark {
  stream_id: string;
  live_high_ts: string | null;
  live_high_external_id: string | null;
  backfill_low_ts: string | null;
  backfill_complete: number;
}

interface WatermarkStatements {
  db: Database.Database;
  read: Database.Statement;
  noteLive: Database.Statement;
  noteBackfill: Database.Statement;
  complete: Database.Statement;
  unsealed: Database.Statement;
  anyUnsealed: Database.Statement;
  countStreams: Database.Statement;
  reset: Database.Statement;
}

let stmts: WatermarkStatements | null = null;

function statements(): WatermarkStatements {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;
  stmts = {
    db,
    read: db.prepare(`SELECT * FROM watermarks WHERE stream_id = ?`),
    // FORWARD only. The MAX in the DO UPDATE is what makes an out-of-order live
    // frame — a retry, a reconnect replay — harmless: it can only ever confirm
    // the head, never pull it back.
    noteLive: db.prepare(`
      INSERT INTO watermarks (stream_id, live_high_ts, live_high_external_id)
      VALUES (@streamId, @ts, @externalId)
      ON CONFLICT(stream_id) DO UPDATE SET
        live_high_external_id = CASE
          WHEN watermarks.live_high_ts IS NULL OR excluded.live_high_ts > watermarks.live_high_ts
            THEN excluded.live_high_external_id
          ELSE watermarks.live_high_external_id
        END,
        live_high_ts = MAX(COALESCE(watermarks.live_high_ts, excluded.live_high_ts), excluded.live_high_ts),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `),
    // BACKWARD only, by the same argument mirrored.
    noteBackfill: db.prepare(`
      INSERT INTO watermarks (stream_id, backfill_low_ts)
      VALUES (@streamId, @ts)
      ON CONFLICT(stream_id) DO UPDATE SET
        backfill_low_ts = MIN(COALESCE(watermarks.backfill_low_ts, excluded.backfill_low_ts), excluded.backfill_low_ts),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `),
    complete: db.prepare(`
      INSERT INTO watermarks (stream_id, backfill_complete)
      VALUES (@streamId, 1)
      ON CONFLICT(stream_id) DO UPDATE SET
        backfill_complete = 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `),
    // The streams of a source that are NOT sealed yet — including the ones with
    // no watermark row at all (a lane that produced no event), which is why this
    // is a LEFT JOIN and not a read of `watermarks` alone.
    unsealed: db.prepare(`
      SELECT s.id AS id
        FROM streams s
        LEFT JOIN watermarks w ON w.stream_id = s.id
       WHERE s.source_id = ?
         AND COALESCE(w.backfill_complete, 0) = 0
    `),
    // The same predicate as `unsealed`, capped at one row: the ingest seal asks
    // "is there anything left to seal" once per post-import write, so this must
    // cost an index probe, not a list.
    anyUnsealed: db.prepare(`
      SELECT 1 AS ok
        FROM streams s
        LEFT JOIN watermarks w ON w.stream_id = s.id
       WHERE s.source_id = ?
         AND COALESCE(w.backfill_complete, 0) = 0
       LIMIT 1
    `),
    countStreams: db.prepare(`SELECT COUNT(*) AS n FROM streams WHERE source_id = ?`),
    reset: db.prepare(`DELETE FROM watermarks WHERE stream_id IN (SELECT id FROM streams WHERE source_id = ?)`),
  };
  return stmts;
}

/** The stream's two cursors, or null if it has ingested nothing yet. */
export function readWatermark(streamId: string): Watermark | null {
  const row = statements().read.get(streamId) as RawWatermark | undefined;
  if (!row) return null;
  return {
    stream_id: row.stream_id,
    live_high_ts: row.live_high_ts,
    live_high_external_id: row.live_high_external_id,
    backfill_low_ts: row.backfill_low_ts,
    backfill_complete: row.backfill_complete === 1,
  };
}

/** A live event landed: lift the head if it is newer. Never lowers it. */
export function noteLiveEvent(streamId: string, ts: string, externalId?: string | null): void {
  if (!streamId || !ts) return;
  statements().noteLive.run({ streamId, ts, externalId: externalId ?? null });
}

/** A history event landed: lower the floor if it is older. Never lifts it. */
export function noteBackfillEvent(streamId: string, ts: string): void {
  if (!streamId || !ts) return;
  statements().noteBackfill.run({ streamId, ts });
}

/**
 * Route one ingested event to the cursor it belongs to. `is_historical` is the
 * only thing that decides: both arrive on the same callback, and a backfilled
 * message that moved the live head would strand every event after it.
 */
export function noteIngestedEvent(
  streamId: string,
  ts: string,
  opts: { historical: boolean; externalId?: string | null },
): void {
  if (opts.historical) noteBackfillEvent(streamId, ts);
  else noteLiveEvent(streamId, ts, opts.externalId);
}

/** History for this stream is exhausted. Sticky. */
export function markBackfillComplete(streamId: string): void {
  if (!streamId) return;
  statements().complete.run({ streamId });
}

/** What one seal pass found and did. */
export interface BackfillSealReport {
  /** Streams the source owns at the moment the pass ran. */
  streams: number;
  /** How many of those were still unsealed and have now been marked. */
  sealed: number;
}

/**
 * History for every stream of a source is exhausted — what the daemon's
 * `backfill_complete` means. Streams with no watermark row yet get one, so a
 * lane that never produced an event still records that its import ran.
 *
 * Deliberately RE-RUNNABLE, not just idempotent. The daemon announces
 * `backfill_complete` before its last page has finished landing, so the first
 * pass sees only the streams that exist so far and every stream created after it
 * would keep `backfill_complete = 0` forever — `noteBackfillEvent`'s upsert
 * creates those rows without the flag, and nothing else ever sets it. Callers
 * therefore run this again once ingest goes quiet (Ingestion's backfill seal)
 * and again on boot; each re-run reads one indexed list and writes only the
 * stragglers, so a fully sealed source costs a single SELECT.
 */
export function markSourceBackfillComplete(sourceId: string): BackfillSealReport {
  const s = statements();
  const ids = s.unsealed.all(sourceId) as { id: string }[];
  const tx = s.db.transaction(() => {
    for (const { id } of ids) s.complete.run({ streamId: id });
  });
  tx();
  const { n } = s.countStreams.get(sourceId) as { n: number };
  return { streams: n, sealed: ids.length };
}

/**
 * Does the source still own a stream whose import is not sealed? One index
 * probe. This is the ingest seal's re-arm gate: after `markSourceBackfillComplete`
 * has caught everything, ordinary live traffic answers false here and the seal
 * timer is never re-armed — which is what keeps the re-seal loop convergent.
 */
export function hasUnsealedStreams(sourceId: string): boolean {
  return statements().anyUnsealed.get(sourceId) !== undefined;
}

/** Drop every watermark belonging to a source (used by the source reset). */
export function resetSourceWatermarks(sourceId: string): void {
  statements().reset.run(sourceId);
}
