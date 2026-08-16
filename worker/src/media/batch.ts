// ===========================================================================
// [CODE] The enrichment lane's batching, priority and hand-off (arch §10.1
// "Enrichment — executor map", §8.4 "Text-first, enrich-later", build 1.4).
//
// Four things live here, and they are the four rules that make enrichment safe
// to run at all:
//
//   1. EXECUTOR ROUTE.  Which engine reads which attachment (§10.1 table).
//      Vision is a hosted [LLM-S] call, transcription is local [ML], scraping
//      is [CODE]. The queue dispatches off this map instead of off a switch
//      statement per call site, so "vision is LLM not ML" is one table, not a
//      convention.
//
//   2. ID ECHO, WHOLE-BATCH.  Sixteen images ride one call, each stamped with
//      an explicit id the model must echo. The returned id set must equal the
//      sent id set EXACTLY, or the whole answer is discarded — never applied in
//      part. A caption on the wrong photo silently corrupts every claim drawn
//      from it, and there is no later stage that can notice.
//
//   3. BINARY SPLIT ON MISMATCH.  A rejected batch of 16 becomes 8 + 8, then
//      4 + 4, down to a single read. V11 dropped straight to solo, turning one
//      bad answer into sixteen calls; this costs three.
//
//   4. PRIORITY, NEVER FIFO.  The queue key is the cohort priority of §9.2/§9.3
//      — tier first, then horizon, then recency — computed by ../tiers/priority.
//      Insertion order is exactly the wrong order: backfilled history has the
//      highest rowids and the oldest timestamps.
//
// Nothing here blocks the text path: pass 1 has already run on text by the time
// any of this executes (§8.4). The hand-off back to it — the pending countdown
// and the completion pass — is ./enrich-pass.ts.
// ===========================================================================

import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { appStateGet, appStateSet, type PendingMediaRow } from "../db/ingest.js";
import { computePriority, horizonFor, isTier, type Tier } from "../tiers/priority.js";
import { resolveFfmpegBin, run } from "./tools.js";

// ---------------------------------------------------------------------------
// Settings — arch §8.4's table and §10.1 point 1/6.
// ---------------------------------------------------------------------------

export const ENRICHMENT_IMAGE_BATCH_SIZE_KEY = "enrichment.image_batch_size";
export const ENRICHMENT_READ_ALL_MEDIA_KEY = "enrichment.read_all_media";
export const ENRICHMENT_SALIENCE_GATE_KEY = "enrichment.salience_gate";

/**
 * Images per [LLM-S] call. Sixteen downscaled images is ~20–26 k input tokens —
 * a large but comfortable call that turns 2,000 photos into ~125 calls.
 */
export const DEFAULT_IMAGE_BATCH_SIZE = 16;
export const MIN_IMAGE_BATCH_SIZE = 1;
/** Past 32 an overrun costs the whole answer rather than one image. */
export const MAX_IMAGE_BATCH_SIZE = 32;

export function clampImageBatchSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_IMAGE_BATCH_SIZE;
  return Math.max(MIN_IMAGE_BATCH_SIZE, Math.min(MAX_IMAGE_BATCH_SIZE, Math.floor(n)));
}

/** Read fresh on every claim, so a Settings change lands on the next call. */
export function getEnrichmentImageBatchSize(): number {
  const raw = appStateGet(ENRICHMENT_IMAGE_BATCH_SIZE_KEY);
  if (raw === null) return DEFAULT_IMAGE_BATCH_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_IMAGE_BATCH_SIZE;
  return clampImageBatchSize(n);
}

export function setEnrichmentImageBatchSize(n: number): void {
  appStateSet(ENRICHMENT_IMAGE_BATCH_SIZE_KEY, String(clampImageBatchSize(n)));
}

/** Caption every image and sticker, transcribe every voice note. Default ON. */
export function getEnrichmentReadAllMedia(): boolean {
  return appStateGet(ENRICHMENT_READ_ALL_MEDIA_KEY) !== "0";
}

export function setEnrichmentReadAllMedia(on: boolean): void {
  appStateSet(ENRICHMENT_READ_ALL_MEDIA_KEY, on ? "1" : "0");
}

/**
 * When ON, an enrichment whose text carries no entity, date, number, price or
 * commitment does not trigger the completion pass. Default OFF — read
 * everything (§8.4 table). Turning it on saves cost and risks missing the one
 * caption that mattered, which is why the default is the expensive one.
 */
export function getEnrichmentSalienceGate(): boolean {
  return appStateGet(ENRICHMENT_SALIENCE_GATE_KEY) === "1";
}

export function setEnrichmentSalienceGate(on: boolean): void {
  appStateSet(ENRICHMENT_SALIENCE_GATE_KEY, on ? "1" : "0");
}

/** Sub-2 s audio is skipped only when read_all_media is off (§8.4 table). */
export const SHORT_AUDIO_SEC = 2;

// ---------------------------------------------------------------------------
// The executor map — arch §10.1, verbatim.
// ---------------------------------------------------------------------------

export type Executor = "[CODE]" | "[ML]" | "[LLM-S]";

export interface EnrichmentRoute {
  /** The §10.1 "Step" column. `skip` is the read_all_media = off case. */
  step: "caption" | "transcription" | "frames" | "scrape" | "skip";
  executor: Executor;
  /** The §10.1 "Engine · batching" column, as an engine name. */
  engine: string;
  /** True only where §10.1 says several inputs ride one call. */
  batched: boolean;
  /** Why, when the step is `skip`. */
  reason?: string;
}

const CAPTION: EnrichmentRoute = {
  step: "caption",
  executor: "[LLM-S]",
  engine: "haiku-cli",
  batched: true,
};

/**
 * A video is [CODE] ffmpeg frames followed by ONE [LLM-S] call carrying all of
 * them — one call per video, never one per frame. A document is read the same
 * way: one call, on its own.
 */
const SINGLE_CAPTION: EnrichmentRoute = {
  step: "caption",
  executor: "[LLM-S]",
  engine: "haiku-cli",
  batched: false,
};

const TRANSCRIBE: EnrichmentRoute = {
  step: "transcription",
  executor: "[ML]",
  engine: "whisper.cpp",
  batched: false,
};

/** The [CODE] half of a video: ffmpeg samples, then ONE model call reads. */
const VIDEO_FRAMES: EnrichmentRoute = {
  step: "frames",
  executor: "[CODE]",
  engine: "ffmpeg",
  batched: false,
};

const SCRAPE: EnrichmentRoute = {
  step: "scrape",
  executor: "[CODE]",
  engine: "fetch",
  batched: false,
};

const YOUTUBE: EnrichmentRoute = {
  step: "scrape",
  executor: "[CODE]",
  engine: "yt-dlp",
  batched: false,
};

/** What §10.1 says reads this attachment. Nothing here makes a call. */
export function enrichmentRoute(input: {
  kind: string | null;
  seconds?: number | null;
  url?: string | null;
}): EnrichmentRoute {
  const kind = input.kind ?? "";
  switch (kind) {
    case "image":
    case "sticker":
      if (kind === "sticker" && !getEnrichmentReadAllMedia()) {
        return { ...CAPTION, step: "skip", reason: "enrichment.read_all_media is off" };
      }
      return CAPTION;
    case "video":
    case "document":
      return SINGLE_CAPTION;
    case "audio":
    case "voice":
    case "ptt": {
      const seconds = input.seconds ?? null;
      if (!getEnrichmentReadAllMedia() && seconds !== null && seconds < SHORT_AUDIO_SEC) {
        return { ...TRANSCRIBE, step: "skip", reason: "enrichment.read_all_media is off" };
      }
      return TRANSCRIBE;
    }
    case "link":
      return isYouTube(input.url ?? "") ? YOUTUBE : SCRAPE;
    default:
      return { ...SCRAPE, step: "skip", reason: `no §10.1 row for kind ${kind || "(none)"}` };
  }
}

/**
 * Every §10.1 step this attachment needs, in order. Only a video has two: the
 * [CODE] frame sample, then the ONE [LLM-S] call that reads all of its frames —
 * never one call per frame.
 */
export function enrichmentSteps(input: {
  kind: string | null;
  seconds?: number | null;
  url?: string | null;
}): EnrichmentRoute[] {
  const route = enrichmentRoute(input);
  if (input.kind === "video" && route.step !== "skip") return [VIDEO_FRAMES, route];
  return [route];
}

function isYouTube(url: string): boolean {
  return /^https?:\/\/([\w-]+\.)*(youtube\.com|youtu\.be)(\/|$)/i.test(url.trim());
}

/** Images and stickers are the only kind §10.1 rides together. */
export function batchable(row: Pick<PendingMediaRow, "kind">): boolean {
  return enrichmentRoute({ kind: row.kind }).batched;
}

// ---------------------------------------------------------------------------
// Downscale — §10.1 point 2. Beyond 1092 px you pay more tokens for no
// additional caption quality.
// ---------------------------------------------------------------------------

export const VISION_MAX_EDGE = 1092;

export interface VisionTarget {
  width: number;
  height: number;
  /** False when the image was already inside the cap and is sent untouched. */
  scaled: boolean;
}

/** Fit inside VISION_MAX_EDGE preserving aspect. Downscale only, never up. */
export function visionTarget(
  width: number,
  height: number,
  maxEdge: number = VISION_MAX_EDGE,
): VisionTarget {
  if (!(width > 0) || !(height > 0)) return { width, height, scaled: false };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height, scaled: false };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

const PROBE_TIMEOUT_MS = 15_000;
const SCALE_TIMEOUT_MS = 30_000;
const SCALE_QUALITY = 5;

const DIMENSIONS = /,\s(\d{2,5})x(\d{2,5})[\s,]/;

/** Width and height off ffmpeg's own stream line, or null when unreadable. */
export async function probeDimensions(
  ffmpeg: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number } | null> {
  try {
    const out = await run(ffmpeg, ["-hide_banner", "-nostdin", "-i", path], {
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
    });
    const m = DIMENSIONS.exec(out.stderr);
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]) };
  } catch {
    return null;
  }
}

export interface VisionImage {
  /** What the prompt should name — the copy when one was made. */
  path: string;
  scaled: boolean;
  /** Longest edge of what will be sent, when it could be measured. */
  longestEdge: number | null;
  /** Why nothing was scaled. Not a failure: the original is still readable. */
  note?: string;
}

/**
 * The file the vision call should open: the original when it is already inside
 * the cap, a downscaled JPEG beside it when it is not. Never throws — a missing
 * ffmpeg or an unprobeable file falls back to the original, because a caption
 * from a large image costs tokens while no caption at all costs the claim.
 */
export async function prepareVisionImage(
  path: string,
  opts: { maxEdge?: number; signal?: AbortSignal } = {},
): Promise<VisionImage> {
  const maxEdge = opts.maxEdge ?? VISION_MAX_EDGE;
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg) return { path, scaled: false, longestEdge: null, note: "ffmpeg is not installed with the app" };

  const size = await probeDimensions(ffmpeg, path, opts.signal);
  if (!size) return { path, scaled: false, longestEdge: null, note: "dimensions unreadable" };

  const target = visionTarget(size.width, size.height, maxEdge);
  if (!target.scaled) {
    return { path, scaled: false, longestEdge: Math.max(size.width, size.height) };
  }

  const out = visionCopyPath(path, maxEdge);
  if (existsSync(out)) return { path: out, scaled: true, longestEdge: Math.max(target.width, target.height) };
  try {
    const result = await run(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        path,
        "-vf",
        `scale=${target.width}:${target.height}`,
        "-q:v",
        String(SCALE_QUALITY),
        "-f",
        "image2",
        "-update",
        "1",
        out,
      ],
      { timeoutMs: SCALE_TIMEOUT_MS, signal: opts.signal },
    );
    if (result.code !== 0 || !existsSync(out)) {
      return {
        path,
        scaled: false,
        longestEdge: Math.max(size.width, size.height),
        note: `ffmpeg exit ${result.code}`,
      };
    }
  } catch (err) {
    return {
      path,
      scaled: false,
      longestEdge: Math.max(size.width, size.height),
      note: (err as Error).message,
    };
  }
  return { path: out, scaled: true, longestEdge: Math.max(target.width, target.height) };
}

/** `photo.jpg` → `photo.v1092.jpg`, beside the original so the sweep sees it. */
export function visionCopyPath(path: string, maxEdge: number = VISION_MAX_EDGE): string {
  const ext = extname(path);
  return join(dirname(path), `${basename(path, ext)}.v${maxEdge}.jpg`);
}

// ---------------------------------------------------------------------------
// Priority — §9.2/§9.3. The queue key, never FIFO.
// ---------------------------------------------------------------------------

/** What the claim needs to know to place a row in the queue. */
export interface EnrichmentUnit {
  id: string;
  /** The event's own instant. `events.ts` — never `ingested_at`. */
  ts?: string | null;
  /** The stream's tier. Null before the boot backfill has run. */
  tier?: string | null;
}

/** An untiered stream sorts as T3: present, but behind anything classified. */
const UNTIERED: Tier = "T3";

export function tierOf(unit: EnrichmentUnit): Tier {
  return isTier(unit.tier) ? unit.tier : UNTIERED;
}

/**
 * `(tier_rank x 10^9) + (horizon_rank x 10^6) + recency`, the same key the
 * cohort scheduler dequeues by. Larger is more urgent.
 */
export function enrichmentPriority(unit: EnrichmentUnit, now: number = Date.now()): number {
  const ts = unit.ts ?? null;
  return computePriority({
    tier: tierOf(unit),
    horizon: ts === null ? "older" : horizonFor(ts, now),
    ts: ts ?? undefined,
    now,
  });
}

/**
 * Priority order, highest first.
 *
 * The key's recency term is quantised to ten minutes (§9.3), which is the right
 * grain for scheduling cohorts and far too coarse for a burst of photos sent one
 * second apart — so a tie falls back to the raw instant, newest first, and only
 * then to the id. Ties are broken deterministically rather than left to input
 * order, because input order here IS insertion order, and §9.2 rule 5 says never
 * that.
 */
export function orderByEnrichmentPriority<T extends EnrichmentUnit>(
  units: readonly T[],
  now: number = Date.now(),
): T[] {
  const at = (u: EnrichmentUnit): number => {
    const ms = u.ts ? Date.parse(u.ts) : NaN;
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  return [...units]
    .map((unit) => ({ unit, key: enrichmentPriority(unit, now) }))
    .sort(
      (a, b) =>
        b.key - a.key ||
        at(b.unit) - at(a.unit) ||
        (a.unit.id < b.unit.id ? -1 : a.unit.id > b.unit.id ? 1 : 0),
    )
    .map((e) => e.unit);
}

// ---------------------------------------------------------------------------
// The id echo and the binary split — §10.1 points 3, 4 and 5.
// ---------------------------------------------------------------------------

export interface EchoVerdict {
  matched: boolean;
  /** Sent but not returned. */
  missing: string[];
  /** Returned but never sent — or returned twice. */
  unexpected: string[];
}

/** Set equality, both directions, duplicates counted as unexpected. */
export function verifyEcho(sent: readonly string[], returned: readonly string[]): EchoVerdict {
  const wanted = new Set(sent);
  const seen = new Set<string>();
  const unexpected: string[] = [];
  for (const id of returned) {
    if (!wanted.has(id) || seen.has(id)) unexpected.push(id);
    else seen.add(id);
  }
  const missing = sent.filter((id) => !seen.has(id));
  return { matched: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

/** Halve a rejected batch: the left half never smaller than the right. */
export function splitInHalf<T>(rows: readonly T[]): [T[], T[]] {
  const mid = Math.ceil(rows.length / 2);
  return [rows.slice(0, mid), rows.slice(mid)];
}

/** Fixed-size chunks in the order given — the order is already the priority. */
export function planBatches<T>(rows: readonly T[], size: number): T[][] {
  const n = clampImageBatchSize(size);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

export interface BatchAnswer<R> {
  /** Verdict per id, exactly as the model named them. */
  results: Map<string, R>;
  /** The API refused the call (limit, 429, auth). Not the batch's fault. */
  refused?: boolean;
}

export interface SplitOptions<T, R> {
  call: (rows: readonly T[]) => Promise<BatchAnswer<R>>;
  /** Applied only for a batch whose echo matched exactly. */
  apply: (row: T, result: R) => void;
  /** The terminal single read — one row has nothing to be split against. */
  solo: (row: T) => Promise<void>;
  /** False stops the recursion mid-flight (a stop() or a shutdown). */
  running?: () => boolean;
  onMismatch?: (verdict: EchoVerdict, rows: readonly T[]) => void;
}

export interface SplitOutcome {
  /** Batch calls made, including the ones that were rejected. */
  calls: number;
  /** Batches whose id set did not match. */
  mismatches: number;
  /** Rows that ended up read alone at the bottom of the recursion. */
  solo: number;
  /** The API refused: the recursion stopped rather than knocking again. */
  refused: boolean;
}

/**
 * One group of images, read in as few calls as the model's own accuracy allows.
 *
 * A matched echo applies every verdict in the batch. A mismatched echo applies
 * NOTHING and splits the batch in half — 16 → 8 + 8 → 4 + 4 — until the halves
 * pass or reach a single row, which is read alone. Sixteen images that come
 * back one caption short therefore cost three calls, not sixteen, and no image
 * can be given a caption the model wrote about a different one.
 */
export async function runBatchWithSplit<T extends { id: string }, R>(
  rows: readonly T[],
  opts: SplitOptions<T, R>,
): Promise<SplitOutcome> {
  const outcome: SplitOutcome = { calls: 0, mismatches: 0, solo: 0, refused: false };
  const running = opts.running ?? (() => true);

  const walk = async (chunk: readonly T[]): Promise<void> => {
    if (chunk.length === 0 || outcome.refused || !running()) return;
    if (chunk.length === 1) {
      outcome.solo += 1;
      await opts.solo(chunk[0]!);
      return;
    }

    const answer = await opts.call(chunk);
    outcome.calls += 1;
    if (!running()) return;
    if (answer.refused) {
      outcome.refused = true;
      return;
    }

    const sent = chunk.map((r) => r.id);
    const verdict = verifyEcho(sent, [...answer.results.keys()]);
    if (verdict.matched) {
      for (const row of chunk) opts.apply(row, answer.results.get(row.id)!);
      return;
    }

    outcome.mismatches += 1;
    opts.onMismatch?.(verdict, chunk);
    const [left, right] = splitInHalf(chunk);
    await walk(left);
    await walk(right);
  };

  await walk(rows);
  return outcome;
}
