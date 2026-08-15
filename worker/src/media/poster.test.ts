// ===========================================================================
// Video poster tests (vitest). ffmpeg is a stub that records its argv, over a
// real temp DB, because the poster is only half a filesystem operation: what
// makes a video render as a video is the path landing in media_thumb_path, and
// what makes that safe is the row still having no thumbnail when it does.
//
// The offset gets its own test. v7 §3's whole complaint is that ten videos
// render as file chips, and a poster taken from the black frame every clip
// opens on would be the file chip with extra steps.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { insertEvent, upsertSource } from "../db/ingest.js";
import { generateVideoPoster, posterPath } from "./poster.js";

let tmpDir: string;
let mediaDir: string;
let calls: string;
let video: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-media-poster-"));
  mediaDir = join(tmpDir, "media", "chat");
  mkdirSync(mediaDir, { recursive: true });
  process.env.SUPERTWIN_MEDIA_DIR = join(tmpDir, "media");
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  calls = join(tmpDir, "calls.jsonl");
  video = join(mediaDir, "3A17B6D20C20A970AD3F.mp4");
  writeFileSync(video, "mp4");
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_MEDIA_DIR;
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_FFMPEG_BIN;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** An ffmpeg that reports `duration` when probing and writes the still asked for. */
function stubFfmpeg(opts: { duration?: string; fails?: boolean } = {}): void {
  const path = join(tmpDir, "ffmpeg");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + "\\n");
const out = argv[argv.length - 1];
if (!out.endsWith(".jpg")) {
  process.stderr.write("  Duration: ${opts.duration ?? "00:02:42.00"}, start: 0.0\\n");
  process.exit(1);
}
${opts.fails ? `process.stderr.write("could not seek\\n"); process.exit(1);` : `fs.writeFileSync(out, "jpeg");`}
`,
    { mode: 0o755 },
  );
  process.env.SUPERTWIN_FFMPEG_BIN = path;
}

function argvOf(): string[][] {
  if (!existsSync(calls)) return [];
  return readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

/** The reported row of v7 §3: 32.4 MB, 2:42, no thumbnail anywhere. */
function seedVideo(thumbPath: string | null = null): string {
  const { id } = insertEvent({
    externalId: "1203@g.us/3A17B6D20C20A970AD3F",
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    channelId: null,
    actorId: null,
    ts: "2026-07-02T10:00:00.000Z",
    kind: "video",
    text: "",
    mediaPath: video,
    mediaThumbPath: thumbPath,
    mediaSeconds: 162,
    mediaMime: "video/mp4",
    rawJson: null,
  });
  return id;
}

function storedThumb(id: string): string | null {
  const row = getDb()
    .prepare(`SELECT media_thumb_path AS p FROM events WHERE id = ?`)
    .get(id) as { p: string | null } | undefined;
  return row?.p ?? null;
}

describe("posterPath", () => {
  it("sits beside the video, and never on the daemon's own thumbnail", () => {
    // Two programs writing one path is how one of them overwrites bytes it did
    // not produce; the daemon writes `<stem>.thumb.jpg`.
    expect(posterPath("/media/chat/ABC.mp4")).toBe("/media/chat/ABC.poster.jpg");
    expect(posterPath("/media/chat/ABC")).toBe("/media/chat/ABC.poster.jpg");
    expect(posterPath("/media/my.chat/ABC")).toBe("/media/my.chat/ABC.poster.jpg");
  });

  it("cannot be reached by the frame sweep", () => {
    // sweepOrphanFrames deletes every `*.frame<N>.jpg` the DB does not name,
    // and nothing names a poster.
    expect(posterPath("/media/chat/ABC.mp4")).not.toMatch(/\.frame\d+\.jpg$/);
  });
});

describe("generateVideoPoster", () => {
  it("writes a still and records it as the row's thumbnail", async () => {
    stubFfmpeg();
    const id = seedVideo();

    const result = await generateVideoPoster({
      id,
      mediaPath: video,
      seconds: 162,
    });

    expect(result.error).toBeNull();
    expect(result.path).toBe(posterPath(video));
    expect(existsSync(posterPath(video))).toBe(true);
    expect(storedThumb(id)).toBe(posterPath(video));
  });

  it("takes the frame from the middle of the clip, not its opening black", async () => {
    stubFfmpeg({ duration: "00:02:42.00" });
    const id = seedVideo();

    await generateVideoPoster({ id, mediaPath: video, seconds: 162 });

    const encode = argvOf().find((c) => c[c.length - 1].endsWith(".jpg")) ?? [];
    expect(encode[encode.indexOf("-ss") + 1]).toBe("81");
    // Seeking before -i jumps instead of decoding 81 seconds to get there.
    expect(encode.indexOf("-ss")).toBeLessThan(encode.indexOf("-i"));
    // The path a stranger's message chose is one argv element, never a string a
    // shell was handed.
    expect(encode).toContain(video);
  });

  it("throws away the still when the row was given a thumbnail meanwhile", async () => {
    stubFfmpeg();
    // WhatsApp's own frame is the sender's choice and outranks our arithmetic.
    const id = seedVideo(join(mediaDir, "3A17B6D20C20A970AD3F.thumb.jpg"));

    const result = await generateVideoPoster({ id, mediaPath: video, seconds: 162 });

    expect(result.path).toBeNull();
    expect(result.error).toBe("the row already had a thumbnail");
    // Referenced by nothing, so it must not be left on disk.
    expect(existsSync(posterPath(video))).toBe(false);
    expect(storedThumb(id)).toMatch(/\.thumb\.jpg$/);
  });

  it("records nothing when ffmpeg could not decode a frame", async () => {
    stubFfmpeg({ fails: true });
    const id = seedVideo();

    const result = await generateVideoPoster({ id, mediaPath: video, seconds: 162 });

    expect(result.path).toBeNull();
    expect(result.error).toMatch(/no frame could be sampled/);
    // A poster path pointing at nothing renders as a broken image, which is
    // worse than the file chip it would have replaced.
    expect(storedThumb(id)).toBeNull();
  });

  it("says so rather than throwing when ffmpeg was never staged", async () => {
    process.env.SUPERTWIN_FFMPEG_BIN = join(tmpDir, "absent");
    const id = seedVideo();

    const result = await generateVideoPoster({ id, mediaPath: video, seconds: 162 });

    expect(result.error).toBe("ffmpeg is not installed with the app");
    expect(storedThumb(id)).toBeNull();
  });
});
