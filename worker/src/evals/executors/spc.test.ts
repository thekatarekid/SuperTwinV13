// ===========================================================================
// SPC executor (V6 P1 S5.1): the eight code cases run against the real
// fixtures in evals/v13 through the real product code (brain/commit.ts,
// spaces/*, consolidation/graduation.ts) — sandboxed DB, zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { loadFixture } from "../fixtures.js";
import { registeredPasses } from "../runner.js";
import { registerProductExecutors } from "./index.js";
import { spacesExecutor } from "./spc.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-spc-eval-"));
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
  expect(fixture.pass).toBe("space");
  const r = await spacesExecutor({ fixture });
  // Nothing in this category may reach a provider: no run rows, ever.
  expect(tableCount("runs")).toBe(0);
  return r;
}

describe("SPC executor (SPC-01..08)", () => {
  it("registers under `space`", async () => {
    await registerProductExecutors();
    expect(registeredPasses()).toContain("space");
  });

  it("SPC-01: an inferred birth in propose-only queues, with the sweep preview on the card", async () => {
    const r = await run("SPC-01");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({
      status: "proposed",
      born_via: "inferred",
      in_review_queue: true,
      sweep_preview_count: 3,
      sweep_preview_line: "will pull in 3 related items",
    });
    // SPC-05's sibling assertion: the founding quote rides along on the row.
    expect((r.output as { birth_evidence: { quote: string }[] }).birth_evidence[0]!.quote).toBe(
      "lets lock goa 18-21 dec",
    );
  });

  it("SPC-02: the bar's space is created active while inference is still proposing", async () => {
    const r = await run("SPC-02");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({
      inferred_would_be: "proposed",
      status: "active",
      born_via: "asked",
      created_by: "user",
      label: "hampi trek in october",
      shown_in_list: true,
    });
  });

  it("SPC-03: a near-duplicate the user asked for is an ASK, never a second space", async () => {
    const r = await run("SPC-03");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({ outcome: "ask", spaces_after: 1 });
    expect((r.output as { duplicate_of: string }).duplicate_of).toContain("sp_goa_dec");
  });

  it("SPC-04: the dormant space wakes with its old evidence and re-arms the sweep", async () => {
    const r = await run("SPC-04");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({
      woke: true,
      status: "active",
      old_evidence: { episodes: 1, open_tasks: 1 },
      episodes_still_attached: 1,
      sweep_rearmed: true,
      decide_requeued: 1,
    });
  });

  it("SPC-05: the birth evidence is the sentence verbatim and \"why?\" reaches the thread", async () => {
    const r = await run("SPC-05");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({
      birth_via: "asked",
      evidence_quote: "start tracking the ITR filing for FY26",
      thread_id: "th_bar_9",
      why_decision_action: "create",
    });
  });

  it("SPC-06: two clean weeks graduate, a false merge resets the clock", async () => {
    const r = await run("SPC-06");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({
      consecutive_green: 14,
      after_clean_weeks: { flipped: "graduated", mode: "auto", born_status: "active" },
      after_false_merge: { flipped: "reset", mode: "propose", born_status: "proposed", consecutive_green: 0 },
      decision_flips: ["auto", "propose"],
    });
  });

  it("SPC-07: an unchanged unsorted skips outright; one new row buys exactly one call", async () => {
    const r = await run("SPC-07");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({
      unchanged: { skipped: true, model_calls: 0 },
      changed: { skipped: false, model_calls: 1, spaces_reviewed: 1, attached: 1 },
    });
    expect(r.metrics!.clock_only_call).toBe(0);
  });

  it("SPC-08: an unchanged content hash never queues a call; a moved one does", async () => {
    const r = await run("SPC-08");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({
      first: { changed: true, queued: true },
      unchanged: { changed: false, queued: false, model_calls: 0, new_decisions: 0 },
      moved: { changed: true, queued: true },
    });
  });

  it("every case cleans up after itself — the harness DB is empty again", async () => {
    for (const id of ["SPC-01", "SPC-02", "SPC-03", "SPC-04", "SPC-05", "SPC-06", "SPC-07", "SPC-08"]) {
      await run(id);
    }
    expect(tableCount("spaces")).toBe(0);
    expect(tableCount("episodes")).toBe(0);
    expect(tableCount("unsorted")).toBe(0);
    expect(tableCount("tasks")).toBe(0);
    expect(tableCount("space_enrichments")).toBe(0);
    expect(tableCount("decide_queue")).toBe(0);
    expect(tableCount("runs")).toBe(0);
  });
});
