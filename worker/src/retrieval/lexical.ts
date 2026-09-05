// ===========================================================================
// Lexical retrieval — BM25 over events and over chunks/cards (V6 P1 S2.3;
// Build §5.2 lane A, Product_V6 §23.4 "Lexical (BM25)", Product_V6_Phase1 §20).
//
// One of the five methods that run against one index. Lexical is what answers
// for rare tokens, names and numbers — "the message with ₹5,400", "the tab
// about villas" — and fails at paraphrase, which is the vector method's job
// (chunk-index.ts). It produces RANKED CANDIDATE LISTS, not scores to be
// summed: BM25 and cosine are not on one scale, so the fusion layer (S2.4,
// retrieval/semantic.ts) combines them by reciprocal rank. Every hit here
// carries its 1-based `rank` for exactly that.
//
// Two indexes, two lists:
//
//   events_fts   ten columns after 0202_v6_fts_projection — the message text
//                and its attachments (0017) plus the projected `app`,
//                `window_title`, `doc_key` (RET-06). A screen event's text is
//                the diff of the window, so the window's TITLE is the column
//                that finds "the tab about villas"; the per-column bm25 says
//                which column a hit came from, so the caller can cite it.
//
//   chunks_fts   one column over chunks.text, rowid = chunks.id — the unit the
//                vector index embeds. Cards are chunks (kind ∈ episode | space
//                | claim | person), so one index puts space cards and people
//                cards under the same BM25 as the chat / screen / browser
//                windows, filterable by kind.
//
// Query construction is planQuery() (query.ts): stopwords out, stems as prefix
// terms, date spellings as phrases. This module never reads the model, never
// writes, and never scans: both lists are bounded by `limit` (S2.4's FTS top
// 2,000 is the intended ceiling for fusion).
// ===========================================================================

import type Database from "better-sqlite3";

import { getDb } from "../db/connection.js";
import {
  DEFAULT_FTS_WEIGHTS,
  EVENTS_FTS_COLUMNS,
  type EventsFtsColumn,
  type FtsColumnWeights,
} from "../db/retrieval.js";
import { CHUNK_KINDS, isChunkKind, type ChunkKind } from "../db/v6graph.js";
import { planQuery, type QueryPlan } from "./query.js";

/** Candidates a lexical pass hands to fusion (S2.4: FTS top 2,000). */
export const DEFAULT_LEXICAL_EVENT_LIMIT = 2000;
export const DEFAULT_LEXICAL_CHUNK_LIMIT = 2000;
/** Hard ceiling on either list — a bound, never a scan. */
export const MAX_LEXICAL_LIMIT = 5000;
/** Snippet width in FTS5 tokens (FTS5 caps it at 64). */
const SNIPPET_TOKENS = 18;

// ---- Hit shapes ---------------------------------------------------------------

export interface LexicalEventHit {
  kind: "event";
  /** events.id */
  id: string;
  /** events.rowid — what events_fts cites. */
  rowid: number;
  /** 1-based position in this list, best first. Fusion reads this. */
  rank: number;
  /** Weighted bm25 (negative; more negative is better). */
  score: number;
  eventKind: string | null;
  source: string | null;
  streamKey: string | null;
  ts: string | null;
  /** The FTS column whose own bm25 contributed most. */
  matchedColumn: EventsFtsColumn;
  /** A snippet cut from THAT column. */
  snippet: string;
  /** The projected identity columns (NULL for chat). */
  app: string | null;
  windowTitle: string | null;
  docKey: string | null;
}

export interface LexicalChunkHit {
  kind: "chunk";
  /** chunks.id (the rowid). */
  id: number;
  rank: number;
  score: number;
  chunkKind: ChunkKind;
  source: string | null;
  streamKey: string | null;
  refId: string | null;
  /** events.id the chunk covers (empty for cards). */
  eventIds: string[];
  tsStart: string | null;
  tsEnd: string | null;
  snippet: string;
}

export interface LexicalSearchOptions {
  /** Clock for date resolution in the query plan (default: now). */
  now?: Date;
  eventLimit?: number;
  chunkLimit?: number;
  /** Restrict the chunk list to these kinds (default: every kind). */
  chunkKinds?: readonly ChunkKind[];
  /** Per-column bm25 weights over events_fts; omitted columns keep the defaults. */
  weights?: FtsColumnWeights;
}

export interface LexicalSearchResult {
  plan: QueryPlan;
  events: LexicalEventHit[];
  chunks: LexicalChunkHit[];
}

// ---- Statements ----------------------------------------------------------------

const WEIGHTED_BM25 = `bm25(events_fts, ${EVENTS_FTS_COLUMNS.map((_, i) => `@w${i}`).join(", ")})`;

const PER_COLUMN_BM25 = EVENTS_FTS_COLUMNS.map(
  (_, i) => `bm25(events_fts, ${EVENTS_FTS_COLUMNS.map((__, j) => (i === j ? "1.0" : "0")).join(", ")}) AS m${i}`,
).join(",\n        ");

const PER_COLUMN_SNIPPET = EVENTS_FTS_COLUMNS.map(
  (_, i) => `snippet(events_fts, ${i}, '', '', '…', ${SNIPPET_TOKENS}) AS s${i}`,
).join(",\n        ");

interface LexicalStatements {
  db: Database.Database;
  events: Database.Statement;
  chunks: Database.Statement;
}

let stmts: LexicalStatements | null = null;

function statements(): LexicalStatements {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;
  stmts = {
    db,
    // Reactions are not evidence (same rule as db/retrieval.ts). Revoked rows
    // are still findable — "the message he deleted" is a real question.
    events: db.prepare(`
      SELECT
        e.id, e.rowid AS rowid, e.kind AS event_kind, e.source_id AS source,
        e.stream_key, e.ts, e.app, e.window_title, e.doc_key,
        ${WEIGHTED_BM25} AS score,
        ${PER_COLUMN_BM25},
        ${PER_COLUMN_SNIPPET}
      FROM events_fts f
      JOIN events e ON e.rowid = f.rowid
      WHERE events_fts MATCH @match
        AND e.kind IS NOT 'reaction'
      ORDER BY score, e.ts DESC, e.rowid DESC
      LIMIT @limit
    `),
    chunks: db.prepare(`
      SELECT
        c.id, c.kind, c.source, c.stream_key, c.ref_id, c.event_ids_json, c.ts_start, c.ts_end,
        bm25(chunks_fts) AS score,
        snippet(chunks_fts, 0, '', '', '…', ${SNIPPET_TOKENS}) AS snippet
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
      WHERE chunks_fts MATCH @match
        AND c.kind IN (SELECT value FROM json_each(@kinds))
      ORDER BY score, c.ts_end DESC, c.id DESC
      LIMIT @limit
    `),
  };
  return stmts;
}

// ---- Search --------------------------------------------------------------------

/**
 * BM25 over both indexes for one question. Empty question → empty lists. An
 * expression FTS5 rejects (planQuery sanitises, but a query of only
 * punctuation can still be nothing) degrades to empty lists rather than
 * throwing: lexical is one method of five and its absence is not an error.
 */
export function lexicalSearch(query: string, opts: LexicalSearchOptions = {}): LexicalSearchResult {
  const plan = planQuery(query, opts.now ?? new Date());
  if (plan.match.length === 0) return { plan, events: [], chunks: [] };
  return {
    plan,
    events: searchEventsLexical(plan.match, { limit: opts.eventLimit, weights: opts.weights }),
    chunks: searchChunksLexical(plan.match, { limit: opts.chunkLimit, kinds: opts.chunkKinds }),
  };
}

export interface EventLexicalOptions {
  limit?: number;
  weights?: FtsColumnWeights;
}

/** Ranked events for an FTS5 MATCH expression, best first, with the matched column. */
export function searchEventsLexical(match: string, opts: EventLexicalOptions = {}): LexicalEventHit[] {
  const expr = match.trim();
  if (expr.length === 0) return [];
  const weights = EVENTS_FTS_COLUMNS.map((col) => {
    const w = opts.weights?.[col];
    return Number.isFinite(w) ? (w as number) : DEFAULT_FTS_WEIGHTS[col];
  });
  const params: Record<string, unknown> = { match: expr, limit: clampLimit(opts.limit, DEFAULT_LEXICAL_EVENT_LIMIT) };
  weights.forEach((w, i) => {
    params[`w${i}`] = w;
  });
  const rows = runMatch(() => statements().events.all(params) as RawEventRow[]);
  return rows.map((row, i) => {
    const index = matchedColumnIndex(row, weights);
    return {
      kind: "event",
      id: row.id,
      rowid: Number(row.rowid),
      rank: i + 1,
      score: Number(row.score),
      eventKind: row.event_kind ?? null,
      source: row.source ?? null,
      streamKey: row.stream_key ?? null,
      ts: row.ts ?? null,
      matchedColumn: EVENTS_FTS_COLUMNS[index],
      snippet: pickSnippet(row, index),
      app: row.app ?? null,
      windowTitle: row.window_title ?? null,
      docKey: row.doc_key ?? null,
    };
  });
}

export interface ChunkLexicalOptions {
  limit?: number;
  kinds?: readonly ChunkKind[];
}

/** Ranked chunks (and cards) for an FTS5 MATCH expression, best first. */
export function searchChunksLexical(match: string, opts: ChunkLexicalOptions = {}): LexicalChunkHit[] {
  const expr = match.trim();
  if (expr.length === 0) return [];
  const kinds = (opts.kinds ?? CHUNK_KINDS).filter(isChunkKind);
  if (kinds.length === 0) return [];
  const rows = runMatch(
    () =>
      statements().chunks.all({
        match: expr,
        kinds: JSON.stringify([...new Set(kinds)]),
        limit: clampLimit(opts.limit, DEFAULT_LEXICAL_CHUNK_LIMIT),
      }) as RawChunkRow[],
  );
  return rows.map((row, i) => ({
    kind: "chunk",
    id: Number(row.id),
    rank: i + 1,
    score: Number(row.score),
    chunkKind: row.kind as ChunkKind,
    source: row.source ?? null,
    streamKey: row.stream_key ?? null,
    refId: row.ref_id ?? null,
    eventIds: parseIds(row.event_ids_json),
    tsStart: row.ts_start ?? null,
    tsEnd: row.ts_end ?? null,
    snippet: String(row.snippet ?? "").trim(),
  }));
}

// ---- Internals ------------------------------------------------------------------

interface RawEventRow {
  id: string;
  rowid: number;
  event_kind: string | null;
  source: string | null;
  stream_key: string | null;
  ts: string | null;
  app: string | null;
  window_title: string | null;
  doc_key: string | null;
  score: number;
  [scored: string]: unknown;
}

interface RawChunkRow {
  id: number;
  kind: string;
  source: string | null;
  stream_key: string | null;
  ref_id: string | null;
  event_ids_json: string | null;
  ts_start: string | null;
  ts_end: string | null;
  score: number;
  snippet: string | null;
}

/** An FTS5 syntax error is an empty method, not a failed question. */
function runMatch<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && /fts5|syntax error|unterminated string|no such column/i.test(err.message)) return [];
    throw err;
  }
}

/** The column whose own bm25, weighted, contributed most (0 = no match in it). */
function matchedColumnIndex(row: RawEventRow, weights: number[]): number {
  let best = 0;
  let bestScore = 0;
  for (let i = 0; i < EVENTS_FTS_COLUMNS.length; i++) {
    const raw = Number(row[`m${i}`]);
    if (!Number.isFinite(raw) || raw === 0) continue;
    const weighted = raw * weights[i];
    if (weighted < bestScore) {
      bestScore = weighted;
      best = i;
    }
  }
  return best;
}

function pickSnippet(row: RawEventRow, index: number): string {
  const at = (i: number): string => String(row[`s${i}`] ?? "").trim();
  const chosen = at(index);
  if (chosen.length > 0) return chosen;
  for (let i = 0; i < EVENTS_FTS_COLUMNS.length; i++) {
    const s = at(i);
    if (s.length > 0) return s;
  }
  return "";
}

function parseIds(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function clampLimit(raw: number | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LEXICAL_LIMIT);
}

/** Test hook: forget the prepared statements (the db handle changed). */
export function resetLexicalStatementsForTests(): void {
  stmts = null;
}
