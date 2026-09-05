// ===========================================================================
// [CODE] The `[BRIDGED]` block — V6 P1 S2.6 (Build §5.2; RET-10; Product_V6
// §23.5 rule 1; Product_V6_Phase1 §7.2 "related cross-source episodes via
// bridges and entities").
//
// Given the events of a bundle, list every bridge that touches them: the
// literal, its kind, the confidence, and BOTH ends — source, time, and a head
// of each event's text — so the model sees that the Airbnb URL in the WhatsApp
// message is the page the user opened in the browser at 21:14, without a
// model call being spent to notice it.
//
// One line per (literal, pair). Pairs are folded (the store is bidirectional),
// ordered by literal kind, value, then the pair, capped. The block is empty
// when nothing bridges — the packer then omits it. S3's packer rewrite mounts
// this as a section; it is section-shaped (header + lines) for that reason.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { bridgesAmong, type BridgeEdgeOptions, type BridgeGraphEdge } from "../bridges/edges.js";

export const BRIDGED_HEADER = "[BRIDGED]";
export const DEFAULT_BRIDGED_LIMIT = 8;
export const BRIDGED_HEAD_CHARS = 80;

export interface BridgedEnd {
  eventId: string;
  source: string | null;
  ts: string | null;
  head: string;
  /** true when this end is one of the bundle's own events. */
  inBundle: boolean;
}

export interface BridgedLine {
  edge: BridgeGraphEdge;
  left: BridgedEnd;
  right: BridgedEnd;
}

export interface BridgedBlockOptions extends BridgeEdgeOptions {
  /** Lines rendered. Default 8. */
  limit?: number;
}

interface EventHead {
  id: string;
  source_id: string | null;
  source_type: string | null;
  ts: string | null;
  text: string | null;
}

function head(text: string | null, chars = BRIDGED_HEAD_CHARS): string {
  const one = (text ?? "").replace(/\s+/g, " ").trim();
  return one.length <= chars ? one : `${one.slice(0, chars - 1)}…`;
}

/** The bridges touching `eventIds`, both ends resolved. */
export function bridgedLines(eventIds: readonly string[], opts: BridgedBlockOptions = {}): BridgedLine[] {
  const limit = Math.max(0, opts.limit ?? DEFAULT_BRIDGED_LIMIT);
  if (limit === 0) return [];
  const edges = bridgesAmong(eventIds, { kinds: opts.kinds, minConfidence: opts.minConfidence, fanOut: limit });
  if (edges.length === 0) return [];
  const ids = [...new Set(edges.flatMap((e) => [e.srcEventId, e.dstEventId]))];
  const rows = getDb()
    .prepare(`SELECT id, source_id, source_type, ts, text FROM events WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as EventHead[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bundle = new Set(eventIds);
  const end = (id: string): BridgedEnd => {
    const r = byId.get(id);
    return {
      eventId: id,
      source: r?.source_id ?? r?.source_type ?? null,
      ts: r?.ts ?? null,
      head: head(r?.text ?? null),
      inBundle: bundle.has(id),
    };
  };
  return edges.map((edge) => ({ edge, left: end(edge.srcEventId), right: end(edge.dstEventId) }));
}

function fmtTs(ts: string | null): string {
  if (!ts) return "?";
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return ts;
  return new Date(t).toISOString().slice(0, 16).replace("T", " ");
}

function fmtEnd(e: BridgedEnd): string {
  const src = e.source ?? "?";
  const quote = e.head ? ` "${e.head}"` : "";
  return `${src} ${fmtTs(e.ts)} ${e.eventId}${quote}`;
}

/**
 * Render the block. "" when nothing bridges. Each line:
 *   - bridge:url 1.00 · airbnb.com/rooms/123 · wa 2026-08-14 15:40 <id> "…" ⇄ browser 2026-08-14 15:44 <id> "…"
 */
export function renderBridgedBlock(lines: readonly BridgedLine[]): string {
  if (lines.length === 0) return "";
  const out = [BRIDGED_HEADER];
  for (const l of lines) {
    out.push(`- ${l.edge.label} ${l.edge.confidence.toFixed(2)} · ${l.edge.valueNorm} · ${fmtEnd(l.left)} ⇄ ${fmtEnd(l.right)}`);
  }
  return out.join("\n");
}

/** Lines + render in one call — what the packer mounts. */
export function bridgedBlock(eventIds: readonly string[], opts: BridgedBlockOptions = {}): string {
  return renderBridgedBlock(bridgedLines(eventIds, opts));
}
