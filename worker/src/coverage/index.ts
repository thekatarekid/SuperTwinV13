// ===========================================================================
// [CODE] Coverage index — per source, per date range, what exists and what was
// never captured (Product_V6 §23.4 rule 3, build S2.7).
//
// The `coverage` table (0200_v6_core) is source × [range_start, range_end] ×
// status. Two kinds of row live in it:
//
//   captured   one row PER CALENDAR DAY, written by the adapters as events
//              land (`noteCaptured` from the sinks / ingest writer). `events`
//              counts the rows that exist for that day. `indexed` /
//              `understood` are promotions of the same day row — a promotion
//              never regresses to `captured` when more events land.
//   missing    one OPEN-START row per source (range_start = EPOCH_DAY) that
//              says "nothing before <day>" — the adapter's import range
//              ("import range 90d"), rewritten whenever the range changes.
//   excluded   the same shape for a consent window; the live INDEX floor is
//              read from `consents` at caveat time, so it is never stale.
//
// `coverageCaveat(source, range)` is the truthful half of an answer: "three
// so far — I only have WhatsApp back to Jan 2024". It never invents a gap: a
// missing range that has captured days inside it is not reported as a gap.
//
// No model, no network. Every read is one or two indexed SQLite statements.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { coverageFor, getConsent, upsertCoverage, type CoverageRange } from "../db/v6core.js";
import { rangeCutoffIso } from "../adapters/source-adapter.js";
import type { Range } from "../adapters/types.js";

/** The open start of a "nothing before X" row. */
export const EPOCH_DAY = "1970-01-01";

/** Human labels for the source ids the adapters write. */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  whatsapp: "WhatsApp",
  wa: "WhatsApp",
  browser: "browser history",
  screen: "your screen",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

/** The calendar day (UTC) of an ISO timestamp or day string; null when unparsable. */
export function dayOf(ts: string | null | undefined): string | null {
  if (!ts) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return DAY_RE.test(ts) ? ts.slice(0, 10) : null;
  return new Date(ms).toISOString().slice(0, 10);
}

function shiftDay(day: string, days: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Writers — called by adapters
// ---------------------------------------------------------------------------

let noteStmt: ReturnType<ReturnType<typeof getDb>["prepare"]> | null = null;
let noteStmtDb: ReturnType<typeof getDb> | null = null;

function captureStatement() {
  const db = getDb();
  if (noteStmt && noteStmtDb === db) return noteStmt;
  noteStmtDb = db;
  noteStmt = db.prepare(
    `INSERT INTO coverage (source, range_start, range_end, status, events, note, updated_at)
     VALUES (@source, @day, @day, 'captured', @n, NULL, @at)
     ON CONFLICT(source, range_start, range_end) DO UPDATE SET
       events     = coverage.events + excluded.events,
       status     = CASE WHEN coverage.status IN ('indexed', 'understood')
                         THEN coverage.status ELSE 'captured' END,
       note       = CASE WHEN coverage.status IN ('missing', 'excluded')
                         THEN NULL ELSE coverage.note END,
       updated_at = excluded.updated_at`,
  );
  return noteStmt;
}

/**
 * Record that `timestamps` were captured for `source`: one day row per
 * distinct calendar day, `events` bumped by the count. Synchronous; meant to
 * be called once per appended batch. Returns the number of day rows touched.
 */
export function noteCaptured(source: string, timestamps: readonly (string | null | undefined)[]): number {
  if (timestamps.length === 0) return 0;
  const perDay = new Map<string, number>();
  for (const ts of timestamps) {
    const day = dayOf(ts);
    if (!day) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  if (perDay.size === 0) return 0;
  const stmt = captureStatement();
  const at = nowIso();
  const db = getDb();
  const run = db.transaction(() => {
    for (const [day, n] of perDay) stmt.run({ source, day, n, at });
  });
  run();
  return perDay.size;
}

/** `MAX(rowid)` of `events` — take it before an append, hand it to `noteCapturedSince`. */
export function eventsHighWater(): number {
  const r = getDb().prepare(`SELECT COALESCE(MAX(rowid), 0) AS r FROM events`).get() as { r: number };
  return r.r;
}

/**
 * Note every event row written after `rowidBefore`, grouped by source. This
 * is how a batch sink stays exact: a content-hash duplicate or a gate-dropped
 * envelope never wrote a row, so it never counts. Returns day rows touched.
 */
export function noteCapturedSince(rowidBefore: number): number {
  const rows = getDb()
    .prepare(`SELECT source_id, ts FROM events WHERE rowid > ?`)
    .all(rowidBefore) as { source_id: string | null; ts: string | null }[];
  if (rows.length === 0) return 0;
  const bySource = new Map<string, (string | null)[]>();
  for (const r of rows) {
    if (!r.source_id) continue;
    const list = bySource.get(r.source_id) ?? [];
    list.push(r.ts);
    bySource.set(r.source_id, list);
  }
  let touched = 0;
  for (const [source, ts] of bySource) touched += noteCaptured(source, ts);
  return touched;
}

// A per-event writer (the WhatsApp ingest path sees one event at a time)
// accumulates and flushes on a short unref'd timer, so a 100k-message import
// costs one upsert per (source, day), not one per message.
const pending = new Map<string, Map<string, number>>();
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_DELAY_MS = 250;

export function noteCapturedDeferred(source: string, ts: string | null | undefined): void {
  const day = dayOf(ts);
  if (!day) return;
  let days = pending.get(source);
  if (!days) {
    days = new Map();
    pending.set(source, days);
  }
  days.set(day, (days.get(day) ?? 0) + 1);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        flushCoverage();
      } catch (err) {
        console.error("[coverage] deferred flush failed (continuing):", err);
      }
    }, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }
}

/** Write everything `noteCapturedDeferred` accumulated. Returns rows touched. */
export function flushCoverage(): number {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.size === 0) return 0;
  const stmt = captureStatement();
  const at = nowIso();
  let touched = 0;
  const db = getDb();
  const run = db.transaction(() => {
    for (const [source, days] of pending) {
      for (const [day, n] of days) {
        stmt.run({ source, day, n, at });
        touched++;
      }
    }
  });
  run();
  pending.clear();
  return touched;
}

/** Test seam: drop anything buffered without writing it. */
export function resetCoverageBufferForTests(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pending.clear();
  noteStmt = null;
  noteStmtDb = null;
}

/**
 * Promote a captured day to `indexed` / `understood`. Never downgrades: an
 * `understood` day stays understood when the indexer re-runs.
 */
export function promoteDay(source: string, day: string, status: "indexed" | "understood"): void {
  const rank = { captured: 0, indexed: 1, understood: 2 } as const;
  const rows = coverageFor(source).filter((r) => r.rangeStart === day && r.rangeEnd === day);
  const current = rows[0];
  if (current && current.status in rank && rank[current.status as keyof typeof rank] >= rank[status]) {
    return;
  }
  upsertCoverage({
    source,
    rangeStart: day,
    rangeEnd: day,
    status,
    events: current?.events ?? 0,
    note: null,
  });
}

/**
 * "Nothing before `beforeDay`" for a source — the adapter's import range.
 * Replaces the source's previous open-start `missing` row; `null` clears it
 * (the user chose "all"). `note` explains why ("import range 90d").
 */
export function setHistoryFloor(source: string, beforeDay: string | null, note: string | null): void {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare(
      `DELETE FROM coverage WHERE source = ? AND range_start = ? AND status = 'missing'`,
    ).run(source, EPOCH_DAY);
    if (beforeDay) {
      const end = shiftDay(beforeDay, -1);
      if (end < EPOCH_DAY) return;
      upsertCoverage({
        source,
        rangeStart: EPOCH_DAY,
        rangeEnd: end,
        status: "missing",
        events: 0,
        note,
      });
    }
  });
  run();
}

/** The import-range form of `setHistoryFloor`, as the ingest writer sees it. */
export function setHistoryFloorForRange(source: string, range: Range, nowMs: number = Date.now()): void {
  if (range === "all") {
    setHistoryFloor(source, null, null);
    return;
  }
  const cutoffDay = dayOf(rangeCutoffIso(range, nowMs));
  setHistoryFloor(source, cutoffDay, `import range ${range}`);
}

/** A known hole INSIDE the captured history ("daemon offline 3 days"). */
export function markMissing(source: string, from: string, to: string, note: string | null): CoverageRange {
  return upsertCoverage({ source, rangeStart: from, rangeEnd: to, status: "missing", events: 0, note });
}

// ---------------------------------------------------------------------------
// Readers — the caveat
// ---------------------------------------------------------------------------

export interface DateRange {
  /** ISO timestamp or YYYY-MM-DD, inclusive. */
  from: string;
  /** ISO timestamp or YYYY-MM-DD, inclusive. */
  to: string;
}

export type CaveatKind =
  /** The source has nothing at all. */
  | "none"
  /** The consent INDEX window starts after the asked range. */
  | "excluded"
  /** The asked range reaches before the earliest captured day. */
  | "floor"
  /** A recorded hole overlaps the asked range and nothing was captured in it. */
  | "gap";

export interface CoverageCaveat {
  source: string;
  kind: CaveatKind;
  /** One sentence, ready to append to an answer. */
  text: string;
  /** Earliest captured day (captured/indexed/understood), when any. */
  floor: string | null;
  /** The hole, for `gap`. */
  gap?: { from: string; to: string; note: string | null };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jan 2024" — how a person says a floor. */
export function monthYear(day: string): string {
  const m = Number(day.slice(5, 7));
  return `${MONTHS[m - 1] ?? day.slice(5, 7)} ${day.slice(0, 4)}`;
}

/** "3 Jan 2024" — how a person says a specific day. */
export function dayLabel(day: string): string {
  return `${Number(day.slice(8, 10))} ${monthYear(day)}`;
}

interface CoverageSummary {
  floor: string | null;
  captured: CoverageRange[];
  holes: CoverageRange[];
}

function summarize(source: string): CoverageSummary {
  const rows = coverageFor(source);
  const captured = rows.filter((r) => r.status === "captured" || r.status === "indexed" || r.status === "understood");
  const holes = rows.filter((r) => r.status === "missing" || r.status === "excluded");
  return { floor: captured[0]?.rangeStart ?? null, captured, holes };
}

/**
 * The caveat an answer over `range` should carry for `source`, or null when
 * the range is fully inside what was captured. Priority: nothing at all →
 * consent floor → capture floor → gap.
 */
export function coverageCaveat(source: string, range: DateRange): CoverageCaveat | null {
  const from = dayOf(range.from);
  const to = dayOf(range.to);
  if (!from || !to) throw new Error(`coverageCaveat: range must be ISO or YYYY-MM-DD: ${range.from}..${range.to}`);
  if (to < from) throw new Error(`coverageCaveat: range.to ${to} precedes range.from ${from}`);
  const label = sourceLabel(source);
  const { floor, captured, holes } = summarize(source);

  if (floor === null) {
    return { source, kind: "none", text: `I don't have any ${label} yet`, floor: null };
  }

  // Consent INDEX floor, read live so a widened window is never stale. The
  // gate drops rows before it, so the capture floor is never earlier; when the
  // asked range reaches past the consent floor, the consent is the reason.
  const consent = getConsent(source);
  const indexFrom = consent && !consent.indexAll ? dayOf(consent.indexFrom) : null;
  if (indexFrom && from < indexFrom) {
    const tail = monthYear(floor) !== monthYear(indexFrom) ? ` and have it back to ${monthYear(floor)}` : "";
    return {
      source,
      kind: "excluded",
      text: `I only index ${label} from ${monthYear(indexFrom)}${tail}`,
      floor,
    };
  }

  if (from < floor) {
    return { source, kind: "floor", text: `I only have ${label} back to ${monthYear(floor)}`, floor };
  }

  for (const hole of holes) {
    const hFrom = hole.rangeStart > from ? hole.rangeStart : from;
    const hTo = hole.rangeEnd < to ? hole.rangeEnd : to;
    if (hFrom > hTo) continue;
    // A hole with captured days inside the overlap is not a gap we can claim.
    const filled = captured.some((c) => c.rangeEnd >= hFrom && c.rangeStart <= hTo);
    if (filled) continue;
    const span = hFrom === hTo ? `on ${dayLabel(hFrom)}` : `between ${dayLabel(hFrom)} and ${dayLabel(hTo)}`;
    return {
      source,
      kind: "gap",
      text: `nothing from ${label} ${span}${hole.note ? ` (${hole.note})` : ""}`,
      floor,
      gap: { from: hFrom, to: hTo, note: hole.note },
    };
  }
  return null;
}

/** Every source with a coverage row, sorted. */
export function coveredSources(): string[] {
  const rows = getDb().prepare(`SELECT DISTINCT source FROM coverage ORDER BY source`).all() as {
    source: string;
  }[];
  return rows.map((r) => r.source);
}

/**
 * Caveats over `range` for `sources` (default: every source that has a
 * coverage row). Sources that never wrote a row are not "none" — they are
 * unknown to the index — so they are only reported when named explicitly.
 */
export function coverageCaveats(range: DateRange, sources: readonly string[] = coveredSources()): CoverageCaveat[] {
  const out: CoverageCaveat[] = [];
  for (const source of sources) {
    const c = coverageCaveat(source, range);
    if (c) out.push(c);
  }
  return out;
}

/** The whole index for one source — the Library's coverage strip. */
export function coverageSnapshotFor(source: string): {
  source: string;
  label: string;
  floor: string | null;
  days: number;
  events: number;
  holes: { from: string; to: string; status: string; note: string | null }[];
} {
  const { floor, captured, holes } = summarize(source);
  return {
    source,
    label: sourceLabel(source),
    floor,
    days: captured.length,
    events: captured.reduce((n, r) => n + r.events, 0),
    holes: holes.map((h) => ({ from: h.rangeStart, to: h.rangeEnd, status: h.status, note: h.note })),
  };
}
