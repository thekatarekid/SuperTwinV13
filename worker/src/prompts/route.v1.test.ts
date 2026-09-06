// ===========================================================================
// route.v1 — the grounded-bar planner (V6 P1 S5.5, Prompts P-08). Zero model
// calls: what is asserted here is the PARSER (what the bar will accept back
// from the model) and the deterministic fallback that runs when the model is
// out — which is also the code half of BAR-02's class accuracy.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  packRouteInput,
  parseRouteOutput,
  planFromIntent,
  routeHeuristic,
  ROUTE_CLASSES,
  type RouteClass,
} from "./route.v1.js";

const NOW = new Date("2026-09-05T10:00:00.000Z");

describe("parseRouteOutput", () => {
  it("reads the P-08 contract, absolute time included", () => {
    const plan = parseRouteOutput(
      `{"class":"aggregate","methods":["structured"],"entities":["Uber","Ola"],` +
        `"time":{"from":"2026-08-01T00:00:00Z","to":"2026-08-31T23:59:00Z"},` +
        `"filters":{"kind":"fact","merchant_in":["Uber","Ola"]},"completeness":"exhaustive","seeds":[]}`,
    );
    expect(plan).not.toBeNull();
    expect(plan!.class).toBe("aggregate");
    expect(plan!.methods).toEqual(["structured"]);
    expect(plan!.completeness).toBe("exhaustive");
    expect(plan!.filters.merchant_in).toEqual(["Uber", "Ola"]);
    expect(plan!.time).toEqual({ from: "2026-08-01T00:00:00Z", to: "2026-08-31T23:59:00Z" });
    expect(plan!.planner).toBe("route.v1");
  });

  it("drops unknown methods, keeps the plan; an unknown class fails the parse", () => {
    const plan = parseRouteOutput(`{"class":"lookup","methods":["lexical","telepathy"],"entities":[],"completeness":"topk"}`);
    expect(plan!.methods).toEqual(["lexical"]);
    expect(parseRouteOutput(`{"class":"vibes","methods":[]}`)).toBeNull();
    expect(parseRouteOutput("no json here")).toBeNull();
    expect(parseRouteOutput("{not json}")).toBeNull();
  });

  it("refuses a backwards or unparseable time range rather than inventing one", () => {
    const back = parseRouteOutput(`{"class":"temporal","methods":["time_window"],"time":{"from":"2026-09-05T00:00:00Z","to":"2026-08-01T00:00:00Z"}}`);
    expect(back!.time).toBeNull();
    const junk = parseRouteOutput(`{"class":"temporal","methods":["time_window"],"time":{"from":"last tuesday","to":"now"}}`);
    expect(junk!.time).toBeNull();
  });

  it("packs the variable half with the clock and the streams it may name", () => {
    const packed = packRouteInput("how much per night?", NOW, ["wa:goa-gang", "wa:family"]);
    expect(packed).toContain("NOW 2026-09-05T10:00:00.000Z");
    expect(packed).toContain("STREAMS wa:goa-gang · wa:family");
    expect(packed.trimEnd().endsWith("QUESTION how much per night?")).toBe(true);
  });
});

describe("routeHeuristic — BAR-02's six shapes, decided by code", () => {
  const cases: { q: string; cls: RouteClass; method?: string }[] = [
    { q: "how much per night?", cls: "lookup" },
    { q: "how much on cabs last month", cls: "aggregate", method: "structured" },
    { q: "what happened tuesday afternoon", cls: "temporal", method: "time_window" },
    { q: "who recommended the place rohan mentioned", cls: "multihop", method: "graph" },
    { q: "did karan ever pay", cls: "absence", method: "time_window" },
    { q: "gst on hotel rooms", cls: "general" },
  ];

  for (const c of cases) {
    it(`${JSON.stringify(c.q)} → ${c.cls}`, () => {
      const plan = routeHeuristic(c.q, NOW);
      expect(plan.class).toBe(c.cls);
      if (c.method) expect(plan.methods).toContain(c.method);
      expect(plan.planner).toBe("heuristic");
    });
  }

  it("class accuracy over the BAR-02 set is 100% — the gate is 90%", () => {
    const hits = cases.filter((c) => routeHeuristic(c.q, NOW).class === c.cls).length;
    expect(hits / cases.length).toBeGreaterThan(0.9);
  });

  it("an aggregate is exhaustive and carries the period it named", () => {
    const plan = routeHeuristic("how much did I spend on cabs last month", NOW);
    expect(plan.class).toBe("aggregate");
    expect(plan.completeness).toBe("exhaustive");
    expect(plan.time).not.toBeNull();
    expect(plan.time!.from.slice(0, 7)).toBe("2026-08");
  });

  it("an absence scan is exhaustive with a range, never a top-k", () => {
    const plan = routeHeuristic("did karan ever pay the advance", NOW);
    expect(plan.class).toBe("absence");
    expect(plan.completeness).toBe("exhaustive");
    expect(plan.time).not.toBeNull();
    expect(plan.seeds).toContain("karan");
  });

  it("imperatives are actions and corrections are corrections", () => {
    expect(routeHeuristic("plan hampi trek in october", NOW).class).toBe("action");
    expect(routeHeuristic("book the anjuna villa", NOW).class).toBe("action");
    expect(routeHeuristic("this is karan's task, not mine", NOW).class).toBe("correction");
    expect(routeHeuristic("don't do this again", NOW).class).toBe("correction");
  });

  it("a locked thread reads a bare follow-up as a correction on the object", () => {
    expect(routeHeuristic("actually make it november", NOW).class).not.toBe("correction");
    expect(routeHeuristic("actually make it november", NOW, { locked: true }).class).toBe("correction");
  });

  it("every class it can return is a declared class", () => {
    const qs = ["how much per night?", "list all my uber rides", "yesterday", "who is rohan's cousin", "gst rate", "add a task"];
    for (const q of qs) expect(ROUTE_CLASSES).toContain(routeHeuristic(q, NOW).class);
  });
});

describe("planFromIntent — the legacy four-way seam mapped onto a plan", () => {
  it("keeps action and correction, and never hands a question an empty method list", () => {
    expect(planFromIntent("action", "plan a trek", NOW).class).toBe("action");
    expect(planFromIntent("correction", "that's wrong", NOW).class).toBe("correction");
    const q = planFromIntent("question", "gst on hotel rooms", NOW);
    expect(q.class).toBe("lookup");
    expect(q.methods.length).toBeGreaterThan(0);
    expect(q.planner).toBe("intent");
  });
});
