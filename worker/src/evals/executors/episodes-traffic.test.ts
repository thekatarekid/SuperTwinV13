// ===========================================================================
// [CODE] The representative-traffic corpus behind `episodes_one_to_one_rate`.
//
// What is tested is the HONESTY of the measurement, not a rehearsed number:
// every observation must come from a real engine routing over a real temp DB,
// the hash-gate re-syncs must stay out of the denominator, and the corpus must
// be emitted at most once per suite so the gate cannot double-count it.
// ===========================================================================

import { afterEach, describe, expect, it } from "vitest";

import {
  buildTrafficObservations,
  resetTrafficObservationsForTests,
  trafficCorpus,
  trafficGateObservations,
} from "./episodes-traffic.js";

afterEach(() => resetTrafficObservationsForTests());

describe("the traffic corpus", () => {
  it("is a traffic-shaped mix: mostly single-topic, some resumes and pivots, a couple of re-syncs", () => {
    const corpus = trafficCorpus();
    const by = (kind: string) => corpus.filter((c) => c.kind === kind).length;
    expect(by("single")).toBe(60);
    expect(by("resume")).toBe(12);
    expect(by("pivot")).toBe(6);
    expect(by("resync")).toBe(2);
    // "Most sealed sessions are single-topic" — the premise behind the 60% bar.
    expect(by("single") / (corpus.length - by("resync"))).toBeGreaterThan(0.7);
  });

  it("routes every session through the real engine and measures the gate off the decisions", () => {
    const obs = buildTrafficObservations();
    // Re-syncs hit the hash gate: routed nothing, observed nothing.
    expect(obs).toHaveLength(78);
    for (const o of obs) expect(o.gate).toBe("episodes_one_to_one_rate");
    const passed = obs.filter((o) => o.passed).length;
    // The 60 ordinary sessions take the zero-call default — the later ones only
    // because the REAL 14-day clock faded their stream's previous episode.
    expect(passed).toBe(60);
    // The 18 non-ordinary sessions were rightly routed to the model.
    expect(obs.filter((o) => !o.passed)).toHaveLength(18);
    for (const o of obs.filter((o) => !o.passed)) {
      expect(o.note).toMatch(/judged/);
    }
  });

  it("clears the §14.2 bar on its own terms and when folded into the fixture matrix", () => {
    const obs = buildTrafficObservations();
    const passed = obs.filter((o) => o.passed).length;
    expect(passed / obs.length).toBeGreaterThanOrEqual(0.6);
    // The authored J matrix contributes 21 one-to-one / 51 routed sessions
    // (its editorial mix). Folded together the gate must still clear 60%.
    expect((passed + 21) / (obs.length + 51)).toBeGreaterThanOrEqual(0.6);
  });

  it("emits the corpus at most once per process, and identically on a rebuild", () => {
    const first = trafficGateObservations();
    expect(first.length).toBeGreaterThan(0);
    expect(trafficGateObservations()).toHaveLength(0);
    resetTrafficObservationsForTests();
    const again = trafficGateObservations();
    expect(again.map((o) => `${o.passed}:${o.note}`)).toEqual(first.map((o) => `${o.passed}:${o.note}`));
  });
});
