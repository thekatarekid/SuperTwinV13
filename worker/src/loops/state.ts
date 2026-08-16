// ===========================================================================
// [CODE] The loop STATE FUNCTION — arch §11.4, §11.5.7. Build item 3.2.
//
// Zero model calls. Every value in this file is derived from four things:
// the end state (due / recurrence / resolving evidence / a user gesture),
// and the clock. Nothing here reads a model answer, and nothing here edits
// one — this is the ground truth the model output is reconciled against, not
// a filter applied to it (build rule 9).
//
// THE ONE SENTENCE THIS FILE IMPLEMENTS
//
//   Loop state is a function of the END STATE, never of the age of the
//   evidence. An insurance policy noticed a year ago whose next annual
//   occurrence is in the future is `open`. "I'll book the tickets tonight"
//   from 2024 is `lapsed`. The discriminator is the end state (§11.4.1).
//
// THE ONE AGE-SENSITIVE RULE THAT SURVIVES (§11.5.7)
//
//   An IMPLICIT loop with no due, no recurrence, never reinforced inside
//   REINFORCEMENT_WINDOW_DAYS defaults to `latent` — in the graph, out of the
//   task list, promotable the instant newer evidence reinforces it. Explicit
//   commitments and temporal-boundary loops are never aged this way.
//
// `possibly_done` DOES NOT EXIST (§11.4.3). It is not in `LOOP_STATES`, it is
// not returned, and `isLoopState("possibly_done")` is false. The prior system
// parked 27 tasks in that limbo. Evidence, or a one-tap question. Never a
// third bucket.
// ===========================================================================

// ---- the closed sets -------------------------------------------------------

/** §10.4 / the `loop_state` wire enum: op · lt · dn · lp · dr. */
export const LOOP_STATES = ["open", "latent", "done", "lapsed", "dropped"] as const;
export type LoopState = (typeof LOOP_STATES)[number];

const LOOP_STATE_SET: ReadonlySet<string> = new Set(LOOP_STATES);

export function isLoopState(value: unknown): value is LoopState {
  return typeof value === "string" && LOOP_STATE_SET.has(value);
}

/**
 * States the prior system had and this one refuses. Kept as a named constant
 * so the ban is testable rather than merely absent (§11.4.3).
 */
export const ABOLISHED_STATES: readonly string[] = ["possibly_done"];

/** `task = loop WHERE owner == me AND state ∈ {open, latent}` (§11.3). */
export const TASK_STATES: readonly LoopState[] = ["open", "latent"];

export function isTaskState(value: unknown): value is "open" | "latent" {
  return value === "open" || value === "latent";
}

/** The stored `horizon` enum — computed from `due − now`, never asked of a model. */
export const LOOP_HORIZONS = ["today", "week", "month", "quarter", "year", "none"] as const;
export type LoopHorizon = (typeof LOOP_HORIZONS)[number];

export type LoopStateReason =
  | "resolution_evidence"
  | "user_gesture_done"
  | "user_gesture_dropped"
  | "due_future"
  | "recurrence_next_future"
  | "recurrence_exhausted"
  | "recurrence_unparsed"
  | "past_due_no_recurrence"
  | "no_due_explicit"
  | "no_due_reinforced"
  | "no_due_stale"
  | "no_due_unknown_age"
  | "no_intent";

/** §11.5.7 — "older than ~30 days and never reinforced". */
export const REINFORCEMENT_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

// ---- clocks ----------------------------------------------------------------

export type NowLike = number | string | Date;

function toMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

function nowMs(now: NowLike): number {
  return toMs(now) ?? Date.now();
}

/** The DB's `%Y-%m-%dT%H:%M:%fZ` shape — exactly what `toISOString()` emits. */
function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---- recurrence ------------------------------------------------------------

/**
 * A parsed recurrence. Either a fixed number of DAYS or a number of MONTHS —
 * months are calendar arithmetic (31 Jan + 1 month is 28/29 Feb), days are not.
 */
export interface Recurrence {
  /** The verbatim string the model wrote. Never rewritten in the row. */
  raw: string;
  days?: number;
  months?: number;
}

const FIXED_RECURRENCES: Readonly<Record<string, Recurrence>> = {
  daily: { raw: "daily", days: 1 },
  everyday: { raw: "daily", days: 1 },
  weekly: { raw: "weekly", days: 7 },
  fortnightly: { raw: "fortnightly", days: 14 },
  biweekly: { raw: "fortnightly", days: 14 },
  monthly: { raw: "monthly", months: 1 },
  bimonthly: { raw: "bimonthly", months: 2 },
  quarterly: { raw: "quarterly", months: 3 },
  quarter: { raw: "quarterly", months: 3 },
  semiannual: { raw: "semiannual", months: 6 },
  semiannually: { raw: "semiannual", months: 6 },
  halfyearly: { raw: "semiannual", months: 6 },
  annual: { raw: "annual", months: 12 },
  annually: { raw: "annual", months: 12 },
  yearly: { raw: "annual", months: 12 },
};

const UNIT_MONTHS: Readonly<Record<string, number>> = { month: 1, quarter: 3, year: 12 };
const UNIT_DAYS: Readonly<Record<string, number>> = { day: 1, week: 7, fortnight: 14 };

/** Strings that positively mean "this does not repeat". */
const NON_RECURRENCES: ReadonlySet<string> = new Set(["", "none", "never", "once", "onetime", "onceoff", "nonrecurring", "no"]);

/**
 * Read a recurrence the model wrote. Returns `null` for "does not repeat" AND
 * for anything unparseable — the two are told apart by `NON_RECURRENCES`, and
 * the state function reports the difference in its reason, so an unrecognised
 * cadence is visible in an audit instead of silently becoming "annual".
 */
export function parseRecurrence(raw: unknown): Recurrence | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  const key = text.replace(/[\s._'-]/g, "");
  if (NON_RECURRENCES.has(key)) return null;
  const fixed = FIXED_RECURRENCES[key];
  if (fixed) return { ...fixed, raw: raw.trim() };

  // "every 2 weeks", "every other month", "every 18 months", "per year"
  const m = /^(?:every|each|per)?\s*(other|\d+)?\s*(day|week|fortnight|month|quarter|year)s?$/.exec(text);
  if (!m) return null;
  const countRaw = m[1];
  const count = countRaw === undefined ? 1 : countRaw === "other" ? 2 : Number.parseInt(countRaw, 10);
  if (!Number.isFinite(count) || count < 1) return null;
  const unit = m[2];
  if (unit in UNIT_MONTHS) return { raw: raw.trim(), months: count * UNIT_MONTHS[unit] };
  return { raw: raw.trim(), days: count * UNIT_DAYS[unit] };
}

export function isRecurring(raw: unknown): boolean {
  return parseRecurrence(raw) !== null;
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Calendar month arithmetic in UTC, with the day clamped to the target month. */
export function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const targetMonthAbs = month + months;
  const targetYear = year + Math.floor(targetMonthAbs / 12);
  const targetMonth = ((targetMonthAbs % 12) + 12) % 12;
  const clamped = Math.min(day, daysInUtcMonth(targetYear, targetMonth));
  return Date.UTC(
    targetYear,
    targetMonth,
    clamped,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** Guards a pathological cadence (a 1-day recurrence from 1970) from spinning. */
const MAX_PROJECTION_STEPS = 20_000;

export interface ProjectionInput {
  dueUtc?: string | null;
  recurrence?: string | null;
  /** An end date for the series, when one is known. Past it, nothing is left. */
  recurrenceEndsAt?: string | null;
}

/**
 * The first occurrence STRICTLY AFTER `now`, or `null` when there is none —
 * no due, no parseable recurrence, or the series ended. `null` is what makes a
 * past-due recurring loop `lapsed` rather than perpetually `open`.
 */
export function nextOccurrenceUtc(input: ProjectionInput, now: NowLike = Date.now()): string | null {
  const due = toMs(input.dueUtc);
  const rec = parseRecurrence(input.recurrence);
  if (due === null || rec === null) return null;
  const at = nowMs(now);
  const endsAt = toMs(input.recurrenceEndsAt);

  let cursor = due;
  if (rec.days !== undefined) {
    const period = rec.days * DAY_MS;
    if (cursor <= at) {
      const steps = Math.floor((at - cursor) / period) + 1;
      cursor += steps * period;
    }
    // The +1 above can land exactly on `now` only if periods divide evenly.
    while (cursor <= at) cursor += period;
  } else {
    const months = rec.months ?? 1;
    let steps = 0;
    while (cursor <= at) {
      steps += 1;
      if (steps > MAX_PROJECTION_STEPS) return null;
      cursor = addMonthsUtc(due, steps * months);
    }
  }

  if (endsAt !== null && cursor > endsAt) return null;
  return toIso(cursor);
}

// ---- horizon ---------------------------------------------------------------

/**
 * §11.4 — "horizon → computed from due − now". Never a model field. A due date
 * already in the past reads `today`: it is the most urgent thing there is, and
 * pretending otherwise is how a lapsed renewal goes unnoticed.
 */
export function loopHorizon(dueUtc: string | null | undefined, now: NowLike = Date.now()): LoopHorizon {
  const due = toMs(dueUtc);
  if (due === null) return "none";
  const days = (due - nowMs(now)) / DAY_MS;
  if (days <= 1) return "today";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 92) return "quarter";
  return "year";
}

// ---- the state function ----------------------------------------------------

export type UserGesture = "done" | "dropped";

export interface LoopStateInput extends ProjectionInput {
  /**
   * A real `events.id`. Its EXISTENCE is the whole rule — §11.4.5: because
   * newer data is processed first, most historical loops resolve against
   * evidence already in the DB with no model call at all.
   */
  resolutionEvidenceEventId?: string | null;
  /** A user tap. The only other way a loop reaches a terminal state. */
  userGesture?: UserGesture | null;
  /** explicit | implicit. Only implicit loops are ever aged out (§11.5.7). */
  origin?: string | null;
  /** A loop with no intent is not a loop. Absent intent never yields `open`. */
  intent?: string | null;
  /** `events.ts` of the stating event. NEVER `ingested_at`. */
  statedAt?: string | null;
  /** `events.ts` of the most recent reinforcing event, when there is one. */
  lastReinforcedAt?: string | null;
}

export interface LoopStateFacts {
  state: LoopState;
  stateReason: LoopStateReason;
  /** Written to `loops.next_occurrence_utc`. Null unless a series projects. */
  nextOccurrenceUtc: string | null;
  horizon: LoopHorizon;
  /** True when a due exists and has already passed. Audit, not a rule. */
  dueInPast: boolean;
  /** `state ∈ {open, latent}` — the state half of the Tasks view. */
  taskState: boolean;
}

function reinforcementRefMs(input: LoopStateInput): number | null {
  return toMs(input.lastReinforcedAt) ?? toMs(input.statedAt);
}

/**
 * §11.4, implemented in the doc's own order.
 *
 *   resolution evidence      → done
 *   user gesture             → done | dropped
 *   due in the FUTURE        → open       ← however old the evidence is
 *   due PAST + recurrence    → project: future → open · none left → lapsed
 *   due PAST, no recurrence  → lapsed     (history, not a task)
 *   no due, reinforced       → open
 *   no due, not reinforced   → latent     (implicit only — §11.5.7)
 *
 * Evidence is checked before the gesture because a resolved loop is resolved
 * whatever the user last tapped; a `dropped` gesture on a loop that has since
 * been resolved is stale, and the evidence is the fact.
 */
export function deriveLoopState(input: LoopStateInput, now: NowLike = Date.now()): LoopStateFacts {
  const at = nowMs(now);
  const due = toMs(input.dueUtc);
  const dueInPast = due !== null && due <= at;
  const next = nextOccurrenceUtc(input, at);
  const horizon = loopHorizon(next ?? input.dueUtc ?? null, at);
  const finish = (state: LoopState, stateReason: LoopStateReason): LoopStateFacts => ({
    state,
    stateReason,
    nextOccurrenceUtc: next,
    horizon,
    dueInPast,
    taskState: isTaskState(state),
  });

  const evidence = typeof input.resolutionEvidenceEventId === "string" && input.resolutionEvidenceEventId.trim() !== "";
  if (evidence) return finish("done", "resolution_evidence");
  if (input.userGesture === "done") return finish("done", "user_gesture_done");
  if (input.userGesture === "dropped") return finish("dropped", "user_gesture_dropped");

  // "Loops require intent AND an unresolved end state" (item 3.1). A BLANK
  // intent is a positive statement that there is none, and never yields a
  // task — it stays in the graph as latent rather than being deleted. A
  // missing field (null/undefined) is simply not supplied to this function,
  // which derives from the end state, not from the wording.
  if (typeof input.intent === "string" && input.intent.trim() === "") {
    return finish("latent", "no_intent");
  }

  if (due !== null && !dueInPast) return finish("open", "due_future");

  if (dueInPast) {
    const rec = parseRecurrence(input.recurrence);
    if (rec === null) {
      const stated = typeof input.recurrence === "string" ? input.recurrence.trim() : "";
      const key = stated.toLowerCase().replace(/[\s._'-]/g, "");
      const unparsed = stated !== "" && !NON_RECURRENCES.has(key);
      return finish("lapsed", unparsed ? "recurrence_unparsed" : "past_due_no_recurrence");
    }
    if (next !== null) return finish("open", "recurrence_next_future");
    return finish("lapsed", "recurrence_exhausted");
  }

  // No due at all. This is the only branch where the clock touches the answer,
  // and only for implicit loops (§11.5.7).
  if (input.origin === "explicit") return finish("open", "no_due_explicit");
  const ref = reinforcementRefMs(input);
  if (ref === null) return finish("latent", "no_due_unknown_age");
  const ageDays = (at - ref) / DAY_MS;
  if (ageDays <= REINFORCEMENT_WINDOW_DAYS) return finish("open", "no_due_reinforced");
  return finish("latent", "no_due_stale");
}

// ---- rows and recomputation ------------------------------------------------

/** A `loops` row as SQLite hands it back. Camel spellings accepted too. */
export interface LoopStateRow {
  due_utc?: string | null;
  dueUtc?: string | null;
  recurrence?: string | null;
  recurrence_ends_at?: string | null;
  recurrenceEndsAt?: string | null;
  resolution_evidence_event_id?: string | null;
  resolutionEvidenceEventId?: string | null;
  user_gesture?: UserGesture | null;
  userGesture?: UserGesture | null;
  origin?: string | null;
  intent?: string | null;
  stated_at?: string | null;
  statedAt?: string | null;
  last_reinforced_at?: string | null;
  lastReinforcedAt?: string | null;
}

export function loopStateInputFromRow(row: LoopStateRow): LoopStateInput {
  return {
    dueUtc: row.dueUtc ?? row.due_utc ?? null,
    recurrence: row.recurrence ?? null,
    recurrenceEndsAt: row.recurrenceEndsAt ?? row.recurrence_ends_at ?? null,
    resolutionEvidenceEventId: row.resolutionEvidenceEventId ?? row.resolution_evidence_event_id ?? null,
    userGesture: row.userGesture ?? row.user_gesture ?? null,
    origin: row.origin ?? null,
    intent: row.intent ?? null,
    statedAt: row.statedAt ?? row.stated_at ?? null,
    lastReinforcedAt: row.lastReinforcedAt ?? row.last_reinforced_at ?? null,
  };
}

/** §11.4 — "recomputed whenever due, recurrence or evidence changes". */
export function deriveLoopStateFromRow(row: LoopStateRow, now: NowLike = Date.now()): LoopStateFacts {
  return deriveLoopState(loopStateInputFromRow(row), now);
}

/**
 * The inputs whose change forces a recompute. The clock is deliberately NOT
 * one of them: passing time changes `open → lapsed` on its own, so callers
 * recompute on read as well as on write.
 */
export function loopStateInputsDiffer(a: LoopStateInput, b: LoopStateInput): boolean {
  return (
    (a.dueUtc ?? null) !== (b.dueUtc ?? null) ||
    (a.recurrence ?? null) !== (b.recurrence ?? null) ||
    (a.recurrenceEndsAt ?? null) !== (b.recurrenceEndsAt ?? null) ||
    (a.resolutionEvidenceEventId ?? null) !== (b.resolutionEvidenceEventId ?? null) ||
    (a.userGesture ?? null) !== (b.userGesture ?? null) ||
    (a.lastReinforcedAt ?? null) !== (b.lastReinforcedAt ?? null) ||
    (a.origin ?? null) !== (b.origin ?? null)
  );
}

// ---- the acceptance check, as code -----------------------------------------

export interface PastDueOpenViolation {
  index: number;
  id: string | null;
  dueUtc: string | null;
  recurrence: string | null;
  nextOccurrenceUtc: string | null;
}

/**
 * Item 3.2 acceptance: **zero loops born past-due as `open`**. A past due may
 * only read `open` through a projected FUTURE occurrence; anything else is a
 * violation and this returns it rather than asserting, so the caller can log
 * exactly which loop broke the rule.
 */
export function pastDueOpenViolations(
  loops: readonly (LoopStateRow & { id?: string | null })[],
  now: NowLike = Date.now(),
): PastDueOpenViolation[] {
  const out: PastDueOpenViolation[] = [];
  loops.forEach((row, index) => {
    const input = loopStateInputFromRow(row);
    const facts = deriveLoopState(input, now);
    if (facts.state !== "open" || !facts.dueInPast) return;
    if (facts.nextOccurrenceUtc !== null) return;
    out.push({
      index,
      id: row.id ?? null,
      dueUtc: input.dueUtc ?? null,
      recurrence: input.recurrence ?? null,
      nextOccurrenceUtc: facts.nextOccurrenceUtc,
    });
  });
  return out;
}
