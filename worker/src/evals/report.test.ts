import { describe, expect, it } from "vitest";

import { stubExecutor } from "./executors/stub.js";
import { goodFixture } from "./testutil.js";
import { renderReport, verdict } from "./report.js";
import { registerExecutor, runSuite } from "./runner.js";

registerExecutor("selftest.stub", stubExecutor);

const base = {
  category: "STB",
  pass: "selftest.stub",
  mode: "code" as const,
  selftest: true,
};

describe("renderReport / verdict", () => {
  it("renders categories, gates and failures, and turns red on a failed case", async () => {
    const suite = await runSuite([
      goodFixture({ ...base, id: "STB-01", gates: ["containment"], input_events: [{ stub: { output: {} } }] }),
      goodFixture({
        ...base,
        id: "STB-02",
        gates: ["idempotency"],
        wrong: [{ label: "double-ingest", assert_absent: "an event ingested twice" }],
        input_events: [{ stub: { output: {}, violations: [{ label: "double-ingest" }] } }],
      }),
      goodFixture({ ...base, id: "STB-03", pass: "not-registered" }),
    ]);
    const text = renderReport(suite, "evals/v13");
    expect(text).toContain("STB");
    expect(text).toContain("failures (1):");
    expect(text).toContain("wrong[double-ingest] by code");
    expect(text).toContain("pending (1):");
    expect(text).toContain("no executor registered");
    expect(text).toContain("FAIL   idempotency");
    expect(text).toContain("VERDICT: red");
    expect(verdict(suite).ok).toBe(false);
    expect(verdict(suite).reasons.join(" ")).toContain("idempotency");
  });

  it("is green when everything passes and hard gates hold", async () => {
    const suite = await runSuite([
      goodFixture({ ...base, id: "STB-01", gates: ["containment"], input_events: [{ stub: { output: {} } }] }),
    ]);
    expect(verdict(suite).ok).toBe(true);
    expect(renderReport(suite, "evals/v13")).toContain("VERDICT: green");
  });
});
