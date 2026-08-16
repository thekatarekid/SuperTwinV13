import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The self-test set includes wire-layer fixtures (S-901..903), so the product
// executors have to be registered for them to run at all.
import "./executors/index.js";
import { loadDirectory, type Fixture } from "./fixtures.js";
import { GATES, breaches, getGate, measureGates } from "./gates.js";
import { renderCategories, renderFailures, renderGates, renderPending, renderReport, verdict } from "./report.js";
import { runSuite, type SuiteResult } from "./runner.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SELFTEST = join(ROOT, "evals", "selftest");
const loaded = loadDirectory(SELFTEST);

function clone(id: string): Fixture {
  const found = loaded.fixtures.find((f) => f.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return structuredClone(found);
}

async function suiteWithFailures(): Promise<SuiteResult> {
  const broken = clone("A-901");
  (broken.expect.claims as { subject: string }[])[0]!.subject = "a9";
  const alsoBroken = clone("S-901");
  (alsoBroken.expect.state as Record<string, unknown>).round_trip_stable = false;
  return runSuite([clone("A-902"), broken, alsoBroken], { mode: "frozen" });
}

describe("the §14.2 gate registry", () => {
  it("carries every gate with a machine-checkable rule", () => {
    expect(GATES.length).toBeGreaterThan(80);
    for (const gate of GATES) {
      expect(gate.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(gate.failsIf.length).toBeGreaterThan(0);
      if (!gate.reported) expect(gate.threshold).not.toBeNull();
    }
    expect(new Set(GATES.map((g) => g.id)).size).toBe(GATES.length);
  });

  it("keeps the row that killed four systems at zero tolerance", () => {
    const gate = getGate("all_model_output_discarded")!;
    expect(gate.critical).toBe(true);
    expect(breaches(gate, 1)).toBe(true);
    expect(breaches(gate, 0)).toBe(false);
  });

  it("applies each comparator the way §14.2 words it", () => {
    expect(breaches(getGate("claim_subject_accuracy")!, 0.94)).toBe(true);
    expect(breaches(getGate("claim_subject_accuracy")!, 0.95)).toBe(false);
    expect(breaches(getGate("episodes_wrong_attach_rate")!, 0.03)).toBe(true);
    expect(breaches(getGate("enrich_passes_per_episode")!, 3)).toBe(true);
    expect(breaches(getGate("enrich_passes_per_episode")!, 2)).toBe(false);
    expect(breaches(getGate("spaces_count_vs_gold")!, 30)).toBe(true);
    expect(breaches(getGate("spaces_count_vs_gold")!, -10)).toBe(false);
  });

  it("never asserts the row §14.2 says is reported only", () => {
    const reading = measureGates([
      { gateId: "wire_char_saving", passed: false, counted: true, metrics: { char_saving_pct: 0 } },
    ]).find((r) => r.gate.id === "wire_char_saving")!;
    expect(reading.status).toBe("reported");
  });

  it("reports a gate nobody measured as no_data, never pass", () => {
    const readings = measureGates([]);
    expect(readings.every((r) => r.status === "no_data" || r.status === "reported")).toBe(true);
  });

  it("takes the worst value, not the average, when several cases measure one gate", () => {
    const reading = measureGates([
      { gateId: "latency_first_claim_rendered", passed: true, counted: true, metrics: { first_claim_s: 4 } },
      { gateId: "latency_first_claim_rendered", passed: true, counted: true, metrics: { first_claim_s: 41 } },
    ]).find((r) => r.gate.id === "latency_first_claim_rendered")!;
    expect(reading.value).toBe(41);
    expect(reading.status).toBe("fail");
  });
});

describe("the report", () => {
  it("shows a pass rate per category", async () => {
    const suite = await suiteWithFailures();
    const text = renderCategories(suite);
    expect(text).toContain("PER-CATEGORY");
    expect(text).toMatch(/A {3}INGEST +2 +1 +1 +0 +50\.0%/);
    expect(text).toMatch(/S {3}WIRE +1 +0 +1 +0 +0\.0%/);
  });

  it("shows every gate's value beside its threshold", async () => {
    const suite = await suiteWithFailures();
    const text = renderGates(suite.gates);
    expect(text).toContain("GATES (architecture §14.2)");
    expect(text).toContain("wire_round_trip");
    expect(text).toContain("any drift");
    // One wire case ran and failed -> one violation -> the gate is breached.
    const line = text.split("\n").find((l) => l.includes("wire_round_trip"))!;
    expect(line).toMatch(/1 +any drift +FAIL/);
    for (const gate of GATES) expect(text).toContain(gate.id);
  });

  it("prints a diff for EVERY failure, not a summary count", async () => {
    const suite = await suiteWithFailures();
    const text = renderFailures(suite, loaded.fixtures);
    expect(text).toContain("FAILURES (2)");
    expect(text).toContain("FAIL A-901");
    expect(text).toContain("FAIL S-901");
    expect(text).toContain("- expected:");
    expect(text).toContain("+ actual:");
    expect(text).toContain("harness self-test — exact mode");
  });

  it("caps diff lines only when asked, and says how many it hid", async () => {
    const suite = await suiteWithFailures();
    const text = renderFailures(suite, loaded.fixtures, { maxDiffLines: 1 });
    expect(text).toContain("more diff line(s)");
  });

  it("groups pending cases by reason", async () => {
    const stub = clone("A-901");
    stub.stub = true;
    const suite = await runSuite([stub], { mode: "frozen" });
    const text = renderPending(suite);
    expect(text).toContain("PENDING (1)");
    expect(text).toContain("stub");
    expect(text).toContain("A-901");
  });

  it("assembles header, categories, gates, failures and pending in one page", async () => {
    const suite = await suiteWithFailures();
    const text = renderReport(suite, loaded.fixtures, "evals/selftest");
    expect(text).toContain("FROZEN mode");
    expect(text).toContain("no network calls");
    expect(text).toContain("PER-CATEGORY");
    expect(text).toContain("GATES (architecture §14.2)");
    expect(text).toContain("FAILURES (2)");
    expect(text).toContain("breached: wire_round_trip");
  });
});

describe("the verdict", () => {
  it("is green only when no case failed and no gate was breached", async () => {
    const clean = await runSuite(loaded.fixtures, { mode: "frozen" });
    expect(verdict(clean)).toMatchObject({ ok: true, failedCases: 0, breachedGates: [] });

    const dirty = await suiteWithFailures();
    const v = verdict(dirty);
    expect(v.ok).toBe(false);
    expect(v.failedCases).toBe(2);
    expect(v.breachedGates).toContain("wire_round_trip");
  });
});
