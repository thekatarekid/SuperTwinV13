// ===========================================================================
// decide.v9 (V6 P1 S3.7, P-05): the prompt carries the P-05 rules verbatim
// (TIM-04 in words), and validation maps the v9 shape onto the applier shape
// conservatively — unknown risk is advise-only, a check_at is never a close,
// an evidence-less "done" is only a proposal, follow-ups never auto.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  DECIDE_V9_SYSTEM,
  EVIDENCED_CLOSURE_CONFIDENCE,
  UNEVIDENCED_CLOSURE_CONFIDENCE,
  validateDecideV9Output,
} from "./decide.v9.js";
import { CLOSE_CONFIDENCE_FLOOR } from "../brain/decide-pass.js";

describe("decide.v9 prompt", () => {
  it("is P-05 verbatim, TIM-04 rule included", () => {
    expect(DECIDE_V9_SYSTEM).toContain("You run for ONE space with its full state and the new committed items.");
    expect(DECIDE_V9_SYSTEM).toContain("Milestones only if the goal has stages.");
    expect(DECIDE_V9_SYSTEM).toContain('One-sided intent → "check_at" at the expected time.');
    expect(DECIDE_V9_SYSTEM).toContain("Never fire early: a");
    expect(DECIDE_V9_SYSTEM).toContain("fire_at is never before the evidence says the window opens (TIM-04).");
    expect(DECIDE_V9_SYSTEM).toContain("Past dates from history are never due; they are closure questions.");
    expect(DECIDE_V9_SYSTEM).toContain('"window_opens_at"');
    expect(DECIDE_V9_SYSTEM).toContain('"risk_class"');
  });
});

describe("validateDecideV9Output", () => {
  it("throws on a non-object top level (the repair trigger)", () => {
    expect(() => validateDecideV9Output([])).toThrow(/single JSON object/);
  });

  it("maps the P-05 example shape onto the applier shape", () => {
    const out = validateDecideV9Output({
      summary: "Dates locked, flights booked.",
      latest: "Flights confirmed on Goibibo.",
      plan: ["lock villa ✓", "collect Karan's share", "web check-in"],
      milestones: [
        { label: "Flights", state: "done" },
        { label: "Stay", state: "active", episodes: ["ep_9"] },
        { label: "Day trips", state: "todo" },
      ],
      tasks: [
        {
          title: "Web check-in",
          type: "check-in",
          owner: "self",
          space: "sp_goa_dec",
          due: "2026-12-16T07:00+05:30",
          origin: "implicit",
          risk_class: "auto",
          steps: ["open airline check-in at T-48h"],
          evidence: [{ event_ids: ["e4"], quote: "PNR 4X7K2 · Confirmed" }],
          confidence: 0.9,
        },
      ],
      closures: [{ task: "book flights", verdict: "done", evidence: [{ event_ids: ["e4"], quote: "PNR 4X7K2 · Confirmed" }] }],
      schedules: [
        {
          task: "Web check-in",
          fire_at: "2026-12-16T06:55+05:30",
          window_opens_at: "2026-12-16T07:00+05:30",
          mode: "auto",
          evidence: [{ event_ids: ["e4"], quote: "18 Dec 08:40 dep" }],
        },
      ],
      follow_ups: [{ title: "Cab to airport", after: "Web check-in", fire_at: "2026-12-18T05:30+05:30" }],
      questions: [{ kind: "amount", text: "Karan's share?", event_ids: ["e2"] }],
    });
    expect(out.summary).toBe("Dates locked, flights booked.");
    expect(out.latest).toBe("Flights confirmed on Goibibo.");
    expect(out.plan).toEqual(["lock villa ✓", "collect Karan's share", "web check-in"]);
    expect(out.staged).toBe(true);
    expect(out.milestones.map((m) => m.state)).toEqual(["done", "active", "todo"]);
    // milestones ARE the chapters the applier writes, states preserved
    expect(out.chapters.map((c) => [c.label, c.status, c.episodes])).toEqual([
      ["Flights", "done", []],
      ["Stay", "active", ["ep_9"]],
      ["Day trips", "todo", []],
    ]);
    expect(out.tasks[0]).toMatchObject({ title: "Web check-in", type: "implicit", risk_class: "auto", owner: "self", steps: ["open airline check-in at T-48h"] });
    // "done" with hard evidence → close at the evidenced confidence (≥ the floor)
    expect(out.closures[0]).toMatchObject({ task: "book flights", verdict: "close", outcome: "done", confidence: EVIDENCED_CLOSURE_CONFIDENCE, check_at: null });
    expect(EVIDENCED_CLOSURE_CONFIDENCE).toBeGreaterThanOrEqual(CLOSE_CONFIDENCE_FLOOR);
    expect(out.schedules[0]).toMatchObject({ task: "Web check-in", mode: "auto", window_opens_at: "2026-12-16T07:00+05:30" });
    expect(out.schedules[0].evidence).toHaveLength(1);
    // follow_ups → followups with an inline CONFIRM schedule (a reminder never auto-runs)
    expect(out.followups[0]).toMatchObject({ title: "Cab to airport", after: "Web check-in", because: "after: Web check-in", due: "2026-12-18T05:30+05:30" });
    expect(out.followups[0].schedule).toMatchObject({ mode: "confirm", fire_at: "2026-12-18T05:30+05:30" });
    expect(out.followups[0].risk_class).toBe("advise-only");
    expect(out.questions).toEqual([{ kind: "amount", text: "Karan's share?", event_ids: ["e2"] }]);
  });

  it("a cancelled verdict closes as cancelled, never done", () => {
    const out = validateDecideV9Output({
      closures: [{ task: "tsk_hotel", verdict: "cancelled", evidence: [{ event_ids: ["e1"], quote: "refund initiated" }] }],
    });
    expect(out.closures[0]).toMatchObject({ verdict: "close", outcome: "cancelled" });
  });

  it("a done verdict without hard evidence is only a proposal (below the floor)", () => {
    const out = validateDecideV9Output({ closures: [{ task: "tsk_x", verdict: "done", evidence: [] }] });
    expect(out.closures[0].confidence).toBe(UNEVIDENCED_CLOSURE_CONFIDENCE);
    expect(out.closures[0].confidence).toBeLessThan(CLOSE_CONFIDENCE_FLOOR);
    const quoteOnly = validateDecideV9Output({ closures: [{ task: "tsk_x", verdict: "done", evidence: [{ event_ids: [], quote: "done" }] }] });
    expect(quoteOnly.closures[0].confidence).toBeLessThan(CLOSE_CONFIDENCE_FLOOR);
  });

  it("check_at is never a close: it rides as suggest_close with the instant", () => {
    const out = validateDecideV9Output({
      closures: [{ task: "tsk_karan", verdict: "check_at", check_at: "2026-08-30T09:00+05:30", evidence: [{ event_ids: ["e1"], quote: "paying tonight" }] }],
    });
    expect(out.closures[0]).toMatchObject({ verdict: "suggest_close", check_at: "2026-08-30T09:00+05:30" });
    const bare = validateDecideV9Output({ closures: [{ task: "tsk_karan", verdict: "check_at" }] });
    expect(bare.closures[0].check_at).toBe(""); // asked for a check, no instant → the applier defaults it
  });

  it("unknown risk on a task degrades to advise-only, never auto", () => {
    const out = validateDecideV9Output({ tasks: [{ title: "Pay", origin: "explicit", owner: "self", risk_class: "yolo" }] });
    expect(out.tasks[0].risk_class).toBe("advise-only");
    const none = validateDecideV9Output({ tasks: [{ title: "Pay", origin: "explicit", owner: "self" }] });
    expect(none.tasks[0].risk_class).toBe("advise-only");
  });

  it("an empty milestones section is not staged; legacy v8 chapters still parse", () => {
    const flat = validateDecideV9Output({ summary: "x", milestones: [], tasks: [] });
    expect(flat.staged).toBe(false);
    expect(flat.chapters).toEqual([]);
    const legacy = validateDecideV9Output({
      chapters: [{ id: null, label: "Flights", status: "active", episodes: ["ep_1"] }],
      followups: [{ title: "Shortlist villas", because: "flights booked" }],
      closures: [{ task: "t", verdict: "close", outcome: "done", confidence: 0.92 }],
      plan: { next: ["a"] },
    });
    expect(legacy.chapters[0]).toMatchObject({ label: "Flights", status: "active" });
    expect(legacy.followups[0]).toMatchObject({ title: "Shortlist villas", because: "flights booked" });
    expect(legacy.closures[0]).toMatchObject({ verdict: "close", confidence: 0.92, check_at: null });
    expect(legacy.plan).toEqual({ next: ["a"] });
    expect(legacy.milestones).toEqual([]);
  });
});
