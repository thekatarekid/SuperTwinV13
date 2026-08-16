// ===========================================================================
// The eight archetypes (§11.3, item 3.6) — shape, not subject.
//
//   P-031..P-046  two variants per shape, all eight
//   P-047, P-048  act vs observe
//   P-049         archetype is revisable, and the transition is recorded
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  ARCHETYPES,
  ARCHETYPE_DISPLAY,
  ARCHETYPE_NAMES,
  actOrObserve,
  archetypeName,
  classifyArchetype,
  describeTransition,
  isArchetype,
  reviseArchetype,
  toArchetype,
  type Archetype,
  type ArchetypeShape,
} from "./archetype.js";

/** Two variants per shape — the same shape said twice, with different numbers. */
const SHAPES: Record<Archetype, [ArchetypeShape, ArchetypeShape]> = {
  prj: [
    { hasOutcome: true, stepCount: 4, endsAt: "2026-11-01T00:00:00Z", route: "cmt", openLoops: 3 },
    { hasOutcome: true, stepCount: 7, endsAt: null, route: "cmt", openLoops: 5 },
  ],
  evt: [
    { endsAt: "2026-09-12T00:00:00Z", stepCount: 1, cadence: "one_time", route: "cmt", openLoops: 1 },
    { endsAt: "2026-10-02T00:00:00Z", stepCount: 0, cadence: "one_time", route: "cmt", openLoops: 1 },
  ],
  rhy: [
    { recurring: true, obligationTo: "person", route: "cmt", openLoops: 1 },
    { cadence: "recurring", obligationTo: "person", route: "rec", openLoops: 2 },
  ],
  adm: [
    { recurring: true, hasLedger: true, obligationTo: "org", route: "cmt", openLoops: 1 },
    { cadence: "recurring", hasLedger: true, obligationTo: "org", route: "ref", durableAnchor: true },
  ],
  hld: [
    { durableAnchor: true, route: "ref", openLoops: 0 },
    { durableAnchor: true, route: "ref", endsAt: "2027-11-01T00:00:00Z", openLoops: 0 },
  ],
  mat: [
    { openLoops: 2, endsAt: null, route: "cmt", stepCount: 1 },
    { openLoops: 1, endsAt: null, route: "cmt", stepCount: 0 },
  ],
  pur: [
    { route: "rec", recurring: true, obligationTo: "none", ownEventRatio: 0.9 },
    { route: "rec", recurring: true, obligationTo: "none", ownEventRatio: 0.62 },
  ],
  wch: [
    { route: "rec", recurring: true, obligationTo: "none", ownEventRatio: 0.1 },
    { route: "rec", recurring: true, obligationTo: "none", ownEventRatio: 0.0 },
  ],
};

describe("the closed set", () => {
  it("has exactly eight shapes and a name for each", () => {
    expect(ARCHETYPES).toHaveLength(8);
    expect(Object.keys(ARCHETYPE_NAMES)).toHaveLength(8);
    expect(Object.keys(ARCHETYPE_DISPLAY)).toHaveLength(8);
  });

  it("reads both the code and the product word", () => {
    expect(toArchetype("pur")).toBe("pur");
    expect(toArchetype("pursuit")).toBe("pur");
    expect(toArchetype("hobby")).toBeNull();
    expect(isArchetype("prj")).toBe(true);
    expect(isArchetype("project")).toBe(false);
    expect(archetypeName("wch")).toBe("watch");
  });
});

describe("archetype by shape, not by subject (P-031..P-046)", () => {
  for (const code of ARCHETYPES) {
    SHAPES[code].forEach((shape, i) => {
      it(`${ARCHETYPE_NAMES[code]} variant ${i + 1}`, () => {
        const v = classifyArchetype(shape);
        expect(v.archetype).toBe(code);
        expect(v.source).toBe("code");
        expect(v.rule).not.toBe("no_shape");
      });
    });
  }

  it("a shapeless thread carries no archetype — unknown beats wrong", () => {
    expect(classifyArchetype({}).archetype).toBeNull();
  });
});

describe("act or observe (P-047, P-048)", () => {
  it("evidence that is mostly the user's own events → pursuit", () => {
    expect(actOrObserve(0.8)).toBe("pur");
    expect(classifyArchetype({ route: "rec", ownEventRatio: 0.8 }).archetype).toBe("pur");
  });

  it("evidence that mostly arrives at the user → watch", () => {
    expect(actOrObserve(0.2)).toBe("wch");
    expect(classifyArchetype({ route: "rec", ownEventRatio: 0.2 }).archetype).toBe("wch");
  });

  it("an unmeasured ratio observes rather than claims the user acted", () => {
    expect(actOrObserve(null)).toBe("wch");
  });
});

describe("archetype is revisable (P-049)", () => {
  it("'learning guitar' becomes a project the moment there is a recital date", () => {
    const before = classifyArchetype({ route: "rec", recurring: true, obligationTo: "none", ownEventRatio: 0.95 });
    expect(before.archetype).toBe("pur");

    const after = classifyArchetype({
      route: "rec",
      recurring: true,
      obligationTo: "none",
      ownEventRatio: 0.95,
      hasOutcome: true,
      stepCount: 3,
      endsAt: "2026-12-06T18:00:00Z",
    });
    expect(after.archetype).toBe("prj");

    const revision = reviseArchetype({
      current: before.archetype,
      currentSource: "code",
      next: after.archetype,
      nextSource: "code",
      reason: "a recital date was set",
    });
    expect(revision.changed).toBe(true);
    expect(revision.transition).toEqual({
      from: "pur",
      to: "prj",
      reason: "a recital date was set",
      source: "code",
    });
    expect(describeTransition(revision.transition!)).toBe("pursuit → project (a recital date was set)");
  });

  it("no transition is recorded when nothing changed", () => {
    const r = reviseArchetype({ current: "pur", next: "pur", nextSource: "model" });
    expect(r.changed).toBe(false);
    expect(r.transition).toBeNull();
  });

  it("code never overwrites a user's correction", () => {
    const r = reviseArchetype({ current: "wch", currentSource: "user", next: "pur", nextSource: "code" });
    expect(r.changed).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.archetype).toBe("wch");
  });

  it("a user may overwrite the model, and the model may overwrite code", () => {
    expect(reviseArchetype({ current: "wch", currentSource: "model", next: "pur", nextSource: "user" }).changed).toBe(true);
    expect(reviseArchetype({ current: "wch", currentSource: "code", next: "pur", nextSource: "model" }).changed).toBe(true);
    expect(reviseArchetype({ current: "wch", currentSource: "user", next: "pur", nextSource: "model" }).blocked).toBe(true);
  });
});
