// ===========================================================================
// Render-relative due labels (spec §16 two-layer time / eval TIM-02).
//
// The STORED value is always the absolute date; the relative word is computed
// at render time from the viewer's "now" and never written back. The UI (task
// modal, library views, Today) calls this per paint.
// ===========================================================================

const DAY_MS = 86_400_000;

/** Calendar-day difference from `now` to `dueIso` (both read as local dates). */
export function dueOffsetDays(dueIso: string, now: Date): number {
  const due = new Date(`${dueIso.slice(0, 10)}T00:00:00`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / DAY_MS);
}

/**
 * The render-time relative label for a due date: "today" / "tomorrow" /
 * "in N days" / "N day(s) overdue". Pure — same stored date, different `now`,
 * different label.
 */
export function dueLabel(dueIso: string, now: Date): string {
  const offset = dueOffsetDays(dueIso, now);
  if (offset === 0) return "today";
  if (offset === 1) return "tomorrow";
  if (offset === -1) return "1 day overdue";
  return offset > 0 ? `in ${offset} days` : `${-offset} days overdue`;
}
