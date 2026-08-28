// ===========================================================================
// [CODE] Freshness — "Knows you: X → Y" (build P2.4, spec §5.4, §14.3.2).
//
// Two ranges per source, and the distinction is the whole feature:
//
//   captured    min/max events.ts — what the log HOLDS.
//   understood  min/max events.ts over rows the dispatcher has handed to a
//               tick (dispatched_at NOT NULL) — what the twin has READ.
//
// The headline chip renders the UNDERSTOOD range ("Knows you: Mar 2024 →
// 2 min ago"); its left edge crawls backward while backfill dispatch works
// through history, its right edge tracks live understanding. The captured
// range and the pending count feed the expanded detail ("capturing live ✓ ·
// importing history: at Jan 2024 (72%) · understanding: caught up"), and the
// lag chip ("catching up — 14 min behind") appears only when the oldest
// undispatched event has been sitting longer than the 10-minute promise.
//
// Pure reads — no writes, no model calls. Formatting helpers are exported
// separately so the watermark math is unit-testable with fixed clocks.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { hasUnsealedStreams } from "../db/watermarks.js";

/** Spec §5.4: the freshness promise, minutes. Breaching it shows the lag chip. */
export const FRESHNESS_PROMISE_MIN = 10;

export interface SourceFreshness {
  source_id: string;
  /** What the log holds: min/max events.ts for the source. */
  captured_from: string | null;
  captured_to: string | null;
  /** What the twin has read: min/max events.ts where dispatched_at is set. */
  understood_from: string | null;
  understood_to: string | null;
  event_count: number;
  understood_count: number;
  pending_count: number;
  /** Age of the oldest undispatched event (by captured_at), minutes. */
  lag_minutes: number | null;
  /** True once every stream of the source has a sealed backfill watermark. */
  backfill_complete: boolean;
  /** Dispatched / total, 0-100. The "importing history (72%)" number. */
  understood_percent: number;
  /** "Knows you: Mar 2024 → 2 min ago", or null before anything is understood. */
  label: string | null;
  /** The expanded §5.4 detail line. */
  detail: string;
}

export interface FreshnessOverview {
  sources: SourceFreshness[];
  /** The header chip: understood range across ALL sources. */
  label: string | null;
  /** Worst lag across sources, minutes; null when everything is caught up. */
  lag_minutes: number | null;
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

/** The §5.4 expanded detail line, from the numbers alone (pure, testable). */
export function freshnessDetail(f: {
  captured_to: string | null;
  understood_from: string | null;
  backfill_complete: boolean;
  understood_percent: number;
  lag_minutes: number | null;
}, nowMs: number): string {
  const parts: string[] = [];
  parts.push(f.captured_to ? "capturing live ✓" : "nothing captured yet");
  if (!f.backfill_complete && f.understood_from) {
    parts.push(
      `importing history: at ${formatLeftEdge(f.understood_from, nowMs)} (${f.understood_percent}%)`,
    );
  }
  if (f.lag_minutes != null && f.lag_minutes > FRESHNESS_PROMISE_MIN) {
    parts.push(`catching up — ${f.lag_minutes} min behind`);
  } else {
    parts.push("understanding: caught up");
  }
  return parts.join(" · ");
}

interface RangeRow {
  captured_from: string | null;
  captured_to: string | null;
  understood_from: string | null;
  understood_to: string | null;
  event_count: number;
  understood_count: number;
  oldest_pending_captured_at: string | null;
}

/** Compute one source's freshness. Pure read; `nowMs` injectable for tests. */
export function sourceFreshness(sourceId: string, nowMs: number = Date.now()): SourceFreshness {
  const db = getDb();
  const r = db
    .prepare(
      `SELECT MIN(ts) AS captured_from, MAX(ts) AS captured_to,
              MIN(CASE WHEN dispatched_at IS NOT NULL THEN ts END) AS understood_from,
              MAX(CASE WHEN dispatched_at IS NOT NULL THEN ts END) AS understood_to,
              COUNT(*) AS event_count,
              SUM(CASE WHEN dispatched_at IS NOT NULL THEN 1 ELSE 0 END) AS understood_count,
              MIN(CASE WHEN dispatched_at IS NULL THEN COALESCE(captured_at, ts) END)
                AS oldest_pending_captured_at
         FROM events
        WHERE source_type = ?`,
    )
    .get(sourceId) as RangeRow;

  const understoodCount = r.understood_count ?? 0;
  const pending = r.event_count - understoodCount;
  const lag =
    r.oldest_pending_captured_at != null
      ? Math.max(0, Math.floor((nowMs - new Date(r.oldest_pending_captured_at).getTime()) / 60_000))
      : null;
  const percent = r.event_count > 0 ? Math.round((understoodCount / r.event_count) * 100) : 0;
  const backfillComplete = r.event_count > 0 && !hasUnsealedStreams(sourceId);
  const base = {
    source_id: sourceId,
    captured_from: r.captured_from,
    captured_to: r.captured_to,
    understood_from: r.understood_from,
    understood_to: r.understood_to,
    event_count: r.event_count,
    understood_count: understoodCount,
    pending_count: pending,
    lag_minutes: lag,
    backfill_complete: backfillComplete,
    understood_percent: percent,
  };
  return {
    ...base,
    label: knowsYouLabel(r.understood_from, r.understood_to, nowMs),
    detail: freshnessDetail(base, nowMs),
  };
}

/** Every source that has events, plus the cross-source header chip. */
export function freshnessOverview(nowMs: number = Date.now()): FreshnessOverview {
  const db = getDb();
  const ids = (
    db.prepare(`SELECT DISTINCT source_type AS id FROM events ORDER BY id`).all() as { id: string }[]
  ).map((r) => r.id);
  const sources = ids.map((id) => sourceFreshness(id, nowMs));
  let from: string | null = null;
  let to: string | null = null;
  let lag: number | null = null;
  for (const s of sources) {
    if (s.understood_from && (!from || s.understood_from < from)) from = s.understood_from;
    if (s.understood_to && (!to || s.understood_to > to)) to = s.understood_to;
    if (s.lag_minutes != null && s.lag_minutes > FRESHNESS_PROMISE_MIN && (lag == null || s.lag_minutes > lag)) {
      lag = s.lag_minutes;
    }
  }
  return { sources, label: knowsYouLabel(from, to, nowMs), lag_minutes: lag };
}
