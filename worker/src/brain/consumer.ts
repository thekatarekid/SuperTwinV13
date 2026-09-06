// ===========================================================================
// The tick consumer (build P1.3, spec §6.3) — the production caller that
// replaces the dispatcher's default sink.
//
// Per bundle: digest lines for content-heavy events (cached per content-hash)
// → pack (§6.4) → ONE Orient call (bundles run concurrently; the provider
// pool's llm lane is the parallelism throttle) → Critic grades the tick's
// writes → commit through the single writer → per-run fidelity stats into the
// run ledger → committed episodes enqueued for the Reduce step (P1.4) →
// markDispatchedEvents over the HANDLED events, which is the ONLY cursor move.
//
// Per-item salvage (V6 P1 S3.1, T2-7): the commit reports which bundle events
// it handled and which it held (a rejected item's). Only handled events are
// stamped; the cursor advances on event ids, and the held rows are
// re-collected by the next tick. The same held set failing three times is
// dead-lettered (Product P1 §9.5) and stamped so it stops cycling.
//
// A quarantined Orient call does NOT mark anything: the cursor never moved,
// so the next tick re-collects the events, and the quarantine row holds the
// story (containment ≥95% is a property of never dropping a bundle on the
// floor).
// ===========================================================================

import type { EventEnvelope } from "../db/eventlog.js";
import { getDb } from "../db/connection.js";
import { markDispatchedEvents, type DeltaBundle } from "../scheduler/v6/bundle.js";
import { clearBundleAttempts, noteBundleAttempt } from "../db/v6core.js";
import { ensureDigests, recordContextStats } from "../packer/index.js";
import type { JsonPassDeps } from "./llm.js";
import { runOrient, type OrientRun } from "./orient.js";
import { applyLiveDecide, runLive, type LiveApplyReport, type LiveOutput, type LiveRun } from "./live.js";
import { activeLivePrompt } from "../prompts/versions.js";
import type { PackOptions } from "../packer/index.js";
import { runCritic } from "./critic.js";
import { commitTick, type CommitReport } from "./commit.js";
import { enqueueCommitted } from "./reduce.js";

export interface TickReport {
  bundle: DeltaBundle;
  /**
   * `stale`: the bundle's rows were already marked dispatched between enqueue
   * and run (S0.3 / T0-3, BND-10) — the tick returned before any model call.
   */
  status: "committed" | "quarantined" | "empty" | "stale";
  commit?: CommitReport;
  orientRunIds: string[];
  criticRunIds: string[];
  /**
   * V6 S4.1: the live pass ran (live.v1) and this is what its decide half did
   * — tasks/closures/schedules applied, prepared actions persisted / dropped.
   * Absent on history bundles and when the live pass is switched off.
   */
  live?: LiveApplyReport;
}

export interface TickOptions {
  /** Packer options (clock, thin policy) — tests and the eval executors. */
  packOpts?: PackOptions;
}

/**
 * The source a bundle event came from (V6 S1.6 / T6-7 — this used to be ""
 * on every envelope the consumer built): the row's source_id, else the
 * `<source>:st:<key>` stream-id scheme both funnels mint.
 */
export function bundleEventSource(bundle: DeltaBundle, e: { sourceId?: string | null }): string {
  if (e.sourceId) return e.sourceId;
  const i = bundle.streamId.indexOf(":st:");
  return i > 0 ? bundle.streamId.slice(0, i) : "";
}

function toEnvelope(bundle: DeltaBundle, i: number): EventEnvelope {
  const e = bundle.events[i];
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(e.payloadJson ?? "{}") as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return {
    id: e.id,
    ts: e.ts ?? "",
    source: bundleEventSource(bundle, e),
    kind: e.kind ?? "",
    origin: e.origin,
    ageBand: e.ageBand,
    streamKey: bundle.streamKey,
    actor: e.actor ?? "?",
    roles: { sender: e.actor ?? "?", audience: [], receiver: [], mentions: [] },
    payload,
  };
}

/**
 * One full tick for one bundle: digest → pack → Orient → Critic → commit →
 * mark. Exported directly for tests and the eval executors; startBrainConsumer
 * wires it under the dispatcher.
 */
/**
 * Bundle identity for the in-flight registry (T0-2): the same rows submitted
 * twice — two ticks over a slow run, or any future re-dispatch path — must
 * cost one model call, not two.
 */
export function bundleKey(bundle: DeltaBundle): string {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const e of bundle.events) {
    if (e.rowid < min) min = e.rowid;
    if (e.rowid > max) max = e.rowid;
  }
  if (!Number.isFinite(min)) min = 0;
  return `${bundle.streamId}:${min}-${max}`;
}

/**
 * Re-validate at execution time (T0-3): a bundle that sat in the queue may
 * have been dispatched by another path in the meantime. Any event already
 * stamped makes the bundle stale — the still-unmarked remainder (if any) is
 * re-collected by the next tick as a fresh bundle.
 */
export function isBundleStale(bundle: DeltaBundle): boolean {
  if (bundle.events.length === 0) return true;
  const stmt = getDb().prepare(
    `SELECT dispatched_at FROM events WHERE rowid = ?`,
  );
  for (const e of bundle.events) {
    const row = stmt.get(e.rowid) as { dispatched_at: string | null } | undefined;
    if (!row || row.dispatched_at !== null) return true;
  }
  return false;
}

export async function runBrainTick(
  bundle: DeltaBundle,
  deps: JsonPassDeps = {},
  opts: TickOptions = {},
): Promise<TickReport> {
  // Execution-time revalidation (S0.3 / T0-3, BND-10) — before the digest
  // step, which is the first thing that can reach a model.
  if (isBundleStale(bundle)) {
    return { bundle, status: "stale", orientRunIds: [], criticRunIds: [] };
  }

  // Digest lines at intake (spec §4.5.1): cached per unique content-hash, so
  // a re-queued bundle pays nothing.
  try {
    await ensureDigests(
      bundle.events.map((_, i) => toEnvelope(bundle, i)),
      deps,
    );
  } catch (err) {
    console.error("[brain] digest generation failed (continuing):", err);
  }

  // V6 S4.1: a live bundle runs live.v1 — ONE call that understands and
  // decides. History keeps orient (no decide section; any stray decide key is
  // ignored by the orient parser). Off-switch: SUPERTWIN_PROMPT_LIVE=off.
  const livePrompt = bundle.lane === "live" ? activeLivePrompt() : null;
  const orientRun: OrientRun | LiveRun = livePrompt
    ? await runLive(bundle, deps, opts.packOpts ?? {}, livePrompt)
    : await runOrient(bundle, deps, opts.packOpts ?? {});
  const liveOut: LiveOutput | undefined = livePrompt ? (orientRun as LiveRun).live : undefined;
  if (!orientRun.output) {
    // Understanding quarantined — the runner parked the unit; the next tick
    // re-collects. A valid decide half still runs (LIV-05): its prepared
    // actions are grounded in this bundle's events and dedupe by content key,
    // so the re-collected bundle cannot mint them twice.
    let live: LiveApplyReport | undefined;
    if (liveOut?.decide) {
      live = applyLiveDecide({
        bundle,
        live: liveOut,
        aliases: orientRun.packed.eventAliases,
        commit: null,
        runId: orientRun.result.runIds[0] ?? null,
        now: deps.now?.() ?? new Date(),
      });
    }
    return {
      bundle,
      status: "quarantined",
      orientRunIds: orientRun.result.runIds,
      criticRunIds: [],
      ...(live ? { live } : {}),
    };
  }

  const criticRun = await runCritic(orientRun, deps);
  // A quarantined Critic must not stall the lane forever: flags don't block,
  // and the Critic exists to REMOVE bad writes — with no verdicts, everything
  // Orient said commits as-is (the same behaviour as "removable if evals ever
  // show zero lift").
  const critic = criticRun.output ?? { verdicts: [] };

  const commit = commitTick({
    bundle,
    orient: orientRun.output,
    critic,
    aliases: orientRun.packed.eventAliases,
    streamAliases: orientRun.packed.streamAliases,
    runId: orientRun.result.runIds[0] ?? null,
  });

  // Per-run fidelity accounting (spec §4.5.4).
  const runId = orientRun.result.runIds[0];
  if (runId) {
    try {
      recordContextStats(runId, orientRun.packed.serveCounters);
    } catch {
      /* the metric never fails the tick */
    }
  }

  // Reduce step intake (P1.4): committed episodes, grouped by space there.
  try {
    enqueueCommitted(commit.committedEpisodes, bundle.lane === "live" ? "live" : "backfill");
  } catch (err) {
    console.error("[brain] reduce enqueue failed (continuing):", err);
  }

  // V6 S4.1: the decide half — after the commit so tasks can land in the
  // space the understanding just touched. A bad decide never blocks the
  // commit above (it is logged inside applyLiveDecide and dropped).
  let live: LiveApplyReport | undefined;
  if (liveOut) {
    try {
      live = applyLiveDecide({
        bundle,
        live: liveOut,
        aliases: orientRun.packed.eventAliases,
        commit,
        runId: runId ?? null,
        now: deps.now?.() ?? new Date(),
      });
    } catch (err) {
      console.error("[brain] live decide apply failed (continuing):", err);
    }
  }

  // Cursor on event ids: stamp what committed (plus the uncovered, flagged
  // rows); hold the rejected items' rows for the next tick — three strikes on
  // the same held set dead-letters it and stamps it too.
  let toMark = commit.handledEventIds;
  if (commit.heldEventIds.length > 0) {
    const held = new Set(commit.heldEventIds);
    const rows = bundle.events.filter((e) => held.has(e.id));
    const ref = {
      streamId: bundle.streamId,
      minRowid: Math.min(...rows.map((e) => e.rowid)),
      maxRowid: Math.max(...rows.map((e) => e.rowid)),
    };
    const attempt = noteBundleAttempt(ref, {
      error: commit.rejections
        .filter((r) => r.eventIds.some((id) => held.has(id)))
        .map((r) => `${r.reason}: ${r.detail}`)
        .join(" · ")
        .slice(0, 500),
    });
    if (attempt.deadLetterAt) toMark = [...toMark, ...rows.map((e) => e.id)];
  } else {
    clearBundleAttempts({
      streamId: bundle.streamId,
      minRowid: Math.min(...bundle.events.map((e) => e.rowid)),
      maxRowid: Math.max(...bundle.events.map((e) => e.rowid)),
    });
  }
  markDispatchedEvents(bundle, toMark);
  return {
    bundle,
    status: commit.committedEpisodes.length > 0 ? "committed" : "empty",
    commit,
    orientRunIds: orientRun.result.runIds,
    criticRunIds: criticRun.result.runIds,
    ...(live ? { live } : {}),
  };
}

export interface BrainConsumer {
  /** The dispatcher sink: fire-and-track, parallel via the provider pool. */
  onBundle: (bundle: DeltaBundle) => void;
  /** Settle every in-flight tick (tests, shutdown). */
  drain: () => Promise<void>;
}

/**
 * The production consumer for runDispatchTick({onBundle}) — one Orient call
 * per bundle, concurrent across bundles (the llm pool lane is the throttle),
 * serial per stream by construction (a stream yields one bundle per window,
 * and an unmarked bundle re-collects rather than double-dispatching).
 */
export function startBrainConsumer(
  deps: JsonPassDeps = {},
  log: (line: string) => void = (line) => console.error(line),
): BrainConsumer {
  // Keyed by streamId:minRowid-maxRowid (S0.3 / T0-2, BND-09): a live key
  // is a no-op resubmission, never a second model call.
  const inflight = new Map<string, Promise<void>>();
  return {
    onBundle(bundle: DeltaBundle): void {
      const key = bundleKey(bundle);
      if (inflight.has(key)) return;
      const p = runBrainTick(bundle, deps)
        .then((report) => {
          if (report.status !== "empty" && report.status !== "stale") {
            log(
              `[brain] tick ${bundle.streamKey}: ${report.status}` +
                (report.commit
                  ? ` (${report.commit.committedEpisodes.length} ep, ` +
                    `${report.commit.createdSpaces.length} proposed, ` +
                    `${report.commit.unsorted} unsorted)`
                  : ""),
            );
          }
        })
        .catch((err) => log(`[brain] tick failed for ${bundle.streamKey}: ${err}`))
        .finally(() => {
          if (inflight.get(key) === p) inflight.delete(key);
        });
      inflight.set(key, p);
    },
    async drain(): Promise<void> {
      await Promise.allSettled([...inflight.values()]);
    },
  };
}
