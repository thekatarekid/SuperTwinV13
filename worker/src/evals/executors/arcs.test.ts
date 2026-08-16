// ===========================================================================
// The category L executor (build item 2.5): the scenario format, the frozen
// P-AG2 block, and the two gate observations it emits per placement.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { validateFixture } from "../fixtures.js";
import type { Produced } from "../runner.js";
import { arcsExecutor } from "./arcs.js";

const FIXTURE = validateFixture(
  {
    id: "L-901",
    category: "L",
    layer: "arcs",
    call: "[CODE]",
    mode: "steady",
    given: {
      roster: [],
      streams: [],
      events: [],
      open: { episodes: [], loops: [] },
      db: { entities: [], claims: [], arcs: [] },
    },
    frozen_response: "",
    expect: {},
    assert: { mode: "no_throw", gate: "arcs_precision" },
  },
  "<test>",
);

async function run(lines: readonly string[]): Promise<Produced> {
  return await arcsExecutor({ fixture: FIXTURE, response: lines.join("\n"), mode: "frozen" });
}

describe("the arcs executor", () => {
  it("binds a cross-source episode over a real bridge, with no model call", async () => {
    const produced = await run([
      "entity|id=a1|type=person",
      "episode|id=ep_seed|entities=a1|label=Goa trip|source=whatsapp",
      "arc|id=n1|label=Goa trip|anchors=a1|sources=whatsapp|episodes=ep_seed",
      "episode|id=ep_new|entities=a9|label=villa page|source=browser",
      "bridge|from=ep_new|to=ep_seed|kind=url|value=site0.com/x|conf=1",
      "place|episode=ep_new",
    ]);
    expect(produced.output.joins).toEqual([{ episode: "ep_new", arc: "n1" }]);
    expect(produced.state.rung).toBe("bridge");
    expect(produced.metrics.model_calls).toBe(0);
    expect(produced.gates?.some((g) => g.gate === "arcs_bridge_recall" && g.passed)).toBe(true);
  });

  it("reads a frozen P-AG2 answer through the real prompt's alias table", async () => {
    const produced = await run([
      "calib|floor=0",
      "episode|id=ep_seed|entities=s0,b0,b1|label=Goa trip|source=whatsapp",
      "arc|id=n1|label=Goa trip|anchors=s0,b0,b1|sources=whatsapp|episodes=ep_seed|cosine=0.8",
      "episode|id=ep_new|entities=s0,x0,x1|label=villa session|source=browser",
      "place|episode=ep_new",
      "#AG2 ep_new",
      "V|e1|jn|n1|0.97|the same villa, already in that thread",
    ]);
    expect(produced.state.rung).toBe("adjudication");
    expect(produced.state.decision).toBe("join");
    expect(produced.metrics.model_calls).toBe(1);
  });

  it("emits the ambient gate observation on every ambient placement", async () => {
    const produced = await run([
      "calib|floor=0",
      "entity|id=a1|type=person",
      "episode|id=ep_seed|entities=a1|label=Goa trip|source=whatsapp",
      "arc|id=n1|label=Goa trip|anchors=a1|sources=whatsapp|episodes=ep_seed|cosine=0.95",
      "episode|id=ep_amb|entities=z9|label=screen frames|source=screen|ambient=1",
      "place|episode=ep_amb",
      "#AG2 ep_amb",
      "V|e1|jn|n1|0.99|they look the same",
    ]);
    expect(produced.output.joins).toEqual([]);
    expect(produced.gates).toContainEqual(
      expect.objectContaining({ gate: "arcs_no_similarity_only_ambient", passed: true }),
    );
  });

  it("honours a declared entity type, so a topic is never weighted as a person", async () => {
    const produced = await run([
      "entity|id=t1|type=topic",
      "entity|id=t2|type=topic",
      "episode|id=ep_seed|entities=t1,t2|label=travel talk|source=whatsapp",
      "arc|id=n1|label=travel talk|anchors=t1,t2|anchor_type=topic|sources=whatsapp|episodes=ep_seed",
      "episode|id=ep_new|entities=t1,t2|label=travel talk|source=browser",
      "place|episode=ep_new",
    ]);
    expect(produced.state.topic_only).toBe(true);
    expect(produced.state.overlap_joins).toBe(false);
  });

  it("reconciles repeatedly and reports whether the ids held", async () => {
    const produced = await run([
      "entity|id=a1|type=person",
      "episode|id=ep_1|entities=a1|label=Goa trip|source=whatsapp",
      "prov|episodes=ep_1",
      "reconcile|times=5",
    ]);
    expect(produced.state.arc_ids_stable).toBe(true);
    expect(produced.state.arcs).toBe(1);
    expect(produced.gates).toContainEqual(
      expect.objectContaining({ gate: "arcs_id_stability", passed: true }),
    );
  });

  it("refuses a record it does not know rather than ignoring it", async () => {
    await expect(run(["nonsense|x=1"])).rejects.toThrow(/unknown record/);
  });

  it("refuses a `place` naming an episode the scenario never declared", async () => {
    await expect(run(["place|episode=ghost"])).rejects.toThrow(/unknown episode/);
  });
});
