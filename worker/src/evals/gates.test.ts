import { describe, expect, it } from "vitest";

import { breachedGates, HARD_GATES, isHardGate, measureGates } from "./gates.js";

describe("V13 gate registry", () => {
  it("carries the hard-gate lists of both eval docs", () => {
    for (const id of [
      "containment",
      "risky_without_token",
      "pass_liveness",
      "over_creation",
      "false_auto_merge",
      "false_auto_close",
      "false_receiver_assignment",
      "guess_rate",
      "auto_schedule_policy_violation",
      "challenge_ignore",
      "login_automation",
      "trigger_gate",
      "trace_coverage",
      "idempotency",
    ]) {
      expect(isHardGate(id), id).toBe(true);
    }
    expect(HARD_GATES).toHaveLength(16);
    expect(isHardGate("bundle_purity")).toBe(false);
  });

  it("a hard gate nobody fed is no_data, never pass", () => {
    const readings = measureGates([]);
    for (const r of readings) expect(r.status).toBe("no_data");
  });

  it("zero-violation gates breach on one failure; min_rate on the threshold", () => {
    const readings = measureGates([
      { gateId: "guess_rate", passed: false, counted: true },
      { gateId: "containment", passed: true, counted: true },
      { gateId: "containment", passed: true, counted: true },
      { gateId: "containment", passed: false, counted: true }, // 2/3 < 95%
      { gateId: "trace_coverage", passed: true, counted: true },
    ]);
    const by = new Map(readings.map((r) => [r.id, r]));
    expect(by.get("guess_rate")!.status).toBe("fail");
    expect(by.get("containment")!.status).toBe("fail");
    expect(by.get("trace_coverage")!.status).toBe("pass");
    expect(breachedGates(readings).map((r) => r.id).sort()).toEqual(["containment", "guess_rate"]);
  });

  it("over_creation is a max-fail-rate gate: 1 fail in 20 holds, 3 in 20 breaches", () => {
    const feed = (fails: number) =>
      measureGates(
        Array.from({ length: 20 }, (_, i) => ({
          gateId: "over_creation",
          passed: i >= fails,
          counted: true,
        })),
      ).find((r) => r.id === "over_creation")!;
    expect(feed(1).status).toBe("pass");
    expect(feed(3).status).toBe("fail");
  });

  it("an unknown gate id is tracked — printed, never asserted", () => {
    const readings = measureGates([{ gateId: "bundle_purity", passed: false, counted: true }]);
    const r = readings.find((x) => x.id === "bundle_purity")!;
    expect(r.status).toBe("tracked");
    expect(r.hard).toBe(false);
    expect(breachedGates(readings)).toEqual([]);
  });

  it("uncounted (pending) inputs feed nothing", () => {
    const readings = measureGates([{ gateId: "guess_rate", passed: false, counted: false }]);
    expect(readings.find((r) => r.id === "guess_rate")!.status).toBe("no_data");
  });
});
