// ===========================================================================
// Adapter-boundary normalisation (build item 1.1; evals A-021…A-030).
//
// Two guards, two properties:
//   - protocol chatter never becomes a row;
//   - a timestamp more than five minutes in the future is clamped and flagged,
//     and everything else — including two-year-old backfill — passes untouched.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  clampSkew,
  isContentKind,
  isNonContentKind,
  normalizeSourceEvent,
  SKEW_TOLERANCE_MS,
} from "./normalize.js";
import type { EventKind, SourceEvent } from "./types.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function event(over: Partial<SourceEvent> = {}): SourceEvent {
  return {
    external_id: "chat@x/MSG1",
    stream_ext_id: "chat@x",
    actor_ext_id: "alice@x",
    ts: "2026-08-15T11:59:00.000Z",
    kind: "message",
    text: "hi",
    from_me: false,
    ...over,
  };
}

describe("non-content frames (A-021…A-024)", () => {
  it("drops read receipts, delivery acks, typing indicators and presence", () => {
    for (const kind of ["read_receipt", "receipt", "delivery_ack", "ack", "typing", "composing", "presence"]) {
      expect(isNonContentKind(kind)).toBe(true);
      expect(normalizeSourceEvent(event({ kind: kind as EventKind }), NOW)).toBeNull();
    }
  });

  it("keeps every kind that carries content", () => {
    const kinds: EventKind[] = [
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
    ];
    for (const kind of kinds) {
      expect(isContentKind(kind)).toBe(true);
      expect(normalizeSourceEvent(event({ kind }), NOW)).not.toBeNull();
    }
  });

  it("drops a kind nobody declared rather than segmenting it", () => {
    expect(normalizeSourceEvent(event({ kind: "telemetry" as EventKind }), NOW)).toBeNull();
    expect(isContentKind(undefined)).toBe(false);
  });
});

describe("clock skew (A-025…A-030)", () => {
  const at = (ms: number): string => new Date(NOW + ms).toISOString();

  it("accepts anything at or before now + 5 min verbatim", () => {
    for (const delta of [-2 * 60_000, -30 * 24 * 3600_000, 30_000, 3 * 60_000, SKEW_TOLERANCE_MS]) {
      const ts = at(delta);
      expect(clampSkew(ts, NOW)).toEqual({ ts, clamped: false });
    }
  });

  it("clamps a timestamp beyond the tolerance and records what it was", () => {
    for (const delta of [12 * 60_000, 6 * 3600_000, 24 * 3600_000]) {
      const ts = at(delta);
      const out = clampSkew(ts, NOW);
      expect(out.clamped).toBe(true);
      expect(out.ts).toBe(new Date(NOW).toISOString());
      expect(out.clamped_from).toBe(ts);
    }
  });

  it("hands an unparseable timestamp back untouched rather than inventing one", () => {
    expect(clampSkew("whenever", NOW)).toEqual({ ts: "whenever", clamped: false });
  });

  it("normalizeSourceEvent carries the clamp onto the event", () => {
    const future = at(12 * 60_000);
    const out = normalizeSourceEvent(event({ ts: future }), NOW);
    expect(out?.ts).toBe(new Date(NOW).toISOString());
    expect(out?.skew_clamped_from).toBe(future);
  });

  it("leaves an in-tolerance event object identical (no needless copy)", () => {
    const e = event({ ts: at(30_000) });
    expect(normalizeSourceEvent(e, NOW)).toBe(e);
  });
});
