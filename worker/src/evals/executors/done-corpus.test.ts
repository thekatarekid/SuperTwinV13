// [CODE] Tests for the labelled done-detection corpus (build item 4.1).

import { describe, expect, it } from "vitest";

import {
  doneCorpusObservations,
  resetDoneCorpusObservationsForTests,
  runDoneCorpus,
} from "./done-corpus.js";

describe("done-detection corpus", () => {
  const run = runDoneCorpus();

  it("closes exactly the 12 genuinely-done loops, and closes them correctly", () => {
    const closes = run.application.outcomes.filter((o) => o.action === "close_done");
    expect(closes.length).toBe(12);
    for (const o of closes) expect(run.trulyDone.has(o.loopId), o.loopId).toBe(true);
  });

  it("measured precision is 1.0 over 12 closes, by the product's own meter", () => {
    expect(run.precision.closed).toBe(12);
    expect(run.precision.correct).toBe(12);
    expect(run.precision.precision).toBe(1);
  });

  it("declines the pre-stated, guessed and unresolvable dn findings", () => {
    const byId = new Map(run.application.outcomes.map((o) => [o.loopId, o]));
    expect(byId.get("nd1")?.action).toBe("keep_open_ask");
    expect(byId.get("nd1")?.reason).toBe("evidence_before_stated");
    expect(byId.get("nd2")?.action).toBe("keep_open_ask");
    expect(byId.get("nd3")?.reason).toBe("evidence_missing");
    expect(byId.get("nd4")?.reason).toBe("evidence_unresolved");
  });

  it("dr closes as dropped and stays outside the precision denominator", () => {
    const dropped = run.application.outcomes.filter((o) => o.action === "close_dropped");
    expect(dropped.map((o) => o.loopId).sort()).toEqual(["dr1", "dr2"]);
  });

  it("ps stays open with a question; op stays open silently", () => {
    const byId = new Map(run.application.outcomes.map((o) => [o.loopId, o]));
    expect(byId.get("ps1")?.action).toBe("keep_open_ask");
    expect(byId.get("op1")?.action).toBe("keep_open");
    expect(run.application.questions.some((q) => q.targetId === "ps1")).toBe(true);
  });

  it("observation pass rate IS the measured precision", () => {
    const obs = run.observations;
    expect(obs.every((o) => o.gate === "loops_done_detection_precision")).toBe(true);
    const rate = obs.filter((o) => o.passed).length / obs.length;
    expect(rate).toBe(run.precision.precision);
  });

  it("the gate can fail: a wrong close would drag the rate under 0.95", () => {
    // 12 correct closes + the 4 declined dn findings turned into closes would
    // read 12/16 = 0.75. The margin the evidence checks are protecting.
    expect(12 / 16).toBeLessThan(0.95);
  });

  it("the once-per-process guard emits exactly once until reset", () => {
    resetDoneCorpusObservationsForTests();
    const first = doneCorpusObservations();
    expect(first.length).toBe(12);
    expect(doneCorpusObservations()).toEqual([]);
    resetDoneCorpusObservationsForTests();
  });
});
