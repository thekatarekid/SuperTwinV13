// ===========================================================================
// Library › per-source status strip — V6 P1 S6d L6.
//
// WHAT THE USER SAW. One chip in the app's top-right corner read
//
//     Knows you: 2010 → 32 min ago · importing history — 11,466 events left
//
// while the two connected sources were, at that same moment,
//
//     browser   Knows you: 2010 → 2h ago · 6,649 left  (71% understood)
//     whatsapp  Knows you: 2023 → 4h ago · 4,359 left  (89% understood)
//
// The left edge came from one source, the right edge from the other, and the
// count from adding them — so a user standing in Library › WhatsApp read a
// number that was mostly browser. Product_V6 §7.2 says the Library is "per
// source: capture status · windows · pause · delete"; status belongs INSIDE
// the sub-tab's own panel, not in a global corner.
//
// So this strip is the first row of each source panel, and it states the four
// things about THAT source and nothing else:
//
//   connection   from the source's own consent row (or the panel's own live
//                phrase, which is more specific — "live", "connected ·
//                watching", "capture paused").
//   window       the INDEX / UNDERSTAND floors in force.
//   coverage     that source's own "Knows you: X → Y".
//   progress     that source's own backlog, percent, and verdict.
//
// It NEVER blocks its panel. The strip paints immediately with what the panel
// already knows and fills the rest in when the read lands; a slow or failed
// read leaves a plain "checking…" / one-line reason, never a claim like "up to
// date" that has not been earned. Polling is deliberately slow (the read
// aggregates over that source's slice of the event log, and an import holds
// the same database) and a slow turn skips rather than queueing another.
// ===========================================================================

import { useEffect } from "react";

import { useLoad, type LoadState } from "../../components/LoadState";
import { fetchSourceStatusView, type SourceStatusView } from "../../lib/api";

/** Slow on purpose: this read scans a source's slice of the log. */
export const STATUS_POLL_MS = 20_000;
/** A sub-tab flip inside this window repaints from cache instead of re-asking. */
export const STATUS_FRESH_MS = 10_000;

const CONNECTION_TEXT: Record<string, string> = {
  connected: "connected",
  paused: "capture paused",
  disconnected: "disconnected",
  revoked: "access revoked",
  not_connected: "not connected",
};

function pct(n: number): string {
  return `${Math.max(0, Math.min(100, Math.round(n)))}%`;
}

/**
 * Poll one source's status on the shared `useLoad` contract (W3 + L2): exactly
 * one of { unknown, data, error }, the answer cached per source so a sub-tab
 * flip repaints in the same frame, and one request per source in flight at a
 * time — four flips must not stack four aggregate queries on a busy worker.
 */
export function useSourceStatus(
  source: string,
  pollMs: number = STATUS_POLL_MS,
): LoadState<SourceStatusView> {
  const gate = useLoad<SourceStatusView>(() => fetchSourceStatusView(source), [source], {
    cacheKey: `source-status:${source}`,
    freshFor: STATUS_FRESH_MS,
  });
  const { retry } = gate;
  useEffect(() => {
    if (pollMs <= 0) return;
    const timer = setInterval(retry, pollMs);
    return () => clearInterval(timer);
  }, [retry, pollMs]);
  return gate;
}

export interface SourcePanelStatusProps {
  /** The source this panel owns — "whatsapp" · "browser" · "screen". */
  source: string;
  /** Human name used in the region label ("WhatsApp status"). */
  title: string;
  /**
   * The panel's own, more specific connection phrase when it has one ("live",
   * "connected · watching", "syncing…"). Without it the consent row's state is
   * shown, which is always true but less precise.
   */
  connection?: string | null;
  /**
   * Overrides the window phrase for a source whose window is not a consent
   * window — Screen is live-only and has no history floors.
   */
  window?: string | null;
  pollMs?: number;
}

/**
 * The status row that sits at the top of a Library sub-tab's panel. One
 * source, its own numbers, inside its own boundary.
 */
export function SourcePanelStatus(props: SourcePanelStatusProps): JSX.Element {
  const gate = useSourceStatus(props.source, props.pollMs ?? STATUS_POLL_MS);
  const status = gate.data;
  const error = gate.error;
  const p = status?.progress ?? null;
  const importing = p?.status === "importing_history";
  const connection =
    props.connection ??
    (status?.connection?.state
      ? (CONNECTION_TEXT[status.connection.state] ?? status.connection.state)
      : null);

  return (
    <section
      className="source-status"
      aria-label={`${props.source} status`}
      data-source={props.source}
    >
      <div className="source-status-line">
        <span className="chip source-status-state">{connection ?? "checking…"}</span>
        <span className="meta source-status-window">
          {props.window ?? status?.window_label ?? "window: checking…"}
        </span>
        <span className="source-status-spacer" />
        <span className="meta source-status-coverage">
          {/* Optional all the way down on purpose: a malformed or older body
              must degrade to "we don't know yet", never take the panel out. */}
          {status
            ? (status.coverage?.label ?? "nothing understood yet")
            : `reading ${props.title}'s coverage…`}
        </span>
      </div>

      <div className="source-status-line">
        {p ? (
          <>
            <span className={`meta source-status-verdict source-status-${p.status}`}>
              {p.status_label}
            </span>
            <span className="meta source-status-counts">
              {p.understood_count.toLocaleString("en-US")} of{" "}
              {p.event_count.toLocaleString("en-US")} events understood ·{" "}
              {pct(p.understood_percent)}
            </span>
          </>
        ) : (
          <span className="meta source-status-verdict">checking {props.title}…</span>
        )}
      </div>

      {p && p.event_count > 0 && (
        <div
          className={`source-status-bar${importing ? " importing" : ""}`}
          role="progressbar"
          aria-label={`${props.source} understood`}
          aria-valuenow={Math.round(p.understood_percent)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className="source-status-fill" style={{ width: pct(p.understood_percent) }} />
        </div>
      )}

      {error !== null && (
        <p className="meta source-status-error">
          {status ? `status last read before: ${error}` : error}
        </p>
      )}
    </section>
  );
}
