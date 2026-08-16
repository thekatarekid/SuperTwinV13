// ===========================================================================
// [CODE] Category C executor — the real enrichment lane (build item 1.4).
//
// Category C is `[CODE]`: no model is in the loop, so `frozen_response` is a
// scenario script and the executor is the product itself. Nothing here
// re-implements routing, batching, the id echo, the split or the queue key —
// every number below comes back out of `media/batch.ts`, `media/describe.ts`,
// `db/ingest.claimPendingMedia` and `providers/pool`, over real temp files and
// a real temp SQLite DB.
//
// Scenario records (one per line, `tag|field=value|…`):
//
//   route|kind=image                        which §10.1 row reads this
//   route|kind=voice|seconds=45
//   route|kind=link|url=https://youtu.be/x
//   caption|kind=sticker                    a real batch call over a real file
//   batch|images=16                         one call, ids echoed exactly
//   batch|images=16|echo=short:1            one id withheld → split 8+8
//   batch|images=16|echo=wrong:2            two ids replaced → whole batch void
//   downscale|width=3000|height=2000        the longest edge actually sent
//   quiet|texts=4                           a day with no media at all
//   priority|                               1h-old photo vs a 2023 photo
//   slots|pending=2                         Lane E during the first paint
//   setting|key=salience_gate               a default, read from the product
//
// The model's side of a batch is frozen the same way a `[LLM-S]` fixture would
// freeze it: a stub provider replies with `@@ID:` blocks, and `echo=` is how a
// case says the reply is wrong. Everything downstream — the prompt, the parse,
// the set comparison, the halving — is the product's.
// ===========================================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../../db/connection.js";
import { runMigrations } from "../../db/index.js";
import {
  claimPendingMedia,
  insertEvent,
  upsertSource,
  upsertStream,
  type PendingMediaRow,
} from "../../db/ingest.js";
import {
  batchable,
  enrichmentRoute,
  enrichmentSteps,
  getEnrichmentImageBatchSize,
  getEnrichmentReadAllMedia,
  getEnrichmentSalienceGate,
  orderByEnrichmentPriority,
  runBatchWithSplit,
  visionTarget,
  VISION_MAX_EDGE,
  type Executor as ExecutorTag,
} from "../../media/batch.js";
import { BATCH_MARKER, describeMediaBatch } from "../../media/describe.js";
import type { DescribeResult } from "../../media/describe.js";
import { laneCaps, RESOURCE_LIMITS } from "../../providers/pool.js";
import type { Provider, ProviderResult, SendOptions } from "../../providers/index.js";
import { emptyUsage } from "../../providers/usage.js";
import type { Executor, GateObservation, Produced } from "../runner.js";
import {
  auditCaptionAttachment,
  measureInfoFreeRate,
  runEpisodeFlow,
  seedAndClaimImages,
  slotCaption,
  type AppliedCaption,
} from "./enrichment-media.js";

const SOURCE_ID = "whatsapp";
const STREAM_EXT = "pranjali@s.whatsapp.net";
/** The instant every case is posed relative to. Frozen, so it is offline. */
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

interface ScenarioLine {
  tag: string;
  fields: Record<string, string>;
}

function parseScenario(text: string): ScenarioLine[] {
  const out: ScenarioLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      if (part.trim() === "") continue;
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`enrichment scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    out.push({ tag, fields });
  }
  return out;
}

function num(fields: Record<string, string>, key: string, fallback: number): number {
  const raw = fields[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`enrichment scenario: ${key}=${raw} is not a number`);
  return n;
}

/** The frozen model. `blocks` is the answer it gives to a batch of `n` ids. */
function stubProvider(blocks: (ids: string[]) => string): Provider & { calls: SendOptions[] } {
  const calls: SendOptions[] = [];
  return {
    id: "stub",
    calls,
    cancel: () => false,
    async send(opts: SendOptions): Promise<ProviderResult> {
      calls.push(opts);
      const ids = [...opts.message.matchAll(/^(#\d\d) /gm)].map((m) => m[1]!);
      opts.onEvent({ type: "delta", text: blocks(ids) });
      return {
        sessionId: "",
        usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 20 },
        freshFallback: false,
        status: "ok",
      };
    },
  };
}

/** A real file on disk, so the reader's existence check agrees it is readable. */
function mediaFile(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, "x");
  return path;
}

function imageRows(dir: string, n: number, kind = "image"): PendingMediaRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${SOURCE_ID}:IMG${i}`,
    kind,
    mediaPath: mediaFile(dir, `IMG${i}.jpg`),
    thumbPath: null,
    mime: "image/jpeg",
    filename: `IMG_${i}.jpg`,
    seconds: null,
    caption: null,
    isHistorical: false,
    ts: new Date(NOW - i * 1_000).toISOString(),
    tier: "T1",
  }));
}

/**
 * The answer a well-behaved model gives: every id, echoed once, with the
 * caption naming the SLOT the image was shown under — which is what lets
 * `auditCaptionAttachment` prove each caption landed on its own image.
 */
function fullAnswer(ids: string[]): string {
  return ids.map((id, i) => `${BATCH_MARKER} ${id}\n${slotCaption(i + 1)}`).join("\n\n");
}

interface Ctx {
  dir: string;
  output: Record<string, unknown>;
  state: Record<string, unknown>;
  metrics: Record<string, number>;
  /** Every enrichment step the scenario caused, by executor. */
  calls: { unit: string; step: string; executor: ExecutorTag; engine: string }[];
  /** §14.2 gate measurements this run made beyond the case's own assertion. */
  gates: GateObservation[];
}

function note(ctx: Ctx, unit: string, route: ReturnType<typeof enrichmentRoute>): void {
  if (route.step === "skip") return;
  ctx.calls.push({ unit, step: route.step, executor: route.executor, engine: route.engine });
}

/** `llm_calls` / `ml_calls` / `code_steps`, so a case can assert on absence. */
function publishCalls(ctx: Ctx): void {
  const of = (tag: ExecutorTag): unknown[] =>
    ctx.calls.filter((c) => c.executor === tag).map((c) => ({ step: c.step, engine: c.engine }));
  ctx.output.llm_calls = of("[LLM-S]");
  ctx.output.ml_calls = of("[ML]");
  ctx.output.code_steps = of("[CODE]");
  ctx.metrics.llm_calls = (ctx.output.llm_calls as unknown[]).length;
  ctx.metrics.ml_calls = (ctx.output.ml_calls as unknown[]).length;
}

// ---- the scenarios ---------------------------------------------------------

/** One §10.1 table lookup, over the real route map. */
function runRoute(ctx: Ctx, fields: Record<string, string>): void {
  const kind = fields.kind ?? "image";
  const input = {
    kind,
    seconds: fields.seconds === undefined ? null : num(fields, "seconds", 0),
    url: fields.url ?? null,
  };
  // A video is two rows of the table: ffmpeg frames, then ONE model call over
  // all of them. Everything else is one row.
  const steps = enrichmentSteps(input);
  for (const step of steps) note(ctx, kind, step);
  const last = steps[steps.length - 1]!;
  ctx.state.kind = kind;
  ctx.state.executor = last.executor;
  ctx.state.step = last.step;
  ctx.state.engine = last.engine;
  ctx.state.batched = last.batched;
  ctx.state.steps = steps.map((s) => `${s.executor} ${s.step}`);
}

/**
 * A real batch call over real files — REAL 2×2 PNGs inserted as events and
 * claimed back off the product's own pending-media queue — with the model's
 * answer frozen.
 */
async function runBatch(ctx: Ctx, fields: Record<string, string>): Promise<void> {
  const count = num(fields, "images", 16);
  const streamId = seedStream();
  const rows = seedAndClaimImages(ctx.dir, SOURCE_ID, streamId, count, NOW);
  const echo = fields.echo ?? "all";
  const sizes: number[] = [];
  const captions: { id: string; status: string }[] = [];
  const applied: AppliedCaption[] = [];
  let currentChunk: readonly PendingMediaRow[] = [];

  const provider = stubProvider((ids) => {
    // Only the FIRST, full-size call misbehaves: a case says "16 comes back one
    // short", not "every call this run comes back short".
    if (ids.length !== count) return fullAnswer(ids);
    if (echo.startsWith("short:")) {
      const drop = Number(echo.slice("short:".length));
      return fullAnswer(ids.slice(0, ids.length - drop));
    }
    if (echo.startsWith("wrong:")) {
      const bad = Number(echo.slice("wrong:".length));
      const swapped = ids.map((id, i) => (i >= ids.length - bad ? `#9${i}` : id));
      return fullAnswer(swapped);
    }
    return fullAnswer(ids);
  });

  /** What each CALL managed to write. The first one is the one on trial. */
  const perCall: { size: number; applied: number }[] = [];

  const outcome = await runBatchWithSplit<PendingMediaRow, DescribeResult>(rows, {
    call: async (chunk) => {
      sizes.push(chunk.length);
      perCall.push({ size: chunk.length, applied: 0 });
      currentChunk = chunk;
      // One CALL, whatever it holds — this is what §10.1's "16 images per call"
      // means, and counting a call per image is how that claim gets faked.
      note(ctx, `batch:${chunk.length}`, enrichmentRoute({ kind: "image" }));
      const answer = await describeMediaBatch(chunk, { provider });
      return { results: answer.results };
    },
    apply: (row, result) => {
      captions.push({ id: row.id, status: result.status });
      applied.push({
        rowId: row.id,
        sentPosition: currentChunk.indexOf(row) + 1,
        caption: result.description,
      });
      perCall[perCall.length - 1]!.applied += 1;
    },
    solo: async (row) => {
      // A single row is a single read: at the bottom of the recursion there is
      // nothing left to split it against.
      sizes.push(1);
      perCall.push({ size: 1, applied: 0 });
      currentChunk = [row];
      note(ctx, row.id, enrichmentRoute({ kind: row.kind }));
      const answer = await describeMediaBatch([row], { provider });
      const result = answer.results.get(row.id);
      captions.push({ id: row.id, status: result?.status ?? "error" });
      applied.push({ rowId: row.id, sentPosition: 1, caption: result?.description ?? null });
      perCall[perCall.length - 1]!.applied += 1;
    },
  });

  captions.sort((a, b) => (a.id < b.id ? -1 : 1));
  ctx.output.batches = sizes.map((size) => ({ size }));
  ctx.state.batch_size_setting = getEnrichmentImageBatchSize();
  ctx.state.sent = count;
  // Every model call the group cost, batched or solo — one image submitted is
  // still one call, and counting only the batched ones would hide that.
  ctx.state.calls = sizes.length;
  ctx.state.batch_sizes = sizes;
  ctx.state.batch_calls = outcome.calls;
  ctx.state.mismatches = outcome.mismatches;
  ctx.state.applied = captions.length;
  ctx.state.every_image_captioned = captions.length === count;
  // A rejected answer writes NOTHING — not even the blocks that lined up.
  ctx.state.first_call_applied = perCall[0]?.applied ?? 0;
  ctx.metrics.calls = sizes.length;
  ctx.metrics.image_batch_size = count;

  // ---- §14.2 gate observations, all measured off what actually happened ----
  const batchSize = getEnrichmentImageBatchSize();
  const mismatched = outcome.mismatches > 0;
  // One observation PER APPLIED CAPTION: sixteen images are sixteen chances to
  // land on the wrong photo (bolded gate `enrich_caption_wrong_image`).
  ctx.gates.push(...auditCaptionAttachment(applied));
  ctx.gates.push({
    gate: "enrich_all_media_captioned",
    passed: captions.length === count,
    note: `${captions.length}/${count} captioned`,
  });
  if (count >= batchSize && !mismatched) {
    // The honoured batch size is only measurable when enough images are
    // pending to fill a batch and no mismatch forced a split (§14.2 wording).
    ctx.gates.push({
      gate: "enrich_batch_size",
      passed: (sizes[0] ?? 0) >= batchSize,
      value: sizes[0] ?? 0,
      note: `first call carried ${sizes[0] ?? 0} of a ${batchSize} batch`,
    });
  }
  if (mismatched) {
    // A mismatched batch must be void-and-split: nothing from the first call
    // applied, everything eventually captioned by the halves.
    ctx.gates.push({
      gate: "enrich_mismatch_split_retry",
      passed: (perCall[0]?.applied ?? 0) === 0 && captions.length === count,
      note: `first call applied ${perCall[0]?.applied ?? 0}, ${captions.length}/${count} after split`,
    });
  }
  // The same media episode, end to end: pass 1 on text with attachments still
  // pending, captions resolve, exactly one completion pass, no duplicate claim.
  const flow = runEpisodeFlow({ dir: ctx.dir, sourceId: SOURCE_ID, streamId, now: NOW, images: 2, voice: true });
  ctx.gates.push(...flow.gates);
  ctx.state.episode_passes_done = flow.passesDone;
}

/** One image, read for real, to show what the defaults do with it. */
async function runCaption(ctx: Ctx, fields: Record<string, string>): Promise<void> {
  const kind = fields.kind ?? "image";
  const [row] = imageRows(ctx.dir, 1, kind);
  const route = enrichmentRoute({ kind });
  note(ctx, row!.id, route);
  if (route.step === "skip") {
    ctx.output.captions = [];
    ctx.state.read_all_media = getEnrichmentReadAllMedia();
    return;
  }
  const answer = await describeMediaBatch([row!], { provider: stubProvider(fullAnswer) });
  const result = answer.results.get(row!.id);
  ctx.output.captions = [{ kind, status: result?.status ?? "error", executor: route.executor }];
  ctx.state.read_all_media = getEnrichmentReadAllMedia();
  ctx.state.batched = batchable(row!);

  // At default settings every image and sticker gets its caption (§14.2).
  ctx.gates.push({
    gate: "enrich_all_media_captioned",
    passed: result?.status === "done" && result.description !== null,
    note: `${kind} → ${result?.status ?? "no result"}`,
  });
  ctx.gates.push(...auditCaptionAttachment([{ rowId: row!.id, sentPosition: 1, caption: result?.description ?? null }]));
  // Late media on a completed episode re-reads the ORIGINAL session (§8.4
  // rule 2) — the whole flow over the real queue rows, late arrival included.
  const streamId = seedStream();
  const flow = runEpisodeFlow({ dir: ctx.dir, sourceId: SOURCE_ID, streamId, now: NOW, images: 1, voice: true, late: true });
  ctx.gates.push(...flow.gates);
  ctx.state.late_targets_original = flow.lateTargetsOriginal;
}

/** The one number a vision call is allowed to send (§10.1 point 2). */
function runDownscale(ctx: Ctx, fields: Record<string, string>): void {
  const width = num(fields, "width", 3000);
  const height = num(fields, "height", 2000);
  const target = visionTarget(width, height);
  const longest = Math.max(target.width, target.height);
  ctx.state.longest_edge_before = Math.max(width, height);
  ctx.state.longest_edge_px = longest;
  ctx.state.scaled = target.scaled;
  ctx.metrics.longest_edge_px = longest;
  ctx.metrics.vision_max_edge = VISION_MAX_EDGE;
}

/** A day of text and nothing else: enrichment must cost zero model calls. */
function runQuiet(ctx: Ctx, fields: Record<string, string>): void {
  const texts = num(fields, "texts", 4);
  const streamId = seedStream();
  for (let i = 0; i < texts; i += 1) {
    insertEvent({
      externalId: `TXT${i}`,
      sourceId: SOURCE_ID,
      sourceType: SOURCE_ID,
      streamId,
      actorId: null,
      ts: new Date(NOW - i * 60_000).toISOString(),
      kind: "message",
      text: "just talking",
      mediaPath: null,
      rawJson: null,
    });
  }
  const pending = claimPendingMedia(50, {
    images: true,
    video: true,
    documents: true,
    business: true,
  });
  for (const row of pending) note(ctx, row.id, enrichmentRoute({ kind: row.kind }));
  ctx.state.text_events = texts;
  ctx.state.pending_media = pending.length;
}

/** The queue key over real rows: 1h-old vs 2023, inserted oldest-first. */
function runPriority(ctx: Ctx): void {
  const streamId = seedStream();
  const seed = (externalId: string, ts: string): string =>
    insertEvent({
      externalId,
      sourceId: SOURCE_ID,
      sourceType: SOURCE_ID,
      streamId,
      actorId: null,
      ts,
      kind: "image",
      text: "",
      mediaPath: `/media/${externalId}.jpg`,
      rawJson: null,
      mediaMime: "image/jpeg",
      isHistorical: true,
    }).id;

  // Insertion order is deliberately the WRONG order: FIFO or rowid would put
  // the 2023 photo first, which is the defect C-035 names.
  const old = seed("PHOTO2023", "2023-05-02T10:00:00.000Z");
  const recent = seed("PHOTO1H", new Date(NOW - 3_600_000).toISOString());

  const claimed = claimPendingMedia(10, {
    images: true,
    video: true,
    documents: true,
    business: true,
  });
  const ordered = orderByEnrichmentPriority(claimed, NOW);
  ctx.output.order = ordered.map((r) => ({ id: r.id }));
  ctx.state.order = ordered.map((r) => r.id);
  ctx.state.insertion_order = [old, recent];
  ctx.state.read_first = ordered[0]?.id ?? null;
  ctx.state.fifo = ordered[0]?.id === old;
  // §14.2 `enrich_media_queue_priority`: any inversion — a 2023 photo read
  // before the hour-old one — is a violation, measured off the real key.
  ctx.gates.push({
    gate: "enrich_media_queue_priority",
    passed: ordered[0]?.id === recent,
    note: `read first: ${ordered[0]?.id ?? "nothing"}`,
  });
}

/**
 * Lane E's slots while the first paint is still running (§9.5.1, §4.4.1). This
 * is the pool's own split function — the same one ResourcePool calls whenever
 * the LLM limit or the first-paint flag changes — so a case here cannot pass
 * while the pool hands enrichment a slot.
 */
function runSlots(ctx: Ctx, fields: Record<string, string>): void {
  const pending = num(fields, "pending", 2);
  const limit = RESOURCE_LIMITS.llm.default;
  const during = laneCaps(limit, true);
  const after = laneCaps(limit, false);
  ctx.output.lanes = [{ lane: "E", slots: during.enrichment }];
  ctx.state.pending_images = pending;
  ctx.state.lane_e_slots = during.enrichment;
  ctx.state.lane_u_slots_positive = during.understanding > 0;
  // ...and the slots do come back once the paint is done: this is a hold, not
  // a ban (§9.4 rule 5 — neither lane may stall the pipeline).
  ctx.state.lane_e_slots_after_paint_positive = after.enrichment > 0;
  ctx.metrics.lane_e_slots = during.enrichment;
}

/** A default, read out of the product rather than restated here. */
function runSetting(ctx: Ctx, fields: Record<string, string>): void {
  const key = fields.key ?? "salience_gate";
  const value =
    key === "salience_gate"
      ? getEnrichmentSalienceGate()
      : key === "read_all_media"
        ? getEnrichmentReadAllMedia()
        : getEnrichmentImageBatchSize();
  ctx.output.settings = [{ key, value }];
  ctx.state[key] = value;

  if (key === "salience_gate") {
    // With the gate ON, an information-free caption must not trigger the
    // update pass (§8.4 table) — measured off real `resolveEnrichment`
    // returns, with the info-free caption resolving LAST so it is the one
    // that could have triggered.
    const streamId = seedStream();
    const report = measureInfoFreeRate({
      dir: ctx.dir,
      sourceId: SOURCE_ID,
      streamId,
      now: NOW,
      captions: ["Flight AI-202 on 21 Aug for ₹4,300", "hmm", "nice one"],
    });
    ctx.gates.push(...report.gates);
    ctx.metrics.info_free_update_rate = report.rate;
    ctx.state.info_free_captions = report.infoFree;
  }
}

function seedStream(): string {
  upsertSource({ id: SOURCE_ID, type: SOURCE_ID, name: "WhatsApp" });
  return upsertStream({
    sourceId: SOURCE_ID,
    sourceExtId: STREAM_EXT,
    name: "Pranjali",
    kind: "dm",
  });
}

async function runScenario(response: string, dir: string): Promise<Produced> {
  runMigrations();
  const ctx: Ctx = { dir, output: {}, state: {}, metrics: {}, calls: [], gates: [] };

  for (const { tag, fields } of parseScenario(response)) {
    switch (tag) {
      case "route":
        runRoute(ctx, fields);
        break;
      case "batch":
        await runBatch(ctx, fields);
        break;
      case "caption":
        await runCaption(ctx, fields);
        break;
      case "downscale":
        runDownscale(ctx, fields);
        break;
      case "quiet":
        runQuiet(ctx, fields);
        break;
      case "priority":
        runPriority(ctx);
        break;
      case "slots":
        runSlots(ctx, fields);
        break;
      case "setting":
        runSetting(ctx, fields);
        break;
      default:
        throw new Error(`enrichment scenario: unknown record ${JSON.stringify(tag)}`);
    }
  }

  publishCalls(ctx);
  return { output: ctx.output, state: ctx.state, metrics: ctx.metrics, gates: ctx.gates };
}

export const enrichmentExecutor: Executor = async ({ response }) => {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-enrich-"));
  const media = join(dir, "media");
  mkdirSync(media, { recursive: true });
  const previousDb = process.env.SUPERTWIN_DB_PATH;
  const previousMedia = process.env.SUPERTWIN_MEDIA_DIR;
  process.env.SUPERTWIN_DB_PATH = join(dir, "eval.db");
  process.env.SUPERTWIN_MEDIA_DIR = media;
  closeDb();
  try {
    return await runScenario(response, media);
  } finally {
    closeDb();
    if (previousDb === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previousDb;
    if (previousMedia === undefined) delete process.env.SUPERTWIN_MEDIA_DIR;
    else process.env.SUPERTWIN_MEDIA_DIR = previousMedia;
    rmSync(dir, { recursive: true, force: true });
  }
};
