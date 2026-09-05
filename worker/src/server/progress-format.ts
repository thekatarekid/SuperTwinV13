// ===========================================================================
// [CODE] Progress-meter wording — the pieces of the deleted V13 scheduler
// (scheduler/horizons.ts, scheduler/lanes.ts) that the coverage surface still
// renders (V6 P1 S3.3). Moved verbatim so the meter cannot disagree with what
// it used to say: the mode vocabulary of `cohorts.mode`, the paused-lane line
// with its mm:ss countdown, and the "~N min remaining" estimate that prefers
// no estimate to a made-up one.
// ===========================================================================

/** `reprocess` is the third mode of `cohorts.mode` — a re-read of settled history. */
export const MODES = ["bootstrap", "steady", "reprocess"] as const;
export type SchedulerMode = (typeof MODES)[number];

export function isMode(value: unknown): value is SchedulerMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export interface PauseWindow {
  fromMs: number;
  toMs: number;
  reason: "quota" | "auth";
}

export interface PauseState {
  paused: boolean;
  /** "paused — rate limit, resumes in 04:12". */
  label: string;
  remainingSeconds: number;
  /** A refusal must NEVER consume the unit's retry budget. */
  retryBudgetSpent: boolean;
}

/** mm:ss, so a countdown reads as a countdown and not as a float. */
export function formatCountdown(remainingSeconds: number): string {
  const s = Math.max(0, Math.ceil(remainingSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** The paused lane's rendering — one quiet state, said out loud. */
export function pauseState(pause: PauseWindow | null, nowMs: number): PauseState {
  if (!pause || nowMs >= pause.toMs) {
    return { paused: false, label: "", remainingSeconds: 0, retryBudgetSpent: false };
  }
  const remaining = (pause.toMs - nowMs) / 1000;
  const what = pause.reason === "quota" ? "rate limit" : "sign-in needed";
  return {
    paused: true,
    label: `paused — ${what}, resumes in ${formatCountdown(remaining)}`,
    remainingSeconds: Math.ceil(remaining),
    retryBudgetSpent: false,
  };
}

/**
 * "~40 min remaining at current rate". Returns null while nothing has been
 * measured, because a made-up estimate is worse than none.
 */
export function remainingMinutes(doneUnits: number, totalUnits: number, unitsPerMinute: number): number | null {
  if (!(unitsPerMinute > 0)) return null;
  const left = Math.max(0, totalUnits - doneUnits);
  return Math.ceil(left / unitsPerMinute);
}
