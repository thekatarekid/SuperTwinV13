// ===========================================================================
// DECIDE v1 (build P1.4, spec §8.4): validation is conservative on nonsense —
// an unknown risk class degrades to advise-only (never auto), an unknown
// schedule mode confirms, an unknown closure verdict only suggests.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { DECIDE_V1_SYSTEM, validateDecideOutput } from "./decide.v1.js";

describe("decide.v1", () => {
  it("carries the spec §8.4 core verbatim markers", () => {
    expect(DECIDE_V1_SYSTEM).toContain("You run for ONE space");
    expect(DECIDE_V1_SYSTEM).toContain("anything moving money or messaging");
    expect(DECIDE_V1_SYSTEM).toContain("False close = data loss");
    expect(DECIDE_V1_SYSTEM).toContain("Age-band policy is hard. JSON only.");
  });

  it("throws on a non-object top level (the repair trigger)", () => {
    expect(() => validateDecideOutput(null)).toThrow(/single JSON object/);
  });

  it("parses the spec example shape", () => {
    const out = validateDecideOutput({
      space: "sp_goa_dec",
      chapters: [
        { id: "ch_flights", label: "Flights", status: "active", episodes: ["ep_412"], target: "2026-08-29" },
      ],
      tasks: [
        {
          title: "Book flights CCU-GOI 18 Dec, return 21 Dec",
          type: "explicit",
          category: "transaction",
          risk_class: "approve-final",
          owner: "self",
          chapter: "Flights",
          due: "2026-08-29",
          evidence: [{ event_ids: ["e1"], quote: "lets lock goa 18-21 dec" }],
          confidence: 0.9,
        },
      ],
      schedules: [
        { task: "web check-in", fire_at: "2026-12-16T07:00+05:30", mode: "auto", reason: "opens T-48h" },
      ],
      closures: [
        { task: "tsk_pool", verdict: "suggest_close", outcome: "done", reason: "one-sided", confidence: 0.55 },
      ],
      followups: [],
      plan: { next: ["flights (awaiting approval)", "villa shortlist"] },
    });
    expect(out.chapters[0].label).toBe("Flights");
    expect(out.tasks[0].risk_class).toBe("approve-final");
    expect(out.schedules[0].mode).toBe("auto");
    expect(out.closures[0].verdict).toBe("suggest_close");
    expect(out.plan).toEqual({ next: ["flights (awaiting approval)", "villa shortlist"] });
    expect(out.skipped).toHaveLength(0);
  });

  it("degrades an unknown risk class to advise-only, NEVER auto", () => {
    const out = validateDecideOutput({
      tasks: [{ title: "wire the deposit", risk_class: "definitely-auto", confidence: 0.9 }],
    });
    expect(out.tasks[0].risk_class).toBe("advise-only");
  });

  it("confirms any schedule mode that is not exactly 'auto'", () => {
    const out = validateDecideOutput({ schedules: [{ task: "check", mode: "AUTO!" }] });
    expect(out.schedules[0].mode).toBe("confirm");
  });

  it("degrades an unknown closure verdict to suggest_close and outcome to done", () => {
    const out = validateDecideOutput({
      closures: [{ task: "tsk_1", verdict: "closed", outcome: "finished", confidence: 0.99 }],
    });
    expect(out.closures[0].verdict).toBe("suggest_close");
    expect(out.closures[0].outcome).toBe("done");
  });

  it("keeps cancellation outcomes as cancelled, and skips entries missing keys", () => {
    const out = validateDecideOutput({
      closures: [{ task: "tsk_1", verdict: "close", outcome: "cancelled", confidence: 0.9 }],
      tasks: [{ type: "explicit" }],
    });
    expect(out.closures[0].outcome).toBe("cancelled");
    expect(out.tasks).toHaveLength(0);
    expect(out.skipped[0].section).toBe("tasks");
  });
});
