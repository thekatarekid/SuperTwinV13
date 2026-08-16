// Supersede chains and provenance completeness (arch §14.5, item 3.10).

import { describe, expect, it } from "vitest";

import { chainNewestFirst, hasChain, missingProvenance, provenanceLine } from "./chain";
import type { ClaimView, ClaimVersionView } from "../../lib/claims-client";

function version(over: Partial<ClaimVersionView> & { id: string }): ClaimVersionView {
  return {
    version: 1,
    text: "Prefers houses in Indiranagar",
    status: "superseded",
    statedAt: "2026-05-20T00:00:00.000Z",
    reason: "original",
    decidedBy: "agent:p-cl1",
    confidence: 0.8,
    ...over,
  };
}

function claim(over: Partial<ClaimView> = {}): ClaimView {
  return {
    id: "clm_1",
    claimKey: "key_1",
    kind: "preference",
    text: "Prefers houses in Indiranagar",
    subjectId: "ent_1",
    subjectLabel: "Rahul Arora",
    subjectIsHint: false,
    status: "active",
    confidence: 0.9,
    attribution: "first_person",
    decidedBy: "agent:p-cl1",
    statedAt: "2026-08-11T00:00:00.000Z",
    validFrom: null,
    validTo: null,
    pinned: false,
    provisional: false,
    evidence: [{ eventId: "ev_1", quote: "i want a place in indiranagar", episodeId: null, at: null }],
    versions: [version({ id: "v1" })],
    ...over,
  };
}

describe("chainNewestFirst", () => {
  it("orders by stated_at, newest first — regardless of the array's order", () => {
    const c = claim({
      versions: [
        version({ id: "v2", version: 2, statedAt: "2026-07-04T00:00:00.000Z" }),
        version({ id: "v1", version: 1, statedAt: "2026-05-20T00:00:00.000Z" }),
        version({ id: "v3", version: 3, statedAt: "2026-08-11T00:00:00.000Z", status: "active" }),
      ],
    });
    expect(chainNewestFirst(c).map((v) => v.id)).toEqual(["v3", "v2", "v1"]);
  });

  it("breaks a stated_at tie on the version number, so the display is stable", () => {
    const at = "2026-08-11T00:00:00.000Z";
    const c = claim({
      versions: [version({ id: "a", version: 1, statedAt: at }), version({ id: "b", version: 2, statedAt: at })],
    });
    expect(chainNewestFirst(c).map((v) => v.id)).toEqual(["b", "a"]);
  });

  it("a single-version claim has no chain to browse", () => {
    expect(hasChain(claim())).toBe(false);
    expect(hasChain(claim({ versions: [version({ id: "a" }), version({ id: "b" })] }))).toBe(true);
  });
});

describe("provenance completeness", () => {
  it("a fully explained claim reports no gaps", () => {
    expect(missingProvenance(claim())).toEqual([]);
  });

  it("names each missing piece rather than rendering a blank", () => {
    expect(
      missingProvenance(claim({ confidence: null, attribution: null, decidedBy: null, evidence: [] })),
    ).toEqual(["confidence", "attribution", "decided_by", "evidence quote"]);
  });

  it("a zero confidence is a measurement, not a gap", () => {
    expect(missingProvenance(claim({ confidence: 0 }))).toEqual([]);
  });

  it("the provenance line prints all three, with placeholders when absent", () => {
    expect(provenanceLine(claim())).toBe("0.90 · 1st-person · agent:p-cl1");
    expect(provenanceLine(claim({ confidence: null, attribution: null, decidedBy: null }))).toBe(
      "confidence — · attribution — · decided_by —",
    );
  });
});
