// Harness self-test (build item 0.6). The ten hand-written fixtures in
// `evals/selftest/` cover every assertion mode in evals doc §3, in both
// directions: each one must PASS as written, and must FAIL with a usable diff
// once the expectation is mutated. A harness that only ever goes green proves
// nothing about the 1,000 cases it is supposed to police.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The self-test set includes wire-layer fixtures (S-901..903), so the product
// executors have to be registered for them to run at all.
import "./executors/index.js";
import { loadDirectory, type Fixture } from "./fixtures.js";
import {
  canonical,
  evaluate,
  getExecutor,
  registerExecutor,
  runCase,
  runSuite,
  type Produced,
} from "./runner.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SELFTEST = join(ROOT, "evals", "selftest");

const loaded = loadDirectory(SELFTEST);
const byId = new Map(loaded.fixtures.map((f) => [f.id, f]));

function fixture(id: string): Fixture {
  const found = byId.get(id);
  if (!found) throw new Error(`self-test fixture ${id} is missing`);
  return structuredClone(found);
}

async function run(f: Fixture) {
  return runCase(f, { mode: "frozen" });
}

describe("the ten self-test fixtures", () => {
  it("all load without error", () => {
    expect(loaded.errors).toEqual([]);
    expect(loaded.fixtures).toHaveLength(10);
  });

  it("all pass in frozen mode with no network", async () => {
    const suite = await runSuite(loaded.fixtures, { mode: "frozen" });
    expect(suite.results.filter((r) => r.status !== "pass").map((r) => [r.id, r.reason])).toEqual([]);
    expect(suite.totals).toEqual({ total: 10, pass: 10, fail: 0, pending: 0 });
  });
});

describe("exact (A-901)", () => {
  it("passes on byte-identical output regardless of key order", async () => {
    expect((await run(fixture("A-901"))).status).toBe("pass");
  });

  it("fails with a whole-output diff when one field drifts", async () => {
    const f = fixture("A-901");
    (f.expect.claims as { confidence: number }[])[0]!.confidence = 0.94;
    const result = await run(f);
    expect(result.status).toBe("fail");
    expect(result.diffs[0]!.kind).toBe("mismatch");
    expect(canonical(result.diffs[0]!.expected)).toContain("0.94");
    expect(canonical(result.diffs[0]!.actual)).toContain("0.95");
  });
});

describe("set_equal (A-902)", () => {
  it("is order-independent on the listed fields", async () => {
    expect((await run(fixture("A-902"))).status).toBe("pass");
  });

  it("reports what is missing and what is extra", async () => {
    const f = fixture("A-902");
    (f.expect.claims as { subject: string }[])[0]!.subject = "a9";
    const result = await run(f);
    expect(result.status).toBe("fail");
    expect(result.diffs.map((d) => d.kind).sort()).toEqual(["missing", "unexpected"]);
    expect(result.diffs.find((d) => d.kind === "missing")!.path).toBe("claims[0]");
  });

  it("only compares the fields named in assert.on", async () => {
    const f = fixture("A-902");
    f.assert.on = ["kind"];
    (f.expect.claims as { subject: string }[])[0]!.subject = "who cares";
    expect((await run(f)).status).toBe("pass");
  });
});

describe("contains (A-903)", () => {
  it("allows extras but counts them against precision", async () => {
    const result = await run(fixture("A-903"));
    expect(result.status).toBe("pass");
    expect(result.extras).toBe(2);
  });

  it("still fails when an expected item is absent", async () => {
    const f = fixture("A-903");
    (f.expect.claims as { kind: string }[])[0]!.kind = "workflow";
    const result = await run(f);
    expect(result.status).toBe("fail");
    expect(result.diffs[0]!.kind).toBe("missing");
  });
});

describe("absent (A-904)", () => {
  it("passes when the forbidden item is not produced", async () => {
    expect((await run(fixture("A-904"))).status).toBe("pass");
  });

  it("fails the moment the forbidden item shows up", async () => {
    const f = fixture("A-904");
    f.frozen_response = "P|loops|owner=a1,intent=return the drill";
    const result = await run(f);
    expect(result.status).toBe("fail");
    expect(result.diffs[0]!.kind).toBe("forbidden");
    expect(result.diffs[0]!.note).toContain("must not be");
  });
});

describe("state (A-905, S-901)", () => {
  it("compares DB fields after the run", async () => {
    expect((await run(fixture("A-905"))).status).toBe("pass");
  });

  it("fails on a wrong value and on a field the run never recorded", async () => {
    const wrong = fixture("A-905");
    (wrong.expect.state as Record<string, unknown>).tier = "T3";
    const wrongResult = await run(wrong);
    expect(wrongResult.status).toBe("fail");
    expect(wrongResult.diffs[0]).toMatchObject({ kind: "mismatch", path: "state.tier", actual: "T1" });

    const missing = fixture("A-905");
    (missing.expect.state as Record<string, unknown>).seal_mode = "immediate";
    const missingResult = await run(missing);
    expect(missingResult.diffs[0]!.path).toBe("state.seal_mode");
    expect(missingResult.diffs[0]!.kind).toBe("missing");
  });

  it("runs the real STW-2 codec for the round-trip case", async () => {
    const result = await run(fixture("S-901"));
    expect(result.status).toBe("pass");
    expect(result.gate).toBe("wire_round_trip");
    expect(result.metrics.records).toBe(2);
    expect(result.metrics.violations).toBe(0);
  });
});

describe("no_throw (A-906, S-902)", () => {
  it("passes when the executor returns, whatever it produced", async () => {
    expect((await run(fixture("A-906"))).status).toBe("pass");
  });

  it("passes on random bytes fed to the real parser — and records the violations", async () => {
    const result = await run(fixture("S-902"));
    expect(result.status).toBe("pass");
    expect(result.metrics.violations).toBeGreaterThan(0);
    expect(result.metrics.records).toBe(0);
  });

  it("fails, with the message, when the run throws", async () => {
    const f = fixture("A-906");
    f.frozen_response = "X|the executor exploded";
    const result = await run(f);
    expect(result.status).toBe("fail");
    expect(result.diffs[0]!.kind).toBe("threw");
    expect(result.reason).toContain("the executor exploded");
  });
});

describe("budget (A-907)", () => {
  it("passes inside the bound", async () => {
    const result = await run(fixture("A-907"));
    expect(result.status).toBe("pass");
    expect(result.metrics.tokens).toBe(1180);
  });

  it("fails over the bound, and when the metric was never measured", async () => {
    const over = fixture("A-907");
    over.assert.bound = { tokens: { max: 1000 } };
    const overResult = await run(over);
    expect(overResult.status).toBe("fail");
    expect(overResult.diffs[0]).toMatchObject({ kind: "bound", path: "metrics.tokens", actual: 1180 });

    const absent = fixture("A-907");
    absent.assert.bound = { ttft_ms: { max: 500 } };
    const absentResult = await run(absent);
    expect(absentResult.diffs[0]).toMatchObject({ kind: "missing", path: "metrics.ttft_ms" });
  });
});

describe("contains against the real codec (S-903)", () => {
  it("decodes the §2 example line into a habit claim about a1", async () => {
    const result = await run(fixture("S-903"));
    expect(result.status).toBe("pass");
  });
});

describe("the executor seam", () => {
  it("reports PENDING — never pass — for a layer nobody has implemented", async () => {
    const f = fixture("A-901");
    f.layer = "promotion";
    const result = await run(f);
    expect(result.status).toBe("pending");
    expect(result.reason).toContain("no executor registered for layer 'promotion'");
  });

  it("reports PENDING for a doc-generated stub", async () => {
    const f = fixture("A-901");
    f.stub = true;
    expect((await run(f)).status).toBe("pending");
  });

  it("lets a layer register its own executor", async () => {
    const produced: Produced = { output: { claims: [{ kind: "habit", subject: "a1", confidence: 0.95 }] }, state: {}, metrics: {} };
    registerExecutor("test_layer", () => produced);
    expect(getExecutor("test_layer")).toBeTypeOf("function");
    const f = fixture("A-901");
    f.layer = "test_layer";
    expect((await run(f)).status).toBe("pass");
  });
});

describe("live mode", () => {
  it("takes the response from the invoker instead of the fixture", async () => {
    const f = fixture("A-901");
    const result = await runCase(f, {
      mode: "live",
      live: async () => ({ response: "P|claims|kind=habit,subject=a1,confidence=0.95", metrics: { tokens: 320 } }),
    });
    expect(result.status).toBe("pass");
    expect(result.metrics.tokens).toBe(320);
  });

  it("re-measures the gates: a live answer that differs fails the case", async () => {
    const result = await runCase(fixture("A-901"), {
      mode: "live",
      live: async () => ({ response: "P|claims|kind=fact,subject=a2,confidence=0.5" }),
    });
    expect(result.status).toBe("fail");
  });

  it("fails the case, not the suite, when the model call throws", async () => {
    const result = await runCase(fixture("A-901"), {
      mode: "live",
      live: async () => {
        throw new Error("quota exceeded");
      },
    });
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("quota exceeded");
  });

  it("is pending when live mode has no invoker", async () => {
    const result = await runCase(fixture("A-901"), { mode: "live" });
    expect(result.status).toBe("pending");
  });
});

describe("suite tallies and gate feeding", () => {
  it("counts per category and never lets a pending case feed a gate", async () => {
    const stub = fixture("S-901");
    stub.stub = true;
    const suite = await runSuite([fixture("S-901"), stub, fixture("A-901")], { mode: "frozen" });
    expect(suite.categories.map((c) => [c.category, c.total, c.pass, c.pending])).toEqual([
      ["A", 1, 1, 0],
      ["S", 2, 1, 1],
    ]);
    const roundTrip = suite.gates.find((g) => g.gate.id === "wire_round_trip")!;
    expect(roundTrip.cases).toBe(1);
    expect(roundTrip.status).toBe("pass");
  });

  it("folds an executor's extra gate observations into their own gates", async () => {
    // A run of real product code measures more than the one thing its case
    // asserts. Each observation is its own datum, so five observations in one
    // case are five entries in the gate's denominator — not one.
    registerExecutor("observing_layer", () => ({
      output: { claims: [{ kind: "habit", subject: "a1", confidence: 0.95 }] },
      state: {},
      metrics: {},
      gates: [
        { gate: "entities_recall", passed: true },
        { gate: "entities_recall", passed: false, note: "a phone in two sources sits on two entities" },
        { gate: "entities_no_silent_guess", passed: true },
        { gate: "not_a_gate_in_14_2", passed: false },
      ],
    }));
    const f = fixture("A-901");
    f.layer = "observing_layer";
    const suite = await runSuite([f], { mode: "frozen" });

    const recall = suite.gates.find((g) => g.gate.id === "entities_recall")!;
    expect(recall.cases).toBe(2);
    expect(recall.value).toBe(0.5);
    expect(recall.status).toBe("fail");

    const silent = suite.gates.find((g) => g.gate.id === "entities_no_silent_guess")!;
    expect(silent.cases).toBe(1);
    expect(silent.value).toBe(0);
    expect(silent.status).toBe("pass");

    // The case's own assertion still feeds its own gate, once.
    expect(suite.results[0].gateObservations).toHaveLength(4);
  });

  it("leaves a gate no_data when the executor observed nothing for it", async () => {
    registerExecutor("silent_layer", () => ({
      output: { claims: [{ kind: "habit", subject: "a1", confidence: 0.95 }] },
      state: {},
      metrics: {},
    }));
    const f = fixture("A-901");
    f.layer = "silent_layer";
    const suite = await runSuite([f], { mode: "frozen" });
    const recall = suite.gates.find((g) => g.gate.id === "entities_recall")!;
    expect(recall.status).toBe("no_data");
    expect(recall.value).toBeNull();
  });

  it("marks a gate no_data when only pending cases mention it", async () => {
    const stub = fixture("S-901");
    stub.stub = true;
    const suite = await runSuite([stub], { mode: "frozen" });
    const roundTrip = suite.gates.find((g) => g.gate.id === "wire_round_trip")!;
    expect(roundTrip.status).toBe("no_data");
    expect(roundTrip.value).toBeNull();
  });
});

describe("canonical comparison", () => {
  it("is key-order independent and distinguishes real differences", () => {
    expect(canonical({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(canonical({ a: [2, { c: 3, d: 4 }], b: 1 }));
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: "1" }));
  });

  it("evaluates every §3 mode through one entry point", () => {
    const f = fixture("A-901");
    const produced: Produced = { output: { claims: [] }, state: {}, metrics: {} };
    expect(evaluate(f, produced).passed).toBe(false);
  });
});
