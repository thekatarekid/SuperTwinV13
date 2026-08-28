import { afterEach, describe, expect, it } from "vitest";

import { stubExecutor } from "./executors/stub.js";
import { goodFixture } from "./testutil.js";
import type { Fixture } from "./fixtures.js";
import { stubJudge } from "./judge.js";
import { registerExecutor, runCase, runSuite, unregisterExecutor } from "./runner.js";

const PASS = "selftest.stub";

function stubFixture(overrides: Partial<Fixture> = {}): Fixture {
  return goodFixture({
    id: "STB-01",
    category: "STB",
    pass: PASS,
    mode: "code",
    selftest: true,
    input_events: [{ stub: { output: { fine: true } } }],
    ...overrides,
  });
}

describe("runCase with the stub pass", () => {
  registerExecutor(PASS, stubExecutor);
  afterEach(() => registerExecutor(PASS, stubExecutor));

  it("is pending when no executor is registered for the pass", async () => {
    unregisterExecutor(PASS);
    const r = await runCase(stubFixture(), {});
    expect(r.status).toBe("pending");
    expect(r.reason).toContain("no executor registered");
  });

  it("is pending for a live case with no judge", async () => {
    const r = await runCase(stubFixture({ mode: "live" }), {});
    expect(r.status).toBe("pending");
    expect(r.reason).toContain("no judge");
  });

  it("passes a clean code case", async () => {
    const r = await runCase(stubFixture(), {});
    expect(r.status).toBe("pass");
    expect(r.judgeVerdict).toBeNull();
  });

  it("fails a code case whose executor says ok: false", async () => {
    const r = await runCase(stubFixture({ input_events: [{ stub: { ok: false, output: {} } }] }), {});
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("code assertions failed");
  });

  it("fails hard on a code-detected wrong[] violation", async () => {
    const r = await runCase(
      stubFixture({
        wrong: [{ label: "cursor-skip", assert_absent: "cursor advances past undispatched events" }],
        input_events: [{ stub: { output: {}, violations: [{ label: "cursor-skip", note: "jumped 3 events" }] } }],
      }),
      {},
    );
    expect(r.status).toBe("fail");
    expect(r.wrongHits).toEqual([{ label: "cursor-skip", by: "code", note: "jumped 3 events" }]);
  });

  it("still fails on a violation label the fixture never declared, with a note", async () => {
    const r = await runCase(
      stubFixture({ input_events: [{ stub: { output: {}, violations: [{ label: "novel-bug" }] } }] }),
      {},
    );
    expect(r.status).toBe("fail");
    expect(r.notes.join(" ")).toContain("not a wrong[] label");
  });

  it("fails, not throws, when the executor throws", async () => {
    const r = await runCase(stubFixture({ input_events: [{ stub: { throw: "boom" } }] }), {});
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("executor threw: boom");
  });

  it("passes a live case the judge grades satisfied", async () => {
    const r = await runCase(
      stubFixture({ mode: "live", input_events: [{ stub: { output: { marker: "verdict:satisfied" } } }] }),
      { judge: stubJudge },
    );
    expect(r.status).toBe("pass");
    expect(r.judgeVerdict).toBe("satisfied");
  });

  it("fails a live case on partial — behavior, not benefit of the doubt", async () => {
    const r = await runCase(
      stubFixture({ mode: "live", input_events: [{ stub: { output: { marker: "verdict:partial" } } }] }),
      { judge: stubJudge },
    );
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("judge: expected partial");
  });

  it("fails a live case when the judge reports a wrong[] hit, even if satisfied", async () => {
    const r = await runCase(
      stubFixture({
        mode: "live",
        wrong: [{ label: "task-theft", assert_absent: "a task owned by self" }],
        input_events: [{ stub: { output: { marker: "verdict:satisfied hits:task-theft" } } }],
      }),
      { judge: stubJudge },
    );
    expect(r.status).toBe("fail");
    expect(r.wrongHits.map((w) => w.label)).toEqual(["task-theft"]);
    expect(r.wrongHits[0]!.by).toBe("judge");
  });
});

describe("runSuite", () => {
  registerExecutor(PASS, stubExecutor);

  it("tallies categories and feeds gates from cases and observations", async () => {
    const fixtures = [
      stubFixture({ id: "STB-01", gates: ["containment"] }),
      stubFixture({
        id: "STB-02",
        gates: ["containment", "idempotency"],
        input_events: [{ stub: { ok: false, output: {} } }],
      }),
      stubFixture({
        id: "STB-03",
        gates: [],
        input_events: [
          { stub: { output: {}, gate_observations: [{ gateId: "trace_coverage", passed: true, counted: true }] } },
        ],
      }),
      stubFixture({ id: "STB-04", pass: "nobody-home" }),
    ];
    const suite = await runSuite(fixtures);
    expect(suite.totals).toEqual({ total: 4, pass: 2, fail: 1, pending: 1 });
    expect(suite.categories).toEqual([
      { category: "STB", total: 4, pass: 2, fail: 1, pending: 1, passRate: 2 / 3 },
    ]);

    const gate = (id: string) => suite.gates.find((g) => g.id === id)!;
    // containment: 1 pass + 1 fail = 50% < 95% → the hard gate breaches.
    expect(gate("containment").status).toBe("fail");
    expect(gate("containment").value).toBeCloseTo(0.5);
    // idempotency: fed one failing case → zero-violations gate breaches.
    expect(gate("idempotency").status).toBe("fail");
    // trace_coverage: fed only by the observation → pass.
    expect(gate("trace_coverage").status).toBe("pass");
    // an unfed hard gate reads no_data, never pass.
    expect(gate("login_automation").status).toBe("no_data");
  });

  it("a pending case feeds no gate", async () => {
    const suite = await runSuite([stubFixture({ pass: "nobody-home", gates: ["containment"] })]);
    expect(suite.gates.find((g) => g.id === "containment")!.status).toBe("no_data");
  });
});
