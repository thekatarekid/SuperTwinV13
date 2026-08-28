// ===========================================================================
// Ingestion writer tests (vitest): what onEvent() does with a SourceEvent
// BEFORE it reaches the DB — media metadata mapping (media spec §1/§3), edit /
// revoke folded onto their target row (§5), and reaction removal (§6).
//
// Driven through a stub SourceAdapter whose captured callbacks we fire by hand,
// so each case is one event with no daemon/NDJSON in the way. Each test uses a
// unique temp DB (SUPERTWIN_DB_PATH).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SourceAdapter } from "../adapters/source-adapter.js";
import type {
  Actor,
  AdapterStatus,
  SourceEvent,
  StatusUpdate,
  Stream,
} from "../adapters/types.js";
import { closeDb, getDb } from "../db/connection.js";
import {
  appStateSet,
  claimPendingMedia,
  getStreamMessages,
  importDoneKey,
  type InboxMessageRow,
  type MediaClaimFilter,
} from "../db/ingest.js";
import { readWatermark } from "../db/watermarks.js";
import { WHATSAPP_MANIFEST } from "../adapters/whatsapp/manifest.js";
import { Ingestion } from "./index.js";

/** Every readable kind switched on, so the claim reflects only what was written. */
const CLAIM_ALL: MediaClaimFilter = {
  images: true,
  video: true,
  documents: true,
  business: true,
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-writer-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal SourceAdapter that only records callbacks (no daemon, no I/O). */
class StubAdapter implements SourceAdapter {
  readonly sourceId = "whatsapp";
  readonly sourceType = "whatsapp";
  emitEvent: (e: SourceEvent) => void = () => {};
  emitActor: (a: Actor) => void = () => {};
  emitStream: (s: Stream) => void = () => {};
  emitStatus: (s: StatusUpdate) => void = () => {};

  async connect(): Promise<void> {}
  async startPairing(): Promise<void> {}
  async backfill(): Promise<void> {}
  async extend(): Promise<void> {}
  async pause(): Promise<void> {}
  async logout(): Promise<void> {}
  async disconnect(): Promise<void> {}

  onEvent(cb: (e: SourceEvent) => void): void {
    this.emitEvent = cb;
  }
  onStream(cb: (s: Stream) => void): void {
    this.emitStream = cb;
  }
  onActor(cb: (a: Actor) => void): void {
    this.emitActor = cb;
  }
  onStatus(cb: (s: StatusUpdate) => void): void {
    this.emitStatus = cb;
  }

  getStatus(): AdapterStatus {
    return { state: "online", paired: true, paused: false };
  }
}

function startIngestion(): StubAdapter {
  const adapter = new StubAdapter();
  new Ingestion(adapter).start();
  return adapter;
}

/** A plain inbound text message from alice. */
function message(overrides: Partial<SourceEvent> = {}): SourceEvent {
  return {
    external_id: "alice@x/MSG1",
    stream_ext_id: "alice@x",
    actor_ext_id: "alice@x",
    ts: "2026-07-02T10:00:00.000Z",
    kind: "message",
    text: "dinner at 8?",
    from_me: false,
    ...overrides,
  };
}

function messages(): InboxMessageRow[] {
  return getStreamMessages({ streamId: "whatsapp:st:alice@x", limit: 50 });
}

describe("onEvent media metadata (media spec §1, §3)", () => {
  it("persists every media field the daemon sends instead of just the path", () => {
    const adapter = startIngestion();
    adapter.emitEvent(
      message({
        external_id: "alice@x/IMG",
        kind: "image",
        text: "",
        media: {
          path: "/media/whatsapp/alice/IMG.jpg",
          mime: "image/jpeg",
          filename: "IMG_2201.jpg",
          size: 918_273,
          sha256: "deadbeef",
          thumb_path: "/media/whatsapp/alice/IMG.thumb.jpg",
          width: 3024,
          height: 4032,
          caption: "the whiteboard",
        },
      }),
    );

    const [row] = messages();
    expect(row).toMatchObject({
      kind: "image",
      mediaPath: "/media/whatsapp/alice/IMG.jpg",
      mediaMime: "image/jpeg",
      mediaFilename: "IMG_2201.jpg",
      mediaSize: 918_273,
      mediaThumbPath: "/media/whatsapp/alice/IMG.thumb.jpg",
      mediaMeta: { width: 3024, height: 4032, caption: "the whiteboard" },
    });
    // sha256 is not part of the message row; it is on the by-id read path.
    expect(
      (
        getDb()
          .prepare(`SELECT media_sha256 AS s FROM events WHERE id = ?`)
          .get(row.id) as { s: string }
      ).s,
    ).toBe("deadbeef");
    // Readable per §8 → queued for the media reader.
    expect(claimPendingMedia(10, CLAIM_ALL).map((p) => p.id)).toEqual(["whatsapp:alice@x/IMG"]);
  });

  it("leaves media_meta_json null when the daemon sent no meta fields", () => {
    const adapter = startIngestion();
    adapter.emitEvent(
      message({
        external_id: "alice@x/DOC",
        kind: "document",
        text: "",
        media: { path: "/media/whatsapp/alice/DOC.zip", mime: "application/zip" },
      }),
    );
    expect(messages()[0].mediaMeta).toBeNull();
  });

  it("carries is_forwarded onto the row", () => {
    const adapter = startIngestion();
    adapter.emitEvent(message({ is_forwarded: true }));
    expect(messages()[0].isForwarded).toBe(true);
  });
});

describe("onEvent edit + revoke (media spec §5)", () => {
  it("an edit updates its target in place instead of inserting a second row", () => {
    const adapter = startIngestion();
    adapter.emitEvent(message({ text: "meet at seven" }));
    adapter.emitEvent(
      message({
        external_id: "alice@x/MSG2",
        ts: "2026-07-02T10:01:00.000Z",
        text: "meet at eight",
        edit_of_external_id: "alice@x/MSG1",
      }),
    );

    const rows = messages();
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("meet at eight");
    expect(rows[0].editedAt).toBe("2026-07-02T10:01:00.000Z");
  });

  it("a revoke tombstones its target instead of inserting an empty revoked row", () => {
    const adapter = startIngestion();
    adapter.emitEvent(
      message({
        kind: "image",
        text: "",
        media: { path: "/media/whatsapp/alice/IMG.jpg", mime: "image/jpeg" },
      }),
    );
    adapter.emitEvent(
      message({
        external_id: "alice@x/TOMB",
        ts: "2026-07-02T10:02:00.000Z",
        kind: "revoked",
        text: "",
        revoke_of_external_id: "alice@x/MSG1",
      }),
    );

    const rows = messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "image",
      text: "",
      mediaPath: null,
      revokedAt: "2026-07-02T10:02:00.000Z",
    });
  });

  it("out-of-order: an edit whose target is absent is kept as its own row", () => {
    const adapter = startIngestion();
    adapter.emitEvent(
      message({
        external_id: "alice@x/MSG2",
        text: "meet at eight",
        edit_of_external_id: "alice@x/NOT-YET",
      }),
    );

    const rows = messages();
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("meet at eight");
    expect(rows[0].editedAt).toBeNull();
  });

  it("out-of-order: a revoke whose target is absent is kept as its own row", () => {
    const adapter = startIngestion();
    adapter.emitEvent(
      message({
        external_id: "alice@x/TOMB",
        kind: "revoked",
        text: "",
        revoke_of_external_id: "alice@x/NOT-YET",
      }),
    );
    expect(messages().map((r) => r.kind)).toEqual(["revoked"]);
  });
});

describe("onEvent reaction removal (media spec §6)", () => {
  it("an empty-text reaction deletes the stored reaction rather than adding one", () => {
    const adapter = startIngestion();
    adapter.emitEvent(message());
    adapter.emitEvent(
      message({
        external_id: "alice@x/R1",
        ts: "2026-07-02T10:01:00.000Z",
        kind: "reaction",
        text: "👍",
        reply_to_external_id: "alice@x/MSG1",
      }),
    );
    expect(messages()[0].reactions).toEqual([
      { emoji: "👍", fromMe: false, actorName: null },
    ]);

    adapter.emitEvent(
      message({
        external_id: "alice@x/R2",
        ts: "2026-07-02T10:02:00.000Z",
        kind: "reaction",
        text: "",
        reply_to_external_id: "alice@x/MSG1",
      }),
    );

    expect(messages()[0].reactions).toEqual([]);
    // The removal left no row behind — not even an empty-emoji one.
    expect(
      (
        getDb()
          .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'reaction'`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("only the removing actor's reaction goes", () => {
    const adapter = startIngestion();
    adapter.emitEvent(message());
    adapter.emitEvent(
      message({
        external_id: "alice@x/R1",
        actor_ext_id: "bob@x",
        ts: "2026-07-02T10:01:00.000Z",
        kind: "reaction",
        text: "🎉",
        reply_to_external_id: "alice@x/MSG1",
      }),
    );
    adapter.emitEvent(
      message({
        external_id: "alice@x/R2",
        ts: "2026-07-02T10:02:00.000Z",
        kind: "reaction",
        text: "👍",
        reply_to_external_id: "alice@x/MSG1",
      }),
    );
    adapter.emitEvent(
      message({
        external_id: "alice@x/R3",
        ts: "2026-07-02T10:03:00.000Z",
        kind: "reaction",
        text: "",
        reply_to_external_id: "alice@x/MSG1",
      }),
    );

    expect(messages()[0].reactions).toEqual([
      { emoji: "🎉", fromMe: false, actorName: null },
    ]);
  });
});

// ===========================================================================
// Newest-page-first history + dual watermarks (build item 1.1).
// ===========================================================================

describe("history is written newest-first (arch §2.2 note 1)", () => {
  /** Ascending history, exactly as whatsmeow hands it over. */
  const ASCENDING = [
    { external_id: "alice@x/H1", ts: "2019-01-01T00:00:00.000Z", text: "oldest" },
    { external_id: "alice@x/H2", ts: "2023-06-01T00:00:00.000Z", text: "middle" },
    { external_id: "alice@x/H3", ts: "2026-08-01T00:00:00.000Z", text: "newest" },
  ];

  function writtenOrder(): string[] {
    return (
      getDb()
        .prepare(`SELECT external_id FROM events ORDER BY rowid`)
        .all() as { external_id: string }[]
    ).map((r) => r.external_id);
  }

  it("re-orders an ascending backfill into descending rows on the way in", () => {
    const adapter = new StubAdapter();
    const ingestion = new Ingestion(adapter, { manifest: WHATSAPP_MANIFEST });
    ingestion.start();

    for (const h of ASCENDING) {
      adapter.emitEvent(message({ ...h, is_historical: true }));
    }
    // Nothing is written until the burst is flushed — that is the buffer.
    expect(writtenOrder()).toEqual([]);

    ingestion.flushBackfill();
    expect(writtenOrder()).toEqual(["alice@x/H3", "alice@x/H2", "alice@x/H1"]);
  });

  it("never delays a live message behind the re-order buffer", () => {
    const adapter = new StubAdapter();
    const ingestion = new Ingestion(adapter, { manifest: WHATSAPP_MANIFEST });
    ingestion.start();

    adapter.emitEvent(message({ ...ASCENDING[0], is_historical: true }));
    adapter.emitEvent(
      message({ external_id: "alice@x/LIVE", ts: "2026-08-15T09:00:00.000Z", text: "now" }),
    );
    expect(writtenOrder()).toEqual(["alice@x/LIVE"]);

    ingestion.flushBackfill();
    expect(writtenOrder()).toEqual(["alice@x/LIVE", "alice@x/H1"]);
  });

  it("moves the two watermarks in opposite directions", () => {
    const adapter = new StubAdapter();
    const ingestion = new Ingestion(adapter, { manifest: WHATSAPP_MANIFEST });
    ingestion.start();

    for (const h of ASCENDING) adapter.emitEvent(message({ ...h, is_historical: true }));
    adapter.emitEvent(
      message({ external_id: "alice@x/LIVE", ts: "2026-08-15T09:00:00.000Z", text: "now" }),
    );
    ingestion.flushBackfill();

    const w = readWatermark("whatsapp:st:alice@x")!;
    expect(w.backfill_low_ts).toBe("2019-01-01T00:00:00.000Z");
    expect(w.live_high_ts).toBe("2026-08-15T09:00:00.000Z");
    expect(w.live_high_external_id).toBe("alice@x/LIVE");
    expect(w.backfill_complete).toBe(false);
  });
});

// ===========================================================================
// The import seal. The daemon announces `backfill_complete` when it has finished
// PUSHING, not when the last row has landed — on the real 30d import the frame
// arrived at 14:43:44 and streams kept being created until 14:45:20. Sealing on
// the frame alone therefore left 93 streams at backfill_complete=0 for ever,
// and `modeAfterBackfill` (scheduler/horizons) reports "bootstrap" until they
// flip. These are the regression tests for that ordering.
// ===========================================================================

describe("import seal ordering (build item 1.1)", () => {
  /** No manifest ⇒ no re-order buffer, so a historical event writes straight through. */
  const DONE: StatusUpdate = {
    type: "backfill_complete",
    range: "30d",
    chats: 2,
    messages: 2,
  };
  /** Mirrors BACKFILL_SEAL_MS in ingest/index.ts (not exported — it is internal). */
  const SEAL_MS = 5_000;

  const sealed = (ext: string): boolean =>
    readWatermark(`whatsapp:st:${ext}`)?.backfill_complete === true;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seals a stream that only lands AFTER the daemon said backfill_complete", () => {
    const adapter = startIngestion();
    adapter.emitEvent(message({ is_historical: true }));
    adapter.emitStatus(DONE);
    // Everything that exists at the edge is sealed optimistically...
    expect(sealed("alice@x")).toBe(true);

    // ...and then the tail of the import arrives, creating a stream the first
    // pass could not have seen. This is the row that used to stay at 0 for ever.
    adapter.emitEvent(
      message({
        external_id: "bob@x/H1",
        stream_ext_id: "bob@x",
        actor_ext_id: "bob@x",
        is_historical: true,
      }),
    );
    expect(sealed("bob@x")).toBe(false);

    vi.advanceTimersByTime(SEAL_MS);
    expect(sealed("bob@x")).toBe(true);
    expect(sealed("alice@x")).toBe(true);
  });

  it("measures the quiet window from the LAST row, not the first", () => {
    const adapter = startIngestion();
    adapter.emitStatus(DONE);

    vi.advanceTimersByTime(SEAL_MS - 1_000);
    adapter.emitEvent(message({ is_historical: true }));
    // 4s later the seal would have fired had the window not been re-armed.
    vi.advanceTimersByTime(SEAL_MS - 1_000);
    expect(sealed("alice@x")).toBe(false);

    vi.advanceTimersByTime(1_000);
    expect(sealed("alice@x")).toBe(true);
  });

  it("seals a stream announced with no events of its own", () => {
    const adapter = startIngestion();
    adapter.emitStatus(DONE);
    adapter.emitStream({
      source_ext_id: "quiet@x",
      name: "Quiet",
      kind: "dm",
      is_business: false,
    });

    vi.advanceTimersByTime(SEAL_MS);
    expect(sealed("quiet@x")).toBe(true);
  });

  it("re-arms after firing: the dead-air frame (chats=0 at connect+0) still seals the real import", async () => {
    const adapter = startIngestion();
    // whatsapp-go emits its backfill-complete frame BEFORE whatsmeow's
    // history-sync payloads arrive; the first seal fires over an empty DB.
    adapter.emitStatus({ type: "backfill_complete", range: "30d", chats: 0, messages: 0 });
    vi.advanceTimersByTime(SEAL_MS);

    // ...then the real import lands, in the window a one-shot seal is blind to.
    adapter.emitEvent(message({ is_historical: true }));
    expect(sealed("alice@x")).toBe(false);

    await vi.advanceTimersByTimeAsync(SEAL_MS);
    expect(sealed("alice@x")).toBe(true);
    // (P0.3) The V11 ensureTiers re-run was pruned with the derivation middle;
    // V13 stream tiering re-lands with P0.4/P0.5, and its seal-edge coverage
    // returns with it.
  });

  it("converges: each late wave re-seals once, and sealed live traffic never re-arms", async () => {
    const adapter = new StubAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    adapter.emitEvent(message({ is_historical: true })); // alice@x, pre-frame
    adapter.emitStatus(DONE);
    await vi.advanceTimersByTimeAsync(SEAL_MS);
    expect(sealed("alice@x")).toBe(true);

    // Wave one, after the seal already fired.
    adapter.emitEvent(message({ external_id: "bob@x/H1", stream_ext_id: "bob@x", actor_ext_id: "bob@x", is_historical: true }));
    await vi.advanceTimersByTimeAsync(SEAL_MS);
    expect(sealed("bob@x")).toBe(true);

    // Wave two, later still — re-seals again.
    adapter.emitEvent(message({ external_id: "carol@x/H1", stream_ext_id: "carol@x", actor_ext_id: "carol@x", is_historical: true }));
    await vi.advanceTimersByTimeAsync(SEAL_MS);
    expect(sealed("carol@x")).toBe(true);

    // A live message on a fully sealed source must NOT arm another seal —
    // that would be a seal per quiet gap for ever.
    adapter.emitEvent(message({ external_id: "alice@x/LIVE2", ts: "2026-08-15T10:00:00.000Z" }));
    expect(
      (ingestion as unknown as { backfillSealTimer: unknown }).backfillSealTimer,
    ).toBeNull();
    // But a live message that CREATES a stream is exactly a re-arm: the new
    // chat needs its watermark sealed and its tier assigned.
    adapter.emitEvent(message({ external_id: "dave@x/L1", stream_ext_id: "dave@x", actor_ext_id: "dave@x", ts: "2026-08-15T10:01:00.000Z" }));
    expect(sealed("dave@x")).toBe(false);
    await vi.advanceTimersByTimeAsync(SEAL_MS);
    expect(sealed("dave@x")).toBe(true);
  });

  it("repairs an existing install on boot: import_done=true but nothing sealed", () => {
    const adapter = startIngestion();
    adapter.emitEvent(message({ is_historical: true }));
    // Exactly the state the previous build left behind: the import is recorded
    // as done, but the per-stream flags were written before the stream existed.
    appStateSet(importDoneKey("whatsapp"), "true");
    expect(sealed("alice@x")).toBe(false);

    new Ingestion(new StubAdapter()).start(); // relaunch
    expect(sealed("alice@x")).toBe(true);
  });
});
