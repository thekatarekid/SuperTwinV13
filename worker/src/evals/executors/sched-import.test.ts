// [CODE] Tests for the full-import + restart corpus (build item 4.1).

import { describe, expect, it } from "vitest";

import {
  buildSchedImportObservations,
  resetSchedImportObservationsForTests,
  schedImportObservations,
} from "./sched-import.js";

const GATES = [
  "sched_recency_order",
  "sched_bootstrap_seal_immediate",
  "sched_live_preempts_backfill",
  "sched_restart_no_rejudge",
] as const;

describe("sched-import corpus", () => {
  const observations = buildSchedImportObservations();

  it("emits observations for all four integration gates and nothing else", () => {
    const seen = new Set(observations.map((o) => o.gate));
    for (const gate of GATES) expect(seen.has(gate), gate).toBe(true);
    for (const o of observations) expect(GATES).toContain(o.gate);
  });

  it("every bootstrap session sealed with seal_mode=immediate", () => {
    const seals = observations.filter((o) => o.gate === "sched_bootstrap_seal_immediate");
    expect(seals.length).toBe(10);
    for (const o of seals) expect(o.passed, o.note).toBe(true);
  });

  it("the drained import order is recency-descending within every tier", () => {
    const order = observations.filter((o) => o.gate === "sched_recency_order");
    expect(order.length).toBeGreaterThan(0);
    for (const o of order) expect(o.passed, o.note).toBe(true);
  });

  it("a live T1 cohort arriving mid-cohort runs at the next boundary (delay <= 1)", () => {
    const live = observations.filter((o) => o.gate === "sched_live_preempts_backfill");
    expect(live.length).toBe(1);
    expect(live[0]!.passed, live[0]!.note).toBe(true);
    expect(live[0]!.value).toBeLessThanOrEqual(1);
    expect(live[0]!.value).toBeGreaterThanOrEqual(0);
  });

  it("restart resumes without re-judging a single persisted verdict", () => {
    const restart = observations.filter((o) => o.gate === "sched_restart_no_rejudge");
    // One summary row plus one per judged session (a whole cohort + the
    // mid-flight verdict).
    expect(restart.length).toBeGreaterThanOrEqual(3);
    for (const o of restart) expect(o.passed, o.note).toBe(true);
  });

  it("is deterministic — a second build reports the same verdicts", () => {
    const again = buildSchedImportObservations();
    expect(again.map((o) => [o.gate, o.passed])).toEqual(observations.map((o) => [o.gate, o.passed]));
  });

  it("the once-per-process guard emits exactly once until reset", () => {
    resetSchedImportObservationsForTests();
    const first = schedImportObservations();
    expect(first.length).toBeGreaterThan(0);
    expect(schedImportObservations()).toEqual([]);
    resetSchedImportObservationsForTests();
    expect(schedImportObservations().length).toBe(first.length);
    resetSchedImportObservationsForTests();
  });
});
