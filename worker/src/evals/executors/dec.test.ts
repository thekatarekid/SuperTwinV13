// ===========================================================================
// DEC executor (V6 P1 S3.7): the six code cases run against the real
// fixtures in evals/v13 through the real Decide pass — canned decide.v9
// output, pinned clock, zero model calls, sandboxed DB.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { decideSpaceExecutor } from "./dec.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-dec-eval-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function run(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("decide-space");
  const r = await decideSpaceExecutor({ fixture });
  expect(r.metrics!.model_calls).toBe(0);
  // the canned answer never reaches the ledger
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n).toBe(0);
  return r;
}

type Out = {
  tasks: Array<{ title: string; type: string; status: string; owner: string; category: string | null; risk_class: string; schedule: { mode: string; fire_at: string } | null; due: string | null }>;
  milestones: Array<{ label: string; status: string }>;
  episodes: Array<{ id: string; chapter: string | null }>;
  closure_check_run?: { asked: number; escalated: number; modelCalls: number };
};

describe("decide executor (DEC-01..06)", () => {
  it("DEC-01: the villa episode lands in sp_goa_dec › Stay", async () => {
    const r = await run("DEC-01");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as Out;
    expect(out.episodes).toEqual([{ id: "ep_villa", chapter: "Stay" }]);
    expect(out.milestones.map((m) => [m.label, m.status])).toEqual([["Flights", "done"], ["Stay", "active"], ["Day trips", "todo"]]);
  });

  it("DEC-02: flights close; web check-in implicit + auto at the window (never 06:55); cab suggested for 18 Dec", async () => {
    const r = await run("DEC-02");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as Out;
    const checkin = out.tasks.find((t) => /check-in/i.test(t.title))!;
    expect(checkin).toMatchObject({ type: "implicit", status: "scheduled" });
    expect(checkin.schedule).toMatchObject({ mode: "auto", fire_at: "2026-12-16T01:30:00.000Z" }); // 07:00 IST, not the model's 06:55
    expect(out.tasks.find((t) => /book flights/i.test(t.title))!.status).toBe("done");
    expect(out.tasks.find((t) => /cab/i.test(t.title))).toMatchObject({ type: "suggested", due: "2026-12-18T04:30+05:30" });
  });

  it("DEC-03: one-sided intent keeps the task open; the check runs as a lookup and asks by code, zero calls", async () => {
    const r = await run("DEC-03");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    const out = r.output as Out;
    expect(out.tasks[0].status).toBe("open");
    expect(out.closure_check_run).toMatchObject({ asked: 1, escalated: 0, modelCalls: 0 });
    expect(r.metrics!.checks_scheduled).toBe(1);
  });

  it("DEC-04: cancellation closes as cancelled, never done", async () => {
    const r = await run("DEC-04");
    expect(r.violations).toEqual([]);
    expect((r.output as Out).tasks[0].status).toBe("cancelled");
  });

  it("DEC-05: Karan's task stays Karan's (advise-only); the user gets a monitoring follow-up", async () => {
    const r = await run("DEC-05");
    expect(r.violations).toEqual([]);
    const out = r.output as Out;
    const theirs = out.tasks.find((t) => !/^Follow up/.test(t.title))!;
    expect(theirs).toMatchObject({ owner: "contact:karan", risk_class: "advise-only" });
    const monitor = out.tasks.find((t) => /^Follow up/.test(t.title))!;
    expect(monitor).toMatchObject({ owner: "self", category: "monitoring", risk_class: "advise-only", type: "suggested" });
    expect(r.metrics!.tasks_monitored).toBe(1);
  });

  it("DEC-06: a one-shot goal gets no milestones", async () => {
    const r = await run("DEC-06");
    expect(r.violations).toEqual([]);
    expect((r.output as Out).milestones).toEqual([]);
    expect(r.metrics!.milestones_dropped).toBe(1);
  });
});
