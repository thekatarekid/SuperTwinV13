// ===========================================================================
// The set times (Product_V6 §25 General "brief times"; §14.4 item 7).
//
// "At the times set in Settings › General" — so the clock decides WHEN a
// brief is considered, and the delta decides whether it is written. This
// module is only the first half: a pure function from (now, times, last slot)
// to the one slot that is due.
//
// ONE slot, never a backlog. A laptop opened at 14:00 does not owe the user
// this morning's 08:30 brief — that brief's window has passed, and the 18:30
// one will carry everything that moved anyway (its window starts at the last
// brief the user actually read, not at the last slot). So a slot older than
// GRACE_MS is consumed silently: `last_slot` advances, nothing is composed.
// ===========================================================================

import { DEFAULT_TZ, localDate, pad2, wallClock, zonedToUtcMs } from "../calendar/clocks.js";

/**
 * app_state key holding the user's set times, as written by
 * `POST /api/settings/general` (server/settings-routes.ts BRIEF_TIMES_KEY).
 * Declared here as well so the brief lane does not depend on the HTTP layer;
 * brief/schedule.test.ts asserts the two constants never drift.
 */
export const BRIEF_TIMES_KEY = "general.brief_times";

/** Settings' default pair, mirrored for the same reason. */
export const DEFAULT_BRIEF_TIMES: readonly string[] = Object.freeze(["08:30", "18:30"]);

/** How late a missed slot may still fire. Older than this is consumed, not composed. */
export const SLOT_GRACE_MS = 3 * 60 * 60_000;

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "8:30" · "08:30" → "08:30"; anything else → null. */
export function normaliseTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = TIME_RE.exec(raw.trim());
  if (!m) return null;
  return `${pad2(Number(m[1]))}:${m[2]}`;
}

/** The set times, sorted and de-duplicated. Nothing valid → the default pair. */
export function briefTimes(raw: readonly unknown[] | null | undefined): string[] {
  const times = [...new Set((raw ?? []).map(normaliseTime).filter((t): t is string => t !== null))];
  return times.length > 0 ? times.sort() : [...DEFAULT_BRIEF_TIMES];
}

/** A slot key: `yyyy-mm-dd HH:MM` in the user's zone. Sorts chronologically. */
export function slotKey(day: string, time: string): string {
  return `${day} ${time}`;
}

export function slotInstantMs(slot: string, tz: string): number {
  const [day, time] = slot.split(" ");
  const [y, mo, d] = (day ?? "").split("-").map(Number);
  const [h, mi] = (time ?? "").split(":").map(Number);
  return zonedToUtcMs({ year: y!, month: mo!, day: d!, hour: h!, minute: mi! }, tz);
}

export interface DueSlot {
  slot: string;
  /** How late the job is to it, in ms. */
  lateMs: number;
  /** True when the slot is past its grace window: consume it, never compose it. */
  stale: boolean;
}

/**
 * The one slot to act on now, or null. Looks at today's and yesterday's set
 * times (a 23:30 brief considered at 00:05 is yesterday's slot), takes the
 * NEWEST one that is due and newer than `lastSlot`, and marks it stale when
 * it is older than the grace window.
 */
export function dueSlot(
  nowMs: number,
  times: readonly string[],
  lastSlot: string | null,
  tz: string = DEFAULT_TZ,
  graceMs: number = SLOT_GRACE_MS,
): DueSlot | null {
  const today = localDate(nowMs, tz);
  const w = wallClock(nowMs, tz);
  const yesterday = localDate(zonedToUtcMs({ year: w.year, month: w.month, day: w.day }, tz) - 12 * 60 * 60_000, tz);
  const candidates: DueSlot[] = [];
  for (const day of [yesterday, today]) {
    for (const time of times) {
      const slot = slotKey(day, time);
      if (lastSlot !== null && slot <= lastSlot) continue;
      const lateMs = nowMs - slotInstantMs(slot, tz);
      if (lateMs < 0) continue; // not yet
      candidates.push({ slot, lateMs, stale: lateMs > graceMs });
    }
  }
  if (candidates.length === 0) return null;
  // Newest due slot wins; older ones are superseded by it (never a backlog).
  candidates.sort((a, b) => (a.slot < b.slot ? 1 : a.slot > b.slot ? -1 : 0));
  return candidates[0]!;
}
