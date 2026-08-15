// ===========================================================================
// Reading one attachment (docs/rich-media-spec.md §8).
//
// The Claude CLI adapter is text-only — there is no attachment or base64 path.
// The way to make the model look at a file is to spawn the CLI with the Read
// tool whitelisted and put the absolute path in the prompt; Read opens images
// and PDFs natively. Same shape grounded chat already uses, with a much tighter
// whitelist (Read only) and cwd pinned to the media root.
//
// What we can and cannot read is fixed by the spec's strategy table: a video is
// one JPEG frame — or, with media.video_frames_enabled on, the frames v5 §2
// sampled across it, handed in through DescribeOptions.frames and read as one
// sequence — audio belongs to the transcriber and not here, and a docx/xlsx/zip
// is only recorded by name. Those come back as `unsupported` with NO
// description — an invented one would be indistinguishable from a real one in
// search.
//
// Images ride together, many to a call, because nearly all of a call's cost is
// the CLI's own fixed preamble. That only works if each description can be tied
// back to the exact file it is about, so the answer is keyed by path — exactly,
// or by a trailing segment when the model answers with a basename — and a block
// that still cannot be matched is thrown away rather than lined up by position.
// ===========================================================================

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { MediaDescStatus, MediaFrame, PendingMediaRow } from "../db/ingest.js";
import { DEFAULT_PROVIDER_ID, get as getProvider } from "../providers/index.js";
import type { Provider, Usage } from "../providers/index.js";
import { getSelectedModel } from "../store/store.js";

/** Only Read. No Grep/Glob/Bash — the reader opens exactly the named files. */
export const MEDIA_ALLOWED_TOOLS = ["Read"] as const;

/** One Read plus the answer, with slack for a retried Read. */
const MEDIA_MAX_TURNS = 4;

/**
 * Images per CLI call when Settings says nothing. Most of a read is the CLI's
 * own system prompt and tool schemas — a floor paid once per invocation, not
 * per image: one image measured 36,394 tokens, eight 45,746, twenty 64,593, so
 * the marginal image is ~1,570 tokens and a fuller call is cheaper per image.
 */
export const DEFAULT_IMAGE_BATCH = 20;

/**
 * The most a configured batch may ask for. Twenty is where the measurement
 * stops; past it each extra image is a guess, and a guess that overruns the
 * answer costs the whole call rather than one image.
 */
export const MAX_IMAGE_BATCH = 40;

const DESCRIBE_TIMEOUT_MS = 120_000;

/**
 * A batch reads N files before it answers, so it gets N files' worth of time —
 * up to this, which has to clear a full batch or the call is spent for nothing.
 */
const MAX_BATCH_TIMEOUT_MS = 900_000;

/**
 * Hard cap on a stored description. Long enough for a dense paragraph plus a
 * transcribed sign or invoice, short enough that a runaway answer cannot bloat
 * the FTS index or the grounded-chat context block.
 */
export const MAX_DESCRIPTION_CHARS = 2000;

/** pdf / txt / md / csv / json are read directly; everything else is not. */
const READABLE_DOC_EXTS = new Set(["pdf", "txt", "md", "csv", "json"]);

/**
 * What the reader will open and how the prompt frames it, or why there is
 * nothing to open. `frame` is a video's single JPEG thumbnail.
 */
export type MediaStrategy =
  | { kind: "image" | "frame" | "document"; path: string }
  | { kind: "unsupported"; reason: string };

/** The outcome of one reading attempt, as `recordMediaDescription` wants it. */
export interface DescribeResult {
  description: string | null;
  status: MediaDescStatus;
  model: string;
  error: string | null;
  usage?: Usage;
  /** Prompt size for the run log. Absent when no call was made. */
  promptChars?: number;
}

/** The outcome of one multi-image call. */
export interface DescribeBatchResult {
  /**
   * Verdict per row id. A row the answer never named is ABSENT rather than
   * carrying a description: with one block missing, every later block belongs
   * to a different image than the order suggests, and a caption filed against
   * the wrong photo is worse than no caption at all.
   */
  results: Map<string, DescribeResult>;
  /** The one call the whole batch cost, so the run log has one row per call. */
  call: DescribeResult;
}

export interface DescribeOptions {
  /** Override the provider (tests stub the CLI). Defaults to the registry's. */
  provider?: Provider;
  /** Correlates the CLI child, the run log and cancel. Generated when absent. */
  runId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Frames sampled across a video (v5 §2). When present they supersede the
   * single thumbnail and are read as ONE sequence; when absent — the switch is
   * off, or sampling failed — the thumbnail path below is exactly as it was.
   */
  frames?: readonly MediaFrame[];
}

/**
 * Media root. Precedence mirrors the /api/media route's mediaRoot() and the
 * daemon's resolveMediaDir() (SUPERTWIN_MEDIA_DIR → SUPERTWIN_HOME/media →
 * ~/SuperTwinV11/media) so the reader's cwd is the tree the files actually live in.
 */
export function mediaRoot(): string {
  const override = process.env.SUPERTWIN_MEDIA_DIR;
  if (override && override.trim().length > 0) return resolve(override);
  const home =
    process.env.SUPERTWIN_HOME && process.env.SUPERTWIN_HOME.trim().length
      ? process.env.SUPERTWIN_HOME
      : join(homedir(), "SuperTwinV11");
  return resolve(join(home, "media"));
}

/** Pick the file to open for a queued row, per the spec §8 strategy table. */
export function mediaStrategy(row: PendingMediaRow): MediaStrategy {
  switch (row.kind) {
    case "image":
    case "sticker":
      return row.mediaPath
        ? { kind: "image", path: row.mediaPath }
        : { kind: "unsupported", reason: "the event carries no file" };
    case "video":
      // One frame is all we get without shipping ffmpeg; no frame, no read.
      return row.thumbPath
        ? { kind: "frame", path: row.thumbPath }
        : { kind: "unsupported", reason: "the video has no thumbnail frame" };
    case "document":
      if (!row.mediaPath) {
        return { kind: "unsupported", reason: "the event carries no file" };
      }
      return isReadableDocument(row.mime, row.filename)
        ? { kind: "document", path: row.mediaPath }
        : {
            kind: "unsupported",
            reason: `${row.mime ?? row.filename ?? "this document"} cannot be read as text`,
          };
    case "audio":
      // Not "never transcribed" any more, but never DESCRIBED: audio runs
      // through the transcriber (v5 §3), which records its own status column.
      return { kind: "unsupported", reason: "audio has nothing to look at" };
    default:
      return {
        kind: "unsupported",
        reason: `nothing to read for a ${row.kind ?? "typeless"} event`,
      };
  }
}

function isReadableDocument(
  mime: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  const m = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (m === "application/pdf" || m === "application/json") return true;
  if (m.startsWith("text/")) return true;
  const name = filename ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return READABLE_DOC_EXTS.has(name.slice(dot + 1).toLowerCase());
}

const SUBJECT: Record<"image" | "frame" | "document", string> = {
  image: "an image someone sent in a chat",
  frame: "one still frame taken from a video someone sent in a chat",
  document: "a document someone sent in a chat",
};

/**
 * The reading prompt. Written for SEARCH, not for a human reader: the answer is
 * indexed into events_fts, so verbatim text beats prose about the text, and a
 * guess is worse than an admission.
 */
export function buildPrompt(
  row: PendingMediaRow,
  strategy: Extract<MediaStrategy, { path: string }>,
): string {
  const lines = [
    `Read the file at ${strategy.path} — it is ${SUBJECT[strategy.kind]}.`,
    "",
  ];
  if (row.filename) lines.push(`Its filename is "${row.filename}".`);
  if (row.caption) lines.push(`The sender's caption was: "${row.caption}".`);
  if (strategy.kind === "frame" && row.seconds) {
    lines.push(`The clip runs ${row.seconds}s; you are seeing one frame of it.`);
  }
  lines.push(
    "",
    "Reply with the description ONLY — no preamble, no headings, no bullet",
    "list, no mention of having read anything.",
    "",
    ...describeRules(strategy.kind),
  );
  return lines.join("\n");
}

/** What a description must contain, shared by the single and batch prompts. */
function describeRules(
  kind: "image" | "frame" | "document" | "sequence",
): string[] {
  const lines = [
    "One dense paragraph, at most 120 words, written so a keyword search finds",
    "it later:",
    "- what is concretely visible: people, objects, place, layout, colours",
    "- every legible word transcribed verbatim, including names, numbers,",
    "  dates and amounts",
  ];
  if (kind === "document") {
    lines.push("- the document's title and the gist of what it says");
  }
  if (kind === "frame") {
    lines.push("- only this frame; say nothing about the rest of the clip");
  }
  if (kind === "sequence") {
    lines.push("- what changes between the frames, and what stays the same");
  }
  lines.push(
    "",
    "Describe only what is actually there. If something is unreadable, say so",
    "rather than guessing.",
  );
  return lines;
}

/**
 * The multi-frame prompt (v5 §2). Every frame of one clip goes in ONE call,
 * stamped with the second it was taken at, and the model is told they are a
 * sequence — asked separately it would describe the same room four times and
 * never say that someone walked out of it.
 */
export function buildFramesPrompt(
  row: PendingMediaRow,
  frames: readonly MediaFrame[],
): string {
  const lines = [
    `Read these ${frames.length} still frames. They are taken in order from ONE`,
    "video someone sent in a chat, at these offsets into the clip:",
    "",
  ];
  for (const frame of frames) lines.push(`${frame.path} — at ${frame.seconds}s`);
  lines.push("");
  if (row.filename) lines.push(`The video's filename is "${row.filename}".`);
  if (row.caption) lines.push(`The sender's caption was: "${row.caption}".`);
  if (row.seconds) lines.push(`The clip runs ${row.seconds}s.`);
  lines.push(
    "",
    "Describe the CLIP, not the frames one by one: what is there throughout,",
    "and what changes as it goes on.",
    "",
    "Reply with the description ONLY — no preamble, no headings, no bullet",
    "list, no per-frame breakdown, no mention of having read anything.",
    "",
    ...describeRules("sequence"),
  );
  return lines.join("\n");
}

/**
 * Marks the start of one image's answer. The path is the ONLY key the parser
 * trusts — position in the answer is not a key, because a batch that skips or
 * merges a block silently shifts every description after it onto the wrong file.
 */
export const BATCH_MARKER = "@@FILE:";

/**
 * The multi-image prompt. Same rules as a single read, plus the one thing that
 * makes a batch safe to map back: each block is stamped with the path it is
 * about, copied from the list above it.
 */
export function buildBatchPrompt(
  items: readonly { row: PendingMediaRow; path: string }[],
): string {
  const lines = [
    `Read each of these ${items.length} files — every one is ${SUBJECT.image}.`,
    "",
  ];
  for (const { row, path } of items) {
    const notes: string[] = [];
    if (row.filename) notes.push(`filename "${row.filename}"`);
    if (row.caption) notes.push(`the sender's caption was "${row.caption}"`);
    lines.push(notes.length ? `${path} — ${notes.join("; ")}` : path);
  }
  lines.push(
    "",
    "Reply with one block per file and nothing else. Begin every block with a",
    "line of exactly:",
    "",
    `${BATCH_MARKER} <that file's path, copied character for character from the`,
    "list above>",
    "",
    "and put the description on the lines after it. One block per file, no",
    "preamble, no headings, no mention of having read anything. If you cannot",
    "describe a file, leave its block out entirely rather than guessing — a",
    "description filed under the wrong path is worse than a missing one.",
    "",
    ...describeRules("image"),
  );
  return lines.join("\n");
}

/**
 * Split a batch answer into path → description. Only paths that were asked for
 * and named exactly once come back; a repeated path is dropped along with both
 * of its blocks, because there is no way to tell which one was meant.
 */
export function parseBatchAnswer(
  raw: string,
  paths: readonly string[],
): Map<string, string> {
  const index = pathIndex(paths);
  const seen = new Map<string, string[]>();
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current !== null) {
      const prev = seen.get(current);
      if (prev) prev.push(buffer.join("\n"));
      else seen.set(current, [buffer.join("\n")]);
    }
    buffer = [];
  };

  for (const line of unfence(raw).split("\n")) {
    const marker = line.trimStart();
    if (marker.startsWith(BATCH_MARKER)) {
      flush();
      current = resolveMarker(markerPath(marker.slice(BATCH_MARKER.length)), index);
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();

  const out = new Map<string, string>();
  for (const [path, blocks] of seen) {
    if (blocks.length !== 1) continue;
    const description = cleanDescription(blocks[0]);
    if (description) out.set(path, description);
  }
  return out;
}

/**
 * Every string that can only mean one of the files we asked about: each path,
 * and each of its trailing segments. The model does copy the path back, but
 * often as the basename or relative to its cwd, and re-reading a whole batch
 * over a near-miss costs more than every near-miss it could ever save.
 *
 * A tail two of the asked-for files share maps to null, not to either of them —
 * a description filed under the wrong photo is the one failure batching must
 * not have.
 */
function pathIndex(paths: readonly string[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const tail = segments.slice(i).join("/");
      if (!tail) continue;
      const known = index.get(tail);
      index.set(tail, known === undefined || known === path ? path : null);
    }
  }
  // A path named in full is never ambiguous, whatever it collides with.
  for (const path of paths) index.set(path, path);
  return index;
}

/** The asked-for path a stamped one names, dropping leading segments to find it. */
function resolveMarker(
  stamped: string,
  index: Map<string, string | null>,
): string | null {
  let candidate = stamped;
  while (candidate.length > 0) {
    const hit = index.get(candidate);
    if (hit !== undefined) return hit;
    const cut = candidate.indexOf("/");
    if (cut < 0) return null;
    candidate = candidate.slice(cut + 1);
  }
  return null;
}

/**
 * Read one queued attachment. Never throws: a spawn/timeout/CLI failure comes
 * back as status "error" with the message, which the queue retries a bounded
 * number of times before recording it. A file that is no longer on disk is
 * "skipped" — retrying cannot bring it back.
 */
export async function describeMedia(
  row: PendingMediaRow,
  opts: DescribeOptions = {},
): Promise<DescribeResult> {
  const model = getSelectedModel("media");
  // A frame the sweep already took is not a file the reader can open, and the
  // prompt is about to promise that every path in it is readable.
  const frames = (opts.frames ?? []).filter((f) => existsSync(f.path));

  let prompt: string;
  let files = frames.length;
  if (frames.length > 0) {
    prompt = buildFramesPrompt(row, frames);
  } else {
    const strategy = mediaStrategy(row);
    if (strategy.kind === "unsupported") {
      return {
        description: null,
        status: "unsupported",
        model,
        error: strategy.reason,
      };
    }
    if (!existsSync(strategy.path)) {
      return {
        description: null,
        status: "skipped",
        model,
        error: `file not found: ${strategy.path}`,
      };
    }
    prompt = buildPrompt(row, strategy);
    files = 1;
  }

  const provider = opts.provider ?? getProvider(DEFAULT_PROVIDER_ID);
  if (!provider) {
    return {
      description: null,
      status: "error",
      model,
      error: `provider "${DEFAULT_PROVIDER_ID}" is not registered`,
    };
  }

  let text = "";
  let failure = "";
  const result = await provider.send({
    runId: opts.runId ?? `media-${randomUUID()}`,
    message: prompt,
    cwd: mediaRoot(),
    allowedTools: [...MEDIA_ALLOWED_TOOLS],
    // One Read per file plus the answer, with slack for a retried Read: a
    // sequence of frames is several Reads before it can say anything.
    maxTurns: files > 1 ? files + MEDIA_MAX_TURNS : MEDIA_MAX_TURNS,
    model,
    skipUserSettings: true,
    timeoutMs:
      opts.timeoutMs ??
      Math.min(DESCRIBE_TIMEOUT_MS * files, MAX_BATCH_TIMEOUT_MS),
    signal: opts.signal,
    onEvent: (ev) => {
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "error") failure = ev.message;
    },
  });
  const spend = { usage: result.usage, promptChars: prompt.length };

  if (result.status !== "ok") {
    return {
      description: null,
      status: "error",
      model,
      error: failure || result.errorCode || "the media read failed",
      ...spend,
    };
  }

  const description = cleanDescription(text);
  if (!description) {
    return {
      description: null,
      status: "error",
      model,
      error: "the model returned no description",
      ...spend,
    };
  }
  return { description, status: "done", model, error: null, ...spend };
}

/**
 * Read several images in ONE call. Every row the answer named is in `results`;
 * a row it did not name is absent, and the caller re-reads it alone. Never
 * throws — a failed call comes back as a retryable error against every row.
 */
export async function describeMediaBatch(
  rows: readonly PendingMediaRow[],
  opts: DescribeOptions = {},
): Promise<DescribeBatchResult> {
  const model = getSelectedModel("media");
  const results = new Map<string, DescribeResult>();
  const items: { row: PendingMediaRow; path: string }[] = [];

  for (const row of rows) {
    const strategy = mediaStrategy(row);
    if (strategy.kind === "unsupported") {
      results.set(row.id, {
        description: null,
        status: "unsupported",
        model,
        error: strategy.reason,
      });
    } else if (!existsSync(strategy.path)) {
      results.set(row.id, {
        description: null,
        status: "skipped",
        model,
        error: `file not found: ${strategy.path}`,
      });
    } else {
      items.push({ row, path: strategy.path });
    }
  }

  // A verdict that cost no call is logged as no call: "skipped" is what the run
  // log treats as nothing to record.
  const noCall: DescribeResult = {
    description: null,
    status: "skipped",
    model,
    error: null,
  };
  if (items.length === 0) return { results, call: noCall };

  const provider = opts.provider ?? getProvider(DEFAULT_PROVIDER_ID);
  if (!provider) {
    const error = `provider "${DEFAULT_PROVIDER_ID}" is not registered`;
    for (const { row } of items) {
      results.set(row.id, { description: null, status: "error", model, error });
    }
    return { results, call: { ...noCall, status: "error", error } };
  }

  const prompt = buildBatchPrompt(items);
  let text = "";
  let failure = "";
  const result = await provider.send({
    runId: opts.runId ?? `media-batch-${randomUUID()}`,
    message: prompt,
    cwd: mediaRoot(),
    allowedTools: [...MEDIA_ALLOWED_TOOLS],
    // One Read per file plus the answer, with slack for a retried Read.
    maxTurns: items.length + MEDIA_MAX_TURNS,
    model,
    skipUserSettings: true,
    timeoutMs:
      opts.timeoutMs ??
      Math.min(DESCRIBE_TIMEOUT_MS * items.length, MAX_BATCH_TIMEOUT_MS),
    signal: opts.signal,
    onEvent: (ev) => {
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "error") failure = ev.message;
    },
  });
  const spend = { usage: result.usage, promptChars: prompt.length };

  if (result.status !== "ok" || !text.trim()) {
    const error =
      result.status !== "ok"
        ? failure || result.errorCode || "the media read failed"
        : "the model returned no descriptions";
    for (const { row } of items) {
      results.set(row.id, {
        description: null,
        status: "error",
        model,
        error,
        ...spend,
      });
    }
    return { results, call: { ...noCall, status: "error", error, ...spend } };
  }

  const byPath = parseBatchAnswer(
    text,
    items.map((i) => i.path),
  );
  for (const { row, path } of items) {
    const description = byPath.get(path);
    if (description === undefined) continue;
    results.set(row.id, {
      description,
      status: "done",
      model,
      error: null,
      ...spend,
    });
  }

  // A call that named nothing we asked about produced no usable work, so the
  // run log records it as the failure it was rather than as a read.
  const mapped = byPath.size;
  return {
    results,
    call:
      mapped > 0
        ? { ...noCall, status: "done", ...spend }
        : {
            ...noCall,
            status: "error",
            error: `the answer named none of the ${items.length} files`,
            ...spend,
          },
  };
}

/** A fence is not part of the text. */
function unfence(raw: string): string {
  const t = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(t);
  return fence ? fence[1].trim() : t;
}

/** Unwrap a fenced answer and cap the length. */
function cleanDescription(raw: string): string {
  const t = unfence(raw);
  if (t.length <= MAX_DESCRIPTION_CHARS) return t;
  return `${t.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

/** The model sometimes quotes, bolds or brackets the stamped path, or trails a colon. */
function markerPath(raw: string): string {
  return raw
    .trim()
    .replace(/[:,]+$/, "")
    .replace(/^[`"'*<[(]+|[`"'*>\])]+$/g, "")
    .trim();
}
