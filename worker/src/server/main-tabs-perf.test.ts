// ===========================================================================
// Main-tab latency budgets — V6 P1 S6d (FIX-C5).
//
// The user reported that switching the MAIN tabs — Home, Spaces, Calendar,
// Timeline, People, Settings — was very slow, the same complaint the Library
// sub-tabs drew. Measured read-only against their running app (138,139 events,
// 844 people, a WhatsApp history import in flight), best of six attempts each
// so the number is a floor and not an unlucky sample:
//
//   GET /api/health            0.002 s   ← touches no database at all
//   GET /api/people/radar      3.92 s    ← 12 bytes of body
//   GET /api/home              4.88 s
//   GET /api/freshness         5.02 s
//   GET /api/people            6.02 s    ← 209 KB of body
//   GET /api/people/who-i-am   6.42 s    ← 434 bytes
//   GET /api/spaces/list       8.03 s    ← 25 bytes of body, 5 rows in the table
//   GET /api/artifacts         8.20 s
//   GET /api/timeline          9.58 s
//   GET /api/timeline/days     9.99 s
//   GET /api/calendar         11.06 s    ← 1.4 KB of body
//   GET /api/settings/general 37.31 s    ← 198 bytes; SEVEN app_state lookups
//
// WHAT THOSE NUMBERS MEAN, AND IT IS NOT WHAT THE SHAPE OF THE LIST SUGGESTS.
// Read them against each other rather than in order:
//
//   * `/api/health` answers in two milliseconds. It is the only one of these
//     that opens no database handle.
//   * `/api/spaces/list` needs eight seconds to produce twenty-five bytes out
//     of a five-row table.
//   * `/api/settings/general` — whose whole body is seven `app_state` key
//     lookups, 198 bytes — needed THIRTY-SEVEN seconds. That is the report of
//     "Settings > General stuck on loading", in one line.
//   * The same SQL, run against the same file with `sqlite3 -readonly` and no
//     worker in the way, completes in ~70 ms including process startup.
//
// A 198-byte constant taking 37 s and a 12-byte body taking 3.9 s cannot be
// explained by query cost, payload size, or an index. There is one explanation
// that fits every row: better-sqlite3 is synchronous and the worker is one
// thread, so a reader waits for the WhatsApp importer to put the handle down.
// The endpoints are not slow. They are queued. `health` is fast for exactly
// the reason it is the odd one out — it never joins the queue.
//
// This is why the fix is NOT query tuning, and why tuning these queries would
// have produced no measurable change on the user's machine.
//
// That is why the fix is in two halves, and why this suite guards both:
//
//   1. THE FLIP MUST STOP ASKING. If a request costs a queue ticket behind the
//      importer, the cure is to stop buying tickets. A main tab is mounted once
//      and kept mounted (src/App.tsx · FIX-C5), so a second visit issues no
//      request at all. That half is covered by src/main-tabs-lifecycle.test.tsx.
//   2. THE FIRST ASK MUST STAY CHEAP. The one read a screen cannot avoid — its
//      first — must be answerable from an index over a log far larger than the
//      user's, so that it costs the queue and nothing more. That is this file.
//
// (Shortening the queue itself — making the importer yield the handle — is the
// third half, and it lives in the ingest lane, not here.)
//
// Like the Library suite it asserts TWO things, because a wall-clock budget on
// a fast CI box is a weak regression:
//
//   * LATENCY, measured while a writer loop shaped like the importer runs.
//   * QUERY PLANS. A `SCAN events` behind any main tab is the defect; that
//     assertion holds on any machine at any speed.
//
// Zero model calls. Scratch db path under $TMPDIR; nothing here touches a home.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { seedCorpus, TEST_CORPUS } from "../library/perf-corpus.js";
import { handleCalendarRoute } from "./calendar-routes.js";
import { handleGroundedRoute } from "./grounded-routes.js";
import { handleReviewRoute } from "./review-routes.js";
import { handleSpacesRoute } from "./spaces-routes.js";
import { handleWorldModelRoute } from "./worldmodel-routes.js";

/**
 * One second, wall clock, with an importer running. Generous on purpose — the
 * suite shares a machine with ~100 other files, and the point of the number is
 * to catch a return to SECONDS, not to police milliseconds. The plan
 * assertions below are the sharp edge.
 */
const BUDGET_MS = 1_000;

/**
 * People gets its own, larger budget, and the reason is worth stating because
 * it is the one main tab whose cost is NOT a queue ticket. `/api/people` ships
 * the entire roster — 844 rows and 197 KB on the user's install, ~470 KB at the
 * 2,000 seeded here — and at that size the time is dominated by serialising
 * the body, not by finding it. Capping the roster would fix the number and
 * break the screen: People groups EVERY contact into circles, so a server-side
 * limit would silently drop contacts out of the counts. That is a product
 * decision (Product_V6_Phase1 §7.3), not a perf one, so the budget admits the
 * real shape of the work instead of pretending it away.
 */
const ROSTER_BUDGET_MS = 1_800;

/** How many people the People tab is held to. The user's install has 844. */
const PEOPLE = 2_000;

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
    // Fifteen rows a tick, not twenty-five: a burst large enough to hold the
    // handle the way the importer does, small enough that vitest's own RPC
    // still gets a turn (a starved reporter fails the run with a timeout that
    // has nothing to do with the endpoint under test).
    for (let i = 0; i < 15; i++) {
      const k = writerSeq++;
      const ts = new Date().toISOString();
      const text = `imported message ${k} with a body long enough that the row is not free`;
      ins.run({
        id: `ev_mt_${k}`,
        streamId: `whatsapp:st:chat${k % 100}`,
        streamKey: `chat${k % 100}@s.whatsapp.net`,
        ts,
        text,
        payloadJson: JSON.stringify({ text, from_me: false }),
        externalId: `mt_${k}`,
        contentHash: `h_mt_${k}`,
      });
    }
    // setTimeout, not setImmediate: a tight setImmediate loop starves the I/O
    // phase completely, which starves vitest's own RPC as well as the request
    // under test. A burst then a yield is also what the real importer does.
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

/** Measure one endpoint twice under a writer loop; the second time is the claim. */
async function budget(path: string, limitMs: number = BUDGET_MS): Promise<unknown> {
  const stop = startWriter();
  try {
    await timeGet(path); // warm
    const { ms, body } = await timeGet(path);
    expect(ms, `GET ${path} took ${ms.toFixed(0)} ms`).toBeLessThan(limitMs);
    return body;
  } finally {
    stop();
  }
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

/**
 * The People tab's roster. `people` is a VIEW over `entities` (type='person',
 * not merged away), so the rows are seeded on the base table — which is also
 * the table that grows, and therefore the one the plan assertion is about.
 */
function seedPeople(count: number): void {
  const db = getDb();
  const circles = ["inner", "close", "regular", "acquaintance", null];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO entities (id, type, subtype, canonical, provisional, user_pinned,
                                     merged_into, first_seen_at, last_seen_at, created_at, circle)
     VALUES (?, 'person', 'person', ?, 0, 0, NULL, ?, ?, ?, ?)`,
  );
  const now = Date.now();
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const seen = new Date(now - i * 3_600_000).toISOString();
      ins.run(`pe_${i}`, `Contact ${i}`, seen, seen, seen, circles[i % circles.length]);
    }
  })();
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-main-tabs-perf-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  seedCorpus(TEST_CORPUS);
  seedPeople(PEOPLE);
  server = createServer((req, res) => {
    void (async () => {
      if (await handleReviewRoute(req, res)) return;
      if (await handleSpacesRoute(req, res)) return;
      if (await handleCalendarRoute(req, res)) return;
      if (await handleWorldModelRoute(req, res)) return;
      if (await handleGroundedRoute(req, res)) return;
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

describe("main tabs on a 160k-event corpus, with an import running", () => {
  it("seeded a corpus larger than the log the user reported on", () => {
    const events = (getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    const people = (getDb().prepare(`SELECT COUNT(*) AS n FROM people`).get() as { n: number }).n;
    expect(events).toBeGreaterThan(138_139);
    expect(people).toBeGreaterThanOrEqual(PEOPLE);
  });

  it("answers /api/home inside the budget", async () => {
    await budget("/api/home");
  });

  it("answers /api/spaces/list inside the budget", async () => {
    await budget("/api/spaces/list");
  });

  it("answers /api/timeline inside the budget", async () => {
    const body = (await budget("/api/timeline")) as { rows: unknown[] };
    // The page is bounded: the Timeline pages with `next_before`, so a first
    // read must never be "every event in the log".
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.length).toBeLessThanOrEqual(200);
  });

  it("answers /api/timeline/days inside the budget", async () => {
    await budget("/api/timeline/days");
  });

  it("answers /api/calendar inside the budget", async () => {
    await budget("/api/calendar?from=2026-09-01&to=2026-09-30");
  });

  it("answers /api/people inside the budget", async () => {
    const body = (await budget("/api/people", ROSTER_BUDGET_MS)) as { people: unknown[] };
    expect(body.people.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // The sharp assertion. A budget passes on a fast machine even when a query
  // scans; a plan does not. `events` is the table that grows without limit, so
  // a main tab that scans it is the regression this suite exists to catch.
  // -----------------------------------------------------------------------
  it("reads the timeline page from an index, never a scan of events", () => {
    const detail = plan(`SELECT * FROM events ORDER BY ts DESC LIMIT 200`);
    expect(detail, detail).not.toMatch(/SCAN events(?! USING)/);
  });

  it("reads the day histogram from an index, never a scan of events", () => {
    const detail = plan(
      `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS n FROM events GROUP BY day ORDER BY day DESC`,
    );
    expect(detail, detail).not.toMatch(/SCAN events(?! USING)/);
  });

  // `people` is a view over `entities`; the roster is filtered to type='person'
  // and then sorted. The SORT is over people only (thousands at most, cheap and
  // bounded by the address book), so it is not what this asserts. The FILTER is
  // over every entity the twin has ever minted — messages, visits and documents
  // all mint entities — so a scan there is the one that grows without limit.
  it("filters the people roster on an index, never a scan of every entity", () => {
    const detail = plan(`SELECT * FROM people ORDER BY last_seen_at DESC, id`);
    expect(detail, detail).toMatch(/USING INDEX|USING COVERING INDEX/);
    expect(detail, detail).not.toMatch(/SCAN (e|entities)(?! USING)/);
  });
});
