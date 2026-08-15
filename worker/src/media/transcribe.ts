// ===========================================================================
// Transcribing audio with the bundled whisper.cpp (v5 §3).
//
// ffmpeg → 16 kHz mono WAV → whisper-cli → text. Nothing leaves the machine and
// nothing costs a token; what it costs is wall clock, which is why the queue
// runs it behind every model call rather than beside them.
//
// LANGUAGE IS AUTO-DETECTED, and that is a flag we must pass: whisper-cli's
// `-l` defaults to `en`, so an invocation that says nothing about language is
// an invocation that forces English. These chats are Hindi, Marathi, English
// and code-switched Hinglish — forced English would silently transliterate or
// mangle most of them, which reads as a working transcript and is not one.
//
// WHISPER HALLUCINATES. On silence and on music it emits fluent, confident,
// entirely invented text; the bundled model answers six seconds of digital
// silence — and thirty seconds of a tone, and thirty seconds of pink noise —
// with "Thank you." Measured here, not supposed. Three defences, in order:
//
//   1. Before whisper runs at all, ffmpeg's own volumedetect says how loud the
//      chunk actually was. Nothing above -50 dB anywhere in it means there is
//      no audible content to transcribe, so there is nothing to invent from.
//      (Measured: digital silence -91 dB; ordinary speech peaks near -2 dB.)
//   2. After it runs, the text is checked for the shapes hallucination takes —
//      empty, only silence markers, one phrase repeated, an n-gram loop.
//   3. And for how little of it there is: a long recording that produced a
//      handful of words did not have speech in it. This is the one that catches
//      music, where the answer is short and fluent rather than looping.
//
// Every verdict records 'unsupported' with the reason and NO transcript. A
// sentence nobody said is worse than a missing one: it is indistinguishable
// from a real one in search and in the grounded-chat context block.
//
// What none of this catches is a SHORT clip of music answered with a short
// plausible sentence. There is no structural difference between that and
// somebody saying two words, and a blocklist of whisper's favourite phrases
// would throw away the same two words when they were really said.
//
// Long audio is chunked so a failure costs one chunk instead of the file. What
// survives is stored WITH status 'error' and "partial: N of M chunks" — the
// lifecycle has no 'partial' of its own, and 'done' would pass an incomplete
// transcript off as the whole thing.
//
// Every child is spawned with an argv ARRAY. The media path came from whoever
// sent the message.
// ===========================================================================

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PendingTranscriptRow, TranscriptStatus } from "../db/ingest.js";
import { getMediaWhisperModel } from "../store/store.js";
import { probeDuration } from "./frames.js";
import { resolveFfmpegBin, resolveWhisperBin, resolveWhisperModel, run } from "./tools.js";

/**
 * Seconds of audio per whisper invocation. The unit exists so a failure or a
 * kill costs one chunk rather than an hour-long file; whisper itself has no
 * trouble with a long one.
 */
export const CHUNK_SEC = 300;

/**
 * Peak level below which a chunk holds nothing audible. Digital silence
 * measures -91 dB and speech peaks near -2 dB, so -50 dB is far below anything
 * a microphone produces and far above the floor.
 */
export const SILENCE_MAX_DB = -50;

/** Decoding 5 minutes of audio out of a container. */
const DECODE_TIMEOUT_MS = 120_000;

/**
 * One chunk through whisper. Generous: the first call also loads a 574 MB model,
 * and a cold read off disk is slower than every call after it.
 */
const WHISPER_TIMEOUT_MS = 900_000;

/** Cap on a stored transcript, mirroring MAX_DESCRIPTION_CHARS' reasoning. */
export const MAX_TRANSCRIPT_CHARS = 20_000;

/**
 * Recordings shorter than this are not judged on how much was said in them: a
 * three-word voice note is a normal thing to send.
 */
export const MIN_DENSITY_SEC = 20;

/**
 * Below this, a recording did not contain speech. Conversation runs at two to
 * three words a second; ordinary sparse speech still clears a word every few
 * seconds. One word per ten is an order of magnitude under anything a person
 * produces, and is what thirty seconds of music scores.
 */
export const MIN_WORDS_PER_10_SEC = 1;

/** The outcome of one transcription attempt, as `recordTranscript` wants it. */
export interface TranscribeResult {
  transcript: string | null;
  status: TranscriptStatus;
  /** The whisper model id, e.g. "large-v3-turbo-q5_0". */
  model: string;
  error: string | null;
}

export interface TranscribeOptions {
  signal?: AbortSignal;
  /** Override the chunk length. Tests use it to force the chunked path. */
  chunkSec?: number;
}

/** ffmpeg's volumedetect line, or null when it did not report one. */
export function parseMaxVolumeDb(stderr: string): number | null {
  const m = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr);
  if (!m) return null;
  const db = Number(m[1]);
  return Number.isFinite(db) ? db : null;
}

/**
 * Why this text cannot be believed, or null when it can. Structural only: it
 * asks whether the text has the SHAPE of a hallucination, never whether a
 * particular sentence is one, because "Thank you." is both the model's
 * favourite invention and a real thing people say.
 */
export function degenerateReason(raw: string): string | null {
  const speech = stripNonSpeech(raw);
  if (!speech) {
    return raw.trim()
      ? "only non-speech markers"
      : "whisper returned no text";
  }

  const segments = speech
    .split(/[.!?।\n]+/)
    .map(normalize)
    .filter((s) => s.length > 0);
  if (segments.length >= 3) {
    const distinct = new Set(segments).size;
    if (distinct === 1) {
      return `the same phrase repeated ${segments.length} times`;
    }
    if (segments.length >= 4 && distinct / segments.length <= 1 / 3) {
      return `${distinct} distinct phrases in ${segments.length} — a loop`;
    }
  }

  const words = normalize(speech).split(" ").filter(Boolean);
  if (words.length >= 8) {
    const distinct = new Set(words).size;
    if (distinct <= 2) {
      return `only ${distinct} distinct word${distinct === 1 ? "" : "s"} in ${words.length}`;
    }
  }
  // Real speech reuses phrases but not four-word runs: a natural transcript
  // scores well above 0.9 here, a looping one scores about 1/period.
  if (words.length >= 20) {
    const grams: string[] = [];
    for (let i = 0; i + 4 <= words.length; i++) {
      grams.push(words.slice(i, i + 4).join(" "));
    }
    const ratio = new Set(grams).size / grams.length;
    if (ratio < 0.5) {
      return `${Math.round(ratio * 100)}% distinct 4-grams — a repeating loop`;
    }
  }
  return null;
}

/**
 * Why this much text cannot be a transcript of this much audio, or null. The
 * shape music produces: a short, fluent, entirely plausible sentence standing
 * in for half a minute of nothing being said. It has no structure to catch, so
 * what catches it is the arithmetic.
 *
 * Only applied when the length is known and worth judging. A recording that
 * fails this is recorded 'unsupported' with the numbers in the reason, so a
 * genuinely sparse note that was thrown away says on the row why it was.
 */
export function sparseReason(
  raw: string,
  durationSec: number | null,
): string | null {
  if (!durationSec || durationSec < MIN_DENSITY_SEC) return null;
  const words = normalize(stripNonSpeech(raw)).split(" ").filter(Boolean).length;
  if (words * (10 / MIN_WORDS_PER_10_SEC) >= durationSec) return null;
  return `only ${words} word${words === 1 ? "" : "s"} in ${Math.round(durationSec)}s of audio`;
}

/**
 * What whisper writes when it hears no words: `[BLANK_AUDIO]`, `[MUSIC]`,
 * `(upbeat music)`, `*laughs*`. Stripped for the VERDICT only — the transcript
 * that gets stored is the model's own, untouched.
 */
function stripNonSpeech(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\*[^*]*\*/g, " ")
    .trim();
}

/** Case, punctuation and spacing are not what makes two phrases different. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Chunk {
  startSec: number;
  durationSec: number | null;
}

/**
 * Transcribe one queued audio or video row. Never throws — a missing binary, a
 * missing model, a file that vanished and a child that died all come back as a
 * status the queue can record.
 */
export async function transcribeMedia(
  row: PendingTranscriptRow,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const model = getMediaWhisperModel();
  const fail = (error: string, status: TranscriptStatus = "error"): TranscribeResult => ({
    transcript: null,
    status,
    model,
    error,
  });

  if (!row.mediaPath) return fail("the event carries no file", "unsupported");
  if (!existsSync(row.mediaPath)) {
    return fail(`file not found: ${row.mediaPath}`, "skipped");
  }
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg) return fail("ffmpeg is not installed with the app");
  const whisper = resolveWhisperBin();
  if (!whisper) return fail("whisper-cli is not installed with the app");
  const modelPath = resolveWhisperModel(model);
  if (!modelPath) {
    return fail(`the whisper model "${model}" is not on this machine`);
  }

  const duration = await probeDuration(ffmpeg, row.mediaPath, opts.signal);
  const chunks = planChunks(duration, opts.chunkSec ?? CHUNK_SEC);

  const dir = await mkdtemp(join(tmpdir(), "supertwin-whisper-"));
  try {
    const parts: string[] = [];
    const failures: string[] = [];
    let silent = 0;
    let noAudio = false;
    // Seconds of audible audio that actually reached whisper. A chunk that was
    // silent, or that never decoded, is not audio this transcript failed to
    // account for, so it must not count against the density check below.
    let heardSec = 0;

    for (let i = 0; i < chunks.length; i++) {
      if (opts.signal?.aborted) return fail("aborted");
      const wav = join(dir, `chunk${i}.wav`);
      const decoded = await decodeChunk(ffmpeg, row.mediaPath, chunks[i], wav, opts.signal);
      if (decoded.noAudio) {
        noAudio = true;
        break;
      }
      if (decoded.error) {
        failures.push(decoded.error);
        continue;
      }
      // Nothing audible in it: whisper would answer anyway, and its answer
      // would be an invention (v5 §3).
      if (decoded.maxDb !== null && decoded.maxDb <= SILENCE_MAX_DB) {
        silent++;
        continue;
      }
      try {
        const text = await runWhisper(whisper, modelPath, wav, opts.signal);
        heardSec += chunks[i].durationSec ?? duration ?? 0;
        if (text) parts.push(text);
      } catch (err) {
        failures.push((err as Error).message);
      }
    }

    if (noAudio) {
      return fail(
        row.kind === "video" ? "the video has no audio track" : "the file has no audio",
        "unsupported",
      );
    }
    if (failures.length > 0 && parts.length === 0) {
      return fail(failures[0]);
    }
    if (parts.length === 0) {
      return fail(
        silent > 0 ? "the audio is silent" : "whisper returned no text",
        "unsupported",
      );
    }

    const transcript = parts.join(" ").replace(/\s+/g, " ").trim();
    const degenerate =
      degenerateReason(transcript) ?? sparseReason(transcript, heardSec || null);
    if (degenerate) return fail(degenerate, "unsupported");

    const clipped =
      transcript.length <= MAX_TRANSCRIPT_CHARS
        ? transcript
        : `${transcript.slice(0, MAX_TRANSCRIPT_CHARS - 1).trimEnd()}…`;

    // Some of the file did not make it. Say so on the row rather than letting
    // what survived read as the whole recording.
    if (failures.length > 0) {
      return {
        transcript: clipped,
        status: "error",
        model,
        error: `partial: ${parts.length} of ${chunks.length} chunks (${failures[0]})`,
      };
    }
    return { transcript: clipped, status: "done", model, error: null };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One chunk when the file is short or its length is unknown; N when it is long. */
export function planChunks(
  durationSec: number | null,
  chunkSec: number,
): Chunk[] {
  const size = Math.max(1, Math.floor(chunkSec));
  if (!durationSec || durationSec <= size) return [{ startSec: 0, durationSec: null }];
  const count = Math.ceil(durationSec / size);
  return Array.from({ length: count }, (_, i) => ({
    startSec: i * size,
    durationSec: size,
  }));
}

interface DecodedChunk {
  error: string | null;
  /** The chunk's peak level, or null when ffmpeg did not report one. */
  maxDb: number | null;
  /** The input has no audio stream at all — no later chunk will either. */
  noAudio: boolean;
}

/**
 * Decode one chunk to the 16 kHz mono WAV whisper wants, measuring its peak
 * level on the same pass. `-ss` sits before `-i` so the seek jumps rather than
 * decoding up to the offset.
 */
async function decodeChunk(
  ffmpeg: string,
  path: string,
  chunk: Chunk,
  out: string,
  signal?: AbortSignal,
): Promise<DecodedChunk> {
  const args = ["-hide_banner", "-nostdin", "-y"];
  if (chunk.startSec > 0) args.push("-ss", String(chunk.startSec));
  args.push("-i", path);
  if (chunk.durationSec !== null) args.push("-t", String(chunk.durationSec));
  args.push(
    "-vn",
    "-af",
    "volumedetect",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    out,
  );

  try {
    const result = await run(ffmpeg, args, {
      timeoutMs: DECODE_TIMEOUT_MS,
      signal,
    });
    if (result.code !== 0) {
      // ffmpeg's way of saying the input had nothing to encode.
      if (/does not contain any stream/i.test(result.stderr)) {
        return { error: null, maxDb: null, noAudio: true };
      }
      return {
        error: `ffmpeg exit ${result.code}: ${lastLine(result.stderr)}`,
        maxDb: null,
        noAudio: false,
      };
    }
    return {
      error: null,
      maxDb: parseMaxVolumeDb(result.stderr),
      noAudio: false,
    };
  } catch (err) {
    return { error: (err as Error).message, maxDb: null, noAudio: false };
  }
}

/**
 * One whisper invocation. `-l auto` is the whole point (the flag defaults to
 * `en`); `-nt` drops timestamps and `-np` drops everything that is not the
 * transcript, so stdout IS the text.
 */
async function runWhisper(
  whisper: string,
  modelPath: string,
  wav: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await run(
    whisper,
    ["-m", modelPath, "-f", wav, "-l", "auto", "-nt", "-np"],
    { timeoutMs: WHISPER_TIMEOUT_MS, signal },
  );
  if (result.code !== 0) {
    throw new Error(`whisper-cli exit ${result.code}: ${lastLine(result.stderr)}`);
  }
  return result.stdout.replace(/\s+/g, " ").trim();
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
