// Binding signals — arch §14.4, build item 2.7.
//
// The item's acceptance criterion is "every membership row shows its signal and
// value", so the two things asserted hardest here are: rows come out in ladder
// precedence order whatever order they arrive in, and NO row ever formats to a
// value-less string.

import { describe, expect, it } from "vitest";

import { inPrecedenceOrder, signalLine, signalValue, strongestBinding } from "./signals";
import type { BindingSignalView } from "../../lib/threads-client";

function signal(over: Partial<BindingSignalView> = {}): BindingSignalView {
  return {
    id: "sig_1",
    rung: 2,
    signal: "overlap",
    value: 0.71,
    measure: "score",
    between: "wa ↔ wa",
    episodeId: "ep_1",
    reason: null,
    ...over,
  };
}

describe("precedence order is the ladder order (§11.2)", () => {
  it("sorts by rung ascending however the worker sent them", () => {
    const rows = [
      signal({ id: "d", rung: 4 }),
      signal({ id: "b", rung: 1 }),
      signal({ id: "c", rung: 3 }),
      signal({ id: "a", rung: 2 }),
    ];
    expect(inPrecedenceOrder(rows).map((r) => r.rung)).toEqual([1, 2, 3, 4]);
  });

  it("keeps two signals of the same rung in the order they were recorded", () => {
    const rows = [
      signal({ id: "url", rung: 1, signal: "url" }),
      signal({ id: "attendees", rung: 1, signal: "attendees" }),
    ];
    expect(inPrecedenceOrder(rows).map((r) => r.id)).toEqual(["url", "attendees"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [signal({ id: "d", rung: 4 }), signal({ id: "b", rung: 1 })];
    inPrecedenceOrder(rows);
    expect(rows.map((r) => r.id)).toEqual(["d", "b"]);
  });
});

describe("every signal formats to a value", () => {
  it("labels a Jaccard as one", () => {
    expect(signalValue(signal({ measure: "jaccard", value: 0.75 }))).toBe("J=0.75");
  });

  it("labels a confidence as one", () => {
    expect(signalValue(signal({ measure: "confidence", value: 0.9 }))).toBe("conf 0.90");
  });

  it("prints a bare calibrated score to two places", () => {
    expect(signalValue(signal({ measure: "score", value: 0.71 }))).toBe("0.71");
  });

  it("keeps the literal on an exact bridge — the literal IS the evidence", () => {
    const value = signalValue(
      signal({ rung: 1, signal: "url", measure: "exact", value: "booking.com/villa-amara" }),
    );
    expect(value).toBe("booking.com/villa-amara · exact");
  });

  it("says 'not measured' rather than going blank", () => {
    expect(signalValue(signal({ value: null }))).toBe("not measured");
    expect(signalValue(signal({ value: "" }))).toBe("not measured");
  });

  it("never produces a line without both the signal name and a value", () => {
    for (const row of [
      signal(),
      signal({ value: null, measure: null }),
      signal({ rung: 1, signal: "url", measure: "exact", value: "x" }),
    ]) {
      const line = signalLine(row);
      expect(line).toContain(row.signal);
      expect(line).toContain(signalValue(row));
    }
  });
});

describe("the strongest signal for one membership", () => {
  it("picks the highest-precedence signal that admitted the episode", () => {
    const rows = [
      signal({ id: "adj", rung: 4, episodeId: "ep_9" }),
      signal({ id: "bridge", rung: 1, episodeId: "ep_9" }),
      signal({ id: "other", rung: 1, episodeId: "ep_1" }),
    ];
    expect(strongestBinding(rows, "ep_9")?.id).toBe("bridge");
  });

  it("returns null for a membership nothing on record explains", () => {
    expect(strongestBinding([signal({ episodeId: "ep_1" })], "ep_2")).toBeNull();
  });
});
