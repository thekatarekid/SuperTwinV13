// ===========================================================================
// The three clocks (V6 P1 S5.3; Product_V6 §11.6, Product_V6_Phase1 §12).
//
//   MESSAGE TIME     when it was said     → resolve relative phrases
//   PROCESSING TIME  when the twin read it → past or future?
//   VIEW TIME        when the user looks   → "in 3 days" / "2 days overdue"
//
// Everything here is pure and clock-injected. Nothing relative is ever
// stored: `resolvePhrase` returns an ABSOLUTE instant plus the zone it was
// resolved in and the original words; `classifyAtProcessing` decides
// closure-check vs due; `renderRelative` computes the label per paint.
//
// Time zones are IANA names and every wall-clock ↔ instant conversion goes
// through Intl, so "sat 8pm" said in IST and "departs SFO 11:30 PDT" both
// land on the right instant (TIM-01, TIM-04). Recurring phrases become
// RULES, not dates (§11.6.4, CAL-04).
// ===========================================================================

export const DAY_MS = 86_400_000;

/** The zone assumed when neither the message nor the settings name one. */
export const DEFAULT_TZ = "Asia/Kolkata";

// ---------------------------------------------------------------------------
// Zone math
// ---------------------------------------------------------------------------

export interface WallClock {
  year: number;
  /** 1-based. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
}

const DTF_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = DTF_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    DTF_CACHE.set(tz, f);
  }
  return f;
}

export function isValidTz(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall clock in `tz` at instant `ms`. */
export function wallClock(ms: number, tz: string): WallClock {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: Math.max(0, WEEKDAY_SHORT.indexOf(get("weekday"))),
  };
}

/** Offset of `tz` from UTC at instant `ms`, in minutes (IST = +330). */
export function tzOffsetMinutes(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** The instant of a wall-clock time in `tz` (DST-safe by iteration). */
export function zonedToUtcMs(
  wall: { year: number; month: number; day: number; hour?: number; minute?: number },
  tz: string,
): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0);
  let guess = naive - tzOffsetMinutes(naive, tz) * 60_000;
  // One correction pass covers a DST edge between the naive and true offsets.
  guess = naive - tzOffsetMinutes(guess, tz) * 60_000;
  return guess;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** yyyy-mm-dd of instant `ms` in `tz`. */
export function localDate(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

/** HH:MM of instant `ms` in `tz`. */
export function localTime(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${pad2(w.hour)}:${pad2(w.minute)}`;
}

/** Locales tried in order for a NAMED abbreviation — ICU gives "IST" only under en-IN, "CEST" only under en-GB. */
const ABBREV_LOCALES = ["en-US", "en-IN", "en-GB"] as const;

/** Format the zone's abbreviation at an instant ("IST", "PDT", "GMT+2" when no name exists). */
export function tzAbbrev(ms: number, tz: string): string {
  let fallback: string | null = null;
  for (const locale of ABBREV_LOCALES) {
    try {
      const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms));
      const name = parts.find((p) => p.type === "timeZoneName")?.value;
      if (!name) continue;
      if (!/^(GMT|UTC)/.test(name)) return name;
      fallback ??= name;
    } catch {
      return tz;
    }
  }
  return fallback ?? tz;
}

/** Parse yyyy-mm-dd. */
export function parseDay(day: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** yyyy-mm-dd shifted by `days` (calendar arithmetic, no zone). */
export function addDays(day: string, days: number): string {
  const p = parseDay(day);
  if (!p) return day;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday, for a calendar day (no zone). */
export function weekdayOf(p: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Calendar-day difference b − a for two yyyy-mm-dd strings. */
export function dayDiff(a: string, b: string): number {
  const pa = parseDay(a);
  const pb = parseDay(b);
  if (!pa || !pb) return 0;
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / DAY_MS);
}

// ---------------------------------------------------------------------------
// MESSAGE TIME — resolve a phrase against when it was said
// ---------------------------------------------------------------------------

export interface MessageClock {
  /** ISO instant the message was sent. */
  ts: string;
  /** The user's zone at message time (§11.6.6). */
  tz?: string;
}

export interface ResolvedInstant {
  /** Absolute UTC instant. Date-only phrases resolve to 00:00 in `tz`. */
  iso: string;
  /** yyyy-mm-dd in `tz`. */
  date: string;
  /** HH:MM in `tz`, or null when the phrase named no time of day. */
  time: string | null;
  /** The zone the phrase was resolved in. */
  tz: string;
  /** The words that produced it, verbatim. */
  phrase: string;
  /** The message instant it was anchored to. */
  anchor: string;
  /** How the phrase was read — for the "why?" panel. */
  how: string;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b|\b(\d{1,2}):(\d{2})\b(?!\s*(?:am|pm))/i;

/** "8pm" / "8:30 pm" / "20:15" → {hour, minute}; null when absent. */
export function parseTimeOfDay(text: string): { hour: number; minute: number; match: string } | null {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  if (m[1] !== undefined) {
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const pm = /p/i.test(m[3] ?? "");
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, match: m[0] };
  }
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, match: m[0] };
}

function daysToWeekday(fromWeekday: number, target: number, next: boolean): number {
  let delta = (target - fromWeekday + 7) % 7;
  if (next && delta === 0) delta = 7;
  // "next friday" said on a Tuesday means the coming one; "next" only forces
  // a week ahead when today IS that weekday (TIM-03 reads "by friday" on a
  // Tuesday as three days later, never ten).
  return delta;
}

/**
 * Resolve a relative or partial date phrase against MESSAGE time. Returns
 * null when the text names no date — a caller must not invent one.
 */
export function resolvePhrase(phrase: string, message: MessageClock): ResolvedInstant | null {
  const tz = message.tz && isValidTz(message.tz) ? message.tz : DEFAULT_TZ;
  const anchorMs = Date.parse(message.ts);
  if (Number.isNaN(anchorMs)) return null;
  const anchor = wallClock(anchorMs, tz);
  const text = phrase.toLowerCase().replace(/\s+/g, " ").trim();
  const tod = parseTimeOfDay(text);

  let year = anchor.year;
  let month = anchor.month;
  let day = anchor.day;
  let how: string | null = null;

  const setOffset = (days: number, why: string): void => {
    const d = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day + days));
    year = d.getUTCFullYear();
    month = d.getUTCMonth() + 1;
    day = d.getUTCDate();
    how = why;
  };

  let m: RegExpExecArray | null;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text))) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]);
    how = "explicit ISO date";
  } else if (/\bday after(?: tomorrow)?\b/.test(text)) {
    setOffset(2, "day after tomorrow = message day + 2");
  } else if (/\btomorrow\b|\btmrw\b|\btmr\b/.test(text)) {
    setOffset(1, "tomorrow = message day + 1");
  } else if (/\byesterday\b/.test(text)) {
    setOffset(-1, "yesterday = message day − 1");
  } else if (/\b(today|tonight|eod|end of day)\b/.test(text)) {
    setOffset(0, "today = message day");
  } else if ((m = /\bin (\d{1,3}) (day|days|week|weeks)\b/.exec(text))) {
    const n = Number(m[1]) * (m[2]!.startsWith("week") ? 7 : 1);
    setOffset(n, `in ${m[1]} ${m[2]} from message day`);
  } else if (/\bnext week\b/.test(text)) {
    setOffset(7, "next week = message day + 7");
  } else if ((m = /\b(next |this |coming |by |on )?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/.exec(text))) {
    const target = WEEKDAYS[m[2]!]!;
    const next = (m[1] ?? "").trim() === "next";
    const delta = daysToWeekday(anchor.weekday, target, next);
    setOffset(delta, `${m[2]} after message day (${WEEKDAY_SHORT[anchor.weekday]}) = +${delta}d`);
  } else if ((m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b(?:\s+(\d{4}))?/.exec(text))) {
    day = Number(m[1]); month = MONTHS[m[2]!]!;
    year = m[3] ? Number(m[3]) : anchor.year;
    how = "explicit day + month";
  } else if ((m = /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/.exec(text))) {
    month = MONTHS[m[1]!]!; day = Number(m[2]);
    year = m[3] ? Number(m[3]) : anchor.year;
    how = "explicit month + day";
  } else if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text))) {
    // dd/mm, the way this user's chats write it.
    day = Number(m[1]); month = Number(m[2]);
    if (m[3]) year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    how = "explicit dd/mm";
  } else if (tod) {
    setOffset(0, "time of day only = message day");
  } else {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = zonedToUtcMs({ year, month, day, hour: tod?.hour ?? 0, minute: tod?.minute ?? 0 }, tz);
  if (Number.isNaN(ms)) return null;
  const date = `${year}-${pad2(month)}-${pad2(day)}`;
  return {
    iso: new Date(ms).toISOString(),
    date,
    time: tod ? `${pad2(tod.hour)}:${pad2(tod.minute)}` : null,
    tz,
    phrase,
    anchor: new Date(anchorMs).toISOString(),
    how: how ?? "explicit",
  };
}

/**
 * An instant a SOURCE named in its own zone ("departs SFO 11:30 PDT" on a
 * given date) → absolute UTC with the source zone kept (TIM-04). Never read
 * as the user's zone.
 */
export function instantInZone(
  wall: { year: number; month: number; day: number; hour?: number; minute?: number },
  tz: string,
): { iso: string; tz: string } {
  const zone = isValidTz(tz) ? tz : DEFAULT_TZ;
  return { iso: new Date(zonedToUtcMs(wall, zone)).toISOString(), tz: zone };
}

/**
 * Wall-clock arithmetic in the SOURCE zone: "check-in opens T−48h" for a
 * flight is computed on the flight's clock, then stored absolute.
 */
export function shiftInZone(iso: string, tz: string, hours: number): string {
  const ms = Date.parse(iso);
  const w = wallClock(ms, tz);
  const shifted = zonedToUtcMs({ year: w.year, month: w.month, day: w.day, hour: w.hour + hours, minute: w.minute }, tz);
  return new Date(shifted).toISOString();
}

// ---------------------------------------------------------------------------
// PROCESSING TIME — past or future?
// ---------------------------------------------------------------------------

export type Disposition = "closure_check" | "due";

export interface ProcessingVerdict {
  relation: "past" | "future";
  /** past → closure-checked, never surfaced as due; future → a real due. */
  disposition: Disposition;
  /** Calendar days from the processing day to the resolved day (negative = past). */
  offsetDays: number;
  why: string;
}

/** Decide, at PROCESSING time, what a resolved instant is (§11.6.2/3). */
export function classifyAtProcessing(resolved: { iso: string; date?: string; tz?: string }, processingNow: Date): ProcessingVerdict {
  const tz = resolved.tz && isValidTz(resolved.tz) ? resolved.tz : DEFAULT_TZ;
  const resolvedDay = resolved.date ?? localDate(Date.parse(resolved.iso), tz);
  const today = localDate(processingNow.getTime(), tz);
  const offsetDays = dayDiff(today, resolvedDay);
  // Calendar days decide: a phrase resolved to an earlier DAY than the
  // processing day is past (CAL-03 — a March "tomorrow" read in August).
  // The processing day itself is still "today", a live due.
  if (offsetDays < 0) {
    return {
      relation: "past",
      disposition: "closure_check",
      offsetDays,
      why: `${resolvedDay} is ${-offsetDays} day(s) before the processing day ${today} → closure check, never due`,
    };
  }
  return { relation: "future", disposition: "due", offsetDays, why: `${resolvedDay} is ${offsetDays} day(s) ahead of ${today} → due` };
}

// ---------------------------------------------------------------------------
// VIEW TIME — render relative to now, computed at paint
// ---------------------------------------------------------------------------

/**
 * "today" / "tomorrow" / "in N days" / "N day(s) overdue", from the viewer's
 * now in the viewer's zone. Pure — the stored value never changes (TIM-02).
 */
export function renderRelative(iso: string, viewNow: Date, tz: string = DEFAULT_TZ): string {
  const zone = isValidTz(tz) ? tz : DEFAULT_TZ;
  const target = iso.length === 10 ? iso : localDate(Date.parse(iso), zone);
  const today = localDate(viewNow.getTime(), zone);
  const offset = dayDiff(today, target);
  if (offset === 0) return "today";
  if (offset === 1) return "tomorrow";
  if (offset === -1) return "1 day overdue";
  if (offset > 0) return `in ${offset} days`;
  return `${-offset} days overdue`;
}

/**
 * A rendered instant for the viewer: their zone first, the source zone noted
 * when it differs ("2026-09-03 00:00 IST (11:30 PDT)") — TIM-04, §11.6.6.
 */
export function renderInstant(iso: string, viewTz: string, sourceTz?: string | null): string {
  const ms = Date.parse(iso);
  const vz = isValidTz(viewTz) ? viewTz : DEFAULT_TZ;
  const main = `${localDate(ms, vz)} ${localTime(ms, vz)} ${tzAbbrev(ms, vz)}`;
  if (!sourceTz || sourceTz === vz || !isValidTz(sourceTz)) return main;
  const src = `${localTime(ms, sourceTz)} ${tzAbbrev(ms, sourceTz)}`;
  return localTime(ms, sourceTz) === localTime(ms, vz) && tzAbbrev(ms, sourceTz) === tzAbbrev(ms, vz)
    ? main
    : `${main} (${src})`;
}

// ---------------------------------------------------------------------------
// Recurrence rules — "every 1st", "every friday", "monthly"
// ---------------------------------------------------------------------------

export type Freq = "daily" | "weekly" | "monthly" | "yearly";

export interface RecurrenceRule {
  freq: Freq;
  interval: number;
  /** 1..31 for monthly rules ("every 1st"). */
  byMonthDay?: number;
  /** 0..6 for weekly rules ("every friday"). */
  byWeekday?: number;
  /** HH:MM when the phrase carried one. */
  time?: string;
  /** The words, verbatim. */
  phrase: string;
}

const ORDINAL_RE = /\b(\d{1,2})(?:st|nd|rd|th)\b/;

/** A recurring phrase → a rule; null when the text is not recurring. */
export function parseRecurrence(phrase: string): RecurrenceRule | null {
  const text = phrase.toLowerCase().replace(/\s+/g, " ").trim();
  const tod = parseTimeOfDay(text);
  const time = tod ? `${pad2(tod.hour)}:${pad2(tod.minute)}` : undefined;
  const base = (rule: Omit<RecurrenceRule, "phrase" | "time">): RecurrenceRule => ({
    ...rule,
    ...(time ? { time } : {}),
    phrase,
  });
  let m: RegExpExecArray | null;
  if ((m = /\bevery (\d+) (day|days|week|weeks|month|months|year|years)\b/.exec(text))) {
    const unit = m[2]!.replace(/s$/, "");
    const freq: Freq = unit === "day" ? "daily" : unit === "week" ? "weekly" : unit === "month" ? "monthly" : "yearly";
    return base({ freq, interval: Number(m[1]) });
  }
  if (/\b(every|each) (day|morning|evening|night)\b|\bdaily\b/.test(text)) return base({ freq: "daily", interval: 1 });
  if ((m = /\b(?:every|each) (sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)s?\b/.exec(text))) {
    return base({ freq: "weekly", interval: 1, byWeekday: WEEKDAYS[m[1]!]! });
  }
  if ((m = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s\b/.exec(text))) {
    return base({ freq: "weekly", interval: 1, byWeekday: WEEKDAYS[m[1]!]! });
  }
  if (/\b(every|each) week\b|\bweekly\b/.test(text)) return base({ freq: "weekly", interval: 1 });
  if ((m = /\b(?:every|each) (\d{1,2})(?:st|nd|rd|th)\b(?: of (?:the|every) month)?/.exec(text))) {
    const d = Number(m[1]);
    if (d >= 1 && d <= 31) return base({ freq: "monthly", interval: 1, byMonthDay: d });
  }
  if ((m = /\b(\d{1,2})(?:st|nd|rd|th) of (?:every|each) month\b/.exec(text))) {
    const d = Number(m[1]);
    if (d >= 1 && d <= 31) return base({ freq: "monthly", interval: 1, byMonthDay: d });
  }
  if (/\b(every|each) month\b|\bmonthly\b/.test(text)) {
    const o = ORDINAL_RE.exec(text);
    const d = o ? Number(o[1]) : undefined;
    return base({ freq: "monthly", interval: 1, ...(d && d >= 1 && d <= 31 ? { byMonthDay: d } : {}) });
  }
  if (/\b(every|each) year\b|\byearly\b|\bannually\b|\bevery anniversary\b/.test(text)) return base({ freq: "yearly", interval: 1 });
  return null;
}

/**
 * The next `n` occurrence days (yyyy-mm-dd) of a rule on/after `fromDay`.
 * Monthly rules clamp to the month's last day; weekly rules with no weekday
 * keep the anchor's weekday.
 */
export function nextOccurrences(rule: RecurrenceRule, fromDay: string, n: number, anchorDay?: string): string[] {
  const from = parseDay(fromDay);
  if (!from || n <= 0) return [];
  const out: string[] = [];
  const interval = Math.max(1, rule.interval);
  if (rule.freq === "daily") {
    for (let i = 0; out.length < n; i += interval) out.push(addDays(fromDay, i));
    return out;
  }
  if (rule.freq === "weekly") {
    const fromWeekday = weekdayOf(from);
    const anchorWd = anchorDay ? weekdayOf(parseDay(anchorDay) ?? from) : fromWeekday;
    const target = rule.byWeekday ?? anchorWd;
    const first = addDays(fromDay, (target - fromWeekday + 7) % 7);
    for (let i = 0; out.length < n; i += 7 * interval) out.push(addDays(first, i));
    return out;
  }
  if (rule.freq === "monthly") {
    const dom = rule.byMonthDay ?? (anchorDay ? (parseDay(anchorDay)?.day ?? from.day) : from.day);
    let y = from.year;
    let mo = from.month;
    while (out.length < n) {
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const d = Math.min(dom, last);
      const candidate = `${y}-${pad2(mo)}-${pad2(d)}`;
      if (candidate >= fromDay) out.push(candidate);
      mo += interval;
      while (mo > 12) { mo -= 12; y += 1; }
    }
    return out;
  }
  // yearly
  const a = anchorDay ? parseDay(anchorDay) ?? from : from;
  let y = from.year;
  while (out.length < n) {
    const last = new Date(Date.UTC(y, a.month, 0)).getUTCDate();
    const candidate = `${y}-${pad2(a.month)}-${pad2(Math.min(a.day, last))}`;
    if (candidate >= fromDay) out.push(candidate);
    y += interval;
  }
  return out;
}

/** A human line for a rule — the confirm suggestion's text. */
export function describeRule(rule: RecurrenceRule): string {
  const every = rule.interval > 1 ? `every ${rule.interval} ` : "every ";
  const unit = rule.freq === "daily" ? "day" : rule.freq === "weekly" ? "week" : rule.freq === "monthly" ? "month" : "year";
  let s = `${every}${unit}${rule.interval > 1 ? "s" : ""}`;
  if (rule.freq === "weekly" && rule.byWeekday !== undefined) s = `${every === "every " ? "every" : every.trim()} ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][rule.byWeekday]}`;
  if (rule.freq === "monthly" && rule.byMonthDay !== undefined) s += ` on the ${ordinal(rule.byMonthDay)}`;
  if (rule.time) s += ` at ${rule.time}`;
  return s;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
