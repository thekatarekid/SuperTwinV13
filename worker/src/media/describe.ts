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
// the CLI's own fixed preamble (arch §10.1). That only works if each description
// can be tied back to the exact file it is about, so EVERY image carries an
// explicit id in the prompt and the model must echo it back. The returned id set
// must equal the sent id set exactly; anything else is discarded whole and split
// in half by the caller (./batch.ts). A batch is never applied in part — a
// caption filed against the wrong photo silently corrupts every claim drawn from
// it, and nothing downstream can notice.
//
// Images are downscaled to ≤1092 px on the longest edge before they are sent
// (§10.1 point 2): past that you pay more vision tokens for no better caption.
// ===========================================================================

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { MediaDescStatus, MediaFrame, PendingMediaRow } from "../db/ingest.js";
import {
  BudgetExceededError,
  ModelActivityPausedError,
} from "../providers/budget.js";
import { ProviderGateError } from "../providers/gate.js";
import { resourcePool, type ResourcePool } from "../providers/pool.js";
import {
  ProviderSelectionError,
  requireMaxOutputTokens,
  resolveModelCall,
  type ResolvedModelCall,
} from "../providers/selection.js";
import type {
  ProviderErrorCode,
  ProviderId,
  LegacyProvider,
  NeutralProviderResult,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderV2,
  Usage,
} from "../providers/types.js";
import { bindTraceContext, withTraceContext } from "../traces/context.js";
import {
  DEFAULT_IMAGE_BATCH_SIZE,
  MAX_IMAGE_BATCH_SIZE,
  prepareVisionImage,
  verifyEcho,
  type EchoVerdict,
} from "./batch.js";

/** Only Read. No Grep/Glob/Bash — the reader opens exactly the named files. */
export const MEDIA_ALLOWED_TOOLS = ["Read"] as const;

/** One Read plus the answer, with slack for a retried Read. */
const MEDIA_MAX_TURNS = 4;

/**
 * Images per CLI call when Settings says nothing, and the ceiling on what may be
 * configured. Both are arch §10.1's numbers, held in ./batch.ts with the rest of
 * the `enrichment.*` settings and re-exported here for the older `media.*`
 * spelling to keep reading one source of truth.
 */
export const DEFAULT_IMAGE_BATCH = DEFAULT_IMAGE_BATCH_SIZE;
export const MAX_IMAGE_BATCH = MAX_IMAGE_BATCH_SIZE;

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
  /** Exact provider snapshot used for the call; absent when no call was needed. */
  provider?: ProviderId;
  /** Typed provider disposition used by the queue; absent for local parse errors. */
  errorCode?: ProviderErrorCode;
  usage?: Usage;
  /** Prompt size for the run log. Absent when no call was made. */
  promptChars?: number;
}

/** The outcome of one multi-image call. */
export interface DescribeBatchResult {
  /**
   * Verdict per row id — ALL of the rows sent, or NONE of them. An answer whose
   * echoed id set is not exactly the sent set is discarded whole: with one id
   * missing, every later block belongs to a different image than the order
   * suggests, and a caption filed against the wrong photo is worse than no
   * caption at all (arch §10.1 point 5).
   */
  results: Map<string, DescribeResult>;
  /** The one call the whole batch cost, so the run log has one row per call. */
  call: DescribeResult;
  /** Set when the echo did not match, naming what was missing or invented. */
  echo?: EchoVerdict;
}

export interface DescribeOptions {
  /** Strict production/test injection. Legacy shape remains type-only for one
   * release so external test fixtures compile, but is rejected before send. */
  provider?: ProviderV2 | LegacyProvider;
  /**
   * The LLM pool the read takes an ENRICHMENT-lane slot from (S0.9 / T8-3,
   * §4.4.1.1). Defaults to the process pool; tests inject their own.
   */
  pool?: ResourcePool;
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
 * ~/SuperTwinV13/media) so the reader's cwd is the tree the files actually live in.
 */
export function mediaRoot(): string {
  const override = process.env.SUPERTWIN_MEDIA_DIR;
  if (override && override.trim().length > 0) return resolve(override);
  const home =
    process.env.SUPERTWIN_HOME && process.env.SUPERTWIN_HOME.trim().length
      ? process.env.SUPERTWIN_HOME
      : join(homedir(), "SuperTwinV13");
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
 * Marks the start of one image's answer. The ID — not the path, and never the
 * position — is the only key the parser trusts: a batch that skips or merges a
 * block would otherwise shift every description after it onto the wrong file.
 */
export const BATCH_MARKER = "@@ID:";

/** The word a block uses for a file the model could not read. */
export const UNREADABLE = "UNREADABLE";

/** The id one image carries through the prompt and back: #01 … #32. */
export function batchImageId(index: number): string {
  return `#${String(index + 1).padStart(2, "0")}`;
}

/**
 * The multi-image prompt (arch §10.1 point 3). Same rules as a single read, plus
 * the two things that make a batch safe to map back: every file carries an
 * explicit id, and the answer must account for every one of them — including the
 * ones it could not read, which say UNREADABLE rather than going missing.
 */
export function buildBatchPrompt(
  items: readonly { row: PendingMediaRow; path: string; id?: string }[],
): string {
  const ids = items.map((item, i) => item.id ?? batchImageId(i));
  const lines = [
    `Read each of these ${items.length} files — every one is ${SUBJECT.image}.`,
    "",
  ];
  // The id goes on its own line, above the path it stands for. Rendered as
  // `#01 /very/long/path` the two read as ONE token, and the model echoes the
  // pair back — `@@ID: #01 /very/long/path` — which used to be taken whole as
  // the id and cost the batch every description in it.
  items.forEach(({ row, path }, i) => {
    const notes: string[] = [];
    if (row.filename) notes.push(`filename "${row.filename}"`);
    if (row.caption) notes.push(`the sender's caption was "${row.caption}"`);
    lines.push(`id ${ids[i]}`);
    lines.push(`    file: ${path}`);
    if (notes.length) lines.push(`    ${notes.join("; ")}`);
    lines.push("");
  });
  lines.push(
    "Reply with one block per file and NOTHING else. Do not write anything at",
    "all before the first block — no preamble, no plan, no \"I'll read the",
    "files\", no headings, no mention of having read anything.",
    "",
    "Begin every block with a marker line that is EXACTLY:",
    "",
    `${BATCH_MARKER} #NN`,
    "",
    "where #NN is that file's two-digit id from the list above and NOTHING",
    "follows it on that line — no path, no filename, no quotes, no colon.",
    "",
    "So a block for id #01 looks exactly like this:",
    "",
    `${BATCH_MARKER} #01`,
    "A crowded street market at dusk, a red awning over a stall whose sign",
    "reads \"FRESH FRUIT 24/7\", crates of mangoes in the foreground.",
    "",
    `Every id above must appear exactly once — all ${items.length} of them, in`,
    "any order. If a file cannot be described, still give it its block and",
    `write the single word ${UNREADABLE}: an id that goes missing invalidates`,
    "the whole answer, because every description after it would belong to a",
    "different file than it appears to.",
    "",
    ...describeRules("image"),
  );
  return lines.join("\n");
}

/**
 * What a batch sent for one id, so a marker that names the FILE instead of the
 * id can still be tied back to it. `paths` is everything the model could
 * plausibly echo for that item: the path as it went into the prompt, the row's
 * own media path (which differs whenever the image was downscaled for vision),
 * and its filename.
 */
export interface BatchItemRef {
  id: string;
  paths: readonly (string | null | undefined)[];
}

/** One `@@ID:` marker found in the answer, and where its block runs from. */
interface MarkerHit {
  id: string;
  /** Offset of the `@@ID:` itself — the previous block ends here. */
  from: number;
  /** Offset just past the marker line's payload — this block starts here. */
  to: number;
}

/** `@@ID:` and the rest of ITS line, found anywhere in the text. See below. */
function markerRegex(): RegExp {
  const lit = BATCH_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${lit}[ \\t]*([^\\n]*)`, "g");
}

/**
 * Split a batch answer into id → description, and report every id it named.
 *
 * Markers are found ANYWHERE in the text, not only at the start of a line, and
 * each block is the text between one marker and the next. Line-anchored
 * matching used to lose a whole block whenever something was glued onto the
 * front of the first marker — a preamble turn ("I'll read all 16 image files
 * for you.") or a duplicated assistant block concatenated with no separator —
 * and a lost block is a correct description silently thrown away plus a batch
 * rejected and paid for twice.
 *
 * Nothing is dropped, repaired or lined up by position here: an id the prompt
 * never issued and an id named twice both stay in `returned`, because it is the
 * CALLER that compares the whole set against what it sent and throws the answer
 * away unless the two match exactly (§10.1 point 5).
 */
export function parseBatchAnswer(
  raw: string,
  ids: readonly string[],
  items: readonly BatchItemRef[] = [],
): { blocks: Map<string, string | null>; returned: string[]; markers: string[] } {
  const known = new Set(ids.map(normalizeId));
  const byBasename = basenameIndex(items);
  const text = unfence(raw);

  const hits: MarkerHit[] = [];
  const markers: string[] = [];
  const re = markerRegex();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const payload = m[1] ?? "";
    markers.push(m[0].trim());
    hits.push({
      id: markerId(payload, byBasename),
      from: m.index,
      to: m.index + m[0].length,
    });
  }

  const returned: string[] = [];
  const blocks = new Map<string, string | null>();
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i]!;
    returned.push(hit.id);
    if (blocks.has(hit.id)) continue;
    const end = i + 1 < hits.length ? hits[i + 1]!.from : text.length;
    const body = cleanDescription(text.slice(hit.to, end));
    blocks.set(hit.id, body && body.toUpperCase() !== UNREADABLE ? body : null);
  }

  for (const id of [...blocks.keys()]) if (!known.has(id)) blocks.delete(id);
  return { blocks, returned, markers };
}

/**
 * The id a marker payload names.
 *
 * Only the LEADING token is the id: the model is told to write `@@ID: #01` and
 * nothing else, but it sometimes helpfully appends the file it is about —
 * `@@ID: #01 /Users/…/3AAF….jpg` — and the whole line used to become the id,
 * which cost the batch one missing id AND one invented one. A trailing path is
 * discarded here. A marker that carries NO number at all (`@@ID: 3AAF….jpg`,
 * the bare filename) is matched back by basename against what was sent; that is
 * unambiguous, because a batch never sends two files of the same name.
 *
 * An UNHASHED number must end the token or be followed by a separator, so the
 * bare filename `12.jpg` is read as a name rather than as id #12 — filing a
 * caption under the wrong id is the one outcome worse than rejecting a batch.
 */
function markerId(payload: string, byBasename: ReadonlyMap<string, string>): string {
  const token = markerToken(payload);
  const hashed = /^#[ \t]*(\d{1,3})(?![0-9])/.exec(token);
  const bare = hashed ? null : /^(\d{1,3})(?=$|[\s:,;\]\)—-])/.exec(token);
  const numeric = hashed ?? bare;
  if (numeric) return `#${String(Number(numeric[1])).padStart(2, "0")}`;
  if (byBasename.size > 0) {
    for (const candidate of basenameCandidates(token)) {
      const id = byBasename.get(candidate);
      if (id) return id;
    }
  }
  return normalizeId(token);
}

/**
 * basename → id, for everything a batch sent. A name that would map to two ids
 * maps to none: guessing between them is exactly the mis-filed caption the
 * whole-batch rule exists to prevent.
 */
function basenameIndex(items: readonly BatchItemRef[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const item of items) {
    for (const path of item.paths) {
      const name = basenameOf(path);
      if (!name) continue;
      const owner = index.get(name);
      if (owner && owner !== item.id) ambiguous.add(name);
      else index.set(name, item.id);
    }
  }
  for (const name of ambiguous) index.delete(name);
  return index;
}

function basenameOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!trimmed) return null;
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  return name ? name.toLowerCase() : null;
}

/** Every word of a marker payload, as a basename. Usually there is only one. */
function basenameCandidates(token: string): string[] {
  const out: string[] = [];
  const whole = basenameOf(token);
  if (whole) out.push(whole);
  for (const word of token.split(/\s+/)) {
    const name = basenameOf(word);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * A short, safe sample of what the model actually stamped, for the run log.
 * Without it this class of bug is only diagnosable by reading the raw CLI
 * transcript out of ~/.claude/projects.
 */
export function markerSample(markers: readonly string[], limit = 4): string {
  if (markers.length === 0) return "no @@ID markers at all";
  const shown = markers.slice(0, limit).map((m) => (m.length > 80 ? `${m.slice(0, 79)}…` : m));
  const more = markers.length > limit ? ` (+${markers.length - limit} more)` : "";
  return `${shown.join(" | ")}${more}`;
}

/**
 * `#1`, `01` and `#01` are the same id. The model does copy the id back, but
 * often without the hash or the leading zero, and rejecting a whole batch over
 * a zero would cost far more than the tolerance ever could: the ids are ours,
 * they are all of this shape, and no two of them normalise to the same string.
 */
export function normalizeId(raw: string): string {
  const bare = raw.trim().replace(/^#/, "").trim();
  return /^\d+$/.test(bare) ? `#${String(Number(bare)).padStart(2, "0")}` : raw.trim();
}

function resolveMediaCall(opts: DescribeOptions): ResolvedModelCall {
  const injected = opts.provider &&
    "catalogue" in opts.provider &&
    "capabilities" in opts.provider &&
    "killAll" in opts.provider
    ? opts.provider
    : undefined;
  if (opts.provider && !injected) {
    throw new ProviderSelectionError(
      "PROVIDER_UNAVAILABLE",
      "legacy provider injection is not accepted by the provider-neutral media reader",
      { key: "media" },
    );
  }
  const resolved = resolveModelCall(
    { source: "role", key: "media" },
    injected ? { provider: injected } : {},
  );
  // Phase 1 has only Claude's local-path/Read transport. Even a future
  // ChatGPT catalogue row claiming host tools must not make this path send an
  // absolute file path; Phase 4b owns the separate data-URL implementation.
  if (resolved.providerId !== "claude-local") {
    throw new ProviderSelectionError(
      "CAPABILITY_UNSUPPORTED",
      "media enrichment requires Claude's local Read host tool until Phase 4b",
      {
        providerId: resolved.providerId,
        key: resolved.key,
        model: resolved.model,
      },
    );
  }
  if (
    !resolved.provider.capabilities.hostTools ||
    !resolved.modelSnapshot.supportsHostTools ||
    !resolved.modelSnapshot.inputModalities.includes("text")
  ) {
    throw new ProviderSelectionError(
      "CAPABILITY_UNSUPPORTED",
      `model ${resolved.model} cannot perform the required Read-host-tool media call`,
      {
        providerId: resolved.providerId,
        key: resolved.key,
        model: resolved.model,
      },
    );
  }
  return resolved;
}

function mediaRequest(
  resolved: ResolvedModelCall,
  options: {
    runId: string;
    prompt: string;
    maxAgentTurns: number;
    timeoutMs: number;
    signal?: AbortSignal;
    onEvent: (event: ProviderStreamEvent) => void;
  },
): ProviderRequest {
  return {
    runId: options.runId,
    model: resolved.model,
    instructions: "",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: options.prompt }],
    }],
    hostTools: [...MEDIA_ALLOWED_TOOLS],
    toolChoice: "auto",
    cache: { mode: "implicit" },
    cwd: mediaRoot(),
    skipHostSettings: true,
    maxOutputTokens: requireMaxOutputTokens(resolved),
    maxAgentTurns: options.maxAgentTurns,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onEvent: options.onEvent,
  };
}

function mediaFailure(
  error: unknown,
  resolved?: ResolvedModelCall,
): DescribeResult {
  const selection = error instanceof ProviderSelectionError ? error : null;
  const errorCode: ProviderErrorCode | undefined = selection?.code ??
    (error instanceof ProviderGateError ||
      error instanceof BudgetExceededError ||
      error instanceof ModelActivityPausedError
      ? error.code
      : undefined);
  return {
    description: null,
    status: "error",
    model: resolved?.model ?? selection?.model ?? "",
    provider: resolved?.providerId ?? selection?.providerId ?? undefined,
    errorCode,
    error: error instanceof Error ? error.message : String(error),
  };
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
        model: "",
        error: strategy.reason,
      };
    }
    if (!existsSync(strategy.path)) {
      return {
        description: null,
        status: "skipped",
        model: "",
        error: `file not found: ${strategy.path}`,
      };
    }
    // Same 1092 px cap as a batch: a solo read of a 12 MP photo pays the same
    // vision tokens for the same caption (§10.1 point 2).
    const vision =
      strategy.kind === "image"
        ? await prepareVisionImage(strategy.path, { signal: opts.signal })
        : { path: strategy.path };
    prompt = buildPrompt(row, { ...strategy, path: vision.path });
    files = 1;
  }

  let resolved: ResolvedModelCall;
  try {
    resolved = resolveMediaCall(opts);
    requireMaxOutputTokens(resolved);
  } catch (error) {
    return mediaFailure(error);
  }
  const model = resolved.model;
  const provider = resolved.provider;

  let text = "";
  let failure = "";
  // Trace scope (build P0.7): one media read is one traced run. It takes an
  // enrichment-lane slot (S0.9 / T8-3) so a photo backlog paces against the
  // same cap as everything else instead of bypassing it.
  const pool = opts.pool ?? resourcePool;
  const runId = opts.runId ?? `media-${randomUUID()}`;
  let result: NeutralProviderResult;
  try {
    result = await withTraceContext(
      { pass: "media", caller: "media/describe" },
      () =>
        pool.run(
          "llm",
          bindTraceContext(() =>
            provider.send(mediaRequest(resolved, {
              runId,
              prompt,
              // One Read per file plus the answer, with slack for a retried
              // Read: a sequence of frames is several Reads before it answers.
              maxAgentTurns:
                files > 1 ? files + MEDIA_MAX_TURNS : MEDIA_MAX_TURNS,
              timeoutMs:
                opts.timeoutMs ??
                Math.min(DESCRIBE_TIMEOUT_MS * files, MAX_BATCH_TIMEOUT_MS),
              signal: opts.signal,
              onEvent: (ev) => {
                if (ev.type === "delta") text += ev.text;
                else if (ev.type === "error") failure = ev.message;
              },
            })),
          ),
          { lane: "enrichment" },
        ),
    );
  } catch (error) {
    return { ...mediaFailure(error, resolved), promptChars: prompt.length };
  }
  const spend = { usage: result.usage, promptChars: prompt.length };

  if (result.status !== "ok") {
    return {
      description: null,
      status: "error",
      model,
      provider: resolved.providerId,
      errorCode: result.errorCode,
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
      provider: resolved.providerId,
      error: "the model returned no description",
      ...spend,
    };
  }
  return {
    description,
    status: "done",
    model,
    provider: resolved.providerId,
    error: null,
    ...spend,
  };
}

/**
 * Read several images in ONE call, each carrying an explicit id the answer has
 * to echo back. The echo is checked as a SET: all of the rows get their verdict
 * or none of them do, and a mismatch comes back with `echo` set so the caller
 * can split the batch in half and try again (arch §10.1 points 3–5). Never
 * throws — a failed call comes back as a retryable error against every row.
 */
export async function describeMediaBatch(
  rows: readonly PendingMediaRow[],
  opts: DescribeOptions = {},
): Promise<DescribeBatchResult> {
  const results = new Map<string, DescribeResult>();
  const items: { row: PendingMediaRow; path: string; id: string }[] = [];

  for (const row of rows) {
    const strategy = mediaStrategy(row);
    if (strategy.kind === "unsupported") {
      results.set(row.id, {
        description: null,
        status: "unsupported",
        model: "",
        error: strategy.reason,
      });
    } else if (!existsSync(strategy.path)) {
      results.set(row.id, {
        description: null,
        status: "skipped",
        model: "",
        error: `file not found: ${strategy.path}`,
      });
    } else {
      // ≤1092 px on the longest edge before it is sent (§10.1 point 2). A file
      // ffmpeg cannot measure or scale is sent as it is — an expensive read
      // beats no read.
      const vision = await prepareVisionImage(strategy.path, { signal: opts.signal });
      items.push({ row, path: vision.path, id: batchImageId(items.length) });
    }
  }

  // A verdict that cost no call is logged as no call: "skipped" is what the run
  // log treats as nothing to record.
  if (items.length === 0) {
    return {
      results,
      call: { description: null, status: "skipped", model: "", error: null },
    };
  }

  let resolved: ResolvedModelCall;
  try {
    resolved = resolveMediaCall(opts);
    requireMaxOutputTokens(resolved);
  } catch (error) {
    const failed = mediaFailure(error);
    for (const { row } of items) {
      results.set(row.id, { ...failed });
    }
    return { results, call: failed };
  }
  const model = resolved.model;
  const provider = resolved.provider;
  const noCall: DescribeResult = {
    description: null,
    status: "skipped",
    model,
    provider: resolved.providerId,
    error: null,
  };

  const prompt = buildBatchPrompt(items);
  let text = "";
  let failure = "";
  // Trace scope (build P0.7): one media batch is one traced run, on an
  // enrichment-lane slot (S0.9 / T8-3).
  const pool = opts.pool ?? resourcePool;
  const runId = opts.runId ?? `media-batch-${randomUUID()}`;
  let result: NeutralProviderResult;
  try {
    result = await withTraceContext(
      { pass: "media", caller: "media/describe-batch" },
      () =>
        pool.run(
          "llm",
          bindTraceContext(() =>
            provider.send(mediaRequest(resolved, {
              runId,
              prompt,
              // One Read per file plus the answer, with slack for a retried Read.
              maxAgentTurns: items.length + MEDIA_MAX_TURNS,
              timeoutMs:
                opts.timeoutMs ??
                Math.min(DESCRIBE_TIMEOUT_MS * items.length, MAX_BATCH_TIMEOUT_MS),
              signal: opts.signal,
              onEvent: (ev) => {
                if (ev.type === "delta") text += ev.text;
                else if (ev.type === "error") failure = ev.message;
              },
            })),
          ),
          { lane: "enrichment" },
        ),
    );
  } catch (error) {
    const failed = {
      ...mediaFailure(error, resolved),
      promptChars: prompt.length,
    };
    for (const { row } of items) results.set(row.id, { ...failed });
    return { results, call: failed };
  }
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
        provider: resolved.providerId,
        errorCode: result.errorCode,
        error,
        ...spend,
      });
    }
    return {
      results,
      call: {
        ...noCall,
        status: "error",
        errorCode: result.errorCode,
        error,
        ...spend,
      },
    };
  }

  const sent = items.map((i) => i.id);
  const { blocks, returned, markers } = parseBatchAnswer(
    text,
    sent,
    // What the model could name a file by: the path it was given, the original
    // (a downscaled copy is sent under a different name), and the filename.
    items.map((i) => ({ id: i.id, paths: [i.path, i.row.mediaPath, i.row.filename] })),
  );
  const echo = verifyEcho(sent, returned);

  // THE WHOLE-BATCH RULE. One id short, one id invented, one id twice — the
  // answer is discarded entire and nothing is written against any row in it.
  // The caller splits the batch in half and asks again; applying the blocks
  // that did line up would be exactly the corruption batching exists to avoid.
  if (!echo.matched) {
    const why = [
      echo.missing.length ? `${echo.missing.length} missing` : "",
      echo.unexpected.length ? `${echo.unexpected.length} unexpected` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      results,
      echo,
      call: {
        ...noCall,
        status: "error",
        // The marker sample is what makes this diagnosable from the run log
        // alone: which ids came back malformed, not merely how many.
        error:
          `the answer echoed ${returned.length} of ${sent.length} ids (${why}) — ` +
          `markers: ${markerSample(markers)}`,
        ...spend,
      },
    };
  }

  for (const { row, id } of items) {
    const description = blocks.get(id) ?? null;
    results.set(row.id, {
      description,
      // An echoed block that says UNREADABLE is a verdict, not a caption: the
      // file was looked at and had nothing to give. Retrying cannot change that.
      status: description === null ? "skipped" : "done",
      model,
      provider: resolved.providerId,
      error: description === null ? "the model could not describe this file" : null,
      ...spend,
    });
  }

  return { results, echo, call: { ...noCall, status: "done", ...spend } };
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

/** The model sometimes quotes, bolds or brackets the stamped id, or trails a colon. */
function markerToken(raw: string): string {
  return raw
    .trim()
    .replace(/[:,]+$/, "")
    .replace(/^[`"'*<[(]+|[`"'*>\])]+$/g, "")
    .trim();
}
