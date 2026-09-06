// ===========================================================================
// [CODE] Bar retrieval — the plan route.v1 wrote, executed by code
// (Product_V6 Phase 1 §19 rule 3, §20; Build S5.5).
//
//   plan.methods → lexical ∪ vector ∪ structured ∪ graph ∪ time_window
//                → RRF (k = 60) over the id lists
//                → hydrate the fused top window as passages
//                → cross-encoder over the window (the RRF order stands when
//                  there is none)
//
// What each method contributes is an ORDERED ID LIST; the fusion never sees a
// score, so bm25, cosine, a graph walk and a SQL enumeration can share one
// ranking. Structured keeps its VALUE beside the list — an aggregate is never
// answered from the top-k (BAR-04), the rows are for citation. Time-window
// keeps its `complete` flag — an absence answer over a truncated scan is not
// an absence answer (BAR-05).
//
// Zero model calls. Never a full vector scan (the vector list comes from
// semantic.ts's bounded path). Never writes.
// ===========================================================================

import { activeClaim } from "../claims/store.js";
import { getDb } from "../db/connection.js";
import { readEventsByIds, type ContextEventRow } from "../db/retrieval.js";
import { listEntities } from "../entities/registry.js";
import type { RoutePlan, RouteMethod } from "../prompts/route.v1.js";
import { graphRetrieve, type GraphHit } from "../retrieval/graph.js";
import { lexicalSearch } from "../retrieval/lexical.js";
import { getReranker, type Reranker } from "../retrieval/reranker.js";
import { hybridSearch, rrfFuse, RRF_K } from "../retrieval/semantic.js";
import {
  planStructured,
  structuredQuery,
  type StructuredFilters,
  type StructuredQuery,
  type StructuredResult,
} from "../retrieval/structured.js";
import { timeWindowScan, type TimeWindowResult } from "../retrieval/time-window.js";

/** Fused rows hydrated and handed to the reranker / judge. */
export const BAR_FUSE_WINDOW = 50;
/** Passages the judge sees (P-09: "10 candidate passages"). */
export const JUDGE_WINDOW = 10;

export type PassageKind = "event" | "claim" | "episode";

export interface BarPassage {
  /** `event:<id>` · `claim:<key>` · `episode:<id>` — the fusion key. */
  key: string;
  kind: PassageKind;
  id: string;
  text: string;
  ts: string | null;
  actor: string | null;
  stream: string | null;
  source: string | null;
  /** Which methods returned it. */
  methods: RouteMethod[];
  rrf: number;
  rerank: number | null;
  /** Ordering score: rerank when it ran on this row, else rrf. */
  score: number;
}

export interface BarRetrieval {
  plan: RoutePlan;
  methods_ran: RouteMethod[];
  /** Fused, hydrated, reranked — best first. */
  candidates: BarPassage[];
  structured: StructuredResult | null;
  time_window: TimeWindowResult | null;
  graph: { seeds: number; hits: number; expanded: number } | null;
  counts: { lexical: number; vector: number; structured: number; graph: number; time_window: number };
  /** Stream keys the plan's stream filter resolved to (absence scans name them). */
  stream_keys: string[];
  reranker: string | null;
  took_ms: number;
}

export interface ExecutePlanOptions {
  now?: Date;
  /** Injected reranker (tests); undefined = the registered/loaded one; null = none. */
  reranker?: Reranker | null;
  window?: number;
  /**
   * Rows an ENUMERATION returns (structured `op: "list"`). The surface's page
   * size, not a retrieval limit: what it cuts is reported as incomplete, and
   * the answer then says "N so far, list may be incomplete" (BAR-06).
   */
  listLimit?: number;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * A stream hint from the plan ("wa:goa-gang", "goa gang", a jid) → the stream
 * keys events carry. Exact key first; then a stream label match; then a
 * substring on the key. Empty when nothing resolves — the method then runs
 * unfiltered rather than over nothing.
 */
export function resolveStreamKeys(hint: string | undefined): string[] {
  if (!hint || hint.trim() === "") return [];
  const db = getDb();
  const h = hint.trim();
  const exact = db.prepare(`SELECT 1 FROM events WHERE stream_key = ? LIMIT 1`).get(h);
  if (exact) return [h];
  const bare = h.replace(/^[a-z]+:/i, "").replace(/[-_]+/g, " ").trim();
  const byLabel = db
    .prepare(
      `SELECT DISTINCT e.stream_key AS k FROM events e JOIN streams s ON s.id = e.stream_id
        WHERE e.stream_key IS NOT NULL AND (s.label LIKE ? OR s.external_key LIKE ?) LIMIT 8`,
    )
    .all(`%${bare}%`, `%${bare}%`) as { k: string }[];
  if (byLabel.length > 0) return byLabel.map((r) => r.k);
  const byKey = db
    .prepare(`SELECT DISTINCT stream_key AS k FROM events WHERE stream_key LIKE ? LIMIT 8`)
    .all(`%${bare.replace(/\s+/g, "%")}%`) as { k: string }[];
  return byKey.map((r) => r.k);
}

function sourceOfStreamKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const m = /^([a-z]+):/i.exec(key);
  return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

function keyOf(kind: PassageKind, id: string): string {
  return `${kind}:${id}`;
}

function eventKeysFiltered(ids: readonly string[], streamKeys: ReadonlySet<string>): string[] {
  if (streamKeys.size === 0) return ids.map((id) => keyOf("event", id));
  const rows = readEventsByIds([...ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const streamOf = streamKeyMap(ids);
  return ids
    .filter((id) => byId.has(id) && streamKeys.has(streamOf.get(id) ?? ""))
    .map((id) => keyOf("event", id));
}

/** events.id → stream_key for a batch (ContextEventRow does not carry it). */
function streamKeyMap(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const db = getDb();
  for (let i = 0; i < ids.length; i += 400) {
    const slice = ids.slice(i, i + 400);
    const rows = db
      .prepare(`SELECT id, stream_key, source_type FROM events WHERE id IN (${slice.map(() => "?").join(",")})`)
      .all(...slice) as { id: string; stream_key: string | null; source_type: string | null }[];
    for (const r of rows) out.set(r.id, r.stream_key ?? "");
  }
  return out;
}

function runLexical(text: string, now: Date, streamKeys: ReadonlySet<string>): string[] {
  const res = lexicalSearch(text, { now });
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const h of res.events) {
    if (!seen.has(h.id)) {
      seen.add(h.id);
      ids.push(h.id);
    }
  }
  // Card chunks (episode / claim / person) ride in as their own passages.
  const cards: string[] = [];
  for (const c of res.chunks) {
    if (c.chunkKind === "episode" && c.refId) cards.push(keyOf("episode", c.refId));
    else if (c.chunkKind === "claim" && c.refId) cards.push(keyOf("claim", c.refId));
    else for (const id of c.eventIds) if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return [...eventKeysFiltered(ids, streamKeys), ...cards];
}

async function runVector(text: string, now: Date, streamKeys: ReadonlySet<string>): Promise<string[]> {
  const hits = await hybridSearch(text, { now, rerank: false, limit: BAR_FUSE_WINDOW });
  const vector = hits
    .filter((h) => h.vectorRank !== null)
    .sort((a, b) => (a.vectorRank ?? 0) - (b.vectorRank ?? 0))
    .map((h) => h.eventId);
  return eventKeysFiltered(vector, streamKeys);
}

/** The structured query the plan implies when the deterministic planner sees none. */
export function structuredFromPlan(text: string, plan: RoutePlan, now: Date): StructuredQuery | null {
  const own = planStructured(text, now);
  if (own) {
    const q = own.query;
    if (plan.filters.merchant_in && !q.filters?.merchant) q.filters = { ...(q.filters ?? {}), merchant: plan.filters.merchant_in };
    if (plan.time && !q.filters?.dateFrom) {
      q.filters = { ...(q.filters ?? {}), dateFrom: plan.time.from.slice(0, 10), dateTo: plan.time.to.slice(0, 10) };
    }
    return q;
  }
  const lower = text.toLowerCase();
  const filters: StructuredFilters = {};
  if (plan.filters.merchant_in) filters.merchant = plan.filters.merchant_in;
  if (plan.time) {
    filters.dateFrom = plan.time.from.slice(0, 10);
    filters.dateTo = plan.time.to.slice(0, 10);
  }
  if (plan.filters.kind && ["fact", "preference", "habit", "recommendation"].includes(plan.filters.kind)) {
    filters.kind = plan.filters.kind as StructuredFilters["kind"];
  }
  if (!filters.merchant && !filters.dateFrom && !filters.kind) return null;
  const op: StructuredQuery["op"] = /\bhow many|count\b/.test(lower)
    ? "count"
    : /\blist|all (?:the|my)|which\b/.test(lower)
      ? "list"
      : "sum";
  return { op, ...(op === "sum" ? { field: "amount" as const } : {}), filters };
}

function runStructured(text: string, plan: RoutePlan, now: Date, listLimit?: number): StructuredResult | null {
  const q = structuredFromPlan(text, plan, now);
  if (!q) return null;
  try {
    return structuredQuery(q.op === "list" && listLimit ? { ...q, limit: listLimit } : q);
  } catch {
    return null;
  }
}

/** Entity ids the plan's seeds / entities name (canonical or alias match). */
export function resolveSeedEntities(names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const wanted = names.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 2);
  if (wanted.length === 0) return [];
  const out: string[] = [];
  for (const e of listEntities()) {
    const canon = (e.canonical ?? "").toLowerCase();
    if (canon === "") continue;
    const first = canon.split(/\s+/)[0];
    if (wanted.some((w) => w === canon || w === first || canon.startsWith(`${w} `))) out.push(e.id);
    if (out.length >= 6) break;
  }
  return out;
}

function runGraph(plan: RoutePlan, now: Date, lexicalEventIds: readonly string[]): { keys: string[]; stats: BarRetrieval["graph"] } {
  const entityIds = resolveSeedEntities([...plan.seeds, ...plan.entities]);
  const eventIds = lexicalEventIds.slice(0, 5);
  if (entityIds.length === 0 && eventIds.length === 0) return { keys: [], stats: { seeds: 0, hits: 0, expanded: 0 } };
  let hits: GraphHit[] = [];
  let seeds = 0;
  let expanded = 0;
  try {
    const walk = graphRetrieve({ entityIds, eventIds }, { now: now.toISOString(), expandEntityEvents: true, expandEpisodeMembers: true });
    hits = walk.hits;
    seeds = walk.seeds.length;
    expanded = walk.expanded;
  } catch {
    hits = [];
  }
  const keys: string[] = [];
  for (const h of hits) {
    if (h.node.kind === "event") keys.push(keyOf("event", h.node.id));
    else if (h.node.kind === "episode") keys.push(keyOf("episode", h.node.id));
    else if (h.node.kind === "claim") keys.push(keyOf("claim", h.node.id));
  }
  return { keys, stats: { seeds, hits: hits.length, expanded } };
}

function runTimeWindow(plan: RoutePlan, streamKeys: readonly string[]): TimeWindowResult | null {
  if (!plan.time) return null;
  try {
    return timeWindowScan({
      window: { fromIso: plan.time.from, toIso: plan.time.to },
      ...(streamKeys.length > 0 ? { streamKeys } : {}),
      ...(plan.filters.source ? { sources: [plan.filters.source] } : {}),
      limit: plan.completeness === "exhaustive" ? 5_000 : 500,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

function textOf(row: ContextEventRow): string {
  for (const c of [row.text, row.transcript, row.mediaDescription, row.linkTitle]) {
    if (c && c.trim() !== "") return c.trim();
  }
  return "";
}

function hydrate(keys: readonly string[], methodsByKey: ReadonlyMap<string, Set<RouteMethod>>, rrf: ReadonlyMap<string, number>): BarPassage[] {
  const eventIds = keys.filter((k) => k.startsWith("event:")).map((k) => k.slice(6));
  const rows = new Map(readEventsByIds(eventIds).map((r) => [r.id, r]));
  const streams = streamKeyMap(eventIds);
  const sources = new Map<string, string | null>();
  if (eventIds.length > 0) {
    const db = getDb();
    for (let i = 0; i < eventIds.length; i += 400) {
      const slice = eventIds.slice(i, i + 400);
      for (const r of db
        .prepare(`SELECT id, source_type FROM events WHERE id IN (${slice.map(() => "?").join(",")})`)
        .all(...slice) as { id: string; source_type: string | null }[]) {
        sources.set(r.id, r.source_type);
      }
    }
  }
  const out: BarPassage[] = [];
  for (const key of keys) {
    const methods = [...(methodsByKey.get(key) ?? [])];
    const score = rrf.get(key) ?? 0;
    if (key.startsWith("event:")) {
      const id = key.slice(6);
      const row = rows.get(id);
      if (!row) continue;
      const text = textOf(row);
      if (text === "") continue;
      out.push({
        key,
        kind: "event",
        id,
        text,
        ts: row.ts,
        actor: row.fromMe ? "you" : row.actorName,
        stream: streams.get(id) ?? row.channelName,
        source: sources.get(id) ?? sourceOfStreamKey(streams.get(id)),
        methods,
        rrf: score,
        rerank: null,
        score,
      });
    } else if (key.startsWith("claim:")) {
      const id = key.slice(6);
      const c = activeClaim(id);
      if (!c || !c.text) continue;
      out.push({ key, kind: "claim", id, text: c.text, ts: c.statedAt, actor: null, stream: null, source: null, methods, rrf: score, rerank: null, score });
    } else if (key.startsWith("episode:")) {
      const id = key.slice(8);
      const ep = getDb().prepare(`SELECT summary, last_ts FROM episodes WHERE id = ?`).get(id) as
        | { summary: string | null; last_ts: string | null }
        | undefined;
      if (!ep?.summary) continue;
      out.push({ key, kind: "episode", id, text: ep.summary, ts: ep.last_ts, actor: null, stream: null, source: null, methods, rrf: score, rerank: null, score });
    }
  }
  return out;
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function executePlan(text: string, plan: RoutePlan, opts: ExecutePlanOptions = {}): Promise<BarRetrieval> {
  const started = performance.now();
  const now = opts.now ?? new Date();
  const window = Math.max(1, Math.min(opts.window ?? BAR_FUSE_WINDOW, 500));
  const methods = new Set<RouteMethod>(plan.methods);
  // Structured is exhaustive by nature; an aggregate class always runs it,
  // whatever the plan said (BAR-04: never from the top-k).
  if (plan.class === "aggregate") methods.add("structured");
  if (plan.class === "absence" && plan.time) methods.add("time_window");
  if (plan.class === "temporal" && plan.time) methods.add("time_window");

  const streamKeyList = resolveStreamKeys(plan.filters.stream);
  const streamKeys = new Set(streamKeyList);
  const ran: RouteMethod[] = [];
  const lists: { method: RouteMethod; keys: string[] }[] = [];
  const counts = { lexical: 0, vector: 0, structured: 0, graph: 0, time_window: 0 };

  let lexicalKeys: string[] = [];
  if (methods.has("lexical")) {
    lexicalKeys = runLexical(text, now, streamKeys);
    lists.push({ method: "lexical", keys: lexicalKeys });
    counts.lexical = lexicalKeys.length;
    ran.push("lexical");
  }
  if (methods.has("vector")) {
    const keys = await runVector(text, now, streamKeys);
    lists.push({ method: "vector", keys });
    counts.vector = keys.length;
    ran.push("vector");
  }
  let structured: StructuredResult | null = null;
  if (methods.has("structured")) {
    structured = runStructured(text, plan, now, opts.listLimit);
    ran.push("structured");
    if (structured) {
      const keys = structured.rows.map((r) => keyOf("claim", r.claimKey));
      lists.push({ method: "structured", keys });
      counts.structured = structured.rowCount;
    }
  }
  let graph: BarRetrieval["graph"] = null;
  if (methods.has("graph")) {
    const g = runGraph(plan, now, lexicalKeys.filter((k) => k.startsWith("event:")).map((k) => k.slice(6)));
    graph = g.stats;
    lists.push({ method: "graph", keys: g.keys });
    counts.graph = g.keys.length;
    ran.push("graph");
  }
  let timeWindow: TimeWindowResult | null = null;
  if (methods.has("time_window")) {
    timeWindow = runTimeWindow(plan, streamKeyList);
    ran.push("time_window");
    if (timeWindow) {
      counts.time_window = timeWindow.count;
      // The window is a SET, not a ranking: most recent first so a tie in the
      // fusion prefers the latest word. Lexical hits inside it rank above
      // the rest through their own list.
      const keys = [...timeWindow.events].reverse().map((e) => keyOf("event", e.id));
      lists.push({ method: "time_window", keys });
    }
  }

  const fused = rrfFuse(lists.map((l) => l.keys), RRF_K);
  const methodsByKey = new Map<string, Set<RouteMethod>>();
  for (const l of lists) {
    for (const k of l.keys) {
      if (!methodsByKey.has(k)) methodsByKey.set(k, new Set());
      methodsByKey.get(k)!.add(l.method);
    }
  }
  const ordered = [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, window)
    .map(([k]) => k);
  const candidates = hydrate(ordered, methodsByKey, fused);

  // The cross-encoder over the window; the RRF order stands without one.
  let rerankerName: string | null = null;
  const reranker = opts.reranker === undefined ? await getReranker().catch(() => null) : opts.reranker;
  if (reranker && candidates.length > 0) {
    try {
      const scores = await reranker.score(text, candidates.map((c) => c.text));
      if (scores.length === candidates.length) {
        candidates.forEach((c, i) => {
          c.rerank = clamp01(scores[i]);
          c.score = c.rerank;
        });
        candidates.sort((a, b) => b.score - a.score || b.rrf - a.rrf);
        rerankerName = reranker.model;
      }
    } catch {
      // keep the fused order
    }
  }

  return {
    plan,
    methods_ran: ran,
    candidates,
    structured,
    time_window: timeWindow,
    graph,
    counts,
    stream_keys: streamKeyList,
    reranker: rerankerName,
    took_ms: Math.round(performance.now() - started),
  };
}
