// ===========================================================================
// correction-parse.v3 — "tell the twin" (V6 P1 S5.5, Prompts P-12). Zero
// model calls: the raw strings below are the model's half. What is asserted
// is the parse (the P-12 type list, the behavioral block, confidence bounds)
// and the code map onto the ONE structured shape the corrections pipeline
// applies, so chip, drag, utterance and bar follow-up all end up in the same
// place (FIX-05).
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  CORRECTION_PARSE_V3_VERSION,
  CORRECTION_TYPES_V3,
  dateFieldFor,
  packCorrectionInputV3,
  parseCorrectionOutputV3,
  toStructuredCorrection,
} from "./correction-parse.v3.js";

describe("parseCorrectionOutputV3", () => {
  it("reads the P-12 example for a misassigned task", () => {
    const p = parseCorrectionOutputV3(`{"type":"not_mine","args":{"owner":"karan"},"behavioral":null,"confidence":0.95}`);
    expect(p).toEqual({ type: "not_mine", args: { owner: "karan" }, behavioral: null, confidence: 0.95 });
  });

  it("reads the P-12 example that carries a durable rule", () => {
    const p = parseCorrectionOutputV3(
      `{"type":"dont_do_this","args":{"kind":"something_moved","context":"app:YouTube"},` +
        `"behavioral":{"rule":"no cards while YouTube is frontmost","scope":"router"},"confidence":0.9}`,
    );
    expect(p!.type).toBe("dont_do_this");
    expect(p!.args).toEqual({ kind: "something_moved", context: "app:YouTube" });
    expect(p!.behavioral).toEqual({ rule: "no cards while YouTube is frontmost", scope: "router" });
  });

  it("rejects an unknown type instead of guessing a mutation", () => {
    expect(parseCorrectionOutputV3(`{"type":"delete_everything","args":{}}`)).toBeNull();
    expect(parseCorrectionOutputV3("sorry, I'm not sure")).toBeNull();
  });

  it("clamps confidence, defaults a missing scope, and keeps numeric args as strings", () => {
    const p = parseCorrectionOutputV3(
      `{"type":"change_date","args":{"iso":"2026-11-02","days":3},"behavioral":{"rule":"trips move, dates follow"},"confidence":7}`,
    );
    expect(p!.confidence).toBe(1);
    expect(p!.args).toEqual({ iso: "2026-11-02", days: "3" });
    expect(p!.behavioral!.scope).toBe("global");
    expect(parseCorrectionOutputV3(`{"type":"not_true","args":{}}`)!.confidence).toBe(0.5);
  });

  it("ignores an empty behavioral rule", () => {
    expect(parseCorrectionOutputV3(`{"type":"outdated","args":{},"behavioral":{"rule":"   ","scope":"router"}}`)!.behavioral).toBeNull();
  });
});

describe("toStructuredCorrection — the v3 → pipeline map", () => {
  const parse = (raw: string) => parseCorrectionOutputV3(raw)!;

  it("maps not_mine onto wrong_person (the FIX-01 / FIX-07 applier)", () => {
    const s = toStructuredCorrection(parse(`{"type":"not_mine","args":{"owner":"karan"},"confidence":0.95}`), "task");
    expect(s.type).toBe("wrong_person");
    expect(s.owner).toBe("karan");
    expect(s.parsed_by).toBe(CORRECTION_PARSE_V3_VERSION);
    expect(s.confidence).toBe(0.95);
  });

  it("renames per target kind: a space gets a label, a task a title", () => {
    const raw = `{"type":"rename","args":{"text":"Hampi trek Nov"},"confidence":0.9}`;
    expect(toStructuredCorrection(parse(raw), "space")).toMatchObject({ type: "edit", field: "label", value: "Hampi trek Nov" });
    expect(toStructuredCorrection(parse(raw), "task")).toMatchObject({ type: "edit", field: "title", value: "Hampi trek Nov" });
  });

  it("change_date edits the field that means a date on that kind", () => {
    expect(dateFieldFor("task")).toBe("due");
    const s = toStructuredCorrection(parse(`{"type":"change_date","args":{"iso":"2026-11-02"},"confidence":0.9}`), "task");
    expect(s).toMatchObject({ type: "edit", field: "due", value: "2026-11-02" });
  });

  it("carries the behavioral rule through whatever the type was", () => {
    const s = toStructuredCorrection(
      parse(`{"type":"dont_do_this","args":{"kind":"something_moved","context":"app:YouTube"},"behavioral":{"rule":"no cards while YouTube is frontmost","scope":"router"},"confidence":0.9}`),
      "task",
    );
    expect(s.type).toBe("dont_do_this");
    expect(s.kind).toBe("something_moved");
    expect(s.context).toBe("app:YouTube");
    expect(s.behavioral).toEqual({ rule: "no cards while YouTube is frontmost", scope: "router" });
  });

  it("has a mapping for every declared type", () => {
    for (const type of CORRECTION_TYPES_V3) {
      const parsed = { type, args: {}, behavioral: null, confidence: 0.5 } as const;
      expect(toStructuredCorrection(parsed, "task").type).toBeTruthy();
    }
  });
});

describe("packCorrectionInputV3", () => {
  it("names the locked object, its state and the utterance", () => {
    const packed = packCorrectionInputV3(
      { kind: "task", id: "t_1", label: "collect ₹5k from Karan", state: { status: "open", owner: "self" } },
      "this is karan's, not mine",
    );
    expect(packed).toContain('LOCKED kind=task id=t_1 label="collect ₹5k from Karan"');
    expect(packed).toContain('STATE {"status":"open","owner":"self"}');
    expect(packed).toContain("UTTERANCE this is karan's, not mine");
  });
});
