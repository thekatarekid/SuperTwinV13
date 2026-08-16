// Archetype presentation (arch §14.6, item 3.10).

import { describe, expect, it } from "vitest";

import { archetypeChrome, orderedContext, signalStrip, stateMarkers } from "./strip";
import { ARCHETYPES, type SpaceView } from "../../lib/spaces-client";

function space(over: Partial<SpaceView> = {}): SpaceView {
  return {
    id: "arc_77",
    arcId: "arc_77",
    label: "Goa trip",
    labelSource: "model",
    archetype: "evt",
    archetypeSource: "model",
    status: "active",
    promotionReason: "cmt",
    signalStrip: "⏳ 31 days",
    pinned: false,
    dormantNote: null,
    stillGrowing: false,
    provisional: false,
    endsAt: "2026-09-15",
    cadence: null,
    loops: [],
    people: [],
    sources: [],
    contextClaims: [],
    promotionRule: null,
    promotingLoopIds: [],
    ...over,
  };
}

describe("archetypeChrome", () => {
  it("gives all eight archetypes an icon, a name and exactly one accent class", () => {
    const modifiers = new Set<string>();
    for (const a of ARCHETYPES) {
      const chrome = archetypeChrome(a);
      expect(chrome.icon.length).toBeGreaterThan(0);
      expect(chrome.name.length).toBeGreaterThan(0);
      expect(chrome.modifier).toBe(`space--${a}`);
      modifiers.add(chrome.modifier);
    }
    expect(modifiers.size).toBe(8);
  });

  it("an unclassified space is still a space", () => {
    expect(archetypeChrome(null)).toEqual({ icon: "○", name: "unclassified", modifier: "space--none" });
  });
});

describe("signalStrip", () => {
  it("renders the worker's line verbatim", () => {
    expect(signalStrip(space({ signalStrip: "₹1,499 due 28 Aug · unpaid" }))).toBe(
      "₹1,499 due 28 Aug · unpaid",
    );
  });

  it("says nothing was recorded rather than composing a strip of its own", () => {
    expect(signalStrip(space({ signalStrip: null }))).toBe("no signal recorded yet");
  });
});

describe("stateMarkers", () => {
  it("collects the §14.6 markers, using the worker's dormancy phrasing", () => {
    expect(
      stateMarkers(space({ pinned: true, status: "dormant", dormantNote: "quiet 9d", stillGrowing: true })),
    ).toEqual(["📌 pinned", "💤 quiet 9d", "◍ still growing"]);
  });

  it("is empty for a plain active space", () => {
    expect(stateMarkers(space())).toEqual([]);
  });
});

describe("orderedContext", () => {
  it("puts preference-weighted claims first and keeps the worker's order inside each band", () => {
    const claims = [
      { claimId: "a", weighted: false },
      { claimId: "b", weighted: true },
      { claimId: "c", weighted: false },
      { claimId: "d", weighted: true },
    ];
    expect(orderedContext(claims).map((c) => c.claimId)).toEqual(["b", "d", "a", "c"]);
  });
});
