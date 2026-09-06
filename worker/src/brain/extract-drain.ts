// ===========================================================================
// The Extract drain — V6 P1 E1. The production caller `runExtractPass` never
// had (Build §6.2 lane B / S3.6; Product_V6_Phase1 §11 memory).
//
// S3.6 built the pass with every code rail the spec asks for and wired it to
// nothing: `brain/reduce.runReduce` was its only caller and nothing called
// `runReduce`. The consolidation job drained the DECIDE queue; there was no
// Extract queue to drain. So on a real home: 435 episodes, 948 person
// entities, ZERO claims — and "Who I am", the People circles and the
// follow-up radar all read claims, so all three were empty by construction.
//
// It was left unwired for a real reason, and this is the design around it
// rather than a way past it. `runReduce` grouped committed episodes BY STREAM
// and called Extract once per group: one history-day bundle spanning ~15
// streams meant ~15 extra calls in one tick — the runaway shape the $3/hour
// latch exists to stop, and which did trip on this user's machine. So the
// drain is shaped like every other paying background lane in this tree:
//
//   A LOOKUP BEFORE A CALL. The tick asks the queue first. Nothing pending
//   and nothing to seed → return, zero calls, no log line (P1 rule 14: no new
//   event, no model call). This is the same rule the hourly T2 roll follows.
//
//   BATCHED, NOT PER STREAM. Claimed episodes are packed into as FEW calls as
//   the ceilings allow: up to EXTRACT_BATCH_EPISODES episodes and about
//   EXTRACT_BATCH_EVENTS events per call, filled stream by stream so a batch
//   is coherent but never limited to one stream. Fifteen streams' worth of a
//   day is two or three calls, not fifteen.
//
//   HARD-CAPPED PER TICK. At most EXTRACT_CALLS_PER_TICK calls leave one tick,
//   and the drain runs at most every EXTRACT_INTERVAL_MS. That is a CEILING
//   the arithmetic of which is stated once here: 2 calls per 5 minutes = 24
//   calls an hour, ~6% of the 400/hour ceiling and (at the ~$0.01 an extract
//   pack has measured) ~$0.25 of the $3 hourly budget. A backlog is worked off
//   steadily and legibly instead of in one burst that trips a ceiling.
//
//   THE LATCH IS RESPECTED, NOT ROUTED AROUND. `reportBackgroundHold` is asked
//   BEFORE anything is claimed, so a held drain claims nothing, stamps
//   nothing, records no attempt and dead-letters nothing: the queue is exactly
//   where it was when an operator resumes. Standing down is also LOUD — one
//   `[budget] HELD` line naming this lane.
//
//   THREE STRIKES. A failed batch releases its episodes with one more strike;
//   the third dead-letters them, so a batch that cannot succeed stops costing
//   money while staying countable (`deadLetteredExtractCount`).
//
// After a drain that actually wrote claims, circles are re-inferred — CODE,
// zero model calls (people/circles.ts). It belongs here because it is the
// same starvation: `inferCirclesForUnassigned` had exactly one caller, a
// route nothing in the app calls, so even with claims on disk the People
// circles would have stayed empty.
//
// TWO THINGS THIS SHAPE ACCEPTS, deliberately.
//
//   A GROWING EPISODE IS RE-EXTRACTED WHOLE. An open episode that gains events
//   is re-queued by the next commit and its pack is the whole episode again,
//   not the delta — the pass's `[KNOWN]` block is what keeps the second look
//   from writing the same claim twice. The waste is real and it is bounded by
//   the per-tick ceiling above, which is the trade this file exists to make:
//   a known, capped cost beats a memory that never runs.
//
//   LIVE BEFORE BACKLOG. Rows are claimed best-priority-first, so what just
//   happened is extracted before the history seeded at 'backfill' — a backlog
//   is worked off in the gaps, and never at the expense of today.
// ===========================================================================

import { inferCirclesForUnassigned } from "../people/circles.js";
import { reportBackgroundHold } from "../providers/budget.js";
import type { JsonPassDeps } from "./llm.js";
import { runExtractPass, type ExtractPassResult } from "./extract-pass.js";
import {
  claimExtractBatch,
  deadLetteredExtractCount,
  episodeEventCounts,
  finishExtract,
  pendingExtractCount,
  releaseExtract,
  seedExtractBacklog,
  type ExtractQueueRow,
} from "./extract-queue.js";

/** Episodes packed into ONE extract call. */
export const EXTRACT_BATCH_EPISODES = 6;
/** Events one call's pack aims to stay under (the last episode may cross it). */
export const EXTRACT_BATCH_EVENTS = 120;
/** Calls one tick may spend. The ceiling the cost arithmetic above is based on. */
export const EXTRACT_CALLS_PER_TICK = 2;
/** How often the drain may run — 2 calls / 5 min = 24 calls an hour, at most. */
export const EXTRACT_INTERVAL_MS = 5 * 60_000;
/** Backlog episodes queued per tick. Bounded so the seed is never a long write. */
export const EXTRACT_SEED_LIMIT = 200;

export interface ExtractBatch {
  episodeIds: string[];
  /** Estimated events in the pack (episodeEventCounts). */
  events: number;
  /** Streams the batch spans, in first-seen order. */
  streams: string[];
}

export interface PlanOptions {
  maxEpisodes?: number;
  maxEvents?: number;
  maxCalls?: number;
  /** Estimated event count per episode; missing ids count as 1. */
  sizes?: ReadonlyMap<string, number>;
}

/**
 * Pack claimed rows into at most `maxCalls` batches.
 *
 * Rows arrive best-priority-first. They are walked in that order and grouped
 * by stream so a batch tends to hold one conversation — but a batch that
 * still has room takes the next stream's episodes rather than spending a
 * second call on them. That is the whole point: one bundle across many
 * streams must not be many calls.
 *
 * Pure: no DB, no clock. Rows that do not fit are simply not returned — the
 * caller releases them, and they keep their place in the queue.
 */
export function planExtractBatches(
  rows: readonly ExtractQueueRow[],
  opts: PlanOptions = {},
): ExtractBatch[] {
  const maxEpisodes = Math.max(1, opts.maxEpisodes ?? EXTRACT_BATCH_EPISODES);
  const maxEvents = Math.max(1, opts.maxEvents ?? EXTRACT_BATCH_EVENTS);
  const maxCalls = Math.max(0, opts.maxCalls ?? EXTRACT_CALLS_PER_TICK);
  if (maxCalls === 0 || rows.length === 0) return [];

  // Stream order = first appearance, so priority order survives the grouping.
  const byStream = new Map<string, ExtractQueueRow[]>();
  for (const r of rows) {
    const key = r.streamId ?? "(none)";
    const list = byStream.get(key);
    if (list) list.push(r);
    else byStream.set(key, [r]);
  }
  const ordered: ExtractQueueRow[] = [];
  for (const list of byStream.values()) ordered.push(...list);

  const sizeOf = (id: string): number => Math.max(1, opts.sizes?.get(id) ?? 1);
  const batches: ExtractBatch[] = [];
  let cur: ExtractBatch | null = null;
  for (const row of ordered) {
    const size = sizeOf(row.episodeId);
    if (
      cur !== null &&
      (cur.episodeIds.length >= maxEpisodes || cur.events + size > maxEvents)
    ) {
      batches.push(cur);
      cur = null;
      if (batches.length >= maxCalls) return batches;
    }
    if (cur === null) cur = { episodeIds: [], events: 0, streams: [] };
    cur.episodeIds.push(row.episodeId);
    cur.events += size;
    const stream = row.streamId ?? "(none)";
    if (!cur.streams.includes(stream)) cur.streams.push(stream);
  }
  if (cur !== null && cur.episodeIds.length > 0 && batches.length < maxCalls) batches.push(cur);
  return batches;
}

export type ExtractDrainStatus = "idle" | "held" | "drained";

export interface ExtractDrainReport {
  status: ExtractDrainStatus;
  /** Backlog episodes this tick queued (the upgrade path). */
  seeded: number;
  /** Rows pending when the tick looked, after seeding. */
  pending: number;
  /** Calls this tick spent (repairs included). */
  modelCalls: number;
  batches: number;
  episodes: number;
  claimsWritten: number;
  provisionalPeople: number;
  toneProfiles: number;
  feelings: number;
  /** Batches whose pass did not come back ok/repaired. */
  failedBatches: number;
  deadLettered: number;
  /** People the code-only circle inference placed after claims landed. */
  circlesAssigned: number;
  /** Why nothing ran, when `status` is "held". */
  reason: string | null;
  results: ExtractPassResult[];
}

function emptyReport(status: ExtractDrainStatus, seeded: number, pending: number, reason: string | null): ExtractDrainReport {
  return {
    status,
    seeded,
    pending,
    modelCalls: 0,
    batches: 0,
    episodes: 0,
    claimsWritten: 0,
    provisionalPeople: 0,
    toneProfiles: 0,
    feelings: 0,
    failedBatches: 0,
    deadLettered: 0,
    circlesAssigned: 0,
    reason,
    results: [],
  };
}

export interface ExtractDrainOptions {
  deps?: JsonPassDeps;
  maxCalls?: number;
  maxEpisodes?: number;
  maxEvents?: number;
  /** Backlog rows to seed this tick; 0 disables seeding. */
  seedLimit?: number;
  /** Re-infer circles after a drain that wrote claims (default true). */
  inferCircles?: boolean;
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * One drain: seed, look, hold-check, claim, batch, run, settle.
 *
 * Never throws for a queue reason. A batch that throws is released with a
 * strike, exactly like one that came back failed.
 */
export async function extractDrainTick(opts: ExtractDrainOptions = {}): Promise<ExtractDrainReport> {
  const now = opts.now ?? (() => new Date());
  const maxCalls = Math.max(1, opts.maxCalls ?? EXTRACT_CALLS_PER_TICK);
  const maxEpisodes = Math.max(1, opts.maxEpisodes ?? EXTRACT_BATCH_EPISODES);
  const seedLimit = opts.seedLimit ?? EXTRACT_SEED_LIMIT;

  const seeded = seedExtractBacklog(seedLimit);
  const pending = pendingExtractCount();
  if (pending === 0) return emptyReport("idle", seeded, 0, null);

  // The latch and the kill switch, BEFORE anything is claimed: a held drain
  // leaves the queue untouched (and says so, at most once a minute).
  const hold = reportBackgroundHold("extract", now().getTime(), opts.log);
  if (hold.held) return emptyReport("held", seeded, pending, hold.label);

  const claimed = claimExtractBatch(maxCalls * maxEpisodes);
  if (claimed.length === 0) return emptyReport("idle", seeded, pending, null);

  const sizes = episodeEventCounts(claimed.map((r) => r.episodeId));
  const batches = planExtractBatches(claimed, {
    maxEpisodes,
    ...(opts.maxEvents !== undefined ? { maxEvents: opts.maxEvents } : {}),
    maxCalls,
    sizes,
  });

  // Anything claimed that did not fit a batch goes straight back — with NO
  // strike: it was never attempted.
  const planned = new Set(batches.flatMap((b) => b.episodeIds));
  const unplanned = claimed.map((r) => r.episodeId).filter((id) => !planned.has(id));
  for (const id of unplanned) releaseExtract([id], null);

  const report = emptyReport("drained", seeded, pending, null);
  report.batches = batches.length;

  for (const batch of batches) {
    let result: ExtractPassResult;
    try {
      result = await runExtractPass(batch.episodeIds, opts.deps ?? {});
    } catch (err) {
      const dead = releaseExtract(batch.episodeIds, err instanceof Error ? err.message : String(err));
      report.failedBatches += 1;
      report.deadLettered += dead.length;
      continue;
    }
    report.results.push(result);
    report.modelCalls += result.runIds.length;
    if (result.status === "ok" || result.status === "repaired") {
      finishExtract(batch.episodeIds, now());
      report.episodes += batch.episodeIds.length;
      report.claimsWritten += result.applied.claimsWritten;
      report.provisionalPeople += result.applied.provisionalPeople;
      report.toneProfiles += result.applied.toneProfiles;
      report.feelings += result.applied.feelings;
    } else {
      const dead = releaseExtract(batch.episodeIds, result.error?.message ?? result.status);
      report.failedBatches += 1;
      report.deadLettered += dead.length;
    }
  }

  // Claims landed → the circles they feed can be read. Code only, and only
  // when something was actually written.
  if (report.claimsWritten > 0 && opts.inferCircles !== false) {
    try {
      report.circlesAssigned = inferCirclesForUnassigned().assigned.length;
    } catch {
      /* a circle pass never fails a drain */
    }
  }

  return report;
}

/** One line for the operator log, or null when the tick was silent. */
export function extractDrainLogLine(r: ExtractDrainReport): string | null {
  if (r.status === "idle") {
    return r.seeded > 0
      ? `[extract] backlog: ${r.seeded} episode(s) queued for the memory pass`
      : null;
  }
  if (r.status === "held") {
    return `[extract] ${r.pending} episode(s) waiting — ${r.reason ?? "held"}`;
  }
  const dead = deadLetteredExtractCount();
  return (
    `[extract] ${r.modelCalls} call(s) over ${r.episodes} episode(s): ` +
    `claims=${r.claimsWritten} people=${r.provisionalPeople} tone=${r.toneProfiles} feelings=${r.feelings}` +
    `${r.circlesAssigned > 0 ? ` circles=${r.circlesAssigned}` : ""}` +
    `${r.failedBatches > 0 ? ` failed=${r.failedBatches}` : ""}` +
    `${r.seeded > 0 ? ` seeded=${r.seeded}` : ""}` +
    ` | ${pendingExtractCount()} pending${dead > 0 ? `, ${dead} dead-lettered` : ""}`
  );
}
