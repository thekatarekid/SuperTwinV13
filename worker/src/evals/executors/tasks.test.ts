// The category Q executor over real product code and a real temp DB: the
// fixture's loops land as persisted `loops` rows, the Tasks view is computed
// by the REAL `tasksFrom()`, and the Q invariants — zero non-self tasks, zero
// born-past-due-open, `possibly_done` does not exist — are measured off what
// was stored, not what was intended.

import { describe, expect, it } from "vitest";

import type { Fixture } from "../fixtures.js";
import type { GateObservation, Produced } from "../runner.js";
import { tasksExecutor } from "./tasks.js";

interface LoopOver {
  t: string;
  intent: string;
  origin?: string;
  owner?: string;
  counterparty?: string | null;
  due?: string | null;
  recurrence?: string | null;
  stated_at?: string | null;
  resolution_evidence_event?: number | null;
  user_gesture?: string | null;
  not_useful?: boolean;
  attempt_state?: string | null;
}

function loopOf(over: LoopOver): Record<string, unknown> {
  return {
    origin: "explicit",
    owner: "self",
    counterparty: over.owner ?? "self",
    due: null,
    recurrence: null,
    stated_at: "2026-08-10T09:00:00Z",
    ...over,
  };
}

function fixtureOf(loops: Record<string, unknown>[], over: Partial<Fixture> = {}): Fixture {
  return {
    id: "Q-901",
    category: "Q",
    layer: "tasks",
    call: "[CODE]",
    mode: "steady",
    given: {
      roster: ["self=Aditya Katare", "a1=Pranjali Sachdeva"],
      streams: [],
      events: [
        { n: 1, ts: "2026-08-12T21:04:00Z", who: "self", text: "here — https://booking.com/villa-amara" },
      ],
      open: { episodes: [], loops },
      db: { entities: [], claims: [], arcs: [] },
    },
    frozen_response: "",
    expect: {},
    assert: { mode: "state", gate: null },
    ...over,
  };
}

async function run(fixture: Fixture, response = ""): Promise<Produced> {
  return await tasksExecutor({ fixture, response, mode: "frozen" });
}

function gate(produced: Produced, id: string): GateObservation[] {
  return (produced.gates ?? []).filter((g) => g.gate === id);
}

describe("tasks executor", () => {
  it("a self-owned open loop is a task; the view is computed by tasksFrom", async () => {
    const produced = await run(
      fixtureOf([
        loopOf({ t: "t1", intent: "Send Pranjali the villa link", counterparty: "a1", due: "2026-08-16T18:00:00Z" }),
      ]),
    );
    const tasks = produced.output.tasks as Record<string, unknown>[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].owner).toBe("self");
    expect(tasks[0].state).toBe("open");
    expect(produced.state.non_self_in_tasks).toBe(0);
    expect(gate(produced, "loops_non_user_owner_tasks")[0]?.passed).toBe(true);
    expect(gate(produced, "party_oo_in_tasks")[0]?.passed).toBe(true);
  });

  it("a loop owned by someone else is context — Waiting on others, never Tasks", async () => {
    const produced = await run(
      fixtureOf([
        loopOf({ t: "t1", intent: "Pranjali renews the broadband", owner: "a1", counterparty: "self", due: "2026-08-28T06:00:00Z" }),
      ]),
    );
    expect(produced.output.tasks).toEqual([]);
    const waiting = produced.output.waiting as Record<string, unknown>[];
    expect(waiting).toHaveLength(1);
    expect(waiting[0].owner).toBe("a1");
    expect(gate(produced, "loops_non_user_owner_tasks").every((g) => g.passed)).toBe(true);
  });

  it("a done loop leaves every surface but stays a retained row", async () => {
    const produced = await run(
      fixtureOf([
        loopOf({ t: "t1", intent: "Send the villa link", counterparty: "a1", due: "2026-08-12T18:00:00Z", resolution_evidence_event: 1 }),
      ]),
    );
    expect(produced.output.tasks).toEqual([]);
    expect(produced.output.waiting).toEqual([]);
    const loops = produced.output.loops as Record<string, unknown>[];
    expect(loops).toEqual([{ t: "t1", state: "done", state_reason: "resolution_evidence", retained: true }]);
    expect(gate(produced, "loops_done_retained")[0]?.passed).toBe(true);
  });

  it("explicit and implicit render as two disjoint lists with different verbs", async () => {
    const produced = await run(
      fixtureOf([
        loopOf({ t: "t1", intent: "Book flights to Indore", due: "2026-09-01T06:00:00Z" }),
        loopOf({ t: "t2", intent: "Compare broadband plans", origin: "implicit", stated_at: "2026-06-01T10:00:00Z" }),
      ]),
    );
    const explicit = produced.output.explicit as Record<string, unknown>[];
    const implicit = produced.output.implicit as Record<string, unknown>[];
    expect(explicit.map((e) => e.t)).toEqual(["t1"]);
    expect(implicit.map((e) => e.t)).toEqual(["t2"]);
    expect(explicit[0].verb).not.toBe(implicit[0].verb);
    expect(produced.state.lists_disjoint).toBe(true);
  });

  it("'not useful' writes a user-sourced preference claim and drops, never deletes", async () => {
    const produced = await run(
      fixtureOf([loopOf({ t: "t1", intent: "Compare broadband plans", origin: "implicit", not_useful: true })]),
    );
    const claims = produced.output.claims as Record<string, unknown>[];
    expect(claims).toHaveLength(1);
    expect(claims[0].kind).toBe("preference");
    expect(claims[0].subject).toBe("self");
    expect(claims[0].decided_by).toBe("user");
    expect(produced.output.tasks).toEqual([]);
    const loops = produced.output.loops as Record<string, unknown>[];
    expect(loops[0].state).toBe("dropped");
    expect(loops[0].retained).toBe(true);
  });

  it("a loop born past due reads lapsed with reason 'born lapsed'", async () => {
    const produced = await run(
      fixtureOf([loopOf({ t: "t1", intent: "Book the Ratlam tickets", due: "2024-11-02T06:00:00Z", stated_at: "2024-10-20T09:00:00Z" })]),
    );
    const lapsed = produced.output.lapsed as Record<string, unknown>[];
    expect(lapsed).toEqual([{ t: "t1", state: "lapsed", reason: "born lapsed" }]);
    expect(produced.state.past_due_open_violations).toBe(0);
    expect(gate(produced, "loops_past_due_not_task")[0]?.passed).toBe(true);
  });

  it("possibly_done is refused by name and no row ever carries it", async () => {
    const produced = await run(
      fixtureOf([
        loopOf({ t: "t1", intent: "Send the villa link", due: "2026-08-16T18:00:00Z", attempt_state: "possibly_done" }),
      ]),
    );
    const refusals = produced.output.refusals as Record<string, unknown>[];
    expect(refusals).toEqual([{ t: "t1", state: "possibly_done", rule: "possibly_done_does_not_exist" }]);
    expect(produced.state.abolished_state_rows).toBe(0);
    // The loop itself is untouched — still an open task.
    expect((produced.output.tasks as unknown[]).length).toBe(1);
  });

  it("a P-DD1 'ps' keeps the loop open and raises exactly one one-tap question", async () => {
    const produced = await run(
      fixtureOf(
        [
          loopOf({
            t: "t1",
            intent: "Send Pranjali the villa link",
            counterparty: "a1",
            due: "2026-08-16T18:00:00Z",
            stated_at: "2026-08-12T19:40:00Z",
          }),
        ],
        { call: "P-DD1" },
      ),
      "S|t1|ps|1|0.6|here — https://booking.com/villa-amara",
    );
    const loops = produced.output.loops as Record<string, unknown>[];
    expect(loops[0].state).toBe("open");
    const questions = produced.output.questions as Record<string, unknown>[];
    expect(questions).toHaveLength(1);
    expect(questions[0].kind).toBe("done_check");
    expect(questions[0].options).toBe(2);
    expect(gate(produced, "all_model_output_discarded")[0]?.passed).toBe(true);
  });

  it("a blanket TR1 approval line is reported, never applied (per-loop only)", async () => {
    const produced = await run(
      fixtureOf([
        loopOf({ t: "t1", intent: "Email the landlord", due: "2026-08-20T06:00:00Z" }),
        loopOf({ t: "t2", intent: "Compare broadband plans", origin: "implicit" }),
      ]),
      ["J|t1|ap|h|outward-facing", "J|t2|ap|l|implicit, never auto", "J|all|ap|h|blanket approval"].join("\n"),
    );
    const approvals = produced.output.approvals as Record<string, unknown>[];
    expect(approvals.map((a) => a.t).sort()).toEqual(["t1", "t2"]);
    expect(produced.output.blanket).toEqual([]);
    expect(produced.state.blanket_applied).toBe(0);
    expect(produced.state.unresolved_lines).toBe(1);
    expect(gate(produced, "all_model_output_discarded")[0]?.passed).toBe(true);
  });
});
