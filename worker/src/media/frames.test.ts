// ===========================================================================
// Frame sampling tests (vitest). ffmpeg is a stub script that records its own
// argv, so what is asserted is the exact command line — including that a media
// path chosen by a stranger arrives as one argv element and is never seen by a
// shell.
//
// The offsets get the most attention: sampling the head of a clip instead of
// spanning it is the failure v5 §2 names outright, and it is invisible in
// anything but the numbers.
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

import type { PendingMediaRow } from "../db/ingest.js";
import {
  frameOffsets,
  framePath,
  parseDuration,
  sampleVideoFrames,
  sweepOrphanFrames,
} from "./frames.js";

let tmpDir: string;
let mediaDir: string;
let calls: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-media-frames-"));
  mediaDir = join(tmpDir, "media");
  mkdirSync(join(mediaDir, "chat"), { recursive: true });
  process.env.SUPERTWIN_MEDIA_DIR = mediaDir;
  calls = join(tmpDir, "calls.jsonl");
});

afterEach(() => {
  delete process.env.SUPERTWIN_MEDIA_DIR;
  delete process.env.SUPERTWIN_FFMPEG_BIN;
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * An ffmpeg that appends its argv to `calls`, reports `duration` when asked to
 * probe, and writes a file when asked to encode one. `failAt` makes the frame
 * at that index exit non-zero, the way a seek into a corrupt clip does.
 */
function stubFfmpeg(opts: { duration?: string; failAt?: number } = {}): string {
  const path = join(tmpDir, "ffmpeg");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + "\\n");
const out = argv[argv.length - 1];
if (!out.endsWith(".jpg")) {
  ${opts.duration ? `process.stderr.write("  Duration: ${opts.duration}, start: 0.000000, bitrate: 170 kb/s\\n");` : ""}
  process.exit(1);
}
const failAt = ${opts.failAt ?? -1};
if (failAt >= 0 && out.endsWith("frame" + failAt + ".jpg")) {
  process.stderr.write("could not seek\\n");
  process.exit(1);
}
fs.writeFileSync(out, "jpeg");
`,
    { mode: 0o755 },
  );
  process.env.SUPERTWIN_FFMPEG_BIN = path;
  return path;
}

function argvOf(): string[][] {
  return readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function videoRow(over: Partial<PendingMediaRow> = {}): PendingMediaRow {
  return {
    id: "wa:v1",
    kind: "video",
    mediaPath: join(mediaDir, "chat", "MSGID.mp4"),
    thumbPath: null,
    mime: "video/mp4",
    filename: "clip.mp4",
    seconds: null,
    caption: null,
    ...over,
  };
}

describe("frameOffsets", () => {
  it("a 20s clip at 5s gives 4 frames, spread over the clip", () => {
    expect(frameOffsets(20, 5, 8)).toEqual([2.5, 7.5, 12.5, 17.5]);
  });

  it("a 10 minute clip gives 8 frames from ACROSS it, not from its first 40s", () => {
    const offsets = frameOffsets(600, 5, 8);
    expect(offsets).toHaveLength(8);
    expect(offsets[0]).toBeGreaterThan(0);
    // The failure v5 §2 names: eight frames of the opening. The last frame has
    // to be near the end of ten minutes, not near the start.
    expect(offsets[7]).toBeGreaterThan(540);
    const gaps = offsets.slice(1).map((t, i) => Math.round(t - offsets[i]));
    expect(new Set(gaps).size).toBe(1);
  });

  it("respects a max the user lowered, still spanning the clip", () => {
    expect(frameOffsets(600, 5, 2)).toEqual([150, 450]);
    expect(frameOffsets(600, 5, 1)).toEqual([300]);
  });

  it("a clip shorter than one interval still gives its middle frame", () => {
    expect(frameOffsets(3, 5, 8)).toEqual([1.5]);
  });

  it("an unknown duration falls back to a single frame at the start", () => {
    expect(frameOffsets(0, 5, 8)).toEqual([0]);
    expect(frameOffsets(Number.NaN, 5, 8)).toEqual([0]);
  });

  it("a longer interval takes fewer frames, still spread", () => {
    expect(frameOffsets(60, 20, 8)).toEqual([10, 30, 50]);
  });
});

describe("framePath", () => {
  it("sits beside the video, per the spec's naming", () => {
    expect(framePath("/media/chat/MSGID.mp4", 0)).toBe("/media/chat/MSGID.frame0.jpg");
    expect(framePath("/media/chat/MSGID.mp4", 7)).toBe("/media/chat/MSGID.frame7.jpg");
  });

  it("survives a directory with a dot in it and a name without an extension", () => {
    expect(framePath("/media/v1.2/MSGID", 0)).toBe("/media/v1.2/MSGID.frame0.jpg");
  });
});

describe("parseDuration", () => {
  it("reads ffmpeg's own report", () => {
    expect(parseDuration("  Duration: 00:03:20.50, start: 0.0")).toBe(200.5);
    expect(parseDuration("  Duration: 01:00:00.00, start: 0.0")).toBe(3600);
  });

  it("is null when there is nothing to read, including N/A", () => {
    expect(parseDuration("Duration: N/A, bitrate: N/A")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("Duration: 00:00:00.00")).toBeNull();
  });
});

describe("sampleVideoFrames", () => {
  it("probes the clip, then writes one downscaled jpeg per offset", async () => {
    stubFfmpeg({ duration: "00:00:20.00" });
    const row = videoRow();

    const result = await sampleVideoFrames(row, { intervalSec: 5, maxFrames: 8 });

    expect(result.error).toBeNull();
    expect(result.frames).toEqual([
      { path: join(mediaDir, "chat", "MSGID.frame0.jpg"), seconds: 2.5 },
      { path: join(mediaDir, "chat", "MSGID.frame1.jpg"), seconds: 7.5 },
      { path: join(mediaDir, "chat", "MSGID.frame2.jpg"), seconds: 12.5 },
      { path: join(mediaDir, "chat", "MSGID.frame3.jpg"), seconds: 17.5 },
    ]);
    for (const frame of result.frames) expect(existsSync(frame.path)).toBe(true);

    const calls = argvOf();
    expect(calls[0]).toEqual(["-hide_banner", "-nostdin", "-i", row.mediaPath]);
    // -ss BEFORE -i: an input seek jumps, an output seek decodes the whole clip
    // up to the offset, which on a long video is the difference between
    // instant and minutes.
    expect(calls[1].indexOf("-ss")).toBeLessThan(calls[1].indexOf("-i"));
    expect(calls[1]).toContain("2.5");
    expect(calls[1].join(" ")).toContain("force_original_aspect_ratio=decrease");
  });

  it("the media path is one argv element, whatever a stranger named the file", async () => {
    stubFfmpeg({ duration: "00:00:06.00" });
    const evil = join(mediaDir, "chat", `a b'; touch pwned; echo $(id) *.mp4`);
    writeFileSync(evil, "video");

    const result = await sampleVideoFrames(videoRow({ mediaPath: evil }), {
      intervalSec: 5,
      maxFrames: 8,
    });

    expect(result.frames).toHaveLength(1);
    for (const call of argvOf()) expect(call).toContain(evil);
    expect(existsSync(join(mediaDir, "chat", "pwned"))).toBe(false);
    expect(existsSync(join(process.cwd(), "pwned"))).toBe(false);
  });

  it("falls back to the recorded duration when ffmpeg will not say", async () => {
    stubFfmpeg();
    const result = await sampleVideoFrames(videoRow({ seconds: 20 }), {
      intervalSec: 5,
      maxFrames: 8,
    });
    expect(result.frames.map((f) => f.seconds)).toEqual([2.5, 7.5, 12.5, 17.5]);
  });

  it("keeps the frames it got and says how many it did not", async () => {
    stubFfmpeg({ duration: "00:00:20.00", failAt: 2 });
    const result = await sampleVideoFrames(videoRow(), {
      intervalSec: 5,
      maxFrames: 8,
    });
    expect(result.frames.map((f) => f.seconds)).toEqual([2.5, 7.5, 17.5]);
    expect(result.error).toMatch(/3 of 4 frames/);
  });

  it("reports rather than throws when ffmpeg was never staged", async () => {
    process.env.SUPERTWIN_FFMPEG_BIN = join(tmpDir, "no-ffmpeg-here");
    const result = await sampleVideoFrames(videoRow(), {
      intervalSec: 5,
      maxFrames: 8,
    });
    expect(result).toEqual({
      frames: [],
      error: "ffmpeg is not installed with the app",
    });
  });

  it("reports rather than throws when the event has no file", async () => {
    stubFfmpeg();
    const result = await sampleVideoFrames(videoRow({ mediaPath: null }), {
      intervalSec: 5,
      maxFrames: 8,
    });
    expect(result.frames).toEqual([]);
    expect(result.error).toBe("the event carries no file");
  });

  it("stops sampling when the caller aborts", async () => {
    stubFfmpeg({ duration: "00:10:00.00" });
    const abort = new AbortController();
    abort.abort();
    const result = await sampleVideoFrames(
      videoRow(),
      { intervalSec: 5, maxFrames: 8, signal: abort.signal },
    );
    expect(result.frames).toEqual([]);
  });
});

describe("sweepOrphanFrames", () => {
  it("deletes the frames the DB no longer points at, and nothing else", () => {
    const chat = join(mediaDir, "chat");
    mkdirSync(join(mediaDir, "other"), { recursive: true });
    const kept = join(chat, "KEEP.frame0.jpg");
    const orphan = join(chat, "GONE.frame0.jpg");
    const nested = join(mediaDir, "other", "GONE.frame3.jpg");
    const video = join(chat, "KEEP.mp4");
    const photo = join(chat, "PHOTO.jpg");
    for (const p of [kept, orphan, nested, video, photo]) writeFileSync(p, "x");

    expect(sweepOrphanFrames([kept])).toBe(2);

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(nested)).toBe(false);
    // The sweep only ever considers the frame naming pattern, so an actual
    // attachment is not something it can reach.
    expect(existsSync(video)).toBe(true);
    expect(existsSync(photo)).toBe(true);
  });

  it("a media root that is not there yet is not an error", () => {
    process.env.SUPERTWIN_MEDIA_DIR = join(tmpDir, "never-created");
    expect(sweepOrphanFrames([])).toBe(0);
  });
});
