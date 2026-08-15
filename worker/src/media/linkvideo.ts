// ===========================================================================
// Reading the video a link points at (v7 §4).
//
// Measured with the bundled binaries, not supposed: a public Instagram reel
// downloads in 0.3s / 2.5 MB with no cookies at all, and ffmpeg gets both a
// still and 16 kHz mono audio out of it. yt-dlp itself extracts no frames — it
// fetches caption tracks and files, and everything visual comes from ffmpeg.
//
// The file is a MEANS, never a result. It is downloaded to a temp directory at
// a capped resolution, sampled, listened to, and deleted in a `finally` — on
// success, on failure, on timeout and on shutdown. Nothing under the media root
// is ever a copy of someone else's video: what survives is stills and text.
//
// The stills DO live under the media root, because they outlive the download
// and events.media_frames_json is the only record that they exist — the same
// mark-and-sweep contract v5 §2 gives an attachment's frames. They are named
// from a hash of the event id: an id contains a chat JID and a stanza id, and
// neither is a filename.
//
// ONE AT A TIME, process-wide. The queue may have five link fetches open at
// once (v6 §5); whisper is minutes of CPU and v5 §5 is explicit that one is all
// a Mac has to give it. Downloads are bounded in bytes, in clip length and in
// wall clock, and the URL handed to yt-dlp is one the caller rebuilt from a
// recognised id — never the string that arrived in the message.
// ===========================================================================

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { MediaFrame } from "../db/ingest.js";
import { mediaRoot } from "./describe.js";
import { sampleFrames } from "./frames.js";
import { resolveFfmpegBin, resolveYtDlpBin, run } from "./tools.js";
import { transcribeMedia } from "./transcribe.js";

/** Bytes one linked video may cost. A reel is ~2.5 MB; a lecture is not this. */
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

/**
 * Seconds of clip worth fetching. Past this the download is no longer the
 * expensive part — whisper is, and the reader would hold a slot for minutes
 * over a video nobody in the chat watched to the end either.
 */
export const MAX_VIDEO_SEC = 600;

/** The download alone, including yt-dlp unpacking ~38 MB of itself first. */
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** Everything below is only allowed to name files this way. */
const OUTPUT_STEM = "video";

/**
 * yt-dlp's own output file, as opposed to the `video.f137.mp4` half-streams it
 * merges and the `video.mp4.part` it writes while downloading. Both have a
 * second dot, so the shape is the test: a partial must never be mistaken for
 * the finished file.
 */
const COMPLETED = new RegExp(`^${OUTPUT_STEM}\\.[A-Za-z0-9]+$`);

export interface LinkVideoBounds {
  /** `media.video_frames_enabled` — sample stills out of the file. */
  frames: boolean;
  /** `media.video_frame_interval_sec`. */
  intervalSec: number;
  /** `media.video_frame_max`. */
  maxFrames: number;
  /** `media.video_audio_enabled` — run whisper over the audio track. */
  audio: boolean;
  /** `media.video_max_height` — the tallest published format worth fetching. */
  maxHeight: number;
  /** The event the stills are named after. Without one, none are kept. */
  eventId?: string;
}

export interface LinkVideoRead {
  /** What was said in it, or null when nothing could be heard or fetched. */
  transcript: string | null;
  /** Stills under the media root, in clip order. */
  frames: MediaFrame[];
  /** What we could not also get. Never a reason to fail the page read. */
  error: string | null;
}

/** Where still N of a linked video lives. Hashed: an event id is not a name. */
export function linkFramePath(eventId: string, index: number): string {
  const stem = createHash("sha1").update(eventId).digest("hex").slice(0, 16);
  return join(mediaRoot(), "links", `${stem}.frame${index}.jpg`);
}

/**
 * One linked video at a time, whatever else the queue is doing. The chain is
 * the whole mechanism: each caller waits on the previous one however it
 * settled, so a failure never wedges the ones behind it.
 */
let inFlight: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = inFlight.then(work, work);
  inFlight = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Download `url`, take stills off it and listen to it, then delete it. Never
 * throws: a missing binary, a video too long to be worth it and a whisper run
 * that heard only music all come back as an error string beside whatever else
 * did land.
 *
 * `url` must be one the caller rebuilt from an id it recognised. Nothing here
 * re-validates it, because there is nothing left to validate against.
 */
export async function readLinkVideo(
  url: string,
  bounds: LinkVideoBounds,
  signal?: AbortSignal,
): Promise<LinkVideoRead> {
  const wantFrames = bounds.frames && Boolean(bounds.eventId);
  if (!wantFrames && !bounds.audio) {
    return { transcript: null, frames: [], error: null };
  }
  const ytdlp = resolveYtDlpBin();
  if (!ytdlp) {
    return { transcript: null, frames: [], error: "yt-dlp is not installed with the app" };
  }
  // Both halves of the work are ffmpeg's; there is no point paying for the
  // download when neither the stills nor the audio could be read out of it.
  if (!resolveFfmpegBin()) {
    return { transcript: null, frames: [], error: "ffmpeg is not installed with the app" };
  }

  return serialize(async () => {
    if (signal?.aborted) {
      return { transcript: null, frames: [], error: "aborted" };
    }
    const dir = await mkdtemp(join(tmpdir(), "supertwin-linkvideo-"));
    try {
      const got = await download(ytdlp, url, bounds.maxHeight, dir, signal);
      if (!got.path) return { transcript: null, frames: [], error: got.error };

      const frames = wantFrames
        ? await stills(got.path, bounds.eventId as string, bounds, signal)
        : { frames: [] as MediaFrame[], error: null as string | null };
      const heard = bounds.audio ? await listen(got.path, signal) : null;

      return {
        transcript: heard?.text ?? null,
        frames: frames.frames,
        error: frames.error ?? heard?.error ?? null,
      };
    } catch (err) {
      return { transcript: null, frames: [], error: (err as Error).message };
    } finally {
      // The file goes with the directory, whatever happened above — including a
      // `.part` that a killed download left looking almost complete.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

interface Downloaded {
  path: string | null;
  error: string | null;
}

/**
 * Fetch the smallest published rendition no taller than `maxHeight`, or the
 * site's own worst when it publishes nothing that low. Every bound yt-dlp can
 * enforce before spending bandwidth is given to it, and the size is checked
 * again afterwards because a server that reports no length gets past
 * `--max-filesize` entirely.
 */
async function download(
  ytdlp: string,
  url: string,
  maxHeight: number,
  dir: string,
  signal?: AbortSignal,
): Promise<Downloaded> {
  const args = [
    // A yt-dlp.conf on this machine must not add cookies, a proxy or a
    // post-processor to a request made on someone else's behalf.
    "--no-config",
    "--no-cache-dir",
    "--no-playlist",
    "--no-progress",
    "--no-warnings",
    // The directory is new every time, so there is nothing to resume — and a
    // resumed `.part` is exactly the partial that must never look complete.
    "--no-continue",
    "--retries",
    "1",
    "--socket-timeout",
    "15",
    "--max-filesize",
    String(MAX_VIDEO_BYTES),
    // `<?` keeps a video whose length the site did not publish; the byte cap
    // and the timeout are still there for it.
    "--match-filter",
    `duration<?${MAX_VIDEO_SEC}`,
    "-f",
    `bv*[height<=?${maxHeight}]+ba/b[height<=?${maxHeight}]/w`,
    "--merge-output-format",
    "mp4",
    "--ffmpeg-location",
    resolveFfmpegBin() as string,
    "-o",
    join(dir, `${OUTPUT_STEM}.%(ext)s`),
    url,
  ];

  let result;
  try {
    result = await run(ytdlp, args, { timeoutMs: DOWNLOAD_TIMEOUT_MS, signal });
  } catch (err) {
    return { path: null, error: (err as Error).message };
  }

  const said = `${result.stdout}\n${result.stderr}`;
  if (/does not pass filter/i.test(said)) {
    return { path: null, error: `the video runs longer than ${MAX_VIDEO_SEC}s` };
  }
  if (/larger than max-filesize/i.test(said)) {
    return { path: null, error: `the video is larger than ${megabytes(MAX_VIDEO_BYTES)}` };
  }
  if (result.code !== 0) {
    return { path: null, error: `yt-dlp exit ${result.code}: ${lastLine(result.stderr)}` };
  }

  const file = completedFile(dir);
  if (!file) return { path: null, error: "yt-dlp downloaded nothing" };
  let size: number;
  try {
    size = statSync(file).size;
  } catch (err) {
    return { path: null, error: (err as Error).message };
  }
  if (size > MAX_VIDEO_BYTES) {
    return {
      path: null,
      error: `the video is ${megabytes(size)}, over the ${megabytes(MAX_VIDEO_BYTES)} cap`,
    };
  }
  return { path: file, error: null };
}

/** The finished download in `dir`, or null when only fragments are there. */
function completedFile(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!COMPLETED.test(name)) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // raced with the cleanup — there is nothing here to read
    }
  }
  return null;
}

/** Stills across the clip, written under the media root so they outlive it. */
async function stills(
  path: string,
  eventId: string,
  bounds: LinkVideoBounds,
  signal?: AbortSignal,
): Promise<{ frames: MediaFrame[]; error: string | null }> {
  const frameFor = (index: number): string => linkFramePath(eventId, index);
  try {
    mkdirSync(dirname(frameFor(0)), { recursive: true });
  } catch (err) {
    return { frames: [], error: (err as Error).message };
  }
  const sampled = await sampleFrames(path, {
    intervalSec: bounds.intervalSec,
    maxFrames: bounds.maxFrames,
    frameFor,
    signal,
  });
  return { frames: sampled.frames, error: sampled.error };
}

/**
 * What is said in the clip, through the same whisper path an attachment takes —
 * so the silence, hallucination and density guards of v5 §3 cover a linked
 * video too. Only a COMPLETE transcript is used: a partial would be folded into
 * the page text with nothing to mark where it stopped, and the auto-caption
 * fallback behind it is a better answer than half a good one.
 */
async function listen(
  path: string,
  signal?: AbortSignal,
): Promise<{ text: string | null; error: string | null }> {
  const result = await transcribeMedia(
    {
      id: `linkvideo:${path}`,
      kind: "video",
      mediaPath: path,
      mime: null,
      filename: null,
      seconds: null,
      voice: false,
    },
    { signal },
  );
  if (result.status === "done" && result.transcript) {
    return { text: result.transcript, error: null };
  }
  return { text: null, error: result.error };
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** The last non-empty line of a child's stderr — the part that says why. */
function lastLine(stderr: string): string {
  const lines = stderr.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line.slice(0, 300);
  }
  return "no output";
}
