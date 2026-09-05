// ===========================================================================
// [CODE] Bar type-ahead — T0, local, under 150 ms (Product_V6 §22 rule 1,
// Product_V6_Phase1 §"bar" rule 2, build S2.7).
//
// "Type-ahead is free": while the user types, the bar shows what the twin
// already holds — events, episodes, spaces (as `Space › Chapter` paths),
// tasks, people, claims — with NO model call. Everything here is a prefix
// match over the world model in SQLite:
//
//   events    FTS5 prefix query over `events_fts` (`"goa"* AND "vill"*`),
//             ranked by bm25; falls back to OR when AND finds nothing.
//             Archive-only rows (origin='archive', outside the UNDERSTAND
//             window) ARE returned — cited by their archive id, labelled
//             `searchable_only`, and they carry no episode (RET-04).
//   episodes  summary contains every token (LIKE); newest first.
//   spaces    `spaces_fts` prefix match on label/goal/exemplars, PLUS the
//             `Space › Chapter` path of every matched episode's chapter — the
//             villa thread files under Goa › Stay, so "goa vill" shows it.
//   tasks     title contains every token; open work before closed.
//   people    entities of type person whose canonical name has a word that
//             starts with a token; merged aliases excluded.
//   claims    the active version's text contains every token.
//
// Vector-over-the-partial-query is deliberately NOT here yet: the bounded
// candidate path lands with S2.4 (retrieval/semantic.ts) and plugs in through
// `TypeaheadOptions.semantic` without touching the lexical groups. `took_ms`
// and `model_calls: 0` ride on every result so the route and the bar can
// prove the budget was kept (BAR-01).
// ===========================================================================

import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";

type Statement = Database.Statement;

import { getDb } from "../db/connection.js";

/** The wall-clock budget the bar promises (Product_V6 §22 rule 1). */
export const TYPEAHEAD_BUDGET_MS = 150;

export interface TypeaheadEventHit {
  id: string;
  ts: string | null;
  actor: string | null;
  chat: string | null;
  snippet: string;
  /** Layer-1 archive row id (T5-1) — how an archive-only hit is cited. */
  archive_id: string | null;
  /** origin='archive': kept and searchable, never sent to the model (RET-04). */
  searchable_only: boolean;
  /** Episode the event is filed into; null for archive-only rows by construction. */
  episode_id: string | null;
}

export interface TypeaheadEpisodeHit {
  id: string;
  summary: string;
  space_id: string | null;
  chapter_id: string | null;
  state: string;
  last_ts: string | null;
}

export interface TypeaheadSpaceHit {
  id: string;
  /** `Goa dec trip` or `Goa dec trip › Stay` for a chapter path. */
  label: string;
  chapter_id: string | null;
}

export interface TypeaheadTaskHit {
  id: string;
  title: string;
  status: string;
  space_id: string | null;
}

export interface TypeaheadPersonHit {
  id: string;
  name: string;
}

export interface TypeaheadClaimHit {
  claim_key: string;
  text: string;
  kind: string | null;
  subject_id: string | null;
}

export interface TypeaheadResult {
  query: string;
  tokens: string[];
  /** Wall-clock of the whole lookup. */
  took_ms: number;
  /** Always 0 — type-ahead never reaches a model. */
  model_calls: 0;
  events: TypeaheadEventHit[];
  episodes: TypeaheadEpisodeHit[];
  spaces: TypeaheadSpaceHit[];
  tasks: TypeaheadTaskHit[];
  people: TypeaheadPersonHit[];
  claims: TypeaheadClaimHit[];
}

export interface TypeaheadOptions {
  /** Per-group cap (events get 2×). Default 6. */
  limit?: number;
  /**
   * Optional semantic candidates over the partial query (S2.4's bounded
   * path). Must be local and cheap; results are appended after the lexical
   * hits and deduped by id. Never a model call.
   */
  semantic?: (query: string, limit: number) => TypeaheadEventHit[];
}

const MAX_TOKENS = 6;
const MIN_TOKEN_CHARS = 2;

/** Lowercased alphanumeric tokens of ≥ 2 chars, at most six, in order, deduped. */
export function typeaheadTokens(query: string): string[] {
  const out: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const tok = raw
      .replace(/["']/g, "")
      .replace(/[^\p{L}\p{N}_-]+/gu, "")
      .toLowerCase();
    if (tok.length < MIN_TOKEN_CHARS || !/[\p{L}\p{N}]/u.test(tok)) continue;
    if (!out.includes(tok)) out.push(tok);
    if (out.length === MAX_TOKENS) break;
  }
  return out;
}

/** `"goa"* AND "vill"*` — every token as an FTS5 prefix, joined by `op`. */
export function typeaheadMatch(tokens: readonly string[], op: "AND" | "OR" = "AND"): string {
  return tokens.map((t) => `"${t}"*`).join(` ${op} `);
}

interface Stmts {
  db: ReturnType<typeof getDb>;
  events: Statement;
  episodes: Map<number, Statement>;
  spacesFts: Statement;
  chapterPath: Statement;
  tasks: Map<number, Statement>;
  people: Map<number, Statement>;
  claims: Map<number, Statement>;
}

let cached: Stmts | null = null;

function stmts(): Stmts {
  const db = getDb();
  if (cached && cached.db === db) return cached;
  cached = {
    db,
    events: db.prepare(
      `SELECT e.id, e.ts, e.origin,
              COALESCE(a.display_name, e.actor) AS actor,
              s.label        AS chat,
              s.external_key AS stream_key,
              snippet(events_fts, 0, '', '', '…', 12) AS snippet,
              (SELECT ar.id FROM archive ar WHERE ar.event_id = e.id LIMIT 1) AS archive_id,
              (SELECT ee.episode_id FROM episode_events ee WHERE ee.event_id = e.id LIMIT 1) AS episode_id
         FROM events_fts f
         JOIN events e ON e.rowid = f.rowid
         LEFT JOIN actors a  ON a.id = e.actor_id
         LEFT JOIN streams s ON s.id = e.stream_id
        WHERE events_fts MATCH @match
          AND e.revoked_at IS NULL
        ORDER BY bm25(events_fts)
        LIMIT @limit`,
    ),
    episodes: new Map(),
    spacesFts: db.prepare(
      `SELECT sp.id, sp.label
         FROM spaces_fts f
         JOIN spaces sp ON sp.id = f.space_id
        WHERE spaces_fts MATCH @match
          AND sp.status IN ('active', 'dormant')
        ORDER BY bm25(spaces_fts)
        LIMIT @limit`,
    ),
    chapterPath: db.prepare(
      `SELECT c.id AS chapter_id, c.label AS chapter_label, sp.id AS space_id, sp.label AS space_label
         FROM chapters c
         JOIN spaces sp ON sp.id = c.space_id
        WHERE c.id = ? AND c.status = 'active' AND sp.status IN ('active', 'dormant')`,
    ),
    tasks: new Map(),
    people: new Map(),
    claims: new Map(),
  };
  return cached;
}

/** Test seam: forget the prepared statements (a new DB path). */
export function resetTypeaheadForTests(): void {
  cached = null;
}

// `ESCAPE` binds to ONE `LIKE`, so it is emitted per clause, never once at the end.
const ESC = `ESCAPE '\\'`;

function likeAll(column: string, n: number): string {
  return Array.from({ length: n }, () => `${column} LIKE ? ${ESC}`).join(" AND ");
}

function likeWordPrefix(column: string, n: number): string {
  return Array.from({ length: n }, () => `(${column} LIKE ? ${ESC} OR ${column} LIKE ? ${ESC})`).join(" OR ");
}

function prepared(map: Map<number, Statement>, n: number, sql: () => string): Statement {
  let s = map.get(n);
  if (!s) {
    s = stmts().db.prepare(sql());
    map.set(n, s);
  }
  return s;
}

function containsParams(tokens: readonly string[]): string[] {
  return tokens.map((t) => `%${escapeLike(t)}%`);
}

function wordPrefixParams(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) out.push(`${escapeLike(t)}%`, `% ${escapeLike(t)}%`);
  return out;
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => `\\${c}`);
}

interface RawEvent {
  id: string;
  ts: string | null;
  origin: string | null;
  actor: string | null;
  chat: string | null;
  stream_key: string | null;
  snippet: string | null;
  archive_id: string | null;
  episode_id: string | null;
}

function toEventHit(r: RawEvent): TypeaheadEventHit {
  const archiveOnly = r.origin === "archive";
  return {
    id: r.id,
    ts: r.ts,
    actor: r.actor,
    chat: r.chat ?? r.stream_key,
    snippet: (r.snippet ?? "").slice(0, 200),
    archive_id: r.archive_id,
    searchable_only: archiveOnly,
    // An archive-only row was never dispatched, so no pass could file it; the
    // label is the contract, the null is the fact (RET-04).
    episode_id: archiveOnly ? null : r.episode_id,
  };
}

function searchEvents(tokens: readonly string[], limit: number): TypeaheadEventHit[] {
  const s = stmts();
  const run = (op: "AND" | "OR"): RawEvent[] => {
    try {
      return s.events.all({ match: typeaheadMatch(tokens, op), limit }) as RawEvent[];
    } catch {
      // A pathological MATCH string must never break the bar — no hits.
      return [];
    }
  };
  let rows = run("AND");
  if (rows.length === 0 && tokens.length > 1) rows = run("OR");
  return rows.map(toEventHit);
}

interface RawEpisode {
  id: string;
  summary: string;
  space_id: string | null;
  chapter_id: string | null;
  state: string;
  last_ts: string | null;
}

function searchEpisodes(tokens: readonly string[], limit: number): TypeaheadEpisodeHit[] {
  const stmt = prepared(
    stmts().episodes,
    tokens.length,
    () =>
      `SELECT id, summary, space_id, chapter_id, state, last_ts
         FROM episodes
        WHERE summary IS NOT NULL AND ${likeAll("summary", tokens.length)}
        ORDER BY last_ts DESC
        LIMIT ?`,
  );
  return (stmt.all(...containsParams(tokens), limit) as RawEpisode[]).map((r) => ({
    id: r.id,
    summary: r.summary,
    space_id: r.space_id,
    chapter_id: r.chapter_id,
    state: r.state,
    last_ts: r.last_ts,
  }));
}

function searchSpaces(
  tokens: readonly string[],
  episodes: readonly TypeaheadEpisodeHit[],
  limit: number,
): TypeaheadSpaceHit[] {
  const s = stmts();
  const out: TypeaheadSpaceHit[] = [];
  const seen = new Set<string>();
  // Chapter paths of the matched episodes first: they are the most specific
  // thing the partial query already points at ("Goa › Stay").
  for (const ep of episodes) {
    if (!ep.chapter_id) continue;
    const key = `ch:${ep.chapter_id}`;
    if (seen.has(key)) continue;
    const row = s.chapterPath.get(ep.chapter_id) as
      | { chapter_id: string; chapter_label: string; space_id: string; space_label: string }
      | undefined;
    if (!row) continue;
    seen.add(key);
    out.push({ id: row.space_id, label: `${row.space_label} › ${row.chapter_label}`, chapter_id: row.chapter_id });
    if (out.length >= limit) return out;
  }
  let rows: { id: string; label: string }[] = [];
  try {
    rows = s.spacesFts.all({ match: typeaheadMatch(tokens, "OR"), limit }) as { id: string; label: string }[];
  } catch {
    rows = [];
  }
  for (const r of rows) {
    if (seen.has(`sp:${r.id}`)) continue;
    seen.add(`sp:${r.id}`);
    out.push({ id: r.id, label: r.label, chapter_id: null });
    if (out.length >= limit) break;
  }
  return out;
}

function searchTasks(tokens: readonly string[], limit: number): TypeaheadTaskHit[] {
  const stmt = prepared(
    stmts().tasks,
    tokens.length,
    () =>
      `SELECT id, title, status, space_id
         FROM tasks
        WHERE ${likeAll("title", tokens.length)}
        ORDER BY CASE WHEN status IN ('done', 'cancelled', 'dismissed') THEN 1 ELSE 0 END,
                 COALESCE(due, created_at) DESC
        LIMIT ?`,
  );
  return stmt.all(...containsParams(tokens), limit) as TypeaheadTaskHit[];
}

function searchPeople(tokens: readonly string[], limit: number): TypeaheadPersonHit[] {
  const stmt = prepared(
    stmts().people,
    tokens.length,
    () =>
      `SELECT id, canonical AS name
         FROM entities
        WHERE type = 'person' AND merged_into IS NULL AND canonical IS NOT NULL
          AND (${likeWordPrefix("canonical", tokens.length)})
        ORDER BY user_pinned DESC, provisional ASC, last_seen_at DESC
        LIMIT ?`,
  );
  return stmt.all(...wordPrefixParams(tokens), limit) as TypeaheadPersonHit[];
}

function searchClaims(tokens: readonly string[], limit: number): TypeaheadClaimHit[] {
  const stmt = prepared(
    stmts().claims,
    tokens.length,
    () =>
      `SELECT c.claim_key, v.text, c.kind, c.subject_id
         FROM claims c
         JOIN claim_versions v ON v.id = c.active_version_id
        WHERE c.status = 'active' AND v.text IS NOT NULL
          AND ${likeAll("v.text", tokens.length)}
        ORDER BY c.last_stated_at DESC
        LIMIT ?`,
  );
  return stmt.all(...containsParams(tokens), limit) as TypeaheadClaimHit[];
}

function empty(query: string, tokens: string[], startedAt: number): TypeaheadResult {
  return {
    query,
    tokens,
    took_ms: round(performance.now() - startedAt),
    model_calls: 0,
    events: [],
    episodes: [],
    spaces: [],
    tasks: [],
    people: [],
    claims: [],
  };
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/**
 * The type-ahead for one partial query. Synchronous, SQLite only, no model.
 * An empty or all-noise query returns empty groups in ~0 ms.
 */
export function typeahead(query: string, options: TypeaheadOptions = {}): TypeaheadResult {
  const startedAt = performance.now();
  const tokens = typeaheadTokens(query);
  if (tokens.length === 0) return empty(query, tokens, startedAt);
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 6)));

  const events = searchEvents(tokens, limit * 2);
  if (options.semantic) {
    const seen = new Set(events.map((e) => e.id));
    for (const hit of options.semantic(query, limit)) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      events.push(hit);
      if (events.length >= limit * 2) break;
    }
  }
  const episodes = searchEpisodes(tokens, limit);
  const spaces = searchSpaces(tokens, episodes, limit);
  const tasks = searchTasks(tokens, limit);
  const people = searchPeople(tokens, limit);
  const claims = searchClaims(tokens, limit);

  return {
    query,
    tokens,
    took_ms: round(performance.now() - startedAt),
    model_calls: 0,
    events,
    episodes,
    spaces,
    tasks,
    people,
    claims,
  };
}
