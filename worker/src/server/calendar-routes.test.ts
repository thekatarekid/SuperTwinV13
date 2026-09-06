// ===========================================================================
// Calendar routes (V6 P1 S5.3) through the handler contract: the layered
// view at VIEW time, create/confirm/cancel events, rule confirm/dismiss,
// dates + policy, plan snooze/stop, Settings › Calendar. Temp DB, no server,
// zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createChatEvent, proposeRule, runLeadTimeTick, upsertPersonDate } from "../calendar/index.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { createEntity, setCircle } from "../entities/registry.js";
import { handleCalendarRoute } from "./calendar-routes.js";

const IST = "Asia/Kolkata";
const NOW = new Date("2026-08-29T03:30:00.000Z");
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cal-routes-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, now: Date = NOW): Promise<{ handled: boolean; status: number | null; body: any }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as { method: string }).method = method;
  (req as { url: string }).url = path;
  let status: number | null = null;
  let payload = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      payload = chunk ?? "";
    },
  } as unknown as ServerResponse;
  const handled = await handleCalendarRoute(req, res, () => now);
  return { handled, status, body: payload === "" ? null : JSON.parse(payload) };
}

describe("handleCalendarRoute", () => {
  it("declines paths it does not own", async () => {
    expect((await call("GET", "/api/people")).handled).toBe(false);
    expect((await call("GET", "/api/settings/general")).handled).toBe(false);
    expect((await call("DELETE", "/api/calendar")).handled).toBe(false);
  });

  it("GET /api/calendar renders the layers for the range at view time; layers= narrows", async () => {
    createChatEvent({ title: "Dinner with Rohan", phrase: "dinner sat 8pm", message: { ts: "2026-08-27T13:30:00.000Z", tz: IST } }, NOW);
    getDb().prepare(`INSERT INTO tasks (id, title, owner, due, status) VALUES ('t1', 'Pay rent', 'self', '2026-09-01', 'open')`).run();
    const all = await call("GET", "/api/calendar?from=2026-08-29&to=2026-09-05&tz=Asia/Kolkata");
    expect(all.status).toBe(200);
    expect(all.body.counts).toEqual({ my_events: 1, my_tasks: 1, twin_tasks: 0, people: 0 });
    expect(all.body.items[0]).toMatchObject({ layer: "my_events", status: "tentative", relative: "today", phrase: "dinner sat 8pm" });
    const tasks = await call("GET", "/api/calendar?from=2026-08-29&to=2026-09-05&layers=my_tasks");
    expect(tasks.body.layers).toEqual(["my_tasks"]);
    expect(tasks.body.items.map((i: { title: string }) => i.title)).toEqual(["Pay rent"]);
    const firm = await call("GET", "/api/calendar?from=2026-08-29&to=2026-09-05&tentative=0&layers=my_events");
    expect(firm.body.items).toEqual([]);
    expect((await call("GET", "/api/calendar?from=2026-09-05&to=2026-09-01")).status).toBe(400);
    // no range → today .. +30d
    expect((await call("GET", "/api/calendar")).body).toMatchObject({ from: "2026-08-29", to: "2026-09-28" });
  });

  it("events: create (confirmed), confirm a tentative one, cancel", async () => {
    const made = await call("POST", "/api/calendar/events", { title: "Dentist", starts_at: "2026-09-04T05:00:00.000Z", tz: IST });
    expect(made.status).toBe(201);
    expect(made.body.event).toMatchObject({ status: "confirmed", origin: "user" });
    expect((await call("POST", "/api/calendar/events", { title: "x" })).status).toBe(400);
    const chat = createChatEvent({ title: "Dinner", phrase: "dinner sat 8pm", message: { ts: "2026-08-27T13:30:00.000Z", tz: IST } }, NOW)!;
    const confirmed = await call("POST", `/api/calendar/events/${chat.event.id}/confirm`);
    expect(confirmed.body.event).toMatchObject({ status: "confirmed", confirmed_by: "user" });
    expect((await call("POST", `/api/calendar/events/${chat.event.id}/cancel`)).body.event.status).toBe("cancelled");
    expect((await call("POST", `/api/calendar/events/nope/confirm`)).status).toBe(404);
  });

  it("rules: confirm as proposed, confirm with an edited phrase, dismiss", async () => {
    const a = proposeRule({ title: "Rent", phrase: "rent every 1st", message: { ts: "2026-08-28T04:30:00.000Z", tz: IST } }, NOW)!;
    expect((await call("POST", `/api/calendar/rules/${a.rule.id}/confirm`)).body.rule.status).toBe("confirmed");
    const b = proposeRule({ title: "Rent", phrase: "rent every 1st", message: { ts: "2026-08-28T04:30:00.000Z", tz: IST } }, NOW)!;
    const edited = await call("POST", `/api/calendar/rules/${b.rule.id}/confirm`, { phrase: "every 5th" });
    expect(JSON.parse(edited.body.rule.rule_json)).toMatchObject({ freq: "monthly", byMonthDay: 5 });
    expect((await call("POST", `/api/calendar/rules/${b.rule.id}/confirm`, { phrase: "once" })).status).toBe(400);
    const c = proposeRule({ title: "Standup", phrase: "every friday", message: { ts: "2026-08-28T04:30:00.000Z", tz: IST } }, NOW)!;
    expect((await call("POST", `/api/calendar/rules/${c.rule.id}/dismiss`)).body.rule.status).toBe("dismissed");
  });

  it("dates + policy, then a plan snoozed through the route (learned) and stopped", async () => {
    const ma = createEntity({ type: "person", canonical: "Ma" });
    setCircle(ma.id, "family");
    const date = await call("POST", "/api/calendar/dates", { person_entity_id: ma.id, kind: "birthday", month: 9, day: 20 });
    expect(date.status).toBe(201);
    expect((await call("POST", "/api/calendar/dates", { person_entity_id: ma.id, kind: "party" })).status).toBe(400);
    const policy = await call("POST", `/api/calendar/dates/${date.body.date.id}/policy`, { lead_days: 21 });
    expect(policy.body.date.lead_days).toBe(21);
    const opened = runLeadTimeTick(new Date("2026-08-30T03:30:00.000Z")).opened[0]!; // Sep 20 − 21 = Aug 30
    const bad = await call("POST", `/api/calendar/plans/${opened.planId}/snooze`, { choice: "tomorrow" });
    expect(bad.status).toBe(400);
    const snoozed = await call("POST", `/api/calendar/plans/${opened.planId}/snooze`, { choice: "3_days_before" }, new Date("2026-08-30T03:30:00.000Z"));
    expect(snoozed.status).toBe(200);
    expect(snoozed.body.plan).toMatchObject({ status: "snoozed", snoozed_until: "2026-09-17" });
    expect(snoozed.body.learned_lead_days).toBe(3);
    expect((await call("POST", `/api/calendar/plans/${opened.planId}/stop`)).body.plan.status).toBe("stopped");
    upsertPersonDate({ personEntityId: ma.id, kind: "anniversary", month: 1, day: 1 }, NOW);
    const people = await call("GET", "/api/calendar?from=2026-08-29&to=2027-01-02&layers=people");
    expect(people.body.items.map((i: { title: string }) => i.title)).toEqual(["Ma's birthday", "Ma's anniversary"]);
  });

  it("Settings › Calendar: GET defaults, POST per circle", async () => {
    const before = await call("GET", "/api/settings/calendar");
    expect(before.body.circles.family).toEqual({ mode: "plan", leadDays: 14 });
    const after = await call("POST", "/api/settings/calendar", { circles: { friends: { mode: "plan", lead_days: 5 } } });
    expect(after.body.circles.friends).toEqual({ mode: "plan", leadDays: 5 });
    expect((await call("GET", "/api/settings/calendar")).body.circles.friends.leadDays).toBe(5);
    expect((await call("PUT", "/api/settings/calendar")).handled).toBe(false);
  });
});
