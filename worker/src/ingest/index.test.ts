// ===========================================================================
// Ingestion writer tests (vitest): what onEvent() does with a SourceEvent
// BEFORE it reaches the DB — media metadata mapping (media spec §1/§3), edit /
// revoke folded onto their target row (§5), and reaction removal (§6).
//
// Driven through a stub SourceAdapter whose captured callbacks we fire by hand,
// so each case is one event with no daemon/NDJSON in the way. Each test uses a
// unique temp DB (SUPERTWIN_DB_PATH).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SourceAdapter } from "../adapters/source-adapter.js";
import type {
  Actor,
  AdapterStatus,
  Channel,
  SourceEvent,
  StatusUpdate,
} from "../adapters/types.js";
import { closeDb, getDb } from "../db/connection.js";
import {
  claimPendingMedia,
  getChannelMessages,
  type InboxMessageRow,
  type MediaClaimFilter,
} from "../db/ingest.js";
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
  onChannel(_cb: (c: Channel) => void): void {}
  onActor(cb: (a: Actor) => void): void {
    this.emitActor = cb;
  }
  onStatus(_cb: (s: StatusUpdate) => void): void {}

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
    channel_ext_id: "alice@x",
    actor_ext_id: "alice@x",
    ts: "2026-07-02T10:00:00.000Z",
    kind: "message",
    text: "dinner at 8?",
    from_me: false,
    ...overrides,
  };
}

function messages(): InboxMessageRow[] {
  return getChannelMessages({ channelId: "whatsapp:ch:alice@x", limit: 50 });
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
    expect(claimPendingMedia(10, CLAIM_ALL).map((p) => p.id)).toEqual(["wa:alice@x/IMG"]);
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
