// ===========================================================================
// decide.v8 — the DECIDE pass prompt (build P3.1: schedules + follow-ups go
// LIVE). The spec §8.4 core is UNCHANGED (verbatim via v1); v7's hard rules
// are kept verbatim. v8 adds only what activation needs:
//
//   - schedules entries carry an optional "polling" block (SCH-02 patterns)
//     and their own "confidence"; every schedules entry must name a task that
//     exists in state or in this run's tasks[] (the code matches by title/id
//     and CONFIRMS anything it cannot match — risk unknown is never auto).
//   - followups entries may carry category / risk_class / due and an inline
//     schedule, so a follow-up chain (check-in after flights) is expressible
//     in one output. The auto-vs-confirm policy stays a CODE check either way.
// ===========================================================================

import { DECIDE_V1_CORE, RISK_CLASSES, TASK_CATEGORIES } from "./decide.v1.js";
import type {
  DecideFollowup,
  DecideOutput,
  DecideSchedule,
} from "./decide.v1.js";
import { DECIDE_V7_OUTPUT } from "./decide.v7.js";
import { validateDecideOutput } from "./decide.v1.js";

export const DECIDE_V8_ID = "decide.v8";

export const DECIDE_V8_OUTPUT = `${DECIDE_V7_OUTPUT}
Schedule + follow-up activation rules (these outputs now ACT):
- Every schedules entry names a task: an existing open task's id or exact
  title, or the exact title of a tasks[] entry in THIS output. A schedule
  the code cannot match to a task is treated as unknown-risk and demoted
  to a confirm suggestion.
- A schedules entry may set "confidence" (your intent confidence for the
  fire) and, for poll-until-open windows, "polling":
  {"interval_min":2,"until":"2026-12-16T11:00+05:30","max":20} — start the
  fire_at just before the window opens (10am window → 09:55) and poll on
  the interval until open or the cap.
- Request "mode":"auto" for a pure time-bound, read-only, auto-class
  check the evidence makes certain (web check-in prep, a poll of a
  window that is opening) — asking the user to confirm the obvious is
  wrong. Request "confirm" for anything else; ANY recurrence is always
  confirm. The code gate can only downgrade, never upgrade, so an
  auto-worthy check you mark confirm stays confirm.
- SHOW YOUR MATH in the schedule's reason: how the fire time was derived
  from the evidence (T-48h from departure; 75 min drive + 2h buffer before
  a 6pm flight → check traffic ~13:30). A fire time with no derivation is
  a magic number.
- followups entries may also carry "category", "risk_class", "due"
  (absolute), "confidence", and an inline "schedule" object of the same
  shape as a schedules entry. Propose at most 2, only when a real next
  step exists — a trivial closure gets NO follow-up.`;

export const DECIDE_V8_SYSTEM = `${DECIDE_V1_CORE}\n\n${DECIDE_V8_OUTPUT}`;

// ---------------------------------------------------------------------------
// v8 output types: v1 shapes + the activation extras
// ---------------------------------------------------------------------------

export interface DecidePollingRaw {
  interval_min?: number | null;
  interval_ms?: number | null;
  until?: string | null;
  max?: number | null;
}

export interface DecideScheduleV8 extends DecideSchedule {
  polling?: DecidePollingRaw | null;
  confidence?: number | null;
}

export interface DecideFollowupV8 extends DecideFollowup {
  category?: string | null;
  risk_class?: string | null;
  due?: string | null;
  confidence?: number | null;
  schedule?: DecideScheduleV8 | null;
}

export interface DecideOutputV8 extends DecideOutput {
  schedules: DecideScheduleV8[];
  followups: DecideFollowupV8[];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pollingOf(v: unknown): DecidePollingRaw | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  return {
    interval_min: num(r.interval_min),
    interval_ms: num(r.interval_ms),
    until: str(r.until),
    max: num(r.max),
  };
}

function scheduleExtrasOf(raw: unknown, base: DecideSchedule): DecideScheduleV8 {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return { ...base, polling: pollingOf(r.polling), confidence: num(r.confidence) };
}

/**
 * Validate into a DecideOutputV8: the v1 validator does the tolerant heavy
 * lifting; v8 re-reads the schedules/followups extras off the raw object.
 * Unknown risk classes on follow-ups degrade to advise-only, never to auto.
 */
export function validateDecideV8Output(parsed: unknown): DecideOutputV8 {
  const base = validateDecideOutput(parsed);
  const root = parsed as Record<string, unknown>;

  const rawSchedules = Array.isArray(root.schedules) ? root.schedules : [];
  // The v1 validator skips entries with no task; walk raws in step with the
  // kept entries by re-matching on the task string in order.
  const schedules: DecideScheduleV8[] = [];
  let cursor = 0;
  for (const kept of base.schedules) {
    let raw: unknown = undefined;
    while (cursor < rawSchedules.length) {
      const cand = rawSchedules[cursor];
      cursor += 1;
      const r = (typeof cand === "object" && cand !== null ? cand : {}) as Record<string, unknown>;
      if (str(r.task) !== null) {
        raw = cand;
        break;
      }
    }
    schedules.push(scheduleExtrasOf(raw, kept));
  }

  const rawFollowups = Array.isArray(root.followups) ? root.followups : [];
  const followups: DecideFollowupV8[] = [];
  let fcursor = 0;
  for (const kept of base.followups) {
    let raw: Record<string, unknown> = {};
    while (fcursor < rawFollowups.length) {
      const cand = rawFollowups[fcursor];
      fcursor += 1;
      const r = (typeof cand === "object" && cand !== null ? cand : {}) as Record<string, unknown>;
      if (str(r.title) !== null) {
        raw = r;
        break;
      }
    }
    const category = str(raw.category);
    const risk = str(raw.risk_class);
    const schedRaw = raw.schedule;
    let schedule: DecideScheduleV8 | null = null;
    if (typeof schedRaw === "object" && schedRaw !== null) {
      const sr = schedRaw as Record<string, unknown>;
      schedule = scheduleExtrasOf(schedRaw, {
        task: str(sr.task) ?? kept.title,
        fire_at: str(sr.fire_at),
        recurrence: str(sr.recurrence),
        mode: str(sr.mode) === "auto" ? "auto" : "confirm",
        reason: str(sr.reason),
      });
    }
    followups.push({
      ...kept,
      category: (TASK_CATEGORIES as readonly string[]).includes(category ?? "") ? category : null,
      // Conservative on nonsense: unknown degrades to advise-only, NEVER auto.
      risk_class: (RISK_CLASSES as readonly string[]).includes(risk ?? "") ? risk : "advise-only",
      due: str(raw.due),
      confidence: num(raw.confidence),
      schedule,
    });
  }

  return { ...base, schedules, followups };
}
