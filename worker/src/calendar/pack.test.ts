// ===========================================================================
// The derived calendar inside the PACK (V6 P1 S5.3; Prompts P-01 user block:
// `[CALENDAR next 7d] 2026-09-06 20:00 dinner Rohan (tentative) · 2026-09-06
// planning opens: Ma's birthday`).
//
// packer/agenda.ts owns the block; this asserts the two sources S5.3 adds —
// calendar_events with their status, and the day a person's date opens its
// planning space — reach it, stay bounded, and never render a chat-derived
// plan as firm. Zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { createEntity, setCircle } from "../entities/registry.js";
import { calendarItems, renderCalendarItem } from "../packer/agenda.js";
import { cancelEvent, createChatEvent, createUserEvent, runLeadTimeTick, upsertPersonDate } from "./index.js";

const IST = "Asia/Kolkata";
/** Sat 2026-08-29 09:00 IST — the fixture era. */
const NOW = new Date("2026-08-29T03:30:00.000Z");
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-calpack-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("[CALENDAR] carries the derived calendar", () => {
  it("a chat-derived event is rendered with (tentative); a confirmed one is not", () => {
    const made = createChatEvent(
      { title: "Dinner with Rohan", phrase: "dinner sat 8pm", message: { ts: "2026-08-27T13:30:00.000Z", tz: IST } },
      NOW,
    );
    expect(made?.event.status).toBe("tentative");
    createUserEvent({ title: "Dentist", startsAt: "2026-08-31T05:30:00.000Z", tz: IST }, NOW);

    const items = calendarItems(NOW.getTime());
    const dinner = items.find((i) => i.refId === made!.event.id);
    expect(dinner).toMatchObject({ kind: "event", title: "Dinner with Rohan", status: "tentative" });
    expect(renderCalendarItem(dinner!)).toContain('"Dinner with Rohan" (tentative)');

    const dentist = items.find((i) => i.title === "Dentist");
    expect(renderCalendarItem(dentist!)).toContain('"Dentist" (confirmed)');
    // Nearest first: the dinner (29 Aug) precedes the dentist (31 Aug).
    expect(items.findIndex((i) => i.refId === dinner!.refId)).toBeLessThan(items.findIndex((i) => i.refId === dentist!.refId));
  });

  it("a cancelled event leaves the block", () => {
    const made = createChatEvent(
      { title: "Movie with Sameer", phrase: "movie sun 9pm", message: { ts: "2026-08-28T13:30:00.000Z", tz: IST } },
      NOW,
    );
    expect(calendarItems(NOW.getTime()).some((i) => i.refId === made!.event.id)).toBe(true);
    cancelEvent(made!.event.id, "user", NOW);
    expect(calendarItems(NOW.getTime()).some((i) => i.refId === made!.event.id)).toBe(false);
  });

  it("the day a lead-time plan opens says whose date it is", () => {
    const ma = createEntity({ type: "person", canonical: "Ma" });
    setCircle(ma.id, "family");
    // Family default is 14 days: Sep 20 opens on Sep 6, inside now+7d? No —
    // pull the date forward so the opening day lands in the window.
    upsertPersonDate({ personEntityId: ma.id, kind: "birthday", month: 9, day: 15 }, NOW);
    // Sep 15 − 14 = Sep 1, four days out.
    runLeadTimeTick(NOW);

    const items = calendarItems(NOW.getTime());
    const plan = items.find((i) => i.kind === "planning");
    expect(plan).toBeDefined();
    expect(plan!.at).toBe("2026-09-01");
    expect(plan!.title).toBe("planning opens: Ma's birthday on 2026-09-15");
    expect(renderCalendarItem(plan!)).toContain("2026-09-01 Tue · planning");
  });

  it("a date whose planning day is outside the window is not in the block", () => {
    const ma = createEntity({ type: "person", canonical: "Ma" });
    setCircle(ma.id, "family");
    upsertPersonDate({ personEntityId: ma.id, kind: "birthday", month: 9, day: 20 }, NOW);
    runLeadTimeTick(NOW); // opens 2026-09-06, eight days out
    expect(calendarItems(NOW.getTime()).some((i) => i.kind === "planning")).toBe(false);
    // Widen the window and it appears.
    expect(calendarItems(NOW.getTime(), { daysAhead: 14 }).some((i) => i.kind === "planning")).toBe(true);
  });

  it("stays capped: the block never grows past the limit", () => {
    for (let i = 0; i < 20; i += 1) {
      createUserEvent({ title: `Slot ${i}`, startsAt: new Date(NOW.getTime() + (i + 1) * 3_600_000).toISOString(), tz: IST }, NOW);
    }
    expect(calendarItems(NOW.getTime()).length).toBe(12);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM calendar_events`).get()).toMatchObject({ n: 20 });
  });
});
