// ===========================================================================
// db module tests (vitest). Each test points SUPERTWIN_DB_PATH at a unique temp
// file, exercises the public API, and cleans up (file + WAL/SHM sidecars).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_QUOTA_WINDOW_MS,
  addUsage,
  appendMessage,
  createSession,
  getDb,
  getMessages,
  getQuota,
  getSession,
  getWindowCost,
  listSessions,
  logRun,
  markSessionPoisoned,
  runMigrations,
  updateSessionTimestamp,
} from "./index.js";
import { closeDb } from "./connection.js";
import { MIGRATIONS } from "./schema.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-db-test-"));
  dbPath = join(tmpDir, `supertwin-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.SUPERTWIN_DB_PATH = dbPath;
  closeDb(); // ensure no handle from a previous test lingers
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: list user-facing table + view names from sqlite_master.
function tableNames(): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

describe("migrations", () => {
  it("runMigrations() twice is idempotent (no error, single recorded row)", () => {
    runMigrations();
    runMigrations();

    const applied = getDb()
      .prepare(`SELECT id FROM schema_migrations ORDER BY id`)
      .all() as { id: string }[];
    // Each migration id is recorded exactly once (no dupes on the second run).
    expect(applied.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("enables WAL + foreign_keys", () => {
    const db = getDb();
    expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("creates every expected operational + phase-0 table and the FTS5 table", () => {
    runMigrations();
    const names = tableNames();

    const expected = [
      // operational
      "sources",
      "channels",
      "people",
      "actors",
      "events",
      "spaces",
      "goals",
      "milestones",
      "tasks",
      "space_events",
      "extraction_runs",
      // 0021_v2_prep (what the retired 0004 carried that is still read)
      "evaluations",
      // phase-0
      "chat_sessions",
      "chat_messages",
      "quota_usage",
      // bookkeeping
      "schema_migrations",
      // FTS5 virtual table
      "events_fts",
    ];
    for (const t of expected) {
      expect(names.has(t), `missing table: ${t}`).toBe(true);
    }
  });

  it("0021_v2_prep carries what the retired 0004–0006 left behind", () => {
    // 0004/0005/0006 were retired with the spaces/tasks ontology (V2 §3.2).
    // Three things in them had readers and moved to 0021; nothing else in those
    // bodies may come back, which is what the negative half below pins down.
    runMigrations();
    const db = getDb();
    const cols = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

    expect(cols("evaluations")).toEqual(
      expect.arrayContaining(["output_type", "output_id", "verdict", "note", "ts"]),
    );
    expect(cols("chat_sessions")).toContain("grounded");
    expect(cols("chat_messages")).toContain("citations_json");
    expect(cols("extraction_runs")).toEqual(expect.arrayContaining(["model", "role"]));

    // The ontology columns and tables are NOT recreated.
    expect(cols("spaces")).not.toContain("slug");
    expect(cols("tasks")).not.toContain("title");
    expect(tableNames().has("patterns")).toBe(false);
    expect(tableNames().has("space_people")).toBe(false);
    expect(tableNames().has("task_runs")).toBe(false);
  });

  it("FTS5 virtual table stays synced with events.text via triggers", () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO events (id, text) VALUES (@id, @text)`,
    ).run({ id: "e1", text: "hello supertwin world" });

    const hit = db
      .prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH ?`)
      .all("supertwin") as { rowid: number }[];
    expect(hit.length).toBe(1);

    // update -> re-indexed
    db.prepare(`UPDATE events SET text = ? WHERE id = ?`).run("totally different content", "e1");
    expect(
      (db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH ?`).all("supertwin")).length,
    ).toBe(0);
    expect(
      (db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH ?`).all("different")).length,
    ).toBe(1);

    // delete -> removed
    db.prepare(`DELETE FROM events WHERE id = ?`).run("e1");
    expect(
      (db.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH ?`).all("different")).length,
    ).toBe(0);
  });
});

describe("extraction_runs / logRun", () => {
  it("round-trips a logged run", () => {
    logRun({
      provider: "claude-local",
      sessionId: "sess-1",
      runId: "run-1",
      kind: "chat",
      promptChars: 42,
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.0123,
      durationMs: 1500,
      status: "ok",
      errorCode: null,
    });

    const row = getDb()
      .prepare(`SELECT * FROM extraction_runs WHERE run_id = ?`)
      .get("run-1") as Record<string, unknown>;

    expect(row.provider).toBe("claude-local");
    expect(row.session_id).toBe("sess-1");
    expect(row.kind).toBe("chat");
    expect(row.prompt_chars).toBe(42);
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(200);
    expect(row.cost_usd).toBeCloseTo(0.0123, 6);
    expect(row.duration_ms).toBe(1500);
    expect(row.status).toBe("ok");
    expect(row.error_code).toBeNull();
    expect(typeof row.created_at).toBe("string");
  });

  it("accepts a null session_id and an error status", () => {
    logRun({
      provider: "claude-local",
      sessionId: null,
      runId: "run-err",
      kind: "chat",
      promptChars: 10,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      durationMs: 5,
      status: "error",
      errorCode: "CLI_ERROR",
    });
    const row = getDb()
      .prepare(`SELECT session_id, cost_usd, error_code FROM extraction_runs WHERE run_id = ?`)
      .get("run-err") as Record<string, unknown>;
    expect(row.session_id).toBeNull();
    expect(row.cost_usd).toBeNull();
    expect(row.error_code).toBe("CLI_ERROR");
  });

  it("records the cache halves of the input, and 0 for a caller that has none", () => {
    logRun({
      provider: "claude-local",
      sessionId: null,
      runId: "run-cache",
      kind: "media",
      promptChars: 0,
      inputTokens: 17,
      cacheCreationInputTokens: 6_158,
      cacheReadInputTokens: 53_565,
      outputTokens: 40,
      costUsd: null,
      durationMs: 900,
      status: "ok",
      errorCode: null,
    });
    logRun({
      provider: "claude-local",
      sessionId: null,
      runId: "run-nocache",
      kind: "chat",
      promptChars: 0,
      inputTokens: 5,
      outputTokens: 5,
      costUsd: null,
      durationMs: 9,
      status: "ok",
      errorCode: null,
    });

    const rows = getDb()
      .prepare(
        `SELECT run_id, cache_creation_input_tokens AS cc, cache_read_input_tokens AS cr
           FROM extraction_runs ORDER BY run_id`,
      )
      .all() as { run_id: string; cc: number; cr: number }[];
    expect(rows).toEqual([
      { run_id: "run-cache", cc: 6_158, cr: 53_565 },
      { run_id: "run-nocache", cc: 0, cr: 0 },
    ]);
  });
});

describe("sessions", () => {
  it("createSession -> getSession -> listSessions", () => {
    createSession({
      sessionId: "s-1",
      provider: "claude-local",
      cwd: "/tmp/work",
      promptBundleHash: "hash-abc",
      title: "First chat",
    });

    const got = getSession("s-1");
    expect(got).not.toBeNull();
    expect(got!.sessionId).toBe("s-1");
    expect(got!.provider).toBe("claude-local");
    expect(got!.cwd).toBe("/tmp/work");
    expect(got!.promptBundleHash).toBe("hash-abc");
    expect(got!.title).toBe("First chat");
    expect(got!.status).toBe("active");
    expect(typeof got!.createdAt).toBe("string");
    expect(typeof got!.updatedAt).toBe("string");

    expect(getSession("nope")).toBeNull();

    const list = listSessions();
    expect(list.length).toBe(1);
    expect(list[0].sessionId).toBe("s-1");
  });

  it("listSessions returns most-recent (updated) first", () => {
    createSession({ sessionId: "s-old", provider: "p", cwd: "/w", promptBundleHash: "h" });
    createSession({ sessionId: "s-new", provider: "p", cwd: "/w", promptBundleHash: "h" });

    // Touch s-old so it becomes the most recently updated.
    updateSessionTimestamp("s-old");
    // Force a strictly-later updated_at to avoid same-millisecond ties.
    getDb()
      .prepare(
        `UPDATE chat_sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second') WHERE session_id = ?`,
      )
      .run("s-old");

    const list = listSessions();
    expect(list.map((s) => s.sessionId)).toEqual(["s-old", "s-new"]);
  });

  it("markSessionPoisoned flips status", () => {
    createSession({ sessionId: "s-p", provider: "p", cwd: "/w", promptBundleHash: "h" });
    expect(getSession("s-p")!.status).toBe("active");

    markSessionPoisoned("s-p");
    expect(getSession("s-p")!.status).toBe("poisoned");
  });
});

describe("messages", () => {
  it("appendMessage -> getMessages ordered by ts", () => {
    createSession({ sessionId: "s-m", provider: "p", cwd: "/w", promptBundleHash: "h" });

    appendMessage({ sessionId: "s-m", role: "user", content: "hi", runId: "r1" });
    appendMessage({
      sessionId: "s-m",
      role: "assistant",
      content: "hello there",
      runId: "r1",
      usageJson: JSON.stringify({ inputTokens: 5, outputTokens: 7 }),
    });
    appendMessage({ sessionId: "s-m", role: "user", content: "bye" });

    const msgs = getMessages("s-m");
    expect(msgs.length).toBe(3);
    expect(msgs.map((m) => m.content)).toEqual(["hi", "hello there", "bye"]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // ids are strictly increasing (tie-break within same ts)
    expect(msgs[0].id < msgs[1].id && msgs[1].id < msgs[2].id).toBe(true);
    expect(msgs[1].runId).toBe("r1");
    expect(msgs[1].usageJson).toBe(JSON.stringify({ inputTokens: 5, outputTokens: 7 }));
    expect(msgs[2].runId).toBeNull();
  });

  it("cascades message deletes when a session is removed (FK ON)", () => {
    createSession({ sessionId: "s-c", provider: "p", cwd: "/w", promptBundleHash: "h" });
    appendMessage({ sessionId: "s-c", role: "user", content: "x" });
    getDb().prepare(`DELETE FROM chat_sessions WHERE session_id = ?`).run("s-c");
    expect(getMessages("s-c").length).toBe(0);
  });
});

describe("quota", () => {
  it("addUsage -> getQuota reflects summed tokens and run counts", () => {
    addUsage({ inputTokens: 100, outputTokens: 50 }); // runCount defaults to 1
    addUsage({ inputTokens: 200, outputTokens: 25, runCount: 2 });

    const q = getQuota();
    expect(q.windowMs).toBe(DEFAULT_QUOTA_WINDOW_MS);
    expect(q.inputTokens).toBe(300);
    expect(q.outputTokens).toBe(75);
    expect(q.runCount).toBe(3);
    expect(typeof q.windowStart).toBe("string");
    expect(q.nearLimit).toBe(false); // default threshold is high
  });

  it("excludes usage recorded outside the rolling window", () => {
    // In-window row via the public API.
    addUsage({ inputTokens: 10, outputTokens: 10, runCount: 1 });

    // Out-of-window row: inserted directly with a window_start well in the past.
    getDb()
      .prepare(
        `INSERT INTO quota_usage (window_start, input_tokens, output_tokens, run_count)
         VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 hours'), 999, 999, 5)`,
      )
      .run();

    // 5h window: the -10h row is excluded.
    const q5 = getQuota(DEFAULT_QUOTA_WINDOW_MS);
    expect(q5.inputTokens).toBe(10);
    expect(q5.outputTokens).toBe(10);
    expect(q5.runCount).toBe(1);

    // Widen the window past 10h: the old row is now included.
    const qWide = getQuota(11 * 60 * 60 * 1000);
    expect(qWide.inputTokens).toBe(1009);
    expect(qWide.outputTokens).toBe(1009);
    expect(qWide.runCount).toBe(6);
  });

  it("trips nearLimit when the configured threshold is crossed", () => {
    process.env.SUPERTWIN_QUOTA_NEAR_LIMIT_TOKENS = "100";
    try {
      addUsage({ inputTokens: 60, outputTokens: 60 });
      expect(getQuota().nearLimit).toBe(true);
    } finally {
      delete process.env.SUPERTWIN_QUOTA_NEAR_LIMIT_TOKENS;
    }
  });

  it("sums the cache halves and stores the billable equivalent alongside them", () => {
    addUsage({
      inputTokens: 17,
      cacheCreationInputTokens: 6_000,
      cacheReadInputTokens: 50_000,
      outputTokens: 40,
    });

    const q = getQuota();
    expect(q.cacheCreationInputTokens).toBe(6_000);
    expect(q.cacheReadInputTokens).toBe(50_000);
    // 17 + 6000*1.25 + 50000*0.1 + 40
    expect(q.billableTokens).toBe(12_557);
  });

  it("sums the window's cost per process instead of leaving it on the run (v4 §1)", () => {
    const run = (runId: string, role: string, costUsd: number | null) =>
      logRun({
        provider: "claude-local",
        sessionId: null,
        runId,
        kind: role,
        promptChars: 0,
        inputTokens: 10,
        outputTokens: 5,
        costUsd,
        durationMs: 100,
        status: "ok",
        errorCode: null,
        role,
      });
    run("chat-1", "chat", 0.0123);
    run("chat-2", "chat", 0.0077);
    run("media-1", "media", 0.004);

    // The chat block's own figure; media reading is spend the quota window
    // never sees, so it stays a separate line.
    expect(getQuota().costUsd).toBeCloseTo(0.02, 10);
    expect(getWindowCost("media")).toBeCloseTo(0.004, 10);
  });

  it("reports no cost rather than zero when nothing in the window priced itself", () => {
    addUsage({ inputTokens: 100, outputTokens: 50 });
    expect(getQuota().costUsd).toBeNull();
    expect(getWindowCost("media")).toBeNull();
  });

  it("excludes cost recorded outside the rolling window", () => {
    getDb()
      .prepare(
        `INSERT INTO extraction_runs
           (provider, run_id, kind, role, cost_usd, status, created_at)
         VALUES ('claude-local', 'old', 'chat', 'chat', 9.99, 'ok',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 hours'))`,
      )
      .run();

    expect(getQuota(DEFAULT_QUOTA_WINDOW_MS).costUsd).toBeNull();
    expect(getWindowCost("chat", 11 * 60 * 60 * 1000)).toBeCloseTo(9.99, 10);
  });

  it("gates on the billable equivalent, not the raw sum", () => {
    process.env.SUPERTWIN_QUOTA_NEAR_LIMIT_TOKENS = "20000";
    try {
      // 56,057 raw tokens, but a cache read bills at ~10% — this is real spend
      // of ~12.5k and must NOT lock the user out of chat.
      addUsage({
        inputTokens: 17,
        cacheCreationInputTokens: 6_000,
        cacheReadInputTokens: 50_000,
        outputTokens: 40,
      });
      expect(getQuota().nearLimit).toBe(false);
    } finally {
      delete process.env.SUPERTWIN_QUOTA_NEAR_LIMIT_TOKENS;
    }
  });
});
