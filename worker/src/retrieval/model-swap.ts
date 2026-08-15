// Swapping the embedding model without ever going dark.
//
// event_embeddings holds ONE row per event, keyed by event_id, tagged with the
// (model, dim) that produced it. That shape makes a mixed index impossible —
// two models cannot both own a row — but it also means the naive swap
// (re-embed in place, one batch at a time) DELETES the old index as it builds
// the new one. Halfway through, chat would be searching a third of the corpus
// and reporting nothing for the rest.
//
// So the swap is built the other way round:
//
//   1. Load the NEW model beside the old one. The active embedder is untouched;
//      every question asked during the swap is still answered by the old index.
//   2. Embed the whole corpus into MEMORY, in batches, reporting progress.
//      Nothing is written. A cancel, a crash or a failed load costs the work
//      and nothing else — the old index is exactly as it was.
//   3. FLIP, in one SQLite transaction: drop every old vector, insert every new
//      one, and move the active-model pointer. Either all of that happened or
//      none of it did, so there is no instant in which the index holds two
//      models' vectors and no instant in which the pointer names a model the
//      index does not hold.

import type { Database as Db } from "better-sqlite3";

import { getDb } from "../db/connection.js";
import { encodeVector, MIN_EMBEDDABLE_CHARS } from "../db/embeddings.js";
import {
  activeEmbeddingModel,
  findEmbeddingModel,
  setActiveEmbeddingModelId,
  type EmbeddingModelSpec,
} from "./model-registry.js";
import {
  embeddingModelPresent,
  forgetEmbedder,
  loadEmbedderFor,
  type Embedder,
} from "./embedder.js";
import { embeddableText } from "./semantic.js";
import { wakeSemanticIndexer } from "./indexer.js";

/** Events embedded per pass. Small enough that a cancel is felt immediately. */
export const SWAP_BATCH = 32;

export type SwapPhase = "embedding" | "flipping" | "done" | "error" | "cancelled";

/** What the Settings card polls while a swap is running. */
export interface EmbeddingSwapState {
  fromModel: string;
  toModel: string;
  phase: SwapPhase;
  /** Events to re-embed, and how many are done. */
  total: number;
  embedded: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

interface SwapRun extends EmbeddingSwapState {
  cancelled: boolean;
}

export interface SwapOptions {
  /** Test seam: build the candidate embedder without the ONNX runtime. */
  loadEmbedder?(spec: EmbeddingModelSpec): Promise<Embedder>;
  batch?: number;
}

let run: SwapRun | null = null;

function publicState(s: SwapRun): EmbeddingSwapState {
  const { cancelled: _cancelled, ...rest } = s;
  return { ...rest };
}

/** The swap in flight, or the last one's outcome. Null before the first. */
export function embeddingSwapState(): EmbeddingSwapState | null {
  return run ? publicState(run) : null;
}

/** True while a swap is building an index. */
export function embeddingSwapRunning(): boolean {
  return run?.phase === "embedding" || run?.phase === "flipping";
}

/**
 * Ask the running swap to stop. It stops between batches, having written
 * nothing — the old index is still the index.
 */
export function cancelEmbeddingSwap(): boolean {
  if (!embeddingSwapRunning() || !run) return false;
  run.cancelled = true;
  return true;
}

/**
 * Start re-embedding the corpus on `targetId`. Returns the initial state; the
 * work continues in the background and is polled off the state above.
 *
 * Throws only on things that are wrong with the REQUEST — an id that is not in
 * the catalogue, a model whose weights are not on disk, a swap already running.
 */
export function startEmbeddingSwap(
  targetId: string,
  opts: SwapOptions = {},
): EmbeddingSwapState {
  if (embeddingSwapRunning()) {
    throw new Error(`a swap to ${run!.toModel} is already running`);
  }
  const target = findEmbeddingModel(targetId);
  if (!target) throw new Error(`unknown embedding model: ${targetId}`);
  if (!embeddingModelPresent(target)) {
    throw new Error(`${target.id} is not downloaded yet`);
  }
  const from = activeEmbeddingModel();

  const started: SwapRun = {
    fromModel: from.id,
    toModel: target.id,
    phase: "embedding",
    total: countEmbeddable(),
    embedded: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    cancelled: false,
  };
  run = started;
  void execute(target, started, opts);
  return publicState(started);
}

async function execute(
  target: EmbeddingModelSpec,
  state: SwapRun,
  opts: SwapOptions,
): Promise<void> {
  try {
    const load = opts.loadEmbedder ?? loadEmbedderFor;
    const embedder = await load(target);
    if (embedder.dim !== target.dim) {
      throw new Error(
        `${target.id} produced ${embedder.dim} dimensions, expected ${target.dim}`,
      );
    }

    const batchSize = opts.batch ?? SWAP_BATCH;
    const rows = readCorpus();
    state.total = rows.length;

    // The whole new index, held in memory until it is complete. At 3,900
    // events and 768 dimensions that is 12 MB — cheaper than the alternative,
    // which is a half-built index that search is already reading from.
    const built: { eventId: string; vector: Float32Array }[] = [];

    for (let i = 0; i < rows.length; i += batchSize) {
      if (state.cancelled) {
        finish(state, "cancelled", null);
        return;
      }
      const slice = rows.slice(i, i + batchSize);
      const vectors = await embedder.embed(
        slice.map((r) => r.text),
        "passage",
      );
      if (vectors.length !== slice.length) {
        throw new Error(
          `${target.id} returned ${vectors.length} vectors for ${slice.length} messages`,
        );
      }
      for (let j = 0; j < slice.length; j++) {
        built.push({ eventId: slice[j].id, vector: vectors[j] });
      }
      state.embedded = built.length;
    }

    if (state.cancelled) {
      finish(state, "cancelled", null);
      return;
    }

    state.phase = "flipping";
    flip(target, built);
    // Whatever was loaded answers in the OLD space; the next question has to
    // load the new one.
    forgetEmbedder();
    // The vector cache keys on (model, dim), so the flip invalidates it by
    // itself — there is nothing to clear.
    wakeSemanticIndexer();
    finish(state, "done", null);
  } catch (err) {
    finish(state, "error", err instanceof Error ? err.message : String(err));
  }
}

function finish(state: SwapRun, phase: SwapPhase, error: string | null): void {
  state.phase = phase;
  state.error = error;
  state.finishedAt = new Date().toISOString();
}

/**
 * The atomic half. One transaction, so there is no readable moment in which
 * two models own vectors in the same table.
 */
function flip(
  target: EmbeddingModelSpec,
  built: readonly { eventId: string; vector: Float32Array }[],
): void {
  const db: Db = getDb();
  const insert = db.prepare(`
    INSERT INTO event_embeddings (event_id, model, dim, vector, indexed_at)
    VALUES (@eventId, @model, @dim, @vector, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(event_id) DO UPDATE SET
      model      = excluded.model,
      dim        = excluded.dim,
      vector     = excluded.vector,
      indexed_at = excluded.indexed_at
  `);
  const clearEvents = db.prepare(`DELETE FROM event_embeddings`);

  const tx = db.transaction(() => {
    clearEvents.run();
    for (const row of built) {
      if (row.vector.length !== target.dim) {
        throw new Error(
          `vector for ${row.eventId} has ${row.vector.length} dimensions, expected ${target.dim}`,
        );
      }
      insert.run({
        eventId: row.eventId,
        model: target.id,
        dim: target.dim,
        vector: encodeVector(row.vector),
      });
    }
    setActiveEmbeddingModelId(target.id);
  });
  tx();
}

// ---- Reading the corpus ---------------------------------------------------
//
// The predicate below MIRRORS db/embeddings.ts's HAS_EMBEDDABLE_TEXT, which is
// not exported. `model-swap.test.ts` asserts this count equals
// countEmbeddableEvents(), so the two cannot drift apart quietly.

const EMBEDDABLE = /* sql */ `
  e.kind IS NOT 'reaction'
  AND e.revoked_at IS NULL
  AND LENGTH(
         TRIM(COALESCE(e.text, ''))
      || TRIM(COALESCE(e.media_description, ''))
      || TRIM(COALESCE(e.transcript, ''))
      || TRIM(COALESCE(e.link_title, ''))
      || TRIM(COALESCE(e.link_description, ''))
  ) >= ${MIN_EMBEDDABLE_CHARS}
`;

export interface CorpusRow {
  id: string;
  text: string;
}

/** How many events a swap has to re-embed. */
export function countEmbeddable(): number {
  try {
    return (
      getDb().prepare(`SELECT COUNT(*) AS n FROM events e WHERE ${EMBEDDABLE}`).get() as {
        n: number;
      }
    ).n;
  } catch {
    return 0;
  }
}

/**
 * Every embeddable event with the text that gets embedded, newest first.
 * Composed by the same function the incremental indexer uses, so a swapped
 * index and an incrementally built one hold the same vectors.
 */
export function readCorpus(limit?: number): CorpusRow[] {
  const rows = getDb()
    .prepare(
      `SELECT
         e.id                AS id,
         e.ts                AS ts,
         e.channel_id        AS channelId,
         e.kind              AS kind,
         e.text              AS text,
         e.media_description AS mediaDescription,
         e.transcript        AS transcript,
         e.link_title        AS linkTitle,
         e.link_description  AS linkDescription,
         e.reply_to_text     AS replyToText
       FROM events e
       WHERE ${EMBEDDABLE}
       ORDER BY e.ts DESC, e.id DESC
       ${limit && limit > 0 ? `LIMIT ${Math.floor(limit)}` : ""}`,
    )
    .all() as Parameters<typeof embeddableText>[0][];
  return rows.map((row) => ({
    id: row.id,
    // Every row leaves with a vector, even the one whose text is twelve
    // newlines — a row with no text would otherwise be re-claimed forever.
    text: embeddableText(row) || (row.kind ?? "message"),
  }));
}

/** Test hook: forget the last swap. */
export function resetEmbeddingSwapForTests(): void {
  run = null;
}
