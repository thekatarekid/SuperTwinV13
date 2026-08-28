// ===========================================================================
// Schedule policy + fire-time math (build P3.1, spec §8.4.3 + §11.2).
//
// THE policy gate for every schedule candidate the model emits — Decide,
// the next-step pass, and the deferred-output replay all funnel through
// `evaluateSchedulePolicy`. The rules live HERE, in code, never only in a
// prompt (build convention: auto-vs-confirm is a code check on pass output):
//
//   auto  ⇔ requested auto AND action is auto-class AND confidence is high
//           AND the value is time-bound (a computable FUTURE fire time).
//   recurrence (any recurring commitment) ⇒ confirm, ALWAYS — even when the
//           model asked for auto (SCH-04 subscription-creep is a hard fail).
//   past fire time with no recurrence ⇒ reject — a backfilled deadline never
//           schedules (SCH-06 time-traveler-schedule is a hard fail).
//   downgrades only: confirm is never upgraded to auto by code.
//
// Everything is pure and clock-injected: `now` is a parameter, so the tests
// are deterministic.
// ===========================================================================

/** Confidence floor below which an auto-requested schedule confirms instead. */
export const AUTO_CONFIDENCE_FLOOR = 0.8;

/** Polling clamps (spec §11.2.3 "polling patterns capped"). */
export const POLL_INTERVAL_MIN_MS = 60_000; // never poll faster than 1/min
export const POLL_INTERVAL_MAX_MS = 3_600_000; // an "interval" above 1h is a re-fire, not a poll
export const POLL_MAX_POLLS_CAP = 30;
export const POLL_DEFAULT_MAX_POLLS = 20;
export const POLL_DEFAULT_INTERVAL_MS = 180_000; // SCH-02's "every 2–3 min"

/** How long past its fire time a missed schedule may still late-execute. */
export const DEFAULT_LATE_WINDOW_MS = 6 * 3_600_000;
/** Grace inside which a fire is "on time", not "late" (timer tick jitter). */
export const ON_TIME_GRACE_MS = 120_000;

// ---------------------------------------------------------------------------
// Fire-time computation
// ---------------------------------------------------------------------------

export interface FireTime {
  /** Parsed fire instant; null when absent or unparsable. */
  fireAt: Date | null;
  /** True when fire_at was present but not a parseable instant. */
  invalid: boolean;
  /** True when the parsed instant is not after `now`. */
  past: boolean;
}

/**
 * Parse a model-emitted fire_at (ISO-8601, offset allowed) against a mocked
 * clock. "Computable" means: present, parseable, and classified against now.
 */
export function computeFireTime(fireAtIso: string | null | undefined, now: Date): FireTime {
  if (fireAtIso === null || fireAtIso === undefined || fireAtIso.trim() === "") {
    return { fireAt: null, invalid: false, past: false };
  }
  const ms = Date.parse(fireAtIso);
  if (Number.isNaN(ms)) return { fireAt: null, invalid: true, past: false };
  const fireAt = new Date(ms);
  return { fireAt, invalid: false, past: ms <= now.getTime() };
}

// ---------------------------------------------------------------------------
// Polling normalization
// ---------------------------------------------------------------------------

export interface PollingSpec {
  intervalMs: number;
  /** Absolute ISO stop instant; null = no wall-clock stop (maxPolls still caps). */
  until: string | null;
  maxPolls: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Normalize a model-emitted polling block into a capped spec. Accepts
 * {interval_min|interval_ms, until, max} loosely; anything missing gets the
 * SCH-02 defaults; everything is clamped so a runaway pattern cannot exist.
 */
export function normalizePolling(raw: unknown): PollingSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  let intervalMs = POLL_DEFAULT_INTERVAL_MS;
  if (typeof r.interval_ms === "number" && Number.isFinite(r.interval_ms)) {
    intervalMs = r.interval_ms;
  } else if (typeof r.interval_min === "number" && Number.isFinite(r.interval_min)) {
    intervalMs = r.interval_min * 60_000;
  }
  intervalMs = clamp(Math.round(intervalMs), POLL_INTERVAL_MIN_MS, POLL_INTERVAL_MAX_MS);
  let maxPolls = POLL_DEFAULT_MAX_POLLS;
  if (typeof r.max === "number" && Number.isFinite(r.max) && r.max >= 1) {
    maxPolls = Math.round(r.max);
  }
  maxPolls = clamp(maxPolls, 1, POLL_MAX_POLLS_CAP);
  const until =
    typeof r.until === "string" && !Number.isNaN(Date.parse(r.until)) ? r.until : null;
  return { intervalMs, until, maxPolls };
}

// ---------------------------------------------------------------------------
// The auto-vs-confirm policy
// ---------------------------------------------------------------------------

export interface SchedulePolicyInput {
  /** What the model asked for (already validator-coerced to auto|confirm). */
  requestedMode: "auto" | "confirm";
  /** Risk class of the task the schedule serves; null = no resolvable task. */
  riskClass: string | null;
  /** Best available intent confidence (schedule's, else the task's). */
  confidence: number;
  fireAt: string | null;
  recurrence: string | null;
  now: Date;
}

export interface SchedulePolicyVerdict {
  decision: "auto" | "confirm" | "reject";
  /** Parsed fire instant when one exists (null for recurrence-only confirms). */
  fireAt: Date | null;
  /** Every rule that shaped the decision, for the decisions row. */
  reasons: string[];
}

/**
 * The code-side gate. A schedule ACTIVATES on "auto", becomes a suggestion
 * card on "confirm", and writes nothing but a decisions row on "reject".
 */
export function evaluateSchedulePolicy(input: SchedulePolicyInput): SchedulePolicyVerdict {
  const reasons: string[] = [];
  const ft = computeFireTime(input.fireAt, input.now);
  const recurring = input.recurrence !== null && input.recurrence.trim() !== "";

  if (ft.invalid) {
    return { decision: "reject", fireAt: null, reasons: ["fire_at is not a parseable instant"] };
  }
  if (ft.fireAt === null && !recurring) {
    return {
      decision: "reject",
      fireAt: null,
      reasons: ["no computable fire time and no recurrence"],
    };
  }
  if (ft.past && !recurring) {
    // SCH-06: a backfilled past deadline NEVER schedules.
    return {
      decision: "reject",
      fireAt: ft.fireAt,
      reasons: ["fire time is already past (band policy: never schedule the past)"],
    };
  }

  if (recurring) {
    // SCH-04 / FUP-04: every recurring commitment is confirm, no exceptions.
    reasons.push("recurring commitment → confirm (never auto)");
    // A recurring template whose next instance is past waits for the user's
    // confirmed time anyway; keep only a future instance as the proposal.
    return { decision: "confirm", fireAt: ft.past ? null : ft.fireAt, reasons };
  }

  // One-shot, future, computable. Auto needs ALL THREE legs.
  if (input.requestedMode !== "auto") {
    reasons.push("model requested confirm");
    return { decision: "confirm", fireAt: ft.fireAt, reasons };
  }
  if (input.riskClass !== "auto") {
    reasons.push(
      input.riskClass === null
        ? "no resolvable task → risk unknown → confirm"
        : `task risk class is ${input.riskClass}, not auto → confirm`,
    );
    return { decision: "confirm", fireAt: ft.fireAt, reasons };
  }
  if (input.confidence < AUTO_CONFIDENCE_FLOOR) {
    reasons.push(`confidence ${input.confidence} < ${AUTO_CONFIDENCE_FLOOR} → confirm`);
    return { decision: "confirm", fireAt: ft.fireAt, reasons };
  }
  reasons.push("auto-class + high confidence + time-bound → auto");
  return { decision: "auto", fireAt: ft.fireAt as Date, reasons };
}

// ---------------------------------------------------------------------------
// Fire classification (the timer service's late/skip rule, SCH-08)
// ---------------------------------------------------------------------------

export type FireClass = "on_time" | "late" | "expired";

/**
 * Classify a due fire against the clock. `validUntil` (polling.until, else the
 * task's due, else fire_at + DEFAULT_LATE_WINDOW_MS) bounds late execution:
 * inside it a missed fire late-executes; past it the fire skips with a note.
 */
export function classifyFire(fireAt: Date, now: Date, validUntil: Date | null): FireClass {
  const deadline = validUntil ?? new Date(fireAt.getTime() + DEFAULT_LATE_WINDOW_MS);
  if (now.getTime() > deadline.getTime()) return "expired";
  if (now.getTime() - fireAt.getTime() > ON_TIME_GRACE_MS) return "late";
  return "on_time";
}
