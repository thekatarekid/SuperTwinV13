// ===========================================================================
// [CODE] What a source's imported history actually LOOKS like.
//
// One aggregate, read after an import settles, so the worker can tell the
// difference between "WhatsApp pushed the whole archive" and "WhatsApp pushed
// the bootstrap batch and then stopped". Both finish with the same
// `backfill_complete` frame, so the frame cannot tell them apart — only the
// shape of what landed can.
//
// The three numbers below are the ones that separate the two cases by an order
// of magnitude on real installs (measured, not guessed):
//
//   install            chats  messages  1-message chats  avg/chat
//   V11 (declined)        89       305       61 (68.5%)      3.43
//   V10 (healthy)         98      3632       35 (35.7%)     37.06
//   V9G (healthy)        100      3575       37 (37.0%)     35.75
//
// A declined re-upload leaves most chats holding a single message — the one
// the bootstrap batch carried to name the chat — while a real sync leaves them
// holding dozens. See ingest/history-depth.ts for the thresholds drawn through
// that gap.
// ===========================================================================

import type Database from "better-sqlite3";

import { getDb } from "./connection.js";

export interface HistoryShape {
  /** Streams of this source holding at least one event. */
  chats: number;
  /** Events of this source, all kinds. */
  messages: number;
  /** Streams holding EXACTLY one event — the bootstrap-batch signature. */
  singleMessageChats: number;
}

interface ShapeStatements {
  db: Database.Database;
  shape: Database.Statement;
}

let stmts: ShapeStatements | null = null;

function statements(): ShapeStatements {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;
  stmts = {
    db,
    // Grouped by stream, then folded — the per-stream counts are the whole
    // point, so the sparseness test cannot be fooled by one enormous chat
    // carrying the average for ninety empty ones.
    shape: db.prepare(`
      SELECT COUNT(*)                     AS chats,
             COALESCE(SUM(n), 0)          AS messages,
             COALESCE(SUM(n = 1), 0)      AS single_message_chats
        FROM (
          SELECT stream_id, COUNT(*) AS n
            FROM events
           WHERE source_id = ?
           GROUP BY stream_id
        )
    `),
  };
  return stmts;
}

/** Aggregate the per-stream event counts for one source. One indexed scan. */
export function readHistoryShape(sourceId: string): HistoryShape {
  const row = statements().shape.get(sourceId) as {
    chats: number;
    messages: number;
    single_message_chats: number;
  };
  return {
    chats: row.chats,
    messages: row.messages,
    singleMessageChats: row.single_message_chats,
  };
}
