// ===========================================================================
// [CODE] Bridges as graph edges — V6 P1 S2.6 (Build §5.2, Product_V6 §23.5
// rule 1, retrieval decision record item 5).
//
// A bridge is a shared literal — a URL, a phone number, an order id — seen in
// two events. It is written AT INGEST by bridges/ingest.ts through both
// single-writer funnels (db/eventlog.ts appendEvents and ingest/index.ts
// insertEvent), as a bidirectional pair row in `bridges`, with no model call
// and confidence 1.0. §23.5 names `bridges` as one of the four graph tables:
// bridges are the highest-precision edges the graph has, and the only thing
// that joins a browser visit to a chat message to a confirmation mail.
//
// This module is the READ side that makes them edges: the walk asks
// `bridgeEdgesOf(eventId)` and gets `bridge:<kind>` edges shaped like every
// other edge it traverses (kind · subtype · src · dst · confidence), fan-out
// capped and ordered best-first. `entity_edges` cannot hold them — its src/dst
// are entity FKs and a bridge joins two EVENTS — so they stay in `bridges`
// and the graph unifies the two tables at the edge abstraction, not in SQL.
//
// The kinds that walk: the exact-match trio the build names (url · phone ·
// order_id) plus email and file_id, which fire the same way. The measured
// kinds (attendee_set, geo_time) never reach `bridges` off a single event.
// ===========================================================================

import { getDb } from "../db/connection.js";

/** The edge kind bridges present as; subtype carries the literal's kind. */
export const BRIDGE_EDGE_KIND = "bridge";

/** Bridge kinds the graph walks. Exact-match kinds only. */
export const GRAPH_BRIDGE_KINDS = ["url", "phone", "order_id", "email", "file_id"] as const;
export type GraphBridgeKind = (typeof GRAPH_BRIDGE_KINDS)[number];

export interface BridgeGraphEdge {
  /** The `bridges.id` of the (src → dst) direction row. */
  id: string;
  kind: typeof BRIDGE_EDGE_KIND;
  /** url · phone · order_id · email · file_id */
  subtype: string;
  /** `bridge:url` — the label the walk and the packer print. */
  label: string;
  /** The shared literal, normalised. */
  valueNorm: string;
  srcEventId: string;
  dstEventId: string;
  /** 1.0 for an exact literal (CONFIDENCE_EXACT). */
  confidence: number;
  decidedBy: string | null;
  createdAt: string;
}

export interface BridgeEdgeOptions {
  /** Restrict to these bridge kinds. Default: GRAPH_BRIDGE_KINDS. */
  kinds?: readonly string[];
  /** Fan-out cap — best confidence first, then oldest. Default 20. */
  fanOut?: number;
  /** Drop edges below this confidence. Default 0. */
  minConfidence?: number;
}

interface RawBridge {
  id: string;
  kind: string;
  value_norm: string;
  left_id: string;
  right_id: string;
  confidence: number | null;
  decided_by: string | null;
  created_at: string;
}

export function bridgeEdgeLabel(subtype: string): string {
  return `${BRIDGE_EDGE_KIND}:${subtype}`;
}

function hydrate(r: RawBridge): BridgeGraphEdge {
  return {
    id: r.id,
    kind: BRIDGE_EDGE_KIND,
    subtype: r.kind,
    label: bridgeEdgeLabel(r.kind),
    valueNorm: r.value_norm,
    srcEventId: r.left_id,
    dstEventId: r.right_id,
    confidence: r.confidence ?? 1,
    decidedBy: r.decided_by,
    createdAt: r.created_at,
  };
}

function kindList(kinds: readonly string[] | undefined): string[] {
  const list = kinds && kinds.length > 0 ? [...new Set(kinds)] : [...GRAPH_BRIDGE_KINDS];
  return list;
}

/**
 * Bridge edges leaving one event: every other event that shares a literal
 * with it, as `bridge:<kind>` edges, best confidence first, fan-out capped.
 * Rows are stored both ways, so one indexed seek on `left_id` is the whole
 * neighbourhood.
 */
export function bridgeEdgesOf(eventId: string, opts: BridgeEdgeOptions = {}): BridgeGraphEdge[] {
  const kinds = kindList(opts.kinds);
  const fanOut = Math.max(0, opts.fanOut ?? 20);
  if (fanOut === 0) return [];
  const rows = getDb()
    .prepare(
      `SELECT id, kind, value_norm, left_id, right_id, confidence, decided_by, created_at
         FROM bridges
        WHERE left_id = ? AND kind IN (${kinds.map(() => "?").join(",")})
          AND COALESCE(confidence, 1) >= ?
        ORDER BY COALESCE(confidence, 1) DESC, created_at ASC, id ASC
        LIMIT ?`,
    )
    .all(eventId, ...kinds, opts.minConfidence ?? 0, fanOut) as RawBridge[];
  return rows.map(hydrate);
}

/**
 * Every bridge touching a set of events, one edge per unordered pair and
 * literal (the mirror row is folded), ordered by literal kind, value, then
 * the pair. This is what the packer's `[BRIDGED]` block lists.
 */
export function bridgesAmong(eventIds: readonly string[], opts: BridgeEdgeOptions = {}): BridgeGraphEdge[] {
  const ids = [...new Set(eventIds)].filter((id) => id !== "");
  if (ids.length === 0) return [];
  const kinds = kindList(opts.kinds);
  const rows = getDb()
    .prepare(
      `SELECT id, kind, value_norm, left_id, right_id, confidence, decided_by, created_at
         FROM bridges
        WHERE left_id IN (${ids.map(() => "?").join(",")})
          AND kind IN (${kinds.map(() => "?").join(",")})
          AND COALESCE(confidence, 1) >= ?
        ORDER BY kind, value_norm, left_id, right_id`,
    )
    .all(...ids, ...kinds, opts.minConfidence ?? 0) as RawBridge[];
  const seen = new Set<string>();
  const out: BridgeGraphEdge[] = [];
  for (const r of rows) {
    const [a, b] = r.left_id <= r.right_id ? [r.left_id, r.right_id] : [r.right_id, r.left_id];
    const key = `${r.kind}\u0000${r.value_norm}\u0000${a}\u0000${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hydrate({ ...r, left_id: a, right_id: b }));
  }
  const cap = opts.fanOut;
  return cap !== undefined && cap >= 0 ? out.slice(0, cap) : out;
}
