// ===========================================================================
// The category R executor (build item 3.3).
//
// The executor drives the REAL write path over a real temp database, so the
// tests here are about the seam: the scenario language, the frozen P-AG3
// answers, the confluence replay, and the gate observations a run emits.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { writeExecutor } from "./write.js";
import type { Fixture } from "../fixtures.js";
import type { Produced } from "../runner.js";

const FIXTURE = { id: "R-000", category: "R", layer: "write" } as unknown as Fixture;

function run(scenario: readonly string[]): Produced {
  return writeExecutor({ fixture: FIXTURE, response: scenario.join("\n"), mode: "frozen" }) as Produced;
}

const WORLD = [
  "entity|id=en1|type=person|name=Rahul Arora",
  "event|id=ev1|ts=2026-03-02T10:00:00Z",
  "event|id=ev3|ts=2026-08-11T10:00:00Z",
];

const KORAMANGALA =
  "claim|kind=fact|tag=F|subject=en1|text=Lives in Koramangala.|said=2026-03-02T10:00:00Z|conf=0.8|event=ev1|quote=my place";
const INDIRANAGAR =
  "claim|kind=fact|tag=F|subject=en1|text=Lives in Indiranagar.|said=2026-08-11T10:00:00Z|conf=0.8|event=ev3|quote=shifting|sim=0.9";

it("reinforces an exact repeat and spends no model call", () => {
  const produced = run([...WORLD, KORAMANGALA, KORAMANGALA]);
  expect(produced.state.routes).toEqual(["insert", "reinforce"]);
  expect(produced.state.claims).toBe(1);
  expect(produced.state.model_calls).toBe(0);
});

it("hands a near hit to the frozen adjudicator and applies the verdict", () => {
  const produced = run([
    ...WORLD,
    KORAMANGALA,
    INDIRANAGAR,
    "#AG3",
    "V|A|B|ctr|b|2026-09-01|0.9|the residence changed",
  ]);
  expect(produced.state.model_calls).toBe(1);
  expect(produced.state.active).toEqual(["Lives in Indiranagar."]);
  expect(produced.state.closed).toEqual([
    { text: "Lives in Koramangala.", reason: "contradiction", valid_to: "2026-09-01" },
  ]);
});

it("measures stated_at precedence and late dislodges rather than assuming them", () => {
  const produced = run([
    ...WORLD,
    INDIRANAGAR.replace("|sim=0.9", ""),
    `${KORAMANGALA}|sim=0.9`,
    "#AG3",
    "V|A|B|ctr|a|2026-09-01|0.9|B was said five months before A",
  ]);
  expect(produced.state.stated_at_precedence).toBe(true);
  expect(produced.state.late_dislodges).toBe(0);
  expect(produced.state.active).toEqual(["Lives in Indiranagar."]);
});

it("replays a corpus in several orders and compares the graphs", () => {
  const produced = run([
    ...WORLD,
    `${KORAMANGALA}|sim=0.9`,
    INDIRANAGAR,
    "confluence|orders=01,10",
    "#AG3",
    "V|A|B|ctr|-|2026-09-01|0.9|the residence changed",
  ]);
  expect(produced.state.confluent).toBe(true);
  const gate = (produced.gates ?? []).find((g) => g.gate === "confluence_order_independence");
  expect(gate?.passed).toBe(true);
});

it("computes a loop key and proves it ignores the two banned fields", () => {
  const produced = run([...WORLD, "loop|owner=en1|counterparty=en2|intent=send the rent receipt"]);
  expect(produced.state.loop_key_ignores_space_arc).toBe(true);
  expect(produced.state.loop_keys).toHaveLength(1);
  expect(String((produced.state.loop_keys as string[])[0])).toMatch(/^[0-9a-f]{40}$/);
});

it("undoes a run and leaves the user's own mutation behind", () => {
  const produced = run([
    ...WORLD,
    `${KORAMANGALA}|run=r1`,
    `${INDIRANAGAR.replace("|sim=0.9", "")}|run=r2`,
    "user_mutation|run=r2|field=text",
    "undo|run=r2",
  ]);
  expect(produced.state.claims).toBe(1);
  expect(produced.state.user_mutations_kept).toBe(1);
  expect(Number(produced.state.reversed)).toBeGreaterThan(0);
});

it("reports zero model output discarded, with the answer lines it could not use", () => {
  const produced = run([
    ...WORLD,
    KORAMANGALA,
    INDIRANAGAR,
    "#AG3",
    "V|A|B|dst|-|-|0.8|two different flats",
    "Y|e1|a summary nobody asked for",
  ]);
  expect(produced.state.model_output_discarded).toBe(0);
  const gate = (produced.gates ?? []).find((g) => g.gate === "all_model_output_discarded");
  expect(gate?.passed).toBe(true);
});

describe("the scenario language", () => {
  it("refuses a field with no '=' rather than guessing what was meant", () => {
    expect(() => run(["entity|id=en1", "claim|nonsense"])).toThrow(/without '='/);
  });

  it("produces an empty graph for an empty scenario", () => {
    const produced = run([]);
    expect(produced.state.claims).toBe(0);
    expect(produced.state.confluent).toBeNull();
  });
});
