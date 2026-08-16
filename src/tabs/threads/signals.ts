// [CODE] Binding signals, rendered — arch §14.4, build item 2.7.
//
//   BOUND BY (precedence order)
//    ① url        booking.com/villa-amara    web ↔ wa        exact
//    ① attendees  {me,Rohan,Ana,Kabir}       cal ↔ wa        J=0.75
//    ② overlap    0.71                       wa ↔ wa
//    ④ adjudicated "same trip, same villa"   mmt ep          conf 0.90
//
// Two invariants live here rather than in JSX, so they are testable on their
// own and cannot be broken by a layout change:
//
//  1. PRECEDENCE ORDER IS THE LADDER ORDER. §11.2's rungs are a precision
//     order — a shared literal outranks a model's opinion — so rows sort by
//     rung ascending and the array's incoming order is never trusted. Ties
//     hold their given order (a stable sort), so two bridges stay as recorded.
//  2. A ROW ALWAYS SHOWS A VALUE. The item's acceptance criterion is "every
//     membership row shows its signal and value". An unmeasured signal
//     therefore renders "not measured" — an honest absence — and never an
//     empty cell, which reads as a value of nothing.

import type { ArcRung, BindingSignalView } from "../../lib/threads-client";

/** ①②③④ — the rung is shown as the ladder writes it (§11.2). */
export const RUNG_GLYPH: Record<ArcRung, string> = {
  1: "①",
  2: "②",
  3: "③",
  4: "④",
};

/** What each rung IS, for the reader who has not read §11.2. */
export const RUNG_NAME: Record<ArcRung, string> = {
  1: "bridge",
  2: "entity overlap",
  3: "topic similarity",
  4: "adjudicated",
};

/**
 * The measured value, formatted by its own measure so the number is never
 * ambiguous: a Jaccard and a confidence are both "0.75" until they are not.
 */
export function signalValue(signal: BindingSignalView): string {
  const { value, measure } = signal;
  if (value === null || value === undefined || value === "") return "not measured";
  const num = typeof value === "number" ? value : null;
  switch (measure) {
    case "jaccard":
      return num === null ? `J=${value}` : `J=${num.toFixed(2)}`;
    case "score":
      return num === null ? String(value) : num.toFixed(2);
    case "confidence":
      return num === null ? `conf ${value}` : `conf ${num.toFixed(2)}`;
    case "exact":
      // The literal IS the evidence; "exact" qualifies it, it does not replace it.
      return `${value} · exact`;
    default:
      return String(value);
  }
}

/** One row, as one line: `① url booking.com/… web ↔ wa exact`. */
export function signalLine(signal: BindingSignalView): string {
  return `${RUNG_GLYPH[signal.rung]} ${signal.signal} ${signalValue(signal)} ${signal.between}`;
}

/** Rung ascending — see invariant 1. `Array.prototype.sort` is stable. */
export function inPrecedenceOrder(
  bindings: readonly BindingSignalView[],
): BindingSignalView[] {
  return [...bindings].sort((a, b) => a.rung - b.rung);
}

/**
 * The strongest signal that admitted one episode, or null when nothing on
 * record did. Null is a real answer: reconcile has not confirmed the
 * membership yet, and the surface says exactly that instead of inventing a
 * reason for a row that has none.
 */
export function strongestBinding(
  bindings: readonly BindingSignalView[],
  episodeId: string,
): BindingSignalView | null {
  return inPrecedenceOrder(bindings).find((b) => b.episodeId === episodeId) ?? null;
}
