import { beforeEach, describe, expect, it } from "vitest";

import {
  buildLegend,
  enumsFor,
  GRAMMAR_BLOCK,
  legendCallTypes,
  legendFor,
  renderTemplate,
  resetLegendCache,
  specsFor,
} from "./legend.js";
import { ENUMS } from "../wire/tolerance.js";
import { TAG_SPECS } from "../wire/tags.js";

const CLAIMS = { callType: "P-CL1", tags: ["F", "P", "B", "T"] } as const;

beforeEach(() => resetLegendCache());

describe("tag selection", () => {
  it("resolves bare tags to every variant and explicit variant ids to one", () => {
    expect(specsFor(["F"]).map((s) => s.variant)).toEqual(["F"]);
    const all = specsFor(["V"]).map((s) => s.variant);
    expect(all).toEqual(TAG_SPECS.V.map((s) => s.variant));
    if (all.length > 1) expect(specsFor([all[0]]).map((s) => s.variant)).toEqual([all[0]]);
  });

  it("throws on a tag the codec could not parse — a build-time defect", () => {
    expect(() => specsFor(["U"])).toThrow(/not a tag/);
    expect(() => specsFor(["F.nope"])).toThrow(/not a variant/);
  });

  it("de-duplicates repeated tags", () => {
    expect(specsFor(["F", "F"]).length).toBe(1);
  });
});

describe("templates and enums are derived, never hand-copied", () => {
  it("renders the field list of the tag table, marking droppable tails", () => {
    const [mention] = specsFor(["M"]);
    expect(renderTemplate(mention)).toBe(
      "M | <events> | <surface> | <entity> | <confidence> | [<hint>]",
    );
  });

  it("collects the enums the selected tags reference, first-seen order", () => {
    expect(enumsFor(specsFor(["F"]))).toEqual(["attribution"]);
    expect(enumsFor(specsFor(["N"]))).toEqual(["entity_type"]);
  });

  it("prints every enum entry as code=stored, straight from the decoder table", () => {
    const legend = buildLegend({ callType: "P-CL1", tags: ["F"] });
    for (const e of ENUMS.attribution.entries) {
      expect(legend).toContain(`${e.code}=${e.stored}`);
    }
  });

  it("groups tags that share a field shape — the claim kind IS the tag", () => {
    const legend = buildLegend(CLAIMS);
    expect(legend).toContain("F=claim.fact");
    expect(legend).toContain("P=claim.preference");
    // One shared template line for the claim kinds, not one per kind.
    const claimTemplate = "<tag> | <events> | <subject> | <attribution>";
    expect(legend.split(claimTemplate).length - 1).toBe(1);
  });

  it("leads with the grammar and the compress-structure-never-language rule", () => {
    const legend = buildLegend(CLAIMS);
    expect(legend.startsWith(GRAMMAR_BLOCK)).toBe(true);
    expect(legend).toContain("Compress structure, never language");
    expect(legend).toContain("A blank is you being honest");
  });
});

describe("the legend is a stable prefix (§5.9.4)", () => {
  it("is byte-identical for the same spec, every time", () => {
    const a = buildLegend(CLAIMS);
    const b = buildLegend({ callType: "P-CL1", tags: ["F", "P", "B", "T"] });
    expect(b).toBe(a);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("memoises per call type and returns the very same string", () => {
    const a = legendFor(CLAIMS);
    const b = legendFor(CLAIMS);
    expect(b).toBe(a);
    expect(legendCallTypes()).toEqual(["P-CL1"]);
  });

  it("throws rather than silently shipping two prefixes for one call type", () => {
    legendFor(CLAIMS);
    expect(() => legendFor({ callType: "P-CL1", tags: ["F"] })).toThrow(/not stable/);
  });

  it("keeps different call types apart", () => {
    const cl1 = legendFor(CLAIMS);
    const tr1 = legendFor({ callType: "P-TR1", tags: ["J"] });
    expect(tr1).not.toBe(cl1);
    expect(legendCallTypes()).toEqual(["P-CL1", "P-TR1"]);
  });

  it("only advertises the tags this call may emit", () => {
    const legend = buildLegend({ callType: "P-TR1", tags: ["J"] });
    expect(legend).toContain("OUTPUT — emit only these tags");
    expect(legend).not.toContain("claim.fact");
  });
});
