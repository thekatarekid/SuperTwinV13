// ===========================================================================
// Giving a video something to show for itself (v7 §3).
//
// A thumbnail is only ever written from the protobuf's JPEGThumbnail, and a
// history-synced video usually carries none — 10 of the 18 in the measured
// database. Those rows rendered as a paperclip chip: the mp4 was on disk and
// readable the whole time, and nothing ever pulled a frame out of it.
//
// One frame, taken at the CLIP'S MIDPOINT rather than at its head, for the
// reason v5 §2 already gives about sampling: the first frame of a clip is
// usually the black one it fades in from, and a black poster is the file chip
// with extra steps.
//
// The file is written as `<stem>.poster.jpg`, NOT as the daemon's
// `<stem>.thumb.jpg`. Two different programs writing the same path is how one
// of them overwrites bytes it did not produce, and the suffix is also what
// keeps a poster out of the frame sweep's `*.frame<N>.jpg` pattern.
//
// Whether the poster is KEPT is the database's decision, not this module's:
// recordVideoPoster refuses a row that has since been given a real thumbnail,
// and this module deletes the frame it just wrote when that happens. WhatsApp's
// own still is the sender's choice of frame and outranks our arithmetic.
// ===========================================================================

import { unlinkSync } from "node:fs";

import { recordVideoPoster, type PendingPosterRow } from "../db/ingest.js";
import { sampleFrames } from "./frames.js";

export interface PosterOptions {
  signal?: AbortSignal;
}

export interface PosterResult {
  /** The stored poster path, or null when there is none to store. */
  path: string | null;
  /** Why there is none, or why the one we made was thrown away. */
  error: string | null;
}

/** Where a video's generated poster lives: beside the video, per v7 §3. */
export function posterPath(mediaPath: string): string {
  const dot = mediaPath.lastIndexOf(".");
  const slash = mediaPath.lastIndexOf("/");
  const stem = dot > slash ? mediaPath.slice(0, dot) : mediaPath;
  return `${stem}.poster.jpg`;
}

/**
 * Sample one frame out of a queued video and record it as the row's thumbnail.
 * Never throws: a missing ffmpeg, a file that vanished and a decode that failed
 * all come back as an error string, and the caller stops asking about that row
 * rather than spinning on it — the queue has no status column to write the
 * failure to.
 */
export async function generateVideoPoster(
  row: PendingPosterRow,
  opts: PosterOptions = {},
): Promise<PosterResult> {
  if (!row.mediaPath) return { path: null, error: "the event carries no file" };
  const out = posterPath(row.mediaPath);

  // maxFrames 1 is what puts the single offset at the midpoint; the interval
  // then has nothing left to decide, so it is not read from Settings.
  const sampled = await sampleFrames(row.mediaPath, {
    intervalSec: 1,
    maxFrames: 1,
    fallbackSec: row.seconds,
    frameFor: () => out,
    signal: opts.signal,
  });
  const frame = sampled.frames[0];
  if (!frame) return { path: null, error: sampled.error ?? "no frame was written" };

  if (!recordVideoPoster(row.id, frame.path)) {
    // Someone got there first, so these bytes are referenced by nothing.
    discard(frame.path);
    return { path: null, error: "the row already had a thumbnail" };
  }
  return { path: frame.path, error: null };
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Never written, or already gone — either way there is nothing to clean up.
  }
}
