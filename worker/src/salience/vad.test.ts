// ===========================================================================
// VAD scaffold (build item 1.3, arch §10.2 stage ①).
//
// The point of these tests is the no-op half of the contract: the detector
// WhatsApp resolves to must never be the reason a clip looks unimportant. The
// other half — that a real detector can be plugged in without touching the
// core — is proved by registering a fake one and getting it back by id.
// ===========================================================================

import { afterEach, describe, expect, it } from "vitest";

import {
  PASS_THROUGH_VAD,
  PASS_THROUGH_VAD_ID,
  VadRegistryError,
  getVad,
  listVads,
  registerVad,
  resetVads,
  verdictFromWindows,
  type VadInput,
  type VadVerdict,
} from "./vad.js";

afterEach(() => {
  resetVads();
});

describe("pass-through VAD — the WhatsApp no-op", () => {
  it("calls the whole clip speech and gates nothing", () => {
    const v = PASS_THROUGH_VAD.detect({ duration_ms: 4_200 });
    expect(v.speech).toBe(true);
    expect(v.speech_ms).toBe(4_200);
    expect(v.speech_ratio).toBe(1);
    expect(v.windows).toEqual([{ start_ms: 0, end_ms: 4_200 }]);
    expect(v.detector).toBe(PASS_THROUGH_VAD_ID);
  });

  it("announces that it does not gate, so callers can skip the plumbing", () => {
    expect(PASS_THROUGH_VAD.gates).toBe(false);
  });

  it("still reports ratio 1 on a zero-length clip — a no-op never scores low", () => {
    const v = PASS_THROUGH_VAD.detect({ duration_ms: 0 });
    expect(v.speech).toBe(false);
    expect(v.speech_ratio).toBe(1);
    expect(v.windows).toEqual([]);
  });

  it("treats a nonsense duration as zero rather than throwing", () => {
    expect(PASS_THROUGH_VAD.detect({ duration_ms: Number.NaN }).speech_ms).toBe(0);
    expect(PASS_THROUGH_VAD.detect({ duration_ms: -5 }).speech_ms).toBe(0);
  });
});

describe("registry", () => {
  const fake = {
    id: "fake-vad",
    gates: true,
    detect(input: VadInput): VadVerdict {
      return verdictFromWindows("fake-vad", input.duration_ms, [{ start_ms: 0, end_ms: 100 }]);
    },
  };

  it("hands back a registered detector by id", () => {
    registerVad(fake);
    expect(getVad("fake-vad")).toBe(fake);
    expect(listVads()).toContain("fake-vad");
  });

  it("refuses to replace the reserved pass-through", () => {
    expect(() => registerVad({ ...fake, id: PASS_THROUGH_VAD_ID })).toThrow(VadRegistryError);
    expect(getVad(PASS_THROUGH_VAD_ID)).toBe(PASS_THROUGH_VAD);
  });

  it("refuses a duplicate id and an id-less detector", () => {
    registerVad(fake);
    expect(() => registerVad(fake)).toThrow(/already registered/);
    expect(() => registerVad({ ...fake, id: "  " })).toThrow(/non-empty string id/);
  });

  it("throws on an unknown id instead of silently disabling gating", () => {
    expect(() => getVad("silero")).toThrow(VadRegistryError);
  });

  it("keeps the pass-through across a reset", () => {
    registerVad(fake);
    resetVads();
    expect(listVads()).toEqual([PASS_THROUGH_VAD_ID]);
  });
});

describe("verdictFromWindows", () => {
  it("merges overlapping spans so speech can never exceed the clip", () => {
    const v = verdictFromWindows("x", 1_000, [
      { start_ms: 0, end_ms: 600 },
      { start_ms: 400, end_ms: 900 },
    ]);
    expect(v.windows).toEqual([{ start_ms: 0, end_ms: 900 }]);
    expect(v.speech_ms).toBe(900);
    expect(v.speech_ratio).toBeCloseTo(0.9);
  });

  it("clips spans to the clip and drops empty ones", () => {
    const v = verdictFromWindows("x", 500, [
      { start_ms: -100, end_ms: 200 },
      { start_ms: 300, end_ms: 900 },
      { start_ms: 450, end_ms: 450 },
    ]);
    expect(v.windows).toEqual([
      { start_ms: 0, end_ms: 200 },
      { start_ms: 300, end_ms: 500 },
    ]);
    expect(v.speech_ms).toBe(400);
  });

  it("reports silence when nothing survives", () => {
    const v = verdictFromWindows("x", 1_000, []);
    expect(v.speech).toBe(false);
    expect(v.speech_ratio).toBe(0);
  });
});
