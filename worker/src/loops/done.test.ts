import { beforeEach, describe, expect, it } from "vitest";

import { createAliasTable } from "../wire/aliases.js";
import { resetLegendCache } from "../prompts/legend.js";
import { buildDd1Prompt, parseDd1Response, type Dd1Loop } from "../prompts/p-dd1.js";
import { packPrompt } from "../wire/pack.js";
import { ABOLISHED_STATES, LOOP_STATES } from "./state.js";
import {
  DONE_OUTCOME_STATES,
  applyDd1Answer,
  dd1CandidateIds,
  dd1Precheck,
  doneQuestionText,
  donePrecision,
  doneStateViolations,
  doneStatesAreLegal,
  evidenceIsAfterStated,
  possiblyWithoutQuestion,
  type DonePrecheckLoop,
} from "./done.js";

beforeEach(() => {
  resetLegendCache();
});

const NOW = "2026-08-15T09:00:00.000Z";

const LOOPS: Dd1Loop[] = [
  {
    loopId: "l1",
    intent: "Send Pranjali the Goa villa link",
    ownerId: "self",
    counterpartyId: "e-pranjali",
    due: "12 Aug",
    statedAt: "2026-08-12T19:40:00.000Z",
  },
  {
    loopId: "l2",
    intent: "Confirm villa to Rohan",
    ownerId: "self",
    counterpartyId: "e-rohan",
    due: "20 Aug",
    statedAt: "2026-08-10T09:00:00.000Z",
  },
];

/**
 * §12.9's transcript. `ev1` (12 Aug 20:04Z) is AFTER both loops were stated;
 * `ev3` (12 Aug 16:40Z) is after l2 (10 Aug) but BEFORE l1 (12 Aug 19:40Z) —
 * which is exactly the "episodes may be older OR newer than the loop" case
 * the evidence rule turns on.
 */
function fixture() {
  const table = createAliasTable();
  const packed = packPrompt(
    {
      tz: "Asia/Kolkata",
      entities: [
        { id: "e-pranjali", name: "Pranjali" },
        { id: "e-rohan", name: "Rohan" },
      ],
      streams: [
        { id: "s1", name: "Pranjali", kind: "dm", participantIds: ["self", "e-pranjali"] },
        { id: "s2", name: "Rohan", kind: "dm", participantIds: ["self", "e-rohan"] },
      ],
      events: [
        {
          id: "ev1",
          streamId: "s1",
          at: "2026-08-12T20:04:00.000Z",
          speakerId: "self",
          text: "here — https://booking.com/villa-amara",
        },
        {
          id: "ev3",
          streamId: "s2",
          at: "2026-08-12T16:40:00.000Z",
          speakerId: "self",
          text: "will confirm the villa by tomorrow for sure",
        },
      ],
    },
    { table },
  );
  if (!packed.ok) throw new Error("pack failed");
  const built = buildDd1Prompt(LOOPS, packed.text, table);
  const eventTimes = new Map([
    ["ev1", "2026-08-12T20:04:00.000Z"],
    ["ev3", "2026-08-12T16:40:00.000Z"],
  ]);
  return { ...built, eventTimes };
}

function apply(wire: string) {
  const f = fixture();
  const answer = parseDd1Response(wire, f.table, LOOPS);
  return applyDd1Answer(answer, LOOPS, { eventTimes: f.eventTimes });
}

// ---------------------------------------------------------------------------

describe("possibly_done does not exist", () => {
  it("is not a loop state, and is named in the ban list", () => {
    expect(LOOP_STATES as readonly string[]).not.toContain("possibly_done");
    expect(ABOLISHED_STATES).toContain("possibly_done");
  });

  it("is not reachable from any outcome this module can produce", () => {
    expect(doneStatesAreLegal()).toBe(true);
    expect(DONE_OUTCOME_STATES as readonly string[]).not.toContain("possibly_done");
  });

  it("Q-028 — a loop carrying the state is a FAIL the checker names", () => {
    expect(
      doneStateViolations([
        { loopId: "l1", state: "done" },
        { loopId: "l2", state: null },
        { loopId: "l3", state: "possibly_done" as never },
        { loopId: "l4", state: "parked" as never },
      ]),
    ).toEqual([
      { loopId: "l3", state: "possibly_done", rule: "possibly_done_does_not_exist" },
      { loopId: "l4", state: "parked", rule: "not_a_loop_state" },
    ]);
  });

  it("Q-029 — ps keeps the loop OPEN and raises exactly one question", () => {
    const applied = apply("S|t2|ps|2|0.6|will confirm the villa by tomorrow");
    expect(applied.outcomes[0]).toMatchObject({
      loopId: "l2",
      action: "keep_open_ask",
      reason: "possibly_needs_confirmation",
      state: null,
      evidenceEventId: "ev3",
    });
    expect(applied.questions).toEqual([
      {
        kind: "done_check",
        targetKind: "loop",
        targetId: "l2",
        question: "Did you: Confirm villa to Rohan?",
        options: ["Yes, done", "Not yet"],
        evidenceEventId: "ev3",
        quote: "will confirm the villa by tomorrow",
      },
    ]);
    expect(possiblyWithoutQuestion(applied)).toEqual([]);
    expect(doneStateViolations(applied.outcomes)).toEqual([]);
  });

  it("a ps answer never writes a state, for any confidence", () => {
    for (const conf of ["0.1", "0.5", "0.99"]) {
      const applied = apply(`S|t1|ps|1|${conf}|maybe`);
      expect(applied.outcomes[0].state).toBeNull();
      expect(applied.questions).toHaveLength(1);
    }
  });
});

describe("the [CODE] pre-check", () => {
  const LIVE: DonePrecheckLoop[] = [
    // Stored resolution evidence — §11.4.5, no model call needed.
    { id: "a", intent: "send the link", resolutionEvidenceEventId: "ev1" },
    // A user tap.
    { id: "b", intent: "book tickets", userGesture: "done" },
    { id: "c", intent: "cancel the plan", userGesture: "dropped" },
    // Past due, no recurrence — history.
    { id: "d", intent: "book the Ratlam tickets", dueUtc: "2024-11-02" },
    // Due in the future — genuinely open, worth asking about.
    { id: "e", intent: "confirm villa", dueUtc: "2026-08-20", origin: "explicit" },
    // Past due but the annual series projects forward — live, worth asking.
    { id: "f", intent: "renew insurance", dueUtc: "2025-03-15", recurrence: "annual" },
  ];

  it("settles everything the state function already knows, with zero model calls", () => {
    const pre = dd1Precheck(LIVE, NOW);
    expect(pre.settled.map((s) => [s.loopId, s.state, s.reason])).toEqual([
      ["a", "done", "resolution_evidence"],
      ["b", "done", "user_gesture"],
      ["c", "dropped", "user_gesture"],
      ["d", "lapsed", "lapsed"],
    ]);
    expect(dd1CandidateIds(pre)).toEqual(["e", "f"]);
    expect(pre.savedFraction).toBeCloseTo(4 / 6);
  });

  it("most historical loops resolve with no model call (item 3.8)", () => {
    const historical: DonePrecheckLoop[] = Array.from({ length: 20 }, (_, i) => ({
      id: `h${i}`,
      intent: "something said in 2024",
      dueUtc: "2024-06-0" + ((i % 9) + 1),
    }));
    const pre = dd1Precheck(historical, NOW);
    expect(pre.candidates).toHaveLength(0);
    expect(pre.savedFraction).toBe(1);
  });

  it("an empty roster is not a division by zero", () => {
    expect(dd1Precheck([], NOW)).toEqual({ settled: [], candidates: [], savedFraction: 0 });
  });
});

describe("evidence must occur AFTER the loop was stated", () => {
  it("compares timestamps, and treats the same instant as after", () => {
    expect(evidenceIsAfterStated("2026-08-13T00:00:00Z", "2026-08-12T00:00:00Z")).toBe(true);
    expect(evidenceIsAfterStated("2026-08-11T00:00:00Z", "2026-08-12T00:00:00Z")).toBe(false);
    expect(evidenceIsAfterStated("2026-08-12T00:00:00Z", "2026-08-12T00:00:00Z")).toBe(true);
    expect(evidenceIsAfterStated(null, "2026-08-12T00:00:00Z")).toBe(false);
    expect(evidenceIsAfterStated("2026-08-12T00:00:00Z", null)).toBe(true);
  });

  it("closes a loop whose evidence is newer than the loop", () => {
    const applied = apply("S|t1|dn|1|0.95|here — https://booking.com/villa-amara");
    expect(applied.outcomes[0]).toMatchObject({
      loopId: "l1",
      action: "close_done",
      reason: "evidence",
      state: "done",
      evidenceEventId: "ev1",
    });
    expect(applied.questions).toHaveLength(0);
  });

  it("refuses to close on evidence that PREDATES the loop — it asks instead", () => {
    // ev3 (12 Aug 16:40Z) is older than l1's stated_at (12 Aug 19:40Z).
    const applied = apply("S|t1|dn|2|0.9|will confirm the villa");
    expect(applied.outcomes[0]).toMatchObject({
      action: "keep_open_ask",
      reason: "evidence_before_stated",
      state: null,
    });
    expect(applied.questions).toHaveLength(1);
    // and the model's line is kept, not dropped.
    expect(applied.outcomes[0].raw).toBe("S|t1|dn|2|0.9|will confirm the villa");
  });

  it("refuses to close on a dn that cites no event at all", () => {
    const applied = apply("S|t1|dn|-|0.9|feels done");
    expect(applied.outcomes[0]).toMatchObject({
      action: "keep_open_ask",
      reason: "evidence_missing",
      state: null,
    });
  });

  it("refuses to close on a dn whose event alias resolves to nothing", () => {
    const applied = apply("S|t1|dn|zz9|0.9|invented");
    expect(applied.outcomes[0]).toMatchObject({
      action: "keep_open_ask",
      reason: "evidence_unresolved",
      state: null,
    });
  });

  it("refuses to close on an untimed event unless the caller allows it", () => {
    const f = fixture();
    const answer = parseDd1Response("S|t1|dn|1|0.9|no clock", f.table, LOOPS);
    expect(applyDd1Answer(answer, LOOPS, {}).outcomes[0].action).toBe("keep_open_ask");
    expect(
      applyDd1Answer(answer, LOOPS, { requireTimedEvidence: false }).outcomes[0].action,
    ).toBe("close_done");
  });

  it("drops a loop with evidence, the same way it closes one", () => {
    const applied = apply("S|t1|dr|1|0.9|trip cancelled");
    expect(applied.outcomes[0]).toMatchObject({
      action: "close_dropped",
      reason: "moot",
      state: "dropped",
      evidenceEventId: "ev1",
    });
  });
});

describe("the doc's own answer", () => {
  const EXPECTED = [
    "S|t1|dn|1|0.95|here — https://booking.com/villa-amara",
    "S|t2|op|-|0.9|",
  ].join("\n");

  it("closes t1 on evidence and leaves t2 open — intent is NOT done", () => {
    const applied = apply(EXPECTED);
    expect(applied.outcomes.map((o) => [o.loopId, o.action, o.state])).toEqual([
      ["l1", "close_done", "done"],
      ["l2", "keep_open", null],
    ]);
    expect(applied.questions).toHaveLength(0);
    expect(doneStateViolations(applied.outcomes)).toEqual([]);
  });

  it("scores precision 1.0 against the labelled fixture (item 3.8 wants ≥ 0.95)", () => {
    const applied = apply(EXPECTED);
    expect(donePrecision(applied, new Set(["l1"]))).toEqual({
      closed: 1,
      correct: 1,
      precision: 1,
    });
  });

  it("a pass that closes nothing has precision 1 by definition, not 0", () => {
    const applied = apply("S|t1|op|-|0.9|\nS|t2|op|-|0.9|");
    expect(donePrecision(applied, new Set()).precision).toBe(1);
  });

  it("reports a finding for a loop that is not on the roster, and applies nothing", () => {
    const f = fixture();
    const answer = parseDd1Response("S|t1|dn|1|0.9|done", f.table, LOOPS);
    const applied = applyDd1Answer(answer, [LOOPS[1]], { eventTimes: f.eventTimes });
    expect(applied.outcomes[0]).toMatchObject({ action: "keep_open", reason: "loop_unknown", state: null });
  });

  it("builds the question from the loop's own words, never invented ones", () => {
    expect(doneQuestionText("Confirm villa to Rohan")).toBe("Did you: Confirm villa to Rohan?");
    expect(doneQuestionText("")).toBe("Is this loop done?");
    expect(doneQuestionText(null)).toBe("Is this loop done?");
  });
});
