// ===========================================================================
// correction-parse.v2 — the parse contract for the two person-target types
// (FIX-03 / CIR-04). No live model calls.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  CORRECTION_PARSE_V2_INSTRUCTIONS,
  CORRECTION_TYPES_V2,
  parseCorrectionOutputV2,
} from "./correction-parse.v2.js";

describe("parseCorrectionOutputV2", () => {
  it("parses set_relationship with relation + circle", () => {
    expect(
      parseCorrectionOutputV2(`{"type":"set_relationship","relation":"cousin","circle":"family"}`),
    ).toEqual({ type: "set_relationship", relation: "cousin", circle: "family" });
  });

  it("parses set_circle", () => {
    expect(parseCorrectionOutputV2(`{"type":"set_circle","circle":"close_friends"}`)).toEqual({
      type: "set_circle",
      circle: "close_friends",
    });
  });

  it("still parses every v1 type (superset, not a fork)", () => {
    expect(parseCorrectionOutputV2(`{"type":"wrong_person","owner":"Karan"}`)).toEqual({
      type: "wrong_person",
      owner: "Karan",
    });
    expect(parseCorrectionOutputV2('Here: {"type":"cancel"}')).toEqual({ type: "cancel" });
  });

  it("rejects garbage and unknown types", () => {
    expect(parseCorrectionOutputV2("no json at all")).toBeNull();
    expect(parseCorrectionOutputV2(`{"type":"explode"}`)).toBeNull();
  });

  it("the instructions name every type the parser accepts", () => {
    for (const type of CORRECTION_TYPES_V2) {
      expect(CORRECTION_PARSE_V2_INSTRUCTIONS).toContain(type);
    }
  });
});
