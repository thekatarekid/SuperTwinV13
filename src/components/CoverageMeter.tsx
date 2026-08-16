// The coverage meter — architecture §14.0, build item 1.8.
//
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ ⟳ UNDERSTANDING YOUR HISTORY    live ✓ · 24h ✓ · 7d ✓ · 30d ▓▓▓░ 71% │
//   │   90d ░ queued · 1y ░ queued · older ░ queued                        │
//   │   1,204 of 3,028 events · ~14 min remaining · newest first           │
//   └──────────────────────────────────────────────────────────────────────┘
//
// Three rules from §14.0, all enforced here rather than assumed of the caller:
//
//  1. PROGRESS IS PER-HORIZON AND MONOTONIC. The meter never goes backwards, so
//     the component remembers the highest fraction it has shown per horizon and
//     renders that. A late, stale poll cannot make a bar shrink.
//  2. A PAUSED LANE SAYS SO, with a countdown — "paused — rate limit, resumes
//     in 04:12". "A healthy mid-run system that looks like a silent failure is
//     itself a shipped defect", so a paused meter is loud, not blank.
//  3. IT DISAPPEARS IN STEADY STATE unless a backlog exists.
//
// The component is pure: it takes coverage rows and renders them. The
// scheduler's own state lives in worker/src/scheduler/*, and the countdown text
// is produced there too (lanes.pauseState) so the wording has one home.

import { useEffect, useRef } from "react";

/** The §9.2 ladder, in the order the meter reads left to right. */
export const HORIZON_ORDER = ["live", "h24", "d7", "d30", "d90", "y1", "older"] as const;
export type Horizon = (typeof HORIZON_ORDER)[number];

const HORIZON_LABEL: Record<Horizon, string> = {
  live: "live",
  h24: "24h",
  d7: "7d",
  d30: "30d",
  d90: "90d",
  y1: "1y",
  older: "older",
};

export interface CoverageRow {
  horizon: Horizon;
  totalUnits: number;
  doneUnits: number;
}

export interface CoverageMeterProps {
  /** One row per horizon, in any order. Missing horizons render as queued. */
  rows: readonly CoverageRow[];
  /** bootstrap | steady | reprocess — §8.1. */
  mode: "bootstrap" | "steady" | "reprocess";
  /** Rendered verbatim; the scheduler owns the wording (lanes.pauseState). */
  pausedLabel?: string;
  /** "~14 min remaining"; absent while nothing has been measured (§9.7 rule 2). */
  remainingMinutes?: number | null;
}

const BAR_CELLS = 4;

/** ▓▓▓░ — four cells, so a bar reads at a glance rather than needing a number. */
function bar(fraction: number): string {
  const filled = Math.round(fraction * BAR_CELLS);
  return "▓".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}

function pct(fraction: number): number {
  return Math.round(fraction * 100);
}

/**
 * Remembers the highest fraction shown per horizon, for §14.0 rule 1.
 *
 * A ref rather than state: the clamp must not itself cause a render, and the
 * value it protects is derived from props on every pass anyway.
 */
function useMonotonic(rows: readonly CoverageRow[]): Map<Horizon, number> {
  const seen = useRef(new Map<Horizon, number>());
  const out = new Map<Horizon, number>();
  for (const row of rows) {
    const fraction = row.totalUnits > 0 ? Math.min(1, row.doneUnits / row.totalUnits) : 0;
    const best = Math.max(seen.current.get(row.horizon) ?? 0, fraction);
    out.set(row.horizon, best);
  }
  useEffect(() => {
    for (const [horizon, fraction] of out) seen.current.set(horizon, fraction);
  });
  // Horizons absent from this poll keep whatever they last showed.
  for (const [horizon, fraction] of seen.current) {
    if (!out.has(horizon)) out.set(horizon, fraction);
  }
  return out;
}

export function CoverageMeter({ rows, mode, pausedLabel, remainingMinutes }: CoverageMeterProps) {
  const fractions = useMonotonic(rows);

  const totals = rows.reduce(
    (acc, row) => ({ total: acc.total + row.totalUnits, done: acc.done + row.doneUnits }),
    { total: 0, done: 0 },
  );
  const backlog = [...fractions.values()].some((f) => f < 1);

  // §14.0 rule 3 — gone in steady state unless a backlog exists.
  if (mode === "steady" && !backlog) return null;

  const complete = HORIZON_ORDER.filter((h) => (fractions.get(h) ?? 0) >= 1);
  const partial = HORIZON_ORDER.filter((h) => {
    const f = fractions.get(h);
    return f !== undefined && f > 0 && f < 1;
  });
  const queued = HORIZON_ORDER.filter((h) => (fractions.get(h) ?? 0) === 0);

  return (
    <section className="coverage-meter" aria-label="Understanding your history" aria-live="polite">
      <header className="coverage-meter__head">
        <span className="coverage-meter__spinner" aria-hidden="true">
          ⟳
        </span>
        <strong>Understanding your history</strong>
        <span className="coverage-meter__horizons">
          {complete.map((h) => (
            <span key={h} className="coverage-meter__horizon coverage-meter__horizon--done">
              {HORIZON_LABEL[h]} ✓
            </span>
          ))}
          {partial.map((h) => (
            <span key={h} className="coverage-meter__horizon coverage-meter__horizon--partial">
              {HORIZON_LABEL[h]} {bar(fractions.get(h) ?? 0)} {pct(fractions.get(h) ?? 0)}%
            </span>
          ))}
        </span>
      </header>

      {queued.length > 0 && (
        <p className="coverage-meter__queued">
          {queued.map((h) => `${HORIZON_LABEL[h]} ░ queued`).join(" · ")}
        </p>
      )}

      <p className="coverage-meter__foot">
        {totals.total > 0 && (
          <span>{`${totals.done.toLocaleString()} of ${totals.total.toLocaleString()} events`}</span>
        )}
        {typeof remainingMinutes === "number" && <span>{` · ~${remainingMinutes} min remaining`}</span>}
        <span> · newest first</span>
      </p>

      {/* §14.0 rule 2: a paused lane says so, with its countdown. */}
      {pausedLabel && (
        <p className="coverage-meter__paused" role="status">
          {pausedLabel}
        </p>
      )}
    </section>
  );
}
