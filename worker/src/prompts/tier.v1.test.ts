// ===========================================================================
// tier.v1 — P-07 contract unit tests (V6 P1 S3.8). No model calls: the
// contract is the packer and the parser, and both are code.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { packTierUser, parseTierV1, TIER_SAMPLE_MAX, TIER_V1_ID, TIER_V1_SYSTEM } from "./tier.v1.js";

describe("tier.v1 · P-07", () => {
  it("is the P-07 system prompt, verbatim, under its version id", () => {
    expect(TIER_V1_ID).toBe("tier.v1");
    expect(TIER_V1_SYSTEM).toContain("Classify ONE business sender from a sample of its messages.");
    expect(TIER_V1_SYSTEM).toContain('Reply: {"tier":2|3|4,"reason":"…","confidence":0.0}');
  });

  it("packs the sample newest-first inside ONE <untrusted> block, capped and flattened", () => {
    const sample = Array.from({ length: 20 }, (_, i) => `line ${i}\nwith a\tbreak`);
    const user = packTierUser({ name: "HDFC Ergo", sample, totalMessages: 340, userMessages: 0 });
    expect(user.startsWith("BUSINESS SENDER HDFC Ergo\n340 messages in total · 0 from the user · 12 sampled (newest first)")).toBe(true);
    expect(user.split("<untrusted>")).toHaveLength(2);
    expect(user.endsWith("</untrusted>")).toBe(true);
    expect(user).toContain(`${TIER_SAMPLE_MAX}. line 11 with a break`);
    expect(user).not.toContain("line 12");
    expect(packTierUser({ name: null, sample: ["", "  ", "one"] })).toContain("(unnamed)\n1 messages in total · 0 from the user · 1 sampled");
  });

  it("parses a clean answer, clamps confidence, and names soft omissions", () => {
    const good = parseTierV1('{"tier":2,"reason":"active policy with a renewal due","confidence":0.92}');
    expect(good).toEqual({ result: { tier: 2, reason: "active policy with a renewal due", confidence: 0.92 }, violations: [] });
    const wrapped = parseTierV1('Sure — here you go:\n```json\n{"tier":"4","reason":"marketing blasts","confidence":1.7}\n```');
    expect(wrapped.result).toEqual({ tier: 4, reason: "marketing blasts", confidence: 1 });
    const bare = parseTierV1('{"tier":3}');
    expect(bare.result).toEqual({ tier: 3, reason: "", confidence: 0.5 });
    expect(bare.violations).toEqual(["missing-reason", "missing-confidence"]);
  });

  it("anything but a clean 2|3|4 is null — code then defaults without caching", () => {
    expect(parseTierV1("probably a bank")).toEqual({ result: null, violations: ["unparseable"] });
    expect(parseTierV1('{"tier":1,"reason":"they reply a lot","confidence":0.9}').result).toBeNull();
    expect(parseTierV1('{"tier":1,"reason":"x","confidence":0.9}').violations).toEqual(["tier-out-of-range:1"]);
    expect(parseTierV1('{"tier":5}').violations).toEqual(["tier-out-of-range:5"]);
    expect(parseTierV1("[2]").result).toBeNull();
  });
});
