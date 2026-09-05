// ===========================================================================
// Time-window retrieval — V6 P1 S2.5 (Build §5.2, Product_V6 §23.4 method 5).
//
// "What happened Tuesday afternoon" is not a search. Nothing in the question
// is a term any event contains; the question names a RANGE of the log, and
// the answer is everything in it, in the order it happened. So this method is
// a range scan over `events.ts`, UNSCORED: no bm25, no cosine, no recency
// blend — `score` is not even a field on the rows, so nothing downstream can
// mistake position for relevance. Order is timestamp, then id (a stable
// tiebreak for rows said in the same millisecond).
//
//   resolveTimeWindow  question → one local window. Day from dates.ts (the
//                      same "tuesday" every other method resolves), day part
//                      from the words: morning 06–12 · afternoon 12–18 ·
//                      evening 18–22 · night 22–06 (crosses midnight). A
//                      question about what HAPPENED picks the most recent
//                      past occurrence; a bare weekday with no past marker
//                      does the same, because recall is what is scarce.
//                      Local → UTC instants once, here; the scan compares
//                      instants, never local strings.
//   timeWindowScan     the range scan. Bounded by `limit` (default 500); when
//                      the window holds more, `complete` is false and the
//                      caller says so ("300 events, showing the first 300").
//                      Reactions and deleted-for-everyone tombstones are out;
//                      stream / source / kind narrow it when a plan says so.
//
// Zero model calls. Never writes. Cites by event id.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { readEventsByIds, type ContextEventRow } from "../db/retrieval.js";
import { isoDate, localToday, resolveDates, type CalendarDate } from "./dates.js";

// ---- Day parts --------------------------------------------------------------

export type DayPart = "morning" | "afternoon" | "evening" | "night";

/** Local start hour (inclusive) → end hour (exclusive). Night runs past midnight. */
export const DAY_PARTS: Readonly<Record<DayPart, readonly [number, number]>> = {
  morning: [6, 12],
  afternoon: [12, 18],
  evening: [18, 22],
  night: [22, 30],
};

const DAY_PART_WORDS: ReadonlyMap<string, DayPart> = new Map([
  ["morning", "morning"],
  ["mornings", "morning"],
  ["noon", "afternoon"],
  ["afternoon", "afternoon"],
  ["afternoons", "afternoon"],
  ["evening", "evening"],
  ["evenings", "evening"],
  ["tonight", "evening"],
  ["night", "night"],
  ["nights", "night"],
  ["midnight", "night"],
]);

/** Words that say the question is about the future, so the next occurrence is meant. */
const FUTURE_MARKERS = /\b(will|planned|planning|plan|upcoming|coming|going to|gonna|schedule|scheduled|next|tomorrow)\b/;

// ---- Window -----------------------------------------------------------------

export interface TimeWindow {
  /** UTC instant, inclusive. */
  fromIso: string;
  /** UTC instant, exclusive. */
  toIso: string;
  /** The local day the window starts on, YYYY-MM-DD. */
  localDate: string;
  dayPart: DayPart | null;
  /** Local hours the window covers, e.g. [12, 18); [0, 24) for a whole day. */
  hours: readonly [number, number];
  /** The words that produced it, e.g. "tuesday afternoon". */
  expression: string;
}

function localInstant(d: CalendarDate, hour: number): Date {
  // Hours past 24 roll into the next local day; the Date constructor does that.
  return new Date(d.year, d.month - 1, d.day, hour, 0, 0, 0);
}

/** Build a window from a local day and a local hour span. */
export function windowFor(day: CalendarDate, hours: readonly [number, number], expression: string, dayPart: DayPart | null = null): TimeWindow {
  const [start, end] = hours;
  if (!(start >= 0 && end > start && end <= 48)) throw new Error(`time-window: bad hour span ${start}..${end}`);
  return {
    fromIso: localInstant(day, start).toISOString(),
    toIso: localInstant(day, end).toISOString(),
    localDate: isoDate(day),
    dayPart,
    hours: [start, end],
    expression,
  };
}

function parseIsoDay(iso: string): CalendarDate {
  const [y, m, d] = iso.split("-").map(Number);
  return { year: y, month: m, day: d };
}

/**
 * The one window a question names, or null when it names no day at all.
 *
 * Choice of day: a past-tense question ("what happened", "what did we") and
 * a bare weekday both take the most recent occurrence that is not in the
 * future; only an explicit future marker ("what's planned for tuesday") takes
 * the coming one. "This afternoon" / "tonight" with no day is today.
 */
export function resolveTimeWindow(query: string, now: Date): TimeWindow | null {
  const q = query.toLowerCase();
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);

  let dayPart: DayPart | null = null;
  let partWord = "";
  for (const w of words) {
    const p = DAY_PART_WORDS.get(w);
    if (p) {
      dayPart = p;
      partWord = w;
      break;
    }
  }

  const dates = resolveDates(query, now);
  const future = FUTURE_MARKERS.test(q);
  let day: CalendarDate | null = null;
  let dayWord = "";
  if (dates.dates.length > 0) {
    const notFuture = dates.dates.filter((d) => d.relation !== "future");
    const ahead = dates.dates.filter((d) => d.relation === "future");
    // Most recent past (largest negative offset) or nearest future.
    const pickPast = notFuture.length > 0 ? notFuture.reduce((a, d) => (d.offsetDays > a.offsetDays ? d : a)) : null;
    const pickFuture = ahead.length > 0 ? ahead.reduce((a, d) => (d.offsetDays < a.offsetDays ? d : a)) : null;
    const pick = future ? (pickFuture ?? pickPast) : (pickPast ?? pickFuture);
    if (pick) {
      day = parseIsoDay(pick.iso);
      dayWord = pick.expression;
    }
  }
  if (!day) {
    // "this afternoon", "tonight", "this morning" — today, no day named.
    if (dayPart && (/\bthis\b/.test(q) || partWord === "tonight" || words.length <= 4)) {
      day = localToday(now);
      dayWord = "today";
    } else {
      return null;
    }
  }

  const hours: readonly [number, number] = dayPart ? DAY_PARTS[dayPart] : [0, 24];
  const expression = [dayWord, dayPart && partWord !== dayWord ? partWord : ""].filter((s) => s.length > 0).join(" ");
  return windowFor(day, hours, expression, dayPart);
}

// ---- Scan -------------------------------------------------------------------

export const DEFAULT_TIME_WINDOW_LIMIT = 500;
export const MAX_TIME_WINDOW_LIMIT = 5_000;

export interface TimeWindowScanOptions {
  window: Pick<TimeWindow, "fromIso" | "toIso"> & Partial<TimeWindow>;
  /** Source-native stream keys (`events.stream_key`) to keep. Default: all. */
  streamKeys?: readonly string[];
  /** `events.source_type` values to keep, e.g. ["wa", "browser"]. Default: all. */
  sources?: readonly string[];
  /** `events.kind` values to keep. Default: everything but reactions. */
  kinds?: readonly string[];
  /** Rows returned at most (default 500, max 5,000). */
  limit?: number;
}

export interface TimeWindowEvent extends ContextEventRow {
  streamKey: string | null;
  source: string | null;
}

export interface TimeWindowResult {
  method: "time_window";
  window: TimeWindow | (Pick<TimeWindow, "fromIso" | "toIso"> & Partial<TimeWindow>);
  /** Oldest first; ties broken by id. No score anywhere on them. */
  events: TimeWindowEvent[];
  /** Rows in the window, before the cap. */
  count: number;
  /** False when `limit` cut the scan — the caller says "showing the first N". */
  complete: boolean;
  /** Always false: this method never ranks. Here so a fusion step can skip it. */
  scored: false;
}

function clampLimit(raw: number | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIME_WINDOW_LIMIT;
  return Math.min(Math.floor(n), MAX_TIME_WINDOW_LIMIT);
}

/** Everything in the window, oldest first, unscored. */
export function timeWindowScan(opts: TimeWindowScanOptions): TimeWindowResult {
  const { fromIso, toIso } = opts.window;
  if (!fromIso || !toIso || Number.isNaN(Date.parse(fromIso)) || Number.isNaN(Date.parse(toIso))) {
    throw new Error(`time-window: bad instants ${JSON.stringify(fromIso)}..${JSON.stringify(toIso)}`);
  }
  if (toIso <= fromIso) throw new Error(`time-window: empty window ${fromIso}..${toIso}`);
  const limit = clampLimit(opts.limit);

  const where: string[] = ["e.ts >= ?", "e.ts < ?", "e.kind IS NOT 'reaction'", "e.revoked_at IS NULL"];
  const params: unknown[] = [fromIso, toIso];
  const inList = (col: string, vals: readonly string[] | undefined): void => {
    if (!vals) return;
    const set = [...new Set(vals.filter((v) => typeof v === "string" && v.length > 0))];
    if (set.length === 0) return;
    where.push(`${col} IN (${set.map(() => "?").join(",")})`);
    params.push(...set);
  };
  inList("e.stream_key", opts.streamKeys);
  inList("e.source_type", opts.sources);
  inList("e.kind", opts.kinds);

  const db = getDb();
  const predicate = where.join(" AND ");
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM events e WHERE ${predicate}`).get(...params) as { n: number }).n;
  const idRows = db
    .prepare(`SELECT e.id, e.stream_key, e.source_type FROM events e WHERE ${predicate} ORDER BY e.ts ASC, e.id ASC LIMIT ?`)
    .all(...params, limit) as { id: string; stream_key: string | null; source_type: string | null }[];

  // readEventsByIds keeps input order, so the timestamp order survives hydration.
  const meta = new Map(idRows.map((r) => [r.id, r]));
  const events: TimeWindowEvent[] = readEventsByIds(idRows.map((r) => r.id)).map((row) => {
    const m = meta.get(row.id);
    return { ...row, streamKey: m?.stream_key ?? null, source: m?.source_type ?? null };
  });

  return {
    method: "time_window",
    window: opts.window,
    events,
    count,
    complete: count <= events.length,
    scored: false,
  };
}

/** The whole method: resolve the question's window and scan it; null when it names no day. */
export function timeWindowForQuery(
  query: string,
  now: Date = new Date(),
  opts: Omit<TimeWindowScanOptions, "window"> = {},
): TimeWindowResult | null {
  const window = resolveTimeWindow(query, now);
  if (!window) return null;
  return timeWindowScan({ ...opts, window });
}
