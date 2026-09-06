// ===========================================================================
// The derived calendar's store + layers (V6 P1 S5.3) on a temp DB — zero
// model calls. Migration 0204 applied; events tentative → confirmed (CAL-01);
// rules proposed → confirmed by the user only (CAL-04); dates, plans, the
// lead-time tick, snooze learned (CAL-02); the four layers separable (CAL-05);
// Settings › Calendar per circle.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { decisionsFor } from "../db/decisions.js";
import { createEntity, setCircle } from "../entities/registry.js";
import {
  calendarSettings,
  calendarView,
  cancelEvent,
  confirmEvent,
  confirmRule,
  createChatEvent,
  createUserEvent,
  DEFAULT_CIRCLE_POLICY,
  dismissRule,
  effectivePolicy,
  ensurePlans,
  findTentativeMatch,
  layerView,
  nextOccurrence,
  plansFor,
  proposeRule,
  ruleQuestionId,
  runLeadTimeTick,
  setCalendarSettings,
  setPersonDatePolicy,
  snoozeOptions,
  snoozePlan,
  startCalendarJob,
  stopPlan,
  upsertPersonDate,
} from "./index.js";

const IST = "Asia/Kolkata";
const NOW = new Date("2026-08-29T03:30:00.000Z");
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-calendar-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function n(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as { n: number }).n;
}

describe("migration 0204_v6_calendar", () => {
  it("creates the four tables after 0203 and is idempotent", () => {
    const ids = (getDb().prepare(`SELECT id FROM schema_migrations ORDER BY rowid`).all() as { id: string }[]).map((r) => r.id);
    expect(ids.indexOf("0204_v6_calendar")).toBe(ids.indexOf("0203_v6_space_card") + 1);
    for (const t of ["calendar_events", "calendar_rules", "person_dates", "calendar_plans"]) {
      expect(n(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`, t)).toBe(1);
    }
    runMigrations();
    expect(ids.filter((i) => i === "0204_v6_calendar")).toHaveLength(1);
  });
});

describe("events — tentative until confirmed (CAL-01)", () => {
  it("a chat phrase lands tentative at the message-time instant, with its words and anchor", () => {
    const made = createChatEvent({ title: "Dinner with Rohan", phrase: "dinner sat 8pm", message: { ts: "2026-08-27T13:30:00.000Z", tz: IST } }, NOW)!;
    expect(made.event).toMatchObject({ status: "tentative", origin: "chat", starts_at: "2026-08-29T14:30:00.000Z", tz: IST, phrase: "dinner sat 8pm", message_ts: "2026-08-27T13:30:00.000Z", all_day: 0 });
    expect(made.verdict.disposition).toBe("due");
    expect(decisionsFor("calendar_event", made.event.id).map((d) => d.action)).toEqual(["create"]);
  });
  it("a booking firms it (confirmed_by booking); the phrase stays; a user cancel is recorded", () => {
    const made = createChatEvent({ title: "Dinner with Rohan", phrase: "dinner sat 8pm", message: { ts: "2026-08-27T13:30:00.000Z", tz: IST } }, NOW)!;
    const match = findTentativeMatch("Table for 4 — dinner", "2026-08-29");
    expect(match?.id).toBe(made.event.id);
    const firm = confirmEvent(made.event.id, "booking", NOW)!;
    expect(firm).toMatchObject({ status: "confirmed", confirmed_by: "booking", phrase: "dinner sat 8pm" });
    expect(findTentativeMatch("dinner", "2026-08-29")).toBeNull();
    expect(cancelEvent(made.event.id, "user", NOW)!.status).toBe("cancelled");
    expect(decisionsFor("calendar_event", made.event.id).map((d) => d.action).sort()).toEqual(["cancel", "confirm", "create"]);
  });
  it("what the user types is confirmed at birth; a phrase with no date makes nothing", () => {
    const ev = createUserEvent({ title: "Dentist", startsAt: "2026-09-04T05:00:00.000Z", tz: IST }, NOW);
    expect(ev).toMatchObject({ status: "confirmed", origin: "user", confirmed_by: "user" });
    expect(createChatEvent({ title: "x", phrase: "send the photos", message: { ts: NOW.toISOString(), tz: IST } }, NOW)).toBeNull();
    expect(n(`SELECT COUNT(*) AS n FROM calendar_events`)).toBe(1);
  });
});

describe("rules — always a confirm suggestion (CAL-04)", () => {
  it("a recurring phrase becomes a proposed rule + one open question; no dates are written", () => {
    const p = proposeRule({ title: "Rent", phrase: "rent every 1st", message: { ts: "2026-08-28T04:30:00.000Z", tz: IST } }, NOW)!;
    expect(p.rule.status).toBe("proposed");
    expect(p.parsed).toMatchObject({ freq: "monthly", byMonthDay: 1 });
    const q = getDb().prepare(`SELECT * FROM questions WHERE id = ?`).get(ruleQuestionId(p.rule.id)) as { kind: string; status: string; question: string; options_json: string };
    expect(q).toMatchObject({ kind: "calendar_rule", status: "open" });
    expect(q.question).toContain("every month on the 1st");
    expect(JSON.parse(q.options_json).map((o: { id: string }) => o.id)).toEqual(["confirm", "edit", "dismiss"]);
    expect(n(`SELECT COUNT(*) AS n FROM calendar_events`)).toBe(0);
    // Not on the layer until confirmed …
    expect(calendarView({ from: "2026-08-29", to: "2026-10-31", viewNow: NOW, tz: IST }).items).toHaveLength(0);
    // … unless asked for explicitly, and then marked proposed.
    const shown = calendarView({ from: "2026-08-29", to: "2026-10-31", viewNow: NOW, tz: IST, includeProposedRules: true }).items;
    expect(shown.map((i) => [i.day, i.status])).toEqual([["2026-09-01", "proposed"], ["2026-10-01", "proposed"]]);
  });
  it("the user confirms (optionally edited) or dismisses; the question is answered either way", () => {
    const p = proposeRule({ title: "Rent", phrase: "rent every 1st", message: { ts: "2026-08-28T04:30:00.000Z", tz: IST } }, NOW)!;
    const c = confirmRule(p.rule.id, NOW)!;
    expect(c.status).toBe("confirmed");
    expect((getDb().prepare(`SELECT status FROM questions WHERE id = ?`).get(ruleQuestionId(p.rule.id)) as { status: string }).status).toBe("answered");
    const view = calendarView({ from: "2026-08-29", to: "2026-10-31", viewNow: NOW, tz: IST });
    expect(view.items.map((i) => [i.kind, i.day, i.relative])).toEqual([
      ["rule_occurrence", "2026-09-01", "in 3 days"],
      ["rule_occurrence", "2026-10-01", "in 33 days"],
    ]);
    expect(n(`SELECT COUNT(*) AS n FROM calendar_events`)).toBe(0);

    const p2 = proposeRule({ title: "Standup", phrase: "standup every friday 9am", message: { ts: "2026-08-28T04:30:00.000Z", tz: IST } }, NOW)!;
    expect(dismissRule(p2.rule.id, NOW)!.status).toBe("dismissed");
    expect(proposeRule({ title: "x", phrase: "dinner sat 8pm", message: { ts: NOW.toISOString(), tz: IST } }, NOW)).toBeNull();
  });
});

describe("Settings › Calendar", () => {
  it("defaults per §11.8.4; overrides clamp and persist; unknown circles ignored", () => {
    expect(calendarSettings()).toEqual(DEFAULT_CIRCLE_POLICY);
    const s = setCalendarSettings({ friends: { mode: "plan", leadDays: 3 }, family: { leadDays: 900 }, martians: { mode: "plan" } });
    expect(s.friends).toEqual({ mode: "plan", leadDays: 3 });
    expect(s.family).toEqual({ mode: "plan", leadDays: 365 });
    expect(calendarSettings().friends.leadDays).toBe(3);
    expect(effectivePolicy({ mode: null, lead_days: null }, "coworkers")).toEqual({ mode: "wish", leadDays: 0 });
    expect(effectivePolicy({ mode: null, lead_days: 10 }, "family")).toEqual({ mode: "plan", leadDays: 10 });
    expect(effectivePolicy({ mode: "wish", lead_days: null }, "partner").mode).toBe("wish");
    expect(effectivePolicy({ mode: null, lead_days: null }, null)).toEqual({ mode: "wish", leadDays: 0 });
  });
});

describe("dates and lead-time plans (CAL-02)", () => {
  function ma(): string {
    const e = createEntity({ type: "person", canonical: "Ma" });
    setCircle(e.id, "family");
    return e.id;
  }

  it("nextOccurrence rolls yearly dates forward and clamps Feb 29", () => {
    expect(nextOccurrence({ month: 9, day: 20, year: null }, "2026-08-29")).toBe("2026-09-20");
    expect(nextOccurrence({ month: 9, day: 20, year: null }, "2026-09-21")).toBe("2027-09-20");
    expect(nextOccurrence({ month: 2, day: 29, year: null }, "2027-01-01")).toBe("2027-02-28");
    expect(nextOccurrence({ month: 12, day: 18, year: 2026 }, "2027-01-01")).toBeNull();
  });

  it("upsert is one row per (person, kind, date); a repeat updates", () => {
    const id = ma();
    const a = upsertPersonDate({ personEntityId: id, kind: "birthday", month: 9, day: 20 }, NOW);
    const b = upsertPersonDate({ personEntityId: id, kind: "birthday", month: 9, day: 20, label: "Ma's birthday" }, NOW);
    expect(b.id).toBe(a.id);
    expect(b.label).toBe("Ma's birthday");
    expect(n(`SELECT COUNT(*) AS n FROM person_dates`)).toBe(1);
    expect(() => upsertPersonDate({ personEntityId: id, kind: "other", month: 13, day: 1 }, NOW)).toThrow(/not a calendar date/);
  });

  it("family 14 days: the plan opens Sep 6 — not Sep 5 — as an active space; wish-only circles never open", () => {
    const id = ma();
    const friend = createEntity({ type: "person", canonical: "Kabir" });
    setCircle(friend.id, "friends");
    const d = upsertPersonDate({ personEntityId: id, kind: "birthday", month: 9, day: 20 }, NOW);
    upsertPersonDate({ personEntityId: friend.id, kind: "birthday", month: 9, day: 20 }, NOW);

    const t0 = runLeadTimeTick(NOW);
    expect(t0).toMatchObject({ planned: 1, opened: [], finished: 0, wishOnly: 1 });
    expect(plansFor(d.id)[0]).toMatchObject({ occurrence: "2026-09-20", lead_days: 14, opens_at: "2026-09-06", status: "pending" });

    expect(runLeadTimeTick(new Date("2026-09-05T03:30:00.000Z")).opened).toEqual([]);
    const t2 = runLeadTimeTick(new Date("2026-09-06T03:30:00.000Z"));
    expect(t2.opened).toHaveLength(1);
    const sp = getDb().prepare(`SELECT * FROM spaces WHERE id = ?`).get(t2.opened[0]!.spaceId) as { status: string; label: string; created_by: string; life_area: string };
    expect(sp).toMatchObject({ status: "active", created_by: "code:calendar", life_area: "People" });
    expect(sp.label).toBe("Ma's birthday on 2026-09-20");
    expect(t2.opened[0]!.snooze.map((o) => [o.id, o.until, o.leadDays])).toEqual([
      ["next_week", "2026-09-13", 7],
      ["10_days_before", "2026-09-10", 10],
      ["3_days_before", "2026-09-17", 3],
    ]);
    // idempotent: a second tick the same day opens nothing more
    expect(runLeadTimeTick(new Date("2026-09-06T05:30:00.000Z")).opened).toEqual([]);
    expect(n(`SELECT COUNT(*) AS n FROM spaces`)).toBe(1);
  });

  it("a snooze re-opens on the chosen day, is LEARNED on the person's date, and next year's plan uses it", () => {
    const id = ma();
    const d = upsertPersonDate({ personEntityId: id, kind: "birthday", month: 9, day: 20 }, NOW);
    const opened = runLeadTimeTick(new Date("2026-09-06T03:30:00.000Z")).opened[0]!;
    const s = snoozePlan(opened.planId, "10_days_before", new Date("2026-09-06T03:30:00.000Z"))!;
    expect(s.plan).toMatchObject({ status: "snoozed", snoozed_until: "2026-09-10", snooze_choice: "10_days_before" });
    expect(s.learnedLeadDays).toBe(10);
    expect((getDb().prepare(`SELECT lead_days FROM person_dates WHERE id = ?`).get(d.id) as { lead_days: number }).lead_days).toBe(10);
    expect((getDb().prepare(`SELECT status FROM spaces WHERE id = ?`).get(opened.spaceId) as { status: string }).status).toBe("dormant");
    // not yet
    expect(runLeadTimeTick(new Date("2026-09-09T03:30:00.000Z")).opened).toEqual([]);
    // re-opens on the 10th
    expect(runLeadTimeTick(new Date("2026-09-10T03:30:00.000Z")).opened).toHaveLength(1);
    // next year: T − 10
    ensurePlans("2026-09-21");
    expect(plansFor(d.id).map((p) => [p.occurrence, p.opens_at, p.lead_days])).toEqual([
      ["2026-09-20", "2026-09-06", 14],
      ["2027-09-20", "2027-09-10", 10],
    ]);
    // past the date: finished
    expect(runLeadTimeTick(new Date("2026-09-21T03:30:00.000Z")).finished).toBe(1);
    expect(decisionsFor("calendar_plan", opened.planId).map((x) => x.action)).toEqual(["snooze"]);
  });

  it("stop, explicit per-person policy, and snooze options never land on the date", () => {
    const id = ma();
    const d = upsertPersonDate({ personEntityId: id, kind: "exam", label: "CAT exam", month: 11, day: 29, year: 2026 }, NOW);
    setPersonDatePolicy(d.id, { mode: "wish" }, "user", NOW);
    expect(runLeadTimeTick(NOW).wishOnly).toBe(1);
    setPersonDatePolicy(d.id, { mode: "plan", leadDays: 30 }, "user", NOW);
    runLeadTimeTick(NOW);
    expect(plansFor(d.id)[0]).toMatchObject({ opens_at: "2026-10-30", lead_days: 30 });
    const opened = runLeadTimeTick(new Date("2026-10-30T03:30:00.000Z")).opened[0]!;
    expect(stopPlan(opened.planId, NOW)!.status).toBe("stopped");
    expect(snoozeOptions("2026-09-18", "2026-09-20")).toEqual([]);
    // opened on the 10th: "10 days before" IS today (dropped); "next week" and "3 days before" both land on the 17th → one option
    expect(snoozeOptions("2026-09-10", "2026-09-20").map((o) => [o.id, o.until, o.leadDays])).toEqual([["next_week", "2026-09-17", 3]]);
    expect(snoozeOptions("2026-09-06", "2026-09-20").map((o) => o.id)).toEqual(["next_week", "10_days_before", "3_days_before"]);
  });

  it("the job runs a tick on demand and stops cleanly", () => {
    const id = ma();
    upsertPersonDate({ personEntityId: id, kind: "birthday", month: 9, day: 20 }, NOW);
    const lines: string[] = [];
    const job = startCalendarJob({ log: (l) => lines.push(l), clock: () => NOW, bootDelayMs: 60_000, intervalMs: 60_000 });
    expect(job.runNow().planned).toBe(1);
    expect(lines[0]).toContain("[calendar] planned=1");
    job.stop();
  });
});

describe("layers separable (CAL-05)", () => {
  it("my tasks · twin's tasks · my events · people render apart, together they are the union", () => {
    const db = getDb();
    const rohan = createEntity({ type: "person", canonical: "Rohan" });
    const mother = createEntity({ type: "person", canonical: "Ma" });
    setCircle(mother.id, "family");
    db.prepare(`INSERT INTO tasks (id, title, owner, due, status) VALUES ('t_mine', 'Pay the maintenance', 'self', '2026-09-02', 'open')`).run();
    db.prepare(`INSERT INTO tasks (id, title, owner, status, schedule_json) VALUES ('t_twin', 'Web check-in', 'self', 'scheduled', '{"mode":"auto","fire_at":"2026-09-03T01:30:00.000Z"}')`).run();
    db.prepare(`INSERT INTO tasks (id, title, owner, owner_entity_id, due, status) VALUES ('t_rohan', 'Rohan pays the advance', 'contact:rohan', ?, '2026-09-04', 'open')`).run(rohan.id);
    db.prepare(`INSERT INTO tasks (id, title, owner, due, status) VALUES ('t_done', 'Already done', 'self', '2026-09-02', 'done')`).run();
    createUserEvent({ title: "Dinner with Rohan", startsAt: "2026-09-01T14:30:00.000Z", tz: IST }, NOW);
    createChatEvent({ title: "Movie with Sameer", phrase: "movie fri 9pm", message: { ts: "2026-08-30T10:00:00.000Z", tz: IST } }, NOW);
    upsertPersonDate({ personEntityId: mother.id, kind: "birthday", month: 9, day: 20 }, NOW);

    const opts = { from: "2026-08-30", to: "2026-09-21", viewNow: NOW, tz: IST };
    expect(layerView("my_tasks", opts).items.map((i) => i.title)).toEqual(["Pay the maintenance"]);
    expect(layerView("twin_tasks", opts).items.map((i) => [i.title, i.status, i.relative])).toEqual([["Web check-in", "scheduled", "in 5 days"]]);
    expect(layerView("my_events", opts).items.map((i) => [i.title, i.status])).toEqual([
      ["Dinner with Rohan", "confirmed"],
      ["Movie with Sameer", "tentative"],
    ]);
    expect(layerView("people", opts).items.map((i) => [i.kind, i.title, i.personName])).toEqual([
      ["their_task", "Rohan pays the advance", "Rohan"],
      ["person_date", "Ma's birthday", "Ma"],
    ]);
    const all = calendarView(opts);
    expect(all.counts).toEqual({ my_events: 2, my_tasks: 1, twin_tasks: 1, people: 2 });
    expect(all.items).toHaveLength(6);
    expect(new Set(all.items.map((i) => `${i.kind}:${i.refId}`)).size).toBe(6);
    // ordered by day; the relative label is computed from viewNow
    expect(all.items.map((i) => i.day)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-04", "2026-09-20"]);
    expect(all.items[0]!.relative).toBe("in 3 days");
    expect(all.items[0]!.rendered).toBe("2026-09-01 20:00 IST");
    // firm-only view hides the tentative movie
    expect(calendarView({ ...opts, includeTentative: false, layers: ["my_events"] }).items.map((i) => i.title)).toEqual(["Dinner with Rohan"]);
    // the people layer explains the date's policy
    const date = all.items.find((i) => i.kind === "person_date")!;
    expect(date.detail).toMatchObject({ circle: "family", mode: "plan", lead_days: 14, learned: false });
  });

  it("a different viewer zone re-days the same instant; the source zone is noted", () => {
    createUserEvent({ title: "Flight", startsAt: "2026-09-02T18:30:00.000Z", tz: "America/Los_Angeles" }, NOW);
    const ist = calendarView({ from: "2026-09-01", to: "2026-09-04", viewNow: NOW, tz: IST }).items[0]!;
    expect(ist.day).toBe("2026-09-03");
    expect(ist.rendered).toMatch(/2026-09-03 00:00 IST \(11:30 PDT\)/);
    expect(ist.sourceTz).toBe("America/Los_Angeles");
    const la = calendarView({ from: "2026-09-01", to: "2026-09-04", viewNow: NOW, tz: "America/Los_Angeles" }).items[0]!;
    expect(la.day).toBe("2026-09-02");
    expect(la.sourceTz).toBeNull();
  });
});
