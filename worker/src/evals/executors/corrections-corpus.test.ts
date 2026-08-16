// [CODE] Tests for the corrections-survive-re-derivation scenario (item 4.1).

import { describe, expect, it } from "vitest";

import {
  buildCorrectionsObservations,
  correctionsObservations,
  resetCorrectionsObservationsForTests,
} from "./corrections-corpus.js";

describe("corrections corpus", () => {
  const observations = buildCorrectionsObservations();

  it("emits observations for all_corrections_survive only", () => {
    expect(observations.length).toBeGreaterThanOrEqual(6);
    for (const o of observations) expect(o.gate).toBe("all_corrections_survive");
  });

  it("every correction survives the full re-derivation", () => {
    for (const o of observations) expect(o.passed, o.note).toBe(true);
  });

  it("covers the arc id rebind, user label, pin, split wall and label surface", () => {
    const notes = observations.map((o) => o.note ?? "");
    expect(notes.some((n) => n.includes("rebinds"))).toBe(true);
    expect(notes.some((n) => n.includes("user_label"))).toBe(true);
    expect(notes.some((n) => n.includes("user_pinned"))).toBe(true);
    expect(notes.some((n) => n.includes("split held"))).toBe(true);
    expect(notes.some((n) => n.includes("group label"))).toBe(true);
  });

  it("covers the claim edit surviving a re-derived write and its undo", () => {
    const claimNotes = observations.filter((o) => (o.note ?? "").includes("user-corrected claim"));
    expect(claimNotes.length).toBe(2);
    for (const o of claimNotes) expect(o.passed, o.note).toBe(true);
  });

  it("the once-per-process guard emits exactly once until reset", () => {
    resetCorrectionsObservationsForTests();
    const first = correctionsObservations();
    expect(first.length).toBe(observations.length);
    expect(correctionsObservations()).toEqual([]);
    resetCorrectionsObservationsForTests();
  });
});
