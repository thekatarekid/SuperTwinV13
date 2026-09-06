// ===========================================================================
// CAL executor (V6 P1 S5.3): the five code cases run against the real
// fixtures in evals/v13 through the real calendar code — pinned clock, zero
// model calls, sandboxed DB — plus the deterministic TIM-01..04 layer.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { registeredPasses } from "../runner.js";
import { calendarExecutor, timCode } from "./cal.js";
import { registerProductExecutors } from "./index.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cal-eval-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function tableCount(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function run(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("calendar");
  const r = await calendarExecutor({ fixture });
  expect(r.metrics!.model_calls).toBe(0);
  expect(tableCount("runs")).toBe(0);
  return r;
}

describe("CAL executor (CAL-01..05)", () => {
  it("registers under `calendar`", async () => {
    await registerProductExecutors();
    expect(registeredPasses()).toContain("calendar");
  });

  it("CAL-01: tentative at 2026-08-29 20:00 IST from the message-time anchor, firm after the booking", async () => {
    const r = await run("CAL-01");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as { after_chat: Record<string, unknown>; after_booking: Record<string, unknown>; layer_status: string };
    expect(out.after_chat).toMatchObject({ status: "tentative", starts_at: "2026-08-29T14:30:00.000Z", local_day: "2026-08-29", local_time: "20:00", phrase: "dinner sat 8pm" });
    expect(out.layer_status).toBe("tentative");
    expect(out.after_booking).toMatchObject({ status: "confirmed", confirmed_by: "booking", starts_at: "2026-08-29T14:30:00.000Z" });
  });

  it("CAL-02: opens Sep 6 not Sep 5; snooze offered and learned; next year at T − 10; the friend's wish never opens", async () => {
    const r = await run("CAL-02");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as Record<string, unknown>;
    expect(out.plan).toEqual({ occurrence: "2026-09-20", lead_days: 14, opens_at: "2026-09-06" });
    expect(out.opened_on_sep_5).toBe(false);
    expect(out.opened_on_sep_6).toBe(true);
    expect(out.space_status_on_open).toBe("active");
    expect((out.snooze_options as Array<{ id: string; until: string }>).map((o) => [o.id, o.until])).toEqual([
      ["next_week", "2026-09-13"],
      ["10_days_before", "2026-09-10"],
      ["3_days_before", "2026-09-17"],
    ]);
    expect(out.after_snooze).toMatchObject({ status: "snoozed", snoozed_until: "2026-09-10", learned_lead_days: 10 });
    expect(out.next_year).toMatchObject({ occurrence: "2027-09-20", opens_at: "2027-09-10", lead_days: 10 });
  });

  it("CAL-03: the March 'tomorrow' is 2026-03-15, past, closure-checked, off the upcoming layer", async () => {
    const r = await run("CAL-03");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({ resolved_date: "2026-03-15", relation: "past", disposition: "closure_check", due_today: false, upcoming_layer_contains_it: false });
  });

  it("CAL-04: a monthly rule, proposed with an open question; no date rows; occurrences only after the user confirms", async () => {
    const r = await run("CAL-04");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({
      rule: { freq: "monthly", interval: 1, byMonthDay: 1 },
      status_at_birth: "proposed",
      question: { open: true, kind: "calendar_rule" },
      calendar_events_from_rule: 0,
      occurrences_visible_before_confirm: 0,
      next_occurrences_after_confirm: ["2026-09-01", "2026-10-01"],
      status_after_confirm: "confirmed",
    });
    expect(r.metrics!.auto_schedule_policy_violation).toBe(0);
  });

  it("CAL-05: the four layers are disjoint and their union is the whole; tentative stays marked", async () => {
    const r = await run("CAL-05");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({
      my_tasks_alone: ["Pay the maintenance"],
      twin_tasks_alone: ["Web check-in for the Goa flight"],
      my_events_alone: ["Dinner with Rohan", "Movie with Sameer"],
      people_alone: ["Ma's birthday", "Rohan pays the villa advance"],
      no_item_in_two_layers: true,
      together_equals_union: true,
      tentative_marked: true,
    });
  });

  it("every case cleans up after itself", async () => {
    for (const id of ["CAL-01", "CAL-02", "CAL-03", "CAL-04", "CAL-05"]) await run(id);
    for (const t of ["calendar_events", "calendar_rules", "person_dates", "calendar_plans", "spaces", "tasks", "entities", "questions"]) {
      expect(tableCount(t), t).toBe(t === "entities" ? 1 : 0); // the seeded self entity stays
    }
  });
});

describe("TIM code layer (timCode)", () => {
  it("TIM-01..04 are green on the pure clocks; other ids are not covered", () => {
    for (const id of ["TIM-01", "TIM-02", "TIM-03", "TIM-04"]) {
      const r = timCode(id)!;
      expect(r.violations, id).toEqual([]);
      expect(r.ok, id).toBe(true);
      expect(r.metrics!.model_calls).toBe(0);
    }
    expect(timCode("SCH-01")).toBeNull();
    expect((timCode("TIM-04")!.output as { rendered_for_user: string }).rendered_for_user).toMatch(/IST.*11:30 PDT/);
  });
});
