// ===========================================================================
// Persisted latency marks (build item 4.2, arch §9.5.3 rule 4).
//
// Four defects this file keeps out:
//   * a call whose latency was never persisted — TTFT that lives only in
//     memory dies with the process, and the ops surface would render nothing;
//   * a summary keyed on model alone — a P-CL1 regression hidden behind a
//     fast P-TR1 on the same model;
//   * a mean where a worst belongs — one breach is a breach;
//   * an errored call recording ttft=0 — claiming "instant" when the truth is
//     "no token ever arrived".
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "./connection.js";
import {
  callLatencySummary,
  isMilestoneName,
  latencySnapshot,
  latestMilestones,
  MILESTONE_NAMES,
  recordCallMark,
  recordMilestoneMark,
} from "./latency-marks.js";
import { recordRun } from "./run-accounting.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-latency-marks-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const USAGE = {
  inputTokens: 100,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 500,
};

describe("call marks — per model per call type, worst never mean", () => {
  it("summarises by the (model, call type) pair, not by model alone", () => {
    recordCallMark({ name: "P-CL1", model: "opus", ttftMs: 2_000, totalMs: 12_000, outputTokens: 600 });
    recordCallMark({ name: "P-CL1", model: "opus", ttftMs: 4_500, totalMs: 15_000, outputTokens: 600 });
    recordCallMark({ name: "P-TR1", model: "opus", ttftMs: 300, totalMs: 900, outputTokens: 90 });

    const rows = callLatencySummary();
    expect(rows.map((r) => [r.model, r.callType, r.calls])).toEqual([
      ["opus", "P-CL1", 2],
      ["opus", "P-TR1", 1],
    ]);
    // Worst TTFT and worst total — a mean of 2s and 4.5s would hide the 4.5.
    const cl1 = rows.find((r) => r.callType === "P-CL1")!;
    expect(cl1.worstTtftMs).toBe(4_500);
    expect(cl1.worstTotalMs).toBe(15_000);
    // Slowest observed rate: 600 tok / 15 s = 40 tok/s, not the faster call's 50.
    expect(cl1.minTokensPerSecond).toBe(40);
  });

  it("keeps an errored call's TTFT as null, never zero", () => {
    recordCallMark({ name: "P-CL1", model: "opus", ttftMs: null, totalMs: 8_000, outputTokens: 0 });
    const row = callLatencySummary()[0]!;
    expect(row.worstTtftMs).toBeNull();
    expect(row.callsWithTtft).toBe(0);
    expect(latencySnapshot().ttftCoverage).toBe(0);
    // ...and rejects a fabricated negative one outright.
    expect(() =>
      recordCallMark({ name: "P-CL1", model: "opus", ttftMs: -1, totalMs: 1, outputTokens: 1 }),
    ).toThrow(/non-negative/);
  });

  it("ttftCoverage is the recorded share — the running system's version of latency_ttft_recorded", () => {
    recordCallMark({ name: "P-CL1", model: "opus", ttftMs: 1_800, totalMs: 9_000, outputTokens: 500 });
    recordCallMark({ name: "media", model: "haiku", ttftMs: 700, totalMs: 4_000, outputTokens: 200 });
    recordCallMark({ name: "media", model: "haiku", ttftMs: null, totalMs: null, outputTokens: 0 });
    expect(latencySnapshot().ttftCoverage).toBeCloseTo(2 / 3);
  });

  it("has no data when nothing ran — never a fabricated pass", () => {
    const snap = latencySnapshot();
    expect(snap.calls).toEqual([]);
    expect(snap.milestones).toEqual([]);
    expect(snap.ttftCoverage).toBeNull();
  });
});

describe("every runs row writes its mark — same cardinality by construction", () => {
  function cohort(id: string): void {
    getDb().prepare(`INSERT INTO cohorts (id, mode, horizon) VALUES (?, 'bootstrap', 'h24')`).run(id);
  }

  it("recordRun persists TTFT, duration and output tokens beside the run", () => {
    cohort("c0");
    const id = recordRun({
      role: "extract",
      model: "opus",
      cohortId: "c0",
      kind: "P-CL1",
      startedAt: "2026-08-15T12:00:00.000Z",
      endedAt: "2026-08-15T12:00:14.000Z",
      usage: USAGE,
      ttftMs: 2_100,
    });
    const mark = getDb()
      .prepare(`SELECT * FROM latency_marks WHERE kind = 'call' AND run_id = ?`)
      .get(id) as Record<string, unknown>;
    expect(mark).toMatchObject({ name: "P-CL1", model: "opus", ttft_ms: 2100, total_ms: 14000, output_tokens: 500 });
    const row = callLatencySummary()[0]!;
    // tokens/sec derived at read: 500 tok / 14 s ≈ 35.7 — derived, not stored.
    expect(row.minTokensPerSecond).toBeCloseTo(35.7, 1);
  });

  it("a run with no kind falls back to the role; no ttft stays null", () => {
    cohort("c0");
    recordRun({ role: "media", model: "haiku", cohortId: "c0", usage: USAGE });
    const row = callLatencySummary()[0]!;
    expect(row.callType).toBe("media");
    expect(row.worstTtftMs).toBeNull();
  });
});

describe("milestones — the global-acceptance numbers, graded against the budget of their day", () => {
  it("stores the five budget names and rejects anything else", () => {
    expect(MILESTONE_NAMES).toEqual(["first_claim", "spaces_tasks", "silent_gap", "steady_calls", "live_visibility"]);
    expect(isMilestoneName("first_claim")).toBe(true);
    expect(() =>
      recordMilestoneMark({ name: "first_clam" as never, value: 1, budget: 2, unit: "ms" }),
    ).toThrow(/unknown latency milestone/);
  });

  it("serves the LATEST mark per milestone, met graded against the stored budget", () => {
    recordMilestoneMark({ name: "first_claim", value: 41_000, budget: 30_000, unit: "ms" });
    recordMilestoneMark({ name: "first_claim", value: 18_000, budget: 30_000, unit: "ms" });
    recordMilestoneMark({ name: "steady_calls", value: 9, budget: 12, unit: "calls" });

    const rows = latestMilestones();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === "first_claim")).toMatchObject({ value: 18_000, met: true });
    expect(rows.find((r) => r.name === "steady_calls")).toMatchObject({ value: 9, budget: 12, unit: "calls", met: true });
  });

  it("a breach reads as a breach — the budget stored with the mark decides", () => {
    recordMilestoneMark({ name: "silent_gap", value: 140_000, budget: 90_000, unit: "ms" });
    expect(latestMilestones()[0]).toMatchObject({ name: "silent_gap", met: false });
  });
});
