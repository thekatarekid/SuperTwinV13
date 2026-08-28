// ===========================================================================
// [CODE] Per-stream capture pause (build P2.4, spec §14.3.2).
//
// The Library's ⏸ is a CAPTURE control, honored at the single-writer ingest
// funnels: db/eventlog.appendEvents and db/ingest.insertEvent both consult
// `isCapturePaused` before writing, so a paused chat's messages are dropped
// on arrival — never stored-but-hidden. Source-level pause stays where it
// was (db/ingest.pausedKey settings key); this is the per-stream refinement.
//
// Every flip writes a decision row (single-writer convention: derived-state
// change → decision, reversible — the old/new payloads are the two states).
// ===========================================================================

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";

/** Is this stream's capture paused? Missing stream → not paused. */
export function isStreamCapturePaused(streamId: string): boolean {
  const r = getDb()
    .prepare(`SELECT capture_paused FROM streams WHERE id = ?`)
    .get(streamId) as { capture_paused: number } | undefined;
  return r?.capture_paused === 1;
}

/** Pause lookup by the envelope's (source, stream_key) — the appendEvents gate. */
export function isCapturePaused(source: string, streamKey: string): boolean {
  const r = getDb()
    .prepare(`SELECT capture_paused FROM streams WHERE source_id = ? AND external_key = ?`)
    .get(source, streamKey) as { capture_paused: number } | undefined;
  return r?.capture_paused === 1;
}

/**
 * Flip one stream's capture pause. Returns the decision id, or null when the
 * stream is missing or already in the requested state (idempotent: a no-op
 * writes no decision).
 */
export function setStreamCapturePaused(
  streamId: string,
  paused: boolean,
  by = "user",
): string | null {
  const db = getDb();
  const before = db
    .prepare(`SELECT id, capture_paused FROM streams WHERE id = ?`)
    .get(streamId) as { id: string; capture_paused: number } | undefined;
  if (!before) return null;
  const next = paused ? 1 : 0;
  if (before.capture_paused === next) return null;
  db.prepare(`UPDATE streams SET capture_paused = ? WHERE id = ?`).run(next, streamId);
  return writeDecision({
    pass: by,
    targetKind: "stream",
    targetId: streamId,
    action: paused ? "capture_pause" : "capture_resume",
    old: { capture_paused: before.capture_paused === 1 },
    new: { capture_paused: paused },
    reason: paused
      ? "user paused capture for this stream in Library"
      : "user resumed capture for this stream in Library",
  });
}
