// ===========================================================================
// Link-video tests (vitest). yt-dlp, ffmpeg and whisper-cli are stub scripts
// that record their own argv, so what is asserted is the exact command line —
// including that the resolution cap, the byte cap and the length cap all reach
// yt-dlp as bounds it can enforce before spending bandwidth, and that a URL
// reaches it as one argv element and is never seen by a shell.
//
// The other subject is the file itself, which v7 §4 says must not survive: the
// temp directory is asserted gone on success, on failure and on a download that
// only left a `.part` behind — the case where a partial could be mistaken for
// a finished video.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { setMediaWhisperModel } from "../store/store.js";
import {
  linkFramePath,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SEC,
  readLinkVideo,
  type LinkVideoBounds,
} from "./linkvideo.js";
import { whisperModelsDir } from "./tools.js";

let tmpDir: string;
let mediaDir: string;
let calls: string;
let argvFile: string;

const REEL = "https://www.instagram.com/reel/C1a2b3c4d5e/";

// One read spawns yt-dlp, then ffmpeg per still, then ffmpeg and whisper for
// the audio, and vitest runs test files in parallel — the default five seconds
// is a stopwatch on the machine, not on this code. The real hang detector is
// still underneath: the download itself times out at three minutes.
vi.setConfig({ testTimeout: 20_000 });

/** Everything on, so a test switches OFF what it wants to leave out. */
function bounds(over: Partial<LinkVideoBounds> = {}): LinkVideoBounds {
  return {
    eventId: "wa:1203@g.us/ABCD",
    frames: true,
    intervalSec: 5,
    maxFrames: 3,
    audio: true,
    maxHeight: 480,
    ...over,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-linkvideo-"));
  mediaDir = join(tmpDir, "media");
  mkdirSync(mediaDir, { recursive: true });
  process.env.SUPERTWIN_MEDIA_DIR = mediaDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
  calls = join(tmpDir, "calls.txt");
  argvFile = join(tmpDir, "argv.txt");
  mkdirSync(whisperModelsDir(), { recursive: true });
  writeFileSync(join(whisperModelsDir(), "ggml-small.bin"), "model");
  setMediaWhisperModel("small");
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_MEDIA_DIR;
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_FFMPEG_BIN;
  delete process.env.SUPERTWIN_WHISPER_BIN;
  delete process.env.SUPERTWIN_YTDLP_BIN;
  rmSync(tmpDir, { recursive: true, force: true });
});

interface YtDlpStub {
  /** What lands in the output directory: the finished file, or only a part. */
  writes?: "video.mp4" | "video.mp4.part" | "video.f137.mp4" | "none";
  /** Bytes the written file reports. Sparse, so a size cap is cheap to test. */
  bytes?: number;
  says?: string;
  exit?: number;
  /** Milliseconds it holds the process, for the one-at-a-time test. */
  holdMs?: number;
}

function stubYtDlp(opts: YtDlpStub = {}): void {
  const path = join(tmpDir, "yt-dlp");
  const writes = opts.writes ?? "video.mp4";
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `echo yt-dlp >> ${sh(calls)}`,
      // Only the first call's command line is read, and every call in a test
      // makes the same one.
      `[ -f ${sh(argvFile)} ] || printf '%s\\n' "$@" > ${sh(argvFile)}`,
      opts.holdMs ? `sleep ${opts.holdMs / 1000}` : "",
      `echo yt-dlp-done >> ${sh(calls)}`,
      opts.says ? `echo ${sh(opts.says)}` : "",
      'prev=""',
      'for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done',
      writes === "none"
        ? ""
        : [
            `f="$(dirname "$out")/${writes}"`,
            'printf mp4 > "$f"',
            // Sparse, so a 64 MB cap costs nothing to exceed.
            opts.bytes ? `dd if=/dev/zero of="$f" bs=1 count=0 seek=${opts.bytes} 2>/dev/null` : "",
          ].join("\n"),
      `exit ${opts.exit ?? 0}`,
    ]
      .filter(Boolean)
      .join("\n"),
    { mode: 0o755 },
  );
  process.env.SUPERTWIN_YTDLP_BIN = path;
}

/** A shell word for a path this test wrote; nothing here comes from outside. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * One ffmpeg for three jobs: probing a header, a still, and a 16 kHz WAV. In
 * shell rather than node, because one read spawns it half a dozen times and an
 * interpreter start each time is most of what this file would cost.
 */
function stubFfmpeg(opts: { duration?: string } = {}): void {
  const path = join(tmpDir, "ffmpeg");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'for a in "$@"; do out="$a"; done',
      'case "$out" in',
      '  *.jpg) printf jpeg > "$out"; exit 0 ;;',
      `  *.wav) printf riff > "$out"; echo "max_volume: -3.0 dB" >&2; exit 0 ;;`,
      "esac",
      `echo "  Duration: ${opts.duration ?? "00:00:30.00"}, start: 0.0" >&2`,
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.SUPERTWIN_FFMPEG_BIN = path;
}

function stubWhisper(text: string): void {
  const path = join(tmpDir, "whisper-cli");
  writeFileSync(path, `#!/bin/sh\nprintf ' %s' ${JSON.stringify(text)}\n`, {
    mode: 0o755,
  });
  process.env.SUPERTWIN_WHISPER_BIN = path;
}

/** Which stub binaries ran, in order. */
function ran(): string[] {
  if (!existsSync(calls)) return [];
  return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
}

function ytdlpArgv(): string[] {
  if (!existsSync(argvFile)) return [];
  return readFileSync(argvFile, "utf8").trim().split("\n");
}

/** The directory yt-dlp was told to write into, read out of its own argv. */
function downloadDir(): string {
  const argv = ytdlpArgv();
  return dirname(argv[argv.indexOf("-o") + 1]);
}

/** Ten dense words, so the density guard does not read 30s as music. */
const SPOKEN = "aaj hum log ek nayi recipe banane wale hain dosto";

describe("readLinkVideo", () => {
  it("samples the frames and hears the audio, then deletes the file", async () => {
    stubYtDlp();
    stubFfmpeg();
    stubWhisper(SPOKEN);

    const result = await readLinkVideo(REEL, bounds());

    expect(result.transcript).toBe(SPOKEN);
    expect(result.error).toBeNull();
    expect(result.frames.map((f) => f.path)).toEqual([
      linkFramePath("wa:1203@g.us/ABCD", 0),
      linkFramePath("wa:1203@g.us/ABCD", 1),
      linkFramePath("wa:1203@g.us/ABCD", 2),
    ]);
    // The stills outlive the video; the video does not outlive the read.
    for (const frame of result.frames) expect(existsSync(frame.path)).toBe(true);
    expect(existsSync(downloadDir())).toBe(false);
  });

  it("gives yt-dlp every bound it can enforce before spending bandwidth", async () => {
    stubYtDlp();
    stubFfmpeg();

    // The command line is the whole subject here, so the read is trimmed to the
    // one still that still makes it a download.
    await readLinkVideo(REEL, bounds({ maxHeight: 360, maxFrames: 1, audio: false }));
    const argv = ytdlpArgv();

    expect(argv).toContain("--no-config");
    expect(argv).toContain("--no-playlist");
    expect(argv).toContain("--no-continue");
    expect(argv.some((a) => /cookie/i.test(a))).toBe(false);
    expect(argv[argv.indexOf("--max-filesize") + 1]).toBe(String(MAX_VIDEO_BYTES));
    expect(argv[argv.indexOf("--match-filter") + 1]).toBe(`duration<?${MAX_VIDEO_SEC}`);
    // The height cap is the setting's, not a constant baked in here.
    expect(argv[argv.indexOf("-f") + 1]).toContain("height<=?360");
    // The URL is its own argv element, so no shell ever sees it.
    expect(argv).toContain(REEL);
  });

  it("refuses a video the site says is longer than the cap", async () => {
    stubYtDlp({
      writes: "none",
      says: "[download] Lecture does not pass filter (duration<?600), skipping ..",
    });
    stubFfmpeg();

    const result = await readLinkVideo(REEL, bounds());

    expect(result.error).toBe(`the video runs longer than ${MAX_VIDEO_SEC}s`);
    expect(result.transcript).toBeNull();
    expect(result.frames).toEqual([]);
    expect(existsSync(downloadDir())).toBe(false);
  });

  it("refuses a file over the byte cap even when yt-dlp downloaded it anyway", async () => {
    // A server that reports no length gets past --max-filesize entirely, which
    // is why the size is checked again on disk.
    stubYtDlp({ bytes: MAX_VIDEO_BYTES + 1024 });
    stubFfmpeg();
    stubWhisper(SPOKEN);

    const result = await readLinkVideo(REEL, bounds());

    expect(result.error).toMatch(/over the 64 MB cap/);
    expect(result.transcript).toBeNull();
    expect(existsSync(downloadDir())).toBe(false);
  });

  it("never mistakes a half-downloaded file for a finished one", async () => {
    // `video.mp4.part` is what a killed download leaves; `video.f137.mp4` is a
    // stream yt-dlp had not merged yet. Neither is a video.
    for (const writes of ["video.mp4.part", "video.f137.mp4"] as const) {
      rmSync(calls, { force: true });
      rmSync(argvFile, { force: true });
      stubYtDlp({ writes });
      stubFfmpeg();

      const result = await readLinkVideo(REEL, bounds());
      expect(result.error, writes).toBe("yt-dlp downloaded nothing");
      expect(result.frames, writes).toEqual([]);
    }
  });

  it("deletes the download when yt-dlp itself failed", async () => {
    stubYtDlp({ exit: 1, writes: "none" });
    stubFfmpeg();

    const result = await readLinkVideo(REEL, bounds());

    expect(result.error).toMatch(/yt-dlp exit 1/);
    expect(existsSync(downloadDir())).toBe(false);
  });

  it("does not fetch anything when neither stills nor audio are wanted", async () => {
    stubYtDlp();
    stubFfmpeg();

    const result = await readLinkVideo(REEL, bounds({ frames: false, audio: false }));

    expect(result).toEqual({ transcript: null, frames: [], error: null });
    expect(ran()).toEqual([]);
  });

  it("keeps the stills when the audio said nothing worth believing", async () => {
    stubYtDlp();
    stubFfmpeg();
    // Six seconds of "Thank you." over thirty seconds of clip is what whisper
    // invents from music (v5 §3), and the density guard catches it.
    stubWhisper("Thank you.");

    const result = await readLinkVideo(REEL, bounds());

    expect(result.transcript).toBeNull();
    expect(result.frames).toHaveLength(3);
  });

  it("reads one linked video at a time, whatever the queue asked for", async () => {
    stubYtDlp({ holdMs: 120 });
    stubFfmpeg();
    stubWhisper(SPOKEN);

    await Promise.all([
      readLinkVideo(REEL, bounds({ eventId: "one" })),
      readLinkVideo(REEL, bounds({ eventId: "two" })),
    ]);

    // Whisper is minutes of CPU and the queue runs five link fetches at once
    // (v6 §5), so the two downloads must not interleave.
    expect(ran()).toEqual(["yt-dlp", "yt-dlp-done", "yt-dlp", "yt-dlp-done"]);
  });

  it("says so rather than downloading when a binary was never staged", async () => {
    stubFfmpeg();
    process.env.SUPERTWIN_YTDLP_BIN = join(tmpDir, "absent");
    expect((await readLinkVideo(REEL, bounds())).error).toBe(
      "yt-dlp is not installed with the app",
    );

    stubYtDlp();
    process.env.SUPERTWIN_FFMPEG_BIN = join(tmpDir, "absent");
    expect((await readLinkVideo(REEL, bounds())).error).toBe(
      "ffmpeg is not installed with the app",
    );
    expect(ran()).toEqual([]);
  });
});

describe("linkFramePath", () => {
  it("names a still from the event without putting the event in the name", () => {
    const path = linkFramePath("wa:1203630@g.us/3A17B6D20C20A970AD3F", 2);
    expect(path.startsWith(join(mediaDir, "links"))).toBe(true);
    // A chat JID has an @ and a stanza id has slashes; neither is a filename.
    expect(path).toMatch(/\/[0-9a-f]{16}\.frame2\.jpg$/);
    expect(path).not.toContain("@");
  });

  it("is stable, so a re-scan overwrites its stills instead of orphaning them", () => {
    expect(linkFramePath("wa:x/y", 0)).toBe(linkFramePath("wa:x/y", 0));
    expect(linkFramePath("wa:x/y", 0)).not.toBe(linkFramePath("wa:x/z", 0));
  });

  it("matches the pattern the frame sweep considers", () => {
    // The sweep only ever deletes `*.frame<N>.jpg`; a still it cannot see is a
    // still that never leaves the disk after a revoke (v5 §2).
    mkdirSync(join(mediaDir, "links"), { recursive: true });
    writeFileSync(linkFramePath("wa:x/y", 0), "jpeg");
    expect(readdirSync(join(mediaDir, "links"))[0]).toMatch(/\.frame\d+\.jpg$/);
  });
});
