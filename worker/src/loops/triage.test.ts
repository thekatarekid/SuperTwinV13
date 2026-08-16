import { beforeEach, describe, expect, it } from "vitest";

import { createAliasTable } from "../wire/aliases.js";
import { resetLegendCache } from "../prompts/legend.js";
import { buildTr1Prompt, parseTr1Response, type Tr1Loop, type Triage } from "../prompts/p-tr1.js";
import { pastDueOpenViolations } from "./state.js";
import {
  tr1Accuracy,
  tr1Assignments,
  tr1DefaultTriage,
  tr1RuleFor,
  tr1Violations,
} from "./triage.js";

beforeEach(() => {
  resetLegendCache();
});

const TODAY = "2026-08-15";
const NOW = "2026-08-15T09:00:00.000Z";

/** §12.8's own USER block, loop for loop. */
const LOOPS: Tr1Loop[] = [
  {
    loopId: "l1",
    intent: "Send Pranjali the Goa villa link",
    origin: "explicit",
    ownerId: "self",
    counterpartyId: "e-pranjali",
    dueUtc: "2026-08-16",
    stake: "low",
    statedAt: "2026-08-12T19:40:00.000Z",
  },
  {
    loopId: "l2",
    intent: "Pranjali's broadband renews",
    origin: "explicit",
    ownerId: "e-pranjali",
    dueUtc: "2026-08-28",
    recurrence: "monthly",
    stake: "medium",
    statedAt: "2026-08-01T10:00:00.000Z",
  },
  {
    loopId: "l3",
    intent: "Compare broadband plans",
    origin: "implicit",
    ownerId: "self",
    stake: "medium",
    statedAt: "2026-08-14T10:00:00.000Z",
  },
  {
    loopId: "l4",
    intent: "Summarise the rent agreement PDF",
    origin: "explicit",
    ownerId: "self",
    stake: "low",
    statedAt: "2026-08-13T10:00:00.000Z",
  },
  {
    loopId: "l5",
    intent: "Book the Ratlam tickets",
    origin: "explicit",
    ownerId: "self",
    dueUtc: "2024-11-02",
    stake: "medium",
    statedAt: "2024-10-30T10:00:00.000Z",
  },
  {
    loopId: "l6",
    intent: "Renew health insurance policy",
    origin: "explicit",
    ownerId: "self",
    dueUtc: "2025-03-15",
    recurrence: "annual",
    stake: "high",
    statedAt: "2025-03-01T10:00:00.000Z",
  },
];

function prompt() {
  return buildTr1Prompt(LOOPS, createAliasTable(), { today: TODAY, now: NOW });
}

describe("triage — the code default for first paint", () => {
  it("non-self → cx", () => {
    expect(tr1DefaultTriage({ ownerId: "e-pranjali", origin: "explicit" })).toEqual({
      triage: "context",
      reason: "owner_not_self",
    });
  });

  it("implicit → ap", () => {
    expect(tr1DefaultTriage({ ownerId: "self", origin: "implicit" })).toEqual({
      triage: "approval",
      reason: "origin_implicit",
    });
  });

  it("everything else → ap, and NEVER au", () => {
    expect(tr1DefaultTriage({ ownerId: "self", origin: "explicit" }).triage).toBe("approval");
    expect(tr1DefaultTriage({ ownerId: "self" }).triage).toBe("approval");
    expect(tr1DefaultTriage({}).triage).toBe("context");
    for (const owner of ["self", "e-x", null, undefined]) {
      for (const origin of ["explicit", "implicit", null, undefined]) {
        expect(tr1DefaultTriage({ ownerId: owner, origin }).triage).not.toBe("auto");
      }
    }
  });
});

describe("triage — the three invariants", () => {
  const byId = (id: string) => LOOPS.find((l) => l.loopId === id)!;

  it("owner not self is ALWAYS cx", () => {
    expect(tr1RuleFor(byId("l2"), NOW)).toEqual({ triage: "context", rule: "owner_not_self" });
  });

  it("past due with no recurrence is cx — read off the state function", () => {
    expect(tr1RuleFor(byId("l5"), NOW)).toEqual({ triage: "context", rule: "lapsed_is_history" });
  });

  it("past due with a FUTURE next occurrence is live, however old the evidence", () => {
    expect(tr1RuleFor(byId("l6"), NOW)).toBeNull();
  });

  it("overrides a wrong class and records the correction with the model's line", () => {
    const built = prompt();
    const answer = parseTr1Response(
      ["J|t2|au|h|looks harmless", "J|t5|ap|m|should book it"].join("\n"),
      built.table,
      LOOPS,
    );
    const flip = tr1Assignments(answer, LOOPS, NOW);
    expect(flip.assignments.map((a) => [a.loopId, a.triage, a.source])).toEqual([
      ["l2", "context", "rule"],
      ["l5", "context", "rule"],
    ]);
    expect(flip.corrections.map((c) => c.rule)).toEqual(["owner_not_self", "lapsed_is_history"]);
    expect(flip.corrections[0].raw).toBe("J|t2|au|h|looks harmless");
    expect(flip.assignments[0].modelTriage).toBe("auto");
    expect(flip.assignments[0].reason).toBe("looks harmless");
  });

  it("raises an implicit au to ap and leaves an implicit cx alone", () => {
    const built = prompt();
    const answer = parseTr1Response("J|t3|au|l|just research", built.table, LOOPS);
    const flip = tr1Assignments(answer, LOOPS, NOW);
    expect(flip.assignments[0].triage).toBe("approval");
    expect(flip.corrections[0].rule).toBe("origin_implicit_never_auto");

    const answer2 = parseTr1Response("J|t3|cx|l|not for the system", built.table, LOOPS);
    const flip2 = tr1Assignments(answer2, LOOPS, NOW);
    expect(flip2.assignments[0].triage).toBe("context");
    expect(flip2.corrections).toHaveLength(0);
  });

  it("leaves a correct answer completely untouched", () => {
    const built = prompt();
    const answer = parseTr1Response("J|t4|au|l|read-and-summarise", built.table, LOOPS);
    const flip = tr1Assignments(answer, LOOPS, NOW);
    expect(flip.assignments[0]).toMatchObject({ triage: "auto", source: "model", rule: null });
    expect(flip.corrections).toHaveLength(0);
  });

  it("ZERO non-self loops end anywhere but cx, whatever the model says", () => {
    const built = prompt();
    const lines = LOOPS.map((_, i) => `J|t${i + 1}|au|h|force auto on everything`).join("\n");
    const answer = parseTr1Response(lines, built.table, LOOPS);
    const flip = tr1Assignments(answer, LOOPS, NOW);
    expect(tr1Violations(flip.assignments, LOOPS, NOW)).toEqual([]);
    const nonSelf = flip.assignments.filter((a) => a.loopId === "l2");
    expect(nonSelf.every((a) => a.triage === "context")).toBe(true);
    expect(flip.assignments.find((a) => a.loopId === "l3")!.triage).not.toBe("auto");
  });

  it("ZERO loops are born past-due as open — the global gate, on this fixture", () => {
    expect(
      pastDueOpenViolations(
        LOOPS.map((l) => ({
          id: l.loopId,
          due_utc: l.dueUtc ?? null,
          recurrence: l.recurrence ?? null,
          origin: l.origin ?? null,
          stated_at: l.statedAt ?? null,
        })),
        NOW,
      ),
    ).toEqual([]);
  });

  it("scores the doc's own answer at accuracy 1.0 (item 3.8 wants ≥ 0.90)", () => {
    const built = prompt();
    const answer = parseTr1Response(
      [
        "J|t1|ap|h|outward-facing message to a person",
        "J|t2|cx|m|owned by Pranjali, not the user",
        "J|t3|ap|l|implicit inference, never auto",
        "J|t4|au|l|read-and-summarise, nothing leaves the device",
        "J|t5|cx|l|past due, no recurrence, historical",
        "J|t6|ap|m|recurring obligation with a future next occurrence",
      ].join("\n"),
      built.table,
      LOOPS,
    );
    const flip = tr1Assignments(answer, LOOPS, NOW);
    const expected = new Map<string, Triage>([
      ["l1", "approval"],
      ["l2", "context"],
      ["l3", "approval"],
      ["l4", "auto"],
      ["l5", "context"],
      ["l6", "approval"],
    ]);
    const score = tr1Accuracy(flip.assignments, expected);
    expect(score.accuracy).toBe(1);
    expect(score.total).toBe(6);
  });
});
