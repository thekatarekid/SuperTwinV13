// ===========================================================================
// [CODE] Real media for the enrichment gates — build item 4.4 (hardening).
//
// The nine `enrich_*` gates in §14.2 sat at `no data` because nothing drove
// REAL media files through the REAL enrichment queue where the harness could
// watch. This module closes that: a valid 2×2 PNG and a 1-second WAV are
// written to disk, inserted as events, claimed off `claimPendingMedia`, read
// through `describeMediaBatch`, resolved through `resolveEnrichment`, and the
// two-pass machinery (`reprocess.ts`) runs over the same temp DB — so every
// observation below is a measurement of product code, not a restatement.
//
// The model's side stays frozen (a stub provider), which is exactly how a
// `[LLM-S]` fixture freezes it. What is NOT frozen is everything on trial:
// the id echo, the mismatch void, the split, the countdown, the pass ceiling
// and the claims write path's duplicate absorption.
//
// THE WRONG-IMAGE AUDIT. The stub captions each image with the batch id it was
// shown under (`slot #03`). `describeMediaBatch` numbers items in the order
// the rows were sent, so the caption applied to `chunk[k]` must name slot
// `k+1` — an independent check of the whole attach path. Apply captions
// positionally after a bad echo (the defect the bolded gate names) and the
// audit fires; let the product void the mismatched batch and it stays silent.
// ===========================================================================

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { getDb } from "../../db/connection.js";
import {
  claimPendingMedia,
  insertEvent,
  recordMediaDescription,
  recordTranscript,
  type PendingMediaRow,
} from "../../db/ingest.js";
import { writeClaim } from "../../claims/write.js";
import { resolveEnrichment, salienceGateAdmits } from "../../media/enrich-pass.js";
import { getEnrichmentSalienceGate, setEnrichmentSalienceGate } from "../../media/batch.js";
import {
  armEnrichmentCountdown,
  completionPassContext,
  lateMediaArrived,
  passState,
  planCompletionPass,
  recordPassComplete,
  recordTextFirstPass,
} from "../../scheduler/reprocess.js";
import type { GateObservation } from "../runner.js";

// ---------------------------------------------------------------------------
// Real files — tiny, but valid to any reader that checks
// ---------------------------------------------------------------------------

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A REAL 2×2 RGB PNG — signature, IHDR, zlib-deflated IDAT, IEND, CRCs. */
export function tinyPngBytes(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); // width
  ihdr.writeUInt32BE(2, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // Two scanlines, filter byte 0 + 2 RGB pixels each.
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A REAL 1-second 8 kHz 16-bit mono PCM WAV (silence), header and all. */
export function tinyWavBytes(): Buffer {
  const sampleRate = 8_000;
  const samples = sampleRate; // one second
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function writeTinyPng(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, tinyPngBytes());
  return path;
}

export function writeTinyWav(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, tinyWavBytes());
  return path;
}

// ---------------------------------------------------------------------------
// The wrong-image audit (gate `enrich_caption_wrong_image`, bolded in §14.2)
// ---------------------------------------------------------------------------

/** One caption the pipeline actually attached to one row. */
export interface AppliedCaption {
  /** The row the caption was recorded against. */
  rowId: string;
  /** 1-based position of that row in the chunk its call sent. */
  sentPosition: number;
  /** The caption text as applied. */
  caption: string | null;
}

/** The stub's caption for the image shown under batch slot `n` (1-based). */
export function slotCaption(n: number): string {
  return `A tiny test image (slot #${String(n).padStart(2, "0")}).`;
}

const SLOT_RE = /slot #(\d\d)/;

/**
 * Did any caption land on an image it does not describe? The stub captions
 * each image with the SLOT it was shown under, and `describeMediaBatch` sends
 * rows in chunk order — so the caption applied to the k-th row of a call must
 * name slot k. A positional apply after a short or shuffled echo breaks this;
 * the product's void-and-split keeps it. One observation per applied caption,
 * so sixteen images are sixteen chances to be wrong.
 */
export function auditCaptionAttachment(applied: readonly AppliedCaption[]): GateObservation[] {
  return applied.map((a) => {
    const m = a.caption === null ? null : SLOT_RE.exec(a.caption);
    const slot = m ? Number(m[1]) : null;
    const ok = slot !== null && slot === a.sentPosition;
    return {
      gate: "enrich_caption_wrong_image",
      passed: ok,
      note: ok
        ? undefined
        : `row ${a.rowId} sent at position ${a.sentPosition} carries caption for slot ${String(slot)}`,
    };
  });
}

// ---------------------------------------------------------------------------
// The episode flow — pass 1, enrichment, pass 2, exactly two
// ---------------------------------------------------------------------------

export interface EpisodeFlowOptions {
  dir: string;
  sourceId: string;
  streamId: string;
  /** Frozen "now" for deterministic priorities. */
  now: number;
  images?: number;
  /** Include the 1-second WAV whose transcription fails (§8.4 rule 3). */
  voice?: boolean;
  /** After completion, one more image arrives late (§8.4 rule 2). */
  late?: boolean;
}

export interface EpisodeFlowReport {
  sessionId: string;
  /** Passes completed at the end of the flow. */
  passesDone: number;
  /** Pass 1 was recorded while attachments were still pending. */
  textRanWithPendingMedia: boolean;
  /** The completion queue row targeted the ORIGINAL session. */
  completionTargetsOriginal: boolean;
  /** The late re-read (when `late`) also targeted the original session. */
  lateTargetsOriginal: boolean | null;
  /** Pass 2 re-emitting pass 1's claim was absorbed, not duplicated. */
  reprocessDuplicates: number;
  /** Pass 2's context listed pass 1's claim (the anti-duplication contract). */
  extractedListed: boolean;
  gates: GateObservation[];
}

let seq = 0;

/**
 * Drive one media episode through the real queue and the real two-pass
 * machinery, and measure the gates on the way. Everything is read back out of
 * the DB; nothing below trusts a local variable where a row exists.
 */
export function runEpisodeFlow(opts: EpisodeFlowOptions): EpisodeFlowReport {
  const db = getDb();
  const images = Math.max(1, opts.images ?? 2);
  const run = (seq += 1);
  const baseTs = opts.now - 3_600_000;
  const eventIds: string[] = [];

  const insert = (i: number, kind: string, mediaPath: string | null, extra: Partial<Parameters<typeof insertEvent>[0]> = {}): string => {
    const r = insertEvent({
      externalId: `EP${run}-${kind}-${i}`,
      sourceId: opts.sourceId,
      sourceType: opts.sourceId,
      streamId: opts.streamId,
      actorId: null,
      ts: new Date(baseTs + i * 60_000).toISOString(),
      kind,
      text: kind === "message" ? "we booked the tickets, sending photos" : "",
      mediaPath,
      rawJson: null,
      ...extra,
    });
    eventIds.push(r.id);
    return r.id;
  };

  insert(0, "message", null);
  const imageIds: string[] = [];
  for (let i = 0; i < images; i += 1) {
    imageIds.push(
      insert(i + 1, "image", writeTinyPng(opts.dir, `ep${run}-img${i}.png`), {
        mediaMime: "image/png",
        mediaFilename: `ep${run}-img${i}.png`,
      }),
    );
  }
  let voiceId: string | null = null;
  if (opts.voice ?? true) {
    voiceId = insert(images + 1, "voice", writeTinyWav(opts.dir, `ep${run}-note.wav`), {
      mediaMime: "audio/wav",
      mediaSeconds: 1,
    });
  }

  const sessionId = `sess-ep-${run}`;
  db.prepare(
    `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, sealed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'sealed', ?)`,
  ).run(
    sessionId,
    opts.streamId,
    opts.sourceId,
    new Date(baseTs).toISOString(),
    new Date(baseTs + (images + 2) * 60_000).toISOString(),
    JSON.stringify(eventIds),
    new Date(opts.now).toISOString(),
  );

  // Pass 1: text-first, immediately, with the attachments still unread. This
  // ordering IS gate `enrich_slow_attachment_blocks_text`.
  recordTextFirstPass(sessionId);
  armEnrichmentCountdown(sessionId);
  const armed = passState(sessionId)!;
  const textRanWithPendingMedia = armed.passesDone >= 1 && armed.pending > 0;

  // Pass 1's claim, through the real write path, with evidence on this episode.
  const p1 = writeClaim(
    {
      kind: "fact",
      subjectId: null,
      subjectHint: `trip ${run}`,
      predicate: "booked tickets",
      text: "we booked the tickets",
      statedAt: new Date(baseTs).toISOString(),
      evidence: [{ eventId: eventIds[0]!, quote: "we booked the tickets" }],
    },
    { runId: `run-ep${run}-p1`, actor: "code:extract" },
  );

  // Enrichment resolves: captions land, the failed transcription still counts.
  for (const [i, id] of imageIds.entries()) {
    recordMediaDescription(id, { description: slotCaption(i + 1), status: "done", model: "stub" });
    resolveEnrichment(id, { text: slotCaption(i + 1), now: opts.now });
  }
  if (voiceId !== null) {
    recordTranscript(voiceId, { status: "error", error: "whisper died", transcript: null });
    resolveEnrichment(voiceId, { text: null, now: opts.now });
  }

  const queued = db
    .prepare(
      `SELECT unit_id FROM work_queue
        WHERE unit_kind = 'session' AND stage = 'extract' AND state = 'ready'
          AND unit_id = ?`,
    )
    .get(sessionId) as { unit_id: string } | undefined;
  const completionTargetsOriginal = queued?.unit_id === sessionId;

  // Pass 2: the plan admits it, the context lists pass 1's claim, and a model
  // that re-emits the claim anyway is absorbed by the write path as REINFORCE.
  const plan2 = planCompletionPass(sessionId);
  const context = completionPassContext(sessionId);
  const extractedListed = (context?.extracted ?? []).some((e) => e.id === p1.claimId);
  const p2 = writeClaim(
    {
      kind: "fact",
      subjectId: null,
      subjectHint: `trip ${run}`,
      predicate: "booked tickets",
      text: "we booked the tickets",
      statedAt: new Date(baseTs).toISOString(),
      evidence: [{ eventId: imageIds[0]!, quote: "tickets in the photo" }],
    },
    { runId: `run-ep${run}-p2`, actor: "code:extract" },
  );
  recordPassComplete(sessionId);

  const activeOfKey = db
    .prepare(`SELECT COUNT(*) AS n FROM claim_versions WHERE claim_key = ? AND closed_by IS NULL`)
    .get(p1.claimKey) as { n: number };
  const reprocessDuplicates = (p2.route === "insert" ? 1 : 0) + Math.max(0, activeOfKey.n - 1);

  // Landing on zero twice buys nothing: the plan refuses a third read.
  const plan3 = planCompletionPass(sessionId);

  // Late media, when posed: §8.4 rule 2 — same mechanism, same session.
  let lateTargetsOriginal: boolean | null = null;
  let finalPasses = passState(sessionId)!.passesDone;
  if (opts.late) {
    const lateId = insertEvent({
      externalId: `EP${run}-late`,
      sourceId: opts.sourceId,
      sourceType: opts.sourceId,
      streamId: opts.streamId,
      actorId: null,
      ts: new Date(baseTs + 10 * 60_000).toISOString(),
      kind: "image",
      text: "",
      mediaPath: writeTinyPng(opts.dir, `ep${run}-late.png`),
      rawJson: null,
      mediaMime: "image/png",
    }).id;
    db.prepare(`UPDATE sessions SET event_ids = ? WHERE id = ?`).run(
      JSON.stringify([...eventIds, lateId]),
      sessionId,
    );
    const rearm = lateMediaArrived(sessionId);
    recordMediaDescription(lateId, { description: slotCaption(1), status: "done", model: "stub" });
    const resolved = resolveEnrichment(lateId, { text: slotCaption(1), now: opts.now });
    const latePlan = planCompletionPass(sessionId);
    lateTargetsOriginal =
      rearm.rearmed && resolved.sessionId === sessionId && latePlan.run && latePlan.sessionId === sessionId;
    recordPassComplete(sessionId);
    finalPasses = passState(sessionId)!.passesDone;
  }

  const gates: GateObservation[] = [
    {
      gate: "enrich_slow_attachment_blocks_text",
      passed: textRanWithPendingMedia,
      note: textRanWithPendingMedia
        ? undefined
        : "text pass had not run while enrichment was outstanding",
    },
    {
      gate: "enrich_late_original_session",
      passed: completionTargetsOriginal && (lateTargetsOriginal ?? true),
      note: `completion row targets ${queued?.unit_id ?? "nothing"}`,
    },
    {
      gate: "enrich_reprocess_no_dupes",
      passed: reprocessDuplicates === 0 && extractedListed,
      note: `route=${p2.route}, active=${activeOfKey.n}, listed=${String(extractedListed)}`,
    },
  ];
  if (!opts.late) {
    // Exactly two passes, measured, and only when no late media excuses more.
    gates.push({
      gate: "enrich_passes_per_episode",
      passed: finalPasses === 2 && plan2.run && plan3.refusal === "already_complete",
      value: finalPasses,
      note: `passes=${finalPasses}, plan2.run=${String(plan2.run)}, plan3=${plan3.refusal ?? "ran"}`,
    });
  }
  return {
    sessionId,
    passesDone: finalPasses,
    textRanWithPendingMedia,
    completionTargetsOriginal,
    lateTargetsOriginal,
    reprocessDuplicates,
    extractedListed,
    gates,
  };
}

// ---------------------------------------------------------------------------
// The salience-gate measurement (gate `enrich_information_free_caption`)
// ---------------------------------------------------------------------------

export interface SalienceRateReport {
  infoFree: number;
  /** Completion passes an information-free caption triggered — the gate's count. */
  triggeredByInfoFree: number;
  rate: number;
  gates: GateObservation[];
}

/**
 * With the salience gate ON, an information-free caption must not trigger the
 * update pass (§8.4 table). Measured over the REAL `resolveEnrichment` returns
 * on a fresh episode: every info-free caption that comes back `gated` yet
 * enqueued a completion counts against the gate. The default (gate off) is not
 * on trial here — off means everything triggers, by design.
 */
export function measureInfoFreeRate(opts: EpisodeFlowOptions & { captions: string[] }): SalienceRateReport {
  const before = getEnrichmentSalienceGate();
  setEnrichmentSalienceGate(true);
  try {
    const db = getDb();
    const run = (seq += 1);
    const ids: string[] = [];
    for (const [i, caption] of opts.captions.entries()) {
      ids.push(
        insertEvent({
          externalId: `SAL${run}-${i}`,
          sourceId: opts.sourceId,
          sourceType: opts.sourceId,
          streamId: opts.streamId,
          actorId: null,
          ts: new Date(opts.now - 60_000 * (i + 1)).toISOString(),
          kind: "image",
          text: "",
          mediaPath: writeTinyPng(opts.dir, `sal${run}-${i}.png`),
          rawJson: null,
          mediaMime: "image/png",
        }).id,
      );
      void caption;
    }
    const sessionId = `sess-sal-${run}`;
    db.prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status)
       VALUES (?, ?, ?, ?, ?, ?, 'sealed')`,
    ).run(
      sessionId,
      opts.streamId,
      opts.sourceId,
      new Date(opts.now - 3_600_000).toISOString(),
      new Date(opts.now).toISOString(),
      JSON.stringify(ids),
    );
    recordTextFirstPass(sessionId);
    armEnrichmentCountdown(sessionId);

    let infoFree = 0;
    let triggeredByInfoFree = 0;
    for (const [i, caption] of opts.captions.entries()) {
      const isInfoFree = !salienceGateAdmits(caption);
      recordMediaDescription(ids[i]!, { description: caption, status: "done", model: "stub" });
      const res = resolveEnrichment(ids[i]!, { text: caption, now: opts.now });
      if (isInfoFree) {
        infoFree += 1;
        if (res.completionEnqueued) triggeredByInfoFree += 1;
      }
    }
    const rate = infoFree === 0 ? 0 : triggeredByInfoFree / infoFree;
    return {
      infoFree,
      triggeredByInfoFree,
      rate,
      gates: [
        {
          gate: "enrich_information_free_caption",
          passed: rate <= 0.05,
          value: rate,
          note: `${triggeredByInfoFree}/${infoFree} info-free captions triggered the update pass`,
        },
      ],
    };
  } finally {
    setEnrichmentSalienceGate(before);
  }
}

// ---------------------------------------------------------------------------
// Media rows for the batch scenarios — real events, claimed off the real queue
// ---------------------------------------------------------------------------

/**
 * Insert `n` image events with REAL 2×2 PNGs and claim them back off the
 * pending-media queue — so the batch scenarios read the rows the product's
 * own claim query hands out, not rows fabricated in their shape.
 */
export function seedAndClaimImages(
  dir: string,
  sourceId: string,
  streamId: string,
  n: number,
  now: number,
): PendingMediaRow[] {
  const run = (seq += 1);
  for (let i = 0; i < n; i += 1) {
    insertEvent({
      externalId: `BATCH${run}-${i}`,
      sourceId,
      sourceType: sourceId,
      streamId,
      actorId: null,
      ts: new Date(now - i * 1_000).toISOString(),
      kind: "image",
      text: "",
      mediaPath: writeTinyPng(dir, `batch${run}-${i}.png`),
      rawJson: null,
      mediaMime: "image/png",
      mediaFilename: `IMG_${i}.png`,
    });
  }
  const claimed = claimPendingMedia(n, { images: true, video: true, documents: true, business: true });
  // The claim can see rows from earlier scenarios in the same case; keep ours.
  return claimed.filter((r) => r.id.includes(`BATCH${run}-`)).slice(0, n);
}
