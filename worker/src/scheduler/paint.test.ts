// ===========================================================================
// The first-paint critical path (arch §9.5; evals T-001…T-014).
//
// The four claims under test are the four §9.5 makes: one call on the path,
// three deferrals, three bars, and line-by-line rendering that does not wait
// for the call to complete.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  BARRED,
  DEFERRED,
  LineStream,
  ON_PATH,
  TimingLog,
  admit,
  paintBudget,
  planFirstPaint,
  prewarm,
  prewarmCli,
  type PaintCall,
} from "./paint.js";

describe("one call on the critical path (§9.5.1, T-003)", () => {
  it("admits P-CL1 and nothing else", () => {
    expect(ON_PATH).toEqual(["P-CL1"]);
    expect(admit("P-CL1").admission).toBe("on_path");
  });

  it("defers P-EP1, P-TR1, P-SP1 and media enrichment (T-004…T-007)", () => {
    for (const call of DEFERRED) {
      const result = admit(call);
      expect(result.admission).toBe("deferred");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("bars all three adjudicators BY RULE, not by cold-DB luck (T-008…T-010)", () => {
    for (const call of BARRED) {
      expect(admit(call).admission).toBe("barred");
      expect(admit(call).reason).toMatch(/by rule/);
    }
  });

  it("executes exactly one call when everything is requested at once", () => {
    const all: PaintCall[] = ["P-CL1", "P-EP1", "P-TR1", "P-SP1", "P-AG1", "P-AG2", "P-AG3", "enrich"];
    const plan = planFirstPaint(all);
    expect(plan.executed).toEqual(["P-CL1"]);
    expect(plan.deferred.map((d) => d.call)).toEqual(["P-EP1", "P-TR1", "P-SP1", "enrich"]);
    expect(plan.barred.map((d) => d.call)).toEqual(["P-AG1", "P-AG2", "P-AG3"]);
  });

  it("stops deferring once first paint is complete — deferred, not dropped", () => {
    expect(admit("P-EP1", true).admission).toBe("on_path");
    expect(admit("P-AG1", true).admission).toBe("on_path");
  });
});

describe("line streaming (§9.5.2, T-011)", () => {
  const stw2 = "CL|a1|wants|goa villa\nCL|a1|sends|link tonight\nLP|a1|s|villa link\n";

  it("emits each line as its newline arrives, not when the call ends", () => {
    const seen: number[] = [];
    const stream = new LineStream((line) => seen.push(line.atMs));
    stream.push("CL|a1|wants|goa", 2_100);
    expect(seen).toEqual([]); // no newline yet
    stream.push(" villa\nCL|a1|sends|link", 2_400);
    expect(seen).toEqual([2_400]);
    stream.push(" tonight\n", 3_900);
    stream.end(12_000);
    expect(seen).toEqual([2_400, 3_900]);
    expect(stream.firstLineMs).toBe(2_400);
  });

  it("renders the first claim seconds before the call completes", () => {
    const stream = new LineStream();
    let at = 2_000;
    for (const chunk of stw2.split(/(?<=\n)/)) {
      stream.push(chunk, at);
      at += 1_500;
    }
    stream.end(12_000);
    expect(stream.all).toHaveLength(3);
    expect(stream.firstLineMs).toBe(2_000);
    // Nothing waited for completion — the JSON failure mode, absent.
    expect(stream.buffered).toEqual([]);
  });

  it("flags a trailing fragment that only completion could reveal", () => {
    const stream = new LineStream();
    stream.push("CL|a1|wants|goa villa\nCL|a1|sends", 1_000);
    const tail = stream.end(9_000);
    expect(tail).toHaveLength(1);
    expect(stream.buffered.map((l) => l.text)).toEqual(["CL|a1|sends"]);
  });

  it("skips blank lines rather than rendering empty claims", () => {
    const stream = new LineStream();
    stream.push("\n\nCL|a1|wants|x\n", 500);
    expect(stream.all).toHaveLength(1);
  });
});

describe("pre-warm and instrumentation (§9.5.3 rules 3 and 4, T-014)", () => {
  it("pays the spawn before the first-paint clock starts", () => {
    const warm = prewarm(0, 1_400, 1_500);
    expect(warm.paidBeforeClock).toBe(true);
    expect(warm.savedSeconds).toBeGreaterThan(0);
  });

  it("resolves the CLI binary at connect and caches it", () => {
    const first = prewarmCli();
    expect(first.bin.length).toBeGreaterThan(0);
    // Cached for the process lifetime: the second call does no filesystem work.
    expect(prewarmCli().bin).toBe(first.bin);
  });

  it("says so when the spawn lands on the clock instead", () => {
    expect(prewarm(2_000, 3_500, 1_500).paidBeforeClock).toBe(false);
  });

  it("records TTFT and tokens/sec per model PER CALL TYPE", () => {
    const log = new TimingLog();
    log.record({ model: "sonnet", callType: "P-CL1", ttftMs: 1_900, outputTokens: 600, totalMs: 12_000 });
    log.record({ model: "haiku", callType: "P-TR1", ttftMs: 400, outputTokens: 90, totalMs: 1_800 });
    expect(log.complete).toBe(true);
    expect(log.worstTtft()).toEqual({ "sonnet|P-CL1": 1_900, "haiku|P-TR1": 400 });
    expect(log.all()[0]!.tokensPerSecond).toBe(50);
  });

  it("is not complete when a call reported no TTFT", () => {
    const log = new TimingLog();
    log.record({ model: "sonnet", callType: "P-CL1", ttftMs: 0, outputTokens: 600, totalMs: 12_000 });
    expect(log.complete).toBe(false);
  });
});

describe("the budget (§9.5.4, T-001 and T-002)", () => {
  it("renders the first claim inside 30 s and the triple inside 120 s", () => {
    const budget = paintBudget();
    expect(budget.firstClaimSeconds).toBeLessThanOrEqual(30);
    expect(budget.firstTripleSeconds).toBeLessThanOrEqual(120);
    expect(budget.callsOnPath).toBe(1);
  });

  it("keeps roughly §9.5.4's ~35 s against the 120 s gate", () => {
    expect(paintBudget().firstTripleSeconds).toBeLessThan(45);
  });

  it("charges a cold spawn to the path when the child was not pre-warmed", () => {
    expect(paintBudget({ prewarmed: false }).firstClaimSeconds).toBeGreaterThan(
      paintBudget({ prewarmed: true }).firstClaimSeconds,
    );
  });

  it("scales on ACTUAL output tokens, not the max-output cap", () => {
    const actual = paintBudget({ outputTokens: 600 });
    const capped = paintBudget({ outputTokens: 6_000 });
    expect(capped.firstTripleSeconds).toBeGreaterThan(actual.firstTripleSeconds);
    // The cap does not move the FIRST claim: that is TTFT, not total output.
    expect(capped.firstClaimSeconds).toBe(actual.firstClaimSeconds);
  });

  it("lays the phases out contiguously from connect", () => {
    const { phases } = paintBudget();
    expect(phases[0]!.startS).toBe(0);
    for (let i = 1; i < phases.length; i += 1) {
      expect(phases[i]!.startS).toBe(phases[i - 1]!.endS);
    }
  });
});
