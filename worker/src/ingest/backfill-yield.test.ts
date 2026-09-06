// ===========================================================================
// FIX-C4 — the import must not hold the event loop.
//
// THE DEFECT THIS PINS. WhatsApp history arrives ascending, so every historical
// event goes through the descending re-order buffer, which SPILLS at
// `page_hint_events * 20` (adapters/backfill-order.ts). One `pushEvent()` call
// therefore returns twenty cohorts, and ingest used to write all twenty — ten
// thousand synchronous better-sqlite3 inserts — inside the single macrotask
// that delivered the ten-thousandth event.
//
// Node is single-threaded, so for the length of that write nothing else runs.
// Measured on the user's own machine while their WhatsApp import was going:
// one main tab's worth of reads (/api/spaces, /api/timeline, /api/people,
// /api/calendar, fired together) took 15.01 s wall and all four finished
// within 100 ms of each other — four requests parked behind one block of
// synchronous work, not four slow queries (the same count read read-only off
// the same file takes 0.055 s).
//
// WHAT IS ASSERTED. Not a duration — a wall-clock budget would be a flaky test
// on a busy machine and would not name the defect anyway. What is asserted is
// the SHAPE: during a spill the event loop gets a turn between cohorts, so a
// callback queued while the import is landing runs BEFORE the import has
// finished writing. That callback stands in for the HTTP request the user was
// waiting fifteen seconds for. Before the fix it could not run until every row
// was written; a `setImmediate` scheduled at the moment of the spill observed
// the whole spill already on disk.
//
// Ordering is asserted too, because the fix must not buy latency with
// correctness: cohorts are written FIFO, newest first, exactly as the buffer
// produced them.
//
// Zero model calls: no provider, no CLI, no network. A stub adapter and a temp
// database.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SourceAdapter } from "../adapters/source-adapter.js";
import type { SourceManifest } from "../adapters/registry.js";
import type {
  Actor,
  AdapterStatus,
  SourceEvent,
  StatusUpdate,
  Stream,
} from "../adapters/types.js";
import { WHATSAPP_MANIFEST } from "../adapters/whatsapp/manifest.js";
import { closeDb, getDb } from "../db/connection.js";
import { Ingestion } from "./index.js";

/** Small pages, so the spill is 20 cohorts of 5 instead of 20 of 500. */
const PAGE = 5;
/** DescendingCohortBuffer spills at pageHint * 20. */
const SPILL = PAGE * 20;

const SMALL_PAGES: SourceManifest<SourceEvent> = {
  ...WHATSAPP_MANIFEST,
  capabilities: { ...WHATSAPP_MANIFEST.capabilities, page_hint_events: PAGE },
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-yield-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

class StubAdapter implements SourceAdapter {
  readonly sourceId = "whatsapp";
  readonly sourceType = "whatsapp";
  emitEvent: (e: SourceEvent) => void = () => {};
  emitActor: (a: Actor) => void = () => {};
  emitStream: (s: Stream) => void = () => {};
  emitStatus: (s: StatusUpdate) => void = () => {};

  async connect(): Promise<void> {}
  async startPairing(): Promise<void> {}
  async backfill(): Promise<void> {}
  async extend(): Promise<void> {}
  async pause(): Promise<void> {}
  async logout(): Promise<void> {}
  async disconnect(): Promise<void> {}

  onEvent(cb: (e: SourceEvent) => void): void {
    this.emitEvent = cb;
  }
  onStream(cb: (s: Stream) => void): void {
    this.emitStream = cb;
  }
  onActor(cb: (a: Actor) => void): void {
    this.emitActor = cb;
  }
  onStatus(cb: (s: StatusUpdate) => void): void {
    this.emitStatus = cb;
  }
  getStatus(): AdapterStatus {
    return { state: "online", paired: true, paused: false };
  }
}

/** One historical message. `n` orders them in time, oldest first. */
function historical(n: number): SourceEvent {
  return {
    external_id: `alice@x/H${n}`,
    stream_ext_id: "alice@x",
    actor_ext_id: "alice@x",
    // Ascending, exactly as whatsmeow serves history.
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 60_000).toISOString(),
    kind: "message",
    text: `history ${n}`,
    from_me: false,
    is_historical: true,
  };
}

function eventCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
}

/** Wait until the cooperative drain has emptied the queue. */
async function settle(ing: Ingestion): Promise<void> {
  for (let i = 0; i < 200 && ing.queuedCohorts > 0; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

describe("FIX-C4 · the import yields the event loop", () => {
  it("a spill writes one cohort now and lets the loop run before the rest", async () => {
    const adapter = new StubAdapter();
    const ing = new Ingestion(adapter, { manifest: SMALL_PAGES });
    ing.start();

    // Fill the re-order buffer to exactly one event short of the spill: nothing
    // has been handed to the writer yet, so nothing is on disk.
    for (let n = 0; n < SPILL - 1; n += 1) adapter.emitEvent(historical(n));
    expect(eventCount()).toBe(0);

    // The spilling event. Before the fix this single call wrote all 100 rows.
    adapter.emitEvent(historical(SPILL - 1));

    // One cohort landed synchronously — the common case stays a write, not a
    // promise — and the other nineteen are waiting for their turn.
    expect(eventCount()).toBe(PAGE);
    expect(ing.queuedCohorts).toBe(19);

    // THE REGRESSION. A callback queued now stands for the HTTP request the
    // user is waiting on. It must run while rows are still being written.
    const seenWhenLoopRan = await new Promise<number>((resolve) => {
      setImmediate(() => resolve(eventCount()));
    });
    expect(seenWhenLoopRan).toBeLessThan(SPILL);

    await settle(ing);
    ing.flushBackfill();
    await settle(ing);
    expect(eventCount()).toBe(SPILL);
  });

  it("keeps cohort order — newest first, FIFO, nothing overtakes", async () => {
    const adapter = new StubAdapter();
    const ing = new Ingestion(adapter, { manifest: SMALL_PAGES });
    ing.start();

    for (let n = 0; n < SPILL; n += 1) adapter.emitEvent(historical(n));
    await settle(ing);

    // The buffer sorts descending before slicing, so the first cohort written
    // is the newest page: H99..H95. rowid order is write order.
    const written = getDb()
      .prepare(`SELECT external_id AS id FROM events ORDER BY rowid LIMIT ?`)
      .all(PAGE) as { id: string }[];
    expect(written.map((r) => r.id)).toEqual([
      "alice@x/H99",
      "alice@x/H98",
      "alice@x/H97",
      "alice@x/H96",
      "alice@x/H95",
    ]);
    expect(eventCount()).toBe(SPILL);
  });

  it("a small import is still one synchronous write (no behaviour change)", () => {
    const adapter = new StubAdapter();
    const ing = new Ingestion(adapter, { manifest: SMALL_PAGES });
    ing.start();

    for (let n = 0; n < 3; n += 1) adapter.emitEvent(historical(n));
    ing.flushBackfill();

    // Three events are one cohort, written inline: every caller that treats
    // flushBackfill() as "the rows are there now" still gets that.
    expect(eventCount()).toBe(3);
    expect(ing.queuedCohorts).toBe(0);
  });

  it("`backfill_complete` lands every buffered row before import_done is stamped", () => {
    const adapter = new StubAdapter();
    const ing = new Ingestion(adapter, { manifest: SMALL_PAGES });
    ing.start();

    // Enough to fill four cohorts, none of them written yet.
    for (let n = 0; n < PAGE * 4; n += 1) adapter.emitEvent(historical(n));
    expect(eventCount()).toBe(0);

    adapter.emitStatus({ type: "backfill_complete", range: "30d", chats: 1, messages: PAGE * 4 });

    // Synchronously — a queued cohort exists only in memory, so an install
    // killed here must not carry "the import finished" over rows that never
    // landed.
    expect(eventCount()).toBe(PAGE * 4);
    expect(ing.queuedCohorts).toBe(0);
  });
});
