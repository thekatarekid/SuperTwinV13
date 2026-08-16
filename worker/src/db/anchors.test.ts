// ===========================================================================
// Back-pagination anchors (vitest). The daemon's anchor map is in-memory and
// empty after every restart, and "Extend history" over zero anchors paginates
// nothing — so this query IS the recovery path's memory. Its four fields are
// exactly what whatsmeow's BuildHistorySyncRequest puts on the wire, and an
// incomplete or wrongly-split one would page from somewhere history never was.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "./connection.js";
import { readAnchors, messageIdOf } from "./anchors.js";
import {
  insertEvent,
  setSelfIdentity,
  upsertActor,
  upsertSource,
  upsertStream,
  actorId,
  streamId,
} from "./ingest.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-anchors-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function chat(jid: string): void {
  upsertStream({ sourceId: "whatsapp", sourceExtId: jid, name: jid, kind: "dm" });
  upsertActor({
    sourceId: "whatsapp",
    sourceExtId: jid,
    displayName: jid,
    handle: null,
    isSelf: false,
  });
}

function event(jid: string, id: string, ts: string, over: { kind?: string; actor?: string } = {}): void {
  insertEvent({
    externalId: `${jid}/${id}`,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    streamId: streamId("whatsapp", jid),
    actorId: actorId("whatsapp", over.actor ?? jid),
    ts,
    kind: over.kind ?? "message",
    text: id,
    mediaPath: null,
    rawJson: null,
    replyToExternalId: null,
    replyToText: null,
    mediaMime: null,
    mediaFilename: null,
    mediaSize: null,
    mediaSha256: null,
    mediaThumbPath: null,
    mediaSeconds: null,
    mediaMetaJson: null,
    isForwarded: false,
    linkUrl: null,
    linkTitle: null,
    linkDescription: null,
    linkThumbPath: null,
    linkPreviewType: null,
    isHistorical: true,
  });
}

describe("readAnchors", () => {
  it("returns the OLDEST message per chat, one anchor each", () => {
    chat("mom@s.whatsapp.net");
    chat("work@g.us");
    event("mom@s.whatsapp.net", "M3", "2026-06-01T10:00:00.000Z");
    event("mom@s.whatsapp.net", "M1", "2026-04-01T10:00:00.000Z");
    event("mom@s.whatsapp.net", "M2", "2026-05-01T10:00:00.000Z");
    event("work@g.us", "W9", "2026-03-01T10:00:00.000Z");

    const anchors = readAnchors("whatsapp").sort((a, b) =>
      a.chat_jid.localeCompare(b.chat_jid),
    );
    expect(anchors).toEqual([
      {
        chat_jid: "mom@s.whatsapp.net",
        msg_id: "M1",
        from_me: false,
        ts: "2026-04-01T10:00:00.000Z",
      },
      {
        chat_jid: "work@g.us",
        msg_id: "W9",
        from_me: false,
        ts: "2026-03-01T10:00:00.000Z",
      },
    ]);
  });

  it("marks an anchor the user sent as from_me via the persisted self identity", () => {
    // `events` has no from_me column and `actors` has no is_self column — the
    // self actor is the one app_state names, so a rename of that key would
    // silently make every anchor from_me:false and issue wrong page requests.
    chat("mom@s.whatsapp.net");
    upsertActor({
      sourceId: "whatsapp",
      sourceExtId: "me@s.whatsapp.net",
      displayName: "Me",
      handle: null,
      isSelf: true,
    });
    setSelfIdentity("whatsapp", "me@s.whatsapp.net");
    event("mom@s.whatsapp.net", "MINE", "2026-04-01T10:00:00.000Z", {
      actor: "me@s.whatsapp.net",
    });

    expect(readAnchors("whatsapp")[0].from_me).toBe(true);
  });

  it("skips reactions — an anchor is a position in the chat, not metadata", () => {
    chat("mom@s.whatsapp.net");
    event("mom@s.whatsapp.net", "R0", "2026-01-01T10:00:00.000Z", { kind: "reaction" });
    event("mom@s.whatsapp.net", "M1", "2026-04-01T10:00:00.000Z");
    expect(readAnchors("whatsapp")[0].msg_id).toBe("M1");
  });

  it("drops a row whose external_id is not the daemon's <chat>/<id> shape", () => {
    chat("mom@s.whatsapp.net");
    insertEvent({
      externalId: "legacy-id-with-no-chat-prefix",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: streamId("whatsapp", "mom@s.whatsapp.net"),
      actorId: actorId("whatsapp", "mom@s.whatsapp.net"),
      ts: "2026-04-01T10:00:00.000Z",
      kind: "message",
      text: "x",
      mediaPath: null,
      rawJson: null,
      replyToExternalId: null,
      replyToText: null,
      mediaMime: null,
      mediaFilename: null,
      mediaSize: null,
      mediaSha256: null,
      mediaThumbPath: null,
      mediaSeconds: null,
      mediaMetaJson: null,
      isForwarded: false,
      linkUrl: null,
      linkTitle: null,
      linkDescription: null,
      linkThumbPath: null,
      linkPreviewType: null,
      isHistorical: true,
    });
    expect(readAnchors("whatsapp")).toEqual([]);
  });

  it("is empty on a fresh install rather than throwing", () => {
    expect(readAnchors("whatsapp")).toEqual([]);
  });
});

describe("messageIdOf", () => {
  it("strips only the chat prefix the daemon actually built", () => {
    expect(messageIdOf("mom@s.whatsapp.net/3EB0ABC", "mom@s.whatsapp.net")).toBe(
      "3EB0ABC",
    );
    // A group JID plus an id that itself contains a slash: splitting on the
    // FIRST "/" would truncate the id, so the whole prefix is matched instead.
    expect(messageIdOf("work@g.us/3EB0/ABC", "work@g.us")).toBe("3EB0/ABC");
    expect(messageIdOf("other@g.us/X", "work@g.us")).toBeNull();
    expect(messageIdOf("work@g.us/", "work@g.us")).toBeNull();
  });
});
