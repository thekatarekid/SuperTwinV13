// The Tasks surface's safety property (arch §14.7, build item 3.10):
// **no loop owned by another person appears in Tasks.**
//
// This file is where that criterion is actually enforced, so it is tested
// here directly and again through the rendered surface in TasksTab.test.tsx.

import { describe, expect, it } from "vitest";

import {
  exclusionReason,
  groupBySpace,
  isOwnTask,
  lapsedExplanation,
  partitionTasks,
} from "./partition";
import type { TaskView } from "../../lib/tasks-client";
import type { Retained } from "../../lib/provisional";

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: "loop_1",
    intent: "send the villa link",
    origin: "explicit",
    state: "open",
    stateReason: null,
    stateNote: null,
    triage: "approve",
    ownerIsSelf: true,
    ownerLabel: "you",
    counterpartyLabel: "Pranjali",
    dueAt: null,
    dueLabel: "due today",
    recurrence: null,
    nextOccurrenceAt: null,
    spaceId: "arc_77",
    spaceLabel: "Goa trip",
    confidence: 0.9,
    inferredFrom: null,
    provisional: false,
    pendingNote: null,
    updatedAt: null,
    evidence: [{ eventId: "ev_1", quote: "i'll send you that villa link tonight", at: null, episodeId: null }],
    ...over,
  };
}

const wrap = (rows: TaskView[]): Retained<TaskView>[] => rows.map((row) => ({ row, retracted: false }));

describe("ownership — the acceptance criterion", () => {
  it("a loop owned by another person is never a task", () => {
    const theirs = task({ id: "loop_2", ownerIsSelf: false, ownerLabel: "Rohan" });
    expect(isOwnTask(theirs)).toBe(false);

    const p = partitionTasks(wrap([task(), theirs]));
    expect(p.explicit.map((e) => e.row.id)).toEqual(["loop_1"]);
    expect(p.implicit).toHaveLength(0);
    expect(p.notYours.map((e) => e.row.id)).toEqual(["loop_2"]);
  });

  it("a context triage is excluded even when the owner flag says self", () => {
    // The second, independent guard: `cx` means "not yours to act on".
    const mislabelled = task({ id: "loop_3", ownerIsSelf: true, triage: "context" });
    expect(isOwnTask(mislabelled)).toBe(false);
    expect(partitionTasks(wrap([mislabelled])).explicit).toHaveLength(0);
  });

  it("says why a loop was excluded, rather than dropping it silently", () => {
    expect(exclusionReason(task({ ownerIsSelf: false, ownerLabel: "Rohan" }))).toContain("Rohan");
    expect(exclusionReason(task({ triage: "context" }))).toContain("context");
    expect(exclusionReason(task())).toBeNull();
  });
});

describe("the two lists (§14.7 rule 1)", () => {
  it("splits explicit from implicit structurally", () => {
    const p = partitionTasks(
      wrap([task(), task({ id: "loop_i", origin: "implicit", inferredFrom: "ACT is way overpriced" })]),
    );
    expect(p.explicit.map((e) => e.row.id)).toEqual(["loop_1"]);
    expect(p.implicit.map((e) => e.row.id)).toEqual(["loop_i"]);
  });

  it("only open and latent are live work; lapsed gets its own list", () => {
    const p = partitionTasks(
      wrap([
        task({ id: "a", state: "latent" }),
        task({ id: "b", state: "done" }),
        task({ id: "c", state: "dropped" }),
        task({ id: "d", state: "lapsed", stateReason: "born_lapsed" }),
      ]),
    );
    expect(p.explicit.map((e) => e.row.id)).toEqual(["a"]);
    expect(p.lapsed.map((e) => e.row.id)).toEqual(["d"]);
  });

  it("keeps a retained (retracted) row in its list — §14.0b", () => {
    const rows: Retained<TaskView>[] = [{ row: task({ provisional: true }), retracted: true }];
    expect(partitionTasks(rows).explicit).toHaveLength(1);
  });
});

describe("lapsed tasks say why", () => {
  it("prefers the worker's own note", () => {
    expect(lapsedExplanation(task({ state: "lapsed", stateNote: "the reply window closed" }))).toBe(
      "the reply window closed",
    );
  });

  it("spells out born lapsed", () => {
    expect(lapsedExplanation(task({ state: "lapsed", stateReason: "born_lapsed" }))).toContain(
      "born lapsed",
    );
  });

  it("is never blank, even with nothing recorded", () => {
    expect(lapsedExplanation(task({ state: "lapsed" }))).toBe("lapsed — reason not recorded");
  });
});

describe("grouping by space (§14.7)", () => {
  it("groups by space and puts loose tasks last, never dropping them", () => {
    const groups = groupBySpace(
      wrap([
        task({ id: "a", spaceId: null, spaceLabel: null }),
        task({ id: "b" }),
        task({ id: "c" }),
      ]),
    );
    expect(groups.map((g) => g.spaceLabel)).toEqual(["Goa trip", "no space"]);
    expect(groups[0]!.entries.map((e) => e.row.id)).toEqual(["b", "c"]);
    expect(groups[1]!.entries.map((e) => e.row.id)).toEqual(["a"]);
  });
});
