// The background indexer (docs/v6-spec.md §1, tier 3).
//
// What matters here is the loop's shape rather than the embedding: it must
// drain in batches while there is a backlog, go quiet when there is not, cost
// nothing while the tier is off, and survive a failing pass without turning
// into a hot loop.

process.env.TZ = "Asia/Kolkata";

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-indexer-"));
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");
delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;

const { closeDb, getDb } = await import("../db/connection.js");
const { runMigrations } = await import("../db/index.js");
const { countEventEmbeddings } = await import("../db/embeddings.js");
const { setEmbedder, forgetEmbedder } = await import("./embedder.js");
const { resetSemanticCacheForTests } = await import("./semantic.js");
const { startSemanticIndexer, stopSemanticIndexer, wakeSemanticIndexer } =
  await import("./indexer.js");

const DIM = 4;
const KEY = { model: "indexer-v1", dim: DIM };

let embedCalls = 0;
let fail = false;

const embedder = {
  ...KEY,
  async embed(texts: readonly string[]) {
    embedCalls++;
    if (fail) throw new Error("the encoder fell over");
    return texts.map(() => Float32Array.from([1, 0, 0, 0]));
  },
};

function addEvents(n: number, prefix: string): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO events (id, source_id, source_type, channel_id, actor_id, ts, kind, text, external_id)
     VALUES (?, 'whatsapp', 'whatsapp', 'ch-1', 'ac-1', '2026-07-28T09:00:00.000Z', 'message', ?, ?)`,
  );
  for (let i = 0; i < n; i++) {
    insert.run(`${prefix}-${i}`, `a message long enough to be worth a vector ${i}`, `${prefix}-${i}`);
  }
}

/** Wait for a condition the timer loop is expected to reach, or give up. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(() => {
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO sources (id, type) VALUES ('whatsapp', 'whatsapp')`).run();
  db.prepare(
    `INSERT INTO channels (id, source_id, name, kind) VALUES ('ch-1', 'whatsapp', 'Chat', 'group')`,
  ).run();
  db.prepare(
    `INSERT INTO actors (id, source_id, display_name) VALUES ('ac-1', 'whatsapp', 'Rahul')`,
  ).run();
});

afterAll(() => {
  stopSemanticIndexer();
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  stopSemanticIndexer();
  forgetEmbedder();
  resetSemanticCacheForTests();
  getDb().prepare(`DELETE FROM event_embeddings`).run();
  getDb().prepare(`DELETE FROM events`).run();
  embedCalls = 0;
  fail = false;
});

describe("the background indexer", () => {
  it("drains a backlog in batches rather than in one pass", async () => {
    addEvents(20, "backlog");
    setEmbedder(embedder);
    startSemanticIndexer({ batch: 4 });

    await until(() => countEventEmbeddings(KEY) === 20, "the backlog to drain");
    // 20 rows in batches of 4 is five passes, not one big one.
    expect(embedCalls).toBe(5);
  });

  it("goes quiet once it is caught up, and wakes for what arrives later", async () => {
    addEvents(3, "first");
    setEmbedder(embedder);
    startSemanticIndexer({ batch: 8 });
    await until(() => countEventEmbeddings(KEY) === 3, "the first rows");

    const settled = embedCalls;
    await new Promise((r) => setTimeout(r, 120));
    // Nothing arrived, so nothing was embedded — the loop is not spinning.
    expect(embedCalls).toBe(settled);

    addEvents(2, "later");
    wakeSemanticIndexer();
    await until(() => countEventEmbeddings(KEY) === 5, "the later rows");
    expect(embedCalls).toBe(settled + 1);
  });

  it("costs nothing while the tier is off", async () => {
    addEvents(5, "off");
    // No embedder registered and the switch defaults off: getEmbedder() is null.
    startSemanticIndexer({ batch: 8 });

    await new Promise((r) => setTimeout(r, 150));
    expect(embedCalls).toBe(0);
    expect(countEventEmbeddings(KEY)).toBe(0);
  });

  it("a failing pass backs off instead of spinning", async () => {
    addEvents(10, "broken");
    setEmbedder(embedder);
    fail = true;
    const log = vi.fn();
    startSemanticIndexer({ batch: 4, log });

    await until(() => embedCalls >= 1, "the first attempt");
    const after = embedCalls;
    await new Promise((r) => setTimeout(r, 150));
    // The batch logged its own failure and returned 0, which reads as "caught
    // up" — so the next attempt is a minute away, not 250 ms.
    expect(embedCalls).toBe(after);
    expect(countEventEmbeddings(KEY)).toBe(0);
  });

  it("stops for good when it is stopped", async () => {
    addEvents(40, "stopme");
    setEmbedder(embedder);
    startSemanticIndexer({ batch: 4 });
    await until(() => embedCalls >= 1, "the first pass");
    stopSemanticIndexer();

    const after = embedCalls;
    await new Promise((r) => setTimeout(r, 150));
    expect(embedCalls).toBe(after);
    // And a wake with nothing running is not a way to restart it.
    wakeSemanticIndexer();
    await new Promise((r) => setTimeout(r, 60));
    expect(embedCalls).toBe(after);
  });
});
