// [CODE] "Every session boundary is explainable in one line" — the acceptance
// test for build item 1.11, over §10.4's recorded boundaries.
//
//   START: gap 7h20m > 6h            END: debounce 45m idle ≥ 45m
//
// The segmenter records a REASON plus the numbers it MEASURED (segment.ts
// `BoundaryRecord`). This module turns that pair into one sentence. It never
// invents a number: everything printed came out of `measured`.
//
// The fallback matters as much as the twelve cases. A reason this module has
// not been taught still gets a line — its name and every measured key — because
// a boundary rendered as a bare label is exactly the failure the acceptance
// criterion exists to catch, and a segmenter shipping a thirteenth rule must
// degrade to "verbose" rather than to "unexplained".

import type { BoundaryView } from "../../lib/surfaces-client";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** 7h20m · 45m · 30s. Compact, because it sits inline in a sentence. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "∞";
  const abs = Math.max(0, Math.round(ms));
  if (abs < MINUTE) return `${Math.round(abs / SECOND)}s`;
  if (abs < HOUR) return `${Math.round(abs / MINUTE)}m`;
  const hours = Math.floor(abs / HOUR);
  const minutes = Math.round((abs % HOUR) / MINUTE);
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

type Measured = Readonly<Record<string, number | string | boolean>>;

function num(measured: Measured, key: string): number | null {
  const value = measured[key];
  return typeof value === "number" ? value : null;
}

function str(measured: Measured, key: string): string | null {
  const value = measured[key];
  return value === undefined ? null : String(value);
}

function dur(measured: Measured, key: string): string | null {
  const value = num(measured, key);
  return value === null ? null : formatDuration(value);
}

/** Everything we were given, verbatim. The last resort, never a blank. */
function verbose(reason: string, measured: Measured): string {
  const pairs = Object.entries(measured).map(([key, value]) => `${key}=${String(value)}`);
  return pairs.length > 0 ? `${reason} · ${pairs.join(" · ")}` : reason;
}

/**
 * One line for one boundary: the rule that fired and the value it fired on.
 */
export function explainBoundary(boundary: BoundaryView): string {
  const m = boundary.measured;
  switch (boundary.reason) {
    case "gap": {
      const gap = dur(m, "gap_ms");
      const threshold = dur(m, "threshold_ms");
      if (gap && threshold) return `gap ${gap} > ${threshold}`;
      break;
    }
    case "ceiling": {
      const span = dur(m, "span_ms");
      const ceiling = dur(m, "ceiling_ms");
      if (span && ceiling) return `ceiling ${ceiling} reached — span ${span}`;
      break;
    }
    case "debounce": {
      const idle = dur(m, "idle_ms");
      const window = dur(m, "debounce_ms");
      if (idle && window) return `debounce ${idle} idle ≥ ${window}`;
      break;
    }
    case "reply_break": {
      const age = dur(m, "reply_age_ms");
      const threshold = dur(m, "threshold_ms");
      const target = str(m, "target");
      if (age && threshold) {
        return `reply chain break — target ${age} old > ${threshold}${target ? ` (${target})` : ""}`;
      }
      break;
    }
    case "participant_shift": {
      const gap = dur(m, "gap_ms");
      const min = dur(m, "shift_min_gap_ms");
      const from = str(m, "initiator");
      const to = str(m, "actor");
      if (gap && min && from && to) {
        return `participant shift ${from} → ${to} after ${gap} (≥ ${min})`;
      }
      break;
    }
    case "author_shift": {
      const gap = dur(m, "gap_ms");
      const from = str(m, "previous_author");
      const to = str(m, "author");
      if (from && to) return `author shift ${from} → ${to}${gap ? ` after ${gap}` : ""}`;
      break;
    }
    case "context_shift": {
      const silence = dur(m, "silence_ms");
      const threshold = dur(m, "threshold_ms");
      if (silence && threshold) return `context shift — silence ${silence} > ${threshold}`;
      const from = str(m, "previous_context");
      const to = str(m, "context");
      if (from && to) return `context shift ${from} → ${to}`;
      break;
    }
    case "day_boundary": {
      const from = str(m, "from_day");
      const to = str(m, "to_day");
      const tz = str(m, "tz");
      if (from && to) return `local midnight ${from} → ${to}${tz ? ` (${tz})` : ""}`;
      break;
    }
    case "size_cap": {
      const events = num(m, "events");
      const capEvents = num(m, "cap_events");
      if (events !== null && capEvents !== null) {
        return `size cap — ${events} events at cap ${capEvents}`;
      }
      const tokens = num(m, "tokens");
      const capTokens = num(m, "cap_tokens");
      if (tokens !== null && capTokens !== null) {
        return `size cap — ${tokens} tokens at cap ${capTokens}`;
      }
      const active = dur(m, "active_ms");
      const capActive = dur(m, "cap_active_ms");
      if (active && capActive) return `size cap — active ${active} at cap ${capActive}`;
      break;
    }
    case "record_bounded": {
      const rule = str(m, "rule");
      if (rule === "transaction") {
        return `transaction — a ${str(m, "kind") ?? "transaction"} is always its own session`;
      }
      if (rule === "transaction_sealed_alone") return "previous transaction sealed alone";
      const record = str(m, "record");
      if (record) return `record ${record} is the session — no cap applies`;
      break;
    }
    case "stream_start":
      return "stream start — the first event on this stream";
    case "late_arrival": {
      const overlap = str(m, "overlap_of");
      if (overlap) return `late arrival inside sealed session ${overlap}`;
      break;
    }
  }
  return verbose(boundary.reason, m);
}

/**
 * The line as the surface prints it. An open session has no end RULE yet, and
 * says so rather than showing an empty slot that reads like a missing value.
 */
export function boundaryLine(
  which: "START" | "END",
  boundary: BoundaryView | null,
  status: "open" | "sealed",
): string {
  if (boundary) return `${which}: ${explainBoundary(boundary)}`;
  return which === "END" && status === "open"
    ? "END: open — no end rule has fired yet"
    : `${which}: not recorded`;
}
