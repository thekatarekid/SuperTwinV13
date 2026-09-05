// ===========================================================================
// V13 dispatch — cursors, delta bundles, priority lanes (build P0.5, spec §6.2;
// pruned in V6 P1 S0.5 — this code dies in S3 when the state gate lands).
//
// There is no segmenter. Each tick, every stream with new events yields ONE
// delta bundle = the events between the stream's cursor and now. Bundle
// boundaries are semantically meaningless by design (§6.2.5); episodes +
// thread history absorb every mid-conversation cut (BND-03).
//
// The moving parts, all deterministic (BND-01/03/05/06 assert them, no model):
//
//   cursor      per stream, ROWID-based (insertion order, never ts) and moved
//               ONLY by markDispatched() — a collect that fails to hand off
//               leaves the log exactly where it was (BND-01 cursor-skip). A
//               bundle that is never marked is simply re-collected next tick.
//   split       an oversized bundle is cut into capped parts; every successor
//               carries the predecessor part's summary so Digest output is
//               cumulative, never amnesiac (BND-05).
//   lanes       live > backfill, and within backfill band A > B > C > D, then
//               engagement score (an ordering signal only). Live preempts:
//               a live bundle is always planned ahead of every backfill batch
//               in the same tick (BND-06).
//   slot cap    runDispatchTick hands out at most cfg.slots bundles per tick,
//               on every path including re-dispatch (S0.3 / T0-1, BND-08).
//
// Deleted in S0.5 (Build V6 P1 §2.3): the 5-minute window clock
// (startDispatcher), the per-stream orphan scan, the INTENT_RE signal floor
// and low-signal deferral. There is NO production caller until S3 wires the
// state gate; the tick is a function the next scheduler calls or discards.
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
  /** Max events per bundle part; larger deltas split (BND-05). */
  maxBundleEvents: number;
  /** CLI slots the planner may fill in one tick — absolute, every path. */
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
  /** events.source_id — "wa" | "browser" | "screen" | … (V6 S1.6 / T6-7). */
  sourceId?: string | null;
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
  /**
   * Stream category (spec §5.1). null = not yet classified, ordered as Cat 1
   * (unknown work is early work — misclassification costs latency, never data).
   */
  category?: StreamCategory | null;
  /** Newest event day ("YYYY-MM-DD") — the §5.2 day-major key. */
  day?: string;
}

export interface TickPlan {
  /** Bundles in dispatch order: live first, then backfill A>B>C>D. */
  bundles: DeltaBundle[];
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
}

interface StreamStateRow {
  id: string;
  cursor_rowid: number;
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
    sourceId: r.source_id ?? null,
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
 * Plan one tick at `nowMs`: group every undispatched envelope event beyond
 * its stream's cursor into per-stream delta bundles, split oversized bundles,
 * and order the result by lane priority. Writes NOTHING — cursors move only
 * in markDispatched().
 */
export function collectTick(
  nowMs: number = Date.now(),
  cfg: DispatchConfig = DEFAULT_DISPATCH_CONFIG,
): TickPlan {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.rowid AS rowid, e.id, e.source_id, e.stream_id, e.stream_key, e.ts, e.kind,
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
    `SELECT id, cursor_rowid, engagement_score, category
       FROM streams WHERE id = ?`,
  );

  const bundles: DeltaBundle[] = [];
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
    return { bundles: applyFirstExperienceSlice(bundles, ctx, { nowMs }) };
  }

  return { bundles };
}

/**
 * Live preemption over bounded slots (BND-06): fill up to `freeSlots` from the
 * plan, live bundles first — a live bundle enters the very next tick even
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
 *
 * The hand-off is also where the enrichment countdown arms (P1.8, spec §4.4
 * rule 2): a bundle dispatched with unread attachments gets an
 * `enrichment_bundles` row, and the media lane counts it down to the one
 * scoped re-understand job. Best-effort by design — a countdown that fails to
 * arm must not unwind a dispatch that committed (the register is a plain
 * insert and the failure is logged loudly).
 */
export function markDispatched(
  bundle: DeltaBundle,
  nowMs: number = Date.now(),
): void {
  markDispatchedEvents(
    bundle,
    bundle.events.map((e) => e.id),
    nowMs,
  );
}

/**
 * Per-item salvage (V6 P1 S3.1, T2-7): stamp ONLY the named bundle events and
 * advance the cursor on event ids — to the largest rowid below which every
 * bundle event is stamped. Events the commit held (a rejected item's) stay
 * unstamped above the cursor, so the next collectTick re-bundles exactly
 * them; the events after them that did commit are stamped and never
 * re-collected. `markDispatched` is the every-event case.
 */
export function markDispatchedEvents(
  bundle: DeltaBundle,
  eventIds: readonly string[],
  nowMs: number = Date.now(),
): { stamped: number; cursorRowid: number } {
  const db = getDb();
  const nowIso = new Date(nowMs).toISOString();
  const want = new Set(eventIds);
  const stamp = db.prepare(`UPDATE events SET dispatched_at = ? WHERE rowid = ?`);
  const advance = db.prepare(
    `UPDATE streams
        SET cursor_rowid = MAX(cursor_rowid, ?)
      WHERE id = ?`,
  );
  const ordered = [...bundle.events].sort((a, b) => a.rowid - b.rowid);
  const stamped = ordered.filter((e) => want.has(e.id));
  let cursorRowid = 0;
  for (const e of ordered) {
    if (!want.has(e.id)) break;
    cursorRowid = e.rowid;
  }
  const run = db.transaction(() => {
    for (const e of stamped) stamp.run(nowIso, e.rowid);
    if (cursorRowid > 0) advance.run(cursorRowid, bundle.streamId);
  });
  run();
  if (stamped.length > 0) {
    try {
      registerBundleForEnrichment({
        streamId: bundle.streamId,
        events: stamped,
      });
    } catch (err) {
      console.error(
        `[dispatch] enrichment countdown failed for ${bundle.streamKey}:`,
        err,
      );
    }
  }
  return { stamped: stamped.length, cursorRowid };
}

// ---- The tick ---------------------------------------------------------------

export interface DispatcherOptions {
  cfg?: DispatchConfig;
  /**
   * Bundle sink. Default marks the bundle dispatched — the brain consumer
   * (brain/consumer.ts) is the real sink and calls markDispatched() on commit.
   */
  onBundle?: (bundle: DeltaBundle) => void;
  /**
   * Cat-2 backfill sink (spec §8.5): the Digest pass. Default runs digest.v1
   * through the traced provider path and marks the bundle dispatched ONLY on
   * success — a failed digest stays undispatched and is re-collected next
   * tick. Only reached when the CAT-05 gate admitted the bundle.
   */
  onDigestBundle?: (bundle: DeltaBundle) => void;
  log?: (line: string) => void;
}

/** Cat-2 backfill goes to Digest, never to the full pass ladder (spec §5.2.3). */
export function isDigestBundle(bundle: DeltaBundle): boolean {
  return bundle.lane === "backfill" && bundle.category === "cat2";
}

export interface TickResult {
  /** Bundles handed to a sink this tick — never more than cfg.slots. */
  routed: DeltaBundle[];
  /** Bundles the plan held that no slot admitted this tick. */
  heldBack: number;
}

/**
 * One dispatch tick: plan, apply the Cat-1-before-Cat-2 slot gate, hand each
 * admitted bundle to its sink. The slot cap is absolute (BND-08): at most
 * cfg.slots bundles leave this function per call, whatever the backlog, and a
 * bundle nobody marked is simply planned again on the next call.
 *
 * There is no clock here. The 5-minute window clock was deleted in S0.5; the
 * S3 state gate decides when a tick runs.
 */
export function runDispatchTick(opts: DispatcherOptions = {}, nowMs: number = Date.now()): TickResult {
  const cfg = opts.cfg ?? DEFAULT_DISPATCH_CONFIG;
  const log = opts.log ?? (() => {});
  const onBundle =
    opts.onBundle ??
    ((bundle: DeltaBundle) => {
      markDispatched(bundle, nowMs);
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

  const plan = collectTick(nowMs, cfg);
  const gate = pendingCat1Counts();
  const slotted = assignSlots(plan, cfg.slots, gate);
  for (const bundle of slotted) {
    if (isDigestBundle(bundle)) onDigestBundle(bundle);
    else onBundle(bundle);
  }
  if (slotted.length > 0) {
    log(`[dispatch] tick: ${slotted.length} bundle(s), ${plan.bundles.length - slotted.length} held back`);
  }
  return { routed: slotted, heldBack: plan.bundles.length - slotted.length };
}
