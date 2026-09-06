// ===========================================================================
// [CODE] Freshness — "Knows you: X → Y" (build P2.4, spec §5.4, §14.3.2).
//
// Two ranges per source, and the distinction is the whole feature:
//
//   captured    min/max events.ts — what the log HOLDS.
//   understood  min/max events.ts over rows that are a member of an episode
//               (freshness/understood.ts) — what the twin has READ.
//
// The headline renders the UNDERSTOOD range ("Knows you: Mar 2024 → 2 min
// ago"); its left edge crawls backward while backfill dispatch works through
// history, its right edge tracks live understanding.
//
// WHAT "UNDERSTOOD" USED TO MEAN, AND WHY IT WAS A FICTION (FIX-C5). Until
// this fix the three understood_* fields were `dispatched_at IS NOT NULL`.
// That column is the DISPATCHER's flag — "no lane will look at this row
// again" — and the consent gate sets it on every row OUTSIDE the Understand
// window (origin='archive', dispatched_at = capture_ts) exactly so the lane
// builders skip them. So the chip counted rows that had never been near a
// model: on the reporting user's home, browser understood_count 16,596 for
// 632 events that actually carry an episode, understood_from 2010-09-27, and
// a header reading "Knows you: 2010 → 2h ago" while the pipeline was
// hard-stopped. The definition now lives in one place, shared with the
// Library's Storage bar so the two surfaces cannot disagree again.
//
// AND THE VERDICT CAN NOW SAY "STOPPED". `freshness/hold.ts` reads the spend
// latch, the kill switch and the breaker; a hold outranks every other verdict
// and replaces the old unconditional "understanding: caught up" — which is the
// line that printed while nothing had been understood for an hour.
//
// WHAT THE LAG NUMBER MEANS — and the bug this replaces. Shipped 13.4.1
// computed `lag_minutes` as the age of the oldest undispatched event of ANY
// origin. A history import lands thousands of backfill rows at once and their
// captured_at is frozen at import time, so the chip flipped to "catching up —
// N min behind" the moment you imported and N then grew by one every minute,
// forever, with nothing the user could do about it. (On the reporting user's
// machine the record-holder was a leaked eval fixture row: captured_at
// 23:33 → "236 min behind" at 03:29, still climbing.)
//
// The ≤10-min promise is about LIVE capture: something that just happened is
// understood within ten minutes. So:
//
//   lag_minutes            age of the oldest pending LIVE event. This is the
//                          promise, and a breach means something is stuck.
//   pending_backfill_count how much imported history is still unread. A
//                          finite number that SHRINKS — the honest way to say
//                          "importing history", and the actionable one.
//   status/status_label    the single settled-or-not verdict the chip shows:
//                          "up to date" · "importing history — 2,569 events
//                          left" · "catching up — 14 min behind".
//
// Pure reads — no writes, no model calls. The math is exported as pure
// functions so it is unit-testable with fixed clocks and fixed counts.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { hasUnsealedStreams } from "../db/watermarks.js";
import { understandingHold, type UnderstandingHold } from "./hold.js";
import {
  EMPTY_UNDERSTOOD,
  understoodBySource,
  understoodForSource,
  type UnderstoodTier,
} from "./understood.js";

export type { UnderstandingHold } from "./hold.js";

/** Spec §5.4: the freshness promise, minutes. Breaching it shows the lag chip. */
export const FRESHNESS_PROMISE_MIN = 10;

/**
 * The settled-or-not verdict, worst-first when aggregated across sources.
 * `paused` (FIX-C5) is worst of all: it is the only one that means no amount
 * of waiting will change the numbers.
 */
export type FreshnessStatus =
  | "paused"
  | "catching_up"
  | "importing_history"
  | "up_to_date"
  | "no_data";

const STATUS_RANK: Record<FreshnessStatus, number> = {
  paused: 4,
  catching_up: 3,
  importing_history: 2,
  up_to_date: 1,
  no_data: 0,
};

export interface SourceFreshness {
  source_id: string;
  /** What the log holds: min/max events.ts for the source. */
  captured_from: string | null;
  captured_to: string | null;
  /** What the twin has read: min/max events.ts over episode members (FIX-C5). */
  understood_from: string | null;
  understood_to: string | null;
  /** Everything the log holds for the source, archive rows included. */
  event_count: number;
  /**
   * Events inside the UNDERSTAND window (origin <> 'archive') — what the twin
   * was ASKED to understand, and the honest denominator for progress.
   */
  understand_window_count: number;
  /** Outside it: kept, searchable, never sent to a model (consent gate S1.2). */
  archive_count: number;
  /** Events that are a member of an episode. The one honest count. */
  understood_count: number;
  pending_count: number;
  /** Undispatched live-captured events — the ones the promise is about. */
  pending_live_count: number;
  /** Undispatched imported-history events — the finite, shrinking backlog. */
  pending_backfill_count: number;
  /**
   * Age of the oldest pending LIVE event (by captured_at), minutes; null when
   * nothing live is waiting. Imported history is deliberately excluded — see
   * the header note.
   */
  lag_minutes: number | null;
  /** True once every stream of the source has a sealed backfill watermark. */
  backfill_complete: boolean;
  /**
   * Understood / in the Understand window, 0-100 — the "importing history
   * (72%)" number. The denominator is the window, not the log: archive rows
   * are never going to a model, so counting them would pin every bar with a
   * big archive behind it at single digits forever.
   */
  understood_percent: number;
  /** "Knows you: Mar 2024 → 2 min ago", or null before anything is understood. */
  label: string | null;
  /** The settled-or-not verdict. */
  status: FreshnessStatus;
  /** The verdict as one human phrase ("up to date"). */
  status_label: string;
  /** The expanded §5.4 detail line. */
  detail: string;
}

export interface FreshnessOverview {
  sources: SourceFreshness[];
  /** The header chip: understood range across ALL sources. */
  label: string | null;
  /** Worst live lag across sources, minutes; null when nothing live is stuck. */
  lag_minutes: number | null;
  /** Worst status across sources. */
  status: FreshnessStatus;
  status_label: string;
  pending_live_count: number;
  pending_backfill_count: number;
  /**
   * Why understanding is stopped, or null when it is running (FIX-C5). The
   * same fact Settings › General shows, so the chip and the operator panel
   * cannot contradict each other.
   */
  hold: UnderstandingHold | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The left edge of "Knows you": "Mar 2024" within the last two years,
 * bare "2019" beyond that (spec §14.3.2 shows both forms).
 */
export function formatLeftEdge(ts: string, nowMs: number): string {
  const d = new Date(ts);
  const twoYears = 2 * 365.25 * 24 * 3600 * 1000;
  if (nowMs - d.getTime() >= twoYears) return String(d.getUTCFullYear());
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The right edge: relative and fresh-feeling ("2 min ago", "2h ago"). */
export function formatRightEdge(ts: string, nowMs: number): string {
  const ms = nowMs - new Date(ts).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 2) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const dt = new Date(ts);
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

/** "Knows you: Mar 2024 → 2 min ago". Null until both edges exist. */
export function knowsYouLabel(
  understoodFrom: string | null,
  understoodTo: string | null,
  nowMs: number,
): string | null {
  if (!understoodFrom || !understoodTo) return null;
  return `Knows you: ${formatLeftEdge(understoodFrom, nowMs)} → ${formatRightEdge(understoodTo, nowMs)}`;
}

/** A lag rendered the way a human reads a clock, not as unbounded minutes. */
export function formatLag(minutes: number): string {
  if (minutes < 60) return `${minutes} min behind`;
  const h = Math.floor(minutes / 60);
  if (h < 24) {
    const m = minutes % 60;
    return m === 0 ? `${h}h behind` : `${h}h ${m}m behind`;
  }
  const d = Math.floor(h / 24);
  return d === 1 ? "a day behind" : `${d} days behind`;
}

export interface FreshnessCounts {
  event_count: number;
  pending_live_count: number;
  pending_backfill_count: number;
  /** Age of the oldest pending LIVE event, minutes. */
  lag_minutes: number | null;
}

/**
 * The verdict, from the counts and the hold. THE settled case is the point:
 * with nothing waiting the chip must say so out loud rather than going quiet —
 * and with the pipeline STOPPED it must say that instead, out loud, first.
 *
 * Order of precedence:
 *   0. nothing captured at all — there is no verdict to give;
 *   1. a hold — the spend latch, the kill switch or a breaker. Nothing below
 *      this line is true while one is on: a queue that is not moving is not
 *      "importing", and a twin that is refusing every call is not "up to
 *      date". This is the case that printed "understanding: caught up" on the
 *      reporting user's machine (FIX-C5);
 *   2. a breached live promise — something is genuinely stuck;
 *   3. imported history still being read — finite, and the number falls;
 *   4. everything else — up to date. Live events inside the 10-minute promise
 *      count as up to date, because the promise is exactly that window.
 */
export function freshnessStatus(
  c: FreshnessCounts,
  hold: UnderstandingHold | null = null,
): { status: FreshnessStatus; label: string } {
  if (c.event_count === 0) return { status: "no_data", label: "nothing captured yet" };
  if (hold) return { status: "paused", label: hold.label };
  if (c.lag_minutes != null && c.lag_minutes > FRESHNESS_PROMISE_MIN) {
    return { status: "catching_up", label: `catching up — ${formatLag(c.lag_minutes)}` };
  }
  if (c.pending_backfill_count > 0) {
    const n = c.pending_backfill_count.toLocaleString("en-US");
    return {
      status: "importing_history",
      label: `importing history — ${n} ${c.pending_backfill_count === 1 ? "event" : "events"} left`,
    };
  }
  return { status: "up_to_date", label: "up to date" };
}

/**
 * The §5.4 expanded detail line, from the numbers and the hold (pure,
 * testable).
 *
 * The last clause is the one FIX-C5 rewrites. It used to be
 *
 *     status === "catching_up" ? label : "understanding: caught up"
 *
 * — i.e. "caught up" for every state except one, including a queue of eleven
 * thousand undispatched events and a latched spend ceiling. Now the only way
 * to read "caught up" is to actually be caught up: nothing pending, nothing
 * holding the pipeline.
 */
export function freshnessDetail(
  f: {
    captured_to: string | null;
    understood_from: string | null;
    backfill_complete: boolean;
    understood_percent: number;
    /** Optional so the pure-function tests can keep passing bare counts. */
    understand_window_count?: number;
  } & FreshnessCounts,
  nowMs: number,
  hold: UnderstandingHold | null = null,
): string {
  const parts: string[] = [];
  parts.push(f.captured_to ? "capturing live ✓" : "nothing captured yet");
  if (!f.backfill_complete && f.understood_from) {
    const left =
      f.pending_backfill_count > 0
        ? `, ${f.pending_backfill_count.toLocaleString("en-US")} left`
        : "";
    parts.push(
      `importing history: at ${formatLeftEdge(f.understood_from, nowMs)} (${f.understood_percent}%${left})`,
    );
  }
  const { status, label } = freshnessStatus(f, hold);
  if (status === "up_to_date" && f.understand_window_count === 0 && f.event_count > 0) {
    // Everything this source holds is outside the Understand window: kept and
    // searchable, never sent to a model. "Caught up" would be true and useless
    // — say what is actually going on.
    parts.push("understanding: nothing is inside the understand window");
  } else {
    parts.push(status === "up_to_date" ? "understanding: caught up" : label);
  }
  return parts.join(" · ");
}

interface RangeRow {
  captured_from: string | null;
  captured_to: string | null;
  event_count: number;
  understand_window_count: number;
  archive_count: number;
  pending_live_count: number;
  pending_backfill_count: number;
  oldest_pending_live_captured_at: string | null;
}

/**
 * `origin` is NULL only on rows written before the V13 envelope landed; the
 * live lane is the conservative reading (it is the one the promise covers).
 */
const IS_LIVE = `(origin IS NULL OR origin <> 'backfill')`;

/** Outside the UNDERSTAND window: stamped by the consent gate (S1.2). */
const IS_ARCHIVE = `COALESCE(origin, '') = 'archive'`;

export interface SourceFreshnessOpts {
  /**
   * This source's understood tier, when the caller has already computed every
   * source's in one pass (freshnessOverview does). Omitted → read here.
   */
  understood?: UnderstoodTier;
  /**
   * Why understanding is stopped. Omitted → read from the latch, the kill
   * switch and the breaker. Pass `null` explicitly for "nothing is holding it".
   */
  hold?: UnderstandingHold | null;
}

/** Compute one source's freshness. Pure read; `nowMs` injectable for tests. */
export function sourceFreshness(
  sourceId: string,
  nowMs: number = Date.now(),
  opts: SourceFreshnessOpts = {},
): SourceFreshness {
  const db = getDb();
  const r = db
    .prepare(
      `SELECT MIN(ts) AS captured_from, MAX(ts) AS captured_to,
              COUNT(*) AS event_count,
              SUM(CASE WHEN ${IS_ARCHIVE} THEN 0 ELSE 1 END) AS understand_window_count,
              SUM(CASE WHEN ${IS_ARCHIVE} THEN 1 ELSE 0 END) AS archive_count,
              SUM(CASE WHEN dispatched_at IS NULL AND ${IS_LIVE} THEN 1 ELSE 0 END)
                AS pending_live_count,
              SUM(CASE WHEN dispatched_at IS NULL AND NOT ${IS_LIVE} THEN 1 ELSE 0 END)
                AS pending_backfill_count,
              MIN(CASE WHEN dispatched_at IS NULL AND ${IS_LIVE}
                       THEN COALESCE(captured_at, ts) END)
                AS oldest_pending_live_captured_at
         FROM events
        WHERE source_type = ?`,
    )
    .get(sourceId) as RangeRow;

  // THE honest count, from the one shared definition: events with an episode.
  const understood = opts.understood ?? understoodForSource(sourceId);
  const hold = opts.hold === undefined ? understandingHold(nowMs) : opts.hold;
  const inWindow = r.understand_window_count ?? 0;
  const pendingLive = r.pending_live_count ?? 0;
  const pendingBackfill = r.pending_backfill_count ?? 0;
  const lag =
    r.oldest_pending_live_captured_at != null
      ? Math.max(
          0,
          Math.floor((nowMs - new Date(r.oldest_pending_live_captured_at).getTime()) / 60_000),
        )
      : null;
  const percent = inWindow > 0 ? Math.round((understood.events / inWindow) * 100) : 0;
  const backfillComplete = r.event_count > 0 && !hasUnsealedStreams(sourceId);
  const base = {
    source_id: sourceId,
    captured_from: r.captured_from,
    captured_to: r.captured_to,
    understood_from: understood.from,
    understood_to: understood.to,
    event_count: r.event_count,
    understand_window_count: inWindow,
    archive_count: r.archive_count ?? 0,
    understood_count: understood.events,
    pending_count: pendingLive + pendingBackfill,
    pending_live_count: pendingLive,
    pending_backfill_count: pendingBackfill,
    lag_minutes: lag,
    backfill_complete: backfillComplete,
    understood_percent: percent,
  };
  const verdict = freshnessStatus(base, hold);
  return {
    ...base,
    label: knowsYouLabel(understood.from, understood.to, nowMs),
    status: verdict.status,
    status_label: verdict.label,
    detail: freshnessDetail(base, nowMs, hold),
  };
}

/** Every source that has events, plus the cross-source header chip. */
export function freshnessOverview(nowMs: number = Date.now()): FreshnessOverview {
  const db = getDb();
  const ids = (
    db.prepare(`SELECT DISTINCT source_type AS id FROM events ORDER BY id`).all() as { id: string }[]
  ).map((r) => r.id);
  // One membership scan and one hold read for the whole overview, not one per
  // source: this runs on the header chip's poll.
  const understood = understoodBySource();
  const hold = understandingHold(nowMs);
  const sources = ids.map((id) =>
    sourceFreshness(id, nowMs, { understood: understood.get(id) ?? { ...EMPTY_UNDERSTOOD }, hold }),
  );
  let from: string | null = null;
  let to: string | null = null;
  let lag: number | null = null;
  let events = 0;
  let pendingLive = 0;
  let pendingBackfill = 0;
  for (const s of sources) {
    if (s.understood_from && (!from || s.understood_from < from)) from = s.understood_from;
    if (s.understood_to && (!to || s.understood_to > to)) to = s.understood_to;
    // The header lag is the worst BREACH; a source inside the promise is not
    // "behind" and must not drag the whole chip into a lag state.
    if (
      s.lag_minutes != null &&
      s.lag_minutes > FRESHNESS_PROMISE_MIN &&
      (lag == null || s.lag_minutes > lag)
    ) {
      lag = s.lag_minutes;
    }
    events += s.event_count;
    pendingLive += s.pending_live_count;
    pendingBackfill += s.pending_backfill_count;
  }
  // ONE source of truth: the header runs the same pure verdict the per-source
  // rows run, over the summed counts and the worst breaching lag. That makes
  // it identically the worst per-source status (asserted in the tests), so the
  // chip can never contradict the detail lines beneath it.
  const verdict = freshnessStatus(
    {
      event_count: events,
      pending_live_count: pendingLive,
      pending_backfill_count: pendingBackfill,
      lag_minutes: lag,
    },
    hold,
  );

  return {
    sources,
    label: knowsYouLabel(from, to, nowMs),
    lag_minutes: lag,
    status: verdict.status,
    status_label: verdict.label,
    pending_live_count: pendingLive,
    pending_backfill_count: pendingBackfill,
    hold,
  };
}

/** Rank used by the tests to assert the header equals the worst source. */
export function statusRank(status: FreshnessStatus): number {
  return STATUS_RANK[status];
}
