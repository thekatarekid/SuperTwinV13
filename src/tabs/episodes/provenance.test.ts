// Session provenance — arch §14.3, build item 2.7.
//
// The acceptance criterion for this item is "every membership row shows its
// signal and value". `provenanceLine` is the only function that composes an
// episode's membership row, so it is the place to prove it: no input produces
// a line missing either half.

import { describe, expect, it } from "vitest";

import { provenanceLabel, provenanceLine, signalAndValue, whenLabel } from "./provenance";
import type { EpisodeSessionView } from "../../lib/episodes-client";

function row(over: Partial<EpisodeSessionView> = {}): EpisodeSessionView {
  return {
    sessionId: "ses_1",
    streamLabel: "Rohan",
    startedAt: "2025-08-11T09:12:00.000Z",
    provenance: "attached",
    decidedBy: "agent:p-ep2",
    confidence: 0.93,
    reason: "continues the Amara booking",
    splitFromSessionId: null,
    splitTopicCount: null,
    verdict: null,
    sessionOpen: false,
    ...over,
  };
}

describe("signal and value are both always present", () => {
  it("shows decided_by and the confidence", () => {
    expect(signalAndValue(row())).toBe("agent:p-ep2 · conf 0.93");
  });

  it("names an unattributed decision instead of leaving it blank", () => {
    expect(signalAndValue(row({ decidedBy: null }))).toContain("unattributed");
    expect(signalAndValue(row({ decidedBy: "  " }))).toContain("unattributed");
  });

  it("says a confidence was not measured rather than printing 0", () => {
    const line = signalAndValue(row({ confidence: null }));
    expect(line).toBe("agent:p-ep2 · no confidence measured");
    expect(line).not.toContain("0.00");
  });

  it("prints a measured zero as a measured zero", () => {
    expect(signalAndValue(row({ confidence: 0 }))).toBe("agent:p-ep2 · conf 0.00");
  });

  it("holds for every provenance kind", () => {
    for (const provenance of ["seed", "attached", "split"] as const) {
      const line = provenanceLine(row({ provenance, decidedBy: null, confidence: null }));
      expect(line).toContain("unattributed");
      expect(line).toContain("no confidence measured");
    }
  });
});

describe("provenance labels", () => {
  it("marks a seed, an attach and a split distinctly", () => {
    expect(provenanceLabel(row({ provenance: "seed" }))).toBe("seed");
    expect(provenanceLabel(row({ provenance: "attached" }))).toBe("ATTACHED");
    expect(
      provenanceLabel(
        row({ provenance: "split", splitFromSessionId: "ses_7", splitTopicCount: 2 }),
      ),
    ).toBe("SPLIT from session ses_7 (2 topics)");
  });

  it("says which session a split came from even when the record is missing", () => {
    const label = provenanceLabel(row({ provenance: "split" }));
    expect(label).toContain("an unrecorded session");
  });
});

describe("whenLabel", () => {
  it("renders a weekday and a clock time", () => {
    expect(whenLabel("2025-08-11T09:12:00.000Z")).toMatch(/\w+ \d{1,2}:\d{2}/);
  });

  it("says 'undated' rather than inventing a date", () => {
    expect(whenLabel(null)).toBe("undated");
    expect(whenLabel("nonsense")).toBe("undated");
  });
});
