// The category N executor over real product code and a real temp DB: the
// frozen T lines land as persisted `loops` rows, the state/triage/party half
// is the code's (§11.4), and the two zero-violation gates are measured off
// what was stored, not what was intended.

import { describe, expect, it } from "vitest";

import type { Fixture } from "../fixtures.js";
import type { GateObservation, Produced } from "../runner.js";
import { loopsExecutor, projectedNextOccurrence } from "./loops.js";

function fixtureOf(over: Partial<Fixture> = {}): Fixture {
  return {
    id: "N-901",
    category: "N",
    layer: "loops",
    call: "[CODE]",
    mode: "steady",
    given: {
      roster: ["self=Aditya Katare", "a1=Pranjali Sachdeva"],
      streams: [],
      events: [{ n: 1, ts: "2026-08-15T09:00:00Z", who: "self", text: "i'll send the link tonight" }],
      open: { episodes: [], loops: [] },
      db: { entities: [], claims: [], arcs: [] },
    },
    frozen_response: "",
    expect: {},
    assert: { mode: "state", gate: null },
    ...over,
  };
}

async function run(fixture: Fixture, response: string): Promise<Produced> {
  return await loopsExecutor({ fixture, response, mode: "frozen" });
}

function gate(produced: Produced, id: string): GateObservation[] {
  return (produced.gates ?? []).filter((g) => g.gate === id);
}

describe("loops executor", () => {
  it("persists an explicit commitment as an open, task-eligible loop", async () => {
    const produced = await run(
      fixtureOf(),
      "T|1|self|a1|ex|i2t|m|d|2026-08-15T18:00Z|-|0.95|Send Pranjali the villa link",
    );
    const loops = produced.output.loops as Record<string, unknown>[];
    expect(loops).toHaveLength(1);
    expect(loops[0].owner).toBe("self");
    expect(loops[0].counterparty).toBe("a1");
    expect(loops[0].state).toBe("open");
    expect(loops[0].horizon).toBe("today");
    expect(loops[0].is_task).toBe(true);
    // stated_at came from the event ts, so the row is dated when it was SAID.
    expect(produced.state.tasks).toBe(1);
    expect(gate(produced, "loops_born_past_due_open")[0]?.passed).toBe(true);
    expect(gate(produced, "all_model_output_discarded")[0]?.passed).toBe(true);
  });

  it("a loop born with a past due is lapsed, never open (§11.4)", async () => {
    const produced = await run(
      fixtureOf(),
      "T|1|self|a1|ex|i2t|m|d|2024-11-02|-|0.9|Book the Ratlam tickets",
    );
    expect(produced.state.states).toEqual(["lapsed"]);
    expect(produced.state.past_due_open_violations).toBe(0);
    expect(produced.state.tasks).toBe(0);
    // Retained as a row — history, not a skip.
    expect(produced.state.rows).toBe(1);
    expect(gate(produced, "loops_past_due_not_task")[0]?.passed).toBe(true);
    expect(gate(produced, "loops_done_retained")[0]?.passed).toBe(true);
  });

  it("a past due with a live recurrence projects forward and stays open", async () => {
    const produced = await run(
      fixtureOf(),
      "T|1|self|-|ex|slf|m|y|2025-09-01|annual||Renew the health insurance",
    );
    expect(produced.state.states).toEqual(["open"]);
    expect(produced.state.next_occurrences).toEqual(["2026-09-01T00:00:00.000Z"]);
    expect(gate(produced, "loops_recurring_live")[0]?.passed).toBe(true);
    // The stored column agrees with a fresh projection off the row.
    expect(
      projectedNextOccurrence({ due_utc: "2025-09-01", recurrence: "annual" }),
    ).toBe("2026-09-01T00:00:00.000Z");
  });

  it("a loop owned by someone else is context and never a task (§11.3.1)", async () => {
    const produced = await run(
      fixtureOf({
        given: {
          ...fixtureOf().given,
          events: [{ n: 1, ts: "2026-08-13T14:00:00Z", who: "a1", text: "i need to renew my broadband" }],
        },
      }),
      "T|1|a1|-|ex|slf|m|mo|2026-09-01|-||Pranjali needs to renew her broadband",
    );
    expect(produced.state.triages).toEqual(["context"]);
    expect(produced.state.owners).toEqual(["a1"]);
    expect(produced.state.tasks).toBe(0);
    expect(gate(produced, "loops_non_user_owner_tasks")[0]?.passed).toBe(true);
  });

  it("an implicit loop is never auto, and a stale one defaults to latent", async () => {
    const fresh = await run(fixtureOf(), "T|1|self|-|im|slf|m|n|-|-|0.6|Move off ACT broadband");
    expect(fresh.state.triages).toEqual(["approval"]);
    expect(fresh.state.auto_count).toBe(0);

    const stale = await run(
      fixtureOf({
        given: {
          ...fixtureOf().given,
          events: [{ n: 1, ts: "2026-06-01T10:00:00Z", who: "self", text: "the wifi is still terrible" }],
        },
      }),
      "T|1|self|-|im|slf|l|n|-|-|0.55|Sort out the study wifi",
    );
    expect(stale.state.states).toEqual(["latent"]);
    expect(stale.state.state_reasons).toEqual(["no_due_stale"]);
  });

  it("claim lines stay claims and an empty answer produces no loops", async () => {
    const habit = await run(fixtureOf(), "H|1|self|1p||-|Does a Goa trip every December");
    expect(habit.state.loops).toBe(0);
    expect(habit.state.claim_kinds).toEqual(["habit"]);

    const empty = await run(fixtureOf(), "");
    expect(empty.state.loops).toBe(0);
    expect(empty.state.claims).toBe(0);
    expect(empty.state.accounted).toBe(true);
  });
});
