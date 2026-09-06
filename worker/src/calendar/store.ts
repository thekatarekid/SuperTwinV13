// ===========================================================================
// The derived calendar's writers (V6 P1 S5.3; migration 0204_v6_calendar).
//
//   events   chat-derived ("dinner sat 8pm") → TENTATIVE; firm only when the
//            user or a booking confirms (CAL-01). The bar's own events are
//            confirmed at birth — the user said so.
//   rules    a recurring phrase → a PROPOSED rule + an open question. Nothing
//            fires until the user confirms (CAL-04, SCH-04). A rule never
//            expands into stored dates; occurrences are computed at view time.
//   dates    a person's birthday / anniversary / exam / flight; plan or wish.
//   plans    one row per (date, occurrence): opens a space at T − lead, snoozable
//            and learned (CAL-02). `runLeadTimeTick` is the job's one entry.
//
// Every write is a decisions row (convention 1.4) so "why?" can explain it.
// Clocks are injected everywhere: nothing here reads Date.now() on its own.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { circleOf } from "../entities/registry.js";
import {
  addDays,
  classifyAtProcessing,
  DEFAULT_TZ,
  describeRule,
  localDate,
  pad2,
  parseDay,
  parseRecurrence,
  resolvePhrase,
  type MessageClock,
  type ProcessingVerdict,
  type RecurrenceRule,
  type ResolvedInstant,
} from "./clocks.js";
import {
  calendarSettings,
  effectivePolicy,
  snoozeOptions,
  type CalendarSettings,
  type SnoozeChoice,
  type SnoozeOption,
} from "./lead-time.js";

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

function nowIso(now: Date): string {
  return now.toISOString();
}

export interface Evidence {
  event_ids: string[];
  quote: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventStatus = "tentative" | "confirmed" | "cancelled";
export type EventOrigin = "chat" | "bar" | "booking" | "user";

export interface CalendarEventRow {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  tz: string;
  all_day: number;
  status: EventStatus;
  origin: EventOrigin;
  phrase: string | null;
  message_ts: string | null;
  evidence_json: string | null;
  space_id: string | null;
  person_entity_id: string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface ChatEventInput {
  title: string;
  /** The words that carried the date ("dinner sat 8pm"). */
  phrase: string;
  /** MESSAGE time — when the phrase was said, and the zone it was said in. */
  message: MessageClock;
  evidence?: Evidence[];
  spaceId?: string | null;
  personEntityId?: string | null;
  createdBy?: string | null;
}

export interface ChatEventResult {
  event: CalendarEventRow;
  resolved: ResolvedInstant;
  /** PROCESSING time verdict — a past event is never surfaced as upcoming. */
  verdict: ProcessingVerdict;
}

/**
 * A chat-derived event: the phrase resolves at MESSAGE time, lands
 * TENTATIVE, and carries its verbatim words. Returns null when the phrase
 * names no date (the caller must not invent one).
 */
export function createChatEvent(input: ChatEventInput, processingNow: Date): ChatEventResult | null {
  const resolved = resolvePhrase(input.phrase, input.message);
  if (!resolved) return null;
  const verdict = classifyAtProcessing(resolved, processingNow);
  const id = mintId("cev");
  const db = getDb();
  db.prepare(
    `INSERT INTO calendar_events (id, title, starts_at, tz, all_day, status, origin, phrase, message_ts,
                                  evidence_json, space_id, person_entity_id, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, 'tentative', 'chat', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.title,
    resolved.iso,
    resolved.tz,
    resolved.time ? 0 : 1,
    input.phrase,
    resolved.anchor,
    input.evidence ? JSON.stringify(input.evidence) : null,
    input.spaceId ?? null,
    input.personEntityId ?? null,
    input.createdBy ?? "code:calendar",
    nowIso(processingNow),
  );
  writeDecision({
    pass: "code:calendar",
    targetKind: "calendar_event",
    targetId: id,
    action: "create",
    old: null,
    new: { status: "tentative", starts_at: resolved.iso, tz: resolved.tz, phrase: input.phrase, anchor: resolved.anchor },
    reason: `"${input.phrase}" resolved at message time (${resolved.how}); ${verdict.why}`,
  });
  return { event: getEvent(id)!, resolved, verdict };
}

export interface UserEventInput {
  title: string;
  /** Absolute instant. */
  startsAt: string;
  endsAt?: string | null;
  tz?: string;
  allDay?: boolean;
  spaceId?: string | null;
  personEntityId?: string | null;
}

/** An event the user typed into the bar or the calendar: confirmed at birth. */
export function createUserEvent(input: UserEventInput, now: Date): CalendarEventRow {
  const id = mintId("cev");
  const tz = input.tz ?? DEFAULT_TZ;
  getDb()
    .prepare(
      `INSERT INTO calendar_events (id, title, starts_at, ends_at, tz, all_day, status, origin, space_id, person_entity_id,
                                    confirmed_at, confirmed_by, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'user', ?, ?, ?, 'user', 'user', ?)`,
    )
    .run(id, input.title, input.startsAt, input.endsAt ?? null, tz, input.allDay ? 1 : 0, input.spaceId ?? null, input.personEntityId ?? null, nowIso(now), nowIso(now));
  writeDecision({ pass: "user", targetKind: "calendar_event", targetId: id, action: "create", old: null, new: { status: "confirmed", starts_at: input.startsAt } });
  return getEvent(id)!;
}

export function getEvent(id: string): CalendarEventRow | null {
  return (getDb().prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(id) as CalendarEventRow | undefined) ?? null;
}

/**
 * Firm up a tentative event — by the user, or by a booking that names it.
 * A booking may also correct the instant (the confirmation is the better
 * source than the chat phrase); the phrase stays on the row.
 */
export function confirmEvent(
  id: string,
  by: "user" | "booking",
  now: Date,
  opts: { startsAt?: string; endsAt?: string | null; evidence?: Evidence[] } = {},
): CalendarEventRow | null {
  const before = getEvent(id);
  if (!before) return null;
  const db = getDb();
  db.prepare(
    `UPDATE calendar_events
        SET status = 'confirmed', confirmed_at = ?, confirmed_by = ?,
            starts_at = COALESCE(?, starts_at), ends_at = COALESCE(?, ends_at),
            evidence_json = COALESCE(?, evidence_json), updated_at = ?
      WHERE id = ?`,
  ).run(nowIso(now), by, opts.startsAt ?? null, opts.endsAt ?? null, opts.evidence ? JSON.stringify(opts.evidence) : null, nowIso(now), id);
  writeDecision({
    pass: by === "user" ? "user" : "code:calendar",
    targetKind: "calendar_event",
    targetId: id,
    action: "confirm",
    old: { status: before.status, starts_at: before.starts_at },
    new: { status: "confirmed", starts_at: opts.startsAt ?? before.starts_at, confirmed_by: by },
    reason: by === "booking" ? "a booking confirmation names this event" : "confirmed by the user",
  });
  return getEvent(id);
}

export function cancelEvent(id: string, by: string, now: Date): CalendarEventRow | null {
  const before = getEvent(id);
  if (!before) return null;
  getDb().prepare(`UPDATE calendar_events SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(nowIso(now), id);
  writeDecision({ pass: by, targetKind: "calendar_event", targetId: id, action: "cancel", old: { status: before.status }, new: { status: "cancelled" } });
  return getEvent(id);
}

/**
 * Find the tentative event a booking confirmation is about: same title
 * words, same local day. Bookings never create confirmed rows out of thin
 * air here — the caller decides what to do when nothing matches.
 */
export function findTentativeMatch(title: string, day: string): CalendarEventRow | null {
  const tokens = title.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const rows = getDb()
    .prepare(`SELECT * FROM calendar_events WHERE status = 'tentative' ORDER BY starts_at`)
    .all() as CalendarEventRow[];
  for (const r of rows) {
    if (localDate(Date.parse(r.starts_at), r.tz) !== day) continue;
    const words = r.title.toLowerCase();
    if (tokens.length === 0 || tokens.some((t) => words.includes(t))) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rules — recurring phrases, ALWAYS a confirm suggestion
// ---------------------------------------------------------------------------

export type RuleStatus = "proposed" | "confirmed" | "dismissed";

export interface CalendarRuleRow {
  id: string;
  title: string;
  rule_json: string;
  phrase: string | null;
  message_ts: string | null;
  tz: string;
  status: RuleStatus;
  space_id: string | null;
  evidence_json: string | null;
  created_by: string | null;
  created_at: string;
  confirmed_at: string | null;
  updated_at: string | null;
}

export const RULE_QUESTION_KIND = "calendar_rule";

export interface ProposeRuleInput {
  title: string;
  phrase: string;
  message: MessageClock;
  evidence?: Evidence[];
  spaceId?: string | null;
  createdBy?: string | null;
}

export interface ProposeRuleResult {
  rule: CalendarRuleRow;
  parsed: RecurrenceRule;
  questionId: string;
}

export function ruleQuestionId(ruleId: string): string {
  return `q_${ruleId}`;
}

/**
 * A recurring phrase becomes a RULE (never dates) in `proposed` status plus
 * one open question — the confirm suggestion (CAL-04). Returns null when the
 * phrase is not recurring.
 */
export function proposeRule(input: ProposeRuleInput, now: Date): ProposeRuleResult | null {
  const parsed = parseRecurrence(input.phrase);
  if (!parsed) return null;
  const tz = input.message.tz ?? DEFAULT_TZ;
  const id = mintId("crl");
  const qid = ruleQuestionId(id);
  const db = getDb();
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO calendar_rules (id, title, rule_json, phrase, message_ts, tz, status, space_id, evidence_json, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      JSON.stringify(parsed),
      input.phrase,
      input.message.ts,
      tz,
      input.spaceId ?? null,
      input.evidence ? JSON.stringify(input.evidence) : null,
      input.createdBy ?? "code:calendar",
      nowIso(now),
    );
    db.prepare(
      `INSERT OR REPLACE INTO questions (id, kind, target_kind, target_id, question, options_json, status)
       VALUES (?, ?, 'calendar_rule', ?, ?, ?, 'open')`,
    ).run(
      qid,
      RULE_QUESTION_KIND,
      id,
      `Add "${input.title}" to the calendar ${describeRule(parsed)}?`,
      JSON.stringify([
        { id: "confirm", label: `Yes, ${describeRule(parsed)}` },
        { id: "edit", label: "Edit the schedule" },
        { id: "dismiss", label: "No" },
      ]),
    );
    writeDecision({
      pass: "code:calendar",
      targetKind: "calendar_rule",
      targetId: id,
      action: "propose",
      old: null,
      new: { status: "proposed", rule: parsed, questionId: qid },
      reason: `"${input.phrase}" is recurring → a rule, proposed for confirmation; nothing scheduled until the user says yes`,
    });
  });
  write();
  return { rule: getRule(id)!, parsed, questionId: qid };
}

export function getRule(id: string): CalendarRuleRow | null {
  return (getDb().prepare(`SELECT * FROM calendar_rules WHERE id = ?`).get(id) as CalendarRuleRow | undefined) ?? null;
}

export function parseRuleRow(row: CalendarRuleRow): RecurrenceRule {
  return JSON.parse(row.rule_json) as RecurrenceRule;
}

/** The user said yes (optionally with an edited rule). */
export function confirmRule(id: string, now: Date, edited?: RecurrenceRule): CalendarRuleRow | null {
  const before = getRule(id);
  if (!before) return null;
  const db = getDb();
  const write = db.transaction(() => {
    db.prepare(
      `UPDATE calendar_rules SET status = 'confirmed', confirmed_at = ?, rule_json = COALESCE(?, rule_json), updated_at = ? WHERE id = ?`,
    ).run(nowIso(now), edited ? JSON.stringify(edited) : null, nowIso(now), id);
    db.prepare(`UPDATE questions SET status = 'answered', answer_json = ?, answered_at = ? WHERE id = ?`).run(
      JSON.stringify({ id: edited ? "edit" : "confirm" }),
      nowIso(now),
      ruleQuestionId(id),
    );
    writeDecision({ pass: "user", targetKind: "calendar_rule", targetId: id, action: "confirm", old: { status: before.status }, new: { status: "confirmed", rule: edited ?? parseRuleRow(before) } });
  });
  write();
  return getRule(id);
}

export function dismissRule(id: string, now: Date): CalendarRuleRow | null {
  const before = getRule(id);
  if (!before) return null;
  const db = getDb();
  const write = db.transaction(() => {
    db.prepare(`UPDATE calendar_rules SET status = 'dismissed', updated_at = ? WHERE id = ?`).run(nowIso(now), id);
    db.prepare(`UPDATE questions SET status = 'answered', answer_json = ?, answered_at = ? WHERE id = ?`).run(JSON.stringify({ id: "dismiss" }), nowIso(now), ruleQuestionId(id));
    writeDecision({ pass: "user", targetKind: "calendar_rule", targetId: id, action: "dismiss", old: { status: before.status }, new: { status: "dismissed" } });
  });
  write();
  return getRule(id);
}

// ---------------------------------------------------------------------------
// People's dates
// ---------------------------------------------------------------------------

export type DateKind = "birthday" | "anniversary" | "exam" | "flight" | "other";

export interface PersonDateRow {
  id: string;
  person_entity_id: string;
  kind: DateKind;
  label: string | null;
  month: number;
  day: number;
  year: number | null;
  mode: string | null;
  lead_days: number | null;
  evidence_json: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface PersonDateInput {
  personEntityId: string;
  kind: DateKind;
  label?: string | null;
  month: number;
  day: number;
  /** Omit for a yearly date (birthday, anniversary). */
  year?: number | null;
  /** Explicit per-person override; NULL = the circle's default. */
  mode?: "plan" | "wish" | null;
  leadDays?: number | null;
  evidence?: Evidence[];
  createdBy?: string | null;
}

/** One row per (person, kind, month, day, year) — a repeat is an update. */
export function upsertPersonDate(input: PersonDateInput, now: Date): PersonDateRow {
  if (input.month < 1 || input.month > 12 || input.day < 1 || input.day > 31) {
    throw new Error(`upsertPersonDate: ${input.month}/${input.day} is not a calendar date`);
  }
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM person_dates WHERE person_entity_id = ? AND kind = ? AND month = ? AND day = ? AND COALESCE(year, 0) = COALESCE(?, 0)`,
    )
    .get(input.personEntityId, input.kind, input.month, input.day, input.year ?? null) as PersonDateRow | undefined;
  if (existing) {
    db.prepare(
      `UPDATE person_dates SET label = COALESCE(?, label), mode = COALESCE(?, mode), lead_days = COALESCE(?, lead_days),
                               evidence_json = COALESCE(?, evidence_json), updated_at = ? WHERE id = ?`,
    ).run(input.label ?? null, input.mode ?? null, input.leadDays ?? null, input.evidence ? JSON.stringify(input.evidence) : null, nowIso(now), existing.id);
    return getPersonDate(existing.id)!;
  }
  const id = mintId("pdt");
  db.prepare(
    `INSERT INTO person_dates (id, person_entity_id, kind, label, month, day, year, mode, lead_days, evidence_json, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.personEntityId,
    input.kind,
    input.label ?? null,
    input.month,
    input.day,
    input.year ?? null,
    input.mode ?? null,
    input.leadDays ?? null,
    input.evidence ? JSON.stringify(input.evidence) : null,
    input.createdBy ?? "code:calendar",
    nowIso(now),
  );
  writeDecision({
    pass: input.createdBy ?? "code:calendar",
    targetKind: "person_date",
    targetId: id,
    action: "create",
    old: null,
    new: { person: input.personEntityId, kind: input.kind, month: input.month, day: input.day, year: input.year ?? null },
  });
  return getPersonDate(id)!;
}

export function getPersonDate(id: string): PersonDateRow | null {
  return (getDb().prepare(`SELECT * FROM person_dates WHERE id = ?`).get(id) as PersonDateRow | undefined) ?? null;
}

/** Set a person date's own mode / lead time (the user's edit, or a learned snooze). */
export function setPersonDatePolicy(id: string, patch: { mode?: "plan" | "wish" | null; leadDays?: number | null }, by: string, now: Date): PersonDateRow | null {
  const before = getPersonDate(id);
  if (!before) return null;
  getDb()
    .prepare(`UPDATE person_dates SET mode = ?, lead_days = ?, updated_at = ? WHERE id = ?`)
    .run(patch.mode === undefined ? before.mode : patch.mode, patch.leadDays === undefined ? before.lead_days : patch.leadDays, nowIso(now), id);
  writeDecision({
    pass: by,
    targetKind: "person_date",
    targetId: id,
    action: "set_policy",
    old: { mode: before.mode, lead_days: before.lead_days },
    new: { mode: patch.mode === undefined ? before.mode : patch.mode, lead_days: patch.leadDays === undefined ? before.lead_days : patch.leadDays },
  });
  return getPersonDate(id);
}

/**
 * The next occurrence (yyyy-mm-dd) of a person date on/after `fromDay`. A
 * dated row (year set) occurs once; a yearly row rolls forward. Feb 29 clamps
 * to Feb 28 in a non-leap year.
 */
export function nextOccurrence(row: { month: number; day: number; year: number | null }, fromDay: string): string | null {
  const from = parseDay(fromDay);
  if (!from) return null;
  const clampDay = (y: number): string => {
    const last = new Date(Date.UTC(y, row.month, 0)).getUTCDate();
    return `${y}-${pad2(row.month)}-${pad2(Math.min(row.day, last))}`;
  };
  if (row.year !== null) {
    const d = clampDay(row.year);
    return d >= fromDay ? d : null;
  }
  const thisYear = clampDay(from.year);
  return thisYear >= fromDay ? thisYear : clampDay(from.year + 1);
}

// ---------------------------------------------------------------------------
// Plans — T minus lead time, snoozable, learned
// ---------------------------------------------------------------------------

export type PlanStatus = "pending" | "opened" | "snoozed" | "stopped" | "done";

export interface CalendarPlanRow {
  id: string;
  person_date_id: string;
  occurrence: string;
  lead_days: number;
  opens_at: string;
  status: PlanStatus;
  snoozed_until: string | null;
  snooze_choice: string | null;
  space_id: string | null;
  opened_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export function getPlan(id: string): CalendarPlanRow | null {
  return (getDb().prepare(`SELECT * FROM calendar_plans WHERE id = ?`).get(id) as CalendarPlanRow | undefined) ?? null;
}

export function plansFor(personDateId: string): CalendarPlanRow[] {
  return getDb().prepare(`SELECT * FROM calendar_plans WHERE person_date_id = ? ORDER BY occurrence`).all(personDateId) as CalendarPlanRow[];
}

/** How far ahead the planner materialises plan rows for yearly dates. */
export const PLAN_HORIZON_DAYS = 400;

export interface PlanTickReport {
  /** Plan rows created this tick (dates that had none for their next occurrence). */
  planned: number;
  /** Spaces opened this tick. */
  opened: Array<{ planId: string; spaceId: string; personDateId: string; occurrence: string; snooze: SnoozeOption[] }>;
  /** Plans past their date closed as done. */
  finished: number;
  /** Dates skipped because their policy is wish. */
  wishOnly: number;
}

interface DateWithCircle extends PersonDateRow {
  circle: string | null;
  person_name: string | null;
}

function datesWithCircle(): DateWithCircle[] {
  return getDb()
    .prepare(
      `SELECT d.*, e.circle AS circle, e.canonical AS person_name
         FROM person_dates d JOIN entities e ON e.id = d.person_entity_id
        WHERE e.merged_into IS NULL`,
    )
    .all() as DateWithCircle[];
}

/**
 * Materialise the pending plan for every plan-mode date whose next occurrence
 * is inside the horizon. Idempotent: (date, occurrence) is unique, so a second
 * tick writes nothing.
 */
export function ensurePlans(today: string, settings: CalendarSettings = calendarSettings()): { planned: number; wishOnly: number } {
  const db = getDb();
  let planned = 0;
  let wishOnly = 0;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO calendar_plans (id, person_date_id, occurrence, lead_days, opens_at, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
  );
  for (const d of datesWithCircle()) {
    const policy = effectivePolicy(d, d.circle, settings);
    if (policy.mode !== "plan") {
      wishOnly += 1;
      continue;
    }
    const occurrence = nextOccurrence(d, today);
    if (!occurrence) continue;
    const horizon = addDays(today, PLAN_HORIZON_DAYS);
    if (occurrence > horizon) continue;
    const exists = db.prepare(`SELECT id FROM calendar_plans WHERE person_date_id = ? AND occurrence = ?`).get(d.id, occurrence);
    if (exists) continue;
    const opensAt = addDays(occurrence, -policy.leadDays);
    const r = ins.run(mintId("cpl"), d.id, occurrence, policy.leadDays, opensAt);
    if (r.changes > 0) planned += 1;
  }
  return { planned, wishOnly };
}

function personLabel(d: DateWithCircle): string {
  const who = d.person_name ?? "someone";
  const what = d.label ?? (d.kind === "other" ? "date" : d.kind);
  return `${who}'s ${what}`;
}

/** Open the planning space for one plan (the nudge's payload). */
function openPlan(plan: CalendarPlanRow, d: DateWithCircle, now: Date): { spaceId: string; snooze: SnoozeOption[] } {
  const db = getDb();
  const spaceId = mintId("sp");
  const label = `${personLabel(d)} on ${plan.occurrence}`;
  const today = localDate(now.getTime(), DEFAULT_TZ);
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO spaces (id, label, life_area, goal, status, horizon, permanence, cadence, created_by, updated_at)
       VALUES (?, ?, 'People', ?, 'active', 'short', 'ephemeral', 'one-time', 'code:calendar', ?)`,
    ).run(spaceId, label, `Plan for ${personLabel(d)} (${plan.occurrence})`, nowIso(now));
    db.prepare(`UPDATE calendar_plans SET status = 'opened', space_id = ?, opened_at = ?, updated_at = ? WHERE id = ?`).run(spaceId, nowIso(now), nowIso(now), plan.id);
    writeDecision({
      pass: "code:calendar",
      targetKind: "space",
      targetId: spaceId,
      action: "create",
      old: null,
      new: { label, planId: plan.id, personDateId: d.id, occurrence: plan.occurrence },
      reason: `${personLabel(d)} is on ${plan.occurrence}; lead time ${plan.lead_days} days → opens ${plan.opens_at} (today ${today})`,
    });
  });
  write();
  return { spaceId, snooze: snoozeOptions(today, plan.occurrence) };
}

/**
 * The lead-time tick: materialise plans, open the ones whose day has come
 * (pending with opens_at ≤ today, or snoozed with snoozed_until ≤ today),
 * finish the ones whose date has passed. A lookup, never a call.
 */
export function runLeadTimeTick(now: Date, settings: CalendarSettings = calendarSettings()): PlanTickReport {
  const db = getDb();
  const today = localDate(now.getTime(), DEFAULT_TZ);
  const { planned, wishOnly } = ensurePlans(today, settings);
  const report: PlanTickReport = { planned, opened: [], finished: 0, wishOnly };

  const dates = new Map(datesWithCircle().map((d) => [d.id, d]));
  const due = db
    .prepare(
      `SELECT * FROM calendar_plans
        WHERE (status = 'pending' AND opens_at <= ?) OR (status = 'snoozed' AND snoozed_until <= ?)
        ORDER BY opens_at, id`,
    )
    .all(today, today) as CalendarPlanRow[];
  for (const plan of due) {
    if (plan.occurrence < today) continue; // finished below
    const d = dates.get(plan.person_date_id);
    if (!d) continue;
    const { spaceId, snooze } = openPlan(plan, d, now);
    report.opened.push({ planId: plan.id, spaceId, personDateId: d.id, occurrence: plan.occurrence, snooze });
  }

  const r = db
    .prepare(`UPDATE calendar_plans SET status = 'done', updated_at = ? WHERE status IN ('pending','opened','snoozed') AND occurrence < ?`)
    .run(nowIso(now), today);
  report.finished = r.changes;
  return report;
}

export interface SnoozeResult {
  plan: CalendarPlanRow;
  option: SnoozeOption;
  /** The lead time now learned on the person's date. */
  learnedLeadDays: number;
}

/**
 * Snooze an opened plan: it re-opens on the option's day, and the choice is
 * LEARNED — the person's date now carries that lead time, so next year's plan
 * opens there without asking (CAL-02). The space stays; it goes dormant.
 */
export function snoozePlan(planId: string, choice: SnoozeChoice, now: Date): SnoozeResult | null {
  const plan = getPlan(planId);
  if (!plan) return null;
  const today = localDate(now.getTime(), DEFAULT_TZ);
  const option = snoozeOptions(plan.opened_at ? localDate(Date.parse(plan.opened_at), DEFAULT_TZ) : today, plan.occurrence).find((o) => o.id === choice);
  if (!option) return null;
  const db = getDb();
  const write = db.transaction(() => {
    db.prepare(`UPDATE calendar_plans SET status = 'snoozed', snoozed_until = ?, snooze_choice = ?, updated_at = ? WHERE id = ?`).run(option.until, choice, nowIso(now), planId);
    if (plan.space_id) db.prepare(`UPDATE spaces SET status = 'dormant', updated_at = ? WHERE id = ? AND status = 'active'`).run(nowIso(now), plan.space_id);
    writeDecision({
      pass: "user",
      targetKind: "calendar_plan",
      targetId: planId,
      action: "snooze",
      old: { status: plan.status, opens_at: plan.opens_at },
      new: { status: "snoozed", snoozed_until: option.until, choice },
      reason: `snoozed "${option.label}" → re-opens ${option.until}`,
    });
    // Learned: the person's date carries this lead time from now on.
    setPersonDatePolicy(plan.person_date_id, { leadDays: option.leadDays }, "user:snooze", now);
  });
  write();
  return { plan: getPlan(planId)!, option, learnedLeadDays: option.leadDays };
}

/** "Don't plan this one" — stop the plan; the date stays, mode unchanged. */
export function stopPlan(planId: string, now: Date): CalendarPlanRow | null {
  const plan = getPlan(planId);
  if (!plan) return null;
  const db = getDb();
  db.prepare(`UPDATE calendar_plans SET status = 'stopped', updated_at = ? WHERE id = ?`).run(nowIso(now), planId);
  if (plan.space_id) db.prepare(`UPDATE spaces SET status = 'dormant', updated_at = ? WHERE id = ? AND status = 'active'`).run(nowIso(now), plan.space_id);
  writeDecision({ pass: "user", targetKind: "calendar_plan", targetId: planId, action: "stop", old: { status: plan.status }, new: { status: "stopped" } });
  return getPlan(planId);
}

/** The circle a person date falls under (for the why-panel and the layers). */
export function circleForDate(row: PersonDateRow): string | null {
  return circleOf(row.person_entity_id);
}
