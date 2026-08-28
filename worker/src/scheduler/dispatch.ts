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
import type { StreamCategory } from "../categories/chat.js";
import {
  admitWork,
  applyFirstExperienceSlice,
  compareBundles,
  isFirstExperience,
  pendingCat1Counts,
  type SlotState,
} from "./priority.js";
import { runDigestPass } from "./digest-pass.js";
import { registerBundleForEnrichment } from "../media/bundle-pass.js";

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
  /**
   * Stream category (spec §5.1). null = not yet classified, ordered as Cat 1
   * (unknown work is early work — misclassification costs latency, never data).
   */
  category?: StreamCategory | null;
  /** Newest event day ("YYYY-MM-DD") — the §5.2 day-major key. */
  day?: string;
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
  category: string | null;
}

/** Stream category, with the browser per-event fallback (P0.8 stamps it on the payload). */
function categoryOf(
  state: StreamStateRow | undefined,
  events: BundleEvent[],
): StreamCategory | null {
  if (state?.category === "cat1" || state?.category === "cat2") return state.category;
  // Browser events carry the per-domain verdict on the payload; any cat1
  // evidence wins, "ambiguous" orders as Cat 2 (later, coarser, never dropped).
  let sawBrowserVerdict = false;
  for (const e of events) {
    if (!e.kind?.startsWith("browser.") || !e.payloadJson) continue;
    try {
      const cat = (JSON.parse(e.payloadJson) as { category?: string }).category;
      if (cat === "cat1") return "cat1";
      if (cat === "cat2" || cat === "ambiguous") sawBrowserVerdict = true;
    } catch {
      /* a malformed payload is not a category */
    }
  }
  return sawBrowserVerdict ? "cat2" : null;
}

/** Newest event day in the bundle — the §5.2 day-major key. */
function dayOf(events: BundleEvent[]): string {
  let newest = "";
  for (const e of events) {
    const day = (e.ts ?? "").slice(0, 10);
    if (day > newest) newest = day;
  }
  return newest;
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
    `SELECT id, cursor_rowid, defer_since, engagement_score, category
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
    const category = categoryOf(state, events);
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
        category,
        day: dayOf(slice),
      };
      bundles.push(bundle);
      predecessorSummary = summarizePart(bundle);
    }
  }

  // Priority order (spec §5.2, scheduler/priority.ts): live > backfill;
  // backfill A > B > C > D (day-major inside a band, newest first), then
  // source order (wa > screen > browser), Cat 1 before Cat 2, engagement
  // (ordering signal only), then stream key for determinism; split parts
  // stay in order.
  const ctx = { engagement };
  bundles.sort((a, b) => compareBundles(a, b, ctx));

  // First-experience slice (spec §5.2.4): until the very first dispatch, the
  // most recent 3–7 days of top-engagement chats jump the backfill queue so
  // first proposals land in minutes.
  if (bundles.length > 0 && isFirstExperience()) {
    return {
      bundles: applyFirstExperienceSlice(bundles, ctx, { nowMs }),
      deferred,
    };
  }

  return { bundles, deferred };
}

/**
 * Live preemption over bounded slots (BND-06): fill up to `freeSlots` from the
 * plan, live bundles first — a live bundle enters the very next window even
 * when a saturated backfill queue predates it, and backfill resumes with
 * whatever room is left.
 *
 * The Cat-1-before-Cat-2 slot rule (spec §5.2.3, eval CAT-05) is applied
 * here: a Cat-2 backfill bundle (Digest work) never takes a CLI slot while
 * ANY Cat-1 work — data or media enrichment — is still pending. `state`
 * defaults to the DB's live counts; tests pass it explicitly.
 */
export function assignSlots(
  plan: TickPlan,
  freeSlots: number = DEFAULT_DISPATCH_CONFIG.slots,
  state?: SlotState,
): DeltaBundle[] {
  const admitted = plan.bundles.filter((b) => {
    if (b.lane === "live" || b.category !== "cat2") return true;
    const s = (state ??= pendingCat1Counts());
    return admitWork(
      { id: b.streamId, lane: b.lane, kind: "data", category: "cat2" },
      s,
    );
  });
  return admitted.slice(0, Math.max(0, freeSlots));
}

// ---- Mark ------------------------------------------------------------------

/**
 * Record a successful hand-off: stamp every event's processed mark and advance
 * the stream cursor to the bundle's last rowid — the ONLY place cursors move.
 * Clears the deferral clock (the lane spoke; the next 👍 starts a fresh one).
 *
 * The hand-off is also where the enrichment countdown arms (P1.8, spec §4.4
 * rule 2): a bundle dispatched with unread attachments gets an
 * `enrichment_bundles` row, and the media lane counts it down to the one
 * scoped re-understand job. Best-effort by design — a countdown that fails to
 * arm must not unwind a dispatch that committed (the orphan-scan side of
 * containment does not cover it, but the register is a plain insert and the
 * failure is logged loudly).
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
  try {
    registerBundleForEnrichment({
      streamId: bundle.streamId,
      events: bundle.events,
    });
  } catch (err) {
    console.error(
      `[dispatch] enrichment countdown failed for ${bundle.streamKey}:`,
      err,
    );
  }
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

  const stateStmt = db.prepare(
    `SELECT id, cursor_rowid, defer_since, engagement_score, category
       FROM streams WHERE id = ?`,
  );
  const bundles: DeltaBundle[] = [];
  for (const [streamId, streamRows] of byStream) {
    const state = stateStmt.get(streamId) as StreamStateRow | undefined;
    const events = streamRows.map(toBundleEvent);
    const lane: Lane = events.some((e) => e.origin === "live")
      ? "live"
      : "backfill";
    const ageBand = events.reduce<AgeBand>(
      (best, e) => (BAND_ORDER[e.ageBand] < BAND_ORDER[best] ? e.ageBand : best),
      "D",
    );
    const category = categoryOf(state, events);
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
        category,
        day: dayOf(events.slice(p * cfg.maxBundleEvents, (p + 1) * cfg.maxBundleEvents)),
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
  /**
   * Cat-2 backfill consumer (spec §8.5): the Digest pass. Default runs
   * digest.v1 through the traced provider path and marks the bundle
   * dispatched ONLY on success — a failed digest is re-queued by the orphan
   * scan. Only reached when the CAT-05 gate admitted the bundle.
   */
  onDigestBundle?: (bundle: DeltaBundle) => void;
  log?: (line: string) => void;
}

/** Cat-2 backfill goes to Digest, never to the full pass ladder (spec §5.2.3). */
export function isDigestBundle(bundle: DeltaBundle): boolean {
  return bundle.lane === "backfill" && bundle.category === "cat2";
}

/**
 * The window clock (production caller — wired in worker/src/index.ts). Every
 * window: plan the tick, apply the Cat-1-before-Cat-2 slot gate, hand each
 * planned bundle to its sink (full passes vs Digest), and run the orphan scan
 * behind it.
 */
export function startDispatcher(opts: DispatcherOptions = {}): DispatcherHandle {
  const cfg = opts.cfg ?? DEFAULT_DISPATCH_CONFIG;
  const log = opts.log ?? (() => {});
  const onBundle =
    opts.onBundle ??
    ((bundle: DeltaBundle) => {
      markDispatched(bundle);
    });
  const onDigestBundle =
    opts.onDigestBundle ??
    ((bundle: DeltaBundle) => {
      void runDigestPass(bundle)
        .then((report) => {
          if (report.status === "ok") markDispatched(bundle);
          else log(`[dispatch] digest failed for ${bundle.streamKey}: ${report.error}`);
        })
        .catch((err) => log(`[dispatch] digest threw for ${bundle.streamKey}: ${err}`));
    });
  const route = (bundle: DeltaBundle): void => {
    if (isDigestBundle(bundle)) onDigestBundle(bundle);
    else onBundle(bundle);
  };

  const tick = (): void => {
    try {
      const now = Date.now();
      const plan = collectTick(now, cfg);
      const gate = pendingCat1Counts();
      const slotted = assignSlots(plan, cfg.slots, gate);
      for (const bundle of slotted) route(bundle);
      const orphans = orphanScan(now, cfg);
      // Orphans re-enter through the same CAT-05 gate: a Cat-2 orphan waits
      // for Cat-1 to finish exactly like a planned Cat-2 bundle would.
      const admittedOrphans = orphans.bundles.filter(
        (b) =>
          !isDigestBundle(b) ||
          admitWork({ id: b.streamId, lane: b.lane, kind: "data", category: "cat2" }, gate),
      );
      for (const bundle of admittedOrphans) route(bundle);
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
