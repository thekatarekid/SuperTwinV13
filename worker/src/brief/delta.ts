// ===========================================================================
// The brief's delta — "no new event, no model call" for the brief lane
// (Product_V6 §23.6 item 16, §14.4 item 7; GoldenEvals BRF-01; gate
// `clock_only_call = 0`).
//
// The brief is the one surface that fires on a CLOCK, so it is the one that
// most needs the lookup before the call. This module is that lookup: a
// handful of indexed COUNTs over the WORLD MODEL since the last brief. Zero
// model calls, and nothing is packed until it answers non-zero.
//
// WORLD MODEL, not capture. `events` is deliberately absent: raw captured
// bytes are not something that moved in the user's life until a pass has
// understood them. A brief that fired because three unread group messages
// arrived would be exactly the filler §14.4 forbids.
//
// Consolidation's own bookkeeping is excluded for the same reason it is
// excluded from the T2 roll (consolidation/t2.ts): a claim version the deep
// pass ended is the twin tidying up, not news.
// ===========================================================================

import { getDb } from "../db/connection.js";

export interface BriefChangeSource {
  table: string;
  /** The "when did this row last mean something new" expression. */
  column: string;
  where?: string;
}

/** The tables a brief is allowed to notice a change in. */
export const BRIEF_CHANGE_SOURCES: readonly BriefChangeSource[] = Object.freeze([
  { table: "episodes", column: "COALESCE(updated_at, created_at)" },
  { table: "spaces", column: "COALESCE(latest_ts, updated_at, created_at)" },
  { table: "tasks", column: "COALESCE(closed_at, updated_at, created_at)" },
  {
    table: "claim_versions",
    column: "COALESCE(updated_at, created_at)",
    where: "COALESCE(closed_by, '') != 'consolidate:t3'",
  },
  { table: "questions", column: "COALESCE(answered_at, asked_at)" },
  { table: "calendar_events", column: "COALESCE(confirmed_at, updated_at, created_at)" },
  { table: "calendar_rules", column: "COALESCE(confirmed_at, updated_at, created_at)" },
  { table: "calendar_plans", column: "COALESCE(opened_at, updated_at, created_at)" },
  { table: "artifacts", column: "COALESCE(updated_at, created_at)" },
]);

export interface BriefDelta {
  /** The window's start; null means "the very first brief" (everything counts). */
  since: string | null;
  /** Total rows across every source. */
  rows: number;
  /** Per-table counts — what the "why did the brief fire?" panel shows. */
  byTable: Record<string, number>;
}

/**
 * Rows the world model gained or changed since `sinceIso`. `null` counts
 * everything, which is what the FIRST brief on a machine should see.
 *
 * A missing table (an install mid-migration) counts zero rather than throwing:
 * the brief is a surface, and a surface never takes the worker down.
 */
export function briefDeltaSince(sinceIso: string | null): BriefDelta {
  const db = getDb();
  const byTable: Record<string, number> = {};
  let rows = 0;
  for (const src of BRIEF_CHANGE_SOURCES) {
    let n = 0;
    try {
      const where = [sinceIso ? `${src.column} >= ?` : null, src.where].filter(Boolean).join(" AND ");
      const sql = `SELECT COUNT(*) AS n FROM ${src.table}${where ? ` WHERE ${where}` : ""}`;
      const row = (sinceIso ? db.prepare(sql).get(sinceIso) : db.prepare(sql).get()) as { n: number };
      n = Number(row?.n ?? 0);
    } catch {
      n = 0; // no such table on this install — not a reason to fail a brief
    }
    if (n > 0) byTable[src.table] = n;
    rows += n;
  }
  return { since: sinceIso, rows, byTable };
}
