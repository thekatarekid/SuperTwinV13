// [CODE] The source-contribution timeline — arch §14.4, "the core visual".
//
//   Jun ───●────●─────────●────●────●───────● Sep
//          wa   wa        web  gmail cal    mmt
//
// The arithmetic is in timeline.ts; this is only the drawing. Two choices:
//
//  1. IT IS A LIST TO A SCREEN READER. The dots are a picture for the eye and
//     an ordered list of "source at date" for everyone else — the information
//     is the same, the rendering differs. `aria-hidden` on the rule, real text
//     on the marks.
//  2. NO TIMESTAMPS, NO AXIS. An arc whose contributions are all undated gets a
//     sentence saying so rather than a straight line implying an even spread.

import { buildTimeline, timelineSources } from "./timeline";
import type { ArcContribution } from "../../lib/threads-client";

export interface SourceTimelineProps {
  contributions: readonly ArcContribution[];
}

function dayLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "undated";
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function SourceTimeline({ contributions }: SourceTimelineProps) {
  const timeline = buildTimeline(contributions);

  if (!timeline) {
    return (
      <p className="arc-timeline arc-timeline--empty">
        no dated contributions — this thread has no timeline yet
      </p>
    );
  }

  return (
    <div className="arc-timeline" aria-label="Source contributions">
      <span className="arc-timeline__end">{timeline.startLabel}</span>
      <span className="arc-timeline__track">
        <span className="arc-timeline__rule" aria-hidden="true" />
        {timeline.marks.map((mark) => (
          <span
            key={`${mark.episodeId}-${mark.at}`}
            className="arc-timeline__mark"
            style={{ left: `${(mark.offset * 100).toFixed(2)}%` }}
            title={`${mark.sourceLabel} · ${dayLabel(mark.at)}`}
          >
            <span className="arc-timeline__dot" aria-hidden="true">
              ●
            </span>
            <span className="arc-timeline__source">{mark.sourceLabel}</span>
          </span>
        ))}
      </span>
      <span className="arc-timeline__end">{timeline.endLabel}</span>
      <span className="arc-timeline__summary">
        {timeline.marks.length} contributions from {timelineSources(timeline).join(", ")}
      </span>
    </div>
  );
}
