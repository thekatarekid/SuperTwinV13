// ===========================================================================
// P3.3 — result schemas: every type validates on emit, bad shapes refuse.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  emitResult,
  isResultType,
  RESULT_TYPES,
  ResultSchemaError,
  validateResult,
} from "./schemas.js";

const VALID: Record<string, Record<string, unknown>> = {
  comparison_table: {
    title: "Villas near Anjuna",
    columns: ["name", "price", "distance"],
    rows: [["Casa A", "₹5.5k", "1.2km"], ["Villa B", "₹4.8k", "2km"], ["Sol C", "₹6k", "800m"]],
    recommendation: "Villa B: best value",
  },
  itinerary: {
    title: "Goa 18–21 Dec",
    legs: [
      { when: "18 Dec 08:10", what: "CCU→GOI 6E-512" },
      { when: "18 Dec 12:30", what: "Cab to Anjuna" },
    ],
  },
  draft_preview: { to: "Sameer", channel: "whatsapp", body: "Answers to your 3 questions: …" },
  approval_card: {
    action: "browser.payment",
    summary: "Pay ₹18,240 for Villa B, 18–21 Dec, free cancellation until 10 Dec",
    amount: "₹18,240",
  },
  research_brief: {
    title: "Anjuna villa market",
    summary: "Dec rates run ₹4.5–7k/night.",
    findings: [{ point: "Weekend premiums ~20%" }],
    sources: ["https://example.com"],
  },
  checklist: {
    title: "Booking prep",
    items: [
      { label: "Shortlist 3 villas", state: "done" },
      { label: "Confirm dates with Rohan", state: "open" },
    ],
  },
  receipt: {
    action: "whatsapp.send",
    summary: "Sent draft reply to Sameer",
    performed_at: "2026-08-29T10:00:00Z",
  },
};

describe("executor result schemas", () => {
  it("covers exactly the seven spec §11.4 types, each with a passing sample", () => {
    expect(Object.keys(VALID).sort()).toEqual([...RESULT_TYPES].sort());
    for (const [result_type, data] of Object.entries(VALID)) {
      expect(validateResult({ result_type, data })).toEqual([]);
      expect(emitResult({ result_type, data }).result_type).toBe(result_type);
    }
  });

  it("refuses unknown result types and non-object shapes", () => {
    expect(validateResult(null)).toEqual(["result: must be an object"]);
    expect(validateResult({ result_type: "poem", data: {} })[0]).toMatch(/result_type/);
    expect(validateResult({ result_type: "receipt", data: "x" })).toEqual([
      "data: must be an object",
    ]);
    expect(isResultType("poem")).toBe(false);
    expect(isResultType("receipt")).toBe(true);
  });

  it("reports missing/mistyped fields precisely", () => {
    const errs = validateResult({
      result_type: "comparison_table",
      data: { title: "", columns: [], rows: "nope" },
    });
    expect(errs).toContain("title: must be a non-empty string");
    expect(errs).toContain("columns: must not be empty");
    expect(errs).toContain("rows: must be an array of arrays");
  });

  it("checks required string keys inside object arrays", () => {
    const errs = validateResult({
      result_type: "checklist",
      data: { title: "t", items: [{ label: "ok", state: "done" }, { label: "" }] },
    });
    expect(errs).toContain("items[1].label: must be a non-empty string");
    expect(errs).toContain("items[1].state: must be a non-empty string");
  });

  it("emitResult is the throwing gate", () => {
    expect(() => emitResult({ result_type: "itinerary", data: { title: "x", legs: [] } })).toThrow(
      ResultSchemaError,
    );
    try {
      emitResult({ result_type: "itinerary", data: { title: "x", legs: [] } });
    } catch (e) {
      expect((e as ResultSchemaError).errors).toContain("legs: must not be empty");
    }
  });
});
