// ===========================================================================
// Event sink (build P0.8 → P0.4 seam).
//
// The browser watcher emits spec-§6.1 envelopes; WHERE they land is behind
// this interface. Production wiring goes through db/eventlog.appendEvents()
// — the single-writer append path P0.4 shipped (global conventions §1.4: all
// DB writes via the single-writer; idempotent by content_hash).
//
// EventlogSink stays guarded: if an append throws (e.g. a DB mid-migration),
// the batch buffers in memory (bounded) and is retried on the next poll — the
// watcher never crashes the boot it rode in on.
// ===========================================================================

import { appendEvents, type EventEnvelope } from "../../db/eventlog.js";
import { eventsHighWater, noteCapturedSince } from "../../coverage/index.js";

import type { V13Event } from "./envelope.js";

export interface V13EventSink {
  /** Append events idempotently (by content_hash). Returns rows actually written. */
  append(events: readonly V13Event[]): number;
}

/** Test/dev sink: collects everything in memory. */
export class MemorySink implements V13EventSink {
  readonly events: V13Event[] = [];
  private readonly seen = new Set<string>();
  append(events: readonly V13Event[]): number {
    let n = 0;
    for (const e of events) {
      if (this.seen.has(e.content_hash)) continue;
      this.seen.add(e.content_hash);
      this.events.push(e);
      n++;
    }
    return n;
  }
}

/** Map a browser envelope onto the single-writer's input shape. */
export function toEventEnvelope(e: V13Event): EventEnvelope {
  return {
    id: e.id,
    ts: e.ts,
    capturedAt: e.captured_at,
    source: e.source,
    kind: e.kind,
    origin: e.origin,
    ageBand: e.age_band,
    streamKey: e.stream_key,
    actor: e.actor,
    roles: e.roles,
    // payload.text is the eventlog's FTS projection into events.text.
    payload: { ...(e.payload as unknown as Record<string, unknown>), text: e.text },
    contentHash: e.content_hash,
    blobRefs: e.blob_refs,
  };
}

/**
 * Production sink: the P0.4 single-writer (db/eventlog.ts) against the shared
 * worker DB. A throwing append buffers (bounded) and retries next poll.
 */
export class EventlogSink implements V13EventSink {
  private readonly log: (line: string) => void;
  private buffer: V13Event[] = [];
  private warned = false;
  private static readonly BUFFER_CAP = 50_000;

  constructor(log: (line: string) => void = () => {}) {
    this.log = log;
  }

  get pending(): number {
    return this.buffer.length;
  }

  append(events: readonly V13Event[]): number {
    const batch = [...this.buffer, ...events];
    if (batch.length === 0) return 0;
    this.buffer = [];
    try {
      const before = eventsHighWater();
      const r = appendEvents(batch.map(toEventEnvelope));
      this.warned = false;
      // Coverage index (S2.7): the adapter records which days it captured.
      // Only rows the append actually wrote count — a content-hash duplicate
      // or a gate-dropped envelope wrote nothing. Never unwinds the append.
      if (r.inserted > 0) {
        try {
          noteCapturedSince(before);
        } catch (err) {
          this.log(`[browser] coverage note failed (continuing): ${(err as Error).message}`);
        }
      }
      return r.inserted;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.log(`[browser] event append failed (buffering for retry): ${(err as Error).message}`);
      }
      this.buffer = batch.slice(-EventlogSink.BUFFER_CAP);
      return 0;
    }
  }

  /** Retry whatever is buffered. */
  flush(): number {
    return this.append([]);
  }
}
