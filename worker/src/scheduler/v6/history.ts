// ===========================================================================
// [CODE] The history day-bundler (Product_V6 §11.2, §11.3.12, §23.2; P1 §7.1;
// GoldenEvals BND-01..03).
//
// History = one calendar day, all sources, one call. Days are served newest
// first; a day with no undispatched events costs nothing — it is skipped,
// never sent (BND-03). Within a day the sections order tier 1 → 2 → 3, then
// chats → screen → browser → rest, then time (§11.2). A day over 30k chars is
// split at its largest inactivity gap, recursively, never at the character
// boundary mid-burst (BND-02).
//
// Tier-3 streams are not history: they go to the digest lane (digest.ts).
// Tier-4 streams are index-only and never bundled.
//
// Reads only. The dispatcher decides how many of these bundles leave per tick.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import {
  bestBand,
  dayOf,
  PENDING_SELECT,
  SCOPE_CLAUSE,
  tierOf,
  toBundleEvent,
  type BundleEvent,
  type DeltaBundle,
  type PendingRow,
} from "./bundle.js";

/** A day bundle over this many chars splits at its largest gap. */
export const HISTORY_SPLIT_CHARS = 30_000;

/** WhatsApp → screen → browser → everything else (§11.2). */
export const SOURCE_ORDER: readonly string[] = ["wa", "whatsapp", "screen", "browser"];

export function sourceRank(source: string | null | undefined): number {
  const s = (source ?? "").toLowerCase();
  const i = SOURCE_ORDER.indexOf(s === "whatsapp" ? "wa" : s);
  return i === -1 ? SOURCE_ORDER.length : i;
}

/** Source of a pending row: its source_id, else the `<source>:st:` prefix of its stream id. */
export function sourceOfRow(r: { source_id: string | null; stream_id: string | null }): string {
  if (r.source_id) return r.source_id;
  const sid = r.stream_id ?? "";
  const i = sid.indexOf(":st:");
  return i > 0 ? sid.slice(0, i) : "";
}

export interface HistoryOptions {
  /** Cap on day bundles returned (the caller's free slots). Default: all. */
  limit?: number;
  /** Skip these bundle keys (attempt not due, in flight). */
  skipKeys?: ReadonlySet<string>;
  /** Only these days (tests / replays); default every day with pending backfill. */
  days?: readonly string[];
  /** Calendar day of an ISO timestamp. Default: UTC date. */
  dayFn?: (ts: string) => string;
  /** Only streams whose key starts with this (tests / eval executors on a shared DB). */
  streamKeyPrefix?: string;
}

export interface DaySplit {
  events: BundleEvent[];
  /** Where the cut fell (the ts of the first event of the part), for reports. */
  from: string | null;
  to: string | null;
}

const charsOf = (e: Pick<BundleEvent, "text">): number => (e.text ?? "").length;

function tsMs(e: Pick<BundleEvent, "ts">): number {
  const t = e.ts ? Date.parse(e.ts) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Split one day's events (time order) at the largest inactivity gap until
 * every part is under the cap. A part that cannot split (one event) stands.
 */
export function splitAtLargestGap(events: readonly BundleEvent[], cap = HISTORY_SPLIT_CHARS): DaySplit[] {
  const sorted = [...events].sort((a, b) => tsMs(a) - tsMs(b) || a.rowid - b.rowid);
  const total = sorted.reduce((n, e) => n + charsOf(e), 0);
  if (sorted.length <= 1 || total <= cap) {
    return [{ events: sorted, from: sorted[0]?.ts ?? null, to: sorted[sorted.length - 1]?.ts ?? null }];
  }
  let bestIdx = 1;
  let bestGap = -1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = tsMs(sorted[i]) - tsMs(sorted[i - 1]);
    if (gap > bestGap) {
      bestGap = gap;
      bestIdx = i;
    }
  }
  return [...splitAtLargestGap(sorted.slice(0, bestIdx), cap), ...splitAtLargestGap(sorted.slice(bestIdx), cap)];
}

interface DayRows {
  day: string;
  rows: PendingRow[];
}

/** Undispatched backfill rows on tier-1/2 streams, grouped by day, newest day first. */
export function pendingHistoryDays(opts: HistoryOptions = {}): DayRows[] {
  const dayFn = opts.dayFn ?? ((ts: string) => ts.slice(0, 10));
  const rows = (
    opts.streamKeyPrefix
      ? getDb()
          .prepare(`${PENDING_SELECT} AND e.origin = 'backfill'${SCOPE_CLAUSE} ORDER BY e.ts DESC, e.rowid`)
          .all(opts.streamKeyPrefix, opts.streamKeyPrefix)
      : getDb().prepare(`${PENDING_SELECT} AND e.origin = 'backfill' ORDER BY e.ts DESC, e.rowid`).all()
  ) as PendingRow[];
  const byDay = new Map<string, PendingRow[]>();
  const only = opts.days ? new Set(opts.days) : null;
  for (const r of rows) {
    const tier = tierOf(r);
    if (tier >= 3) continue; // digest lane / index-only
    if (!r.ts) continue;
    const day = dayFn(r.ts);
    if (only && !only.has(day)) continue;
    const list = byDay.get(day);
    if (list) list.push(r);
    else byDay.set(day, [r]);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([day, list]) => ({ day, rows: list }));
}

/** §11.2 section order for one day's rows: tier, source, then time. */
export function orderDayRows(rows: readonly PendingRow[]): PendingRow[] {
  return [...rows].sort((a, b) => {
    const ta = tierOf(a);
    const tb = tierOf(b);
    if (ta !== tb) return ta - tb;
    const sa = sourceRank(sourceOfRow(a));
    const sb = sourceRank(sourceOfRow(b));
    if (sa !== sb) return sa - sb;
    const ka = a.stream_id ?? a.stream_key;
    const kb = b.stream_id ?? b.stream_key;
    if (ka !== kb) return ka < kb ? -1 : 1;
    const da = a.ts ?? "";
    const db_ = b.ts ?? "";
    if (da !== db_) return da < db_ ? -1 : 1;
    return a.rowid - b.rowid;
  });
}

/**
 * Plan history bundles: newest day first, empty days skipped, each day split
 * at 30k chars at its largest gap. `streamId` is the first section's stream
 * (tier 1 chats first); the packer sections the rest by stream.
 */
export function planHistory(opts: HistoryOptions = {}): DeltaBundle[] {
  const out: DeltaBundle[] = [];
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  for (const { day, rows } of pendingHistoryDays(opts)) {
    const ordered = orderDayRows(rows);
    const lead = ordered[0];
    const events = ordered.map(toBundleEvent);
    const parts = splitAtLargestGap(events);
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (part.events.length === 0) continue;
      const leadEvent = part.events.find((e) => (e.streamId ?? "") === (lead.stream_id ?? "")) ?? part.events[0];
      const leadRow = ordered.find((r) => r.id === leadEvent.id) ?? lead;
      const bundle: DeltaBundle = {
        streamId: leadRow.stream_id ?? leadRow.stream_key,
        streamKey: leadRow.stream_key,
        lane: "history",
        ageBand: bestBand(part.events),
        events: part.events,
        part: p + 1,
        partCount: parts.length,
        day: dayOf(part.events) || day,
      };
      const key = `${bundle.streamId}:${Math.min(...part.events.map((e) => e.rowid))}-${Math.max(...part.events.map((e) => e.rowid))}`;
      if (opts.skipKeys?.has(key)) continue;
      out.push(bundle);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
