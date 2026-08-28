// ===========================================================================
// Event sink (build P0.8 → P0.4 seam).
//
// The browser watcher emits spec-§6.1 envelopes; WHERE they land is behind
// this interface. Production wiring targets the v13 `events` table created by
// migration 0100_v13_core (LANE A, concurrent) — coded to the SPEC column
// shape, and guarded: while the migration has not landed (or on an old DB),
// appends buffer in memory and a single warning is logged, so the watcher
// never crashes the boot it rode in on.
//
// Idempotency: append is INSERT-or-skip on `content_hash` — re-reading the
// same history rows next poll writes nothing new.
// ===========================================================================

import type Database from "better-sqlite3";

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

/** Does the open DB have the v13 events table (spec §6.1 columns)? */
export function hasV13EventsTable(db: Database.Database): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    return ["id", "ts", "source", "kind", "origin", "age_band", "stream_key", "roles", "payload", "content_hash"].every(
      (c) => names.has(c),
    );
  } catch {
    return false;
  }
}

/**
 * DB sink writing spec-§6.1 rows into `events`. While the 0100_v13_core table
 * is absent, events buffer (bounded) and one warning is emitted; `flush()`
 * retries the buffer — the watcher calls it each poll, so the backlog drains
 * the moment the migration lands.
 */
export class DbSink implements V13EventSink {
  private readonly db: Database.Database;
  private readonly log: (line: string) => void;
  private buffer: V13Event[] = [];
  private warned = false;
  private static readonly BUFFER_CAP = 50_000;

  constructor(db: Database.Database, log: (line: string) => void = () => {}) {
    this.db = db;
    this.log = log;
  }

  get pending(): number {
    return this.buffer.length;
  }

  append(events: readonly V13Event[]): number {
    if (!hasV13EventsTable(this.db)) {
      if (!this.warned) {
        this.warned = true;
        this.log("[browser] v13 events table not present yet — buffering (0100_v13_core pending)");
      }
      this.buffer.push(...events);
      if (this.buffer.length > DbSink.BUFFER_CAP) {
        this.buffer = this.buffer.slice(this.buffer.length - DbSink.BUFFER_CAP);
      }
      return 0;
    }
    const batch = [...this.buffer, ...events];
    this.buffer = [];
    return this.write(batch);
  }

  flush(): number {
    if (this.buffer.length === 0) return 0;
    return this.append([]);
  }

  private write(events: readonly V13Event[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO events (id, ts, captured_at, source, kind, origin, age_band,
                           stream_key, actor, roles, text, payload, content_hash, blob_refs)
       SELECT @id, @ts, @captured_at, @source, @kind, @origin, @age_band,
              @stream_key, @actor, @roles, @text, @payload, @content_hash, @blob_refs
        WHERE NOT EXISTS (SELECT 1 FROM events WHERE content_hash = @content_hash)`,
    );
    let n = 0;
    const tx = this.db.transaction((evs: readonly V13Event[]) => {
      for (const e of evs) {
        const info = stmt.run({
          id: e.id,
          ts: e.ts,
          captured_at: e.captured_at,
          source: e.source,
          kind: e.kind,
          origin: e.origin,
          age_band: e.age_band,
          stream_key: e.stream_key,
          actor: e.actor,
          roles: JSON.stringify(e.roles),
          text: e.text,
          payload: JSON.stringify(e.payload),
          content_hash: e.content_hash,
          blob_refs: JSON.stringify(e.blob_refs),
        });
        n += info.changes;
      }
    });
    try {
      tx(events);
    } catch (err) {
      // Column drift between the concurrent migration and the spec shape must
      // not crash capture — buffer and warn, exactly like a missing table.
      this.log(`[browser] events append failed (buffering): ${(err as Error).message}`);
      this.buffer.push(...events);
      return 0;
    }
    return n;
  }
}
