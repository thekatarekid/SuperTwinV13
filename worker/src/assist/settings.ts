// ===========================================================================
// [CODE] Assist lane settings — build P2.2, spec §10.1 + §14.9.
//
// Every knob the code trigger gate reads lives here as an app_state key with
// a spec default, user-editable in Settings › Assist. There is NO daily nudge
// cap on purpose (spec §10.1): rate emerges from novelty + intent confidence
// + hygiene, and these are the hygiene numbers.
// ===========================================================================

import { appStateGet, appStateSet } from "../db/ingest.js";

// ---- keys ------------------------------------------------------------------

export const ASSIST_ENABLED_KEY = "assist.enabled";
export const ASSIST_THRESHOLD_KEY_PREFIX = "assist.threshold_"; // + category
export const ASSIST_COOLDOWN_MIN_KEY = "assist.cooldown_min";
export const ASSIST_SUPPRESS_DAYS_KEY = "assist.suppress_days";
export const ASSIST_QUIET_START_KEY = "assist.quiet_start"; // "HH:MM" local
export const ASSIST_QUIET_END_KEY = "assist.quiet_end";
export const ASSIST_INTENT_MIN_KEY = "assist.intent_confidence_min";
export const ASSIST_HELPFULNESS_MIN_KEY = "assist.helpfulness_min";
export const CAPTURE_PAUSED_UNTIL_KEY = "capture.paused_until"; // ISO; quick-pause

// ---- defaults (spec §10.1) -------------------------------------------------

/** Per-category novelty thresholds N: default 5, transaction 3, research 7. */
export const ASSIST_THRESHOLD_DEFAULTS: Record<string, number> = {
  default: 5,
  transaction: 3,
  research: 7,
};

export const DEFAULT_ASSIST_COOLDOWN_MIN = 45;
export const DEFAULT_ASSIST_SUPPRESS_DAYS = 7;
export const DEFAULT_ASSIST_QUIET_START = "22:00";
export const DEFAULT_ASSIST_QUIET_END = "08:00";
export const DEFAULT_ASSIST_INTENT_MIN = 0.7;
export const DEFAULT_ASSIST_HELPFULNESS_MIN = 0.6;

// ---- reads -----------------------------------------------------------------

function readNumber(key: string, fallback: number): number {
  const raw = appStateGet(key);
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Assist is ON by default; only an explicit "0" turns it off. */
export function getAssistEnabled(): boolean {
  const v = appStateGet(ASSIST_ENABLED_KEY);
  return v == null ? true : v !== "0";
}

export function setAssistEnabled(v: boolean): void {
  appStateSet(ASSIST_ENABLED_KEY, v ? "1" : "0");
}

/** The novelty threshold N for one topic category (user-editable per §14.9). */
export function assistThreshold(category: string | null | undefined): number {
  const cat =
    category && ASSIST_THRESHOLD_DEFAULTS[category] !== undefined ? category : "default";
  return Math.max(
    1,
    Math.floor(
      readNumber(`${ASSIST_THRESHOLD_KEY_PREFIX}${cat}`, ASSIST_THRESHOLD_DEFAULTS[cat]!),
    ),
  );
}

export function setAssistThreshold(category: string, n: number): void {
  appStateSet(`${ASSIST_THRESHOLD_KEY_PREFIX}${category}`, String(Math.max(1, Math.floor(n))));
}

export function assistCooldownMinutes(): number {
  return readNumber(ASSIST_COOLDOWN_MIN_KEY, DEFAULT_ASSIST_COOLDOWN_MIN);
}

export function assistSuppressDays(): number {
  return readNumber(ASSIST_SUPPRESS_DAYS_KEY, DEFAULT_ASSIST_SUPPRESS_DAYS);
}

export function assistIntentConfidenceMin(): number {
  return readNumber(ASSIST_INTENT_MIN_KEY, DEFAULT_ASSIST_INTENT_MIN);
}

export function assistHelpfulnessMin(): number {
  return readNumber(ASSIST_HELPFULNESS_MIN_KEY, DEFAULT_ASSIST_HELPFULNESS_MIN);
}

/** Quiet hours window as "HH:MM" strings (local time). */
export function assistQuietHours(): { start: string; end: string } {
  return {
    start: appStateGet(ASSIST_QUIET_START_KEY) ?? DEFAULT_ASSIST_QUIET_START,
    end: appStateGet(ASSIST_QUIET_END_KEY) ?? DEFAULT_ASSIST_QUIET_END,
  };
}

export function setAssistQuietHours(start: string, end: string): void {
  appStateSet(ASSIST_QUIET_START_KEY, start);
  appStateSet(ASSIST_QUIET_END_KEY, end);
}

/**
 * Whether `nowMs` (local wall clock) falls inside the quiet window. Handles
 * windows that cross midnight (the 22:00 → 08:00 default). Equal start/end
 * means quiet hours are effectively off.
 */
export function inQuietHours(nowMs: number, hours = assistQuietHours()): boolean {
  const parse = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const start = parse(hours.start);
  const end = parse(hours.end);
  if (start == null || end == null || start === end) return false;
  const d = new Date(nowMs);
  const mins = d.getHours() * 60 + d.getMinutes();
  return start < end ? mins >= start && mins < end : mins >= start || mins < end;
}

// ---- capture quick-pause (menu-bar ⏸, build P2.3) --------------------------

export function getCapturePausedUntil(): string | null {
  return appStateGet(CAPTURE_PAUSED_UNTIL_KEY);
}

export function setCapturePausedUntil(iso: string | null): void {
  appStateSet(CAPTURE_PAUSED_UNTIL_KEY, iso ?? "");
}

export function isCapturePaused(nowMs: number = Date.now()): boolean {
  const until = getCapturePausedUntil();
  if (!until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > nowMs;
}
