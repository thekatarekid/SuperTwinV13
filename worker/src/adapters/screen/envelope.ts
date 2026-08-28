// ===========================================================================
// screen.snapshot → v13 event envelope (build P2.1, spec §4.2.2 / §6.1).
//
// One snapshot frame becomes one `screen.snapshot` event through the P0.4
// single-writer. The event stores the DIFF (`new_chars`, which is also the
// FTS projection) plus the hashes; identity for idempotent append is
// stream_key + content_hash + the diff, so a restart replaying the same
// frame dedupes while a genuine revert (A→B→A) still lands.
//
// Reference enrichment (spec §4.2.2, P0.8 pattern): links/files seen in the
// tree ride on the payload marked `content_pending: true` — the backlog of
// things lane E / the SuperTwin Browser fetches later stays queryable.
// ===========================================================================

import { createHash } from "node:crypto";

import type { EventEnvelope } from "../../db/eventlog.js";
import { ageBandOf, SELF_ROLES } from "../browser/envelope.js";
import type { SnapshotFrame } from "./frames.js";

export const SCREEN_SOURCE_ID = "screen";

/** A link/file seen in the AX tree, queued for fetch-by-reference. */
export interface PendingRef {
  ref: string;
  content_pending: true;
}

export interface ScreenSnapshotPayload extends Record<string, unknown> {
  bundle_id: string;
  app_name: string;
  window_title: string;
  doc_key: string;
  trigger: string;
  tree_hash: string;
  content_hash: string;
  /** Full-text length of the capture (the event itself stores the diff). */
  char_count: number;
  /** FTS projection (db/eventlog.ts) — the `new_chars` diff. */
  text: string;
  links: PendingRef[];
  files: PendingRef[];
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * Links referenced by a snapshot: what the sidecar's AX walk collected
 * (AXURL attributes) plus URLs spelled out in the new text — deduped,
 * order-preserving, capped so a link farm cannot bloat the row.
 */
export function collectLinks(frame: SnapshotFrame, cap = 32): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (url: string): void => {
    const u = url.trim();
    if (!u || seen.has(u) || out.length >= cap) return;
    seen.add(u);
    out.push(u);
  };
  for (const l of frame.links) push(l);
  for (const m of frame.new_chars.match(URL_RE) ?? []) push(m);
  return out;
}

/**
 * Append identity: stream + full-content hash + the diff. Same frame replayed
 * (sidecar restart, fixture re-run) ⇒ same hash ⇒ single-writer dedupe; a
 * revert to earlier content diffs differently, so it still lands.
 */
export function screenEventHash(frame: SnapshotFrame): string {
  return createHash("sha256")
    .update(
      ["screen", frame.stream_key, frame.content_hash, frame.new_chars].join(
        "¦",
      ),
    )
    .digest("hex");
}

/** Map one sidecar snapshot onto the single-writer's input shape. */
export function toScreenEnvelope(
  frame: SnapshotFrame,
  nowMs: number = Date.now(),
): EventEnvelope {
  const payload: ScreenSnapshotPayload = {
    bundle_id: frame.bundle_id,
    app_name: frame.app_name,
    window_title: frame.window_title,
    doc_key: frame.doc_key,
    trigger: frame.trigger,
    tree_hash: frame.tree_hash,
    content_hash: frame.content_hash,
    char_count: frame.char_count,
    text: frame.new_chars,
    links: collectLinks(frame).map((ref) => ({ ref, content_pending: true })),
    files: frame.files.map((ref) => ({ ref, content_pending: true })),
  };
  return {
    ts: frame.ts,
    capturedAt: new Date(nowMs).toISOString(),
    source: SCREEN_SOURCE_ID,
    kind: "screen.snapshot",
    // The screen has no backfill: every capture is the live present.
    origin: "live",
    ageBand: ageBandOf(Date.parse(frame.ts) || nowMs, nowMs),
    streamKey: frame.stream_key,
    actor: "self",
    roles: SELF_ROLES,
    payload,
    contentHash: screenEventHash(frame),
    blobRefs: [],
  };
}
