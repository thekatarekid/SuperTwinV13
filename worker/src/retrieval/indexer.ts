// The background half of tier 3: keeping the vector index caught up.
//
// Chat turns nudge indexSemanticBatch() too, but 32 events a turn would take
// twenty questions to work through a modest history — and the first turn after
// the user switches the tier on is exactly when the index is emptiest. So this
// drains on its own clock, one batch at a time, and goes back to sleep when
// there is nothing left.
//
// Resumable by construction: the state is the rows in event_embeddings, so a
// quit halfway through costs the batch in flight and nothing else. Nothing here
// blocks a chat turn or the media queue — batches are awaited one at a time on
// a timer, never in a loop that holds the event loop.

import { indexSemanticBatch, DEFAULT_INDEX_BATCH } from "./semantic.js";
import { getEmbedder } from "./embedder.js";
import { runChunker } from "./chunker.js";
import { indexChunkBatch } from "./chunk-index.js";

/** Between batches while there is a backlog. Enough to stay out of the way. */
const BUSY_MS = 250;

/** Between checks once caught up, and while the tier is switched off. */
const IDLE_MS = 60_000;

/** After a failed pass. Long enough that a broken model is not a hot loop. */
const ERROR_MS = 5 * 60_000;

export interface SemanticIndexerOptions {
  batch?: number;
  log?(line: string): void;
}

class SemanticIndexer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private working = false;
  private readonly batch: number;
  private readonly log: (line: string) => void;

  constructor(opts: SemanticIndexerOptions = {}) {
    this.batch = opts.batch ?? DEFAULT_INDEX_BATCH;
    this.log = opts.log ?? ((line) => console.error(line));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Cut a long idle wait short — the model just arrived, or was switched on. */
  wake(): void {
    if (!this.running || this.working) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    // Never the reason the process stays alive.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running || this.working) return;
    this.working = true;
    let next = IDLE_MS;
    try {
      // Asking for the embedder first keeps the switched-off case free: no
      // claim query, no vector read, just a null.
      if (await getEmbedder()) {
        // V6 S2.2: cut what is new into chunks (SQLite only, no model), then
        // give the chunks their vectors. The legacy per-event index keeps
        // filling beside it until the retrieval lanes stop reading it.
        let cut = 0;
        try {
          const r = runChunker();
          cut = r.chatChunks + r.screenChunks + r.browserChunks + r.cardChunks;
        } catch (err) {
          this.log(`[retrieval] chunker pass failed: ${(err as Error).message}`);
        }
        const chunksStored = await indexChunkBatch(this.batch);
        const stored = await indexSemanticBatch(this.batch);
        // A full batch — or a chunker pass that produced work — means there
        // is more behind it.
        next = stored >= this.batch || chunksStored >= this.batch || cut > 0 ? BUSY_MS : IDLE_MS;
      }
    } catch (err) {
      this.log(`[retrieval] index pass failed: ${(err as Error).message}`);
      next = ERROR_MS;
    } finally {
      this.working = false;
    }
    this.schedule(next);
  }
}

let current: SemanticIndexer | null = null;

/** Start the shared indexer. Idempotent — a second call is a no-op. */
export function startSemanticIndexer(opts?: SemanticIndexerOptions): void {
  if (!current) current = new SemanticIndexer(opts);
  current.start();
}

/** Stop it and drop it. Safe when none is running. */
export function stopSemanticIndexer(): void {
  current?.stop();
  current = null;
}

/**
 * Tell a sleeping indexer that its answer may have changed — the tier was
 * switched on, or a download finished. No-op when it is not running.
 */
export function wakeSemanticIndexer(): void {
  current?.wake();
}
