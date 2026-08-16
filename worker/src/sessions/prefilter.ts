// ===========================================================================
// [CODE] The ambient prefilter — what runs BEFORE segmentation (arch §2.1
// fact 2, §10.2; build item 1.7).
//
// §2.1 is explicit about the order: for an AMBIENT stream the salience
// prefilter runs FIRST, and only what survives it is segmented. That ordering
// is not a preference. Families 10, 12 and 13 out-produce every other source
// combined, and a screen recorder handing 10⁵ near-identical frames a day to a
// segmenter built for 10³ does not degrade — it stops.
//
// So this file is deliberately upstream of `./segment.ts` and knows nothing
// about sessions. It takes frames and gives back fewer frames, each carrying
// how many it swallowed and over what span, and the walk then treats what it
// gets as if that were all there ever was.
// ===========================================================================

import { hamming, isPhash } from "../salience/dedupe.js";
import { tsMs } from "./policies.js";
import type { SegEvent } from "./segment.js";

export interface Collapsed {
  events: SegEvent[];
  /** external_id -> how many frames it swallowed, and the span they covered. */
  collapsedInto: Map<string, { count: number; span_ms: number }>;
  removed: number;
}

export const NO_COLLAPSE: Collapsed = { events: [], collapsedInto: new Map(), removed: 0 };

/**
 * Perceptual collapse for AMBIENT. A run of near-identical frames becomes ONE
 * event carrying the run's duration. Nothing downstream sees the other 199 —
 * §2.1 fact 2: an ambient stream must be gated BEFORE segmentation, not after,
 * or a 10⁵/day source walks into a segmenter built for 10³.
 *
 * `hamming` comes from the salience prefilter rather than being re-derived
 * here: one definition of "the same frame", used by both stages.
 *
 * A run is CONTIGUOUS: two identical frames either side of a two-minute silence
 * are not one frame, they are the same thing seen twice with a gap in between —
 * and that gap is itself a boundary (§10.4 AMBIENT, silence > 90s). Collapsing
 * across it would hide the very rule that should have fired.
 */
export function collapseFrames(events: readonly SegEvent[], maxDistance: number, maxGapMs: number): Collapsed {
  const out: SegEvent[] = [];
  const collapsedInto = new Map<string, { count: number; span_ms: number }>();
  let anchor: SegEvent | null = null;
  let previousMs = 0;
  let removed = 0;
  for (const ev of events) {
    const hash = ev.phash;
    const contiguous = anchor !== null && tsMs(ev.ts) - previousMs <= maxGapMs;
    if (!isPhash(hash) || anchor === null || !isPhash(anchor.phash) || !contiguous) {
      out.push(ev);
      anchor = ev;
      previousMs = tsMs(ev.ts);
      continue;
    }
    if (hamming(hash, anchor.phash) <= maxDistance) {
      removed += 1;
      const entry = collapsedInto.get(anchor.external_id) ?? { count: 0, span_ms: 0 };
      entry.count += 1;
      entry.span_ms = tsMs(ev.ts) - tsMs(anchor.ts);
      collapsedInto.set(anchor.external_id, entry);
      previousMs = tsMs(ev.ts);
      continue;
    }
    out.push(ev);
    anchor = ev;
    previousMs = tsMs(ev.ts);
  }
  return { events: out, collapsedInto, removed };
}
