// ===========================================================================
// The REDUCE step (build P1.4, spec §6.3): group committed episodes BY SPACE,
// then run Decide per space and Extract per affected-people group — parallel
// ACROSS spaces, serial PER space (the decide_queue's 'running' status is the
// per-space lock; the queue's merge-in is the "max one entry per space" rule).
//
// The MAP half (Orient) and the GATE (Critic) are Lane A's (build P1.3); this
// module is what runs after their commit. Production caller: the consolidation
// job (worker/src/consolidation/job.ts) drains the queue every minute — the
// Gates-phase tick wiring calls runReduce directly on commit.
// ===========================================================================

import { enqueueDecide, claimDecideBatch, finishDecide, releaseDecide, type DecidePriority } from "./decide-queue.js";
import { emptyDecideApplied, runDecidePass, type DecidePassResult } from "./decide-pass.js";
import { runExtractPass, type ExtractPassResult } from "./extract-pass.js";
import type { JsonPassDeps } from "./llm.js";
import { getDb } from "../db/connection.js";

export interface CommittedEpisode {
  episodeId: string;
  spaceId: string | null;
  streamId?: string | null;
}

export interface ReduceReport {
  enqueuedSpaces: number;
  decided: { spaceId: string; result: DecidePassResult }[];
  extracted: ExtractPassResult[];
}

/** Group committed episodes by space and merge them into the Decide queue. */
export function enqueueCommitted(
  episodes: readonly CommittedEpisode[],
  priority: DecidePriority = "live",
): number {
  const bySpace = new Map<string, string[]>();
  for (const ep of episodes) {
    if (ep.spaceId === null) continue; // unsorted episodes have no Decide space
    const list = bySpace.get(ep.spaceId) ?? [];
    list.push(ep.episodeId);
    bySpace.set(ep.spaceId, list);
  }
  for (const [spaceId, ids] of bySpace) enqueueDecide(spaceId, ids, priority);
  return bySpace.size;
}

/**
 * Drain up to `limit` queued spaces: parallel across spaces, serial per space
 * (each claimed row is that space's lock; merge-ins during the run survive via
 * finishDecide). A failed run releases its claim instead of losing it.
 */
export async function drainDecideQueue(
  deps: JsonPassDeps = {},
  limit = 4,
): Promise<{ spaceId: string; result: DecidePassResult }[]> {
  const batch = claimDecideBatch(limit);
  const results = await Promise.all(
    batch.map(async (row) => {
      try {
        const result = await runDecidePass(row.spaceId, row.episodeIds, deps);
        if (result.status === "ok" || result.status === "repaired") {
          finishDecide(row.spaceId, row.episodeIds);
        } else {
          releaseDecide(row.spaceId);
        }
        return { spaceId: row.spaceId, result };
      } catch (err) {
        releaseDecide(row.spaceId);
        return {
          spaceId: row.spaceId,
          result: {
            status: "failed",
            applied: emptyDecideApplied(),
            runIds: [],
            error: { code: "reduce_throw", message: err instanceof Error ? err.message : String(err) },
          } satisfies DecidePassResult,
        };
      }
    }),
  );
  return results;
}

/** P1 affected-people grouping: a stream is its people. */
function groupByStream(episodes: readonly CommittedEpisode[]): string[][] {
  const db = getDb();
  const byStream = new Map<string, string[]>();
  for (const ep of episodes) {
    let stream = ep.streamId ?? null;
    if (stream === undefined || stream === null) {
      const row = db.prepare(`SELECT stream_id FROM episodes WHERE id = ?`).get(ep.episodeId) as
        | { stream_id: string | null }
        | undefined;
      stream = row?.stream_id ?? null;
    }
    const key = stream ?? "(none)";
    const list = byStream.get(key) ?? [];
    list.push(ep.episodeId);
    byStream.set(key, list);
  }
  return [...byStream.values()];
}

/**
 * The whole reduce for one tick's committed episodes: enqueue + drain Decide
 * (per space) and run Extract per affected-people group, in parallel groups.
 */
export async function runReduce(
  episodes: readonly CommittedEpisode[],
  deps: JsonPassDeps = {},
): Promise<ReduceReport> {
  const enqueuedSpaces = enqueueCommitted(episodes);
  const [decided, extracted] = await Promise.all([
    drainDecideQueue(deps),
    Promise.all(groupByStream(episodes).map((group) => runExtractPass(group, deps))),
  ]);
  return { enqueuedSpaces, decided, extracted };
}
