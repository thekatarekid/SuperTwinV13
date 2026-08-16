// [CODE] The source-contribution timeline — arch §14.4: "the core visual".
//
//   Jun ───●────●─────────●────●────●───────● Sep
//          wa   wa        web  gmail cal    mmt
//
// It answers the question a list of episodes cannot: WHICH SOURCES built this
// thread, and WHEN. Five WhatsApp dots in one week and one calendar dot in
// September is a different object from six sources spread evenly, and only the
// picture shows that.
//
// Pure, so the arithmetic is tested without a DOM. Three rules:
//
//  1. AN UNREADABLE TIMESTAMP IS DROPPED, NOT GUESSED. Placing a dot at "now"
//     because its date did not parse would put a lie in the core visual.
//  2. A ZERO-WIDTH SPAN IS CENTRED, NOT DIVIDED. One contribution, or several
//     in the same instant, would otherwise divide by zero.
//  3. THE ENDS ARE LABELLED FROM THE DATA. `Jun`…`Sep` are the first and last
//     contribution's months, so the axis cannot claim a range nothing occupies.

import type { ArcContribution } from "../../lib/threads-client";

export interface TimelineMark extends ArcContribution {
  /** 0 at the first contribution, 1 at the last. */
  offset: number;
}

export interface Timeline {
  startLabel: string;
  endLabel: string;
  startAt: string;
  endAt: string;
  marks: TimelineMark[];
}

function monthLabel(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: "short" });
}

/**
 * Build the timeline, or null when nothing readable contributed — an arc whose
 * contributions all failed to parse gets no axis rather than a false one.
 */
export function buildTimeline(contributions: readonly ArcContribution[]): Timeline | null {
  const dated = contributions
    .map((c) => ({ c, ms: Date.parse(c.at) }))
    .filter((row) => Number.isFinite(row.ms))
    .sort((a, b) => a.ms - b.ms);

  if (dated.length === 0) return null;

  const first = dated[0];
  const last = dated[dated.length - 1];
  const span = last.ms - first.ms;

  return {
    startLabel: monthLabel(first.ms),
    endLabel: monthLabel(last.ms),
    startAt: first.c.at,
    endAt: last.c.at,
    marks: dated.map(({ c, ms }) => ({
      ...c,
      offset: span === 0 ? 0.5 : (ms - first.ms) / span,
    })),
  };
}

/** The distinct sources that fed this arc, first contribution first. */
export function timelineSources(timeline: Timeline): string[] {
  const seen: string[] = [];
  for (const mark of timeline.marks) {
    if (!seen.includes(mark.sourceLabel)) seen.push(mark.sourceLabel);
  }
  return seen;
}
