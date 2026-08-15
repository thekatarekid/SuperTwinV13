// ===========================================================================
// [CODE] Run history, media spend, media-queue progress and evaluations.
//
// The other half of what survived `store/store.ts` (V2 §3.2): the read side the
// Settings tab and the system routes serve. Every LLM call is logged into
// `extraction_runs` by db/index.ts `logRun`; this module only reads it back.
//
// Kept apart from db/settings.ts on purpose — settings are typed views over one
// `app_state` row each, these are aggregate queries over three tables, and one
// file holding both would be past the size where either is findable.
// ===========================================================================

import type Database from "better-sqlite3";

import { getDb } from "./connection.js";
import { billableTokens } from "../providers/usage.js";

// ---- Row shapes -------------------------------------------------------------

/** One row of the runs viewer (Settings → Runs). */
export interface RunListRow {
  id: string;
  process: string;
  model: string;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  /** null when the run died before the CLI reported a cost — NOT $0. */
  cost_usd: number | null;
  duration_ms: number;
  status: string;
  created_at: string;
}

/**
 * What media reading spent over a window. Media runs are logged but never
 * counted against the chat quota (v3 §1) — a background backlog must not lock
 * the user out of chat — so this is the line that keeps that spend visible.
 */
export interface MediaSpend {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  billableTokens: number;
  /** null when no run in the window reported a cost — NOT $0. */
  costUsd: number | null;
  runCount: number;
}

/** Media rows per media_desc_status — the backfill progress the UI shows. */
export interface MediaQueueCounts {
  pending: number;
  done: number;
  unsupported: number;
  error: number;
}

/** Row shape returned by {@link evaluationsAll}. */
export interface EvaluationRow {
  id: number;
  output_type: string;
  output_id: string;
  verdict: "up" | "down";
  note: string | null;
  ts: string;
}

// ---------------------------------------------------------------------------
// Prepared-statement cache (same pattern as db/index.ts): keyed on the handle,
// so a test that repoints SUPERTWIN_DB_PATH gets fresh statements instead of
// ones bound to a closed database.
// ---------------------------------------------------------------------------

interface Stmts {
  db: Database.Database;
  listRuns: Database.Statement;
  mediaSpend: Database.Statement;
  insertEvaluation: Database.Statement;
  evaluationSummary: Database.Statement;
  evaluationsAll: Database.Statement;
}

let stmts: Stmts | null = null;

function s(): Stmts {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;

  stmts = {
    db,
    listRuns: db.prepare(`
      SELECT id, COALESCE(role, kind) AS process, COALESCE(model, '') AS model,
             input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
             output_tokens, cost_usd, duration_ms, status, created_at
      FROM extraction_runs ORDER BY created_at DESC, id DESC LIMIT ?
    `),
    // SUM(cost_usd) stays NULL when no row reported one, which is how a window
    // with no cost figures is told apart from one that genuinely cost nothing.
    mediaSpend: db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0)                AS input_tokens,
             COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
             COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
             COALESCE(SUM(output_tokens), 0)               AS output_tokens,
             SUM(cost_usd)                                 AS cost_usd,
             COUNT(*)                                      AS run_count
      FROM extraction_runs
      WHERE COALESCE(role, kind) = 'media' AND created_at >= ?
    `),
    insertEvaluation: db.prepare(`
      INSERT INTO evaluations (output_type, output_id, verdict, note)
      VALUES (@outputType, @outputId, @verdict, @note)
    `),
    evaluationSummary: db.prepare(`
      SELECT output_type,
        SUM(CASE WHEN verdict = 'up' THEN 1 ELSE 0 END)   AS up,
        SUM(CASE WHEN verdict = 'down' THEN 1 ELSE 0 END) AS down
      FROM evaluations GROUP BY output_type
    `),
    evaluationsAll: db.prepare(`
      SELECT id, output_type, output_id, verdict, note, ts
      FROM evaluations ORDER BY ts ASC, id ASC
    `),
  };
  return stmts;
}

// ---- Runs viewer -------------------------------------------------------------

/**
 * The most recent `limit` runs, newest first. `process` is the role the call was
 * made for, falling back to the run kind for rows logged before roles existed;
 * every Claude call in the app logs here via db.logRun.
 */
export function listRuns(limit: number): RunListRow[] {
  const rows = s().listRuns.all(limit) as (Omit<RunListRow, "id"> & { id: number })[];
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

/** Media reading's spend over the same window the chat quota snapshot covers. */
export function mediaSpend(windowMs: number): MediaSpend {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = s().mediaSpend.get(since) as {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    run_count: number;
  };
  const usage = {
    inputTokens: row.input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    outputTokens: row.output_tokens,
  };
  return {
    ...usage,
    billableTokens: billableTokens(usage),
    costUsd: row.cost_usd,
    runCount: row.run_count,
  };
}

// ---- Media queue progress ----------------------------------------------------

export function mediaQueueCounts(): MediaQueueCounts {
  const counts: MediaQueueCounts = { pending: 0, done: 0, unsupported: 0, error: 0 };
  const db = s().db;
  const cols = db.pragma("table_info(events)") as { name: string }[];
  // A DB whose events table has no description status has nothing queued.
  if (!cols.some((c) => c.name === "media_desc_status")) return counts;
  const rows = db
    .prepare(
      `SELECT media_desc_status AS status, COUNT(*) AS n FROM events
       WHERE media_desc_status IS NOT NULL GROUP BY media_desc_status`,
    )
    .all() as { status: string; n: number }[];
  for (const r of rows) {
    if (r.status in counts) counts[r.status as keyof MediaQueueCounts] = r.n;
  }
  return counts;
}

// ---- Evaluations -------------------------------------------------------------

const EVAL_OUTPUT_TYPES = new Set([
  "space",
  "task",
  "suggestion",
  "update",
  "pattern",
  "chat_answer",
  "task_result",
]);

export function isEvalOutputType(v: unknown): v is string {
  return typeof v === "string" && EVAL_OUTPUT_TYPES.has(v);
}

export function addEvaluation(params: {
  outputType: string;
  outputId: string;
  verdict: "up" | "down";
  note?: string | null;
}): void {
  s().insertEvaluation.run({
    outputType: params.outputType,
    outputId: params.outputId,
    verdict: params.verdict,
    note: params.note ?? null,
  });
}

export function evaluationSummary(): Record<string, { up: number; down: number }> {
  const rows = s().evaluationSummary.all() as {
    output_type: string;
    up: number;
    down: number;
  }[];
  const out: Record<string, { up: number; down: number }> = {};
  for (const r of rows) out[r.output_type] = { up: r.up, down: r.down };
  return out;
}

/** All evaluation rows, oldest first (down-votes + weekly quality buckets). */
export function evaluationsAll(): EvaluationRow[] {
  return s().evaluationsAll.all() as EvaluationRow[];
}
