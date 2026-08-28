// ===========================================================================
// Phase 3 eval executors — the CODE paths only (zero live model calls):
// SCH-08 timer resilience, FUP-05 provenance chain, TIM-02 render-relative,
// the BRW code assertions, and the schedule-policy applied view on a canned
// Decide output.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../../db/connection.js";
import { dueLabel } from "../../library/due-label.js";
import { validateBriefOutput } from "../../prompts/brief.v1.js";
import {
  browserEvalExecutor,
  fup05Code,
  sch08Code,
  schedulePolicyView,
  tim02Code,
} from "./p3.js";
import type { Fixture } from "../fixtures.js";
import type { DecideOutputV8 } from "../../prompts/decide.v8.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-p3ev-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const brwFixture = (id: string): { fixture: Fixture } =>
  ({ fixture: { id, category: "BRW", pass: "browser", mode: "code", wrong: [], gates: [], input_events: [] } as unknown as Fixture });

describe("SCH-08 code executor", () => {
  it("late-executes a valid missed fire, skips an expired one with a note, never double-fires", () => {
    const r = sch08Code();
    expect(r.ok).toBe(true);
    expect(r.violations ?? []).toHaveLength(0);
    const out = r.output as { lateFlagOnMissedFire: boolean; expiredTask: { status: string } };
    expect(out.lateFlagOnMissedFire).toBe(true);
    expect(out.expiredTask.status).toBe("open");
  });
});

describe("FUP-05 code executor", () => {
  it("builds a chain with visible because-spine; deleting a link orphans nothing", () => {
    const r = fup05Code();
    expect(r.ok).toBe(true);
    const out = r.output as { chain_before_delete: { because: string }[]; chain_after_delete: unknown[] };
    expect(out.chain_before_delete).toHaveLength(3);
    for (const link of out.chain_before_delete) expect(link.because).toMatch(/because/);
    expect(out.chain_after_delete).toHaveLength(2);
  });
});

describe("TIM-02 code executor + dueLabel", () => {
  it("renders tomorrow then overdue off the same stored date", () => {
    const r = tim02Code();
    expect(r.ok).toBe(true);
    expect(dueLabel("2026-08-27", new Date("2026-08-26T09:00:00"))).toBe("tomorrow");
    expect(dueLabel("2026-08-27", new Date("2026-08-27T09:00:00"))).toBe("today");
    expect(dueLabel("2026-08-27", new Date("2026-08-30T09:00:00"))).toBe("3 days overdue");
    expect(dueLabel("2026-08-27", new Date("2026-08-24T09:00:00"))).toBe("in 3 days");
  });
});

describe("schedulePolicyView", () => {
  const decideOut = (schedules: DecideOutputV8["schedules"]): DecideOutputV8 =>
    ({ chapters: [], tasks: [], closures: [], followups: [], plan: null, skipped: [], schedules }) as unknown as DecideOutputV8;

  it("SCH-01 shape: auto-class + high confidence + future time-bound → auto with announcement", () => {
    const { rows, violations } = schedulePolicyView(
      "SCH-01",
      decideOut([{ task: "Web check-in CCU-GOI", fire_at: "2026-12-16T07:00:00+05:30", recurrence: null, mode: "auto", reason: "T-48h", confidence: 0.95, polling: null }]),
      new Date("2026-08-29T00:00:00Z"),
    );
    expect(violations).toHaveLength(0);
    expect(rows[0]!.decision).toBe("auto");
    expect(rows[0]!.announce).toMatch(/tap to change/);
  });

  it("SCH-04 shape: recurrence is confirm even when auto was requested", () => {
    const { rows, violations } = schedulePolicyView(
      "SCH-04",
      decideOut([{ task: "Daily AI news brief", fire_at: "2026-08-30T08:30:00+05:30", recurrence: "daily", mode: "auto", reason: "asked twice", confidence: 0.9, polling: null }]),
      new Date("2026-08-29T00:00:00Z"),
    );
    expect(rows[0]!.decision).toBe("confirm");
    expect(violations).toHaveLength(0); // policy downgraded — no creep
  });

  it("SCH-06 shape: a past fire time is rejected; a surviving schedule is a violation", () => {
    const { rows, violations } = schedulePolicyView(
      "SCH-06",
      decideOut([{ task: "Web check-in", fire_at: "2026-06-05T06:15:00+05:30", recurrence: null, mode: "auto", reason: "", confidence: 0.9, polling: null }]),
      new Date("2026-08-29T00:00:00Z"),
    );
    expect(rows[0]!.decision).toBe("reject");
    expect(violations).toHaveLength(0);
  });
});

describe("brief.v1 contract", () => {
  it("requires a source chip on every item and forbids skip with items", () => {
    expect(() => validateBriefOutput({ skip: false, items: [{ text: "pay pool" }] })).toThrow(/source/);
    expect(() => validateBriefOutput({ skip: true, items: [{ text: "x", source: "y" }] })).toThrow(/zero items/);
    const ok = validateBriefOutput({ skip: false, items: [{ text: "pay pool", source: "tsk_pool" }] });
    expect(ok.items).toHaveLength(1);
  });
});

describe("BRW code-asserted executors", () => {
  it("BRW-01: challenge = hard stop, no further request", async () => {
    const r = await browserEvalExecutor(brwFixture("BRW-01"));
    expect(r.ok).toBe(true);
    expect(r.violations ?? []).toHaveLength(0);
  });
  it("BRW-02: jitter + skip days + human delays", async () => {
    const r = await browserEvalExecutor(brwFixture("BRW-02"));
    expect(r.ok).toBe(true);
  });
  it("BRW-03: user tabs untouchable", async () => {
    const r = await browserEvalExecutor(brwFixture("BRW-03"));
    expect(r.ok).toBe(true);
  });
  it("BRW-05: captured replay runs in page", async () => {
    const r = await browserEvalExecutor(brwFixture("BRW-05"));
    expect(r.ok).toBe(true);
  });
  it("BRW-08: login walls hard-stop; no credential tool exists", async () => {
    const r = await browserEvalExecutor(brwFixture("BRW-08"));
    expect(r.ok).toBe(true);
  });
  it("P5-scope BRW ids report their pending reason loudly", async () => {
    await expect(browserEvalExecutor(brwFixture("BRW-04"))).rejects.toThrow(/P5/);
  });
});
