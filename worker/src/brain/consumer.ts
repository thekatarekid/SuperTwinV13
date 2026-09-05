// ===========================================================================
// The tick consumer (build P1.3, spec §6.3) — the production caller that
// replaces the dispatcher's default sink.
//
// Per bundle: digest lines for content-heavy events (cached per content-hash)
// → pack (§6.4) → ONE Orient call (bundles run concurrently; the provider
// pool's llm lane is the parallelism throttle) → Critic grades the tick's
// writes → commit through the single writer → per-run fidelity stats into the
// run ledger → committed episodes enqueued for the Reduce step (P1.4) →
// markDispatched, which is the ONLY cursor move.
//
// A quarantined Orient call does NOT markDispatched: the cursor never moved,
// so the next tick re-collects the events, and the quarantine row holds the
// story (containment ≥95% is a property of never dropping a bundle on the
// floor).
// ===========================================================================

import type { EventEnvelope } from "../db/eventlog.js";
import { getDb } from "../db/connection.js";
import { markDispatched, type DeltaBundle } from "../scheduler/dispatch.js";
import { ensureDigests, recordContextStats } from "../packer/index.js";
import type { JsonPassDeps } from "./llm.js";
import { runOrient } from "./orient.js";
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
    source: "",
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

  const orientRun = await runOrient(bundle, deps);
  if (!orientRun.output) {
    // Quarantined — the runner parked the unit; the next tick re-collects.
    return {
      bundle,
      status: "quarantined",
      orientRunIds: orientRun.result.runIds,
      criticRunIds: [],
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

  markDispatched(bundle);
  return {
    bundle,
    status: commit.committedEpisodes.length > 0 ? "committed" : "empty",
    commit,
    orientRunIds: orientRun.result.runIds,
    criticRunIds: criticRun.result.runIds,
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
