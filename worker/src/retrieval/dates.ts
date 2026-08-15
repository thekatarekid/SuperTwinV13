// ===========================================================================
// Weekday / relative-date resolution for retrieval (docs/v6-spec.md §1).
//
// "Do i have anything planned on sunday" and
// "booking on 02 Aug 2026, 01:00 PM ... at Oye Kake" share no token. The only
// thing that connects them is what day it is today, and nothing in the pipeline
// knew. So this module answers two questions:
//
//   1. What date does the question mean? ("sunday" -> 2026-08-02)
//   2. How would a human have WRITTEN that date in a chat message?
//      ("02 Aug 2026", "2/8/2026", "2026-08-02", "Aug 2", "Sunday")
//
// (2) is why the phrase list looks redundant: FTS5's tokenizer splits
// "02 Aug 2026" into [02, aug, 2026] and "2 Aug" into [2, aug], and `02` and `2`
// are DIFFERENT tokens. A phrase that omits the leading zero cannot match a
// message that wrote one.
//
// Everything here is local-time. Resolving "sunday" through UTC gets the wrong
// day for five and a half hours out of every day in this user's timezone, and
// the answer is silently one day off rather than absent.
// ===========================================================================

/** A calendar day, with no time and no zone. `month` is 1-based. */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** How a resolved date relates to today — shown to the model, not just used. */
export type DateRelation = "today" | "future" | "past";

export interface ResolvedDate {
  /** yyyy-mm-dd. */
  iso: string;
  /** Lowercase full weekday name, e.g. "sunday". */
  weekday: string;
  /** The words in the question that produced it, e.g. "sunday", "next week". */
  expression: string;
  relation: DateRelation;
  /** Days from today; negative is in the past. */
  offsetDays: number;
}

/** An inclusive day range, for boosting events that HAPPENED in it. */
export interface DateRange {
  fromIso: string;
  toIso: string;
}

export interface DateResolution {
  /** The user's local today, yyyy-mm-dd. */
  todayIso: string;
  todayWeekday: string;
  /** Resolved dates, best-supported first, deduped by iso. */
  dates: ResolvedDate[];
  /** Day windows an event's own `ts` can fall inside. */
  ranges: DateRange[];
}

// ---- Names ----------------------------------------------------------------

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const MONTHS_SHORT = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

const MONTHS_LONG = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/**
 * Weekday words a question can use. The three-letter forms are in because chats
 * are full of them ("i booked sat imax koramangala"); the cost of reading a
 * stray "sun" as Sunday is one extra OR-term in a recall-bound search.
 */
const WEEKDAY_ALIASES: ReadonlyMap<string, number> = new Map([
  ["sun", 0],
  ["sunday", 0],
  ["mon", 1],
  ["monday", 1],
  ["tue", 2],
  ["tues", 2],
  ["tuesday", 2],
  ["wed", 3],
  ["weds", 3],
  ["wednesday", 3],
  ["thu", 4],
  ["thur", 4],
  ["thurs", 4],
  ["thursday", 4],
  ["fri", 5],
  ["friday", 5],
  ["sat", 6],
  ["saturday", 6],
]);

/** Qualifiers that bind to a following weekday / "weekend" / "week". */
const QUALIFIERS: ReadonlySet<string> = new Set([
  "this",
  "next",
  "last",
  "coming",
  "upcoming",
  "past",
  "previous",
]);

/**
 * More than this and the match expression is mostly dates. Six covers the
 * widest thing anyone asks ("next week" = 2 endpoints) plus a weekend plus a
 * weekday, which is already more than one question ever means.
 */
export const MAX_RESOLVED_DATES = 6;

// ---- Day arithmetic -------------------------------------------------------
//
// Days are counted through Date.UTC even though the inputs are local dates: UTC
// has no DST, so "+1 day" is always +1 day. Only the ENTRY point (today) reads
// local getters — that is the part that has to be local.

const MS_PER_DAY = 86_400_000;

/** The user's local calendar date for an instant — never `toISOString()`. */
export function localToday(now: Date): CalendarDate {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function dayNumber(d: CalendarDate): number {
  return Math.round(Date.UTC(d.year, d.month - 1, d.day) / MS_PER_DAY);
}

function fromDayNumber(n: number): CalendarDate {
  const d = new Date(n * MS_PER_DAY);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function weekdayIndex(d: CalendarDate): number {
  return new Date(dayNumber(d) * MS_PER_DAY).getUTCDay();
}

/** yyyy-mm-dd for a calendar date. */
export function isoDate(d: CalendarDate): string {
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
}

/** The full lowercase weekday name of a calendar date. */
export function weekdayName(d: CalendarDate): string {
  return WEEKDAYS[weekdayIndex(d)];
}

// ---- Resolution -----------------------------------------------------------

interface Candidate {
  date: CalendarDate;
  expression: string;
}

/**
 * Every date the question refers to, resolved against the user's local today.
 *
 * Rules, chosen to be predictable rather than clever (English disagrees with
 * itself about "next friday", so a rule you can state beats a rule you have to
 * guess at):
 *   - a bare or "this"/"coming" weekday is the NEXT one, today included;
 *   - "next <weekday>" is that one plus a week;
 *   - "last"/"past"/"previous <weekday>" is the most recent one before today;
 *   - a bare weekday ALSO yields its most recent past occurrence, because a
 *     question in the past tense ("what did we do on sunday") looks identical
 *     to one in the future tense and recall is what is scarce here;
 *   - a week yields its Monday and Sunday, plus the whole seven days as a
 *     range. Thirteen phrase spellings per day times seven days is a match
 *     expression made of dates.
 */
export function resolveDates(query: string, now: Date): DateResolution {
  const today = localToday(now);
  const todayNum = dayNumber(today);
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);

  const candidates: Candidate[] = [];
  const ranges: DateRange[] = [];

  const push = (offset: number, expression: string): void => {
    candidates.push({ date: fromDayNumber(todayNum + offset), expression });
  };

  /** Days from today to the next `target` weekday, today counting as 0. */
  const daysUntil = (target: number): number =>
    (target - weekdayIndex(today) + 7) % 7;

  const pushWeek = (weekOffset: number, expression: string): void => {
    // Monday-first, so "this week" on a Sunday is the week that is ending.
    const mondayOffset = -((weekdayIndex(today) + 6) % 7) + weekOffset * 7;
    push(mondayOffset, expression);
    push(mondayOffset + 6, expression);
    ranges.push({
      fromIso: isoDate(fromDayNumber(todayNum + mondayOffset)),
      toIso: isoDate(fromDayNumber(todayNum + mondayOffset + 6)),
    });
  };

  const pushWeekend = (weekOffset: number, expression: string): void => {
    const saturday = daysUntil(6) + weekOffset * 7;
    push(saturday, expression);
    push(saturday + 1, expression);
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = words[i + 1] ?? "";

    if (QUALIFIERS.has(word) && next.length > 0) {
      const expression = `${word} ${next}`;
      const backwards = word === "last" || word === "past" || word === "previous";
      const forwards = word === "next";

      const weekday = WEEKDAY_ALIASES.get(next);
      if (weekday !== undefined) {
        const ahead = daysUntil(weekday);
        push(backwards ? ahead - 7 : forwards ? ahead + 7 : ahead, expression);
        i++;
        continue;
      }
      if (next === "weekend") {
        pushWeekend(backwards ? -1 : forwards ? 1 : 0, expression);
        i++;
        continue;
      }
      if (next === "week") {
        pushWeek(backwards ? -1 : forwards ? 1 : 0, expression);
        i++;
        continue;
      }
    }

    const weekday = WEEKDAY_ALIASES.get(word);
    if (weekday !== undefined) {
      const ahead = daysUntil(weekday);
      push(ahead, word);
      if (ahead !== 0) push(ahead - 7, word);
      continue;
    }
    if (word === "weekend") {
      pushWeekend(0, word);
      continue;
    }
    if (word === "today" || word === "tonight") {
      push(0, word);
      continue;
    }
    if (word === "tomorrow") {
      push(1, word);
      continue;
    }
    if (word === "yesterday") {
      push(-1, word);
      continue;
    }
  }

  const seen = new Set<string>();
  const dates: ResolvedDate[] = [];
  for (const candidate of candidates) {
    const iso = isoDate(candidate.date);
    if (seen.has(iso)) continue;
    seen.add(iso);
    const offsetDays = dayNumber(candidate.date) - todayNum;
    dates.push({
      iso,
      weekday: weekdayName(candidate.date),
      expression: candidate.expression,
      relation: offsetDays === 0 ? "today" : offsetDays > 0 ? "future" : "past",
      offsetDays,
    });
    if (dates.length >= MAX_RESOLVED_DATES) break;
  }

  for (const d of dates) {
    if (!ranges.some((r) => r.fromIso <= d.iso && d.iso <= r.toIso)) {
      ranges.push({ fromIso: d.iso, toIso: d.iso });
    }
  }

  return {
    todayIso: isoDate(today),
    todayWeekday: weekdayName(today),
    dates,
    ranges,
  };
}

// ---- Spellings ------------------------------------------------------------

/**
 * How a date can appear in a message, as FTS5 phrases (space-separated tokens
 * — the tokenizer has already thrown the separators away, so "2026-08-02",
 * "2026/08/02" and "2026 08 02" are one phrase).
 *
 * Day-first only. This corpus is Indian: 08/02/2026 there is the 8th of
 * February, so also emitting the American ordering would not widen recall, it
 * would match a different day.
 */
export function dateMatchPhrases(iso: string): string[] {
  const [y, m, d] = iso.split("-");
  const year = String(Number(y));
  const mm = m;
  const monthNum = String(Number(m));
  const dd = d;
  const dayNum = String(Number(d));
  const mon = MONTHS_SHORT[Number(m) - 1];
  const month = MONTHS_LONG[Number(m) - 1];

  const phrases = [
    `${year} ${mm} ${dd}`,
    `${dd} ${mon} ${year}`,
    `${dayNum} ${mon} ${year}`,
    `${dd} ${month} ${year}`,
    `${dayNum} ${month} ${year}`,
    `${dd} ${mm} ${year}`,
    `${dayNum} ${monthNum} ${year}`,
    `${dd} ${mon}`,
    `${dayNum} ${mon}`,
    `${dd} ${month}`,
    `${dayNum} ${month}`,
    `${mon} ${dd}`,
    `${mon} ${dayNum}`,
    `${month} ${dd}`,
    `${month} ${dayNum}`,
  ];
  return [...new Set(phrases)];
}

/**
 * True when the instant `ts` falls inside the day range, inclusive. `ts` is
 * stored in UTC and the range is local days, so the instant is converted rather
 * than string-sliced: 2026-08-02T19:30:00Z is already Monday where the user is.
 */
export function tsWithinRange(ts: string | null, range: DateRange): boolean {
  if (!ts) return false;
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return false;
  const day = isoDate(localToday(at));
  return day >= range.fromIso && day <= range.toIso;
}
