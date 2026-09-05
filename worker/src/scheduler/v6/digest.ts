// ===========================================================================
// [CODE] The digest lane planner (Product_V6 §23.2, P1 §5.2 / §8; S3.3).
//
// Tier-3 streams — never-replied groups, past businesses — are not understood
// live or by the day. They get one Digest call per stream per week, and only
// for weeks that hold new (undispatched) events: an empty week is skipped,
// never sent. A week is served once it has ended; the current week waits.
//
// Reads only; the dispatcher hands the bundles to brain/digest-pass.ts
// (digest.v1 today, digest.v2 in S3.8) and marks them on success.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { bestBand, dayOf, PENDING_SELECT, SCOPE_CLAUSE, tierOf, toBundleEvent, type DeltaBundle, type PendingRow } from "./bundle.js";

export const WEEK_MS = 7 * 86_400_000;

/** Monday 00:00 UTC of the ISO week containing `ms`. */
export function weekStartMs(ms: number): number {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * 86_400_000;
  return start;
}

export function weekKey(ms: number): string {
  return new Date(weekStartMs(ms)).toISOString().slice(0, 10);
}

export interface DigestOptions {
  nowMs?: number;
  /** Cap on bundles returned. */
  limit?: number;
  skipKeys?: ReadonlySet<string>;
  /** Include the current (unfinished) week too. Default false. */
  includeCurrentWeek?: boolean;
  /** Only streams whose key starts with this (tests / eval executors on a shared DB). */
  streamKeyPrefix?: string;
}

/**
 * Due digest bundles: one per (tier-3 stream, ended week with new events),
 * newest week first, then by stream key. Weeks with nothing new never appear.
 */
export function planDigest(opts: DigestOptions = {}): DeltaBundle[] {
  const nowMs = opts.nowMs ?? Date.now();
  const currentWeek = weekStartMs(nowMs);
  const rows = (
    opts.streamKeyPrefix
      ? getDb().prepare(`${PENDING_SELECT}${SCOPE_CLAUSE} ORDER BY e.rowid`).all(opts.streamKeyPrefix, opts.streamKeyPrefix)
      : getDb().prepare(`${PENDING_SELECT} ORDER BY e.rowid`).all()
  ) as PendingRow[];
  const groups = new Map<string, { streamId: string; streamKey: string; week: string; rows: PendingRow[] }>();
  for (const r of rows) {
    if (tierOf(r) !== 3) continue;
    if (!r.ts) continue;
    const ms = Date.parse(r.ts);
    if (!Number.isFinite(ms)) continue;
    const ws = weekStartMs(ms);
    if (!opts.includeCurrentWeek && ws >= currentWeek) continue;
    const streamId = r.stream_id ?? r.stream_key;
    const week = new Date(ws).toISOString().slice(0, 10);
    const gk = `${streamId}|${week}`;
    const g = groups.get(gk);
    if (g) g.rows.push(r);
    else groups.set(gk, { streamId, streamKey: r.stream_key, week, rows: [r] });
  }
  const out: DeltaBundle[] = [];
  const ordered = [...groups.values()].sort((a, b) =>
    a.week !== b.week ? (a.week < b.week ? 1 : -1) : a.streamKey < b.streamKey ? -1 : a.streamKey > b.streamKey ? 1 : 0,
  );
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  for (const g of ordered) {
    const events = g.rows.map(toBundleEvent);
    const key = `${g.streamId}:${Math.min(...events.map((e) => e.rowid))}-${Math.max(...events.map((e) => e.rowid))}`;
    if (opts.skipKeys?.has(key)) continue;
    out.push({
      streamId: g.streamId,
      streamKey: g.streamKey,
      lane: "digest",
      ageBand: bestBand(events),
      events,
      part: 1,
      partCount: 1,
      day: dayOf(events) || g.week,
    });
    if (out.length >= limit) break;
  }
  return out;
}
