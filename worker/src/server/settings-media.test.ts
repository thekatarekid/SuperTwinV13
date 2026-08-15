// ===========================================================================
// HTTP tests for the media-reader settings surface: GET/POST
// /api/settings/media, GET /api/media/queue (backfill progress) and
// GET /api/chat/status (the Chat tab's kill-switch banner).
//
// Boots the real worker server on an ephemeral port with a STUB provider (no
// real `claude` CLI) and a temp SQLite DB — same lightweight pattern as the
// other route-module tests.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE imports (db module reads SUPERTWIN_DB_PATH lazily at first use).
const tmpDir = mkdtempSync(join(tmpdir(), "st-settings-media-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");

const { getDb, runMigrations } = await import("../db/index.js");
const { register } = await import("../providers/index.js");
const { startServer } = await import("./index.js");
const { setProcessEnabled, getMediaConcurrency, MAX_MEDIA_CONCURRENCY } =
  await import("../db/settings.js");
const { getMediaImageBatch } = await import("../media/switches.js");
const { MAX_IMAGE_BATCH } = await import("../media/describe.js");

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function postJson<T>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

/** Seed described media, adding the status column when the migration has not run. */
function seedQueue(): void {
  const d = getDb();
  const cols = d.pragma("table_info(events)") as { name: string }[];
  if (!cols.some((c) => c.name === "media_desc_status")) {
    d.exec(`ALTER TABLE events ADD COLUMN media_desc_status TEXT`);
  }
  const insert = d.prepare(
    `INSERT INTO events (id, ts, kind, text, media_desc_status)
     VALUES (?, '2026-06-20T10:00:00.000Z', 'message', 'photo', ?)`,
  );
  insert.run("evt_q1", "pending");
  insert.run("evt_q2", "pending");
  insert.run("evt_q3", "done");
  insert.run("evt_q4", "error");
}

beforeAll(async () => {
  runMigrations();
  seedQueue();
  register({
    id: "claude-local",
    send: async () => ({
      sessionId: "",
      usage: {
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      },
      freshFallback: false,
      status: "ok" as const,
    }),
    cancel: () => false,
  });
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  if (server) await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

type MediaSettings = {
  describe_enabled: boolean;
  backfill_enabled: boolean;
  images_enabled: boolean;
  video_enabled: boolean;
  business_enabled: boolean;
  link_scrape_enabled: boolean;
  video_frames_enabled: boolean;
  video_audio_enabled: boolean;
  voice_notes_enabled: boolean;
  rate_per_min: number;
  concurrency: number;
  image_batch: number;
  video_frame_interval_sec: number;
  video_frame_max: number;
  video_max_height: number;
  whisper_model: string;
};

/** A fresh install, so every assertion below names the whole surface. */
const DEFAULTS: MediaSettings = {
  describe_enabled: true,
  backfill_enabled: true,
  images_enabled: true,
  video_enabled: false,
  business_enabled: false,
  link_scrape_enabled: false,
  video_frames_enabled: false,
  video_audio_enabled: true,
  voice_notes_enabled: true,
  rate_per_min: 20,
  concurrency: 5,
  image_batch: 20,
  video_frame_interval_sec: 5,
  video_frame_max: 8,
  video_max_height: 480,
  whisper_model: "large-v3-turbo-q5_0",
};

describe("GET /api/settings/media", () => {
  it("serves each switch at its default polarity and the default limits", async () => {
    const { status, body } = await getJson<MediaSettings>("/api/settings/media");
    expect(status).toBe(200);
    expect(body).toEqual(DEFAULTS);
  });

  it("ships the capabilities that spend tokens off and the local ones on (v6 §6)", async () => {
    const { body } = await getJson<MediaSettings>("/api/settings/media");
    // Frames go to Claude, so they wait to be asked for; whisper runs on this
    // Mac and costs nothing but its own time.
    expect(body.video_frames_enabled).toBe(false);
    expect(body.video_audio_enabled).toBe(true);
    expect(body.voice_notes_enabled).toBe(true);
  });
});

describe("POST /api/settings/media", () => {
  it("applies only the keys present and answers with the full settings", async () => {
    const post = await postJson<MediaSettings>("/api/settings/media", {
      backfill_enabled: false,
    });
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ ...DEFAULTS, backfill_enabled: false });

    const { body } = await getJson<MediaSettings>("/api/settings/media");
    expect(body.backfill_enabled).toBe(false);
  });

  it("flips the default-OFF switches and they stay flipped", async () => {
    const post = await postJson<MediaSettings>("/api/settings/media", {
      video_enabled: true,
      business_enabled: true,
      link_scrape_enabled: true,
    });
    expect(post.body).toMatchObject({
      video_enabled: true,
      business_enabled: true,
      link_scrape_enabled: true,
    });

    const { body } = await getJson<MediaSettings>("/api/settings/media");
    expect(body.video_enabled).toBe(true);

    await postJson<MediaSettings>("/api/settings/media", {
      video_enabled: false,
      business_enabled: false,
      link_scrape_enabled: false,
    });
  });

  it("flips the three v5 switches independently (v5 §2/§3)", async () => {
    const post = await postJson<MediaSettings>("/api/settings/media", {
      video_frames_enabled: true,
      voice_notes_enabled: false,
    });
    // Video audio is its own switch: silencing voice notes must not silence it.
    expect(post.body).toMatchObject({
      video_frames_enabled: true,
      voice_notes_enabled: false,
      video_audio_enabled: true,
    });

    const { body } = await getJson<MediaSettings>("/api/settings/media");
    expect(body.video_frames_enabled).toBe(true);

    await postJson<MediaSettings>("/api/settings/media", {
      video_frames_enabled: false,
      voice_notes_enabled: true,
    });
  });

  it("clamps the frame interval and cap the way it clamps the throttle", async () => {
    const high = await postJson<MediaSettings>("/api/settings/media", {
      video_frame_interval_sec: 100_000,
      video_frame_max: 999,
    });
    expect(high.body.video_frame_interval_sec).toBe(3600);
    expect(high.body.video_frame_max).toBe(20);

    const low = await postJson<MediaSettings>("/api/settings/media", {
      video_frame_interval_sec: 0,
      video_frame_max: -4,
    });
    expect(low.body.video_frame_interval_sec).toBe(1);
    expect(low.body.video_frame_max).toBe(1);

    const back = await postJson<MediaSettings>("/api/settings/media", {
      video_frame_interval_sec: 5,
      video_frame_max: 8,
    });
    expect(back.body.video_frame_interval_sec).toBe(5);
  });

  it("clamps the download height at BOTH ends (v7 §4)", async () => {
    const high = await postJson<MediaSettings>("/api/settings/media", {
      video_max_height: 4320,
    });
    expect(high.body.video_max_height).toBe(1080);

    // The only limit here with a floor of its own: under it no site publishes a
    // matching format and the download silently falls back to "worst".
    const low = await postJson<MediaSettings>("/api/settings/media", {
      video_max_height: 1,
    });
    expect(low.body.video_max_height).toBe(144);

    const back = await postJson<MediaSettings>("/api/settings/media", {
      video_max_height: 480,
    });
    expect(back.body.video_max_height).toBe(480);
  });

  it("accepts a catalogue model id and rejects anything else", async () => {
    const ok = await postJson<MediaSettings>("/api/settings/media", {
      whisper_model: "small",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.whisper_model).toBe("small");

    // The transcriber builds a file path out of this id, so an unknown value is
    // rejected rather than clamped or stored.
    const bad = await postJson<{ error: string }>("/api/settings/media", {
      whisper_model: "../../etc/passwd",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("whisper_model must be one of");

    const enOnly = await postJson<{ error: string }>("/api/settings/media", {
      whisper_model: "small.en",
    });
    expect(enOnly.status).toBe(400);

    const { body } = await getJson<MediaSettings>("/api/settings/media");
    expect(body.whisper_model).toBe("small");

    await postJson<MediaSettings>("/api/settings/media", {
      whisper_model: "large-v3-turbo-q5_0",
    });
  });

  it("clamps the throttle instead of rejecting it", async () => {
    const high = await postJson<MediaSettings>("/api/settings/media", {
      rate_per_min: 10_000,
    });
    expect(high.body.rate_per_min).toBe(600);

    const low = await postJson<MediaSettings>("/api/settings/media", {
      rate_per_min: 0,
    });
    expect(low.body.rate_per_min).toBe(1);
  });

  it("persists how many media reads run at once, clamped (v6 §5)", async () => {
    const set = await postJson<MediaSettings>("/api/settings/media", {
      concurrency: 8,
    });
    expect(set.body.concurrency).toBe(8);
    // The queue reads this getter each time it fills, so a change lands without
    // a restart — and the settings surface must be reading the same value.
    expect(getMediaConcurrency()).toBe(8);

    // Every slot holds a CLI child and a model call open, so an absurd number is
    // capped rather than obeyed.
    const high = await postJson<MediaSettings>("/api/settings/media", {
      concurrency: 900,
    });
    expect(high.body.concurrency).toBe(MAX_MEDIA_CONCURRENCY);

    const low = await postJson<MediaSettings>("/api/settings/media", {
      concurrency: 0,
    });
    expect(low.body.concurrency).toBe(1);

    // Leave it where a fresh install has it — the whole file shares one DB.
    await postJson<MediaSettings>("/api/settings/media", { concurrency: 5 });
  });

  it("persists the image batch size the reader claims against (v4 §4d)", async () => {
    const set = await postJson<MediaSettings>("/api/settings/media", {
      image_batch: 12,
    });
    expect(set.body.image_batch).toBe(12);
    // The reader's own getter is the one the claim query uses every cycle.
    expect(getMediaImageBatch()).toBe(12);

    const { body } = await getJson<MediaSettings>("/api/settings/media");
    expect(body.image_batch).toBe(12);
  });

  it("clamps the batch size to what one call can hold apart", async () => {
    const high = await postJson<MediaSettings>("/api/settings/media", {
      image_batch: 500,
    });
    expect(high.body.image_batch).toBe(MAX_IMAGE_BATCH);

    const low = await postJson<MediaSettings>("/api/settings/media", {
      image_batch: 0,
    });
    expect(low.body.image_batch).toBe(1);

    // Leave it where a fresh install has it — the whole file shares one DB.
    await postJson<MediaSettings>("/api/settings/media", { image_batch: 20 });
  });

  it("rejects wrong types with 400", async () => {
    const bool = await postJson<{ error: string }>("/api/settings/media", {
      describe_enabled: "yes",
    });
    expect(bool.status).toBe(400);
    expect(bool.body.error).toBe("describe_enabled must be a boolean");

    const scrape = await postJson<{ error: string }>("/api/settings/media", {
      link_scrape_enabled: 1,
    });
    expect(scrape.status).toBe(400);
    expect(scrape.body.error).toBe("link_scrape_enabled must be a boolean");

    const rate = await postJson<{ error: string }>("/api/settings/media", {
      rate_per_min: "fast",
    });
    expect(rate.status).toBe(400);
    expect(rate.body.error).toBe("rate_per_min must be a number");

    const batch = await postJson<{ error: string }>("/api/settings/media", {
      image_batch: "twenty",
    });
    expect(batch.status).toBe(400);
    expect(batch.body.error).toBe("image_batch must be a number");
  });

  it("writes nothing when a later key in the same body is rejected", async () => {
    const bad = await postJson<{ error: string }>("/api/settings/media", {
      images_enabled: false,
      video_enabled: "on",
    });
    expect(bad.status).toBe(400);

    const { body } = await getJson<MediaSettings>("/api/settings/media");
    expect(body.images_enabled).toBe(true);

    // A bad number rejects the switches in the same body too — the switches are
    // validated first, but nothing is applied until every key has passed.
    const mixed = await postJson<{ error: string }>("/api/settings/media", {
      images_enabled: false,
      image_batch: "twelve",
    });
    expect(mixed.status).toBe(400);

    const after = await getJson<MediaSettings>("/api/settings/media");
    expect(after.body.images_enabled).toBe(true);
    expect(after.body.image_batch).toBe(20);
  });
});

describe("GET /api/media/queue", () => {
  it("counts events by description status", async () => {
    const { status, body } = await getJson<Record<string, number>>("/api/media/queue");
    expect(status).toBe(200);
    expect(body).toEqual({ pending: 2, done: 1, unsupported: 0, error: 1 });
  });
});

describe("GET /api/chat/status", () => {
  it("mirrors the chat process toggle", async () => {
    const on = await getJson<{ enabled: boolean }>("/api/chat/status");
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);

    setProcessEnabled("chat", false);
    const off = await getJson<{ enabled: boolean }>("/api/chat/status");
    expect(off.body.enabled).toBe(false);
    setProcessEnabled("chat", true);
  });
});

// Last in the file: a re-scan rewrites media_desc_status, which the queue-count
// assertion above reads.
type RescanResult = {
  media: number;
  links: number;
  transcripts: number;
  frames: number;
};

describe("POST /api/media/rescan", () => {
  it("re-queues the requested type and reports what moved", async () => {
    getDb()
      .prepare(
        `INSERT INTO events (id, ts, kind, text, media_path, media_desc_status)
         VALUES ('evt_img', '2026-06-20T10:00:00.000Z', 'image', '', '/tmp/a.jpg', 'done')`,
      )
      .run();

    const { status, body } = await postJson<RescanResult>("/api/media/rescan", {
      types: ["image"],
    });
    expect(status).toBe(200);
    expect(body).toEqual({ media: 1, links: 0, transcripts: 0, frames: 0 });

    const { body: queue } = await getJson<Record<string, number>>("/api/media/queue");
    expect(queue.pending).toBe(3);
  });

  it("accepts the two v5 types and counts them on their own", async () => {
    getDb()
      .prepare(
        `INSERT INTO events (id, ts, kind, text, media_path, transcript_status,
                             media_frames_json)
         VALUES ('evt_vid', '2026-06-20T10:00:00.000Z', 'video', '', '/tmp/a.mp4',
                 'done', '[{"path":"/tmp/a.frame0.jpg","seconds":2.5}]')`,
      )
      .run();

    const { status, body } = await postJson<RescanResult>("/api/media/rescan", {
      types: ["transcript", "frames"],
    });
    expect(status).toBe(200);
    // Frames are dropped rather than kept, so they land in their own counter —
    // "media" would read as descriptions that were re-queued.
    expect(body.transcripts).toBe(1);
    expect(body.frames).toBe(1);
  });

  it("rejects an unknown type instead of silently rescanning less", async () => {
    const bad = await postJson<{ error: string }>("/api/media/rescan", {
      types: ["image", "audio"],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("types must be an array of");

    const missing = await postJson<{ error: string }>("/api/media/rescan", {});
    expect(missing.status).toBe(400);
  });

  it("accepts an empty selection as the no-op it is", async () => {
    const { status, body } = await postJson<RescanResult>("/api/media/rescan", {
      types: [],
    });
    expect(status).toBe(200);
    expect(body).toEqual({ media: 0, links: 0, transcripts: 0, frames: 0 });
  });
});
