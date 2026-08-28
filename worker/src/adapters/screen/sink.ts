// ===========================================================================
// Screen event sink (build P2.1) — the same seam the browser watcher uses
// (adapters/browser/sink.ts): WHERE envelopes land is behind an interface,
// production goes through db/eventlog.appendEvents() (P0.4 single-writer,
// idempotent by content_hash), and a throwing append buffers (bounded) so
// the adapter never crashes the boot it rode in on.
// ===========================================================================

import { appendEvents, type EventEnvelope } from "../../db/eventlog.js";

export interface ScreenEventSink {
  /** Append idempotently (by contentHash). Returns rows actually written. */
  append(envelopes: readonly EventEnvelope[]): number;
}

/** Test/dev sink: collects everything in memory, deduped by contentHash. */
export class MemoryScreenSink implements ScreenEventSink {
  readonly events: EventEnvelope[] = [];
  private readonly seen = new Set<string>();
  append(envelopes: readonly EventEnvelope[]): number {
    let n = 0;
    for (const e of envelopes) {
      const hash = e.contentHash ?? JSON.stringify(e.payload);
      if (this.seen.has(hash)) continue;
      this.seen.add(hash);
      this.events.push(e);
      n++;
    }
    return n;
  }
}

/** Production sink: the P0.4 single-writer against the shared worker DB. */
export class ScreenEventlogSink implements ScreenEventSink {
  private readonly log: (line: string) => void;
  private buffer: EventEnvelope[] = [];
  private warned = false;
  private static readonly BUFFER_CAP = 20_000;

  constructor(log: (line: string) => void = () => {}) {
    this.log = log;
  }

  get pending(): number {
    return this.buffer.length;
  }

  append(envelopes: readonly EventEnvelope[]): number {
    const batch = [...this.buffer, ...envelopes];
    if (batch.length === 0) return 0;
    this.buffer = [];
    try {
      const r = appendEvents(batch);
      this.warned = false;
      return r.inserted;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.log(
          `[screen] event append failed (buffering for retry): ${(err as Error).message}`,
        );
      }
      this.buffer = batch.slice(-ScreenEventlogSink.BUFFER_CAP);
      return 0;
    }
  }

  /** Retry whatever is buffered. */
  flush(): number {
    return this.append([]);
  }
}
