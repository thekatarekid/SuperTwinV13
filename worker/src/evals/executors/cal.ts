// ===========================================================================
// [CODE] CAL — the derived calendar (GoldenEvals V6 P1 CAL-01..05; S5.3), and
// the deterministic layer under TIM-01..04 (the three clocks).
//
// Zero model calls. Every case drives the REAL calendar code (calendar/
// clocks.ts → store.ts → layers.ts) on the sandboxed DB with the clock pinned,
// then reads the rows back:
//
//   CAL-01  "dinner sat 8pm" → TENTATIVE at 2026-08-29 20:00 IST (message-time
//           anchor); a booking confirmation firms it. `firm-on-chat` = a
//           confirmed row before anyone confirmed.
//   CAL-02  Ma (family, 14 days) · Sep 20 → the plan opens Sep 6, not Sep 5;
//           snooze options next week / 10 days before / 3 days before; the
//           choice is LEARNED — next year opens at T − 10.
//   CAL-03  a March "book by tomorrow" read in August → 2026-03-15, past,
//           closure-checked, never on the upcoming layer.
//   CAL-04  "rent every 1st" → a monthly RULE, `proposed`, one open question;
//           no calendar_events rows; occurrences only after the user confirms.
//   CAL-05  four layers rendered alone and together: disjoint, union equal,
//           tentative marked.
//
//   TIM-01..04 (`timCode`) — the pure clocks: message-time resolution, render
//           at view time, the backfilled Friday, the PDT flight. The `time`
//           executor runs this layer first; a red here never spends a call.
//
// Every case removes its own rows afterwards.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import {
  calendarView,
  classifyAtProcessing,
  confirmEvent,
  confirmRule,
  createChatEvent,
  createUserEvent,
  ensurePlans,
  findTentativeMatch,
  instantInZone,
  localDate,
  localTime,
  nextOccurrences,
  parseRuleRow,
  plansFor,
  proposeRule,
  renderInstant,
  renderRelative,
  resolvePhrase,
  runLeadTimeTick,
  setCalendarSettings,
  shiftInZone,
  snoozePlan,
  upsertPersonDate,
  CALENDAR_SETTINGS_KEY,
  RULE_QUESTION_KIND,
  type CalendarSettings,
  type Layer,
  type SnoozeChoice,
} from "../../calendar/index.js";
import { appStateDelete, appStateGet, appStateSet } from "../../db/ingest.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";
import { FIXTURE_NOW, fixtureNow } from "./clock.js";

const IST = "Asia/Kolkata";

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}
function count(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as { n: number }).n;
}

/** Runs rows written during a case — must stay 0 (the ledger is the truth). */
function runsWritten(before: number): number {
  return count(`SELECT COUNT(*) AS n FROM runs`) - before;
}

// ---- The case world --------------------------------------------------------

class CalWorld {
  readonly entities: string[] = [];
  readonly tasks: string[] = [];
  readonly spaces: string[] = [];
  private settingsBefore: string | null;
  readonly startedAt = new Date(Date.now() - 1_000).toISOString();
  constructor(readonly caseId: string) {
    this.settingsBefore = appStateGet(CALENDAR_SETTINGS_KEY);
  }

  person(id: string, name: string, circle: string | null): string {
    const eid = `${id}_${this.caseId.toLowerCase().replace("-", "")}`;
    getDb()
      .prepare(`INSERT INTO entities (id, type, canonical, provisional, circle, first_seen_at, last_seen_at) VALUES (?, 'person', ?, 0, ?, ?, ?)`)
      .run(eid, name, circle, FIXTURE_NOW.toISOString(), FIXTURE_NOW.toISOString());
    this.entities.push(eid);
    return eid;
  }

  task(t: Record<string, unknown>): string {
    const tid = `${str(t.id, "tsk")}_${this.caseId.toLowerCase().replace("-", "")}`;
    const schedule = t.schedule ? JSON.stringify(t.schedule) : null;
    getDb()
      .prepare(
        `INSERT INTO tasks (id, title, type, owner, due, status, schedule_json, created_by)
         VALUES (?, ?, 'explicit', ?, ?, ?, ?, 'eval')`,
      )
      .run(tid, str(t.title, "task"), str(t.owner, "self"), typeof t.due === "string" ? t.due : null, str(t.status, "open"), schedule);
    this.tasks.push(tid);
    return tid;
  }

  settings(patch: Record<string, unknown>): CalendarSettings {
    const cleaned: Record<string, { mode?: "plan" | "wish"; leadDays?: number }> = {};
    for (const [circle, v] of Object.entries(patch)) {
      const o = rec(v);
      cleaned[circle] = {
        ...(o.mode === "plan" || o.mode === "wish" ? { mode: o.mode } : {}),
        ...(typeof o.leadDays === "number" ? { leadDays: o.leadDays } : {}),
      };
    }
    return setCalendarSettings(cleaned);
  }

  /** Remove every row this case wrote, in dependency order. */
  cleanup(): void {
    const db = getDb();
    // Plans/dates cascade from entities; events/rules are found by our marks.
    for (const e of this.entities) {
      db.prepare(`DELETE FROM calendar_plans WHERE person_date_id IN (SELECT id FROM person_dates WHERE person_entity_id = ?)`).run(e);
      db.prepare(`DELETE FROM person_dates WHERE person_entity_id = ?`).run(e);
      db.prepare(`DELETE FROM calendar_events WHERE person_entity_id = ?`).run(e);
    }
    db.prepare(`DELETE FROM calendar_events WHERE created_by IN ('code:calendar', 'user') AND id IN (SELECT id FROM calendar_events WHERE created_at >= ?)`).run(this.startedAt);
    db.prepare(`DELETE FROM questions WHERE kind = ? AND target_id IN (SELECT id FROM calendar_rules WHERE created_at >= ?)`).run(RULE_QUESTION_KIND, this.startedAt);
    db.prepare(`DELETE FROM calendar_rules WHERE created_at >= ?`).run(this.startedAt);
    for (const t of this.tasks) db.prepare(`DELETE FROM tasks WHERE id = ?`).run(t);
    db.prepare(`DELETE FROM spaces WHERE created_by = 'code:calendar' AND created_at >= ?`).run(this.startedAt);
    for (const s of this.spaces) db.prepare(`DELETE FROM spaces WHERE id = ?`).run(s);
    for (const e of this.entities) db.prepare(`DELETE FROM entities WHERE id = ?`).run(e);
    db.prepare(`DELETE FROM decisions WHERE target_kind IN ('calendar_event','calendar_rule','person_date','calendar_plan') AND created_at >= ?`).run(this.startedAt);
    if (this.settingsBefore === null) appStateDelete(CALENDAR_SETTINGS_KEY);
    else appStateSet(CALENDAR_SETTINGS_KEY, this.settingsBefore);
  }

}

// ---- CAL-01 ----------------------------------------------------------------

function cal01(fixture: Fixture): ExecutorResult {
  const setup = rec(fixture.setup);
  const message = rec(setup.message);
  const violations: Violation[] = [];
  const runsBefore = count(`SELECT COUNT(*) AS n FROM runs`);

  const made = createChatEvent(
    { title: str(setup.title, "Dinner"), phrase: str(setup.phrase, "dinner sat 8pm"), message: { ts: str(message.ts), tz: str(message.tz, IST) }, evidence: [{ event_ids: [], quote: str(setup.phrase) }] },
    fixtureNow(),
  );
  if (!made) {
    return { ok: false, output: { error: "phrase did not resolve" }, violations: [{ label: "date-drift", note: "no date resolved" }], metrics: { model_calls: 0 } };
  }
  const afterChat = { ...made.event };
  const localDay = localDate(Date.parse(afterChat.starts_at), afterChat.tz);
  const expected = rec(rec(fixture.expected).after_chat);
  if (afterChat.status !== "tentative") violations.push({ label: "firm-on-chat", note: `status ${afterChat.status} at birth` });
  if (afterChat.starts_at !== str(expected.starts_at)) violations.push({ label: "date-drift", note: `starts_at ${afterChat.starts_at}, expected ${str(expected.starts_at)}` });
  if (localDay === localDate(FIXTURE_NOW.getTime(), IST) && localDay !== str(expected.local_day)) violations.push({ label: "date-drift", note: "resolved onto the processing day" });

  // The upcoming layer shows it — marked tentative.
  const view = calendarView({ from: localDay, to: localDay, layers: ["my_events"], viewNow: fixtureNow(), tz: IST });
  const shown = view.items.find((i) => i.refId === afterChat.id);
  if (!shown || shown.status !== "tentative") violations.push({ label: "firm-on-chat", note: "the layer did not render the event as tentative" });

  // A booking confirmation names it.
  const booking = rec(setup.booking);
  const match = findTentativeMatch(str(setup.title, "Dinner"), localDay);
  const confirmed = match ? confirmEvent(match.id, "booking", new Date(str(booking.ts, FIXTURE_NOW.toISOString())), { evidence: [{ event_ids: [], quote: str(booking.text) }] }) : null;
  if (!confirmed || confirmed.status !== "confirmed" || confirmed.confirmed_by !== "booking") {
    violations.push({ label: "firm-on-chat", note: "the booking did not firm the tentative event" });
  }
  if (confirmed && confirmed.phrase !== str(setup.phrase)) violations.push({ label: "date-drift", note: "the original phrase was lost on confirm" });

  return {
    ok: violations.length === 0,
    output: {
      after_chat: { status: afterChat.status, starts_at: afterChat.starts_at, local_day: localDay, local_time: localTime(Date.parse(afterChat.starts_at), afterChat.tz), tz: afterChat.tz, phrase: afterChat.phrase, anchor: afterChat.message_ts, how: made.resolved.how },
      layer_status: shown?.status ?? null,
      after_booking: confirmed ? { status: confirmed.status, confirmed_by: confirmed.confirmed_by, starts_at: confirmed.starts_at, phrase: confirmed.phrase } : null,
      processing_verdict: made.verdict,
    },
    violations,
    metrics: { model_calls: runsWritten(runsBefore), events: 1 },
  };
}

// ---- CAL-02 ----------------------------------------------------------------

function cal02(fixture: Fixture, world: CalWorld): ExecutorResult {
  const setup = rec(fixture.setup);
  const violations: Violation[] = [];
  const runsBefore = count(`SELECT COUNT(*) AS n FROM runs`);
  const person = rec(setup.person);
  const date = rec(setup.date);
  const ticks = Array.isArray(setup.ticks) ? setup.ticks.map((t) => new Date(str(t))) : [new Date("2026-09-05T03:30:00.000Z"), new Date("2026-09-06T03:30:00.000Z")];

  const settings = world.settings(rec(setup.settings));
  const ma = world.person(str(person.id, "ent_ma"), str(person.name, "Ma"), str(person.circle, "family"));
  // A wish-only control: a friend with the same birthday must never open a space.
  const friend = world.person("ent_friend", "Kabir", "friends");
  const row = upsertPersonDate({ personEntityId: ma, kind: "birthday", month: num(date.month, 9), day: num(date.day, 20) }, fixtureNow());
  upsertPersonDate({ personEntityId: friend, kind: "birthday", month: num(date.month, 9), day: num(date.day, 20) }, fixtureNow());

  const first = runLeadTimeTick(ticks[0]!, settings);
  const openedEarly = first.opened.filter((o) => o.personDateId === row.id);
  if (openedEarly.length > 0) violations.push({ label: "early-open", note: `opened on ${localDate(ticks[0]!.getTime(), IST)}` });
  const plan0 = plansFor(row.id)[0];

  const second = runLeadTimeTick(ticks[1]!, settings);
  const opened = second.opened.find((o) => o.personDateId === row.id);
  if (!opened) violations.push({ label: "early-open", note: "did not open on the lead-time day (opens_at reached, no space)" });
  const friendOpened = [...first.opened, ...second.opened].some((o) => o.personDateId !== row.id);
  if (friendOpened) violations.push({ label: "wish-planned", note: "a wish-only circle opened a space" });
  const spaceStatus = opened ? (getDb().prepare(`SELECT status FROM spaces WHERE id = ?`).get(opened.spaceId) as { status: string } | undefined)?.status ?? null : null;

  // Snooze, learned.
  const choice = str(setup.snooze, "10_days_before") as SnoozeChoice;
  const snoozed = opened ? snoozePlan(opened.planId, choice, ticks[1]!) : null;
  const learned = (getDb().prepare(`SELECT lead_days FROM person_dates WHERE id = ?`).get(row.id) as { lead_days: number | null }).lead_days;
  if (!snoozed || learned !== snoozed.option.leadDays) violations.push({ label: "snooze-not-learned", note: `person_dates.lead_days = ${learned}` });

  // Next year: plan from the day after this occurrence.
  const nextYearFrom = "2026-09-21";
  ensurePlans(nextYearFrom, settings);
  const plans = plansFor(row.id);
  const nextYear = plans.find((p) => p.occurrence.startsWith("2027"));
  const expectedNext = rec(rec(fixture.expected).next_year);
  if (!nextYear || nextYear.opens_at !== str(expectedNext.opens_at)) {
    violations.push({ label: "snooze-not-learned", note: `next year's plan opens ${nextYear?.opens_at ?? "never"}` });
  }

  return {
    ok: violations.length === 0,
    output: {
      plan: plan0 ? { occurrence: plan0.occurrence, lead_days: plan0.lead_days, opens_at: plan0.opens_at } : null,
      opened_on_sep_5: openedEarly.length > 0,
      opened_on_sep_6: Boolean(opened),
      space_status_on_open: spaceStatus,
      snooze_options: opened?.snooze.map((o) => ({ id: o.id, until: o.until, lead_days: o.leadDays })) ?? [],
      after_snooze: snoozed ? { status: snoozed.plan.status, snoozed_until: snoozed.plan.snoozed_until, learned_lead_days: snoozed.learnedLeadDays } : null,
      next_year: nextYear ? { occurrence: nextYear.occurrence, opens_at: nextYear.opens_at, lead_days: nextYear.lead_days } : null,
      wish_only_dates_skipped: first.wishOnly,
    },
    violations,
    metrics: { model_calls: runsWritten(runsBefore), plans: plans.length },
  };
}

// ---- CAL-03 ----------------------------------------------------------------

function cal03(fixture: Fixture): ExecutorResult {
  const setup = rec(fixture.setup);
  const message = rec(setup.message);
  const violations: Violation[] = [];
  const runsBefore = count(`SELECT COUNT(*) AS n FROM runs`);
  const expected = rec(fixture.expected);

  const made = createChatEvent({ title: str(setup.title, "Book"), phrase: str(setup.phrase, "book by tomorrow"), message: { ts: str(message.ts), tz: str(message.tz, IST) } }, fixtureNow());
  if (!made) return { ok: false, output: { error: "no date" }, violations: [{ label: "date-drift" }], metrics: { model_calls: 0 } };
  const today = localDate(FIXTURE_NOW.getTime(), IST);
  if (made.resolved.date !== str(expected.resolved_date)) violations.push({ label: "date-drift", note: `resolved ${made.resolved.date}` });
  if (made.resolved.date === today || made.verdict.disposition === "due") violations.push({ label: "due-today", note: made.verdict.why });

  // The upcoming layer (today .. +30d) must not carry it.
  const view = calendarView({ from: today, to: "2026-09-30", layers: ["my_events"], viewNow: fixtureNow(), tz: IST });
  const upcoming = view.items.some((i) => i.refId === made.event.id);
  if (upcoming) violations.push({ label: "due-today", note: "the March event is on the upcoming layer" });

  return {
    ok: violations.length === 0,
    output: {
      resolved_date: made.resolved.date,
      anchor: made.resolved.anchor,
      how: made.resolved.how,
      relation: made.verdict.relation,
      disposition: made.verdict.disposition,
      offset_days: made.verdict.offsetDays,
      due_today: made.resolved.date === today,
      event_status: made.event.status,
      upcoming_layer_contains_it: upcoming,
      processing_day: today,
    },
    violations,
    metrics: { model_calls: runsWritten(runsBefore) },
  };
}

// ---- CAL-04 ----------------------------------------------------------------

function cal04(fixture: Fixture): ExecutorResult {
  const setup = rec(fixture.setup);
  const message = rec(setup.message);
  const violations: Violation[] = [];
  const runsBefore = count(`SELECT COUNT(*) AS n FROM runs`);
  const eventsBefore = count(`SELECT COUNT(*) AS n FROM calendar_events`);

  const proposed = proposeRule({ title: str(setup.title, "Rent"), phrase: str(setup.phrase, "rent every 1st"), message: { ts: str(message.ts), tz: str(message.tz, IST) } }, fixtureNow());
  if (!proposed) return { ok: false, output: { error: "not recurring" }, violations: [{ label: "auto-confirmed", note: "phrase not read as recurring" }], metrics: { model_calls: 0 } };
  const rule = proposed.rule;
  if (rule.status !== "proposed") violations.push({ label: "auto-confirmed", note: `status ${rule.status} at birth` });
  const q = getDb().prepare(`SELECT kind, status FROM questions WHERE id = ?`).get(proposed.questionId) as { kind: string; status: string } | undefined;
  if (!q || q.status !== "open" || q.kind !== RULE_QUESTION_KIND) violations.push({ label: "auto-confirmed", note: "no open confirm question" });
  const eventsFromRule = count(`SELECT COUNT(*) AS n FROM calendar_events`) - eventsBefore;
  if (eventsFromRule > 0) violations.push({ label: "expanded-to-dates", note: `${eventsFromRule} calendar_events rows` });

  const before = calendarView({ from: "2026-08-29", to: "2026-10-31", layers: ["my_events"], viewNow: fixtureNow(), tz: IST }).items.filter((i) => i.refId === rule.id);
  if (before.length > 0) violations.push({ label: "auto-confirmed", note: "occurrences rendered before the user confirmed" });

  // Only the user confirms.
  const confirmed = confirmRule(rule.id, fixtureNow());
  const after = calendarView({ from: "2026-08-29", to: "2026-10-31", layers: ["my_events"], viewNow: fixtureNow(), tz: IST }).items.filter((i) => i.refId === rule.id);
  const next = nextOccurrences(parseRuleRow(confirmed!), "2026-08-29", 2);
  const expectedNext = Array.isArray(rec(fixture.expected).next_occurrences_after_confirm) ? (rec(fixture.expected).next_occurrences_after_confirm as string[]) : [];
  if (JSON.stringify(next) !== JSON.stringify(expectedNext)) violations.push({ label: "expanded-to-dates", note: `occurrences ${next.join(", ")}` });
  const eventsAfter = count(`SELECT COUNT(*) AS n FROM calendar_events`) - eventsBefore;
  if (eventsAfter > 0) violations.push({ label: "expanded-to-dates", note: "confirming wrote date rows" });

  return {
    ok: violations.length === 0,
    output: {
      rule: proposed.parsed,
      status_at_birth: rule.status,
      question: q ? { open: q.status === "open", kind: q.kind } : null,
      calendar_events_from_rule: eventsFromRule,
      occurrences_visible_before_confirm: before.length,
      occurrences_visible_after_confirm: after.map((i) => i.day),
      next_occurrences_after_confirm: next,
      status_after_confirm: confirmed?.status ?? null,
    },
    violations,
    metrics: { model_calls: runsWritten(runsBefore), auto_schedule_policy_violation: rule.status === "proposed" ? 0 : 1 },
  };
}

// ---- CAL-05 ----------------------------------------------------------------

function cal05(fixture: Fixture, world: CalWorld): ExecutorResult {
  const setup = rec(fixture.setup);
  const range = rec(setup.range);
  const from = str(range.from, "2026-08-30");
  const to = str(range.to, "2026-09-21");
  const viewNow = new Date(str(setup.view_now, FIXTURE_NOW.toISOString()));
  const violations: Violation[] = [];
  const runsBefore = count(`SELECT COUNT(*) AS n FROM runs`);

  for (const t of list(setup.tasks)) world.task(t);
  const person = rec(setup.person);
  const ma = world.person(str(person.id, "ent_ma"), str(person.name, "Ma"), str(person.circle, "family"));
  const pd = rec(person.date);
  upsertPersonDate({ personEntityId: ma, kind: "birthday", month: num(pd.month, 9), day: num(pd.day, 20) }, viewNow);
  for (const ev of list(setup.events)) {
    if (typeof ev.phrase === "string") {
      createChatEvent({ title: str(ev.title), phrase: ev.phrase, message: { ts: str(ev.message_ts), tz: IST } }, viewNow);
    } else {
      createUserEvent({ title: str(ev.title), startsAt: str(ev.starts_at), tz: IST }, viewNow);
    }
  }

  const alone: Record<Layer, string[]> = { my_events: [], my_tasks: [], twin_tasks: [], people: [] };
  const seen = new Map<string, Layer[]>();
  for (const layer of ["my_events", "my_tasks", "twin_tasks", "people"] as const) {
    const v = calendarView({ from, to, layers: [layer], viewNow, tz: IST });
    alone[layer] = v.items.map((i) => i.title).sort();
    for (const i of v.items) {
      if (i.layer !== layer) violations.push({ label: "layer-bleed", note: `${i.title} rendered in ${layer} tagged ${i.layer}` });
      const key = `${i.kind}:${i.refId}`;
      seen.set(key, [...(seen.get(key) ?? []), layer]);
    }
  }
  for (const [key, layers] of seen) if (layers.length > 1) violations.push({ label: "layer-bleed", note: `${key} in ${layers.join(" + ")}` });

  const together = calendarView({ from, to, viewNow, tz: IST });
  const unionCount = Object.values(alone).reduce((n, a) => n + a.length, 0);
  if (together.items.length !== unionCount) violations.push({ label: "layer-bleed", note: `together ${together.items.length} ≠ union ${unionCount}` });

  const expected = rec(fixture.expected);
  for (const layer of ["my_tasks", "twin_tasks", "my_events", "people"] as const) {
    const want = (Array.isArray(expected[`${layer}_alone`]) ? (expected[`${layer}_alone`] as string[]) : []).slice().sort();
    if (JSON.stringify(want) !== JSON.stringify(alone[layer])) violations.push({ label: "layer-bleed", note: `${layer}: ${alone[layer].join(" | ")}` });
  }
  const tentative = together.items.filter((i) => i.kind === "event" && i.phrase !== null);
  if (tentative.some((i) => i.status !== "tentative")) violations.push({ label: "tentative-unmarked", note: "a chat-derived event lost its tentative status" });

  return {
    ok: violations.length === 0,
    output: {
      my_tasks_alone: alone.my_tasks,
      twin_tasks_alone: alone.twin_tasks,
      my_events_alone: alone.my_events,
      people_alone: alone.people,
      no_item_in_two_layers: [...seen.values()].every((l) => l.length === 1),
      together_equals_union: together.items.length === unionCount,
      together_counts: together.counts,
      tentative_marked: tentative.length > 0 && tentative.every((i) => i.status === "tentative"),
      relatives: together.items.map((i) => ({ title: i.title, layer: i.layer, day: i.day, relative: i.relative, status: i.status })),
    },
    violations,
    metrics: { model_calls: runsWritten(runsBefore), items: together.items.length },
  };
}

// ---- TIM (deterministic layer) --------------------------------------------

/**
 * The pure clocks under TIM-01..04. Returns null for ids this layer does not
 * cover. Zero model calls.
 */
export function timCode(fixtureId: string): ExecutorResult | null {
  const violations: Violation[] = [];
  switch (fixtureId) {
    case "TIM-01": {
      // Tue 2026-08-25 21:40 IST = 16:10Z; "day after" → Thu 27 Aug.
      const r = resolvePhrase("pay maintenance by day after", { ts: "2026-08-25T16:10:00.000Z", tz: IST });
      if (!r || r.date !== "2026-08-27") violations.push({ label: "processing-time-anchor", note: `resolved ${r?.date ?? "nothing"}` });
      if (r && r.phrase !== "pay maintenance by day after") violations.push({ label: "processing-time-anchor", note: "phrase not kept" });
      return { ok: violations.length === 0, output: { resolved: r, anchor_shown: r?.anchor, how: r?.how }, violations, metrics: { model_calls: 0 } };
    }
    case "TIM-02": {
      const stored = "2026-08-27";
      const a = renderRelative(stored, new Date("2026-08-26T04:30:00.000Z"), IST);
      const b = renderRelative(stored, new Date("2026-08-28T04:30:00.000Z"), IST);
      if (a !== "tomorrow" || b !== "1 day overdue") violations.push({ label: "stale-relative", note: `${a} / ${b}` });
      return { ok: violations.length === 0, output: { stored_value: stored, render_08_26: a, render_08_28: b, stored_value_after: stored }, violations, metrics: { model_calls: 0, renders: 2 } };
    }
    case "TIM-03": {
      // Tue 2026-05-12 10:00 IST; "by friday" → Fri 15 May; read in August → past.
      const r = resolvePhrase("send the deck by friday", { ts: "2026-05-12T04:30:00.000Z", tz: IST });
      const v = r ? classifyAtProcessing(r, fixtureNow()) : null;
      if (!r || r.date !== "2026-05-15") violations.push({ label: "date-drift", note: `resolved ${r?.date ?? "nothing"}` });
      if (!v || v.disposition !== "closure_check") violations.push({ label: "date-drift", note: `disposition ${v?.disposition ?? "none"}` });
      return { ok: violations.length === 0, output: { resolved: r, verdict: v }, violations, metrics: { model_calls: 0 } };
    }
    case "TIM-04": {
      // "departs SFO 11:30 PDT" on 2026-09-02 → 18:30Z; check-in T−48h on the flight's clock; rendered IST with PDT noted.
      const dep = instantInZone({ year: 2026, month: 9, day: 2, hour: 11, minute: 30 }, "America/Los_Angeles");
      const checkin = shiftInZone(dep.iso, dep.tz, -48);
      const rendered = renderInstant(dep.iso, IST, dep.tz);
      if (dep.iso !== "2026-09-02T18:30:00.000Z") violations.push({ label: "tz-blindness", note: `stored ${dep.iso}` });
      if (checkin !== "2026-08-31T18:30:00.000Z") violations.push({ label: "tz-blindness", note: `check-in ${checkin}` });
      if (!/IST/.test(rendered) || !/PDT/.test(rendered)) violations.push({ label: "tz-blindness", note: `rendered "${rendered}"` });
      return { ok: violations.length === 0, output: { stored_utc: dep.iso, source_tz: dep.tz, checkin_opens_utc: checkin, rendered_for_user: rendered }, violations, metrics: { model_calls: 0, schedule_math_ok: violations.length === 0 ? 1 : 0 } };
    }
    default:
      return null;
  }
}

// ---- Dispatch --------------------------------------------------------------

export const calendarExecutor: Executor = async (ctx) => {
  const { fixture } = ctx;
  const world = new CalWorld(fixture.id);
  try {
    switch (fixture.id) {
      case "CAL-01":
        return cal01(fixture);
      case "CAL-02":
        return cal02(fixture, world);
      case "CAL-03":
        return cal03(fixture);
      case "CAL-04":
        return cal04(fixture);
      case "CAL-05":
        return cal05(fixture, world);
      default: {
        const tim = timCode(fixture.id);
        if (tim) return tim;
        return { ok: false, output: { error: `no calendar case for ${fixture.id}` }, violations: [], metrics: { model_calls: 0 } };
      }
    }
  } finally {
    world.cleanup();
  }
};
