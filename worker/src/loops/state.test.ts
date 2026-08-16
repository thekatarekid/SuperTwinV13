import { describe, expect, it } from "vitest";

import {
  ABOLISHED_STATES,
  LOOP_STATES,
  REINFORCEMENT_WINDOW_DAYS,
  addMonthsUtc,
  deriveLoopState,
  deriveLoopStateFromRow,
  isLoopState,
  isRecurring,
  isTaskState,
  loopHorizon,
  loopStateInputsDiffer,
  nextOccurrenceUtc,
  parseRecurrence,
  pastDueOpenViolations,
} from "./state.js";

const NOW = "2026-08-16T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY = 86_400_000;

function daysFromNow(n: number): string {
  return new Date(NOW_MS + n * DAY).toISOString();
}

describe("the closed sets", () => {
  it("possibly_done does not exist (§11.4.3)", () => {
    expect(LOOP_STATES).not.toContain("possibly_done" as never);
    expect(isLoopState("possibly_done")).toBe(false);
    for (const abolished of ABOLISHED_STATES) {
      expect(isLoopState(abolished)).toBe(false);
    }
  });

  it("has exactly the five wire states", () => {
    expect([...LOOP_STATES]).toEqual(["open", "latent", "done", "lapsed", "dropped"]);
  });

  it("tasks are open|latent only", () => {
    expect(isTaskState("open")).toBe(true);
    expect(isTaskState("latent")).toBe(true);
    for (const s of ["done", "lapsed", "dropped"]) expect(isTaskState(s)).toBe(false);
  });
});

describe("parseRecurrence", () => {
  it("reads the fixed cadences", () => {
    expect(parseRecurrence("annual")).toMatchObject({ months: 12 });
    expect(parseRecurrence("Annually")).toMatchObject({ months: 12 });
    expect(parseRecurrence("yearly")).toMatchObject({ months: 12 });
    expect(parseRecurrence("monthly")).toMatchObject({ months: 1 });
    expect(parseRecurrence("quarterly")).toMatchObject({ months: 3 });
    expect(parseRecurrence("half-yearly")).toMatchObject({ months: 6 });
    expect(parseRecurrence("weekly")).toMatchObject({ days: 7 });
    expect(parseRecurrence("fortnightly")).toMatchObject({ days: 14 });
    expect(parseRecurrence("daily")).toMatchObject({ days: 1 });
  });

  it("reads every-N forms", () => {
    expect(parseRecurrence("every 2 weeks")).toMatchObject({ days: 14 });
    expect(parseRecurrence("every other month")).toMatchObject({ months: 2 });
    expect(parseRecurrence("every 18 months")).toMatchObject({ months: 18 });
    expect(parseRecurrence("per year")).toMatchObject({ months: 12 });
  });

  it("keeps the model's own string verbatim", () => {
    expect(parseRecurrence("  Annual  ")?.raw).toBe("Annual");
  });

  it("returns null for 'does not repeat' and for nonsense alike", () => {
    for (const v of ["", "none", "never", "once", "when the moon is right", null, 7]) {
      expect(parseRecurrence(v as unknown)).toBeNull();
    }
    expect(isRecurring("annual")).toBe(true);
    expect(isRecurring("none")).toBe(false);
  });
});

describe("addMonthsUtc clamps the day", () => {
  it("31 Jan + 1 month is 28 Feb in a common year", () => {
    expect(new Date(addMonthsUtc(Date.parse("2026-01-31T00:00:00Z"), 1)).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("31 Jan + 1 month is 29 Feb in a leap year", () => {
    expect(new Date(addMonthsUtc(Date.parse("2024-01-31T00:00:00Z"), 1)).toISOString()).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("crosses the year boundary", () => {
    expect(new Date(addMonthsUtc(Date.parse("2025-11-15T09:30:00Z"), 3)).toISOString()).toBe(
      "2026-02-15T09:30:00.000Z",
    );
  });
});

describe("nextOccurrenceUtc", () => {
  it("projects an annual policy noticed a year ago into the future", () => {
    const next = nextOccurrenceUtc({ dueUtc: "2025-03-04T00:00:00Z", recurrence: "annual" }, NOW);
    expect(next).toBe("2027-03-04T00:00:00.000Z");
  });

  it("projects a monthly rent from years back", () => {
    const next = nextOccurrenceUtc({ dueUtc: "2021-01-05T00:00:00Z", recurrence: "monthly" }, NOW);
    expect(next).toBe("2026-09-05T00:00:00.000Z");
    expect(Date.parse(next!)).toBeGreaterThan(NOW_MS);
  });

  it("always lands strictly after now, for day cadences too", () => {
    for (const rec of ["daily", "weekly", "fortnightly", "every 3 days"]) {
      const next = nextOccurrenceUtc({ dueUtc: "2019-06-01T12:00:00Z", recurrence: rec }, NOW);
      expect(Date.parse(next!)).toBeGreaterThan(NOW_MS);
    }
  });

  it("returns the due itself when it is already in the future", () => {
    expect(nextOccurrenceUtc({ dueUtc: daysFromNow(10), recurrence: "monthly" }, NOW)).toBe(daysFromNow(10));
  });

  it("returns null with no recurrence, no due, or a series that ended", () => {
    expect(nextOccurrenceUtc({ dueUtc: "2020-01-01T00:00:00Z", recurrence: null }, NOW)).toBeNull();
    expect(nextOccurrenceUtc({ dueUtc: null, recurrence: "annual" }, NOW)).toBeNull();
    expect(
      nextOccurrenceUtc(
        { dueUtc: "2020-01-01T00:00:00Z", recurrence: "annual", recurrenceEndsAt: "2024-01-01T00:00:00Z" },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("loopHorizon — computed from due − now", () => {
  it("buckets the future", () => {
    expect(loopHorizon(daysFromNow(0.5), NOW)).toBe("today");
    expect(loopHorizon(daysFromNow(4), NOW)).toBe("week");
    expect(loopHorizon(daysFromNow(20), NOW)).toBe("month");
    expect(loopHorizon(daysFromNow(60), NOW)).toBe("quarter");
    expect(loopHorizon(daysFromNow(200), NOW)).toBe("year");
  });

  it("a past due is the most urgent thing there is", () => {
    expect(loopHorizon(daysFromNow(-400), NOW)).toBe("today");
  });

  it("no due is 'none', never a default date", () => {
    expect(loopHorizon(null, NOW)).toBe("none");
    expect(loopHorizon(undefined, NOW)).toBe("none");
  });
});

describe("the state function — §11.4", () => {
  it("resolution evidence wins first", () => {
    const f = deriveLoopState({ dueUtc: daysFromNow(5), resolutionEvidenceEventId: "ev_9" }, NOW);
    expect(f.state).toBe("done");
    expect(f.stateReason).toBe("resolution_evidence");
    expect(f.taskState).toBe(false);
  });

  it("a user gesture reaches done or dropped", () => {
    expect(deriveLoopState({ userGesture: "done" }, NOW).state).toBe("done");
    expect(deriveLoopState({ userGesture: "dropped" }, NOW).state).toBe("dropped");
  });

  it("a FUTURE due is open however old the evidence is (§11.4.1)", () => {
    const f = deriveLoopState({ dueUtc: daysFromNow(30), statedAt: "2019-01-01T00:00:00Z" }, NOW);
    expect(f.state).toBe("open");
    expect(f.stateReason).toBe("due_future");
  });

  it("the insurance policy: past due + annual recurrence with a future next → open", () => {
    const f = deriveLoopState(
      { dueUtc: "2025-03-04T00:00:00Z", recurrence: "annual", statedAt: "2025-02-01T00:00:00Z" },
      NOW,
    );
    expect(f.state).toBe("open");
    expect(f.stateReason).toBe("recurrence_next_future");
    expect(f.nextOccurrenceUtc).toBe("2027-03-04T00:00:00.000Z");
    expect(f.dueInPast).toBe(true);
  });

  it("the horizon of a recurring loop follows the NEXT occurrence", () => {
    const f = deriveLoopState({ dueUtc: "2026-08-10T00:00:00Z", recurrence: "monthly" }, NOW);
    expect(f.nextOccurrenceUtc).toBe("2026-09-10T00:00:00.000Z");
    expect(f.horizon).toBe("month");
  });

  it("'I'll book the tickets tonight' from 2024: past due, no recurrence → lapsed", () => {
    const f = deriveLoopState({ dueUtc: "2024-05-02T18:00:00Z", intent: "book the tickets" }, NOW);
    expect(f.state).toBe("lapsed");
    expect(f.stateReason).toBe("past_due_no_recurrence");
    expect(f.taskState).toBe(false);
  });

  it("a series with no occurrences left lapses", () => {
    const f = deriveLoopState(
      { dueUtc: "2020-01-01T00:00:00Z", recurrence: "annual", recurrenceEndsAt: "2023-01-01T00:00:00Z" },
      NOW,
    );
    expect(f.state).toBe("lapsed");
    expect(f.stateReason).toBe("recurrence_exhausted");
  });

  it("an unparseable recurrence lapses and SAYS SO — never silently 'open'", () => {
    const f = deriveLoopState({ dueUtc: "2024-01-01T00:00:00Z", recurrence: "whenever Ma reminds me" }, NOW);
    expect(f.state).toBe("lapsed");
    expect(f.stateReason).toBe("recurrence_unparsed");
  });

  it("no due + explicit is open forever — explicit commitments never age out (§11.5.7)", () => {
    const f = deriveLoopState({ origin: "explicit", statedAt: "2018-01-01T00:00:00Z", intent: "send the deck" }, NOW);
    expect(f.state).toBe("open");
    expect(f.stateReason).toBe("no_due_explicit");
  });

  it("no due + implicit, reinforced inside the window → open", () => {
    const f = deriveLoopState(
      { origin: "implicit", statedAt: "2019-01-01T00:00:00Z", lastReinforcedAt: daysFromNow(-3) },
      NOW,
    );
    expect(f.state).toBe("open");
    expect(f.stateReason).toBe("no_due_reinforced");
  });

  it("no due + implicit, stale beyond the window → latent", () => {
    const f = deriveLoopState(
      { origin: "implicit", statedAt: daysFromNow(-(REINFORCEMENT_WINDOW_DAYS + 5)) },
      NOW,
    );
    expect(f.state).toBe("latent");
    expect(f.stateReason).toBe("no_due_stale");
    expect(f.taskState).toBe(true);
  });

  it("no due, no timestamp at all → latent, not open", () => {
    expect(deriveLoopState({ origin: "implicit" }, NOW).stateReason).toBe("no_due_unknown_age");
  });

  it("a loop with an empty intent never becomes open", () => {
    expect(deriveLoopState({ intent: "   ", dueUtc: daysFromNow(3) }, NOW).state).toBe("latent");
  });

  it("only ever returns a real state", () => {
    const inputs = [
      { dueUtc: daysFromNow(3) },
      { dueUtc: daysFromNow(-3) },
      { dueUtc: daysFromNow(-3), recurrence: "monthly" },
      { origin: "implicit" },
      { userGesture: "dropped" as const },
      { resolutionEvidenceEventId: "e1" },
      {},
    ];
    for (const input of inputs) expect(isLoopState(deriveLoopState(input, NOW).state)).toBe(true);
  });

  it("never throws on rubbish dates", () => {
    const f = deriveLoopState({ dueUtc: "not a date", recurrence: "annual", origin: "implicit" }, NOW);
    expect(isLoopState(f.state)).toBe(true);
    expect(f.horizon).toBe("none");
  });
});

describe("rows and recomputation", () => {
  it("reads a snake_case loops row", () => {
    const f = deriveLoopStateFromRow(
      { due_utc: "2025-03-04T00:00:00Z", recurrence: "annual", stated_at: "2025-01-01T00:00:00Z" },
      NOW,
    );
    expect(f.state).toBe("open");
    expect(f.nextOccurrenceUtc).toBe("2027-03-04T00:00:00.000Z");
  });

  it("ignores ingested_at entirely — it is not an input", () => {
    const a = deriveLoopStateFromRow({ due_utc: daysFromNow(-2) } as never, NOW);
    const b = deriveLoopStateFromRow({ due_utc: daysFromNow(-2), ingested_at: NOW } as never, NOW);
    expect(b).toEqual(a);
  });

  it("flags a change in due, recurrence or evidence", () => {
    const base = { dueUtc: "2026-01-01T00:00:00Z", recurrence: "annual" };
    expect(loopStateInputsDiffer(base, { ...base })).toBe(false);
    expect(loopStateInputsDiffer(base, { ...base, dueUtc: "2026-02-01T00:00:00Z" })).toBe(true);
    expect(loopStateInputsDiffer(base, { ...base, recurrence: "monthly" })).toBe(true);
    expect(loopStateInputsDiffer(base, { ...base, resolutionEvidenceEventId: "e1" })).toBe(true);
    expect(loopStateInputsDiffer(base, { ...base, intent: "different words" })).toBe(false);
  });
});

describe("ACCEPTANCE — zero loops born past-due as open", () => {
  const corpus = [
    { id: "l1", due_utc: "2024-05-02T18:00:00Z", intent: "book tickets" },
    { id: "l2", due_utc: "2019-01-01T00:00:00Z", recurrence: "none" },
    { id: "l3", due_utc: "2020-07-07T00:00:00Z", recurrence: "who knows" },
    { id: "l4", due_utc: "2025-03-04T00:00:00Z", recurrence: "annual" },
    { id: "l5", due_utc: daysFromNow(9) },
    { id: "l6", due_utc: "2015-02-02T00:00:00Z", recurrence: "monthly" },
    { id: "l7", due_utc: "2010-01-01T00:00:00Z", recurrence: "annual", recurrence_ends_at: "2012-01-01T00:00:00Z" },
    { id: "l8", origin: "implicit", stated_at: "2017-04-04T00:00:00Z" },
  ];

  it("no past-due loop is open without a projected FUTURE occurrence", () => {
    expect(pastDueOpenViolations(corpus, NOW)).toEqual([]);
  });

  it("every past-due loop that IS open has a future next_occurrence_utc", () => {
    for (const row of corpus) {
      const f = deriveLoopStateFromRow(row, NOW);
      if (f.dueInPast && f.state === "open") {
        expect(f.nextOccurrenceUtc).not.toBeNull();
        expect(Date.parse(f.nextOccurrenceUtc!)).toBeGreaterThan(NOW_MS);
      }
    }
  });

  it("the dead ones are lapsed, and stay out of the task list", () => {
    const states = Object.fromEntries(corpus.map((r) => [r.id, deriveLoopStateFromRow(r, NOW).state]));
    expect(states).toEqual({
      l1: "lapsed",
      l2: "lapsed",
      l3: "lapsed",
      l4: "open",
      l5: "open",
      l6: "open",
      l7: "lapsed",
      l8: "latent",
    });
  });
});
