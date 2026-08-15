// ===========================================================================
// Sampling frames out of a video (v5 §2).
//
// The offsets are spread over the WHOLE clip, not taken from its head: one
// frame per media.video_frame_interval_sec decides how many, and
// media.video_frame_max caps them, but a 10 minute video yields 8 frames from
// across the ten minutes rather than 8 from its first 40 seconds. Each is taken
// at the midpoint of its share of the clip, so the first is not the black frame
// every video starts on and the last is not past the end.
//
// Frames are downscaled on the way out. A 1920×1080 still costs several times
// the tokens of a 768-wide one and tells the reader nothing more about who is
// in it or what the sign says.
//
// Duration comes from probing the file, not from events.media_seconds: v4 §3
// found that column holding the duration of a video that never downloaded, and
// a wrong duration puts every offset in the wrong place. media_seconds is the
// fallback for when the probe cannot answer.
//
// Cleanup is mark-and-sweep, not delete-on-revoke: events.media_frames_json is
// the only record these files exist, so clearing it (on revoke, or on a
// 'frames' rescan) unreferences them and this module deletes what the DB no
// longer points at. The sweep only ever considers files matching the frame
// naming pattern, so it cannot reach an actual attachment.
// ===========================================================================

import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { MediaFrame, PendingMediaRow } from "../db/ingest.js";
import { mediaRoot } from "./describe.js";
import { resolveFfmpegBin, run } from "./tools.js";

/** Longest edge of a stored frame. Downscale only — a small clip is left alone. */
export const FRAME_MAX_EDGE = 768;

/** JPEG quality (ffmpeg -q:v, 2 best … 31 worst). 5 is visually clean at ~15 KB. */
const FRAME_QUALITY = 5;

/** Reading a container header. Generous, because the file may be cold. */
const PROBE_TIMEOUT_MS = 15_000;

/** One seek plus one decoded frame. */
const FRAME_TIMEOUT_MS = 30_000;

/** `<msgID>.frame<N>.jpg`, and the pattern the sweep will consider deleting. */
const FRAME_SUFFIX = /\.frame\d+\.jpg$/;

export interface SampleOptions {
  intervalSec: number;
  maxFrames: number;
  signal?: AbortSignal;
}

export interface FrameSourceOptions extends SampleOptions {
  /**
   * Where frame N goes. Defaults to beside the video. A linked video (v7 §4) is
   * downloaded to a temp directory and deleted minutes later, so its stills
   * cannot live beside it and are named by the caller instead.
   */
  frameFor?: (index: number) => string;
  /** Used when ffmpeg will not say how long the clip is. */
  fallbackSec?: number | null;
}

export interface SampleResult {
  /** In clip order. Empty when nothing could be sampled. */
  frames: MediaFrame[];
  /** Why there are fewer frames than asked for, or none at all. */
  error: string | null;
}

/** Where frame N of a video lives: beside the video, per v5 §2. */
export function framePath(mediaPath: string, index: number): string {
  const dot = mediaPath.lastIndexOf(".");
  const slash = mediaPath.lastIndexOf("/");
  const stem = dot > slash ? mediaPath.slice(0, dot) : mediaPath;
  return `${stem}.frame${index}.jpg`;
}

/**
 * The offsets to sample, in seconds. One per `intervalSec` of clip, at least
 * one, never more than `maxFrames`, each at the midpoint of its own share of
 * the clip so the set spans the whole thing evenly.
 */
export function frameOffsets(
  durationSec: number,
  intervalSec: number,
  maxFrames: number,
): number[] {
  const max = Math.max(1, Math.floor(maxFrames));
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
  const interval = Math.max(1, Math.floor(intervalSec));
  const count = Math.min(max, Math.max(1, Math.floor(durationSec / interval)));
  return Array.from({ length: count }, (_, i) =>
    round2((durationSec * (i + 0.5)) / count),
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * `HH:MM:SS.ss` out of ffmpeg's own report. ffmpeg with no output file exits
 * non-zero after printing the header it did read, which is exactly the cheap
 * probe we want and why the exit code is ignored here.
 */
export function parseDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** The clip's real length, or null when ffmpeg would not say. Never throws. */
export async function probeDuration(
  ffmpeg: string,
  path: string,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const out = await run(ffmpeg, ["-hide_banner", "-nostdin", "-i", path], {
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
    });
    return parseDuration(out.stderr);
  } catch {
    return null;
  }
}

/**
 * Sample a video into frames on disk. Never throws: a missing ffmpeg, an
 * unreadable file or a seek past a corrupt keyframe all come back as an error
 * string with whatever frames did land, and the caller falls back to the single
 * thumbnail rather than losing the read entirely.
 */
export async function sampleVideoFrames(
  row: PendingMediaRow,
  opts: SampleOptions,
): Promise<SampleResult> {
  if (!row.mediaPath) {
    return { frames: [], error: "the event carries no file" };
  }
  return sampleFrames(row.mediaPath, { ...opts, fallbackSec: row.seconds });
}

/**
 * The same sampling, over any file on disk and writing wherever asked. This is
 * where the "never throws" above is actually kept.
 */
export async function sampleFrames(
  videoPath: string,
  opts: FrameSourceOptions,
): Promise<SampleResult> {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg) {
    return { frames: [], error: "ffmpeg is not installed with the app" };
  }
  const frameFor = opts.frameFor ?? ((i: number) => framePath(videoPath, i));

  const probed = await probeDuration(ffmpeg, videoPath, opts.signal);
  const fallback = opts.fallbackSec;
  const duration = probed ?? (fallback && fallback > 0 ? fallback : 0);
  const offsets = frameOffsets(duration, opts.intervalSec, opts.maxFrames);

  const frames: MediaFrame[] = [];
  const failures: string[] = [];
  for (let i = 0; i < offsets.length; i++) {
    if (opts.signal?.aborted) break;
    const out = frameFor(i);
    try {
      const result = await run(
        ffmpeg,
        [
          "-hide_banner",
          "-nostdin",
          "-y",
          // Seeking BEFORE -i seeks the input, which jumps rather than decoding
          // up to the offset — the difference between instant and minutes on a
          // long clip.
          "-ss",
          String(offsets[i]),
          "-i",
          videoPath,
          "-frames:v",
          "1",
          "-vf",
          `scale='min(${FRAME_MAX_EDGE},iw)':'min(${FRAME_MAX_EDGE},ih)':force_original_aspect_ratio=decrease`,
          "-q:v",
          String(FRAME_QUALITY),
          "-f",
          "image2",
          "-update",
          "1",
          out,
        ],
        { timeoutMs: FRAME_TIMEOUT_MS, signal: opts.signal },
      );
      if (result.code === 0) frames.push({ path: out, seconds: offsets[i] });
      else failures.push(`${offsets[i]}s: ffmpeg exit ${result.code}`);
    } catch (err) {
      failures.push(`${offsets[i]}s: ${(err as Error).message}`);
    }
  }

  if (frames.length === 0) {
    return {
      frames,
      error: failures.length
        ? `no frame could be sampled (${failures[0]})`
        : "no frame could be sampled",
    };
  }
  return {
    frames,
    error: failures.length
      ? `${frames.length} of ${offsets.length} frames sampled (${failures[0]})`
      : null,
  };
}

/**
 * Delete every frame file under the media root that `referenced` does not
 * name. Returns how many went. Best-effort per file — a frame that cannot be
 * deleted is left for the next sweep rather than aborting the rest.
 *
 * Synchronous on purpose. It runs at most every few minutes and only when the
 * queue has nothing else to do, and the alternative — filesystem promises
 * resolving somewhere inside a work cycle — would let a sweep interleave with
 * the sampling that is writing the very files it decides are unreferenced.
 */
export function sweepOrphanFrames(referenced: Iterable<string>): number {
  const keep = new Set(referenced);
  let removed = 0;
  for (const path of listFrameFiles(mediaRoot())) {
    if (keep.has(path)) continue;
    try {
      unlinkSync(path);
      removed++;
    } catch {
      // gone already, or not ours to delete — the next sweep will see it
    }
  }
  return removed;
}

/** Every `*.frame<N>.jpg` under `dir`, recursively. Missing dir means none. */
function listFrameFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFrameFiles(path));
    else if (entry.isFile() && FRAME_SUFFIX.test(entry.name)) out.push(path);
  }
  return out;
}
