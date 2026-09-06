// ===========================================================================
// Library latency budgets — V6 P1 S6d L1.
//
// The user reported all four Library sub-tabs showing their empty state and
// then freezing, "sometimes a minute", while a WhatsApp history import ran.
// Measured against their running app (36,830 messages, a 1.05 GB database, an
// import in flight):
//
//   GET /api/library/chats?source=whatsapp   13.97 s
//   GET /api/sources/whatsapp/counts          9.17 s (503)
//   GET /api/sources/browser/discover         9.76 s
//   GET /api/library/browser                  7.00 s
//   GET /api/library/storage                  3.37 s
//   GET /api/library/screen                   2.86 s
//
// This suite is the rail that keeps them fast. It seeds a 160,200-event corpus
// — larger than the user's real log — runs a writer loop shaped like the
// importer, and holds every endpoint to a budget. It asserts TWO things,
// because a wall-clock budget alone is a weak regression on a fast machine:
//
//   1. LATENCY, under a writer loop. The coarse guard.
//   2. QUERY PLANS. Every hot statement must be answered from an index; a
//      `SCAN events` in any of them is the defect that produced the numbers
//      above, and that assertion holds on any machine at any speed.
//
// Zero model calls. Runs on a scratch db path; nothing here touches a home.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { handleLibraryRoute } from "../server/library-routes.js";
import { handleLibraryStorageRoute } from "../server/library-storage-routes.js";
import { seedCorpus, TEST_CORPUS } from "./perf-corpus.js";
import { invalidateStorageSnapshot } from "./storage.js";

/**
 * One second, wall clock, with an importer running. Generous on purpose: the
 * suite shares a machine with whatever else is building, and the point of the
 * number is to catch a return to SECONDS, not to police milliseconds. The plan
 * assertions below are the sharp edge.
 */
const BUDGET_MS = 1_000;
/**
 * A snapshot-served answer does no measuring at all. The sharp assertion is
 * that `as_of` did not move; this is the coarse one, and it is deliberately
 * loose because the suite runs alongside ~100 other files.
 */
const SNAPSHOT_BUDGET_MS = 400;

let tmpDir: string;
let server: Server;
let base: string;
let writerSeq = 0;
let writing = false;

/** The importer's shape: a steady trickle of single-row writes on the one handle. */
function startWriter(): () => void {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO events (id, source_id, source_type, stream_id, stream_key, actor, ts, captured_at,
                         kind, text, payload_json, origin, dispatched_at, external_id, content_hash, created_at)
     VALUES (@id, 'whatsapp', 'whatsapp', @streamId, @streamKey, 'self', @ts, @ts,
             'wa.message', @text, @payloadJson, 'live', @ts, @externalId, @contentHash, @ts)`,
  );
  writing = true;
  const pump = (): void => {
    if (!writing) return;
    for (let i = 0; i < 25; i++) {
      const k = writerSeq++;
      const ts = new Date().toISOString();
      const text = `imported message ${k} with a body long enough that the row is not free`;
      ins.run({
        id: `ev_imp_${k}`,
        streamId: `whatsapp:st:chat${k % 100}`,
        streamKey: `chat${k % 100}@s.whatsapp.net`,
        ts,
        text,
        payloadJson: JSON.stringify({ text, from_me: false }),
        externalId: `imp_${k}`,
        contentHash: `h_imp_${k}`,
      });
    }
    // setTimeout, not setImmediate: a tight setImmediate loop starves the I/O
    // phase completely, which starves vitest's own RPC as well as the request
    // under test. A burst then a yield is also what the real importer does —
    // it is driven by the daemon's stdout arrivals.
    setTimeout(pump, 0);
  };
  setTimeout(pump, 0);
  return () => {
    writing = false;
  };
}

async function timeGet(path: string): Promise<{ ms: number; body: unknown }> {
  const started = process.hrtime.bigint();
  const res = await fetch(base + path);
  const body = (await res.json()) as unknown;
  expect(res.status).toBe(200);
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, body };
}

/** The `detail` lines SQLite reports for a statement, joined. */
function plan(sql: string, ...params: unknown[]): string {
  return (
    getDb()
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(params as never[])) as { detail: string }[]
  )
    .map((r) => r.detail)
    .join(" | ");
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-library-perf-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  seedCorpus(TEST_CORPUS);
  invalidateStorageSnapshot();
  server = createServer((req, res) => {
    void (async () => {
      if (await handleLibraryStorageRoute(req, res)) return;
      if (await handleLibraryRoute(req, res)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
    })();
  });
  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}, 300_000);

afterAll(async () => {
  writing = false;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Library endpoints on a 160k-event corpus, with an import running", () => {
  it("seeded a corpus larger than the log the user reported on", () => {
    const n = (getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    expect(n).toBeGreaterThan(150_000);
  });

  it("answers /api/library/chats inside the budget", async () => {
    const stop = startWriter();
    try {
      await timeGet("/api/library/chats?source=whatsapp"); // warm
      const { ms, body } = await timeGet("/api/library/chats?source=whatsapp");
      const payload = body as { streams: unknown[]; total: number; event_count: number };
      expect(payload.streams.length).toBe(TEST_CORPUS.streams);
      expect(payload.total).toBe(TEST_CORPUS.streams);
      expect(payload.event_count).toBeGreaterThan(TEST_CORPUS.whatsapp - 1);
      expect(ms, `/api/library/chats took ${ms.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
    } finally {
      stop();
    }
  });

  it("pages the chat list when asked, without re-reading the whole inbox", async () => {
    const { body } = await timeGet("/api/library/chats?source=whatsapp&limit=25");
    const payload = body as { streams: { last_ts: string | null }[]; total: number };
    expect(payload.streams.length).toBe(25);
    expect(payload.total).toBe(TEST_CORPUS.streams);
    // Newest-first is the inbox's whole contract.
    const stamps = payload.streams.map((s) => s.last_ts ?? "");
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });

  it("answers /api/library/browser inside the budget", async () => {
    const stop = startWriter();
    try {
      await timeGet("/api/library/browser");
      const { ms, body } = await timeGet("/api/library/browser");
      const payload = body as { chains: unknown[]; event_count: number };
      expect(payload.chains.length).toBeGreaterThan(0);
      expect(payload.event_count).toBeGreaterThan(TEST_CORPUS.browserVisits - 1);
      expect(ms, `/api/library/browser took ${ms.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
    } finally {
      stop();
    }
  });

  it("answers /api/library/screen inside the budget", async () => {
    const stop = startWriter();
    try {
      const day = new Date().toISOString().slice(0, 10);
      await timeGet(`/api/library/screen?day=${day}`);
      const { ms, body } = await timeGet(`/api/library/screen?day=${day}`);
      expect((body as { event_count: number }).event_count).toBeGreaterThan(0);
      expect(ms, `/api/library/screen took ${ms.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
    } finally {
      stop();
    }
  });

  it("measures storage once and serves the snapshot afterwards", async () => {
    invalidateStorageSnapshot();
    const cold = await timeGet("/api/library/storage");
    const payload = cold.body as { sources: { source: string; searchable: { bytes: number } }[]; as_of: string };
    const wa = payload.sources.find((s) => s.source === "whatsapp");
    expect(wa, "the corpus's whatsapp rows are counted").toBeTruthy();
    expect(wa?.searchable.bytes).toBeGreaterThan(0);

    const stop = startWriter();
    try {
      const warm = await timeGet("/api/library/storage");
      // The measurement was NOT re-taken: same stamp, so the same scan.
      expect((warm.body as { as_of: string }).as_of).toBe(payload.as_of);
      expect(
        warm.ms,
        `snapshot-served storage took ${warm.ms.toFixed(0)} ms against a ${cold.ms.toFixed(0)} ms measure`,
      ).toBeLessThan(Math.max(SNAPSHOT_BUDGET_MS, cold.ms / 2));
    } finally {
      stop();
    }
  });
});

describe("the plans behind those numbers", () => {
  it("carries the three indexes 0209 adds", () => {
    const names = (
      getDb()
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("idx_events_source_type_ts");
    expect(names).toContain("idx_events_source_kind_ts");
    expect(names).toContain("idx_events_stream_dispatched");
  });

  it("never full-scans `events` for a per-source count", () => {
    const p = plan(`SELECT COUNT(*) AS n FROM events WHERE source_type = ?`, "whatsapp");
    expect(p).toMatch(/INDEX idx_events_source/);
    expect(p).not.toMatch(/SCAN events\b(?! USING)/);
  });

  it("answers the chat list's two aggregates from covering indexes", () => {
    const stats = plan(
      `SELECT stream_id AS id, MAX(ts) AS last_ts, COUNT(*) AS event_count,
              SUM(CASE WHEN ts >= strftime('%Y-%m-%dT00:00:00.000Z','now') THEN 1 ELSE 0 END) AS today_count
         FROM events WHERE stream_id IS NOT NULL GROUP BY stream_id`,
    );
    expect(stats).toMatch(/idx_events_stream_ts/);
    expect(stats).not.toMatch(/TEMP B-TREE FOR GROUP BY/);

    const knows = plan(
      `SELECT stream_id AS id, MIN(ts) AS knows_from
         FROM events WHERE dispatched_at IS NOT NULL AND stream_id IS NOT NULL GROUP BY stream_id`,
    );
    expect(knows).toMatch(/idx_events_stream_dispatched/);
    expect(knows).not.toMatch(/TEMP B-TREE FOR GROUP BY/);
  });

  it("seeks the chat preview instead of sorting the stream's history", () => {
    const p = plan(
      `SELECT text, kind, actor FROM events WHERE stream_id = ? AND ts = ? ORDER BY id DESC LIMIT 1`,
      "whatsapp:st:chat3",
      "2026-01-01T00:00:00.000Z",
    );
    expect(p).toMatch(/idx_events_stream_ts \(stream_id=\? AND ts=\?\)/);
  });

  it("reads a browser chain by its own key, not by scanning every visit", () => {
    const p = plan(
      `SELECT id, ts, stream_key, payload_json FROM events INDEXED BY idx_events_stream_key
        WHERE stream_key = ? AND source_type = 'browser' AND kind = 'browser.visit'
        ORDER BY ts ASC LIMIT 50`,
      "chain-3",
    );
    expect(p).toMatch(/idx_events_stream_key/);
    expect(p).not.toMatch(/idx_events_source_kind_ts/);
  });

  it("bounds today's browser domains and the bookmark shelf to an index range", () => {
    expect(
      plan(
        `SELECT json_extract(payload_json,'$.domain') AS domain FROM events
          WHERE source_type = 'browser' AND kind = 'browser.visit'
            AND ts >= strftime('%Y-%m-%dT00:00:00.000Z','now') LIMIT 20000`,
      ),
    ).toMatch(/idx_events_source_kind_ts \(source_type=\? AND kind=\? AND ts>\?\)/);
    expect(
      plan(
        `SELECT ts, payload_json FROM events
          WHERE source_type = 'browser' AND kind = 'browser.bookmark' ORDER BY ts DESC LIMIT 20`,
      ),
    ).toMatch(/idx_events_source_kind_ts/);
  });

  it("reads one screen day as an index range, not a scan of the log", () => {
    const p = plan(
      `SELECT id, ts, stream_key, payload_json FROM events
        WHERE source_type = 'screen' AND ts >= ? AND ts < ? ORDER BY ts ASC`,
      "2026-09-06T00:00:00.000Z",
      "2026-09-06T23:59:59.999Z",
    );
    expect(p).toMatch(/idx_events_source_type_ts \(source_type=\? AND ts>\? AND ts<\?\)/);
  });
});
