// ===========================================================================
// [CODE] Adapter-boundary normalisation — what the core is allowed to see
// (build item 1.1; evals A-021…A-030).
//
// Two guards every source needs and no source should re-implement:
//
//   1. **Non-content frames never become rows.** A read receipt, a delivery
//      ack, a typing indicator and a presence update are protocol chatter. They
//      outnumber messages several to one, they carry no text, and a row for
//      each of them would poison every count the segmenter and the tier
//      classifier take. They are dropped AT THE ADAPTER, before ingestion —
//      not filtered later by a reader that might forget.
//
//   2. **A timestamp from the future is clamped, and says so.** `events.ts` is
//      "when it was said" and the ONLY basis for precedence (arch §3.3 rule 8).
//      A phone with a wrong clock, or a daemon translating a timezone badly,
//      can hand us a message dated tomorrow — and one such row sorts ahead of
//      everything real forever. Anything more than five minutes past now is
//      pulled back to now and flagged, so the row is still ingested (never
//      dropped — it is a real message) but cannot outrank the present.
//
// Both are pure functions: the adapter calls them, the tests call them, and the
// eval executor calls the same code the product does.
// ===========================================================================

import type { EventKind, SourceEvent } from "./types.js";

// ---- 1. Non-content frames ------------------------------------------------

/**
 * The event kinds that are CONTENT — the ones worth a row. Anything a source
 * emits that is not in here is protocol chatter and is dropped.
 *
 * This is the `EventKind` union restated as a runtime set. A source that starts
 * emitting a new kind must widen both together, which is the point: a kind
 * nobody declared is a kind nobody segments.
 */
export const CONTENT_EVENT_KINDS: ReadonlySet<string> = new Set<EventKind>([
  "message",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
  "revoked",
  "reaction",
  "system",
  "poll",
  "poll_vote",
  "live_location",
  "call",
]);

/**
 * Protocol chatter, named so a dropped frame can be explained rather than just
 * vanishing. Not exhaustive by design — the rule is the allow-list above; this
 * list only makes the common cases legible in a log line.
 */
export const NON_CONTENT_EVENT_KINDS: ReadonlySet<string> = new Set([
  "receipt",
  "read_receipt",
  "read",
  "delivery_ack",
  "ack",
  "typing",
  "composing",
  "chat_state",
  "presence",
  "presence_update",
  "available",
  "unavailable",
]);

/** True when this kind earns an `events` row. */
export function isContentKind(kind: unknown): boolean {
  return typeof kind === "string" && CONTENT_EVENT_KINDS.has(kind);
}

/** True when the frame is protocol chatter and must be dropped at the adapter. */
export function isNonContentKind(kind: unknown): boolean {
  return !isContentKind(kind);
}

// ---- 2. Clock skew --------------------------------------------------------

/**
 * How far into the future a timestamp may sit before it is clamped. Five
 * minutes absorbs ordinary phone clock drift and the daemon's own round trip;
 * beyond that the clock is wrong, not late.
 */
export const SKEW_TOLERANCE_MS = 5 * 60_000;

export interface SkewResult {
  /** The timestamp to store — clamped to `now` when it was too far ahead. */
  ts: string;
  /** The original value, present only when it was clamped. */
  clamped_from?: string;
  clamped: boolean;
}

/**
 * Clamp a future timestamp to `now`, flagging what it was.
 *
 * Anything at or before `now + 5 min` is accepted verbatim — including every
 * past timestamp, however old, because backfilled history is supposed to be old
 * and a floor would rewrite it. An unparseable timestamp is handed back
 * untouched: inventing a `ts` for it would be worse than storing what the
 * source said.
 */
export function clampSkew(ts: string, nowMs: number = Date.now()): SkewResult {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return { ts, clamped: false };
  if (t <= nowMs + SKEW_TOLERANCE_MS) return { ts, clamped: false };
  return { ts: new Date(nowMs).toISOString(), clamped_from: ts, clamped: true };
}

/**
 * Apply both guards to one event. Returns null when the frame is not content
 * (the caller drops it), else the event with a clamped `ts` and, when it was
 * clamped, `skew_clamped_from` recording what the source claimed.
 */
export function normalizeSourceEvent(
  e: SourceEvent,
  nowMs: number = Date.now(),
): SourceEvent | null {
  if (isNonContentKind(e.kind)) return null;
  const skew = clampSkew(e.ts, nowMs);
  if (!skew.clamped) return e;
  return { ...e, ts: skew.ts, skew_clamped_from: skew.clamped_from };
}
