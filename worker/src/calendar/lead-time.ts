// ===========================================================================
// Lead-time planning by circle (V6 P1 S5.3; Product_V6 §11.8.4, §11.9.2;
// Product_V6_Phase1 §16, Settings › Calendar).
//
// A person's date (birthday, anniversary, exam, flight) is either a PLAN or a
// WISH. Plan: a space opens at T minus the lead time. Wish: nothing opens, the
// date just shows on the people layer. Defaults are per circle — partner and
// family 14 days, close friends 7, everyone else wish-only — overridable in
// Settings › Calendar (app_state), then overridden again per person the
// moment the user snoozes ("10 days before" said once becomes that person's
// lead time — CAL-02 "snooze options offered and learned").
//
// Snooze options (§11.9.2): next week · 10 days before · 3 days before. Each
// is computed against the occurrence, never against "now", so the choice is
// a lead time the twin can carry to next year.
// ===========================================================================

import { appStateGet, appStateSet } from "../db/ingest.js";
import { CIRCLES, isCircle, type Circle } from "../entities/registry.js";
import { addDays, dayDiff } from "./clocks.js";

export type DateMode = "plan" | "wish";

export interface CirclePolicy {
  mode: DateMode;
  leadDays: number;
}

/** §11.8.4: 14 for partner and family, 7 for close friends, 0 = wish-only. */
export const DEFAULT_CIRCLE_POLICY: Readonly<Record<Circle, CirclePolicy>> = {
  partner: { mode: "plan", leadDays: 14 },
  family: { mode: "plan", leadDays: 14 },
  close_friends: { mode: "plan", leadDays: 7 },
  friends: { mode: "wish", leadDays: 0 },
  coworkers: { mode: "wish", leadDays: 0 },
  important_services: { mode: "wish", leadDays: 0 },
  old_batchmates: { mode: "wish", leadDays: 0 },
  acquaintances: { mode: "wish", leadDays: 0 },
  businesses: { mode: "wish", leadDays: 0 },
};

/** A person with no circle yet is treated as wish-only until circled. */
export const UNCIRCLED_POLICY: CirclePolicy = { mode: "wish", leadDays: 0 };

export const CALENDAR_SETTINGS_KEY = "settings.calendar.circles";

export type CalendarSettings = Record<Circle, CirclePolicy>;

function clampLead(n: unknown, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(365, Math.round(n)));
}

/** Settings › Calendar: every circle's mode + lead time (defaults filled in). */
export function calendarSettings(): CalendarSettings {
  const out = {} as CalendarSettings;
  for (const c of CIRCLES) out[c] = { ...DEFAULT_CIRCLE_POLICY[c] };
  const raw = appStateGet(CALENDAR_SETTINGS_KEY);
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const c of CIRCLES) {
      const v = parsed[c];
      if (!v || typeof v !== "object") continue;
      const o = v as Record<string, unknown>;
      if (o.mode === "plan" || o.mode === "wish") out[c].mode = o.mode;
      out[c].leadDays = clampLead(o.leadDays, out[c].leadDays);
    }
  } catch {
    // a corrupt row falls back to the defaults; nothing else to do
  }
  return out;
}

/** Overwrite one or more circles' policy. Unknown circles are ignored. */
export function setCalendarSettings(patch: Partial<Record<string, Partial<CirclePolicy>>>): CalendarSettings {
  const current = calendarSettings();
  for (const [circle, v] of Object.entries(patch)) {
    if (!isCircle(circle) || !v) continue;
    if (v.mode === "plan" || v.mode === "wish") current[circle].mode = v.mode;
    if (v.leadDays !== undefined) current[circle].leadDays = clampLead(v.leadDays, current[circle].leadDays);
  }
  appStateSet(CALENDAR_SETTINGS_KEY, JSON.stringify(current));
  return current;
}

/** The circle's policy, from settings (defaults when unset). */
export function circlePolicy(circle: string | null | undefined, settings: CalendarSettings = calendarSettings()): CirclePolicy {
  return isCircle(circle) ? settings[circle] : UNCIRCLED_POLICY;
}

/**
 * Resolve a person date's effective policy: the row's own mode/lead (learned
 * from a snooze or set by the user) wins; NULL means "the circle's default".
 */
export function effectivePolicy(
  row: { mode: string | null; lead_days: number | null },
  circle: string | null | undefined,
  settings: CalendarSettings = calendarSettings(),
): CirclePolicy {
  const base = circlePolicy(circle, settings);
  const mode: DateMode = row.mode === "plan" || row.mode === "wish" ? row.mode : base.mode;
  const leadDays = row.lead_days !== null && row.lead_days !== undefined ? clampLead(row.lead_days, base.leadDays) : base.leadDays;
  return { mode, leadDays };
}

// ---------------------------------------------------------------------------
// Snooze — the three options, as lead times against the occurrence
// ---------------------------------------------------------------------------

export type SnoozeChoice = "next_week" | "10_days_before" | "3_days_before";

export interface SnoozeOption {
  id: SnoozeChoice;
  label: string;
  /** yyyy-mm-dd the plan re-opens on. */
  until: string;
  /** The lead time this choice implies (occurrence − until); learned per person. */
  leadDays: number;
}

/**
 * The nudge's snooze options for a plan that opened on `openedDay` for a date
 * on `occurrence` (§11.9.2). Options that would land on or after the date
 * itself are dropped — a snooze never skips the day.
 */
export function snoozeOptions(openedDay: string, occurrence: string): SnoozeOption[] {
  const candidates: Array<{ id: SnoozeChoice; label: string; until: string }> = [
    { id: "next_week", label: "Next week", until: addDays(openedDay, 7) },
    { id: "10_days_before", label: "10 days before", until: addDays(occurrence, -10) },
    { id: "3_days_before", label: "3 days before", until: addDays(occurrence, -3) },
  ];
  const out: SnoozeOption[] = [];
  for (const c of candidates) {
    const leadDays = dayDiff(c.until, occurrence);
    if (leadDays <= 0) continue; // on or past the date
    if (c.until <= openedDay) continue; // not a snooze at all
    if (out.some((o) => o.until === c.until)) continue;
    out.push({ ...c, leadDays });
  }
  return out;
}

export function isSnoozeChoice(v: unknown): v is SnoozeChoice {
  return v === "next_week" || v === "10_days_before" || v === "3_days_before";
}
