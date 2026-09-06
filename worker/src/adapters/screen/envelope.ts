// ===========================================================================
// screen.snapshot → v13 event envelope (build P2.1, spec §4.2.2 / §6.1;
// V6 P1 S1.6 — Product_V6_Phase1 §"Screen": app · title · doc key · full
// text · roles; anchor + diff).
//
// One snapshot frame becomes one `screen.snapshot` event through the P0.4
// single-writer. The event ROW stores the DIFF (`new_chars`, which is also the
// FTS projection) plus the hashes; identity for idempotent append is
// stream_key + content_hash + the diff, so a restart replaying the same
// frame dedupes while a genuine revert (A→B→A) still lands.
//
// The FULL text is persisted too (T6-8 / T5-4 — before S1.6, 71.7% of the
// captured characters were deleted at this line): content-addressed into
// `blobs` (0200_v6_core) as ANCHOR + DIFF per stream. The first capture of a
// stream is stored whole (the anchor); each later capture is stored as a
// patch against that anchor — common prefix length, common suffix length, the
// middle — with the anchor's address inside it, so the exact text is
// recoverable from the two blobs and no heartbeat re-stores 22 KB. The stream
// re-anchors when the patch stops paying for itself (middle > half the text)
// or every RE_ANCHOR_EVERY captures, so a reconstruction never chases a long
// chain: one anchor blob + one diff blob, always.
//
// References (spec §4.2.2): links/files seen in the tree ride on the payload
// as plain strings. The `content_pending` marker was deleted in V6 P1 S0.5
// (Build §2.3 / T6-14): writers existed, readers never did.
// ===========================================================================

import { createHash } from "node:crypto";

import type { EventEnvelope, EventIdentity } from "../../db/eventlog.js";
import { blobAddress, getBlobText, putBlob } from "../../db/v6core.js";
import { ageBandOf, SELF_ROLES } from "../browser/envelope.js";
import type { SnapshotFrame } from "./frames.js";
import { docPathOf, docStreamKey, screenStreamKey, sessionIdOf, type ScreenSessionTracker } from "../stream-keys.js";

export const SCREEN_SOURCE_ID = "screen";

/** blobs.kind for a stored anchor (the full text of one capture). */
export const SCREEN_ANCHOR_BLOB_KIND = "screen.text";
/** blobs.kind for a stored diff record (JSON patch against an anchor). */
export const SCREEN_DIFF_BLOB_KIND = "screen.diff";
/** Re-anchor after this many diffs, whatever their size (T5-4: "~20"). */
export const RE_ANCHOR_EVERY = 20;
/** Re-anchor when the patch middle exceeds this share of the new text. */
export const RE_ANCHOR_RATIO = 0.5;

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
  /** Links seen in the AX tree + spelled out in the new text. */
  links: string[];
  /** File references seen in the AX tree. */
  files: string[];
  /**
   * How the full text is persisted (V6 S1.6): `anchor` — `text_ref` is the
   * blob holding the whole text; `diff` — `text_ref` is a patch blob whose
   * `anchor_ref` names the anchor it applies to. Absent when the blob write
   * failed (the event still lands; the row's diff is all that survives).
   */
  storage?: "anchor" | "diff";
  /** blobs.sha256 of this capture's stored record (anchor text or patch). */
  text_ref?: string;
  /** blobs.sha256 of the anchor the record resolves against (== text_ref for an anchor). */
  anchor_ref?: string;
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

/** app · window title · doc key — the identity the packed head shows (SRC-03). */
export function screenIdentity(frame: {
  app_name: string;
  window_title: string;
  doc_key: string;
}): EventIdentity {
  return {
    app: frame.app_name || null,
    windowTitle: frame.window_title || null,
    docKey: frame.doc_key || null,
  };
}

// ---- Anchor + diff storage --------------------------------------------------

/** The stored patch record (JSON, blobs.kind = screen.diff). */
export interface ScreenDiffRecord {
  v: 1;
  /** blobs.sha256 of the anchor text this patch applies to. */
  anchor: string;
  /** Characters (UTF-16 code units) shared with the anchor at the start… */
  prefix: number;
  /** …and at the end. */
  suffix: number;
  /** What sits between them in the new text. */
  middle: string;
  /** Length of the reconstructed text — a checksum for the splice. */
  length: number;
}

/** What one capture's persistence produced — merged onto the payload. */
export interface StoredScreenText {
  storage: "anchor" | "diff";
  text_ref: string;
  anchor_ref: string;
  /** In blob_refs order: [text_ref] for an anchor, [text_ref, anchor_ref] for a diff. */
  blobRefs: string[];
}

/** The blob writer the store needs — production is v6core.putBlob. */
export type BlobPut = (data: string, kind: string) => { sha256: string };

interface StreamAnchor {
  sha256: string;
  text: string;
  diffsSince: number;
}

/** Common prefix / suffix lengths (non-overlapping) between two strings. */
export function commonEnds(a: string, b: string): { prefix: number; suffix: number } {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (
    s < max - p &&
    a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)
  ) {
    s++;
  }
  return { prefix: p, suffix: s };
}

/**
 * Per-stream anchor memory + the store/re-anchor decision. One instance per
 * adapter; a restart simply re-anchors every stream on its first capture
 * (the anchor is content-addressed, so a repeat of the same text costs a
 * refs bump, not a second copy).
 */
export class ScreenTextStore {
  private readonly anchors = new Map<string, StreamAnchor>();
  private readonly put: BlobPut;
  private readonly reAnchorEvery: number;
  private readonly reAnchorRatio: number;

  constructor(
    opts: { put?: BlobPut; reAnchorEvery?: number; reAnchorRatio?: number } = {},
  ) {
    this.put = opts.put ?? ((data, kind) => putBlob(data, kind));
    this.reAnchorEvery = opts.reAnchorEvery ?? RE_ANCHOR_EVERY;
    this.reAnchorRatio = opts.reAnchorRatio ?? RE_ANCHOR_RATIO;
  }

  /** The stream's current anchor address (tests, Library). */
  anchorOf(streamKey: string): string | null {
    return this.anchors.get(streamKey)?.sha256 ?? null;
  }

  /** Forget a stream (disconnect / delete verbs). */
  forget(streamKey: string): void {
    this.anchors.delete(streamKey);
  }

  /**
   * Persist the frame's FULL text. Returns the refs to carry on the event.
   * Throws only if the blob writer throws — the adapter decides what an
   * unpersisted capture means (it lands without refs; it is never dropped).
   */
  record(frame: Pick<SnapshotFrame, "stream_key" | "text">): StoredScreenText {
    const text = frame.text;
    const prev = this.anchors.get(frame.stream_key);
    if (prev) {
      const { prefix, suffix } = commonEnds(prev.text, text);
      const middle = text.slice(prefix, text.length - suffix);
      const worthIt =
        prev.diffsSince < this.reAnchorEvery &&
        middle.length <= Math.max(0, Math.floor(text.length * this.reAnchorRatio));
      if (worthIt) {
        const rec: ScreenDiffRecord = {
          v: 1,
          anchor: prev.sha256,
          prefix,
          suffix,
          middle,
          length: text.length,
        };
        const { sha256 } = this.put(JSON.stringify(rec), SCREEN_DIFF_BLOB_KIND);
        prev.diffsSince += 1;
        return {
          storage: "diff",
          text_ref: sha256,
          anchor_ref: prev.sha256,
          blobRefs: [sha256, prev.sha256],
        };
      }
    }
    const { sha256 } = this.put(text, SCREEN_ANCHOR_BLOB_KIND);
    this.anchors.set(frame.stream_key, { sha256, text, diffsSince: 0 });
    return { storage: "anchor", text_ref: sha256, anchor_ref: sha256, blobRefs: [sha256] };
  }
}

/** Splice a patch onto its anchor. Throws on a corrupt record. */
export function applyScreenDiff(anchorText: string, rec: ScreenDiffRecord): string {
  if (rec.v !== 1) throw new Error(`screen diff: unknown record version ${String(rec.v)}`);
  if (rec.prefix < 0 || rec.suffix < 0 || rec.prefix + rec.suffix > anchorText.length) {
    throw new Error("screen diff: prefix/suffix exceed the anchor");
  }
  const out =
    anchorText.slice(0, rec.prefix) +
    rec.middle +
    (rec.suffix === 0 ? "" : anchorText.slice(anchorText.length - rec.suffix));
  if (out.length !== rec.length) {
    throw new Error(`screen diff: reconstructed ${out.length} chars, record says ${rec.length}`);
  }
  return out;
}

/**
 * The full text behind a stored screen event: anchor blob, or patch blob +
 * its anchor. `null` when nothing was persisted (blob write failed at
 * capture) or a referenced blob is gone. Reader-side counterpart of
 * ScreenTextStore.record — SRC-04 asserts the round trip.
 */
export function reconstructScreenText(
  payload: Record<string, unknown>,
  getText: (sha256: string) => string | null = getBlobText,
): string | null {
  const ref = typeof payload.text_ref === "string" ? payload.text_ref : null;
  if (!ref) return null;
  const stored = getText(ref);
  if (stored === null) return null;
  if (payload.storage === "anchor") return stored;
  if (payload.storage !== "diff") return null;
  let rec: ScreenDiffRecord;
  try {
    rec = JSON.parse(stored) as ScreenDiffRecord;
  } catch {
    return null;
  }
  const anchorSha =
    typeof payload.anchor_ref === "string" ? payload.anchor_ref : rec.anchor;
  const anchor = getText(anchorSha);
  if (anchor === null) return null;
  return applyScreenDiff(anchor, rec);
}

/** Address a text would be stored under (tests, Library) — v6core.blobAddress. */
export function screenBlobAddress(text: string): string {
  return blobAddress(text);
}

// ---- Stream key (V6 S3.4) ------------------------------------------------------

/**
 * The stream a frame belongs to (adapters/stream-keys.ts):
 *
 *   doc:<path>                   — doc_key names a file (AXDocument path / file URL):
 *                                  one document, whichever app shows it;
 *   screen:<bundleId>:<session>  — otherwise: one app session, closed by the
 *                                  30-minute idle gap the tracker enforces.
 *
 * The sidecar's own `bundleId¦docKey` stays the dedup / diff-anchor identity
 * (ScreenTextStore, screenEventHash) — that is per document, this is per stream.
 * Without a tracker every frame opens its own session (tests, one-off calls).
 */
export function screenStreamKeyFor(
  frame: Pick<SnapshotFrame, "bundle_id" | "doc_key" | "ts">,
  sessions?: ScreenSessionTracker,
): string {
  const path = docPathOf(frame.doc_key);
  if (path) return docStreamKey(path);
  const tsMs = Date.parse(frame.ts);
  const at = Number.isFinite(tsMs) ? tsMs : Date.now();
  const session = sessions ? sessions.sessionFor(frame.bundle_id, at) : sessionIdOf(at);
  return screenStreamKey(frame.bundle_id, session);
}

// ---- The envelope ------------------------------------------------------------

/**
 * Map one sidecar snapshot onto the single-writer's input shape. `stored`
 * (from ScreenTextStore.record) rides on the payload + blob_refs; without it
 * the event still lands, carrying only the diff in its row.
 */
export function toScreenEnvelope(
  frame: SnapshotFrame,
  nowMs: number = Date.now(),
  stored?: StoredScreenText | null,
  streamKey: string = screenStreamKeyFor(frame),
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
    links: collectLinks(frame),
    files: [...frame.files],
  };
  if (stored) {
    payload.storage = stored.storage;
    payload.text_ref = stored.text_ref;
    payload.anchor_ref = stored.anchor_ref;
  }
  return {
    ts: frame.ts,
    capturedAt: new Date(nowMs).toISOString(),
    source: SCREEN_SOURCE_ID,
    kind: "screen.snapshot",
    // The screen has no backfill: every capture is the live present.
    origin: "live",
    ageBand: ageBandOf(Date.parse(frame.ts) || nowMs, nowMs),
    streamKey,
    actor: "self",
    roles: SELF_ROLES,
    identity: screenIdentity(frame),
    payload,
    contentHash: screenEventHash(frame),
    blobRefs: stored ? [...stored.blobRefs] : [],
  };
}
