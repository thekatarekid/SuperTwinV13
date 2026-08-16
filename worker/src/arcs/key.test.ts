// ===========================================================================
// Arc anchors and arc identity (§11.2, item 2.5). Two properties are load
// bearing and both are asserted here: the weighted-Jaccard bar of rung ②
// (evals L-009..L-017) and the id stability `arc_key` exists for (L-032..L-035).
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  ANCHOR_WEIGHTS,
  ARC_OVERLAP_MIN,
  TOPIC_WEIGHT,
  anchorWeight,
  arcIdForKey,
  arcKey,
  normaliseLabelStem,
  overlapJoins,
  rankAnchors,
  topAnchorIds,
  weightedOverlap,
  type AnchorRef,
} from "./key.js";

const people = (...ids: string[]): AnchorRef[] => ids.map((entityId) => ({ entityId, type: "person" }));
const topics = (...ids: string[]): AnchorRef[] => ids.map((entityId) => ({ entityId, type: "topic" }));

describe("anchor weights (§11.2)", () => {
  it("puts who/where/when on 1.0, concrete things on 0.7, topics on 0.4", () => {
    expect(ANCHOR_WEIGHTS.person).toBe(1);
    expect(ANCHOR_WEIGHTS.place).toBe(1);
    expect(ANCHOR_WEIGHTS.occasion).toBe(1);
    expect(ANCHOR_WEIGHTS.thing).toBe(0.7);
    expect(ANCHOR_WEIGHTS.media_work).toBe(0.7);
    expect(ANCHOR_WEIGHTS.topic).toBe(TOPIC_WEIGHT);
  });

  it("treats an unknown type as the WEAKEST tier, never the strongest", () => {
    expect(anchorWeight("wormhole")).toBe(TOPIC_WEIGHT);
    expect(anchorWeight(null)).toBe(TOPIC_WEIGHT);
    expect(anchorWeight(undefined)).toBe(TOPIC_WEIGHT);
  });
});

describe("label stems", () => {
  it("drops stopwords, case, accents and punctuation", () => {
    expect(normaliseLabelStem("The Goa Trip!")).toBe(normaliseLabelStem("goa trip"));
    expect(normaliseLabelStem("Café visit")).toBe(normaliseLabelStem("cafe visit"));
  });

  it("is word-order insensitive, so a later cohort's phrasing keeps the id", () => {
    expect(normaliseLabelStem("Goa trip")).toBe(normaliseLabelStem("trip to Goa"));
  });

  it("returns the empty stem for a missing label rather than throwing", () => {
    expect(normaliseLabelStem(null)).toBe("");
    expect(normaliseLabelStem(undefined)).toBe("");
  });
});

describe("anchor ranking", () => {
  it("ranks by tier, then by how often the entity was seen, then by id", () => {
    const ranked = rankAnchors([
      { entityId: "e_topic", type: "topic", count: 99 },
      { entityId: "e_p2", type: "person", count: 1 },
      { entityId: "e_p1", type: "person", count: 5 },
    ]);
    expect(ranked).toEqual(["e_p1", "e_p2", "e_topic"]);
  });

  it("takes the top three and then SORTS them, so the key is order-free", () => {
    const anchors = [
      { entityId: "z", type: "person", count: 9 },
      { entityId: "a", type: "person", count: 8 },
      { entityId: "m", type: "person", count: 7 },
      { entityId: "q", type: "topic", count: 100 },
    ];
    expect(topAnchorIds(anchors)).toEqual(["a", "m", "z"]);
  });

  it("folds a repeated entity into one row at the strongest tier it was given", () => {
    const ranked = rankAnchors([
      { entityId: "x", type: "topic" },
      { entityId: "x", type: "person" },
      { entityId: "y", type: "thing", count: 40 },
    ]);
    expect(ranked).toEqual(["x", "y"]);
  });
});

describe("arc_key — the id stability the whole import leans on (L-032..L-035)", () => {
  it("is the same for the same anchors and label, in any order", () => {
    const a = arcKey([...people("a2", "a7"), ...topics("t1")], "Goa trip");
    const b = arcKey([...topics("t1"), ...people("a7", "a2")], "the trip to Goa");
    expect(a).toBe(b);
  });

  it("survives four full re-derivations unchanged", () => {
    const anchors = people("a2", "a7", "a5", "a9");
    const keys = [1, 2, 3, 4, 5].map(() => arcKey(anchors, "Goa trip"));
    expect(new Set(keys).size).toBe(1);
    expect(new Set(keys.map(arcIdForKey)).size).toBe(1);
  });

  it("changes when the anchors change", () => {
    expect(arcKey(people("a1", "a2", "a3"), "x")).not.toBe(arcKey(people("a1", "a2", "a4"), "x"));
  });

  it("ignores anchors beyond the top three", () => {
    const three = [
      { entityId: "a1", type: "person", count: 9 },
      { entityId: "a2", type: "person", count: 8 },
      { entityId: "a3", type: "person", count: 7 },
    ];
    expect(arcKey(three, "x")).toBe(arcKey([...three, { entityId: "t9", type: "topic", count: 1 }], "x"));
  });

  it("derives the id from the key, so a clean database reproduces it", () => {
    const key = arcKey(people("a1"), "x");
    expect(arcIdForKey(key)).toBe(`arc_${key.slice(0, 16)}`);
  });
});

describe("rung ② — weighted Jaccard (evals L-009..L-017)", () => {
  /** Builds two anchor sets whose weighted Jaccard is exactly `shared/total`. */
  const pair = (shared: number, total: number): [AnchorRef[], AnchorRef[]] => {
    const both = people(...Array.from({ length: shared }, (_, i) => `s${i}`));
    const restA = people(...Array.from({ length: total - shared }, (_, i) => `a${i}`));
    const restB = people(...Array.from({ length: total - shared }, (_, i) => `b${i}`));
    return [[...both, ...restA], [...both, ...restB]];
  };

  it("L-009/L-010: below 0.5 does not join", () => {
    for (const [shared, total] of [[3, 7], [6, 13]] as const) {
      const [a, b] = pair(shared, total + (total - shared));
      const measure = weightedOverlap(a, b);
      expect(measure.score).toBeLessThan(ARC_OVERLAP_MIN);
      expect(overlapJoins(measure)).toBe(false);
    }
  });

  it("L-011: exactly 0.50 JOINS — the bar is >=, not >", () => {
    // 2 shared people out of a 4-person union: 2/4 = 0.5 exactly.
    const a = people("s0", "s1", "a0");
    const b = people("s0", "s1", "b0");
    const measure = weightedOverlap(a, b);
    expect(measure.score).toBe(0.5);
    expect(overlapJoins(measure)).toBe(true);
  });

  it("L-012..L-016: everything above the bar joins", () => {
    const a = people("s0", "s1", "s2", "a0");
    const b = people("s0", "s1", "s2", "b0");
    const measure = weightedOverlap(a, b);
    expect(measure.score).toBeGreaterThan(ARC_OVERLAP_MIN);
    expect(overlapJoins(measure)).toBe(true);
  });

  it("weights a shared topic below a shared person", () => {
    const withPerson = weightedOverlap(people("x", "a"), people("x", "b"));
    const withTopic = weightedOverlap(
      [{ entityId: "x", type: "topic" }, ...people("a")],
      [{ entityId: "x", type: "topic" }, ...people("b")],
    );
    expect(withTopic.score).toBeLessThan(withPerson.score);
  });

  it("L-017: a perfect ratio made ONLY of shared topics does not join", () => {
    const measure = weightedOverlap(topics("t1", "t2"), topics("t1", "t2"));
    expect(measure.score).toBe(1);
    expect(measure.topicOnly).toBe(true);
    expect(overlapJoins(measure)).toBe(false);
  });

  it("a topic overlap carrying one real anchor DOES join", () => {
    const measure = weightedOverlap([...topics("t1"), ...people("a1")], [...topics("t1"), ...people("a1")]);
    expect(measure.topicOnly).toBe(false);
    expect(overlapJoins(measure)).toBe(true);
  });

  it("two anchor sets that share nothing score 0 and never join", () => {
    const measure = weightedOverlap(people("a"), people("b"));
    expect(measure.score).toBe(0);
    expect(measure.shared).toEqual([]);
    expect(overlapJoins(measure)).toBe(false);
  });

  it("two empty anchor sets score 0 rather than dividing by zero", () => {
    expect(weightedOverlap([], []).score).toBe(0);
  });
});
