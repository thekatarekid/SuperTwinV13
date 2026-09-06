// ===========================================================================
// R3 — `applied_by_task_writer`, and the judge being told to read it.
//
// The decide executor grades a LIVE model answer, so the only thing the judge
// ever saw was the raw decide.v9 JSON. Two shipped rules live entirely in the
// code AFTER that answer, and both decided a fixture's verdict the first time
// TSK-03..13 were measured (R3):
//
//   * a task whose owner is not the user becomes a MONITOR for the user —
//     stored as theirs, forced to advise-only (TSK-04 read the raw owner and
//     called it task theft);
//   * a title matching an OPEN task is skipped by the writer, and that dedupe
//     is the only filter there is (TSK-08's V1 rubric asked for an urgency
//     bump the applier does not do).
//
// `decideAppliedView` now renders both, and `buildJudgePrompt` names every
// `applied_by_*` annotation as code-enforced. Pure functions, zero model calls.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { buildJudgePrompt } from "../judge.js";
import type { Fixture } from "../fixtures.js";
import type { DecideOutput, DecideTask } from "../../prompts/decide.v1.js";
import { decideAppliedView } from "./passes.js";

function task(over: Partial<DecideTask> = {}): DecideTask {
  return {
    title: "Book flight ticket (CCU→GOI, 18 Dec)",
    type: "explicit",
    category: "transaction",
    risk_class: "approve-final",
    owner: "self",
    evidence: [{ event_ids: ["e1"], quote: "karan book YOUR ticket" }],
    confidence: 0.9,
    ...over,
  };
}

function out(over: Partial<DecideOutput> = {}): DecideOutput {
  return { chapters: [], tasks: [], schedules: [], closures: [], followups: [], plan: null, skipped: [], ...over };
}

interface AppliedView {
  tasks?: { title: string; owner: string; applied_as: string; risk_class_applied: string }[];
  task_dedupe?: string;
  closures?: { task: string; applied_as: string; note?: string }[];
}

describe("decideAppliedView — the task writer's half (R3)", () => {
  it("is undefined when the answer carries neither a task nor a closure", () => {
    expect(decideAppliedView(out())).toBeUndefined();
  });

  it("a task the user owns lands in the user's own list, at the risk class the model chose", () => {
    const view = decideAppliedView(out({ tasks: [task()] })) as AppliedView;
    expect(view.tasks).toHaveLength(1);
    expect(view.tasks![0]).toMatchObject({ owner: "self", risk_class_applied: "approve-final" });
    expect(view.tasks![0]!.applied_as).toMatch(/user's own list/);
  });

  it("another person's task becomes a MONITOR, forced to advise-only — the user's list gains nothing", () => {
    const view = decideAppliedView(out({ tasks: [task({ owner: "contact:karan" })] })) as AppliedView;
    expect(view.tasks![0]).toMatchObject({ owner: "contact:karan", risk_class_applied: "advise-only" });
    expect(view.tasks![0]!.applied_as).toMatch(/MONITOR/);
    expect(view.tasks![0]!.applied_as).toMatch(/gains nothing/);
  });

  it("treats every roster spelling of the user as the user (isSelf, the product's own predicate)", () => {
    for (const owner of ["self", "user", "me", "unknown", ""]) {
      const view = decideAppliedView(out({ tasks: [task({ owner })] })) as AppliedView;
      expect(view.tasks![0]!.applied_as).toMatch(/user's own list/);
    }
  });

  it("states the dedupe rule that actually ships, and names no budget", () => {
    const view = decideAppliedView(out({ tasks: [task()] })) as AppliedView;
    expect(view.task_dedupe).toMatch(/OPEN task/);
    expect(view.task_dedupe).toMatch(/only filter/);
    expect(view.task_dedupe).toMatch(/no suggestion budget/);
  });

  it("still renders the closure demotion beside the tasks", () => {
    const view = decideAppliedView(
      out({
        tasks: [task()],
        closures: [
          { task: "t_1", verdict: "close", outcome: "done", confidence: 0.95 },
          { task: "t_2", verdict: "close", outcome: "done", confidence: 0.5 },
        ],
      }),
    ) as AppliedView;
    expect(view.tasks).toHaveLength(1);
    expect(view.closures!.map((c) => c.applied_as)).toEqual(["close", "suggest_close"]);
    expect(view.closures![1]!.note).toMatch(/demoted/);
  });
});

describe("buildJudgePrompt — every applied_by_* annotation is named as code-enforced (R3)", () => {
  const fixture: Fixture = {
    id: "TSK-04",
    category: "TSK",
    title: "t",
    pass: "decide",
    mode: "live",
    setup: "s",
    input_events: ["i"],
    expected: "e",
    wrong: [{ label: "task-theft", assert_absent: "a task the user owns" }],
    gates: [],
    source: { doc: "V1", section: "TSK-04" },
  };

  it("names the two annotations the decide and consolidate executors actually emit", () => {
    const prompt = buildJudgePrompt(fixture, { output: { tasks: [] } });
    // These were emitted by passes.ts and missing from the judge's list until
    // R3, so the judge had no reason to trust them.
    expect(prompt).toContain("applied_by_task_writer");
    expect(prompt).toContain("applied_by_consolidator");
    expect(prompt).toContain("applied_by_commit_layer");
    expect(prompt).toMatch(/ANNOTATION is what\s+shipped/);
  });

  it("carries the annotation into the prompt when the executor produced one", () => {
    const view = decideAppliedView(out({ tasks: [task({ owner: "contact:karan" })] }));
    const prompt = buildJudgePrompt(fixture, { output: { tasks: [], applied_by_task_writer: view } });
    expect(prompt).toContain("MONITOR");
  });
});
