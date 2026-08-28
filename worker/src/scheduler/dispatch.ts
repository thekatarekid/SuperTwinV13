// ===========================================================================
// V13 dispatch — cursors, delta bundles, priority lanes (build P0.5, spec §6.2).
//
// There is no segmenter. Every dispatch window (~5 min live), each stream with
// new events yields ONE delta bundle = the events between the stream's cursor
// and now. Bundle boundaries are semantically meaningless by design (§6.2.5);
// episodes + thread history absorb every mid-conversation cut (BND-03).
//
// The moving parts, all deterministic (BND-01…06 assert them with no model):
//
//   cursor      per stream, ROWID-based (insertion order, never ts) and moved
//               ONLY by markDispatched() — a collect that fails to hand off
//               leaves the log exactly where it was (BND-01 cursor-skip). A
//               backfill wave landing with OLDER timestamps still sits beyond
//               the cursor because it landed later (BND-04).
//   deferral    a live bundle below the signal floor (no intent verbs, no
//               entities-ish tokens, tiny chars) carries forward and
//               accumulates; the max-defer bound (45–60 min) force-dispatches
//               it anyway — an "ok" still matters for closure (BND-02).
//   split       an oversized bundle is cut into capped parts; every successor
//               carries the predecessor part's summary so Digest output is
//               cumulative, never amnesiac (BND-05).
//   lanes       live > backfill, and within backfill band A > B > C > D, then
//               engagement score (an ordering signal only). Live preempts:
//               a live bundle is always planned ahead of every backfill batch
//               in the same window (BND-06).
//   orphan scan any event older than N windows with no processed mark
//               (events.dispatched_at) is re-queued regardless of deferral
//               state — the containment safety net (BND-04).
//
// The tick consumer (Orient map-reduce, spec §6.3) lands in P1; until then the
// production loop (startDispatcher, wired in worker/src/index.ts) plans each
// window and hands bundles to its sink.
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { AgeBand, EventOrigin } from "../db/eventlog.js";

// ---- Config ----------------------------------------------------------------

export interface DispatchConfig {
  /** Live dispatch window. Spec §6.2: ~5 min. */
  windowMs: number;
  /** Below this many total trimmed chars a bundle is deferral-eligible. */
  signalFloorChars: number;
  /** Low-signal bundles force-dispatch after this long (spec: 45–60 min). */
  maxDeferMs: number;
  /** Max events per bundle part; larger deltas split (BND-05). */
  maxBundleEvents: number;
  /** Orphan scan re-queues undispatched events older than N windows. */
  orphanWindows: number;
  /** CLI slots the planner may fill in one window. */
  slots: number;
}

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  windowMs: 5 * 60_000,
  signalFloorChars: 12,
  maxDeferMs: 50 * 60_000, // middle of the spec's 45–60 min band
  maxBundleEvents: 500,
  orphanWindows: 3,
  slots: 4,
};

// ---- Types -----------------------------------------------------------------

export interface BundleEvent {
  rowid: number;
  id: string;
  ts: string | null;
  kind: string | null;
  text: string | null;
  actor: string | null;
  origin: EventOrigin;
  ageBand: AgeBand;
  rolesJson: string | null;
  payloadJson: string | null;
}

export type Lane = "live" | "backfill";

export interface DeltaBundle {
  streamId: string;
  streamKey: string;
  lane: Lane;
  /** Best (youngest) band present — orders backfill A > B > C > D. */
  ageBand: AgeBand;
  events: BundleEvent[];
  /** 1-based part number after a max-size split; 1/1 when unsplit. */
  part: number;
  partCount: number;
  /** Predecessor part's summary — successors are never amnesiac (BND-05). */
  predecessorSummary?: string;
  /** True when a low-signal bundle hit max-defer and dispatched anyway. */
  forced?: boolean;
}

export interface DeferredStream {
  streamId: string;
  streamKey: string;
  eventCount: number;
  deferSince: string;
}

export interface TickPlan {
  /** Bundles in dispatch order: live first, then backfill A>B>C>D. */
  bundles: DeltaBundle[];
  deferred: DeferredStream[];
}

// ---- Signal floor (deterministic, no model) --------------------------------

/** Verbs/markers that make even a tiny bundle worth a call right now. */
const INTENT_RE =
  /\b(book|pay|paid|send|sent|buy|bought|call|confirm|cancel|urgent|now|asap|today|tonight|tomorrow|meet|due|deadline|remind)\b/i;

/** Entity-ish signals: numbers, currency, URLs, emails, @mentions, Title Case runs. */
const ENTITY_RE =
  /\d{2,}|https?:\/\/|www\.|@\w|[₹$€£]|\b[A-Z][a-z]+\s+[A-Z][a-z]+\b|\?/;

/**
 * A bundle is low-signal when its total trimmed text is under the floor AND
 * nothing in it looks like intent or an entity. Deterministic by design —
 * misclassification costs minutes (max-defer), never data.
 */
export function isLowSignal(
  events: Pick<BundleEvent, "text">[],
  cfg: DispatchConfig = DEFAULT_DISPATCH_CONFIG,
): boolean {
  let chars = 0;
  for (const e of events) {
    const t = (e.text ?? "").trim();
    chars += t.length;
    if (t.length > 0 && (INTENT_RE.test(t) || ENTITY_RE.test(t))) return false;
  }
  return chars < cfg.signalFloorChars;
}

// ---- Predecessor summary (deterministic — BND-05) --------------------------

/**
 * Deterministic summary of a dispatched part, carried by its successor so the
 * next call knows what came before without re-reading it.
 */
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

// ---- Collect ---------------------------------------------------------------

const BAND_ORDER: Record<AgeBand, number> = { A: 0, B: 1, C: 2, D: 3 };

interface UndispatchedRow {
  rowid: number;
  id: string;
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
}

interface StreamStateRow {
  id: string;
  cursor_rowid: number;
  defer_since: string | null;
  engagement_score: number;
}

function toBundleEvent(r: UndispatchedRow): BundleEvent {
  return {
    rowid: r.rowid,
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    text: r.text,
    actor: r.actor,
    origin: (r.origin === "backfill" ? "backfill" : "live") as EventOrigin,
    ageBand: (r.age_band && r.age_band in BAND_ORDER
      ? r.age_band
      : "A") as AgeBand,
    rolesJson: r.roles_json,
    payloadJson: r.payload_json,
  };
}

/**
 * Plan one dispatch window at `nowMs`: group every undispatched envelope
 * event beyond its stream's cursor into per-stream delta bundles, apply the
 * low-signal deferral, split oversized bundles, and order the result by lane
 * priority. Writes NOTHING except the deferral clock — cursors move only in
 * markDispatched().
 */
export function collectTick(
  nowMs: number = Date.now(),
  cfg: DispatchConfig = DEFAULT_DISPATCH_CONFIG,
): TickPlan {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.rowid AS rowid, e.id, e.stream_id, e.stream_key, e.ts, e.kind,
              e.text, e.actor, e.origin, e.age_band, e.roles_json, e.payload_json
         FROM events e
        WHERE e.dispatched_at IS NULL
          AND e.stream_key IS NOT NULL
          AND e.revoked_at IS NULL
        ORDER BY e.rowid`,
    )
    .all() as UndispatchedRow[];

  // Group by stream lane.
  const byStream = new Map<string, UndispatchedRow[]>();
  for (const r of rows) {
    const sid = r.stream_id ?? r.stream_key;
    const list = byStream.get(sid);
    if (list) list.push(r);
    else byStream.set(sid, [r]);
  }

  const stateStmt = db.prepare(
    `SELECT id, cursor_rowid, defer_since, engagement_score
       FROM streams WHERE id = ?`,
  );
  const setDefer = db.prepare(
    `UPDATE streams SET defer_since = ? WHERE id = ? AND defer_since IS NULL`,
  );

  const bundles: DeltaBundle[] = [];
  const deferred: DeferredStream[] = [];
  const engagement = new Map<string, number>();

  for (const [streamId, streamRows] of byStream) {
    const state = stateStmt.get(streamId) as StreamStateRow | undefined;
    const cursor = state?.cursor_rowid ?? 0;
    engagement.set(streamId, state?.engagement_score ?? 0);

    // Delta = events beyond the cursor. dispatched_at IS NULL already excludes
    // handled rows; the cursor guard keeps a re-run from re-bundling rows a
    // half-finished mark left behind.
    const events = streamRows.filter((r) => r.rowid > cursor).map(toBundleEvent);
    if (events.length === 0) continue;

    const lane: Lane = events.some((e) => e.origin === "live")
      ? "live"
      : "backfill";
    const ageBand = events.reduce<AgeBand>(
      (best, e) => (BAND_ORDER[e.ageBand] < BAND_ORDER[best] ? e.ageBand : best),
      "D",
    );

    // Low-signal deferral (live lane only — backfill batches are never
    // urgency-priced, they just batch). Floor + max-defer bound (BND-02).
    let forced = false;
    if (lane === "live" && isLowSignal(events, cfg)) {
      const since = state?.defer_since ?? null;
      if (since === null) {
        const sinceIso = new Date(nowMs).toISOString();
        setDefer.run(sinceIso, streamId);
        deferred.push({
          streamId,
          streamKey: streamRows[0].stream_key,
          eventCount: events.length,
          deferSince: sinceIso,
        });
        continue;
      }
      if (nowMs - Date.parse(since) < cfg.maxDeferMs) {
        deferred.push({
          streamId,
          streamKey: streamRows[0].stream_key,
          eventCount: events.length,
          deferSince: since,
        });
        continue;
      }
      forced = true; // max-defer hit: an "ok" still matters for closure
    }

    // Max-size split with predecessor summaries (BND-05).
    const partCount = Math.max(1, Math.ceil(events.length / cfg.maxBundleEvents));
    let predecessorSummary: string | undefined;
    for (let p = 0; p < partCount; p++) {
      const slice = events.slice(
        p * cfg.maxBundleEvents,
        (p + 1) * cfg.maxBundleEvents,
      );
      const bundle: DeltaBundle = {
        streamId,
        streamKey: streamRows[0].stream_key,
        lane,
        ageBand,
        events: slice,
        part: p + 1,
        partCount,
        predecessorSummary,
        forced: forced || undefined,
      };
      bundles.push(bundle);
      predecessorSummary = summarizePart(bundle);
    }
  }

  // Priority lanes: live > backfill; backfill A > B > C > D, then engagement
  // (ordering signal only), then stream key for determinism; split parts stay
  // in order.
  bundles.sort((a, b) => {
    if (a.lane !== b.lane) return a.lane === "live" ? -1 : 1;
    if (a.lane === "backfill" && BAND_ORDER[a.ageBand] !== BAND_ORDER[b.ageBand])
      return BAND_ORDER[a.ageBand] - BAND_ORDER[b.ageBand];
    const ea = engagement.get(a.streamId) ?? 0;
    const eb = engagement.get(b.streamId) ?? 0;
    if (ea !== eb) return eb - ea;
    if (a.streamKey !== b.streamKey) return a.streamKey < b.streamKey ? -1 : 1;
    return a.part - b.part;
  });

  return { bundles, deferred };
}

/**
 * Live preemption over bounded slots (BND-06): fill up to `freeSlots` from the
 * plan, live bundles first — a live bundle enters the very next window even
 * when a saturated backfill queue predates it, and backfill resumes with
 * whatever room is left.
 */
export function assignSlots(
  plan: TickPlan,
  freeSlots: number = DEFAULT_DISPATCH_CONFIG.slots,
): DeltaBundle[] {
  return plan.bundles.slice(0, Math.max(0, freeSlots));
}

// ---- Mark ------------------------------------------------------------------

/**
 * Record a successful hand-off: stamp every event's processed mark and advance
 * the stream cursor to the bundle's last rowid — the ONLY place cursors move.
 * Clears the deferral clock (the lane spoke; the next 👍 starts a fresh one).
 */
export function markDispatched(
  bundle: DeltaBundle,
  nowMs: number = Date.now(),
): void {
  const db = getDb();
  const nowIso = new Date(nowMs).toISOString();
  const stamp = db.prepare(`UPDATE events SET dispatched_at = ? WHERE rowid = ?`);
  const advance = db.prepare(
    `UPDATE streams
        SET cursor_rowid = MAX(cursor_rowid, ?), defer_since = NULL
      WHERE id = ?`,
  );
  const run = db.transaction(() => {
    let maxRowid = 0;
    for (const e of bundle.events) {
      stamp.run(nowIso, e.rowid);
      if (e.rowid > maxRowid) maxRowid = e.rowid;
    }
    advance.run(maxRowid, bundle.streamId);
  });
  run();
}

// ---- Orphan scan -----------------------------------------------------------

export interface OrphanScanResult {
  /** Bundles rebuilt from orphaned events, in lane-priority order. */
  bundles: DeltaBundle[];
  orphanCount: number;
}

/**
 * Containment safety net (BND-04): any envelope event with no processed mark
 * whose row landed more than N windows ago is re-queued as a bundle,
 * REGARDLESS of cursors or deferral state. A backfill wave that arrived after
 * its stream was processed, a crashed tick, a deferral row lost to a restart —
 * all end up here instead of nowhere.
 */
export function orphanScan(
  nowMs: number = Date.now(),
  cfg: DispatchConfig = DEFAULT_DISPATCH_CONFIG,
): OrphanScanResult {
  const db = getDb();
  const cutoffIso = new Date(nowMs - cfg.orphanWindows * cfg.windowMs).toISOString();
  const rows = db
    .prepare(
      `SELECT e.rowid AS rowid, e.id, e.stream_id, e.stream_key, e.ts, e.kind,
              e.text, e.actor, e.origin, e.age_band, e.roles_json, e.payload_json
         FROM events e
        WHERE e.dispatched_at IS NULL
          AND e.stream_key IS NOT NULL
          AND e.revoked_at IS NULL
          AND COALESCE(e.captured_at, e.created_at) < ?
        ORDER BY e.rowid`,
    )
    .all(cutoffIso) as UndispatchedRow[];

  const byStream = new Map<string, UndispatchedRow[]>();
  for (const r of rows) {
    const sid = r.stream_id ?? r.stream_key;
    const list = byStream.get(sid);
    if (list) list.push(r);
    else byStream.set(sid, [r]);
  }

  const bundles: DeltaBundle[] = [];
  for (const [streamId, streamRows] of byStream) {
    const events = streamRows.map(toBundleEvent);
    const lane: Lane = events.some((e) => e.origin === "live")
      ? "live"
      : "backfill";
    const ageBand = events.reduce<AgeBand>(
      (best, e) => (BAND_ORDER[e.ageBand] < BAND_ORDER[best] ? e.ageBand : best),
      "D",
    );
    const partCount = Math.max(1, Math.ceil(events.length / cfg.maxBundleEvents));
    let predecessorSummary: string | undefined;
    for (let p = 0; p < partCount; p++) {
      const bundle: DeltaBundle = {
        streamId,
        streamKey: streamRows[0].stream_key,
        lane,
        ageBand,
        events: events.slice(p * cfg.maxBundleEvents, (p + 1) * cfg.maxBundleEvents),
        part: p + 1,
        partCount,
        predecessorSummary,
        forced: true,
      };
      bundles.push(bundle);
      predecessorSummary = summarizePart(bundle);
    }
  }

  bundles.sort((a, b) => {
    if (a.lane !== b.lane) return a.lane === "live" ? -1 : 1;
    if (BAND_ORDER[a.ageBand] !== BAND_ORDER[b.ageBand])
      return BAND_ORDER[a.ageBand] - BAND_ORDER[b.ageBand];
    if (a.streamKey !== b.streamKey) return a.streamKey < b.streamKey ? -1 : 1;
    return a.part - b.part;
  });

  return { bundles, orphanCount: rows.length };
}

// ---- Production loop -------------------------------------------------------

export interface DispatcherHandle {
  stop(): void;
}

export interface DispatcherOptions {
  cfg?: DispatchConfig;
  /**
   * Tick consumer. Default marks the bundle dispatched — the Orient map-reduce
   * (spec §6.3) replaces this in P1 and calls markDispatched() on commit.
   */
  onBundle?: (bundle: DeltaBundle) => void;
  log?: (line: string) => void;
}

/**
 * The window clock (production caller — wired in worker/src/index.ts). Every
 * window: plan the tick, hand each planned bundle to the sink, and run the
 * orphan scan behind it.
 */
export function startDispatcher(opts: DispatcherOptions = {}): DispatcherHandle {
  const cfg = opts.cfg ?? DEFAULT_DISPATCH_CONFIG;
  const log = opts.log ?? (() => {});
  const onBundle =
    opts.onBundle ??
    ((bundle: DeltaBundle) => {
      markDispatched(bundle);
    });

  const tick = (): void => {
    try {
      const now = Date.now();
      const plan = collectTick(now, cfg);
      const slotted = assignSlots(plan, cfg.slots);
      for (const bundle of slotted) onBundle(bundle);
      const orphans = orphanScan(now, cfg);
      for (const bundle of orphans.bundles) onBundle(bundle);
      if (slotted.length > 0 || orphans.orphanCount > 0) {
        log(
          `[dispatch] window: ${slotted.length} bundle(s), ` +
            `${plan.deferred.length} deferred, ${orphans.orphanCount} orphan(s)`,
        );
      }
    } catch (err) {
      log(`[dispatch] tick failed: ${(err as Error).message}`);
    }
  };

  const timer = setInterval(tick, cfg.windowMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
