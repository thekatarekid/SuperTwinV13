// ===========================================================================
// WhatsApp / Inbox / media HTTP route tests. Boots the REAL worker server on an
// ephemeral port with a fresh temp DB + an Ingestion backed by a FAKE adapter
// (no child process, no `claude`). Exercises the new Phase-1 endpoints incl.
// /api/media content-type + path-traversal guard.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = mkdtempSync(join(tmpdir(), "wa-routes-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_HOME = tmpDir;

const { runMigrations } = await import("../db/connection.js");
const ingestDb = await import("../db/ingest.js");
const { WhatsAppAdapter } = await import("../adapters/whatsapp/adapter.js");
const { Ingestion } = await import("../ingest/index.js");
const { startServer } = await import("./index.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");

type ServerHandle = { port: number; close(): Promise<void> };

// ---- Minimal fake child (records stdin writes; exits on kill). ------------
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  writes: string[] = [];
  stdin = {
    write: (c: string) => {
      this.writes.push(c);
    },
    end: () => {},
  };
  kill() {
    setImmediate(() => this.emit("exit", 0, null));
    return true;
  }
  line(obj: unknown) {
    this.stdout.emit("data", JSON.stringify(obj) + "\n");
  }
}

let server: ServerHandle;
let base: string;
let child: FakeChild;
let ingestion: InstanceType<typeof Ingestion>;
const mediaRoot = join(tmpDir, "media", "whatsapp");
/** Stand-in thumbnail bytes: the route types the response off the extension. */
const THUMB = Buffer.from("stored-thumbnail-bytes");

/** The link block the route builds — `thumbUrl`, never the stored path. */
interface MessageLink {
  url: string;
  title: string | null;
  description: string | null;
  previewType: string | null;
  scrapedText: string | null;
  thumbUrl?: string;
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, init);
  return (await res.json()) as T;
}

describe("whatsapp/inbox/media routes", () => {
  beforeAll(async () => {
    runMigrations();
    register(claudeLocalProvider);
    child = new FakeChild();
    const adapter = new WhatsAppAdapter({
      spawn: () => child as never,
      mock: true,
      autoRestart: false,
      home: tmpDir,
    });
    ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();

    // Drive a small scripted stream to seed the DB.
    child.line({ t: "ready" });
    child.line({ t: "status", state: "online", jid: "me@x", push_name: "Me" });
    child.line({ t: "actor", actor: { source_ext_id: "me@x", display_name: "Me", is_self: true } });
    child.line({ t: "channel", channel: { source_ext_id: "mom@x", name: "Mom", kind: "dm" } });
    child.line({ t: "actor", actor: { source_ext_id: "mom@x", display_name: "Mom", is_self: false } });

    // Write a real media file under the media root and reference it from an event.
    mkdirSync(join(mediaRoot, "mom@x"), { recursive: true });
    const imgPath = join(mediaRoot, "mom@x", "IMG1.png");
    // 1x1 transparent PNG.
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
        "01f15c4890000000d49444154789c6360000002000100ffff03000006" +
        "0005570bfb2b0000000049454e44ae426082",
      "hex",
    );
    writeFileSync(imgPath, png);

    child.line({
      t: "event",
      event: {
        external_id: "mom@x/MSG1",
        channel_ext_id: "mom@x",
        actor_ext_id: "mom@x",
        ts: "2026-07-02T10:00:00.000Z",
        kind: "message",
        text: "let us grab coffee",
        from_me: false,
        raw: { id: "MSG1" },
      },
    });
    child.line({
      t: "event",
      event: {
        external_id: "mom@x/MSG2",
        channel_ext_id: "mom@x",
        actor_ext_id: "mom@x",
        ts: "2026-07-02T10:05:00.000Z",
        kind: "image",
        text: "",
        media: { path: imgPath, mime: "image/png", filename: "IMG1.png" },
        from_me: false,
        raw: { id: "MSG2" },
      },
    });

    server = await startServer({ port: 0, ingestion });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server) await server.close();
    delete process.env.SUPERTWIN_DB_PATH;
    delete process.env.SUPERTWIN_HOME;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/whatsapp/status returns paired/online + paused false", async () => {
    const st = await getJson<{ state: string; paired: boolean; paused: boolean }>(
      "/api/whatsapp/status",
    );
    expect(st.state).toBe("online");
    expect(st.paired).toBe(true);
    expect(st.paused).toBe(false);
  });

  it("GET /api/health includes whatsapp state (additive)", async () => {
    const h = await getJson<{ ok: boolean; whatsapp?: { state: string; paired: boolean } }>(
      "/api/health",
    );
    expect(h.ok).toBe(true);
    expect(h.whatsapp?.state).toBe("online");
    expect(h.whatsapp?.paired).toBe(true);
  });

  it("GET /api/health reports the real worker version (not 0.0.0)", async () => {
    const h = await getJson<{ version: string }>("/api/health");
    // Read the source-of-truth version rather than hardcoding a literal, so this
    // never drifts when the worker package version is bumped.
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };
    expect(h.version).toBe(pkg.version);
    expect(h.version).not.toBe("0.0.0");
  });

  it("GET /api/inbox/chats lists the seeded chat", async () => {
    const chats = await getJson<
      Array<{ id: string; name: string; messageCount: number; lastTs: string }>
    >("/api/inbox/chats");
    expect(chats.length).toBe(1);
    expect(chats[0].name).toBe("Mom");
    expect(chats[0].messageCount).toBe(2);
  });

  it("GET /api/inbox/chats/:id/messages returns ascending msgs + mediaUrl", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const msgs = await getJson<
      Array<{ id: string; text: string; kind: string; mediaUrl?: string }>
    >(`/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`);
    expect(msgs.map((m) => m.text)).toEqual(["let us grab coffee", ""]);
    const imgMsg = msgs.find((m) => m.kind === "image")!;
    expect(imgMsg.mediaUrl).toBe(`/api/media/${encodeURIComponent(imgMsg.id)}`);
  });

  it("GET /api/inbox/search finds via FTS with a snippet", async () => {
    const hits = await getJson<Array<{ text: string; snippet: string; channelName: string }>>(
      "/api/inbox/search?q=coffee",
    );
    expect(hits.length).toBe(1);
    expect(hits[0].text).toBe("let us grab coffee");
    expect(hits[0].channelName).toBe("Mom");
  });

  it("GET /api/media/:eventId streams the file with the right Content-Type", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const msgs = await getJson<Array<{ id: string; kind: string }>>(
      `/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`,
    );
    const imgId = msgs.find((m) => m.kind === "image")!.id;
    const res = await fetch(`${base}/api/media/${encodeURIComponent(imgId)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });

  it("GET /api/media rejects path traversal (media_path outside root => 403)", async () => {
    // Insert an event whose media_path escapes the media root.
    ingestDb.upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const ch = ingestDb.upsertStream({ sourceId: "whatsapp", sourceExtId: "evil@x", name: "Evil" });
    const ac = ingestDb.upsertActor({ sourceId: "whatsapp", sourceExtId: "evil@x", displayName: "Evil" });
    const r = ingestDb.insertEvent({
      externalId: "evil/1",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: ch,
      actorId: ac,
      ts: "2026-07-02T00:00:00.000Z",
      kind: "document",
      text: "",
      mediaPath: "/etc/passwd",
      rawJson: null,
    });
    const res = await fetch(`${base}/api/media/${encodeURIComponent(r.id)}`);
    expect(res.status).toBe(403);
  });

  it("GET /api/media 404s for an unknown event", async () => {
    const res = await fetch(`${base}/api/media/whatsapp:nope`);
    expect(res.status).toBe(404);
  });

  it("messages carry the media metadata + description (media spec §4/§8)", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const doc = ingestDb.insertEvent({
      externalId: "mom@x/MSG3",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: chats[0].id,
      actorId: ingestDb.actorId("whatsapp", "mom@x"),
      ts: "2026-07-02T10:10:00.000Z",
      kind: "video",
      text: "",
      mediaPath: join(mediaRoot, "mom@x", "VID1.mp4"),
      rawJson: null,
      mediaMime: "video/mp4",
      mediaFilename: "VID1.mp4",
      mediaSize: 4096,
      mediaThumbPath: join(mediaRoot, "mom@x", "VID1.thumb.jpg"),
      mediaSeconds: 12,
      mediaMetaJson: JSON.stringify({ width: 1080, height: 1920 }),
    });
    ingestDb.recordMediaDescription(doc.id, {
      description: "A kitchen table seen from above, one plate of rice on it.",
      model: "claude-haiku-4-5-20251001",
      status: "done",
    });

    const msgs = await getJson<
      Array<{
        id: string;
        mediaMime?: string;
        mediaFilename?: string;
        mediaSize?: number;
        mediaSeconds?: number;
        mediaWidth?: number | null;
        mediaHeight?: number | null;
        mediaDescription?: string;
        revokedAt: string | null;
        isForwarded: boolean;
      }>
    >(`/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`);
    const row = msgs.find((m) => m.id === doc.id)!;
    expect(row.mediaMime).toBe("video/mp4");
    expect(row.mediaFilename).toBe("VID1.mp4");
    expect(row.mediaSize).toBe(4096);
    expect(row.mediaSeconds).toBe(12);
    // The shape of the picture, so the browser reserves its box before the
    // bytes decode (v7 §5) rather than growing the row underneath a reader.
    expect(row.mediaWidth).toBe(1080);
    expect(row.mediaHeight).toBe(1920);
    // A row WhatsApp sent no dimensions for says so, rather than dropping the
    // key — the UI reserves a box of its own choosing for exactly that case.
    const undimensioned = msgs.find((m) => m.id === "whatsapp:mom@x/MSG2")!;
    expect(undimensioned.mediaWidth).toBeNull();
    expect(undimensioned.mediaHeight).toBeNull();
    expect(row.mediaDescription).toBe(
      "A kitchen table seen from above, one plate of rice on it.",
    );
    expect(row.revokedAt).toBeNull();
    expect(row.isForwarded).toBe(false);
  });

  it("a revoked message sheds its media metadata AND its description", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    ingestDb.applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "mom@x/MSG3",
      revokedAt: "2026-07-02T10:20:00.000Z",
    });

    const msgs = await getJson<
      Array<{
        id: string;
        mediaUrl?: string;
        mediaFilename?: string;
        mediaDescription?: string;
        revokedAt: string | null;
      }>
    >(`/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`);
    const row = msgs.find((m) => m.id === "whatsapp:mom@x/MSG3")!;
    expect(row.revokedAt).toBe("2026-07-02T10:20:00.000Z");
    expect(row.mediaUrl).toBeUndefined();
    expect(row.mediaFilename).toBeUndefined();
    expect(row.mediaDescription).toBeUndefined();
  });

  it("carries the link preview, with the thumbnail as a URL (v4 §2)", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const linkThumb = join(mediaRoot, "mom@x", "LNK1.link.jpg");
    writeFileSync(linkThumb, THUMB);
    const ev = ingestDb.insertEvent({
      externalId: "mom@x/LNK1",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: chats[0].id,
      actorId: ingestDb.actorId("whatsapp", "mom@x"),
      ts: "2026-07-02T11:00:00.000Z",
      kind: "message",
      text: "https://example.com/post",
      mediaPath: null,
      rawJson: null,
      linkUrl: "https://example.com/post",
      linkTitle: "A post",
      linkDescription: "What the post is about",
      linkThumbPath: linkThumb,
      linkPreviewType: "article",
    });

    const msgs = await getJson<Array<{ id: string; link: MessageLink | null }>>(
      `/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`,
    );
    const row = msgs.find((m) => m.id === ev.id)!;
    expect(row.link).toEqual({
      url: "https://example.com/post",
      title: "A post",
      description: "What the post is about",
      previewType: "article",
      scrapedText: null,
      thumbUrl: `/api/media/${encodeURIComponent(ev.id)}/link-thumb`,
    });
    // The stored path is the worker's alone; nothing in the payload leaks it.
    expect(JSON.stringify(row)).not.toContain(linkThumb);

    const res = await fetch(`${base}${row.link!.thumbUrl}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect((await res.arrayBuffer()).byteLength).toBe(THUMB.length);
  });

  it("a message with no link carries link:null rather than dropping the key", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const msgs = await getJson<Array<{ id: string; link: MessageLink | null }>>(
      `/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`,
    );
    const plain = msgs.find((m) => m.id === "whatsapp:mom@x/MSG1")!;
    expect(plain).toHaveProperty("link");
    expect(plain.link).toBeNull();
  });

  it("serves a video's stored thumbnail as a URL (v4 §3)", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const vidPath = join(mediaRoot, "mom@x", "VID2.mp4");
    const thumbPath = join(mediaRoot, "mom@x", "VID2.thumb.jpg");
    writeFileSync(vidPath, Buffer.from("not really an mp4"));
    writeFileSync(thumbPath, THUMB);
    const ev = ingestDb.insertEvent({
      externalId: "mom@x/VID2",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: chats[0].id,
      actorId: ingestDb.actorId("whatsapp", "mom@x"),
      ts: "2026-07-02T11:05:00.000Z",
      kind: "video",
      text: "",
      mediaPath: vidPath,
      rawJson: null,
      mediaMime: "video/mp4",
      mediaThumbPath: thumbPath,
    });

    const msgs = await getJson<Array<{ id: string; mediaThumbUrl?: string }>>(
      `/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`,
    );
    const row = msgs.find((m) => m.id === ev.id)!;
    expect(row.mediaThumbUrl).toBe(`/api/media/${encodeURIComponent(ev.id)}/thumb`);
    expect(JSON.stringify(row)).not.toContain(thumbPath);

    // The thumbnail is its own bytes, not the file it was derived from.
    const thumb = await fetch(`${base}${row.mediaThumbUrl}`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    expect((await thumb.arrayBuffer()).byteLength).toBe(THUMB.length);

    const full = await fetch(`${base}/api/media/${encodeURIComponent(ev.id)}`);
    expect(full.headers.get("content-type")).toBe("video/mp4");
  });

  it("a message with no stored thumbnail offers no thumbnail URL", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const msgs = await getJson<Array<{ id: string; kind: string; mediaThumbUrl?: string }>>(
      `/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`,
    );
    const img = msgs.find((m) => m.id === "whatsapp:mom@x/MSG2")!;
    expect(img.mediaThumbUrl).toBeUndefined();
    const res = await fetch(`${base}/api/media/${encodeURIComponent(img.id)}/thumb`);
    expect(res.status).toBe(404);
  });

  it("a revoked message stops serving the thumbnail its media_path is gone for", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const thumbPath = join(mediaRoot, "mom@x", "VID3.thumb.jpg");
    writeFileSync(thumbPath, THUMB);
    const ev = ingestDb.insertEvent({
      externalId: "mom@x/VID3",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: chats[0].id,
      actorId: ingestDb.actorId("whatsapp", "mom@x"),
      ts: "2026-07-02T11:10:00.000Z",
      kind: "video",
      text: "",
      mediaPath: join(mediaRoot, "mom@x", "VID3.mp4"),
      rawJson: null,
      mediaThumbPath: thumbPath,
    });
    expect(
      (await fetch(`${base}/api/media/${encodeURIComponent(ev.id)}/thumb`)).status,
    ).toBe(200);

    // A revoke NULLs media_path but leaves media_thumb_path in the row.
    ingestDb.applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "mom@x/VID3",
      revokedAt: "2026-07-02T11:11:00.000Z",
    });
    expect(
      (await fetch(`${base}/api/media/${encodeURIComponent(ev.id)}/thumb`)).status,
    ).toBe(404);
  });

  it("GET /api/media/:id/thumb rejects a thumbnail outside the media root", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const ev = ingestDb.insertEvent({
      externalId: "mom@x/EVIL",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: chats[0].id,
      actorId: ingestDb.actorId("whatsapp", "mom@x"),
      ts: "2026-07-02T11:15:00.000Z",
      kind: "video",
      text: "",
      mediaPath: join(mediaRoot, "mom@x", "OK.mp4"),
      rawJson: null,
      mediaThumbPath: "/etc/passwd",
    });
    const res = await fetch(`${base}/api/media/${encodeURIComponent(ev.id)}/thumb`);
    expect(res.status).toBe(403);
  });

  // ---- v5 §2/§3: sampled video frames and transcripts ---------------------

  /** A video with two sampled frames on disk, plus a transcript of its audio. */
  function seedSampledVideo(streamId: string, name: string) {
    const vidPath = join(mediaRoot, "mom@x", `${name}.mp4`);
    const frames = [0, 1].map((i) => join(mediaRoot, "mom@x", `${name}.frame${i}.jpg`));
    writeFileSync(vidPath, Buffer.from("not really an mp4"));
    for (const f of frames) writeFileSync(f, THUMB);
    const ev = ingestDb.insertEvent({
      externalId: `mom@x/${name}`,
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: ingestDb.actorId("whatsapp", "mom@x"),
      ts: "2026-07-02T12:00:00.000Z",
      kind: "video",
      text: "",
      mediaPath: vidPath,
      rawJson: null,
      mediaMime: "video/mp4",
    });
    ingestDb.recordMediaFrames(ev.id, [
      { path: frames[0], seconds: 2.5 },
      { path: frames[1], seconds: 7.5 },
    ]);
    return { ev, vidPath, frames };
  }

  interface FrameRow {
    id: string;
    mediaFrames?: { url: string; seconds: number }[];
    transcript?: string | null;
  }

  it("serves each sampled frame as its own URL, in clip order (v5 §2)", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const { ev, frames } = seedSampledVideo(chats[0].id, "FRM1");

    const msgs = await getJson<FrameRow[]>(
      `/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`,
    );
    const row = msgs.find((m) => m.id === ev.id)!;
    expect(row.mediaFrames).toEqual([
      { url: `/api/media/${encodeURIComponent(ev.id)}/frame0`, seconds: 2.5 },
      { url: `/api/media/${encodeURIComponent(ev.id)}/frame1`, seconds: 7.5 },
    ]);
    // The stored absolute path is the one thing that must never reach a browser.
    for (const f of frames) expect(JSON.stringify(row)).not.toContain(f);

    const first = await fetch(`${base}${row.mediaFrames![0].url}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/jpeg");
    expect((await first.arrayBuffer()).byteLength).toBe(THUMB.length);

    // An index past the end of the sequence is a miss, not the video itself.
    const past = await fetch(`${base}/api/media/${encodeURIComponent(ev.id)}/frame9`);
    expect(past.status).toBe(404);
  });

  it("a video with no sampled frames offers none (frame sampling is off by default)", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const msgs = await getJson<FrameRow[]>(
      `/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`,
    );
    const plain = msgs.find((m) => m.id === "whatsapp:mom@x/VID2")!;
    expect(plain.mediaFrames).toBeUndefined();
    expect(
      (await fetch(`${base}/api/media/whatsapp%3Amom%40x%2FVID2/frame0`)).status,
    ).toBe(404);
  });

  it("serves the stills of a LINKED clip, which has no file to hang off (v7 §4)", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const linkFrames = [0, 1].map((i) =>
      join(mediaRoot, "mom@x", `LNKV.frame${i}.jpg`),
    );
    for (const f of linkFrames) writeFileSync(f, THUMB);
    const ev = ingestDb.insertEvent({
      externalId: "mom@x/LNKV",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: chats[0].id,
      actorId: ingestDb.actorId("whatsapp", "mom@x"),
      ts: "2026-07-02T12:20:00.000Z",
      kind: "message",
      text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      // The download is deleted after sampling, so there never is one here.
      mediaPath: null,
      rawJson: null,
      linkUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    ingestDb.recordMediaFrames(ev.id, [
      { path: linkFrames[0], seconds: 4 },
      { path: linkFrames[1], seconds: 12 },
    ]);

    const msgs = await getJson<FrameRow[]>(
      `/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`,
    );
    const row = msgs.find((m) => m.id === ev.id)!;
    // Hanging the frames off media_path is what made these invisible: a link
    // message has none, so the stills never reached the payload at all.
    expect(row.mediaFrames).toEqual([
      { url: `/api/media/${encodeURIComponent(ev.id)}/frame0`, seconds: 4 },
      { url: `/api/media/${encodeURIComponent(ev.id)}/frame1`, seconds: 12 },
    ]);
    for (const f of linkFrames) expect(JSON.stringify(row)).not.toContain(f);

    const first = await fetch(`${base}${row.mediaFrames![0].url}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/jpeg");

    // Still nothing else: the message has no file, and asking for one says so.
    expect(
      (await fetch(`${base}/api/media/${encodeURIComponent(ev.id)}`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/api/media/${encodeURIComponent(ev.id)}/thumb`)).status,
    ).toBe(404);
  });

  it("carries a transcript on the message it was heard in (v5 §3)", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const audioPath = join(mediaRoot, "mom@x", "PTT1.ogg");
    writeFileSync(audioPath, Buffer.from("not really an opus file"));
    const ev = ingestDb.insertEvent({
      externalId: "mom@x/PTT1",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: chats[0].id,
      actorId: ingestDb.actorId("whatsapp", "mom@x"),
      ts: "2026-07-02T12:05:00.000Z",
      kind: "audio",
      text: "",
      mediaPath: audioPath,
      rawJson: null,
      mediaMime: "audio/ogg",
    });
    ingestDb.recordTranscript(ev.id, {
      transcript: "कल मिलते हैं",
      model: "large-v3-turbo-q5_0",
      status: "done",
    });

    const msgs = await getJson<FrameRow[]>(
      `/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`,
    );
    expect(msgs.find((m) => m.id === ev.id)!.transcript).toBe("कल मिलते हैं");
  });

  it("a revoked video stops serving the frames sampled out of it", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const { ev } = seedSampledVideo(chats[0].id, "FRM2");
    expect(
      (await fetch(`${base}/api/media/${encodeURIComponent(ev.id)}/frame0`)).status,
    ).toBe(200);

    ingestDb.applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "mom@x/FRM2",
      revokedAt: "2026-07-02T12:10:00.000Z",
    });

    expect(
      (await fetch(`${base}/api/media/${encodeURIComponent(ev.id)}/frame0`)).status,
    ).toBe(404);
    const msgs = await getJson<FrameRow[]>(
      `/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`,
    );
    const row = msgs.find((m) => m.id === ev.id)!;
    expect(row.mediaFrames).toBeUndefined();
    expect(row.transcript).toBeUndefined();
  });

  // The layers on either side of this seam were each covered — the daemon's
  // fields reach the row (ingest/index.test.ts), the row reaches the payload
  // (above) — and the route still shipped dropping `link`, because nothing ran
  // the whole way through. This does.
  it("an event arriving over the daemon stream keeps its link and its media thumbnail, as URLs (v4 §2/§3)", async () => {
    const chats = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    const linkThumb = join(mediaRoot, "mom@x", "E2E.link.jpg");
    const vidPath = join(mediaRoot, "mom@x", "E2E.mp4");
    const vidThumb = join(mediaRoot, "mom@x", "E2E.thumb.jpg");
    writeFileSync(linkThumb, THUMB);
    writeFileSync(vidPath, Buffer.from("not really an mp4"));
    writeFileSync(vidThumb, THUMB);

    child.line({
      t: "event",
      event: {
        external_id: "mom@x/E2E-LNK",
        channel_ext_id: "mom@x",
        actor_ext_id: "mom@x",
        ts: "2026-07-02T11:30:00.000Z",
        kind: "message",
        text: "https://example.com/e2e",
        from_me: false,
        link: {
          url: "https://example.com/e2e",
          title: "End to end",
          description: "The whole way through",
          thumb_path: linkThumb,
          preview_type: "article",
        },
        raw: { id: "E2E-LNK" },
      },
    });
    child.line({
      t: "event",
      event: {
        external_id: "mom@x/E2E-VID",
        channel_ext_id: "mom@x",
        actor_ext_id: "mom@x",
        ts: "2026-07-02T11:31:00.000Z",
        kind: "video",
        text: "",
        from_me: false,
        media: { path: vidPath, mime: "video/mp4", thumb_path: vidThumb },
        raw: { id: "E2E-VID" },
      },
    });

    const msgs = await getJson<
      Array<{ id: string; link: MessageLink | null; mediaThumbUrl?: string }>
    >(`/api/inbox/chats/${encodeURIComponent(chats[0].id)}/messages`);

    const linkRow = msgs.find((m) => m.id === "whatsapp:mom@x/E2E-LNK")!;
    expect(linkRow.link).toEqual({
      url: "https://example.com/e2e",
      title: "End to end",
      description: "The whole way through",
      previewType: "article",
      scrapedText: null,
      thumbUrl: "/api/media/whatsapp%3Amom%40x%2FE2E-LNK/link-thumb",
    });

    const vidRow = msgs.find((m) => m.id === "whatsapp:mom@x/E2E-VID")!;
    expect(vidRow.mediaThumbUrl).toBe("/api/media/whatsapp%3Amom%40x%2FE2E-VID/thumb");

    // A path is not fetchable by a browser, so neither may reach the UI as one.
    expect(JSON.stringify(msgs)).not.toContain(linkThumb);
    expect(JSON.stringify(msgs)).not.toContain(vidThumb);

    // Both URLs resolve to the stored bytes — the point of handing out a URL.
    for (const url of [linkRow.link!.thumbUrl!, vidRow.mediaThumbUrl!]) {
      const res = await fetch(`${base}${url}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(THUMB);
    }
  });

  it("POST /api/whatsapp/pause persists the kill-switch + forwards the command", async () => {
    const res = await fetch(`${base}/api/whatsapp/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; paused: boolean };
    expect(body).toEqual({ ok: true, paused: true });
    expect(ingestDb.appStateGet("source.whatsapp.paused")).toBe("1");
    expect(child.writes.some((w) => w.includes('"cmd":"pause"'))).toBe(true);

    // Unpause resets it.
    await fetch(`${base}/api/whatsapp/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
    expect(ingestDb.appStateGet("source.whatsapp.paused")).toBe("0");
  });

  it("POST /api/whatsapp/import validates the range", async () => {
    const bad = await fetch(`${base}/api/whatsapp/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: "2d" }),
    });
    expect(bad.status).toBe(400);

    const ok = await fetch(`${base}/api/whatsapp/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: "7d" }),
    });
    expect(ok.status).toBe(200);
    expect(child.writes.some((w) => w.includes('"cmd":"import"'))).toBe(true);
  });

  it("POST /api/whatsapp/pair + extend + logout forward commands", async () => {
    await fetch(`${base}/api/whatsapp/pair`, { method: "POST" });
    await fetch(`${base}/api/whatsapp/extend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: "30d" }),
    });
    await fetch(`${base}/api/whatsapp/logout`, { method: "POST" });
    expect(child.writes.some((w) => w.includes('"cmd":"start_pairing"'))).toBe(true);
    expect(child.writes.some((w) => w.includes('"cmd":"extend"'))).toBe(true);
    expect(child.writes.some((w) => w.includes('"cmd":"logout"'))).toBe(true);
  });

  it("GET /api/whatsapp/stream emits an initial status frame", async () => {
    const res = await fetch(`${base}/api/whatsapp/stream`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("data:");
    const jsonLine = text.split("\n").find((l) => l.startsWith("data: "))!;
    const frame = JSON.parse(jsonLine.slice(6)) as { type: string; state: string };
    expect(frame.type).toBe("status");
    await reader.cancel();
  });

  it("GET /api/whatsapp/stream forwards the ingest nudge frame (Rev 2 §R2.2)", async () => {
    // Open the stream, then push a NEW live event; the debounced ingest nudge
    // must be delivered on the same SSE the UI already listens to.
    const res = await fetch(`${base}/api/whatsapp/stream`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the immediate initial `status` frame.
    await reader.read();

    // A brand-new event (unique id) triggers a debounced ingest nudge.
    child.line({
      t: "event",
      event: {
        external_id: "mom@x/STREAM1",
        channel_ext_id: "mom@x",
        actor_ext_id: "mom@x",
        ts: "2026-07-02T12:34:56.000Z",
        kind: "message",
        text: "stream nudge please",
        from_me: false,
        raw: { id: "STREAM1" },
      },
    });

    // Read frames until we see the ingest frame or time out.
    let sawIngest: { type: string; ts?: string; channels?: string[] } | null = null;
    const deadline = Date.now() + 3000;
    let buf = "";
    while (Date.now() < deadline && !sawIngest) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      for (const line of buf.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const frame = JSON.parse(line.slice(6));
          if (frame.type === "ingest") sawIngest = frame;
        } catch {
          /* partial line; keep buffering */
        }
      }
    }
    await reader.cancel();

    expect(sawIngest).toBeTruthy();
    expect(typeof sawIngest!.ts).toBe("string");
    expect(Array.isArray(sawIngest!.channels)).toBe(true);
  });

  it("POST /api/whatsapp/reset clears data + flags, /status shows importDone:false, keeps whatsmeow session (Rev 2 §R2.3)", async () => {
    // Seed the persisted import flags via a real import call (also sets in-mem).
    await fetch(`${base}/api/whatsapp/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: "7d" }),
    });
    // P0.6: import_done advances only on the DAEMON'S completion signal, not
    // on issuing the import — emit the frame the way a finished daemon would.
    child.line({ t: "backfill_complete", range: "7d", chats: 1, messages: 1 });
    expect(ingestDb.appStateGet("source.whatsapp.import_done")).toBe("true");
    const before = await getJson<{ importDone: boolean }>("/api/whatsapp/status");
    expect(before.importDone).toBe(true);

    // The daemon session store must be left untouched by reset.
    const sessionPath = join(tmpDir, "whatsapp", "whatsmeow.db");
    mkdirSync(join(tmpDir, "whatsapp"), { recursive: true });
    writeFileSync(sessionPath, "fake-session-bytes");

    // Sanity: there IS whatsapp data to clear.
    const chatsBefore = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    expect(chatsBefore.length).toBeGreaterThan(0);

    const res = await fetch(`${base}/api/whatsapp/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      cleared: { events: number; channels: number; actors: number };
    };
    expect(body.ok).toBe(true);
    expect(body.cleared.events).toBeGreaterThan(0);
    expect(body.cleared.channels).toBeGreaterThan(0);
    expect(body.cleared.actors).toBeGreaterThan(0);

    // Data is gone.
    const chatsAfter = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    expect(chatsAfter).toEqual([]);

    // Flags cleared + status reports importDone:false.
    expect(ingestDb.appStateGet("source.whatsapp.import_done")).toBeNull();
    expect(ingestDb.appStateGet("source.whatsapp.import_range")).toBeNull();
    const after = await getJson<{ importDone: boolean }>("/api/whatsapp/status");
    expect(after.importDone).toBe(false);

    // whatsmeow session file is NOT touched.
    expect(existsSync(sessionPath)).toBe(true);
  });

  it("POST /api/whatsapp/logout clears the import flags + forwards logout (Rev 3 §R3.2)", async () => {
    // Seed the import flags via a real import.
    await fetch(`${base}/api/whatsapp/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: "7d" }),
    });
    // P0.6: completion (and thus import_done) comes from the daemon's signal.
    child.line({ t: "backfill_complete", range: "7d", chats: 1, messages: 1 });
    expect(ingestDb.appStateGet("source.whatsapp.import_done")).toBe("true");

    const before = child.writes.length;
    const res = await fetch(`${base}/api/whatsapp/logout`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Import flags cleared + /status reports importDone:false.
    expect(ingestDb.appStateGet("source.whatsapp.import_done")).toBeNull();
    expect(ingestDb.appStateGet("source.whatsapp.import_range")).toBeNull();
    const st = await getJson<{ importDone: boolean }>("/api/whatsapp/status");
    expect(st.importDone).toBe(false);

    // logout command forwarded to the daemon.
    expect(child.writes.slice(before).some((w) => w.includes('"cmd":"logout"'))).toBe(true);
  });

  it("POST /api/whatsapp/relink wipes data + clears flags + sends logout (Rev 3 §R3.2)", async () => {
    // Re-seed a chat + import flags (a previous test may have cleared them).
    child.line({ t: "channel", channel: { source_ext_id: "rl@x", name: "Relink", kind: "dm" } });
    child.line({ t: "actor", actor: { source_ext_id: "rl@x", display_name: "Relink", is_self: false } });
    child.line({
      t: "event",
      event: {
        external_id: "rl@x/RL1",
        channel_ext_id: "rl@x",
        actor_ext_id: "rl@x",
        ts: "2026-07-02T13:00:00.000Z",
        kind: "message",
        text: "before relink",
        from_me: false,
        raw: { id: "RL1" },
      },
    });
    await fetch(`${base}/api/whatsapp/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: "30d" }),
    });
    // P0.6: completion (and thus import_done) comes from the daemon's signal.
    child.line({ t: "backfill_complete", range: "30d", chats: 1, messages: 1 });
    expect(ingestDb.appStateGet("source.whatsapp.import_done")).toBe("true");
    const chatsBefore = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    expect(chatsBefore.length).toBeGreaterThan(0);

    const before = child.writes.length;
    const res = await fetch(`${base}/api/whatsapp/relink`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // (1) ingested data wiped.
    const chatsAfter = await getJson<Array<{ id: string }>>("/api/inbox/chats");
    expect(chatsAfter).toEqual([]);
    // (2) import flags cleared (+ /status importDone:false).
    expect(ingestDb.appStateGet("source.whatsapp.import_done")).toBeNull();
    expect(ingestDb.appStateGet("source.whatsapp.import_range")).toBeNull();
    const st = await getJson<{ importDone: boolean }>("/api/whatsapp/status");
    expect(st.importDone).toBe(false);
    // (3) logout sent to the daemon.
    expect(child.writes.slice(before).some((w) => w.includes('"cmd":"logout"'))).toBe(true);
  });

  // ---- Source-scoped routes (build item 1.1, arch §3.3 leak 4) -----------

  it("serves the canonical /api/sources/:source_id/status", async () => {
    const canonical = await getJson<{ paired: boolean }>("/api/sources/whatsapp/status");
    const alias = await getJson<{ paired: boolean }>("/api/whatsapp/status");
    expect(canonical).toEqual(alias);
  });

  it("keeps the old /api/whatsapp/* path working for one release", async () => {
    const res = await fetch(`${base}/api/whatsapp/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paused: false });
  });

  it("pauses through the canonical path too, and persists under source.<id>.*", async () => {
    const res = await fetch(`${base}/api/sources/whatsapp/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(200);
    expect(ingestDb.appStateGet("source.whatsapp.paused")).toBe("1");
    // Undo, so later cases still ingest.
    await fetch(`${base}/api/sources/whatsapp/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
    expect(ingestDb.appStateGet("source.whatsapp.paused")).toBe("0");
  });

  it("404s a control route naming a source this worker does not run", async () => {
    const res = await fetch(`${base}/api/sources/gmail/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown source "gmail"' });
  });

  it("does not shadow Phase-0 routes (health still ok, unknown => 404)", async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    expect(res.status).toBe(404);
  });

  // ---- P0.6: approval-token mint + gated send ------------------------------

  it("POST /api/approvals/mint mints a single-use token; blank action 400s", async () => {
    const res = await fetch(`${base}/api/approvals/mint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "whatsapp.send" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; action: string; expires_at: string };
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.action).toBe("whatsapp.send");

    const bad = await fetch(`${base}/api/approvals/mint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
  });

  it("POST send without a valid token => 403, nothing reaches the daemon", async () => {
    const before = child.writes.length;
    const res = await fetch(`${base}/api/sources/whatsapp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "x@s.whatsapp.net",
        text: "hi",
        approval_token: "bogus",
      }),
    });
    expect(res.status).toBe(403);
    expect(
      child.writes.slice(before).some((w) => w.includes('"cmd":"send_message"')),
    ).toBe(false);

    // Missing fields entirely => 400 before the token is even considered.
    const missing = await fetch(`${base}/api/sources/whatsapp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "x@s.whatsapp.net" }),
    });
    expect(missing.status).toBe(400);
  });

  it("POST send with a minted token forwards send_message exactly once", async () => {
    const mint = (await (
      await fetch(`${base}/api/approvals/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "whatsapp.send" }),
      })
    ).json()) as { token: string };

    const before = child.writes.length;
    const res = await fetch(`${base}/api/sources/whatsapp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "x@s.whatsapp.net",
        text: "approved via route",
        approval_token: mint.token,
      }),
    });
    expect(res.status).toBe(200);
    const sends = child.writes
      .slice(before)
      .filter((w) => w.includes('"cmd":"send_message"'));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain(mint.token);

    // Replaying the consumed token => 403, no second command.
    const replay = await fetch(`${base}/api/sources/whatsapp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "x@s.whatsapp.net",
        text: "again",
        approval_token: mint.token,
      }),
    });
    expect(replay.status).toBe(403);
    expect(
      child.writes.slice(before).filter((w) => w.includes('"cmd":"send_message"')),
    ).toHaveLength(1);
  });
});
