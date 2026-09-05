// ===========================================================================
// Screen envelope tests (V6 P1 S1.6) — SRC-04 "full text persisted" plus the
// anchor + diff store's decisions, all deterministic, zero model calls.
//
// SRC-04 (GoldenEvals V6 P1 §5.3):
//   Input.    A 21,999-character capture.
//   Expected. The blob holds it (anchor), or the diff plus a valid anchor ref.
//   Wrong.    `diff-only-72%-lost` — only new_chars stored (the pre-S1.6 row:
//             132,091 chars captured → 37,352 stored).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { appendEvents, readEnvelope } from "../../db/eventlog.js";
import { blobStats, getBlobText, grantConsent } from "../../db/v6core.js";
import {
  applyScreenDiff,
  commonEnds,
  RE_ANCHOR_EVERY,
  reconstructScreenText,
  SCREEN_ANCHOR_BLOB_KIND,
  SCREEN_DIFF_BLOB_KIND,
  screenEventHash,
  screenIdentity,
  ScreenTextStore,
  toScreenEnvelope,
  type BlobPut,
  type ScreenDiffRecord,
  type ScreenSnapshotPayload,
} from "./envelope.js";
import type { SnapshotFrame } from "./frames.js";

// ---- Fixtures ---------------------------------------------------------------

/** Deterministic prose of exactly `n` characters (no model, no randomness). */
function prose(n: number, seed = "the quarterly budget review moved to thursday; "): string {
  let out = "";
  let i = 0;
  while (out.length < n) {
    out += `${seed}line ${i} of the document under review\n`;
    i++;
  }
  return out.slice(0, n);
}

function frame(over: Partial<SnapshotFrame> = {}): SnapshotFrame {
  const text = over.text ?? "meeting notes";
  return {
    t: "snapshot",
    ts: "2026-08-28T10:00:00.000Z",
    bundle_id: "com.apple.TextEdit",
    app_name: "TextEdit",
    window_title: "notes.txt",
    doc_key: "/Users/u/notes.txt",
    stream_key: "com.apple.TextEdit¦/Users/u/notes.txt",
    trigger: "app_switch",
    tree_hash: "th-1",
    content_hash: createHash("sha256").update(text).digest("hex"),
    char_count: text.length,
    new_chars: over.new_chars ?? text,
    text,
    links: [],
    files: [],
    ...over,
  };
}

class MemoryBlobs {
  readonly blobs = new Map<string, { kind: string; data: string }>();
  puts = 0;
  put: BlobPut = (data, kind) => {
    this.puts++;
    const sha256 = createHash("sha256").update(data, "utf8").digest("hex");
    this.blobs.set(sha256, { kind, data });
    return { sha256 };
  };
  text = (sha256: string): string | null => this.blobs.get(sha256)?.data ?? null;
}

// ---- Pure helpers -----------------------------------------------------------

describe("commonEnds / applyScreenDiff", () => {
  it("finds non-overlapping prefix and suffix", () => {
    expect(commonEnds("abcXYZdef", "abcQdef")).toEqual({ prefix: 3, suffix: 3 });
    expect(commonEnds("aaaa", "aa")).toEqual({ prefix: 2, suffix: 0 });
    expect(commonEnds("", "new")).toEqual({ prefix: 0, suffix: 0 });
    expect(commonEnds("same", "same")).toEqual({ prefix: 4, suffix: 0 });
  });

  it("splices a record back onto its anchor and rejects a corrupt one", () => {
    const anchor = "meeting notes\nagenda: budget\nend";
    const next = "meeting notes\nagenda: budget\naction: email finance\nend";
    const { prefix, suffix } = commonEnds(anchor, next);
    const rec: ScreenDiffRecord = {
      v: 1,
      anchor: "x",
      prefix,
      suffix,
      middle: next.slice(prefix, next.length - suffix),
      length: next.length,
    };
    expect(applyScreenDiff(anchor, rec)).toBe(next);
    expect(() => applyScreenDiff(anchor, { ...rec, length: rec.length + 1 })).toThrow(/reconstructed/);
    expect(() => applyScreenDiff("ab", { ...rec, prefix: 5, suffix: 5 })).toThrow(/exceed/);
  });
});

// ---- The store ----------------------------------------------------------------

describe("ScreenTextStore — anchor + diff per stream", () => {
  it("anchors the first capture, diffs the next, and every capture reconstructs exactly", () => {
    const blobs = new MemoryBlobs();
    const store = new ScreenTextStore({ put: blobs.put });
    const t1 = prose(2_000);
    const t2 = t1.slice(0, 900) + "INSERTED PARAGRAPH\n" + t1.slice(900);
    const t3 = t2.replace("line 3 ", "line THREE ");

    const s1 = store.record({ stream_key: "k", text: t1 });
    expect(s1.storage).toBe("anchor");
    expect(s1.anchor_ref).toBe(s1.text_ref);
    expect(s1.blobRefs).toEqual([s1.text_ref]);
    expect(blobs.blobs.get(s1.text_ref)?.kind).toBe(SCREEN_ANCHOR_BLOB_KIND);

    const s2 = store.record({ stream_key: "k", text: t2 });
    expect(s2.storage).toBe("diff");
    expect(s2.anchor_ref).toBe(s1.text_ref);
    expect(s2.blobRefs).toEqual([s2.text_ref, s1.text_ref]);
    expect(blobs.blobs.get(s2.text_ref)?.kind).toBe(SCREEN_DIFF_BLOB_KIND);
    const rec = JSON.parse(blobs.text(s2.text_ref)!) as ScreenDiffRecord;
    expect(rec.middle).toBe("INSERTED PARAGRAPH\n");
    expect(rec.anchor).toBe(s1.text_ref);

    // A diff is always against the ANCHOR, not the previous diff: one hop.
    const s3 = store.record({ stream_key: "k", text: t3 });
    expect(s3.storage).toBe("diff");
    expect(s3.anchor_ref).toBe(s1.text_ref);

    const payloadOf = (s: typeof s1) => ({ storage: s.storage, text_ref: s.text_ref, anchor_ref: s.anchor_ref });
    expect(reconstructScreenText(payloadOf(s1), blobs.text)).toBe(t1);
    expect(reconstructScreenText(payloadOf(s2), blobs.text)).toBe(t2);
    expect(reconstructScreenText(payloadOf(s3), blobs.text)).toBe(t3);
  });

  it("re-anchors when the patch stops paying (middle > half the text) and after RE_ANCHOR_EVERY diffs", () => {
    const blobs = new MemoryBlobs();
    const store = new ScreenTextStore({ put: blobs.put });
    const a = store.record({ stream_key: "k", text: prose(1_000) });
    // A wholly different document under the same key: the patch would be
    // the whole text — store it as a new anchor instead.
    const b = store.record({ stream_key: "k", text: prose(1_000, "completely different words about a villa in goa; ") });
    expect(b.storage).toBe("anchor");
    expect(b.text_ref).not.toBe(a.text_ref);
    expect(store.anchorOf("k")).toBe(b.text_ref);

    // Now RE_ANCHOR_EVERY small edits ride as diffs; the next one re-anchors.
    let text = prose(1_000, "completely different words about a villa in goa; ");
    for (let i = 0; i < RE_ANCHOR_EVERY; i++) {
      text = text + `\nedit ${i}`;
      expect(store.record({ stream_key: "k", text }).storage).toBe("diff");
    }
    text = text + "\none more";
    const re = store.record({ stream_key: "k", text });
    expect(re.storage).toBe("anchor");
    expect(store.anchorOf("k")).toBe(re.text_ref);
    expect(reconstructScreenText({ storage: re.storage, text_ref: re.text_ref, anchor_ref: re.anchor_ref }, blobs.text)).toBe(text);
  });

  it("keys anchors per stream and forgets on request", () => {
    const blobs = new MemoryBlobs();
    const store = new ScreenTextStore({ put: blobs.put });
    store.record({ stream_key: "a", text: prose(500) });
    const b = store.record({ stream_key: "b", text: prose(500) });
    // Same text under another key: content-addressed, so the SAME blob, but
    // its own anchor state.
    expect(b.storage).toBe("anchor");
    expect(store.anchorOf("a")).toBe(store.anchorOf("b"));
    store.forget("a");
    expect(store.anchorOf("a")).toBeNull();
    expect(store.record({ stream_key: "a", text: prose(500) + "x" }).storage).toBe("anchor");
  });

  it("reconstructScreenText returns null when nothing was persisted or a blob is missing", () => {
    const blobs = new MemoryBlobs();
    expect(reconstructScreenText({ text: "diff only" }, blobs.text)).toBeNull();
    expect(reconstructScreenText({ storage: "anchor", text_ref: "deadbeef" }, blobs.text)).toBeNull();
    const store = new ScreenTextStore({ put: blobs.put });
    const a = store.record({ stream_key: "k", text: prose(300) });
    const d = store.record({ stream_key: "k", text: prose(300) + "tail" });
    blobs.blobs.delete(a.text_ref); // anchor gone → the diff cannot resolve
    expect(reconstructScreenText({ storage: "diff", text_ref: d.text_ref, anchor_ref: d.anchor_ref }, blobs.text)).toBeNull();
  });
});

// ---- The envelope -------------------------------------------------------------

describe("toScreenEnvelope", () => {
  it("carries identity (app · title · doc key) on the envelope and the store's refs on payload + blob_refs", () => {
    const f = frame();
    const bare = toScreenEnvelope(f, Date.parse("2026-08-28T10:00:01.000Z"));
    expect(bare.identity).toEqual({ app: "TextEdit", windowTitle: "notes.txt", docKey: "/Users/u/notes.txt" });
    expect(bare.blobRefs).toEqual([]);
    expect((bare.payload as ScreenSnapshotPayload).storage).toBeUndefined();

    const stored = { storage: "diff" as const, text_ref: "t", anchor_ref: "a", blobRefs: ["t", "a"] };
    const env = toScreenEnvelope(f, Date.parse("2026-08-28T10:00:01.000Z"), stored);
    const p = env.payload as ScreenSnapshotPayload;
    expect(p.storage).toBe("diff");
    expect(p.text_ref).toBe("t");
    expect(p.anchor_ref).toBe("a");
    expect(env.blobRefs).toEqual(["t", "a"]);
    // Refs do not move the append identity: replaying the frame still dedupes.
    expect(env.contentHash).toBe(bare.contentHash);
    expect(env.contentHash).toBe(screenEventHash(f));
    // FTS projection stays the diff.
    expect(p.text).toBe(f.new_chars);
  });

  it("screenIdentity turns empty strings into null, never \"\"", () => {
    expect(screenIdentity({ app_name: "X", window_title: "", doc_key: "" })).toEqual({
      app: "X",
      windowTitle: null,
      docKey: null,
    });
  });
});

// ---- SRC-04 through the real funnel -------------------------------------------

describe("SRC-04 — full text persisted (real DB, blobs table)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "supertwin-src04-"));
    process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
    closeDb();
    runMigrations();
    grantConsent({ source: "screen", indexAll: true, understandFrom: "2026-01-01T00:00:00.000Z" });
  });

  afterEach(() => {
    closeDb();
    delete process.env.SUPERTWIN_DB_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a 21,999-character capture: the anchor blob holds it whole; a heartbeat's diff plus its anchor ref gives it back", () => {
    const store = new ScreenTextStore(); // production writer: v6core.putBlob
    const full = prose(21_999);
    expect(full.length).toBe(21_999);

    // First capture — sidecar sends full text as new_chars too.
    const f1 = frame({ text: full, new_chars: full });
    const s1 = store.record(f1);
    const e1 = toScreenEnvelope(f1, Date.parse("2026-08-28T10:00:01.000Z"), s1);
    // Heartbeat 60 s later with a 332-char edit — the pre-S1.6 row kept
    // 332 of 21,999 and nothing else (the "diff-only-72%-lost" wrong).
    const edit = prose(332, "typed after the heartbeat; ");
    const full2 = full.slice(0, 10_000) + edit + full.slice(10_000);
    const f2 = frame({
      ts: "2026-08-28T10:01:00.000Z",
      trigger: "heartbeat",
      text: full2,
      new_chars: edit,
      content_hash: createHash("sha256").update(full2).digest("hex"),
      char_count: full2.length,
    });
    const s2 = store.record(f2);
    const e2 = toScreenEnvelope(f2, Date.parse("2026-08-28T10:01:01.000Z"), s2);

    const r = appendEvents([e1, e2], Date.parse("2026-08-28T10:01:01.000Z"));
    expect(r.inserted).toBe(2);

    // The anchor blob holds all 21,999 characters.
    expect(s1.storage).toBe("anchor");
    expect(getBlobText(s1.text_ref)).toBe(full);
    expect(getBlobText(s1.text_ref)!.length).toBe(21_999);

    // The heartbeat is a diff + a valid anchor ref — and the pair reconstructs.
    expect(s2.storage).toBe("diff");
    expect(s2.anchor_ref).toBe(s1.text_ref);
    const rec = JSON.parse(getBlobText(s2.text_ref)!) as ScreenDiffRecord;
    expect(rec.anchor).toBe(s1.text_ref);
    expect(rec.middle).toBe(edit);
    expect(rec.length).toBe(full2.length);

    // Read back through the event rows, as a reader would.
    const row1 = readEnvelope(r.ids[0]!)!;
    const row2 = readEnvelope(r.ids[1]!)!;
    expect(row1.blobRefs).toEqual([s1.text_ref]);
    expect(row2.blobRefs).toEqual([s2.text_ref, s1.text_ref]);
    expect(reconstructScreenText(row1.payload)).toBe(full);
    expect(reconstructScreenText(row2.payload)).toBe(full2);
    expect(reconstructScreenText(row2.payload)!.length).toBe(22_331);

    // The ROW stays narrow: events.text is the diff, the blob is the text.
    const rowText = getDb().prepare(`SELECT text, app, window_title, doc_key FROM events WHERE id = ?`).get(r.ids[1]!) as {
      text: string;
      app: string;
      window_title: string;
      doc_key: string;
    };
    expect(rowText.text).toBe(edit);
    expect(rowText.app).toBe("TextEdit");
    expect(rowText.window_title).toBe("notes.txt");
    expect(rowText.doc_key).toBe("/Users/u/notes.txt");

    // Two blobs: one anchor (21,999 raw bytes), one small patch — not two
    // copies of 22 KB.
    const stats = blobStats();
    expect(stats.count).toBe(2);
    expect(stats.rawBytes).toBeGreaterThanOrEqual(21_999);
    expect(stats.rawBytes).toBeLessThan(21_999 + 2_000);
  });

  it("wrong: diff-only — an envelope built without the store keeps only new_chars (asserted so the regression is named)", () => {
    const full = prose(21_999);
    const edit = prose(332, "typed later; ");
    const f = frame({ text: full.slice(0, 10_000) + edit + full.slice(10_000), new_chars: edit });
    const env = toScreenEnvelope(f, Date.parse("2026-08-28T10:00:01.000Z"));
    const r = appendEvents([env], Date.parse("2026-08-28T10:00:01.000Z"));
    const row = readEnvelope(r.ids[0]!)!;
    expect(row.blobRefs).toEqual([]);
    expect(reconstructScreenText(row.payload)).toBeNull(); // nothing to give back
    expect((row.payload.text as string).length).toBe(332); // 332 of 22,331 — the wrong the adapter no longer produces
  });
});
