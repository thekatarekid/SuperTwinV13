// ===========================================================================
// [CODE] Per-source status — V6 P1 S6d L6 (Product_V6 §7.2: "Library ──── per
// source: capture status · windows · pause · delete").
//
// WHAT WAS WRONG. Status was one chip in the app's top-right corner, and it
// was a SUM. On the reporting user's machine it read
//
//     Knows you: 2010 → 32 min ago · importing history — 11,466 events left
//
// while the two connected sources were actually
//
//     browser   Knows you: 2010 → 2h ago · 6,649 left  (71% understood)
//     whatsapp  Knows you: 2023 → 4h ago · 4,359 left  (89% understood)
//
// Neither source has the range the chip printed and neither has that backlog:
// the left edge came from one source, the right edge from the other, and the
// count from adding them. A user standing in Library › WhatsApp was reading a
// number that was mostly browser. `freshnessOverview()` already computed the
// honest per-source rows — nothing surfaced them.
//
// WHAT THIS IS. The one read a Library sub-tab makes about ITS OWN source, so
// the panel can state, inside its own boundary, the four things Product_V6
// §7.2 asks for:
//
//   connection   the live consent row's state ('connected' · 'paused' ·
//                'disconnected' · 'revoked'), or 'not_connected' when there is
//                no consent row at all. Consent is the truth about a source
//                being connected — never "are there events yet".
//   windows      the INDEX and UNDERSTAND floors in force, from that same row,
//                rendered as one honest phrase ("index everything · understand
//                from 7 Aug 2026").
//   coverage     this source's own understood range — its own "Knows you".
//   progress     this source's own backlog, percent and verdict, straight off
//                `sourceFreshness`.
//
// Cost note: `sourceFreshness` aggregates over `events WHERE source_type = ?`,
// which is one source's slice rather than every source plus the DISTINCT scan
// `freshnessOverview` pays for. There is no index on `source_type`, so this is
// still a scan of that slice — the panel polls it on a slow cadence and never
// blocks its first paint on it.
//
// Pure read. No writes, no model calls.
// ===========================================================================

import { getConsent, type ConsentState } from "../db/v6core.js";
import { sourceFreshness, type FreshnessStatus } from "../freshness/index.js";

/** `not_connected` = no consent row at all; the rest are the row's own state. */
export type SourceConnectionState = ConsentState | "not_connected";

export interface SourceWindows {
  /** INDEX window is everything the source will give. */
  index_all: boolean;
  /** INDEX floor (ISO) when `index_all` is false. */
  index_from: string | null;
  /** UNDERSTAND floor (ISO); null = nothing goes to the model. */
  understand_from: string | null;
}

export interface SourceStatusView {
  source_id: string;
  connection: {
    state: SourceConnectionState;
    /** True only for a live consent row in the 'connected' state. */
    capturing: boolean;
    granted_at: string | null;
  };
  /** The consent row's windows, or null when the source has no consent row. */
  windows: SourceWindows | null;
  /** The windows as one phrase — "index everything · understand from 7 Aug 2026". */
  window_label: string;
  coverage: {
    captured_from: string | null;
    captured_to: string | null;
    understood_from: string | null;
    understood_to: string | null;
    /** THIS source's own "Knows you: X → Y", never the cross-source union. */
    label: string | null;
  };
  progress: {
    status: FreshnessStatus;
    /** THIS source's own phrase — "importing history — 4,359 events left". */
    status_label: string;
    detail: string;
    /**
     * The denominator of "X of N events understood": events inside the
     * UNDERSTAND window. FIX-C5 — this was the whole log, so a source with a
     * large searchable-only archive behind it (browser: 15,931 of 23,214 rows)
     * read "632 of 23,214 · 9%", pairing a count of what was read with a total
     * that includes rows no model will ever see. `captured_count` is that
     * total, under its own name.
     */
    event_count: number;
    /** Everything the log holds for this source, archive rows included. */
    captured_count: number;
    /** Events that carry an episode (freshness/understood.ts). */
    understood_count: number;
    understood_percent: number;
    pending_live_count: number;
    /** THIS source's own backlog — never a sum across sources. */
    pending_backfill_count: number;
    backfill_complete: boolean;
    lag_minutes: number | null;
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "7 Aug 2026" — a floor is a date, and a date the user can recognise. */
export function floorLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The window in force, as one phrase. No consent row is its own sentence —
 * "not connected" is a state, not an empty window.
 *
 * The UNDERSTAND half never guesses: `understand_from` null means nothing has
 * been sent to a model, and the phrase says exactly that.
 */
export function windowLabel(w: SourceWindows | null): string {
  if (!w) return "no window — not connected";
  const index = w.index_all
    ? "index everything"
    : w.index_from
      ? `index from ${floorLabel(w.index_from)}`
      : "index nothing";
  const understand = w.understand_from
    ? `understand from ${floorLabel(w.understand_from)}`
    : "understand: nothing goes to the model";
  return `${index} · ${understand}`;
}

/**
 * One source's whole status. `nowMs` is injectable so the relative edges in
 * the coverage label are testable against a fixed clock.
 */
export function sourceStatus(sourceId: string, nowMs: number = Date.now()): SourceStatusView {
  const consent = getConsent(sourceId);
  const f = sourceFreshness(sourceId, nowMs);
  const windows: SourceWindows | null = consent
    ? {
        index_all: consent.indexAll,
        index_from: consent.indexFrom,
        understand_from: consent.understandFrom,
      }
    : null;
  return {
    source_id: sourceId,
    connection: {
      state: consent ? consent.state : "not_connected",
      capturing: consent?.state === "connected",
      granted_at: consent ? consent.grantedAt : null,
    },
    windows,
    window_label: windowLabel(windows),
    coverage: {
      captured_from: f.captured_from,
      captured_to: f.captured_to,
      understood_from: f.understood_from,
      understood_to: f.understood_to,
      label: f.label,
    },
    progress: {
      status: f.status,
      status_label: f.status_label,
      detail: f.detail,
      event_count: f.understand_window_count,
      captured_count: f.event_count,
      understood_count: f.understood_count,
      understood_percent: f.understood_percent,
      pending_live_count: f.pending_live_count,
      pending_backfill_count: f.pending_backfill_count,
      backfill_complete: f.backfill_complete,
      lag_minutes: f.lag_minutes,
    },
  };
}
