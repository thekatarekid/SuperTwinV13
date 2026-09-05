// ===========================================================================
// [CODE] Graph retrieval — the bounded BFS walk (V6 P1 S2.6; Build §5.2,
// Product_V6 §23.5, Product_V6_Phase1 §20, retrieval decision record §8 and
// items 5–6).
//
//   seeds (from lexical + vector)        hop 1                  hop 2
//    ◉ Ma ──── related_to:mother ─────► ◉ self   ✗ hub, excluded
//      └────── mentioned_in ──────────► ◉ ep_882 ─ about ─────► ◉ Diwali gifts
//      └────── claim:preference ──────► ◉ "prefers jasmine tea"
//    ◉ e_wa ── bridge:url ────────────► ◉ e_browser ─ member_of ► ◉ ep_villa
//
//    score = hop decay × edge confidence × evidence recency
//    superseded and expired edges skipped · fan-out capped per node · hubs
//    never entered
//
// WHAT WALKS. Four node kinds, one store (SQLite), one edge abstraction:
//
//   entity   entity_edges (kind:subtype, status/validity pruned in SQL, fan-out
//            capped, hub neighbours dropped before the cap — db/v6graph
//            neighborEdges) · mentioned_in → episodes through `mentions` ×
//            episode membership · claim:<kind> → the entity's active claims.
//   episode  about → the entities its member events mention · claim:<kind> →
//            claims stated in it · (opt) member → its events.
//   event    bridge:<kind> → events sharing a literal (bridges/edges.ts) ·
//            member_of → its episode · mentions → entities.
//   claim    subject → its entity · stated_in → its episode.
//
// The walk is a ~100-line loop in TypeScript over prepared statements, as the
// decision record prefers: per-node fan-out capping and cycle detection are
// awkward in a recursive CTE, and `better-sqlite3` is in-process, so the
// round-trips are free. Level-synchronous: every node of hop h is scored
// (max over its parents) before hop h+1 expands, and a node expands once, at
// the first hop it is reached. Seeds are hop 0 and never returned as hits.
//
// HUBS. `hub_nodes` (self seeded by 0201) are never entered and never
// expanded — a seed that is a hub contributes nothing. Without this the user
// connects to everything and a two-hop walk returns half the graph (RET-09's
// `hub-walk`).
//
// Zero model calls. Never writes. Cites by id. Deterministic for a fixed
// `now`: ties break on hop, then node key.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { hubIds, neighborEdges, type ChunkRow, type WalkEdge } from "../db/v6graph.js";
import { bridgeEdgesOf, GRAPH_BRIDGE_KINDS } from "../bridges/edges.js";
import { resolveEntityId } from "../entities/registry.js";

// ---- Types -------------------------------------------------------------------

export const GRAPH_NODE_KINDS = ["entity", "episode", "event", "claim"] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export interface GraphNodeRef {
  kind: GraphNodeKind;
  id: string;
}

export interface GraphStep {
  /** `related_to:mother` · `mentioned_in` · `about` · `bridge:url` · `claim:preference` … */
  edge: string;
  from: GraphNodeRef;
  to: GraphNodeRef;
  confidence: number;
  recency: number;
}

export interface GraphHit {
  node: GraphNodeRef;
  /** `entity:ent_…` — the dedupe key. */
  key: string;
  hop: number;
  score: number;
  /** Best-scoring path from a seed, seed first. */
  path: GraphStep[];
  /** Entity canonical · episode summary · event text head · claim text. */
  label: string | null;
}

export interface GraphWalkOptions {
  /** ≤ this many hops from a seed. Default 2 (§23.5: two to three; P1 fixes 2). */
  maxHops?: number;
  /** Per-hop multiplier. Default 0.6. */
  decay?: number;
  /** Edges expanded per node, best confidence first. Default 20. */
  fanOut?: number;
  /** Drop a node whose score falls under this. Default 0.05. */
  minScore?: number;
  /** Hits returned. Default 30. */
  limit?: number;
  /** ISO instant edges must be valid at and recency is measured from. Default now. */
  now?: string;
  /** Restrict entity_edges to these kinds. Default all seven. */
  edgeKinds?: readonly string[];
  /** Restrict bridge edges to these kinds. Default GRAPH_BRIDGE_KINDS. */
  bridgeKinds?: readonly string[];
  /** Half-life of the evidence-recency factor, days. Default 365. */
  recencyHalfLifeDays?: number;
  /** Also expand entity → the events that mention it. Default false (fan-out noise). */
  expandEntityEvents?: boolean;
  /** Also expand episode → its member events. Default false. */
  expandEpisodeMembers?: boolean;
}

export const GRAPH_DEFAULTS = {
  maxHops: 2,
  decay: 0.6,
  fanOut: 20,
  minScore: 0.05,
  limit: 30,
  recencyHalfLifeDays: 365,
  /** Recency never drops an edge below a quarter of its weight. */
  recencyFloor: 0.25,
} as const;

export interface GraphWalkResult {
  hits: GraphHit[];
  /** Seeds after hub removal and dedupe, in expansion order. */
  seeds: GraphNodeRef[];
  /** Nodes whose neighbourhood was read. */
  expanded: number;
  /** Edges read across all hops (after SQL-side pruning). */
  edgesRead: number;
  /** Neighbours dropped because they were hubs, or under minScore. */
  pruned: { hubs: number; score: number };
}

// ---- Node keys ---------------------------------------------------------------

export function nodeKey(n: GraphNodeRef): string {
  return `${n.kind}:${n.id}`;
}

export function parseNodeKey(key: string): GraphNodeRef | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const kind = key.slice(0, i);
  if (!(GRAPH_NODE_KINDS as readonly string[]).includes(kind)) return null;
  const id = key.slice(i + 1);
  return id ? { kind: kind as GraphNodeKind, id } : null;
}

// ---- Recency -----------------------------------------------------------------

/**
 * 2^(-age/halfLife), floored — evidence from last month weighs a little more
 * than evidence from three years ago, never nothing. Unknown ts = 1.
 */
export function recencyWeight(ts: string | null | undefined, now: string, halfLifeDays: number = GRAPH_DEFAULTS.recencyHalfLifeDays): number {
  if (!ts) return 1;
  const t = Date.parse(ts);
  const n = Date.parse(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return 1;
  const ageDays = (n - t) / 86_400_000;
  if (ageDays <= 0) return 1;
  return Math.max(GRAPH_DEFAULTS.recencyFloor, Math.pow(2, -ageDays / Math.max(1, halfLifeDays)));
}

// ---- Seeds -------------------------------------------------------------------

export interface SeedInput {
  entityIds?: readonly string[];
  eventIds?: readonly string[];
  episodeIds?: readonly string[];
  claimKeys?: readonly string[];
  /** Chunk hits from lexical/vector: their event ids and card refs become seeds. */
  chunks?: readonly ChunkRow[];
}

/**
 * Turn what lexical and vector returned into graph seeds. Chunks of chat /
 * screen / browser seed their events; card chunks (person, episode, claim)
 * seed the card's ref. Entity ids are merge-resolved. Order is preserved,
 * duplicates dropped.
 */
export function seedsFromHits(input: SeedInput): GraphNodeRef[] {
  const out: GraphNodeRef[] = [];
  const seen = new Set<string>();
  const push = (n: GraphNodeRef): void => {
    const k = nodeKey(n);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(n);
  };
  for (const id of input.entityIds ?? []) {
    const r = resolveEntityId(id);
    if (r) push({ kind: "entity", id: r });
  }
  for (const id of input.eventIds ?? []) push({ kind: "event", id });
  for (const id of input.episodeIds ?? []) push({ kind: "episode", id });
  for (const id of input.claimKeys ?? []) push({ kind: "claim", id });
  for (const c of input.chunks ?? []) {
    switch (c.kind) {
      case "person": {
        if (c.refId) {
          const r = resolveEntityId(c.refId);
          if (r) push({ kind: "entity", id: r });
        }
        break;
      }
      case "episode":
        if (c.refId) push({ kind: "episode", id: c.refId });
        break;
      case "claim":
        if (c.refId) push({ kind: "claim", id: c.refId });
        break;
      default:
        for (const id of c.eventIds) push({ kind: "event", id });
    }
  }
  return out;
}

// ---- Neighbourhood -----------------------------------------------------------

interface Neighbour {
  to: GraphNodeRef;
  edge: string;
  confidence: number;
  /** ISO ts of the evidence behind the edge, when known. */
  evidenceTs: string | null;
}

interface Ctx {
  now: string;
  fanOut: number;
  edgeKinds: readonly string[] | undefined;
  bridgeKinds: readonly string[];
  hubs: Set<string>;
  expandEntityEvents: boolean;
  expandEpisodeMembers: boolean;
  pruned: { hubs: number; score: number };
}

const EPISODE_MEMBER_JOIN = `(ee.event_id = ev.id OR ee.start_event_id = ev.id OR ee.end_event_id = ev.id)`;

function evidenceTsFor(edges: readonly WalkEdge[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (edges.length === 0) return out;
  const ids = edges.map((e) => e.id);
  const rows = getDb()
    .prepare(
      `SELECT ee.edge_id, MAX(ev.ts) AS ts FROM edge_evidence ee JOIN events ev ON ev.id = ee.event_id
        WHERE ee.edge_id IN (${ids.map(() => "?").join(",")}) GROUP BY ee.edge_id`,
    )
    .all(...ids) as { edge_id: string; ts: string | null }[];
  for (const r of rows) out.set(r.edge_id, r.ts);
  return out;
}

/** Live entity_edges from `id` whose far end is a hub — what the SQL side dropped. */
function countHubNeighbours(id: string, ctx: Ctx): number {
  const kinds = ctx.edgeKinds;
  const kindClause = kinds ? ` AND e.kind IN (${kinds.map(() => "?").join(",")})` : "";
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM entity_edges e
        WHERE (e.src_entity_id = ? OR e.dst_entity_id = ?) AND e.status = 'active'
          AND (e.valid_from IS NULL OR e.valid_from <= ?) AND (e.valid_to IS NULL OR e.valid_to > ?)${kindClause}
          AND EXISTS (SELECT 1 FROM hub_nodes h
                       WHERE h.entity_id = CASE WHEN e.src_entity_id = ? THEN e.dst_entity_id ELSE e.src_entity_id END)`,
    )
    .get(id, id, ctx.now, ctx.now, ...(kinds ?? []), id) as { n: number };
  return r.n;
}

function entityNeighbours(id: string, ctx: Ctx): Neighbour[] {
  const out: Neighbour[] = [];
  const db = getDb();

  // 1. entity_edges — active, valid at now, hubs dropped before the cap.
  const edges = neighborEdges(id, { now: ctx.now, kinds: ctx.edgeKinds, fanOut: ctx.fanOut, excludeHubs: true });
  ctx.pruned.hubs += countHubNeighbours(id, ctx);
  const ts = evidenceTsFor(edges);
  for (const e of edges) {
    out.push({
      to: { kind: "entity", id: e.neighborId },
      edge: e.subtype ? `${e.kind}:${e.subtype}` : e.kind,
      confidence: e.confidence,
      evidenceTs: ts.get(e.id) ?? null,
    });
  }

  // 2. mentioned_in → episodes the entity's mentions fall in, newest first.
  const eps = db
    .prepare(
      `SELECT ep.id, ep.last_ts, MAX(COALESCE(m.confidence, 1)) AS conf
         FROM mentions m
         JOIN events ev ON ev.id = m.event_id
         JOIN episode_events ee ON ${EPISODE_MEMBER_JOIN}
         JOIN episodes ep ON ep.id = ee.episode_id
        WHERE m.entity_id = ?
        GROUP BY ep.id
        ORDER BY conf DESC, ep.last_ts DESC, ep.id ASC
        LIMIT ?`,
    )
    .all(id, ctx.fanOut) as { id: string; last_ts: string | null; conf: number }[];
  for (const r of eps) out.push({ to: { kind: "episode", id: r.id }, edge: "mentioned_in", confidence: r.conf, evidenceTs: r.last_ts });

  // 3. claim:<kind> → the entity's active claims.
  const claims = db
    .prepare(
      `SELECT c.claim_key, c.kind, c.last_stated_at, COALESCE(v.confidence, 0.5) AS conf
         FROM claims c LEFT JOIN claim_versions v ON v.id = c.active_version_id
        WHERE c.subject_id = ? AND c.status = 'active'
          AND (v.valid_to IS NULL OR v.valid_to > ?)
        ORDER BY conf DESC, c.last_stated_at DESC, c.claim_key ASC
        LIMIT ?`,
    )
    .all(id, ctx.now, ctx.fanOut) as { claim_key: string; kind: string | null; last_stated_at: string | null; conf: number }[];
  for (const r of claims) {
    out.push({ to: { kind: "claim", id: r.claim_key }, edge: `claim:${r.kind ?? "fact"}`, confidence: r.conf, evidenceTs: r.last_stated_at });
  }

  // 4. (opt) mentioned_in → events.
  if (ctx.expandEntityEvents) {
    const evs = db
      .prepare(
        `SELECT m.event_id, ev.ts, COALESCE(m.confidence, 1) AS conf FROM mentions m JOIN events ev ON ev.id = m.event_id
          WHERE m.entity_id = ? ORDER BY conf DESC, ev.ts DESC, m.event_id ASC LIMIT ?`,
      )
      .all(id, ctx.fanOut) as { event_id: string; ts: string | null; conf: number }[];
    for (const r of evs) out.push({ to: { kind: "event", id: r.event_id }, edge: "mentioned_in", confidence: r.conf, evidenceTs: r.ts });
  }
  return out;
}

function episodeNeighbours(id: string, ctx: Ctx): Neighbour[] {
  const out: Neighbour[] = [];
  const db = getDb();
  const ep = db.prepare(`SELECT last_ts FROM episodes WHERE id = ?`).get(id) as { last_ts: string | null } | undefined;
  const epTs = ep?.last_ts ?? null;

  // about → entities its member events mention (hubs never entered).
  const ents = db
    .prepare(
      `SELECT m.entity_id, MAX(COALESCE(m.confidence, 1)) AS conf, MAX(ev.ts) AS ts
         FROM episode_events ee
         JOIN events ev ON ${EPISODE_MEMBER_JOIN}
         JOIN mentions m ON m.event_id = ev.id
        WHERE ee.episode_id = ? AND m.entity_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM hub_nodes h WHERE h.entity_id = m.entity_id)
        GROUP BY m.entity_id
        ORDER BY conf DESC, ts DESC, m.entity_id ASC
        LIMIT ?`,
    )
    .all(id, ctx.fanOut) as { entity_id: string; conf: number; ts: string | null }[];
  for (const r of ents) out.push({ to: { kind: "entity", id: r.entity_id }, edge: "about", confidence: r.conf, evidenceTs: r.ts ?? epTs });
  ctx.pruned.hubs += (
    db
      .prepare(
        `SELECT COUNT(DISTINCT m.entity_id) AS n FROM episode_events ee JOIN events ev ON ${EPISODE_MEMBER_JOIN}
           JOIN mentions m ON m.event_id = ev.id JOIN hub_nodes h ON h.entity_id = m.entity_id WHERE ee.episode_id = ?`,
      )
      .get(id) as { n: number }
  ).n;

  // claim:<kind> → claims stated in this episode.
  const claims = db
    .prepare(
      `SELECT c.claim_key, c.kind, v.stated_at, COALESCE(v.confidence, 0.5) AS conf
         FROM claim_versions v JOIN claims c ON c.claim_key = v.claim_key AND c.active_version_id = v.id
        WHERE v.episode_id = ? AND c.status = 'active' AND (v.valid_to IS NULL OR v.valid_to > ?)
        ORDER BY conf DESC, v.stated_at DESC, c.claim_key ASC
        LIMIT ?`,
    )
    .all(id, ctx.now, ctx.fanOut) as { claim_key: string; kind: string | null; stated_at: string; conf: number }[];
  for (const r of claims) {
    out.push({ to: { kind: "claim", id: r.claim_key }, edge: `claim:${r.kind ?? "fact"}`, confidence: r.conf, evidenceTs: r.stated_at });
  }

  if (ctx.expandEpisodeMembers) {
    const evs = db
      .prepare(
        `SELECT DISTINCT ev.id, ev.ts FROM episode_events ee JOIN events ev ON ${EPISODE_MEMBER_JOIN}
          WHERE ee.episode_id = ? ORDER BY ev.ts DESC, ev.id ASC LIMIT ?`,
      )
      .all(id, ctx.fanOut) as { id: string; ts: string | null }[];
    for (const r of evs) out.push({ to: { kind: "event", id: r.id }, edge: "member", confidence: 1, evidenceTs: r.ts });
  }
  return out;
}

function eventNeighbours(id: string, ctx: Ctx): Neighbour[] {
  const out: Neighbour[] = [];
  const db = getDb();
  const self = db.prepare(`SELECT ts FROM events WHERE id = ?`).get(id) as { ts: string | null } | undefined;

  // bridge:<kind> → events sharing a literal. Exact, 1.0, no model.
  const bridges = bridgeEdgesOf(id, { kinds: ctx.bridgeKinds, fanOut: ctx.fanOut });
  if (bridges.length > 0) {
    const ids = bridges.map((b) => b.dstEventId);
    const tsRows = db
      .prepare(`SELECT id, ts FROM events WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as { id: string; ts: string | null }[];
    const ts = new Map(tsRows.map((r) => [r.id, r.ts]));
    for (const b of bridges) {
      out.push({ to: { kind: "event", id: b.dstEventId }, edge: b.label, confidence: b.confidence, evidenceTs: ts.get(b.dstEventId) ?? null });
    }
  }

  // member_of → the episode(s) holding this event.
  const eps = db
    .prepare(
      `SELECT DISTINCT ep.id, ep.last_ts FROM episode_events ee JOIN events ev ON ${EPISODE_MEMBER_JOIN}
         JOIN episodes ep ON ep.id = ee.episode_id
        WHERE ev.id = ? ORDER BY ep.last_ts DESC, ep.id ASC LIMIT ?`,
    )
    .all(id, ctx.fanOut) as { id: string; last_ts: string | null }[];
  for (const r of eps) out.push({ to: { kind: "episode", id: r.id }, edge: "member_of", confidence: 1, evidenceTs: r.last_ts ?? self?.ts ?? null });

  // mentions → entities named in the event (hubs never entered).
  const ents = db
    .prepare(
      `SELECT m.entity_id, COALESCE(m.confidence, 1) AS conf FROM mentions m
        WHERE m.event_id = ? AND m.entity_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM hub_nodes h WHERE h.entity_id = m.entity_id)
        ORDER BY conf DESC, m.entity_id ASC LIMIT ?`,
    )
    .all(id, ctx.fanOut) as { entity_id: string; conf: number }[];
  for (const r of ents) out.push({ to: { kind: "entity", id: r.entity_id }, edge: "mentions", confidence: r.conf, evidenceTs: self?.ts ?? null });
  ctx.pruned.hubs += (
    db.prepare(`SELECT COUNT(*) AS n FROM mentions m JOIN hub_nodes h ON h.entity_id = m.entity_id WHERE m.event_id = ?`).get(id) as { n: number }
  ).n;
  return out;
}

function claimNeighbours(id: string, ctx: Ctx): Neighbour[] {
  const out: Neighbour[] = [];
  const row = getDb()
    .prepare(
      `SELECT c.subject_id, c.status, v.episode_id, v.stated_at, COALESCE(v.confidence, 0.5) AS conf, v.valid_to
         FROM claims c LEFT JOIN claim_versions v ON v.id = c.active_version_id WHERE c.claim_key = ?`,
    )
    .get(id) as
    | { subject_id: string | null; status: string; episode_id: string | null; stated_at: string | null; conf: number; valid_to: string | null }
    | undefined;
  if (!row || row.status !== "active") return out;
  if (row.valid_to && row.valid_to <= ctx.now) return out;
  if (row.subject_id && !ctx.hubs.has(row.subject_id)) {
    out.push({ to: { kind: "entity", id: row.subject_id }, edge: "subject", confidence: row.conf, evidenceTs: row.stated_at });
  } else if (row.subject_id) {
    ctx.pruned.hubs += 1;
  }
  if (row.episode_id) out.push({ to: { kind: "episode", id: row.episode_id }, edge: "stated_in", confidence: row.conf, evidenceTs: row.stated_at });
  return out;
}

function neighboursOf(node: GraphNodeRef, ctx: Ctx): Neighbour[] {
  switch (node.kind) {
    case "entity":
      return entityNeighbours(node.id, ctx);
    case "episode":
      return episodeNeighbours(node.id, ctx);
    case "event":
      return eventNeighbours(node.id, ctx);
    case "claim":
      return claimNeighbours(node.id, ctx);
  }
}

// ---- Labels ------------------------------------------------------------------

function labelsFor(hits: GraphHit[]): void {
  const db = getDb();
  const byKind = new Map<GraphNodeKind, string[]>();
  for (const h of hits) {
    const list = byKind.get(h.node.kind) ?? [];
    list.push(h.node.id);
    byKind.set(h.node.kind, list);
  }
  const labels = new Map<string, string | null>();
  const q = (kind: GraphNodeKind, sql: string): void => {
    const ids = byKind.get(kind);
    if (!ids || ids.length === 0) return;
    const rows = db.prepare(sql.replace("__IDS__", ids.map(() => "?").join(","))).all(...ids) as { id: string; label: string | null }[];
    for (const r of rows) labels.set(nodeKey({ kind, id: r.id }), r.label);
  };
  q("entity", `SELECT id, canonical AS label FROM entities WHERE id IN (__IDS__)`);
  q("episode", `SELECT id, summary AS label FROM episodes WHERE id IN (__IDS__)`);
  q("event", `SELECT id, substr(COALESCE(text, ''), 1, 160) AS label FROM events WHERE id IN (__IDS__)`);
  q(
    "claim",
    `SELECT c.claim_key AS id, COALESCE(v.text, v.object) AS label FROM claims c LEFT JOIN claim_versions v ON v.id = c.active_version_id WHERE c.claim_key IN (__IDS__)`,
  );
  for (const h of hits) h.label = labels.get(h.key) ?? null;
}

// ---- The walk ----------------------------------------------------------------

function compareHits(a: GraphHit, b: GraphHit): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.hop !== b.hop) return a.hop - b.hop;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Bounded BFS from `seeds`. Returns nodes within `maxHops`, best score first,
 * seeds excluded. See the header for the edge model and the rules.
 */
export function graphWalk(seeds: readonly GraphNodeRef[], opts: GraphWalkOptions = {}): GraphWalkResult {
  const maxHops = Math.max(0, Math.floor(opts.maxHops ?? GRAPH_DEFAULTS.maxHops));
  const decay = opts.decay ?? GRAPH_DEFAULTS.decay;
  const fanOut = Math.max(0, Math.floor(opts.fanOut ?? GRAPH_DEFAULTS.fanOut));
  const minScore = opts.minScore ?? GRAPH_DEFAULTS.minScore;
  const limit = Math.max(0, Math.floor(opts.limit ?? GRAPH_DEFAULTS.limit));
  const now = opts.now ?? new Date().toISOString();
  const halfLife = opts.recencyHalfLifeDays ?? GRAPH_DEFAULTS.recencyHalfLifeDays;

  const hubs = hubIds();
  const ctx: Ctx = {
    now,
    fanOut,
    edgeKinds: opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : undefined,
    bridgeKinds: opts.bridgeKinds && opts.bridgeKinds.length > 0 ? opts.bridgeKinds : GRAPH_BRIDGE_KINDS,
    hubs,
    expandEntityEvents: opts.expandEntityEvents ?? false,
    expandEpisodeMembers: opts.expandEpisodeMembers ?? false,
    pruned: { hubs: 0, score: 0 },
  };

  // Seeds: dedupe, drop hubs (a hub is never expanded — it is the whole graph).
  const seedKeys = new Set<string>();
  const liveSeeds: GraphNodeRef[] = [];
  for (const s of seeds) {
    const k = nodeKey(s);
    if (seedKeys.has(k)) continue;
    if (s.kind === "entity" && hubs.has(s.id)) {
      ctx.pruned.hubs += 1;
      continue;
    }
    seedKeys.add(k);
    liveSeeds.push(s);
  }

  const best = new Map<string, GraphHit>();
  let frontier: GraphHit[] = liveSeeds.map((s) => ({ node: s, key: nodeKey(s), hop: 0, score: 1, path: [], label: null }));
  let expanded = 0;
  let edgesRead = 0;

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop += 1) {
    const next = new Map<string, GraphHit>();
    frontier.sort(compareHits);
    for (const parent of frontier) {
      const neighbours = neighboursOf(parent.node, ctx);
      expanded += 1;
      edgesRead += neighbours.length;
      for (const n of neighbours) {
        const k = nodeKey(n.to);
        // Cycle / revisit guard: seeds and anything reached at an earlier hop.
        if (seedKeys.has(k) || best.has(k)) continue;
        if (n.to.kind === "entity" && hubs.has(n.to.id)) {
          ctx.pruned.hubs += 1;
          continue;
        }
        const recency = recencyWeight(n.evidenceTs, now, halfLife);
        const score = parent.score * decay * Math.max(0, Math.min(1, n.confidence)) * recency;
        if (score < minScore) {
          ctx.pruned.score += 1;
          continue;
        }
        const step: GraphStep = { edge: n.edge, from: parent.node, to: n.to, confidence: n.confidence, recency };
        const cand: GraphHit = { node: n.to, key: k, hop: hop + 1, score, path: [...parent.path, step], label: null };
        const prev = next.get(k);
        if (!prev || compareHits(cand, prev) < 0) next.set(k, cand);
      }
    }
    frontier = [...next.values()];
    for (const h of frontier) best.set(h.key, h);
  }

  const hits = [...best.values()].sort(compareHits).slice(0, limit);
  labelsFor(hits);
  return { hits, seeds: liveSeeds, expanded, edgesRead, pruned: ctx.pruned };
}

/** Seeds from lexical + vector hits, then the walk — the one call the fusion layer makes. */
export function graphRetrieve(input: SeedInput, opts: GraphWalkOptions = {}): GraphWalkResult {
  return graphWalk(seedsFromHits(input), opts);
}
