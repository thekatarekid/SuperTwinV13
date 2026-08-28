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
// A quarantined Orient call does NOT markDispatched: the orphan scan re-queues
// the events, and the quarantine row holds the story (containment ≥95% is a
// property of never dropping a bundle on the floor).
// ===========================================================================

import type { EventEnvelope } from "../db/eventlog.js";
import { markDispatched, type DeltaBundle } from "../scheduler/dispatch.js";
import { ensureDigests, recordContextStats } from "../packer/index.js";
import type { JsonPassDeps } from "./llm.js";
import { runOrient } from "./orient.js";
import { runCritic } from "./critic.js";
import { commitTick, type CommitReport } from "./commit.js";
import { enqueueCommitted } from "./reduce.js";

export interface TickReport {
  bundle: DeltaBundle;
  status: "committed" | "quarantined" | "empty";
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
export async function runBrainTick(
  bundle: DeltaBundle,
  deps: JsonPassDeps = {},
): Promise<TickReport> {
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
    // Quarantined — the runner parked the unit; the orphan scan will re-queue.
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
 * The production consumer for startDispatcher({onBundle}) — one Orient call
 * per bundle, concurrent across bundles (the llm pool lane is the throttle),
 * serial per stream by construction (a stream yields one bundle per window,
 * and an unmarked bundle re-collects rather than double-dispatching).
 */
export function startBrainConsumer(
  deps: JsonPassDeps = {},
  log: (line: string) => void = (line) => console.error(line),
): BrainConsumer {
  const inflight = new Set<Promise<void>>();
  return {
    onBundle(bundle: DeltaBundle): void {
      const p = runBrainTick(bundle, deps)
        .then((report) => {
          if (report.status !== "empty") {
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
        .finally(() => inflight.delete(p));
      inflight.add(p);
    },
    async drain(): Promise<void> {
      await Promise.allSettled([...inflight]);
    },
  };
}
