// ===========================================================================
// Budgeted truncation (V6 P1 S3.2; Build §6.1 "Truncation. Budgeted from the
// remaining allowance — floor 400, ceiling 4,000"; PCK-05).
//
// The pack has one character budget. Every context block spends from it in
// order; what is left when the bundle is rendered is divided among the
// bundle's events. A 1-event bundle gets up to 4,000 chars of its one event;
// a 150-event bundle gets the 400-char floor per event. Never a fixed 1,200.
// ===========================================================================

/** Whole-pack budget (Product P1 §7.3 "under 16,000 chars"). */
export const PACK_BUDGET_CHARS = 16_000;
/** Per-event allowance bounds. */
export const EVENT_TEXT_FLOOR = 400;
export const EVENT_TEXT_CEILING = 4_000;
/** Head overhead reserved per event line before the text allowance is computed. */
export const EVENT_HEAD_RESERVE = 96;
/** Per-line text bounds inside a history block. */
export const HISTORY_LINE_FLOOR = 40;
export const HISTORY_LINE_CEILING = 240;
export const HISTORY_QUOTED_MIN = 160;
export const HISTORY_HEAD_RESERVE = 48;

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Per-event text allowance from the remaining budget: floor 400, ceiling
 * 4,000, whatever the event count.
 */
export function eventAllowance(remainingChars: number, eventCount: number): number {
  if (eventCount <= 0) return EVENT_TEXT_CEILING;
  const perEvent = Math.floor(remainingChars / eventCount) - EVENT_HEAD_RESERVE;
  return clamp(perEvent, EVENT_TEXT_FLOOR, EVENT_TEXT_CEILING);
}

/** Per-line text allowance for a history block of `lines` under `budget` chars. */
export function historyAllowance(budget: number, lines: number): number {
  if (lines <= 0) return HISTORY_LINE_CEILING;
  return clamp(Math.floor(budget / lines) - HISTORY_HEAD_RESERVE, HISTORY_LINE_FLOOR, HISTORY_LINE_CEILING);
}

/** One line, whitespace-folded, cut at `max` with an ellipsis. */
export function clip(text: string | null | undefined, max: number): string {
  const one = (text ?? "").replace(/\r?\n/g, " ⏎ ").replace(/[ \t]+/g, " ").trim();
  if (one.length <= max) return one;
  return max <= 1 ? "…" : `${one.slice(0, max - 1)}…`;
}

/** Multi-line body cut at `max` chars, an ellipsis marking the cut. */
export function clipBody(text: string | null | undefined, max: number): string {
  const body = (text ?? "").replace(/\r\n/g, "\n").trim();
  if (body.length <= max) return body;
  return `${body.slice(0, Math.max(0, max - 1))}…`;
}
