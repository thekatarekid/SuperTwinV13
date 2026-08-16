// ===========================================================================
// [CODE] Newest-page-first history (arch §2.2 note 1, §3.3 rule 8; build 1.1).
//
// The scheduler asks every source for history NEWEST FIRST. Last week matters
// more than 2019, and a backfill that starts at the beginning of time spends
// its first hour on messages nobody will read before it reaches the ones the
// user is actually waiting for.
//
// A source that can do it declares `backfill_order: "desc"` and its pages pass
// straight through. A source that can only walk forwards declares `"asc"` (or
// `"unordered"`) and the re-ordering happens HERE instead: pages are buffered
// and handed on as descending cohorts, so everything downstream sees one order
// regardless of what the daemon can speak.
//
// whatsmeow is the ascending case. Its history sync arrives oldest-first, per
// conversation, in whatever order the phone serialises it — so WhatsApp's
// manifest promises the core `desc` and this buffer is what keeps the promise.
//
// Bounded by construction: a full buffer SPILLS as descending cohorts rather
// than growing without limit. A spill is a local inversion — the run that
// spilled is strictly descending, and a later run may contain newer events —
// which is the honest trade for a two-year import that must not sit in RAM.
// Nothing downstream depends on a single global ordering: work is ordered by a
// recency-derived priority key (§3.3 rule 8), and the cohorts feed it.
// ===========================================================================

import type { BackfillOrder } from "./registry.js";

/** The only thing the re-orderer needs off an event. */
export interface HasTs {
  ts: string;
}

export interface CohortBufferOptions {
  /** Events per cohort — the manifest's `capabilities.page_hint_events`. */
  pageHintEvents: number;
  /**
   * Spill threshold. Default 20 pages' worth: enough that an ordinary
   * conversation's whole history re-orders exactly, small enough that a
   * two-year import cannot exhaust memory.
   */
  maxBufferedEvents?: number;
}

function tsMs(e: HasTs): number {
  const t = Date.parse(e.ts);
  return Number.isFinite(t) ? t : 0;
}

/** Newest first; ties keep their arrival order (stable sort). */
export function sortDescByTs<E extends HasTs>(events: readonly E[]): E[] {
  return [...events].sort((a, b) => tsMs(b) - tsMs(a));
}

/** Slice a descending run into cohorts of at most `size`. */
function intoCohorts<E>(events: readonly E[], size: number): E[][] {
  const out: E[][] = [];
  for (let i = 0; i < events.length; i += size) out.push(events.slice(i, i + size));
  return out;
}

/**
 * Turns however a source delivers history into descending cohorts.
 *
 * ```ts
 * const buf = new DescendingCohortBuffer(manifest.capabilities.backfill_order, {
 *   pageHintEvents: manifest.capabilities.page_hint_events,
 * });
 * for (const page of pages) for (const cohort of buf.push(page)) emit(cohort);
 * for (const cohort of buf.flush()) emit(cohort);
 * ```
 */
export class DescendingCohortBuffer<E extends HasTs> {
  private readonly order: BackfillOrder;
  private readonly cohortSize: number;
  private readonly maxBuffered: number;
  private buffer: E[] = [];

  constructor(order: BackfillOrder, opts: CohortBufferOptions) {
    this.order = order;
    this.cohortSize = Math.max(1, Math.floor(opts.pageHintEvents));
    this.maxBuffered = Math.max(this.cohortSize, Math.floor(opts.maxBufferedEvents ?? this.cohortSize * 20));
  }

  /** Events waiting to be re-ordered. */
  get buffered(): number {
    return this.buffer.length;
  }

  /**
   * Feed one page exactly as the source delivered it. Returns the cohorts that
   * are ready NOW — every page for a `desc` source, nothing for an ascending
   * one until it spills or flushes.
   */
  push(page: readonly E[]): E[][] {
    if (page.length === 0) return [];
    if (this.order === "desc") {
      // Already newest-first. Sorted anyway: a page that lied about its order
      // would otherwise put 2019 in front of last week with nothing to catch it.
      return intoCohorts(sortDescByTs(page), this.cohortSize);
    }
    this.buffer.push(...page);
    if (this.buffer.length >= this.maxBuffered) return this.drain();
    return [];
  }

  /** Feed a single event (a live-shaped source with no page framing). */
  pushEvent(event: E): E[][] {
    return this.push([event]);
  }

  /** End of history: every buffered event, newest cohort first. */
  flush(): E[][] {
    return this.drain();
  }

  /** Sort everything buffered newest-first, slice it into cohorts, empty it. */
  private drain(): E[][] {
    if (this.buffer.length === 0) return [];
    const sorted = sortDescByTs(this.buffer);
    this.buffer = [];
    return intoCohorts(sorted, this.cohortSize);
  }
}

/**
 * One-shot: pages in (in delivery order), descending cohorts out. The batch
 * form of the buffer, for callers that already hold the whole history.
 */
export function descendingCohorts<E extends HasTs>(
  pages: readonly (readonly E[])[],
  order: BackfillOrder,
  opts: CohortBufferOptions,
): E[][] {
  const buf = new DescendingCohortBuffer<E>(order, opts);
  const out: E[][] = [];
  for (const page of pages) out.push(...buf.push(page));
  out.push(...buf.flush());
  return out;
}
