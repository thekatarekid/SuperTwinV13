// ===========================================================================
// [CODE] V6 bundles — the unit of a model call (Product_V6 §11.3, P1 §7).
//
// A bundle is time, not stream: a live bundle is the delta since the last
// flush across every source; a history bundle is one calendar day across
// every source (scheduler/v6/history.ts); a digest bundle is one tier-3
// stream for one week (scheduler/v6/digest.ts). The packer sections a bundle
// by stream (`[THREAD S<k>]`) and the commit path enforces one stream per
// episode, so a bundle spanning streams is the normal case, not an exception.
//
// What lives here is shared by every lane and by the consumer:
//
//   BundleEvent / DeltaBundle   the shape the packer, Orient, Critic, commit
//                               and the digest prompt consume
//   collectTick                 per-stream pending deltas — the seam the
//                               commit / packer tests and eval executors use
//                               to obtain a bundle from a seeded DB
//   markDispatched(Events)      the ONLY place `events.dispatched_at` and
//                               `streams.cursor_rowid` move
//   bundleKey / isBundleStale   the keyed in-flight identity (BND-09) and the
//                               revalidate-at-execution check (BND-10)
//
// Nothing here decides WHEN a bundle is built — that is the state gate, the
// cold window and the day-bundler in this directory.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import type { AgeBand, EventOrigin } from "../../db/eventlog.js";
import type { StreamCategory } from "../../categories/chat.js";
import { registerBundleForEnrichment } from "../../media/bundle-pass.js";

// ---- Config ----------------------------------------------------------------

export interface DispatchConfig {
  /** Max events per bundle part; a larger per-stream delta splits. */
  maxBundleEvents: number;
  /** Bundles the dispatcher may hand out in one tick — absolute, every path (BND-08). */
  slots: number;
}

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  maxBundleEvents: 500,
  slots: 4,
};

// ---- Types -----------------------------------------------------------------

export interface BundleEvent {
  rowid: number;
  id: string;
  /** events.source_id — "wa" | "browser" | "screen" | … */
  sourceId?: string | null;
  /** events.stream_id — set on every bundle event so a multi-stream bundle sections itself. */
  streamId?: string | null;
  ts: string | null;
  kind: string | null;
  text: string | null;
  actor: string | null;
  origin: EventOrigin;
  ageBand: AgeBand;
  rolesJson: string | null;
  payloadJson: string | null;
}

/**
 * The lane a bundle runs on (Product_V6 §23.2): `live` flushes from the state
 * gate, `history` is a day of backfill, `digest` a tier-3 week. Downstream code
 * that only knows live-vs-not treats anything but `live` as background.
 */
export type Lane = "live" | "history" | "digest";

export interface DeltaBundle {
  /** The bundle's own stream — S1 in the pack; the stream that triggered a live flush. */
  streamId: string;
  streamKey: string;
  lane: Lane;
  /** Best (youngest) band present. */
  ageBand: AgeBand;
  events: BundleEvent[];
  /** 1-based part number after a split; 1/1 when unsplit. */
  part: number;
  partCount: number;
  /** Predecessor part's summary — successors are never amnesiac. */
  predecessorSummary?: string;
  /** Stream category where known (chat Cat 1/2); null = unclassified. */
  category?: StreamCategory | null;
  /** Newest event day ("YYYY-MM-DD"). */
  day?: string;
  /** Why the live lane flushed: hot · burst · cold · cap. Absent on history/digest. */
  trigger?: "hot" | "burst" | "cold" | "cap";
}

export interface TickPlan {
  /** Per-stream pending deltas, live first, then by first rowid. */
  bundles: DeltaBundle[];
}

// ---- Predecessor summary (deterministic) -----------------------------------

export function summarizePart(bundle: {
  streamKey: string;
  part: number;
  events: Pick<BundleEvent, "ts" | "text" | "actor">[];
}): string {
  const { events } = bundle;
  const first = events[0];
  const last = events[events.length - 1];
  const tail = events
    .slice(-3)
    .map((e) => `${e.actor ?? "?"}: ${(e.text ?? "").slice(0, 80)}`)
    .join(" · ");
  return (
    `[part ${bundle.part} of ${bundle.streamKey}: ${events.length} events, ` +
    `${first?.ts ?? "?"} → ${last?.ts ?? "?"}; last: ${tail}]`
  );
}

// ---- Rows ------------------------------------------------------------------

const BAND_ORDER: Record<AgeBand, number> = { A: 0, B: 1, C: 2, D: 3 };

export interface PendingRow {
  rowid: number;
  id: string;
  source_id: string | null;
  stream_id: string | null;
  stream_key: string;
  ts: string | null;
  kind: string | null;
  text: string | null;
  actor: string | null;
  origin: string | null;
  age_band: string | null;
  roles_json: string | null;
  payload_json: string | null;
  tier: number | null;
  stream_tier: string | null;
}

export const PENDING_SELECT = `
  SELECT e.rowid AS rowid, e.id, e.source_id, e.stream_id, e.stream_key, e.ts, e.kind,
         e.text, e.actor, e.origin, e.age_band, e.roles_json, e.payload_json, e.tier,
         s.tier AS stream_tier
    FROM events e
    LEFT JOIN streams s ON s.id = e.stream_id
   WHERE e.dispatched_at IS NULL
     AND e.stream_key IS NOT NULL
     AND e.revoked_at IS NULL`;

export function toBundleEvent(r: PendingRow): BundleEvent {
  return {
    rowid: r.rowid,
    id: r.id,
    sourceId: r.source_id ?? null,
    streamId: r.stream_id ?? null,
    ts: r.ts,
    kind: r.kind,
    text: r.text,
    actor: r.actor,
    origin: (r.origin === "backfill" || r.origin === "archive" || r.origin === "eval" ? r.origin : "live") as EventOrigin,
    ageBand: (r.age_band && r.age_band in BAND_ORDER ? r.age_band : "A") as AgeBand,
    rolesJson: r.roles_json,
    payloadJson: r.payload_json,
  };
}

/** Best (youngest) age band across events; "D" for none. */
export function bestBand(events: readonly BundleEvent[]): AgeBand {
  return events.reduce<AgeBand>(
    (best, e) => (BAND_ORDER[e.ageBand] < BAND_ORDER[best] ? e.ageBand : best),
    events.length > 0 ? "D" : "A",
  );
}

/** Newest event day in the bundle. */
export function dayOf(events: readonly BundleEvent[]): string {
  let newest = "";
  for (const e of events) {
    const day = (e.ts ?? "").slice(0, 10);
    if (day > newest) newest = day;
  }
  return newest;
}

/** Stream tier 1..4 for a pending row: the stream's `T<n>`, else the event's, else 1 (unknown work is early work). */
export function tierOf(r: { tier: number | null; stream_tier: string | null }): 1 | 2 | 3 | 4 {
  const s = r.stream_tier;
  if (typeof s === "string") {
    const m = /^T?([1-4])$/.exec(s.trim());
    if (m) return Number(m[1]) as 1 | 2 | 3 | 4;
  }
  if (r.tier === 2 || r.tier === 3 || r.tier === 4) return r.tier;
  return 1;
}

/** `AND <stream_key starts with ?>` — a scope for tests and eval executors sharing one DB. */
export const SCOPE_CLAUSE = ` AND substr(e.stream_key, 1, length(?)) = ?`;

/**
 * Every undispatched, unrevoked event row, in rowid order (optionally above a
 * rowid, optionally only streams whose key starts with `streamKeyPrefix`).
 */
export function pendingRows(afterRowid = 0, streamKeyPrefix?: string): PendingRow[] {
  if (streamKeyPrefix) {
    return getDb()
      .prepare(`${PENDING_SELECT} AND e.rowid > ?${SCOPE_CLAUSE} ORDER BY e.rowid`)
      .all(afterRowid, streamKeyPrefix, streamKeyPrefix) as PendingRow[];
  }
  return getDb()
    .prepare(`${PENDING_SELECT} AND e.rowid > ? ORDER BY e.rowid`)
    .all(afterRowid) as PendingRow[];
}

// ---- Collect (per-stream deltas; the test / executor seam) -----------------

interface StreamStateRow {
  id: string;
  cursor_rowid: number;
  category: string | null;
}

function categoryOf(state: StreamStateRow | undefined): StreamCategory | null {
  if (state?.category === "cat1" || state?.category === "cat2") return state.category;
  return null;
}

/**
 * Group every undispatched event beyond its stream's cursor into per-stream
 * delta bundles: live first, then history, then by first rowid. Oversized
 * deltas split into `maxBundleEvents` parts carrying a predecessor summary.
 * Writes NOTHING — cursors move only in markDispatched().
 *
 * This is the seam the commit / packer suites and the CMT / PCK executors use
 * to turn a seeded DB into a bundle; the production dispatcher builds live
 * and day bundles itself (dispatch.ts, history.ts).
 */
export function collectTick(
  _nowMs: number = Date.now(),
  cfg: DispatchConfig = DEFAULT_DISPATCH_CONFIG,
): TickPlan {
  const db = getDb();
  const rows = pendingRows();
  const byStream = new Map<string, PendingRow[]>();
  for (const r of rows) {
    const sid = r.stream_id ?? r.stream_key;
    const list = byStream.get(sid);
    if (list) list.push(r);
    else byStream.set(sid, [r]);
  }
  const stateStmt = db.prepare(`SELECT id, cursor_rowid, category FROM streams WHERE id = ?`);

  const bundles: DeltaBundle[] = [];
  for (const [streamId, streamRows] of byStream) {
    const state = stateStmt.get(streamId) as StreamStateRow | undefined;
    const cursor = state?.cursor_rowid ?? 0;
    const events = streamRows.filter((r) => r.rowid > cursor).map(toBundleEvent);
    if (events.length === 0) continue;
    const lane: Lane = events.some((e) => e.origin === "live") ? "live" : "history";
    const category = categoryOf(state);
    const partCount = Math.max(1, Math.ceil(events.length / cfg.maxBundleEvents));
    let predecessorSummary: string | undefined;
    for (let p = 0; p < partCount; p++) {
      const slice = events.slice(p * cfg.maxBundleEvents, (p + 1) * cfg.maxBundleEvents);
      const bundle: DeltaBundle = {
        streamId,
        streamKey: streamRows[0].stream_key,
        lane,
        ageBand: bestBand(slice),
        events: slice,
        part: p + 1,
        partCount,
        predecessorSummary,
        category,
        day: dayOf(slice),
      };
      bundles.push(bundle);
      predecessorSummary = summarizePart(bundle);
    }
  }
  bundles.sort((a, b) => {
    if (a.lane !== b.lane) return a.lane === "live" ? -1 : 1;
    const ra = a.events[0]?.rowid ?? 0;
    const rb = b.events[0]?.rowid ?? 0;
    if (ra !== rb) return ra - rb;
    return a.part - b.part;
  });
  return { bundles };
}

// ---- Mark ------------------------------------------------------------------

/** Stamp every event of the bundle dispatched and advance every touched stream's cursor. */
export function markDispatched(bundle: DeltaBundle, nowMs: number = Date.now()): void {
  markDispatchedEvents(bundle, bundle.events.map((e) => e.id), nowMs);
}

/**
 * Per-item salvage (S3.1, T2-7): stamp ONLY the named bundle events and
 * advance each touched stream's cursor to the largest rowid below which every
 * bundle event OF THAT STREAM is stamped. Held events stay unstamped above the
 * cursor and are re-collected; stamped events after them never are.
 *
 * The hand-off also arms the media enrichment countdown (best-effort — a
 * countdown that fails to arm must not unwind a dispatch that committed).
 */
export function markDispatchedEvents(
  bundle: DeltaBundle,
  eventIds: readonly string[],
  nowMs: number = Date.now(),
): { stamped: number; cursorRowid: number } {
  const db = getDb();
  const nowIso = new Date(nowMs).toISOString();
  const want = new Set(eventIds);
  const stamp = db.prepare(`UPDATE events SET dispatched_at = ? WHERE rowid = ? AND dispatched_at IS NULL`);
  const advance = db.prepare(`UPDATE streams SET cursor_rowid = MAX(cursor_rowid, ?) WHERE id = ?`);

  const ordered = [...bundle.events].sort((a, b) => a.rowid - b.rowid);
  const stamped = ordered.filter((e) => want.has(e.id));

  // Cursor per stream: the bundle may span streams (live), so each stream's
  // cursor advances over its own stamped prefix.
  const perStream = new Map<string, BundleEvent[]>();
  for (const e of ordered) {
    const sid = e.streamId ?? bundle.streamId;
    const list = perStream.get(sid);
    if (list) list.push(e);
    else perStream.set(sid, [e]);
  }
  const cursors = new Map<string, number>();
  for (const [sid, list] of perStream) {
    let cursor = 0;
    for (const e of list) {
      if (!want.has(e.id)) break;
      cursor = e.rowid;
    }
    if (cursor > 0) cursors.set(sid, cursor);
  }

  const run = db.transaction(() => {
    for (const e of stamped) stamp.run(nowIso, e.rowid);
    for (const [sid, cursor] of cursors) advance.run(cursor, sid);
  });
  run();

  if (stamped.length > 0) {
    try {
      registerBundleForEnrichment({ streamId: bundle.streamId, events: stamped });
    } catch (err) {
      console.error(`[dispatch] enrichment countdown failed for ${bundle.streamKey}:`, err);
    }
  }
  return { stamped: stamped.length, cursorRowid: cursors.get(bundle.streamId) ?? 0 };
}

// ---- Identity and revalidation ---------------------------------------------

/**
 * Bundle identity for the in-flight registry (BND-09): the same rows submitted
 * twice — two ticks over a slow run, any re-dispatch path — cost one model
 * call, not two. `<stream>:<minRowid>-<maxRowid>`, the same key
 * `bundle_attempts` is filed under.
 */
export function bundleKey(bundle: Pick<DeltaBundle, "streamId" | "events">): string {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const e of bundle.events) {
    if (e.rowid < min) min = e.rowid;
    if (e.rowid > max) max = e.rowid;
  }
  if (!Number.isFinite(min)) min = 0;
  return `${bundle.streamId}:${min}-${max}`;
}

/** The `bundle_attempts` reference for a bundle. */
export function bundleRef(bundle: Pick<DeltaBundle, "streamId" | "events">): {
  streamId: string;
  minRowid: number;
  maxRowid: number;
} {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const e of bundle.events) {
    if (e.rowid < min) min = e.rowid;
    if (e.rowid > max) max = e.rowid;
  }
  return { streamId: bundle.streamId, minRowid: Number.isFinite(min) ? min : 0, maxRowid: max };
}

/**
 * Re-validate at execution (BND-10): a bundle that waited may have been
 * dispatched by another path meanwhile. Any event already stamped makes the
 * whole bundle stale — the unmarked remainder is re-collected as a fresh
 * bundle by the next tick. Zero model calls are spent on a stale bundle.
 */
export function isBundleStale(bundle: Pick<DeltaBundle, "events">): boolean {
  if (bundle.events.length === 0) return true;
  const stmt = getDb().prepare(`SELECT dispatched_at FROM events WHERE rowid = ?`);
  for (const e of bundle.events) {
    const row = stmt.get(e.rowid) as { dispatched_at: string | null } | undefined;
    if (!row || row.dispatched_at !== null) return true;
  }
  return false;
}
