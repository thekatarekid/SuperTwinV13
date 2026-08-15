// ===========================================================================
// Ingestion DB tests (vitest): migration idempotency + dedupe + upserts + FTS +
// app_state + inbox reads. Each test uses a unique temp DB (SUPERTWIN_DB_PATH).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDb, runMigrations, runMigrationsOn } from "./connection.js";
import { closeDb } from "./connection.js";
import type { MediaClaimFilter, TranscriptClaimFilter } from "./ingest.js";
import {
  applyEdit,
  applyRevoke,
  appStateGet,
  appStateSet,
  claimPendingLinks,
  claimPendingMedia,
  claimPendingPosters,
  claimPendingTranscription,
  deleteReaction,
  getChannelMessages,
  getEventById,
  IMPORT_DONE_KEY,
  IMPORT_RANGE_KEY,
  insertEvent,
  listInboxChats,
  listMediaFramePaths,
  recordLinkScrape,
  recordMediaDescription,
  recordMediaFrames,
  recordTranscript,
  recordVideoPoster,
  rescanMedia,
  resetWhatsappData,
  searchEvents,
  toFtsMatchQuery,
  upsertActor,
  upsertChannel,
  upsertSource,
} from "./ingest.js";
import { MIGRATIONS } from "./schema.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-ingest-test-"));
  dbPath = join(tmpDir, `st-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.SUPERTWIN_DB_PATH = dbPath;
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Every readable kind switched on, business chats left out — the usual claim. */
const CLAIM_ALL: MediaClaimFilter = {
  images: true,
  video: true,
  documents: true,
  business: false,
};

/** Register the whatsapp source + a channel + actor; return their ids. */
function seedSourceChannelActor(): { channelId: string; actorId: string } {
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  const channelId = upsertChannel({
    sourceId: "whatsapp",
    sourceExtId: "chat-1@s.whatsapp.net",
    name: "Mom",
    kind: "dm",
  });
  const actorId = upsertActor({
    sourceId: "whatsapp",
    sourceExtId: "mom@s.whatsapp.net",
    displayName: "Mom",
    handle: "+199",
    isSelf: false,
  });
  return { channelId, actorId };
}

function makeEvent(externalId: string, channelId: string, actorId: string, text: string) {
  return {
    externalId,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    channelId,
    actorId,
    ts: "2026-07-02T12:00:00.000Z",
    kind: "message",
    text,
    mediaPath: null,
    rawJson: JSON.stringify({ id: externalId }),
  };
}

describe("migration 0002_phase1", () => {
  it("applies on a fresh DB and records all ids", () => {
    runMigrations();
    const applied = getDb()
      .prepare(`SELECT id FROM schema_migrations ORDER BY id`)
      .all() as { id: string }[];
    expect(applied.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("is idempotent (running twice is a no-op)", () => {
    runMigrations();
    runMigrations();
    const applied = getDb()
      .prepare(`SELECT id FROM schema_migrations ORDER BY id`)
      .all() as { id: string }[];
    expect(applied.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("adds external_id + the dedupe unique index + app_state", () => {
    const db = getDb();
    const cols = (db.prepare(`PRAGMA table_info(events)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("external_id");

    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_source_external'`)
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_events_source_external");

    const appState = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'`)
      .get() as { name: string } | undefined;
    expect(appState?.name).toBe("app_state");

    // source_ext_id columns exist on channels + actors.
    const chCols = (db.prepare(`PRAGMA table_info(channels)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(chCols).toContain("source_ext_id");
    const acCols = (db.prepare(`PRAGMA table_info(actors)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(acCols).toContain("source_ext_id");
  });
});

// ---------------------------------------------------------------------------
// migration 0003_phase1_threads (§R5.3/§R5.4): reply_to columns + index.
// Idempotency on fresh + upgrade (from a DB with only 0001+0002 applied).
// ---------------------------------------------------------------------------

describe("migration 0003_phase1_threads", () => {
  it("adds reply_to_external_id + reply_to_text + the idx_events_reply_to index on a fresh DB", () => {
    runMigrations();
    const db = getDb();
    const cols = (db.prepare(`PRAGMA table_info(events)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("reply_to_external_id");
    expect(cols).toContain("reply_to_text");

    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_reply_to'`)
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_events_reply_to");
  });

  it("is idempotent: running twice records 0003 exactly once (fresh)", () => {
    runMigrations();
    runMigrations();
    const applied = (getDb().prepare(`SELECT id FROM schema_migrations WHERE id='0003_phase1_threads'`).all() as {
      id: string;
    }[]);
    expect(applied.length).toBe(1);
  });

  it("upgrades a DB that already has 0001+0002 (only 0003 applies)", () => {
    // Build a DB with 0001_init + 0002_phase1 recorded and their columns present,
    // but WITHOUT the 0003 threading columns — the pre-R5 Phase-1 install.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT);
      CREATE TABLE events (
        id TEXT PRIMARY KEY, source_id TEXT, source_type TEXT, channel_id TEXT,
        actor_id TEXT, ts TEXT, kind TEXT, text TEXT, media_path TEXT, raw_json TEXT,
        external_id TEXT, created_at TEXT
      );
      -- 0001+0002 table that 0012_business_channel ALTERs (is_business).
      CREATE TABLE channels (
        id TEXT PRIMARY KEY, source_id TEXT, name TEXT, kind TEXT, created_at TEXT,
        source_ext_id TEXT
      );
      -- 0001 tables that later migrations (0004_phase2) ALTER / reference.
      CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, handle TEXT, created_at TEXT);
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY, name TEXT, type TEXT, permanence TEXT, status TEXT,
        latest_update TEXT, latest_update_ts TEXT, ends_at TEXT, created_at TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, space_id TEXT, goal_id TEXT, origin TEXT, status TEXT,
        execute_at TEXT, recurrence TEXT, created_at TEXT
      );
      -- 0001 table that 0006_phase34 ALTERs (model/role) + task_runs references.
      CREATE TABLE extraction_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, session_id TEXT,
        run_id TEXT NOT NULL, kind TEXT NOT NULL, prompt_chars INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL, duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        error_code TEXT, created_at TEXT
      );
      -- 0001 table that 0010_token_truth ALTERs (cache + billable columns).
      CREATE TABLE quota_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, window_start TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        run_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT
      );
      -- 0001 chat tables that 0005_grounded_chat ALTERs.
      CREATE TABLE chat_sessions (
        session_id TEXT PRIMARY KEY, provider TEXT, cwd TEXT, prompt_bundle_hash TEXT,
        title TEXT, status TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
        run_id TEXT, usage_json TEXT, ts TEXT
      );
      INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_init', '2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations (id, applied_at) VALUES ('0002_phase1', '2026-01-01T00:00:00.000Z');
    `);
    // Only 0003 should apply on this handle.
    runMigrationsOn(raw);
    const applied = (raw.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as {
      id: string;
    }[]).map((r) => r.id);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
    const cols = (raw.prepare(`PRAGMA table_info(events)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("reply_to_external_id");
    expect(cols).toContain("reply_to_text");
    raw.close();
  });

  it("tolerates a partially-applied ADD COLUMN (duplicate reply_to_external_id) on a dev DB", () => {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT);
      CREATE TABLE events (
        id TEXT PRIMARY KEY, source_id TEXT, source_type TEXT, channel_id TEXT,
        actor_id TEXT, ts TEXT, kind TEXT, text TEXT, media_path TEXT, raw_json TEXT,
        external_id TEXT, created_at TEXT
      );
      -- 0001+0002 table that 0012_business_channel ALTERs (is_business).
      CREATE TABLE channels (
        id TEXT PRIMARY KEY, source_id TEXT, name TEXT, kind TEXT, created_at TEXT,
        source_ext_id TEXT
      );
      -- 0001 tables that later migrations (0004_phase2) ALTER / reference.
      CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, handle TEXT, created_at TEXT);
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY, name TEXT, type TEXT, permanence TEXT, status TEXT,
        latest_update TEXT, latest_update_ts TEXT, ends_at TEXT, created_at TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, space_id TEXT, goal_id TEXT, origin TEXT, status TEXT,
        execute_at TEXT, recurrence TEXT, created_at TEXT
      );
      -- 0001 table that 0006_phase34 ALTERs (model/role) + task_runs references.
      CREATE TABLE extraction_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, session_id TEXT,
        run_id TEXT NOT NULL, kind TEXT NOT NULL, prompt_chars INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL, duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        error_code TEXT, created_at TEXT
      );
      -- 0001 table that 0010_token_truth ALTERs (cache + billable columns).
      CREATE TABLE quota_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, window_start TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        run_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT
      );
      -- 0001 chat tables that 0005_grounded_chat ALTERs.
      CREATE TABLE chat_sessions (
        session_id TEXT PRIMARY KEY, provider TEXT, cwd TEXT, prompt_bundle_hash TEXT,
        title TEXT, status TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
        run_id TEXT, usage_json TEXT, ts TEXT
      );
      INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_init', '2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations (id, applied_at) VALUES ('0002_phase1', '2026-01-01T00:00:00.000Z');
      -- Someone hand-added one of the 0003 columns but never recorded the id.
      ALTER TABLE events ADD COLUMN reply_to_external_id TEXT;
    `);
    expect(() => runMigrationsOn(raw)).not.toThrow();
    const applied = (raw.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as {
      id: string;
    }[]).map((r) => r.id);
    expect(applied).toContain("0003_phase1_threads");
    const cols = (raw.prepare(`PRAGMA table_info(events)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    // The remaining 0003 column was still added.
    expect(cols).toContain("reply_to_text");
    raw.close();
  });

  it("applies cleanly on a simulated Phase-0 DB (0001 already applied)", () => {
    // Build a DB with ONLY 0001_init applied (simulate a pre-Phase-1 install).
    const raw = new Database(dbPath);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    raw.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT);
    `);
    // Apply 0001 via the real runner would also apply 0002; instead force-record
    // 0001 and hand-create the minimal tables 0002 touches.
    raw.exec(`
      CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT, name TEXT, config_json TEXT, created_at TEXT);
      CREATE TABLE channels (id TEXT PRIMARY KEY, source_id TEXT, name TEXT, kind TEXT, created_at TEXT);
      CREATE TABLE actors (id TEXT PRIMARY KEY, source_id TEXT, person_id TEXT, display_name TEXT, handle TEXT, created_at TEXT);
      CREATE TABLE events (id TEXT PRIMARY KEY, source_id TEXT, source_type TEXT, channel_id TEXT, actor_id TEXT, ts TEXT, kind TEXT, text TEXT, media_path TEXT, raw_json TEXT, created_at TEXT);
      -- 0001 tables that later migrations (0004_phase2) ALTER / reference.
      CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, handle TEXT, created_at TEXT);
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY, name TEXT, type TEXT, permanence TEXT, status TEXT,
        latest_update TEXT, latest_update_ts TEXT, ends_at TEXT, created_at TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, space_id TEXT, goal_id TEXT, origin TEXT, status TEXT,
        execute_at TEXT, recurrence TEXT, created_at TEXT
      );
      -- 0001 table that 0006_phase34 ALTERs (model/role) + task_runs references.
      CREATE TABLE extraction_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, session_id TEXT,
        run_id TEXT NOT NULL, kind TEXT NOT NULL, prompt_chars INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL, duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        error_code TEXT, created_at TEXT
      );
      -- 0001 table that 0010_token_truth ALTERs (cache + billable columns).
      CREATE TABLE quota_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, window_start TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        run_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT
      );
      -- 0001 chat tables that 0005_grounded_chat ALTERs.
      CREATE TABLE chat_sessions (
        session_id TEXT PRIMARY KEY, provider TEXT, cwd TEXT, prompt_bundle_hash TEXT,
        title TEXT, status TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
        run_id TEXT, usage_json TEXT, ts TEXT
      );
      INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_init', '2026-01-01T00:00:00.000Z');
    `);
    // Now run migrations on this handle: 0002 + 0003 should apply.
    runMigrationsOn(raw);
    const applied = (raw.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as {
      id: string;
    }[]).map((r) => r.id);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
    // The new columns exist (0002 + 0003).
    const cols = (raw.prepare(`PRAGMA table_info(events)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("external_id");
    expect(cols).toContain("reply_to_external_id");
    expect(cols).toContain("reply_to_text");
    raw.close();
  });

  it("tolerates a partially-applied ADD COLUMN (duplicate column) on a dev DB", () => {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT);
      CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT, name TEXT, config_json TEXT, created_at TEXT);
      CREATE TABLE channels (id TEXT PRIMARY KEY, source_id TEXT, name TEXT, kind TEXT, created_at TEXT);
      CREATE TABLE actors (id TEXT PRIMARY KEY, source_id TEXT, person_id TEXT, display_name TEXT, handle TEXT, created_at TEXT);
      CREATE TABLE events (id TEXT PRIMARY KEY, source_id TEXT, source_type TEXT, channel_id TEXT, actor_id TEXT, ts TEXT, kind TEXT, text TEXT, media_path TEXT, raw_json TEXT, created_at TEXT);
      -- 0001 tables that later migrations (0004_phase2) ALTER / reference.
      CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, handle TEXT, created_at TEXT);
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY, name TEXT, type TEXT, permanence TEXT, status TEXT,
        latest_update TEXT, latest_update_ts TEXT, ends_at TEXT, created_at TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, space_id TEXT, goal_id TEXT, origin TEXT, status TEXT,
        execute_at TEXT, recurrence TEXT, created_at TEXT
      );
      -- 0001 table that 0006_phase34 ALTERs (model/role) + task_runs references.
      CREATE TABLE extraction_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, session_id TEXT,
        run_id TEXT NOT NULL, kind TEXT NOT NULL, prompt_chars INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL, duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        error_code TEXT, created_at TEXT
      );
      -- 0001 table that 0010_token_truth ALTERs (cache + billable columns).
      CREATE TABLE quota_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, window_start TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        run_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT
      );
      -- 0001 chat tables that 0005_grounded_chat ALTERs.
      CREATE TABLE chat_sessions (
        session_id TEXT PRIMARY KEY, provider TEXT, cwd TEXT, prompt_bundle_hash TEXT,
        title TEXT, status TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
        run_id TEXT, usage_json TEXT, ts TEXT
      );
      INSERT INTO schema_migrations (id, applied_at) VALUES ('0001_init', '2026-01-01T00:00:00.000Z');
      -- Someone hand-added the column but never recorded 0002_phase1:
      ALTER TABLE events ADD COLUMN external_id TEXT;
    `);
    // Should NOT throw despite the pre-existing external_id column.
    expect(() => runMigrationsOn(raw)).not.toThrow();
    const applied = (raw.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as {
      id: string;
    }[]).map((r) => r.id);
    expect(applied).toContain("0002_phase1");
    raw.close();
  });
});

describe("insertEvent dedupe", () => {
  it("same event twice => 1 row (second is a dedupe no-op)", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const ev = makeEvent("chat-1@s.whatsapp.net/MSG1", channelId, actorId, "hello");

    const r1 = insertEvent(ev);
    const r2 = insertEvent(ev);
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);
    expect(r1.id).toBe(r2.id);
    expect(r1.id).toBe("wa:chat-1@s.whatsapp.net/MSG1");

    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE external_id = ?`)
      .get("chat-1@s.whatsapp.net/MSG1") as { n: number };
    expect(count.n).toBe(1);
  });

  it("restart re-emit => 0 new rows", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const ids = ["A", "B", "C"];
    for (const i of ids) insertEvent(makeEvent(`c/${i}`, channelId, actorId, `m${i}`));
    // Simulate a restart: the daemon re-emits the exact same events.
    let newRows = 0;
    for (const i of ids) {
      if (insertEvent(makeEvent(`c/${i}`, channelId, actorId, `m${i}`)).inserted) newRows++;
    }
    expect(newRows).toBe(0);
    const total = getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    expect(total.n).toBe(3);
  });

  it("extend overlap => 0 dupes (older + overlapping ids collapse)", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    // Initial import: msgs 3,4,5.
    for (const i of [3, 4, 5]) insertEvent(makeEvent(`c/${i}`, channelId, actorId, `m${i}`));
    // Extend widens backwards: emits 1,2,3,4,5 (1,2 new; 3,4,5 overlap).
    let newRows = 0;
    for (const i of [1, 2, 3, 4, 5]) {
      if (insertEvent(makeEvent(`c/${i}`, channelId, actorId, `m${i}`)).inserted) newRows++;
    }
    expect(newRows).toBe(2);
    const total = getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    expect(total.n).toBe(5);
  });
});

describe("FTS search", () => {
  it("searchEvents returns matching events with a snippet", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeEvent("c/1", channelId, actorId, "let us meet for coffee tomorrow"));
    insertEvent(makeEvent("c/2", channelId, actorId, "unrelated grocery list"));

    const hits = searchEvents({ q: "coffee" });
    expect(hits.length).toBe(1);
    expect(hits[0].eventId).toBe("wa:c/1");
    expect(hits[0].channelName).toBe("Mom");
    expect(hits[0].snippet.toLowerCase()).toContain("coffee");
  });

  it("guards FTS syntax: punctuation-only query returns [] (no throw)", () => {
    seedSourceChannelActor();
    expect(searchEvents({ q: "  " })).toEqual([]);
    expect(() => searchEvents({ q: '"(' })).not.toThrow();
  });

  it("toFtsMatchQuery quotes tokens and drops stray quotes", () => {
    expect(toFtsMatchQuery("hello world")).toBe('"hello" "world"');
    expect(toFtsMatchQuery('a "b')).toBe('"a" "b"');
    expect(toFtsMatchQuery("   ")).toBe("");
  });
});

describe("inbox reads + media resolution + app_state", () => {
  it("listInboxChats derives lastText/lastTs/messageCount, sorted by lastTs desc", () => {
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const chA = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const chB = upsertChannel({ sourceId: "whatsapp", sourceExtId: "B@x", name: "Bob", kind: "dm" });
    const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "s@x", displayName: "S", isSelf: false });

    insertEvent({ ...makeEvent("A/1", chA, actor, "first"), ts: "2026-07-01T10:00:00.000Z" });
    insertEvent({ ...makeEvent("A/2", chA, actor, "second in A"), ts: "2026-07-01T11:00:00.000Z" });
    insertEvent({ ...makeEvent("B/1", chB, actor, "only in B"), ts: "2026-07-02T09:00:00.000Z" });

    const chats = listInboxChats({ limit: 10 });
    expect(chats.map((c) => c.id)).toEqual([chB, chA]); // B has the newest ts
    const a = chats.find((c) => c.id === chA)!;
    expect(a.messageCount).toBe(2);
    expect(a.lastText).toBe("second in A");
    // The JID must reach the UI: displayName() needs it to recover a label for
    // nameless chats (and to recognise WhatsApp's own system JIDs).
    expect(a.sourceExtId).toBe("A@x");
    expect(a.lastTs).toBe("2026-07-01T11:00:00.000Z");
  });

  it("listInboxChats excludes zero-event channels but includes channels with >=1 event (Rev 4 §R4.3, bug 17)", () => {
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    // Two channels with rows in the DB; only one has any event.
    const withMsg = upsertChannel({ sourceId: "whatsapp", sourceExtId: "has@x", name: "HasMsg", kind: "dm" });
    const empty = upsertChannel({ sourceId: "whatsapp", sourceExtId: "empty@x", name: "Empty", kind: "dm" });
    const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "s@x", displayName: "S", isSelf: false });

    insertEvent({ ...makeEvent("has/1", withMsg, actor, "hello"), ts: "2026-07-01T10:00:00.000Z" });

    const chats = listInboxChats({ limit: 10 });
    // The empty channel row still exists in the DB (name may resolve first)...
    const stillInDb = getDb().prepare(`SELECT id FROM channels WHERE id = ?`).get(empty) as
      | { id: string }
      | undefined;
    expect(stillInDb?.id).toBe(empty);
    // ...but the inbox list hides it (only channels with >=1 event show up).
    expect(chats.map((c) => c.id)).toEqual([withMsg]);
    expect(chats[0].messageCount).toBe(1);
    expect(chats[0].lastText).toBe("hello");
  });

  it("getChannelMessages returns ascending, before-cursor pages, and fromMe", () => {
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const other = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice", isSelf: false });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });
    appStateSet("whatsapp.self_jid", "me@x");

    insertEvent({ ...makeEvent("A/1", ch, other, "hi"), ts: "2026-07-01T10:00:00.000Z" });
    insertEvent({ ...makeEvent("A/2", ch, self, "hey back"), ts: "2026-07-01T10:05:00.000Z" });
    insertEvent({ ...makeEvent("A/3", ch, other, "bye"), ts: "2026-07-01T10:10:00.000Z" });

    // Whole chat fits in the window: ascending oldest→newest.
    const msgs = getChannelMessages({ channelId: ch, limit: 10 });
    expect(msgs.map((m) => m.text)).toEqual(["hi", "hey back", "bye"]);
    expect(msgs.map((m) => m.fromMe)).toEqual([false, true, false]);
    expect(msgs[0].actorName).toBe("Alice");

    // Legacy bare-ts cursor still works: strictly older than 10:05.
    const older = getChannelMessages({ channelId: ch, before: "2026-07-01T10:05:00.000Z", limit: 10 });
    expect(older.map((m) => m.text)).toEqual(["hi"]);

    // Compound cursor "<ts>|<id>" from the oldest loaded message pages older.
    const olderCompound = getChannelMessages({
      channelId: ch,
      before: "2026-07-01T10:05:00.000Z|wa:A/2",
      limit: 10,
    });
    expect(olderCompound.map((m) => m.text)).toEqual(["hi"]);
  });

  // Rev 7 §R7.1: the default (no cursor) must window on the NEWEST `limit`
  // messages, ascending — NOT the oldest `limit` from the start of the chat.
  it("getChannelMessages default returns the NEWEST limit messages in ascending order", () => {
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "B@x", name: "Bob", kind: "dm" });
    const bob = upsertActor({ sourceId: "whatsapp", sourceExtId: "bob@x", displayName: "Bob", isSelf: false });

    // 5 messages 10:00..10:04; a window of 3 must be the LAST 3 (m2,m3,m4)
    // ascending, not the first 3 (m0,m1,m2).
    for (let i = 0; i < 5; i++) {
      insertEvent({
        ...makeEvent(`B/${i}`, ch, bob, `m${i}`),
        ts: `2026-07-01T10:0${i}:00.000Z`,
      });
    }

    const msgs = getChannelMessages({ channelId: ch, limit: 3 });
    expect(msgs.map((m) => m.text)).toEqual(["m2", "m3", "m4"]);
    // Ascending: newest ("m4") is last so the UI renders it at the bottom.
    expect(msgs[msgs.length - 1].text).toBe("m4");
    // hasMore is inferable from rows.length === limit.
    expect(msgs.length).toBe(3);
  });

  // Rev 7 §R7.1: the `before` cursor returns the immediately-older page, with no
  // gap and no overlap against the newest window.
  it("getChannelMessages before-cursor returns the older page with no gap/overlap", () => {
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "C@x", name: "Cara", kind: "dm" });
    const cara = upsertActor({ sourceId: "whatsapp", sourceExtId: "cara@x", displayName: "Cara", isSelf: false });

    for (let i = 0; i < 6; i++) {
      insertEvent({
        ...makeEvent(`C/${i}`, ch, cara, `m${i}`),
        ts: `2026-07-01T10:0${i}:00.000Z`,
      });
    }

    // Newest window of 3 = m3,m4,m5. Oldest loaded = m3.
    const page1 = getChannelMessages({ channelId: ch, limit: 3 });
    expect(page1.map((m) => m.text)).toEqual(["m3", "m4", "m5"]);

    const oldest = page1[0];
    const cursor = `${oldest.ts}|${oldest.id}`;
    // Next older page = the 3 messages strictly older than m3: m0,m1,m2.
    const page2 = getChannelMessages({ channelId: ch, before: cursor, limit: 3 });
    expect(page2.map((m) => m.text)).toEqual(["m0", "m1", "m2"]);

    // No gap, no overlap: concatenation reconstructs the full ascending stream.
    expect([...page2, ...page1].map((m) => m.text)).toEqual([
      "m0", "m1", "m2", "m3", "m4", "m5",
    ]);

    // Paging past the start returns empty (exhausted).
    const p2oldest = page2[0];
    const page3 = getChannelMessages({
      channelId: ch,
      before: `${p2oldest.ts}|${p2oldest.id}`,
      limit: 3,
    });
    expect(page3).toEqual([]);
  });

  // Rev 7 §R7.1: same-timestamp boundary must page via the id tiebreak — no
  // dropped or duplicated messages when several share an identical ts.
  it("getChannelMessages pages a same-timestamp boundary via the id tiebreak", () => {
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "D@x", name: "Dana", kind: "dm" });
    const dana = upsertActor({ sourceId: "whatsapp", sourceExtId: "dana@x", displayName: "Dana", isSelf: false });

    // Four messages, all at the SAME ts. ids sort D/1 < D/2 < D/3 < D/4, so the
    // (ts,id) order is m1,m2,m3,m4 ascending.
    const SAME = "2026-07-01T10:00:00.000Z";
    insertEvent({ ...makeEvent("D/1", ch, dana, "m1"), ts: SAME });
    insertEvent({ ...makeEvent("D/2", ch, dana, "m2"), ts: SAME });
    insertEvent({ ...makeEvent("D/3", ch, dana, "m3"), ts: SAME });
    insertEvent({ ...makeEvent("D/4", ch, dana, "m4"), ts: SAME });

    // Newest window of 2 = the two highest ids at that ts: m3,m4.
    const page1 = getChannelMessages({ channelId: ch, limit: 2 });
    expect(page1.map((m) => m.text)).toEqual(["m3", "m4"]);

    // Cursor is the oldest loaded (m3). Same ts, so ONLY the id tiebreak selects
    // strictly-older rows: m1,m2 — m3 itself is excluded (no overlap).
    const oldest = page1[0];
    const page2 = getChannelMessages({
      channelId: ch,
      before: `${oldest.ts}|${oldest.id}`,
      limit: 2,
    });
    expect(page2.map((m) => m.text)).toEqual(["m1", "m2"]);
    expect([...page2, ...page1].map((m) => m.text)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  // Rev 7 §R7.1: reactions and replyTo must still attach on a PAGED window.
  it("getChannelMessages attaches reactions + replyTo on a before-cursor page", () => {
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "E@x", name: "Eve", kind: "dm" });
    const eve = upsertActor({ sourceId: "whatsapp", sourceExtId: "eve@x", displayName: "Eve", isSelf: false });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });
    appStateSet("whatsapp.self_jid", "me@x");

    // Older segment (paged to via cursor): a message, a reply quoting it, and a
    // reaction on the first message.
    insertEvent({ ...makeEvent("E/1", ch, eve, "dinner at 8?"), ts: "2026-07-01T10:00:00.000Z" });
    insertEvent({
      ...makeEvent("E/2", ch, self, "yes!"),
      ts: "2026-07-01T10:01:00.000Z",
      replyToExternalId: "E/1",
      replyToText: "dinner at 8?",
    });
    insertEvent(makeReaction("E/R1", ch, self, "E/1", "👍", "2026-07-01T10:02:00.000Z"));
    // Newer segment (the initial window): unrelated later messages.
    insertEvent({ ...makeEvent("E/3", ch, eve, "later"), ts: "2026-07-01T10:10:00.000Z" });
    insertEvent({ ...makeEvent("E/4", ch, eve, "latest"), ts: "2026-07-01T10:11:00.000Z" });

    // Newest window of 2 = E/3,E/4. Page older with the oldest (E/3) cursor.
    const page1 = getChannelMessages({ channelId: ch, limit: 2 });
    expect(page1.map((m) => m.text)).toEqual(["later", "latest"]);

    const oldest = page1[0];
    const older = getChannelMessages({
      channelId: ch,
      before: `${oldest.ts}|${oldest.id}`,
      limit: 2,
    });
    // The reaction row is NOT a stream bubble; only the 2 real messages appear.
    expect(older.map((m) => m.text)).toEqual(["dinner at 8?", "yes!"]);

    // Reaction attached to its target on the paged window.
    const target = older.find((m) => m.id === "wa:E/1")!;
    expect(target.reactions).toEqual([{ emoji: "👍", fromMe: true, actorName: "Me" }]);

    // Quoted reply resolves against the quoted message present in the same page.
    const reply = older.find((m) => m.id === "wa:E/2")!;
    expect(reply.replyTo).toEqual({
      externalId: "E/1",
      text: "dinner at 8?",
      actorName: "Eve",
    });
  });

  it("getEventById resolves media_path; app_state get/set round-trips", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const r = insertEvent({
      ...makeEvent("A/img", channelId, actorId, ""),
      mediaPath: "/tmp/SuperTwinV11/media/whatsapp/A/img.jpg",
    });
    const ev = getEventById(r.id);
    expect(ev?.mediaPath).toBe("/tmp/SuperTwinV11/media/whatsapp/A/img.jpg");
    expect(getEventById("wa:does-not-exist")).toBeNull();

    expect(appStateGet("k")).toBeNull();
    appStateSet("k", "v1");
    expect(appStateGet("k")).toBe("v1");
    appStateSet("k", "v2");
    expect(appStateGet("k")).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// Revision 6 §R6.5 (bug 4) — Inbox preview for text-less messages.
//   - When the latest non-reaction message has non-empty text, lastText is that
//     text (unchanged behaviour).
//   - When it is a media/other message with empty/null text, lastText is a
//     concise kind label (📷 Photo, 🎥 Video, 🎙️ Audio, 📄 Document, 📍 Location,
//     👤 Contact, 🚫 Deleted) so a media-only chat never shows "No messages".
//   - Reactions are still excluded from the preview/count; a zero-message channel
//     is still hidden (messageCount===0 never appears in the list).
// ---------------------------------------------------------------------------

/** Build a media/non-text event of a given kind with empty text. */
function makeMediaEvent(
  externalId: string,
  channelId: string,
  actorId: string,
  kind: string,
  ts: string,
  mediaPath: string | null = null,
) {
  return {
    externalId,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    channelId,
    actorId,
    ts,
    kind,
    text: "",
    mediaPath,
    rawJson: null,
  };
}

describe("listInboxChats lastText labelling for text-less messages (Rev 6 §R6.5)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("labels a media-only chat whose latest message is a video (not empty)", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "V@x", name: "Ghar+", kind: "group" });
    const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "s@x", displayName: "S", isSelf: false });

    // Many text messages, then a text-less video as the newest.
    insertEvent({ ...makeEvent("V/1", ch, actor, "hey"), ts: "2026-07-01T10:00:00.000Z" });
    insertEvent({ ...makeEvent("V/2", ch, actor, "sup"), ts: "2026-07-01T10:01:00.000Z" });
    insertEvent(makeMediaEvent("V/3", ch, actor, "video", "2026-07-01T10:02:00.000Z", "/m/v.mp4"));

    const chats = listInboxChats({ limit: 10 });
    expect(chats).toHaveLength(1);
    expect(chats[0].lastText).toBe("🎥 Video");
    expect(chats[0].lastText).not.toBe("");
    // Count is all 3 non-reaction messages; sort/last-ts is the video's ts.
    expect(chats[0].messageCount).toBe(3);
    expect(chats[0].lastTs).toBe("2026-07-01T10:02:00.000Z");
  });

  it("labels each media/other kind (image/audio/document/location/contact/revoked)", () => {
    const cases: Array<[string, string, string]> = [
      ["image", "📷 Photo", "I@x"],
      ["audio", "🎙️ Audio", "A@x"],
      ["document", "📄 Document", "D@x"],
      ["location", "📍 Location", "L@x"],
      ["contact", "👤 Contact", "C@x"],
      ["revoked", "🚫 Deleted", "R@x"],
    ];
    for (const [kind, label, ext] of cases) {
      const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: ext, name: kind, kind: "dm" });
      const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: `a-${ext}`, displayName: "A", isSelf: false });
      insertEvent(makeMediaEvent(`${ext}/1`, ch, actor, kind, "2026-07-01T10:00:00.000Z"));
      const chats = listInboxChats({ limit: 100 });
      const row = chats.find((c) => c.id === ch)!;
      expect(row.lastText).toBe(label);
    }
  });

  it("keeps the text when the latest message HAS text", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "T@x", name: "TextChat", kind: "dm" });
    const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "t@x", displayName: "T", isSelf: false });

    // Media first, then a real text message as the newest.
    insertEvent(makeMediaEvent("T/1", ch, actor, "image", "2026-07-01T10:00:00.000Z"));
    insertEvent({ ...makeEvent("T/2", ch, actor, "here's the plan"), ts: "2026-07-01T10:01:00.000Z" });

    const chats = listInboxChats({ limit: 10 });
    expect(chats.find((c) => c.id === ch)!.lastText).toBe("here's the plan");
  });

  it("labels a bare-URL text message as a link", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "U@x", name: "Links", kind: "dm" });
    const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "u@x", displayName: "U", isSelf: false });

    insertEvent({ ...makeEvent("U/1", ch, actor, "https://example.com/page"), ts: "2026-07-01T10:00:00.000Z" });

    const chats = listInboxChats({ limit: 10 });
    expect(chats.find((c) => c.id === ch)!.lastText).toBe("🔗 Link");
  });

  it("text that merely CONTAINS a url (with other words) stays as-is, not a link label", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "UM@x", name: "Mixed", kind: "dm" });
    const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "um@x", displayName: "U", isSelf: false });

    insertEvent({ ...makeEvent("UM/1", ch, actor, "check https://example.com out"), ts: "2026-07-01T10:00:00.000Z" });

    const chats = listInboxChats({ limit: 10 });
    expect(chats.find((c) => c.id === ch)!.lastText).toBe("check https://example.com out");
  });

  it("a reaction newer than a media message does not become the preview (still labelled media)", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "MR@x", name: "MediaReact", kind: "group" });
    const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "mr@x", displayName: "MR", isSelf: false });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });

    insertEvent(makeMediaEvent("MR/1", ch, actor, "image", "2026-07-01T10:00:00.000Z"));
    // A reaction lands LATER than the media message — must NOT be the preview.
    insertEvent(makeReaction("MR/R1", ch, self, "MR/1", "👍", "2026-07-01T11:00:00.000Z"));

    const chats = listInboxChats({ limit: 10 });
    const row = chats.find((c) => c.id === ch)!;
    expect(row.lastText).toBe("📷 Photo");
    expect(row.messageCount).toBe(1); // reaction excluded from count
    expect(row.lastTs).toBe("2026-07-01T10:00:00.000Z"); // media ts, not reaction ts
  });

  it("a channel whose ONLY row is a text-less reaction stays hidden (messageCount===0 case)", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "RO@x", name: "ReactOnly", kind: "dm" });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });
    insertEvent(makeReaction("RO/R1", ch, self, "other@x/MSG", "👍", "2026-07-01T10:00:00.000Z"));

    const chats = listInboxChats({ limit: 10 });
    expect(chats.map((c) => c.id)).not.toContain(ch);
  });
});

// ---------------------------------------------------------------------------
// Revision 5 §R5.3/§R5.4 — reactions + quoted replies.
//   - A reaction event (kind='reaction') attaches to its TARGET message via
//     reply_to_external_id and does NOT appear as a standalone message.
//   - A later empty-text reaction from the same actor REMOVES their reaction
//     (net-current state only).
//   - replyTo persists (reply_to_external_id + reply_to_text) and is returned,
//     with actorName resolved when the quoted actor is in the page.
//   - Reactions are excluded from listInboxChats (preview + count) and searchEvents.
// ---------------------------------------------------------------------------

/** Build a reaction event row targeting `targetExternalId` with `emoji` ("" = removal). */
function makeReaction(
  externalId: string,
  channelId: string,
  actorId: string,
  targetExternalId: string,
  emoji: string,
  ts: string,
) {
  return {
    externalId,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    channelId,
    actorId,
    ts,
    kind: "reaction",
    text: emoji, // "" = removal
    mediaPath: null,
    rawJson: null,
    replyToExternalId: targetExternalId,
    replyToText: null,
  };
}

describe("getChannelMessages reactions (Rev 5 §R5.3)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("attaches a reaction to its target message and does NOT surface it as a standalone message", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const other = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice", isSelf: false });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });
    appStateSet("whatsapp.self_jid", "me@x");

    // Target message from Alice, then a 👍 reaction from self.
    insertEvent({ ...makeEvent("A/1", ch, other, "dinner at 8?"), ts: "2026-07-01T10:00:00.000Z" });
    insertEvent(makeReaction("A/R1", ch, self, "A/1", "👍", "2026-07-01T10:01:00.000Z"));

    const msgs = getChannelMessages({ channelId: ch, limit: 10 });
    // Only the real message is in the stream — the reaction is NOT a bubble.
    expect(msgs.map((m) => m.text)).toEqual(["dinner at 8?"]);
    expect(msgs.every((m) => m.kind !== "reaction")).toBe(true);
    // The reaction is attached to its target.
    expect(msgs[0].reactions).toEqual([
      { emoji: "👍", fromMe: true, actorName: "Me" },
    ]);
  });

  it("aggregates multiple distinct actors' reactions on one message", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "G@x", name: "Group", kind: "group" });
    const alice = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice", isSelf: false });
    const bob = upsertActor({ sourceId: "whatsapp", sourceExtId: "bob@x", displayName: "Bob", isSelf: false });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });
    appStateSet("whatsapp.self_jid", "me@x");

    insertEvent({ ...makeEvent("G/1", ch, alice, "ship it 🚀"), ts: "2026-07-01T10:00:00.000Z" });
    insertEvent(makeReaction("G/R1", ch, bob, "G/1", "❤️", "2026-07-01T10:01:00.000Z"));
    insertEvent(makeReaction("G/R2", ch, self, "G/1", "🎉", "2026-07-01T10:02:00.000Z"));

    const msgs = getChannelMessages({ channelId: ch, limit: 10 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].reactions).toEqual([
      { emoji: "❤️", fromMe: false, actorName: "Bob" },
      { emoji: "🎉", fromMe: true, actorName: "Me" },
    ]);
  });

  it("a later empty-text reaction from the same actor REMOVES their reaction (net-current state)", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const other = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice", isSelf: false });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });
    appStateSet("whatsapp.self_jid", "me@x");

    insertEvent({ ...makeEvent("A/1", ch, other, "coffee?"), ts: "2026-07-01T10:00:00.000Z" });
    // self reacts 👍, then removes it (empty-text reaction).
    insertEvent(makeReaction("A/R1", ch, self, "A/1", "👍", "2026-07-01T10:01:00.000Z"));
    insertEvent(makeReaction("A/R2", ch, self, "A/1", "", "2026-07-01T10:02:00.000Z"));

    const msgs = getChannelMessages({ channelId: ch, limit: 10 });
    expect(msgs).toHaveLength(1);
    // Net-current: self removed theirs, so no reactions remain.
    expect(msgs[0].reactions).toEqual([]);
  });

  it("an actor changing their emoji keeps only the latest (one reaction per actor)", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const other = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice", isSelf: false });
    appStateSet("whatsapp.self_jid", "me@x");

    insertEvent({ ...makeEvent("A/1", ch, other, "news!"), ts: "2026-07-01T10:00:00.000Z" });
    insertEvent(makeReaction("A/R1", ch, other, "A/1", "👍", "2026-07-01T10:01:00.000Z"));
    insertEvent(makeReaction("A/R2", ch, other, "A/1", "😮", "2026-07-01T10:03:00.000Z"));

    const msgs = getChannelMessages({ channelId: ch, limit: 10 });
    expect(msgs[0].reactions).toEqual([
      { emoji: "😮", fromMe: false, actorName: "Alice" },
    ]);
  });

  it("removal then re-add: the actor's reaction comes back", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const other = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice", isSelf: false });

    insertEvent({ ...makeEvent("A/1", ch, other, "hi"), ts: "2026-07-01T10:00:00.000Z" });
    insertEvent(makeReaction("A/R1", ch, other, "A/1", "👍", "2026-07-01T10:01:00.000Z"));
    insertEvent(makeReaction("A/R2", ch, other, "A/1", "", "2026-07-01T10:02:00.000Z"));
    insertEvent(makeReaction("A/R3", ch, other, "A/1", "🔥", "2026-07-01T10:03:00.000Z"));

    const msgs = getChannelMessages({ channelId: ch, limit: 10 });
    expect(msgs[0].reactions).toEqual([
      { emoji: "🔥", fromMe: false, actorName: "Alice" },
    ]);
  });
});

describe("getChannelMessages quoted replies (Rev 5 §R5.4)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("persists reply_to_external_id + reply_to_text and returns replyTo with resolved actorName", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const alice = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice", isSelf: false });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });
    appStateSet("whatsapp.self_jid", "me@x");

    // Original from Alice, then a self reply quoting it.
    insertEvent({ ...makeEvent("A/1", ch, alice, "dinner at 8?"), ts: "2026-07-01T10:00:00.000Z" });
    insertEvent({
      ...makeEvent("A/2", ch, self, "yes!"),
      ts: "2026-07-01T10:05:00.000Z",
      replyToExternalId: "A/1",
      replyToText: "dinner at 8?",
    });

    const msgs = getChannelMessages({ channelId: ch, limit: 10 });
    const reply = msgs.find((m) => m.id === "wa:A/2")!;
    expect(reply.replyTo).toEqual({
      externalId: "A/1",
      text: "dinner at 8?",
      actorName: "Alice", // resolved from the quoted message in the page
    });
    // A non-reply message has replyTo === null.
    expect(msgs.find((m) => m.id === "wa:A/1")!.replyTo).toBeNull();

    // The columns are actually stored on the row.
    const stored = getDb()
      .prepare(`SELECT reply_to_external_id, reply_to_text FROM events WHERE id = 'wa:A/2'`)
      .get() as { reply_to_external_id: string | null; reply_to_text: string | null };
    expect(stored.reply_to_external_id).toBe("A/1");
    expect(stored.reply_to_text).toBe("dinner at 8?");
  });

  it("returns the stored snippet with actorName=null when the quoted target is not in the imported set", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });
    appStateSet("whatsapp.self_jid", "me@x");

    // Reply whose quoted target (A/OLD) was never imported.
    insertEvent({
      ...makeEvent("A/2", ch, self, "agreed"),
      ts: "2026-07-01T10:05:00.000Z",
      replyToExternalId: "A/OLD",
      replyToText: "the older message",
    });

    const msgs = getChannelMessages({ channelId: ch, limit: 10 });
    expect(msgs[0].replyTo).toEqual({
      externalId: "A/OLD",
      text: "the older message",
      actorName: null,
    });
  });
});

describe("reactions excluded from inbox preview/count + search (Rev 5 §R5.3)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("listInboxChats: a reaction is not the chat's last message and is not counted", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const alice = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice", isSelf: false });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });

    insertEvent({ ...makeEvent("A/1", ch, alice, "let us meet"), ts: "2026-07-01T10:00:00.000Z" });
    // A reaction lands LATER than the last real message.
    insertEvent(makeReaction("A/R1", ch, self, "A/1", "👍", "2026-07-01T11:00:00.000Z"));

    const chats = listInboxChats({ limit: 10 });
    expect(chats).toHaveLength(1);
    // Preview is the real message, NOT the reaction emoji.
    expect(chats[0].lastText).toBe("let us meet");
    expect(chats[0].lastTs).toBe("2026-07-01T10:00:00.000Z");
    // Count excludes the reaction row.
    expect(chats[0].messageCount).toBe(1);
  });

  it("listInboxChats: a channel whose ONLY rows are reactions/system stays hidden (empty per R4.3)", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "R@x", name: "Reactful", kind: "dm" });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });
    // Only a reaction row (its target lives elsewhere / not imported) — no real message.
    insertEvent(makeReaction("R/R1", ch, self, "other@x/MSG", "👍", "2026-07-01T10:00:00.000Z"));

    const chats = listInboxChats({ limit: 10 });
    expect(chats.map((c) => c.id)).not.toContain(ch);
    expect(chats).toHaveLength(0);
  });

  it("searchEvents: reaction rows are excluded from FTS results", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const alice = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice", isSelf: false });
    const self = upsertActor({ sourceId: "whatsapp", sourceExtId: "me@x", displayName: "Me", isSelf: true });

    // A normal message containing an emoji-ish word, plus a reaction whose text
    // would otherwise match. Use a searchable ascii token to keep FTS simple.
    insertEvent({ ...makeEvent("A/1", ch, alice, "party time"), ts: "2026-07-01T10:00:00.000Z" });
    insertEvent(makeReaction("A/R1", ch, self, "A/1", "party", "2026-07-01T10:01:00.000Z"));

    const hits = searchEvents({ q: "party" });
    // Only the real message matches; the reaction row is filtered out.
    expect(hits.map((h) => h.eventId)).toEqual(["wa:A/1"]);
  });
});

// ---------------------------------------------------------------------------
// Rev 2 §R2.4 — name-updating upserts (supports bug 4).
// The daemon re-emits channel/actor lines when it learns a better name later:
// a JID/empty placeholder must UPGRADE to a real name, and a real name must
// never DOWNGRADE to an empty/number/JID placeholder.
// ---------------------------------------------------------------------------

function channelNameOf(id: string): string | null {
  const row = getDb().prepare(`SELECT name FROM channels WHERE id = ?`).get(id) as
    | { name: string | null }
    | undefined;
  return row?.name ?? null;
}
function actorNameOf(id: string): string | null {
  const row = getDb()
    .prepare(`SELECT display_name FROM actors WHERE id = ?`)
    .get(id) as { display_name: string | null } | undefined;
  return row?.display_name ?? null;
}
function actorHandleOf(id: string): string | null {
  const row = getDb().prepare(`SELECT handle FROM actors WHERE id = ?`).get(id) as
    | { handle: string | null }
    | undefined;
  return row?.handle ?? null;
}

describe("upsertChannel name-update semantics (Rev 2 §R2.4)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("upgrades a JID-placeholder name to a real name when it later arrives", () => {
    // First seen only as a JID placeholder (name looks like a JID).
    const id = upsertChannel({
      sourceId: "whatsapp",
      sourceExtId: "grp-123@g.us",
      name: "grp-123@g.us",
      kind: "group",
    });
    expect(channelNameOf(id)).toBe("grp-123@g.us");

    // Daemon learns the real group subject later.
    upsertChannel({ sourceId: "whatsapp", sourceExtId: "grp-123@g.us", name: "Family" });
    expect(channelNameOf(id)).toBe("Family");
  });

  it("upgrades from a null/lazy placeholder to a real name", () => {
    // Lazy upsert (event before channel line): no name.
    const id = upsertChannel({ sourceId: "whatsapp", sourceExtId: "a@x" });
    expect(channelNameOf(id)).toBeNull();
    upsertChannel({ sourceId: "whatsapp", sourceExtId: "a@x", name: "Alice" });
    expect(channelNameOf(id)).toBe("Alice");
  });

  it("does NOT downgrade a real name to empty/null/JID-looking", () => {
    const id = upsertChannel({
      sourceId: "whatsapp",
      sourceExtId: "b@x",
      name: "Bob",
      kind: "dm",
    });
    // A later lazy upsert (null name) must not wipe the good name.
    upsertChannel({ sourceId: "whatsapp", sourceExtId: "b@x" });
    expect(channelNameOf(id)).toBe("Bob");
    // An empty-string name must not wipe it either.
    upsertChannel({ sourceId: "whatsapp", sourceExtId: "b@x", name: "" });
    expect(channelNameOf(id)).toBe("Bob");
    // A JID-looking value must not clobber the good name.
    upsertChannel({ sourceId: "whatsapp", sourceExtId: "b@x", name: "b@x" });
    expect(channelNameOf(id)).toBe("Bob");
  });
});

describe("upsertActor name-update semantics (Rev 2 §R2.4)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("upgrades a JID-placeholder display_name to a real name when it later arrives", () => {
    const id = upsertActor({
      sourceId: "whatsapp",
      sourceExtId: "mom@s.whatsapp.net",
      displayName: "mom@s.whatsapp.net",
      isSelf: false,
    });
    expect(actorNameOf(id)).toBe("mom@s.whatsapp.net");
    upsertActor({
      sourceId: "whatsapp",
      sourceExtId: "mom@s.whatsapp.net",
      displayName: "Mom",
    });
    expect(actorNameOf(id)).toBe("Mom");
  });

  it("does NOT downgrade a real display_name to empty/null/JID-looking", () => {
    const id = upsertActor({
      sourceId: "whatsapp",
      sourceExtId: "dad@x",
      displayName: "Dad",
      handle: "+15551234",
      isSelf: false,
    });
    upsertActor({ sourceId: "whatsapp", sourceExtId: "dad@x" }); // lazy null
    expect(actorNameOf(id)).toBe("Dad");
    upsertActor({ sourceId: "whatsapp", sourceExtId: "dad@x", displayName: "" });
    expect(actorNameOf(id)).toBe("Dad");
    upsertActor({ sourceId: "whatsapp", sourceExtId: "dad@x", displayName: "dad@x" });
    expect(actorNameOf(id)).toBe("Dad");
    // handle (a phone number) is retained across a lazy null upsert.
    expect(actorHandleOf(id)).toBe("+15551234");
  });
});

// ---------------------------------------------------------------------------
// Rev 2 §R2.3 — resetWhatsappData().
// ---------------------------------------------------------------------------

describe("resetWhatsappData (Rev 2 §R2.3)", () => {
  it("clears events/channels/actors + orphan people + import flags, returns counts", () => {
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    const chA = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const chB = upsertChannel({ sourceId: "whatsapp", sourceExtId: "B@x", name: "Bob", kind: "dm" });
    const acA = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice" });
    const acB = upsertActor({ sourceId: "whatsapp", sourceExtId: "bob@x", displayName: "Bob" });

    insertEvent(makeEvent("A/1", chA, acA, "hi from A"));
    insertEvent(makeEvent("A/2", chA, acA, "more A"));
    insertEvent(makeEvent("B/1", chB, acB, "hi from B"));

    // Simulate the persisted import flags.
    appStateSet(IMPORT_DONE_KEY, "true");
    appStateSet(IMPORT_RANGE_KEY, "7d");

    const cleared = resetWhatsappData("whatsapp");
    expect(cleared).toEqual({ events: 3, channels: 2, actors: 2 });

    const db = getDb();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM channels`).get() as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM actors`).get() as { n: number }).n).toBe(0);
    // People orphaned by the actor delete are removed too.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM people`).get() as { n: number }).n).toBe(0);
    // FTS auto-synced via triggers: a prior term no longer matches.
    expect(searchEvents({ q: "hi" })).toEqual([]);

    // Import flags cleared.
    expect(appStateGet(IMPORT_DONE_KEY)).toBeNull();
    expect(appStateGet(IMPORT_RANGE_KEY)).toBeNull();
  });

  it("only touches the target source (other sources are left intact)", () => {
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    upsertSource({ id: "other", type: "other", name: "Other" });
    const waCh = upsertChannel({ sourceId: "whatsapp", sourceExtId: "A@x", name: "Alice", kind: "dm" });
    const waAc = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice" });
    insertEvent(makeEvent("A/1", waCh, waAc, "wa msg"));

    const otherCh = upsertChannel({ sourceId: "other", sourceExtId: "O@x", name: "Ozzy", kind: "dm" });
    const otherAc = upsertActor({ sourceId: "other", sourceExtId: "ozzy@x", displayName: "Ozzy" });
    insertEvent({
      externalId: "O/1",
      sourceId: "other",
      sourceType: "other",
      channelId: otherCh,
      actorId: otherAc,
      ts: "2026-07-02T12:00:00.000Z",
      kind: "message",
      text: "other msg",
      mediaPath: null,
      rawJson: null,
    });

    const cleared = resetWhatsappData("whatsapp");
    expect(cleared).toEqual({ events: 1, channels: 1, actors: 1 });

    const db = getDb();
    // The other source's rows survive.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source_id='other'`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM channels WHERE source_id='other'`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM actors WHERE source_id='other'`).get() as { n: number }).n).toBe(1);
    // Its person is retained (still referenced by the surviving actor).
    expect((db.prepare(`SELECT COUNT(*) AS n FROM people`).get() as { n: number }).n).toBe(1);
  });

  it("is a no-op-safe on an empty DB (returns zero counts)", () => {
    upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
    expect(resetWhatsappData("whatsapp")).toEqual({ events: 0, channels: 0, actors: 0 });
  });
});

// ---------------------------------------------------------------------------
// Media spec §4 — migration 0008_media.
// ---------------------------------------------------------------------------

/** Apply every migration BEFORE 0008 to `handle` — an install predating media. */
function seedPreMediaDb(handle: Database.Database): void {
  handle.exec(`
    CREATE TABLE schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  const record = handle.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`);
  for (const m of MIGRATIONS) {
    // 0009 backfills a column 0008 adds, so it cannot be seeded ahead of it.
    if (m.id === "0008_media") break;
    handle.exec(m.sql);
    record.run(m.id);
  }
}

describe("migration 0008_media", () => {
  it("adds the media/edit/revoke columns + the desc-status index on a fresh DB", () => {
    runMigrations();
    const db = getDb();
    const cols = (db.prepare(`PRAGMA table_info(events)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        "media_mime",
        "media_filename",
        "media_size",
        "media_sha256",
        "media_thumb_path",
        "media_seconds",
        "media_meta_json",
        "media_description",
        "media_desc_status",
        "media_desc_model",
        "media_desc_ts",
        "media_desc_error",
        "edited_at",
        "revoked_at",
        "is_forwarded",
      ]),
    );

    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_desc_status'`)
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_events_desc_status");
  });

  it("rebuilds events_fts with the three triggers, message text first", () => {
    runMigrations();
    const db = getDb();
    const cols = (db.prepare(`PRAGMA table_info(events_fts)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    // 0011, then 0016, then 0017 widened this; column 0 is pinned by
    // snippet(events_fts, 0, …) and every later column keeps its ordinal.
    expect(cols).toEqual([
      "text",
      "media_description",
      "link_title",
      "link_description",
      "link_scraped_text",
      "transcript",
      "reply_to_text",
    ]);

    const triggers = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`)
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(triggers).toEqual(["events_ad", "events_ai", "events_au"]);
  });

  it("upgrades a pre-media DB: only the media migrations apply and FTS still returns pre-existing hits", () => {
    const raw = new Database(dbPath);
    seedPreMediaDb(raw);
    // Rows written under the OLD single-column FTS — the rebuild must keep them.
    raw.prepare(`INSERT INTO events (id, text) VALUES (?, ?)`).run("e1", "let us meet for coffee");
    expect(
      (raw.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH ?`).all("coffee")).length,
    ).toBe(1);

    runMigrationsOn(raw);

    const applied = (raw.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as {
      id: string;
    }[]).map((r) => r.id);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
    // Rebuilt index: the old row is still findable, and a description is too.
    expect(
      (raw.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH ?`).all("coffee")).length,
    ).toBe(1);
    raw
      .prepare(`UPDATE events SET media_description = ? WHERE id = ?`)
      .run("a red bicycle against a wall", "e1");
    expect(
      (raw.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH ?`).all("bicycle")).length,
    ).toBe(1);
    raw.close();
  });

  it("tolerates a partially-applied ADD COLUMN on a dev DB (trigger bodies survive the split)", () => {
    const raw = new Database(dbPath);
    seedPreMediaDb(raw);
    // A hand-mangled dev DB: one 0008 column already exists, so the whole-body
    // exec fails and the statement-by-statement fallback runs.
    raw.exec(`ALTER TABLE events ADD COLUMN media_mime TEXT;`);

    runMigrationsOn(raw);

    const applied = (raw.prepare(`SELECT id FROM schema_migrations WHERE id='0008_media'`).all() as {
      id: string;
    }[]);
    expect(applied.length).toBe(1);
    // The triggers were recreated intact (a naive `;` split would truncate them).
    raw
      .prepare(`INSERT INTO events (id, text, media_description) VALUES (?, ?, ?)`)
      .run("e2", "", "a scanned invoice for the plumber");
    expect(
      (raw.prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH ?`).all("plumber")).length,
    ).toBe(1);
    raw.close();
  });
});

// ---------------------------------------------------------------------------
// Media spec §3/§4 — media metadata persistence + the desc-status queue seed.
// ---------------------------------------------------------------------------

/** A media event row with the full §1 metadata set. */
function makeRichMediaEvent(
  externalId: string,
  channelId: string,
  actorId: string,
  kind: string,
  overrides: Partial<Parameters<typeof insertEvent>[0]> = {},
) {
  return {
    externalId,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    channelId,
    actorId,
    ts: "2026-07-02T12:00:00.000Z",
    kind,
    text: "",
    mediaPath: `/media/whatsapp/${externalId}.bin`,
    rawJson: null,
    mediaMime: "image/jpeg",
    mediaFilename: "photo.jpg",
    mediaSize: 20480,
    mediaSha256: "abc123",
    mediaThumbPath: `/media/whatsapp/${externalId}.thumb.jpg`,
    mediaSeconds: null,
    mediaMetaJson: JSON.stringify({ width: 1600, height: 900, caption: "the whiteboard" }),
    ...overrides,
  };
}

describe("media metadata persistence (media spec §3, §4)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("insertEvent writes every media column and both read paths hand it back", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const res = insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));

    const msgs = getChannelMessages({ channelId, limit: 10 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      kind: "image",
      mediaPath: "/media/whatsapp/A/IMG.bin",
      mediaMime: "image/jpeg",
      mediaFilename: "photo.jpg",
      mediaSize: 20480,
      mediaThumbPath: "/media/whatsapp/A/IMG.thumb.jpg",
      mediaMeta: { width: 1600, height: 900, caption: "the whiteboard" },
      isForwarded: false,
    });

    const ev = getEventById(res.id)!;
    expect(ev).toMatchObject({
      id: res.id,
      kind: "image",
      mediaPath: "/media/whatsapp/A/IMG.bin",
      mediaMime: "image/jpeg",
      mediaSha256: "abc123",
      mediaThumbPath: "/media/whatsapp/A/IMG.thumb.jpg",
      mediaMeta: { width: 1600, height: 900 },
      mediaDescription: null,
    });
  });

  it("persists is_forwarded", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent({ ...makeEvent("A/FWD", channelId, actorId, "fyi"), isForwarded: true });
    expect(getChannelMessages({ channelId, limit: 10 })[0].isForwarded).toBe(true);
  });

  it("a corrupt media_meta_json reads back as null instead of throwing", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(
      makeRichMediaEvent("A/BAD", channelId, actorId, "image", { mediaMetaJson: "{not json" }),
    );
    expect(getChannelMessages({ channelId, limit: 10 })[0].mediaMeta).toBeNull();
  });

  it("seeds media_desc_status per the §8 readability table", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const statusOf = (id: string): string | null =>
      (
        getDb()
          .prepare(`SELECT media_desc_status AS s FROM events WHERE external_id = ?`)
          .get(id) as { s: string | null }
      ).s;

    insertEvent(makeRichMediaEvent("m/img", channelId, actorId, "image"));
    insertEvent(makeRichMediaEvent("m/sticker", channelId, actorId, "sticker"));
    insertEvent(
      makeRichMediaEvent("m/video", channelId, actorId, "video", { mediaMime: "video/mp4" }),
    );
    // A video with no JPEG thumbnail still has its mp4 (v7 §3).
    insertEvent(
      makeRichMediaEvent("m/video-nothumb", channelId, actorId, "video", {
        mediaMime: "video/mp4",
        mediaThumbPath: null,
      }),
    );
    insertEvent(
      makeRichMediaEvent("m/pdf", channelId, actorId, "document", {
        mediaMime: "application/pdf",
        mediaFilename: "contract.pdf",
      }),
    );
    insertEvent(
      makeRichMediaEvent("m/csv", channelId, actorId, "document", {
        mediaMime: null,
        mediaFilename: "rows.CSV",
      }),
    );
    insertEvent(
      makeRichMediaEvent("m/docx", channelId, actorId, "document", {
        mediaMime:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        mediaFilename: "notes.docx",
      }),
    );
    insertEvent(
      makeRichMediaEvent("m/audio", channelId, actorId, "audio", {
        mediaMime: "audio/ogg; codecs=opus",
        mediaMetaJson: JSON.stringify({ voice: true }),
      }),
    );
    insertEvent(makeEvent("m/text", channelId, actorId, "just words"));

    expect(statusOf("m/img")).toBe("pending");
    expect(statusOf("m/sticker")).toBe("pending");
    expect(statusOf("m/video")).toBe("pending");
    expect(statusOf("m/video-nothumb")).toBe("pending");
    expect(statusOf("m/pdf")).toBe("pending");
    expect(statusOf("m/csv")).toBe("pending");
    expect(statusOf("m/docx")).toBe("unsupported");
    expect(statusOf("m/audio")).toBe("unsupported");
    expect(statusOf("m/text")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Media spec §5 — edit + revoke rewrite their target row.
// ---------------------------------------------------------------------------

describe("applyEdit / applyRevoke (media spec §5)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("applyEdit rewrites the target in place, stamps edited_at, and re-indexes FTS", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeEvent("A/1", channelId, actorId, "meet at seven"));

    expect(
      applyEdit({
        sourceId: "whatsapp",
        targetExternalId: "A/1",
        text: "meet at eight",
        editedAt: "2026-07-02T13:00:00.000Z",
      }),
    ).toBe(true);

    const msgs = getChannelMessages({ channelId, limit: 10 });
    // One row, not two: the edit never becomes its own message.
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("meet at eight");
    expect(msgs[0].editedAt).toBe("2026-07-02T13:00:00.000Z");
    expect(searchEvents({ q: "eight" }).map((h) => h.eventId)).toEqual(["wa:A/1"]);
    expect(searchEvents({ q: "seven" })).toEqual([]);
  });

  it("applyEdit returns false when the target has not been ingested yet", () => {
    seedSourceChannelActor();
    expect(
      applyEdit({
        sourceId: "whatsapp",
        targetExternalId: "A/missing",
        text: "edited body",
        editedAt: "2026-07-02T13:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("applyRevoke tombstones the target: text cleared, media dropped, revoked_at set", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));

    expect(
      applyRevoke({
        sourceId: "whatsapp",
        targetExternalId: "A/IMG",
        revokedAt: "2026-07-02T13:00:00.000Z",
      }),
    ).toBe(true);

    const msgs = getChannelMessages({ channelId, limit: 10 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("");
    expect(msgs[0].mediaPath).toBeNull();
    expect(msgs[0].revokedAt).toBe("2026-07-02T13:00:00.000Z");
  });

  it("revoking a message still queued for description clears it out of the queue", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));
    expect(claimPendingMedia(10, CLAIM_ALL).map((r) => r.id)).toContain("wa:A/IMG");

    applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "A/IMG",
      revokedAt: "2026-07-02T13:00:00.000Z",
    });

    expect(claimPendingMedia(10, CLAIM_ALL)).toHaveLength(0);
    // The queue counts read the column directly, so leaving it 'pending' would
    // show a backlog nothing can ever drain.
    const row = getDb()
      .prepare("SELECT media_desc_status AS s FROM events WHERE id = ?")
      .get("wa:A/IMG") as { s: string | null };
    expect(row.s).toBeNull();
  });

  it("a revoked message previews as deleted, not as its original media kind", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));
    applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "A/IMG",
      revokedAt: "2026-07-02T13:00:00.000Z",
    });

    const chat = listInboxChats({ limit: 10 }).find((c) => c.id === channelId)!;
    expect(chat.lastText).toBe("🚫 Deleted");
  });

  it("applyRevoke returns false when the target has not been ingested yet", () => {
    seedSourceChannelActor();
    expect(
      applyRevoke({
        sourceId: "whatsapp",
        targetExternalId: "A/missing",
        revokedAt: "2026-07-02T13:00:00.000Z",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Media spec §6 — reaction removal deletes the stored row.
// ---------------------------------------------------------------------------

describe("deleteReaction (media spec §6)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("deletes only the removing actor's reaction on that target", () => {
    const ch = upsertChannel({ sourceId: "whatsapp", sourceExtId: "G@x", name: "Group", kind: "group" });
    const alice = upsertActor({ sourceId: "whatsapp", sourceExtId: "alice@x", displayName: "Alice" });
    const bob = upsertActor({ sourceId: "whatsapp", sourceExtId: "bob@x", displayName: "Bob" });

    insertEvent({ ...makeEvent("G/1", ch, alice, "ship it"), ts: "2026-07-01T10:00:00.000Z" });
    insertEvent(makeReaction("G/R1", ch, alice, "G/1", "👍", "2026-07-01T10:01:00.000Z"));
    insertEvent(makeReaction("G/R2", ch, bob, "G/1", "🎉", "2026-07-01T10:02:00.000Z"));

    expect(
      deleteReaction({ sourceId: "whatsapp", targetExternalId: "G/1", actorId: alice }),
    ).toBe(1);

    // Bob's survives, and the collapse sees exactly one stored row.
    expect(getChannelMessages({ channelId: ch, limit: 10 })[0].reactions).toEqual([
      { emoji: "🎉", fromMe: false, actorName: "Bob" },
    ]);
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE kind='reaction'`).get() as {
        n: number;
      }).n,
    ).toBe(1);
  });

  it("returns 0 when the actor has no stored reaction on the target", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeEvent("A/1", channelId, actorId, "hi"));
    expect(
      deleteReaction({ sourceId: "whatsapp", targetExternalId: "A/1", actorId }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Media spec §8 — the media-reading queue.
// ---------------------------------------------------------------------------

describe("claimPendingMedia / recordMediaDescription (media spec §8)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("returns pending rows batchable-first with the fields the reader needs", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(
      makeRichMediaEvent("A/IMG", channelId, actorId, "image", { ts: "2026-07-02T10:00:00.000Z" }),
    );
    insertEvent(
      makeRichMediaEvent("A/VID", channelId, actorId, "video", {
        ts: "2026-07-02T11:00:00.000Z",
        mediaMime: "video/mp4",
        mediaFilename: "clip.mp4",
        mediaSeconds: 42,
        mediaMetaJson: JSON.stringify({ caption: "the dog again" }),
      }),
    );
    // Never readable: it must not show up in the queue.
    insertEvent(
      makeRichMediaEvent("A/AUD", channelId, actorId, "audio", {
        ts: "2026-07-02T12:00:00.000Z",
        mediaMime: "audio/ogg",
      }),
    );

    // The video is newer, but it cannot ride a batch — so it does not get to
    // sit at the head of the claim (v4 §4c).
    const pending = claimPendingMedia(10, CLAIM_ALL);
    expect(pending.map((p) => p.id)).toEqual(["wa:A/IMG", "wa:A/VID"]);
    expect(pending[1]).toEqual({
      id: "wa:A/VID",
      kind: "video",
      mediaPath: "/media/whatsapp/A/VID.bin",
      thumbPath: "/media/whatsapp/A/VID.thumb.jpg",
      mime: "video/mp4",
      filename: "clip.mp4",
      seconds: 42,
      caption: "the dog again",
      isHistorical: false,
    });
    expect(pending[0].caption).toBe("the whiteboard");
  });

  it("still claims a row whose meta JSON is unreadable (caption just goes null)", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(
      makeRichMediaEvent("A/IMG", channelId, actorId, "image", { mediaMetaJson: "{not json" }),
    );
    expect(claimPendingMedia(10, CLAIM_ALL)).toEqual([
      {
        id: "wa:A/IMG",
        kind: "image",
        mediaPath: "/media/whatsapp/A/IMG.bin",
        thumbPath: "/media/whatsapp/A/IMG.thumb.jpg",
        mime: "image/jpeg",
        filename: "photo.jpg",
        seconds: null,
        caption: null,
        isHistorical: false,
      },
    ]);
  });

  it("honours the limit and never hands out a revoked row", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(
      makeRichMediaEvent("A/1", channelId, actorId, "image", { ts: "2026-07-02T10:00:00.000Z" }),
    );
    insertEvent(
      makeRichMediaEvent("A/2", channelId, actorId, "image", { ts: "2026-07-02T11:00:00.000Z" }),
    );
    expect(claimPendingMedia(1, CLAIM_ALL).map((p) => p.id)).toEqual(["wa:A/2"]);

    applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "A/2",
      revokedAt: "2026-07-02T12:00:00.000Z",
    });
    expect(claimPendingMedia(10, CLAIM_ALL).map((p) => p.id)).toEqual(["wa:A/1"]);
  });

  it("recordMediaDescription clears the row from the queue and makes it searchable", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));

    recordMediaDescription(id, {
      description: "a whiteboard covered in migration diagrams",
      model: "claude-haiku-4-5-20251001",
      status: "done",
    });

    expect(claimPendingMedia(10, CLAIM_ALL)).toEqual([]);
    expect(getEventById(id)!.mediaDescription).toBe(
      "a whiteboard covered in migration diagrams",
    );
    expect(getChannelMessages({ channelId, limit: 10 })[0].mediaDescription).toBe(
      "a whiteboard covered in migration diagrams",
    );

    // Grounded chat can now find the image by what is IN it.
    const hits = searchEvents({ q: "migration diagrams" });
    expect(hits.map((h) => h.eventId)).toEqual([id]);
    expect(hits[0].snippet).toContain("diagrams");

    const stored = getDb()
      .prepare(`SELECT media_desc_model AS m, media_desc_status AS s, media_desc_ts AS t FROM events WHERE id = ?`)
      .get(id) as { m: string | null; s: string | null; t: string | null };
    expect(stored).toMatchObject({ m: "claude-haiku-4-5-20251001", s: "done" });
    expect(stored.t).toBeTruthy();
  });

  it("records a failed read as 'error' with the message and leaves the queue empty", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));

    recordMediaDescription(id, { status: "error", error: "file missing on disk" });

    expect(claimPendingMedia(10, CLAIM_ALL)).toEqual([]);
    const stored = getDb()
      .prepare(`SELECT media_desc_status AS s, media_desc_error AS e, media_description AS d FROM events WHERE id = ?`)
      .get(id) as { s: string; e: string; d: string | null };
    expect(stored).toEqual({ s: "error", e: "file missing on disk", d: null });
  });
});

// ---------------------------------------------------------------------------
// v3 §2 — the switches gate the CLAIM, not the insert. The property that
// matters is the one insert-time gating cannot have: flipping a switch on later
// still reaches rows that were already written.
// ---------------------------------------------------------------------------

const CLAIM_IMAGES_ONLY: MediaClaimFilter = {
  images: true,
  video: false,
  documents: false,
  business: false,
};

describe("claimPendingMedia per-kind + business gating (v3 §2)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  /** One readable row of each kind in the same chat, newest first: doc, vid, img. */
  function seedOneOfEachKind(channelId: string, actorId: string): void {
    insertEvent(
      makeRichMediaEvent("A/IMG", channelId, actorId, "image", { ts: "2026-07-02T10:00:00.000Z" }),
    );
    insertEvent(
      makeRichMediaEvent("A/VID", channelId, actorId, "video", { ts: "2026-07-02T11:00:00.000Z" }),
    );
    insertEvent(
      makeRichMediaEvent("A/DOC", channelId, actorId, "document", {
        ts: "2026-07-02T12:00:00.000Z",
        mediaMime: "application/pdf",
        mediaFilename: "invoice.pdf",
      }),
    );
  }

  it("hands out only the kinds the filter switches on", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    seedOneOfEachKind(channelId, actorId);

    expect(claimPendingMedia(10, CLAIM_IMAGES_ONLY).map((r) => r.id)).toEqual(["wa:A/IMG"]);
    expect(
      claimPendingMedia(10, { ...CLAIM_ALL, video: false }).map((r) => r.id),
    ).toEqual(["wa:A/IMG", "wa:A/DOC"]);
    expect(claimPendingMedia(10, CLAIM_ALL).map((r) => r.id)).toEqual([
      "wa:A/IMG",
      "wa:A/DOC",
      "wa:A/VID",
    ]);
  });

  it("stickers ride the image switch", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeRichMediaEvent("A/STK", channelId, actorId, "sticker"));

    expect(claimPendingMedia(10, CLAIM_IMAGES_ONLY).map((r) => r.id)).toEqual(["wa:A/STK"]);
    expect(claimPendingMedia(10, { ...CLAIM_ALL, images: false })).toEqual([]);
  });

  it("a switch flipped on later still reaches rows written while it was off", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video"));

    // Video off at ingest time: the row is invisible but NOT written off.
    expect(claimPendingMedia(10, CLAIM_IMAGES_ONLY)).toEqual([]);
    expect(claimPendingMedia(10, CLAIM_ALL).map((r) => r.id)).toEqual(["wa:A/VID"]);
  });

  it("excludes business chats unless the filter includes them", () => {
    const shop = upsertChannel({
      sourceId: "whatsapp",
      sourceExtId: "shop@s.whatsapp.net",
      name: "Corner Store",
      kind: "dm",
      isBusiness: true,
    });
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));
    insertEvent(makeRichMediaEvent("B/IMG", shop, actorId, "image"));

    expect(claimPendingMedia(10, CLAIM_ALL).map((r) => r.id)).toEqual(["wa:A/IMG"]);
    expect(
      claimPendingMedia(10, { ...CLAIM_ALL, business: true }).map((r) => r.id).sort(),
    ).toEqual(["wa:A/IMG", "wa:B/IMG"]);
  });

  it("returns a same-kind batch the reader can send in one call (v3 §2 batching)", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    for (let i = 0; i < 10; i++) {
      insertEvent(
        makeRichMediaEvent(`A/IMG${i}`, channelId, actorId, "image", {
          ts: `2026-07-02T1${i}:00:00.000Z`,
        }),
      );
    }
    insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video"));

    const batch = claimPendingMedia(8, CLAIM_IMAGES_ONLY);
    expect(batch).toHaveLength(8);
    expect(new Set(batch.map((r) => r.kind))).toEqual(new Set(["image"]));
  });

  it("upsertChannel never un-flags a business chat on a later re-emit", () => {
    const id = upsertChannel({
      sourceId: "whatsapp",
      sourceExtId: "shop@s.whatsapp.net",
      name: "Corner Store",
      kind: "dm",
      isBusiness: true,
    });
    // The daemon only learns "business" from a verified name, which is not on
    // every line — a plain re-emit must not re-enable reading.
    upsertChannel({
      sourceId: "whatsapp",
      sourceExtId: "shop@s.whatsapp.net",
      name: "Corner Store",
      kind: "dm",
    });

    expect(
      getDb().prepare(`SELECT is_business AS b FROM channels WHERE id = ?`).get(id),
    ).toEqual({ b: 1 });
  });
});

// ---------------------------------------------------------------------------
// v4 §4b/§4c — what the claim hands out first. Measured: 33 items took 14 CLI
// calls because a document or video at the head of a `ts DESC` claim turned the
// whole tick into one read. The claim's own order is what stops that.
// ---------------------------------------------------------------------------

describe("claimPendingMedia ordering + kind class (v4 §4c)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("keeps a non-batchable row off the head however new it is", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(
      makeRichMediaEvent("A/IMG1", channelId, actorId, "image", {
        ts: "2026-07-02T10:00:00.000Z",
      }),
    );
    insertEvent(
      makeRichMediaEvent("A/IMG2", channelId, actorId, "image", {
        ts: "2026-07-02T11:00:00.000Z",
      }),
    );
    insertEvent(
      makeRichMediaEvent("A/DOC", channelId, actorId, "document", {
        ts: "2026-07-02T23:00:00.000Z",
        mediaMime: "application/pdf",
        mediaFilename: "invoice.pdf",
      }),
    );

    expect(claimPendingMedia(10, CLAIM_ALL).map((r) => r.id)).toEqual([
      "wa:A/IMG2",
      "wa:A/IMG1",
      "wa:A/DOC",
    ]);
  });

  it("narrows to one kind class so a batch call carries nothing else", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));
    insertEvent(makeRichMediaEvent("A/STK", channelId, actorId, "sticker"));
    insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video"));
    insertEvent(
      makeRichMediaEvent("A/DOC", channelId, actorId, "document", {
        mediaMime: "application/pdf",
        mediaFilename: "invoice.pdf",
      }),
    );

    expect(
      claimPendingMedia(10, CLAIM_ALL, "batchable").map((r) => r.kind).sort(),
    ).toEqual(["image", "sticker"]);
    expect(
      claimPendingMedia(10, CLAIM_ALL, "single").map((r) => r.kind).sort(),
    ).toEqual(["document", "video"]);
    // The class narrows the switches, it does not widen them.
    expect(claimPendingMedia(10, CLAIM_IMAGES_ONLY, "single")).toEqual([]);
  });

  it("lets a live arrival past a backlog of images", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    for (let i = 0; i < 5; i++) {
      insertEvent(
        makeRichMediaEvent(`A/OLD${i}`, channelId, actorId, "image", {
          ts: `2026-07-02T1${i}:00:00.000Z`,
          isHistorical: true,
        }),
      );
    }
    // Older than everything in the backlog, and a kind that cannot batch — it is
    // still the one thing that just arrived.
    insertEvent(
      makeRichMediaEvent("A/LIVE", channelId, actorId, "video", {
        ts: "2020-01-01T00:00:00.000Z",
      }),
    );

    const claim = claimPendingMedia(3, CLAIM_ALL);
    expect(claim[0].id).toBe("wa:A/LIVE");
    expect(claim[0].isHistorical).toBe(false);
    expect(claim.slice(1).every((r) => r.isHistorical)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v3 §2 — re-scan. Settings never re-processes anything on its own, so this is
// the only path back onto the queue for a row that was already read.
// ---------------------------------------------------------------------------

describe("rescanMedia (v3 §2)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("re-queues only the named types and drops their previous verdict", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const img = insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image")).id;
    const vid = insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video")).id;
    recordMediaDescription(img, {
      description: "a whiteboard covered in arrows",
      model: "claude-haiku-4-5-20251001",
      status: "done",
    });
    recordMediaDescription(vid, { status: "error", error: "frame missing" });

    expect(rescanMedia(["image"])).toEqual({ media: 1, links: 0, transcripts: 0, frames: 0 });

    const rows = getDb()
      .prepare(
        `SELECT id, media_desc_status AS s, media_description AS d, media_desc_model AS m,
                media_desc_error AS e, media_desc_ts AS t
           FROM events WHERE media_path IS NOT NULL ORDER BY id`,
      )
      .all() as { id: string; s: string; d: string | null; m: string | null; e: string | null; t: string | null }[];
    expect(rows.find((r) => r.id === img)).toEqual({
      id: img,
      s: "pending",
      d: null,
      m: null,
      e: null,
      t: null,
    });
    // Untouched: the video keeps its recorded failure.
    expect(rows.find((r) => r.id === vid)).toMatchObject({ s: "error", e: "frame missing" });
  });

  it("re-queues an unsupported document once the reader can handle it", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(
      makeRichMediaEvent("A/DOC", channelId, actorId, "document", {
        mediaMime: "application/vnd.ms-excel",
        mediaFilename: "sheet.xls",
      }),
    );
    expect(claimPendingMedia(10, CLAIM_ALL)).toEqual([]);

    expect(rescanMedia(["document"]).media).toBe(1);
    expect(claimPendingMedia(10, CLAIM_ALL).map((r) => r.id)).toEqual([id]);
  });

  it("'business' matches by chat rather than by kind", () => {
    const shop = upsertChannel({
      sourceId: "whatsapp",
      sourceExtId: "shop@s.whatsapp.net",
      name: "Corner Store",
      kind: "dm",
      isBusiness: true,
    });
    const { channelId, actorId } = seedSourceChannelActor();
    const mine = insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image")).id;
    const theirs = insertEvent(makeRichMediaEvent("B/IMG", shop, actorId, "image")).id;
    recordMediaDescription(mine, { status: "done", description: "mine" });
    recordMediaDescription(theirs, { status: "unsupported" });

    expect(rescanMedia(["business"])).toEqual({ media: 1, links: 0, transcripts: 0, frames: 0 });
    expect(
      getDb().prepare(`SELECT media_desc_status AS s FROM events WHERE id = ?`).get(theirs),
    ).toEqual({ s: "pending" });
    expect(
      getDb().prepare(`SELECT media_desc_status AS s FROM events WHERE id = ?`).get(mine),
    ).toEqual({ s: "done" });
  });

  it("never resurrects a revoked row, and reports nothing for an empty list", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));
    applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "A/IMG",
      revokedAt: "2026-07-02T13:00:00.000Z",
    });

    expect(rescanMedia(["image"])).toEqual({ media: 0, links: 0, transcripts: 0, frames: 0 });
    expect(rescanMedia([])).toEqual({ media: 0, links: 0, transcripts: 0, frames: 0 });
    expect(claimPendingMedia(10, CLAIM_ALL)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v3 §3 — links: the preview persists, the scrape has its own lifecycle, and
// everything readable about a link lands in the search index.
// ---------------------------------------------------------------------------

/** A message carrying a full link preview. */
function makeLinkEvent(
  externalId: string,
  channelId: string,
  actorId: string,
  overrides: Partial<Parameters<typeof insertEvent>[0]> = {},
) {
  return {
    ...makeEvent(externalId, channelId, actorId, "look at this https://example.com/ferry"),
    linkUrl: "https://example.com/ferry",
    linkTitle: "Panjim ferry timetable",
    linkDescription: "Sailings every half hour",
    linkThumbPath: "/media/whatsapp/link.thumb.jpg",
    linkPreviewType: "NONE",
    ...overrides,
  };
}

describe("link previews + scraping (v3 §3)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("persists the preview and hands it back on the message read path", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeLinkEvent("A/1", channelId, actorId));

    expect(getChannelMessages({ channelId, limit: 10 })[0].link).toEqual({
      url: "https://example.com/ferry",
      title: "Panjim ferry timetable",
      description: "Sailings every half hour",
      thumbPath: "/media/whatsapp/link.thumb.jpg",
      previewType: "NONE",
      scrapedText: null,
    });
    // The preview thumbnail is the only file a link event has, so the media
    // route needs it off the by-id read too.
    expect(getEventById("wa:A/1")!.linkThumbPath).toBe("/media/whatsapp/link.thumb.jpg");
  });

  it("a message with no URL has no link block", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeEvent("A/1", channelId, actorId, "no links here"));
    expect(getChannelMessages({ channelId, limit: 10 })[0].link).toBeNull();
  });

  it("queues http(s) and writes off a scheme that can never be fetched", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeLinkEvent("A/1", channelId, actorId));
    insertEvent(
      makeLinkEvent("A/2", channelId, actorId, { linkUrl: "mailto:hello@example.com" }),
    );

    expect(claimPendingLinks(10, { business: false })).toEqual([
      { id: "wa:A/1", url: "https://example.com/ferry", title: "Panjim ferry timetable" },
    ]);
    expect(
      getDb().prepare(`SELECT link_scrape_status AS s FROM events WHERE id = 'wa:A/2'`).get(),
    ).toEqual({ s: "unsupported" });
  });

  it("keeps links in business chats back unless the filter includes them", () => {
    const shop = upsertChannel({
      sourceId: "whatsapp",
      sourceExtId: "shop@s.whatsapp.net",
      name: "Corner Store",
      kind: "dm",
      isBusiness: true,
    });
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeLinkEvent("A/1", channelId, actorId));
    insertEvent(makeLinkEvent("B/1", shop, actorId));

    expect(claimPendingLinks(10, { business: false }).map((r) => r.id)).toEqual(["wa:A/1"]);
    expect(claimPendingLinks(10, { business: true }).map((r) => r.id).sort()).toEqual([
      "wa:A/1",
      "wa:B/1",
    ]);
  });

  it("recordLinkScrape clears the queue and makes the page text searchable", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeLinkEvent("A/1", channelId, actorId));

    recordLinkScrape(id, {
      scrapedText: "the last sailing leaves from the northern gangplank",
      title: "example.com",
      status: "done",
    });

    expect(claimPendingLinks(10, { business: false })).toEqual([]);
    expect(searchEvents({ q: "gangplank" }).map((h) => h.eventId)).toEqual([id]);
    expect(searchEvents({ q: "timetable" }).map((h) => h.eventId)).toEqual([id]);
    // WhatsApp's own title is what the sender saw; the page's never overwrites it.
    expect(getChannelMessages({ channelId, limit: 10 })[0].link!.title).toBe(
      "Panjim ferry timetable",
    );
  });

  it("fills a missing title from the page and records a failure as 'error'", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const bare = insertEvent(
      makeLinkEvent("A/1", channelId, actorId, {
        linkTitle: null,
        linkDescription: null,
        linkThumbPath: null,
        linkPreviewType: null,
      }),
    ).id;
    const dead = insertEvent(
      makeLinkEvent("A/2", channelId, actorId, { linkUrl: "https://example.com/gone" }),
    ).id;

    recordLinkScrape(bare, { scrapedText: "ferries run hourly", title: "Ferries", status: "done" });
    recordLinkScrape(dead, { status: "error", error: "404" });

    expect(getChannelMessages({ channelId, limit: 10 })[0].link!.title).toBe("Ferries");
    expect(
      getDb()
        .prepare(`SELECT link_scrape_status AS s, link_scrape_error AS e FROM events WHERE id = ?`)
        .get(dead),
    ).toEqual({ s: "error", e: "404" });
    expect(claimPendingLinks(10, { business: false })).toEqual([]);
  });

  it("rescan 'link' re-queues scraped rows and drops the stale page text", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeLinkEvent("A/1", channelId, actorId));
    recordLinkScrape(id, { scrapedText: "gangplank", status: "done" });

    expect(rescanMedia(["link"])).toEqual({ media: 0, links: 1, transcripts: 0, frames: 0 });
    expect(claimPendingLinks(10, { business: false }).map((r) => r.id)).toEqual([id]);
    expect(searchEvents({ q: "gangplank" })).toEqual([]);
  });

  it("revoking a message takes its link out of the queue and out of search", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeLinkEvent("A/1", channelId, actorId));
    recordLinkScrape(id, { scrapedText: "gangplank", status: "done" });

    applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "A/1",
      revokedAt: "2026-07-02T13:00:00.000Z",
    });

    expect(claimPendingLinks(10, { business: false })).toEqual([]);
    expect(searchEvents({ q: "gangplank" })).toEqual([]);
    expect(getChannelMessages({ channelId, limit: 10 })[0].link).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// v5 §2 — video frames. The column is the only record those files exist, so
// what matters is that it survives a round trip and that clearing it (revoke,
// re-scan) is what takes the paths out of listMediaFramePaths().
// ---------------------------------------------------------------------------

const FRAMES = [
  { path: "/media/whatsapp/A/VID.frame0.jpg", seconds: 0 },
  { path: "/media/whatsapp/A/VID.frame1.jpg", seconds: 5 },
];

describe("sampled video frames (v5 §2)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("round-trips through both read paths and shows up as referenced files", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video"));

    recordMediaFrames(id, FRAMES);

    expect(getEventById(id)!.mediaFrames).toEqual(FRAMES);
    expect(getChannelMessages({ channelId, limit: 10 })[0].mediaFrames).toEqual(FRAMES);
    expect(listMediaFramePaths()).toEqual(FRAMES.map((f) => f.path));
  });

  it("stores nothing at all for an empty sample, and reads junk back as null", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video"));

    recordMediaFrames(id, []);
    expect(
      getDb().prepare(`SELECT media_frames_json AS j FROM events WHERE id = ?`).get(id),
    ).toEqual({ j: null });
    expect(getEventById(id)!.mediaFrames).toBeNull();

    getDb().prepare(`UPDATE events SET media_frames_json = '{not json' WHERE id = ?`).run(id);
    expect(getEventById(id)!.mediaFrames).toBeNull();
    expect(listMediaFramePaths()).toEqual([]);
  });

  it("drops entries with no usable path rather than passing them on", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video"));

    getDb()
      .prepare(`UPDATE events SET media_frames_json = ? WHERE id = ?`)
      .run(
        JSON.stringify([{ seconds: 0 }, { path: "", seconds: 1 }, { path: "/f2.jpg" }]),
        id,
      );

    // The surviving entry keeps a usable offset even though it arrived without one.
    expect(getEventById(id)!.mediaFrames).toEqual([{ path: "/f2.jpg", seconds: 0 }]);
  });

  it("revoking the video unreferences its frames so the sweep can delete them", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video"));
    recordMediaFrames(id, FRAMES);

    applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "A/VID",
      revokedAt: "2026-07-02T13:00:00.000Z",
    });

    expect(listMediaFramePaths()).toEqual([]);
    expect(getEventById(id)!.mediaFrames).toBeNull();
  });

  it("rescan 'frames' drops them and re-reads the video; 'video' alone keeps them", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video"));
    recordMediaFrames(id, FRAMES);
    recordMediaDescription(id, { description: "a car pulling away", status: "done" });

    // A re-read of the same clip yields the same stills, so 'video' leaves them.
    expect(rescanMedia(["video"])).toEqual({ media: 1, links: 0, transcripts: 0, frames: 0 });
    expect(listMediaFramePaths()).toEqual(FRAMES.map((f) => f.path));

    expect(rescanMedia(["frames"])).toEqual({ media: 0, links: 0, transcripts: 0, frames: 1 });
    expect(listMediaFramePaths()).toEqual([]);
    // The description went with them — it was a reading of those frames.
    expect(getEventById(id)!.mediaDescription).toBeNull();
    expect(claimPendingMedia(10, CLAIM_ALL).map((r) => r.id)).toEqual([id]);
  });
});

// ---------------------------------------------------------------------------
// v7 §3 — videos with no poster. WhatsApp only ever supplies a thumbnail from
// the protobuf, and 10 of the 18 videos measured carry none; the frame has to
// come out of the mp4 that is already on disk.
// ---------------------------------------------------------------------------

describe("claimPendingPosters / recordVideoPoster (v7 §3)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  /** A video the daemon stored without a JPEGThumbnail beside it. */
  function makeThumblessVideo(
    externalId: string,
    channelId: string,
    actorId: string,
    overrides: Partial<Parameters<typeof insertEvent>[0]> = {},
  ) {
    return makeRichMediaEvent(externalId, channelId, actorId, "video", {
      mediaMime: "video/mp4",
      mediaThumbPath: null,
      mediaSeconds: 162,
      ...overrides,
    });
  }

  it("claims the videos with no thumbnail and skips the ones that have one", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeThumblessVideo("A/VID", channelId, actorId));
    // Has WhatsApp's own thumbnail; nothing to generate.
    insertEvent(makeRichMediaEvent("A/VID2", channelId, actorId, "video"));
    // Not a video, and a video with no file at all.
    insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));
    insertEvent(
      makeThumblessVideo("A/NOFILE", channelId, actorId, { mediaPath: null }),
    );

    expect(claimPendingPosters(10)).toEqual([
      { id, mediaPath: "/media/whatsapp/A/VID.bin", seconds: 162, isHistorical: false },
    ]);
  });

  it("hands live arrivals over before the history backlog, newest first", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(
      makeThumblessVideo("A/OLD", channelId, actorId, {
        ts: "2026-07-01T12:00:00.000Z",
        isHistorical: true,
      }),
    );
    insertEvent(
      makeThumblessVideo("A/NEWER", channelId, actorId, {
        ts: "2026-07-02T12:00:00.000Z",
        isHistorical: true,
      }),
    );
    insertEvent(
      makeThumblessVideo("A/LIVE", channelId, actorId, {
        ts: "2026-06-01T12:00:00.000Z",
      }),
    );

    expect(claimPendingPosters(10).map((r) => r.id)).toEqual([
      "wa:A/LIVE",
      "wa:A/NEWER",
      "wa:A/OLD",
    ]);
  });

  it("never claims a revoked row — there is no file left to sample", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeThumblessVideo("A/VID", channelId, actorId));
    applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "A/VID",
      revokedAt: "2026-07-02T13:00:00.000Z",
    });

    expect(claimPendingPosters(10)).toEqual([]);
  });

  it("takes the row out of the queue when the poster is recorded", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeThumblessVideo("A/VID", channelId, actorId));

    expect(recordVideoPoster(id, "/media/whatsapp/A/VID.poster.jpg")).toBe(true);
    expect(claimPendingPosters(10)).toEqual([]);
    expect(getEventById(id)!.mediaThumbPath).toBe("/media/whatsapp/A/VID.poster.jpg");
  });

  it("refuses to overwrite a thumbnail that arrived meanwhile", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video"));

    // The sender's own frame is what they chose to show; ours is a guess at it.
    expect(recordVideoPoster(id, "/media/whatsapp/A/VID.poster.jpg")).toBe(false);
    expect(getEventById(id)!.mediaThumbPath).toBe("/media/whatsapp/A/VID.thumb.jpg");
  });

  it("holds the reader off until there is a still, then lets it through", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeThumblessVideo("A/VID", channelId, actorId));

    // Pending rather than unsupported — the lockout this replaces was
    // permanent, because the claim only ever matches 'pending'.
    expect(
      getDb().prepare(`SELECT media_desc_status AS s FROM events WHERE id = ?`).get(id),
    ).toEqual({ s: "pending" });
    // But there is nothing to look at yet, and the reader answers a video with
    // no still by writing it off again.
    expect(claimPendingMedia(10, CLAIM_ALL)).toEqual([]);

    recordVideoPoster(id, "/media/whatsapp/A/VID.poster.jpg");
    expect(claimPendingMedia(10, CLAIM_ALL).map((r) => r.id)).toEqual([id]);
  });

  it("lets sampled frames stand in for the poster", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeThumblessVideo("A/VID", channelId, actorId));

    recordMediaFrames(id, [{ path: "/media/whatsapp/A/VID.frame0.jpg", seconds: 0 }]);
    expect(claimPendingMedia(10, CLAIM_ALL).map((r) => r.id)).toEqual([id]);
  });
});

// ---------------------------------------------------------------------------
// v5 §3 — transcription. Same lifecycle as media reading, its own two switches.
// ---------------------------------------------------------------------------

/** Both audio switches on, business chats left out — the usual claim. */
const TRANSCRIBE_ALL: TranscriptClaimFilter = {
  voiceNotes: true,
  videoAudio: true,
  business: false,
};

/** A voice note: audio with a duration and the PTT flag the daemon sets. */
function makeVoiceNote(
  externalId: string,
  channelId: string,
  actorId: string,
  overrides: Partial<Parameters<typeof insertEvent>[0]> = {},
) {
  return makeRichMediaEvent(externalId, channelId, actorId, "audio", {
    mediaMime: "audio/ogg; codecs=opus",
    mediaFilename: "ptt.ogg",
    mediaSeconds: 14,
    mediaThumbPath: null,
    mediaMetaJson: JSON.stringify({ voice: true }),
    ...overrides,
  });
}

describe("transcript status seeding (v5 §3)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("marks what might carry speech pending and everything else unsupported", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeVoiceNote("A/PTT", channelId, actorId));
    insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video"));
    insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));
    insertEvent(makeRichMediaEvent("A/DOC", channelId, actorId, "document"));
    insertEvent(makeEvent("A/TXT", channelId, actorId, "no attachment here"));

    const rows = getDb()
      .prepare(`SELECT external_id AS x, transcript_status AS s FROM events ORDER BY external_id`)
      .all() as { x: string; s: string | null }[];
    expect(Object.fromEntries(rows.map((r) => [r.x, r.s]))).toEqual({
      "A/PTT": "pending",
      "A/VID": "pending",
      "A/IMG": "unsupported",
      "A/DOC": "unsupported",
      "A/TXT": null,
    });
  });
});

describe("claimPendingTranscription / recordTranscript (v5 §3)", () => {
  beforeEach(() => upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" }));

  it("hands back live rows first with the fields whisper needs", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(
      makeVoiceNote("A/OLD", channelId, actorId, {
        ts: "2026-07-02T13:00:00.000Z",
        isHistorical: true,
      }),
    );
    insertEvent(makeVoiceNote("A/PTT", channelId, actorId, { ts: "2026-07-02T10:00:00.000Z" }));

    const pending = claimPendingTranscription(10, TRANSCRIBE_ALL);
    // The history row is newer, but only a live arrival may jump the backlog.
    expect(pending.map((r) => r.id)).toEqual(["wa:A/PTT", "wa:A/OLD"]);
    expect(pending[0]).toEqual({
      id: "wa:A/PTT",
      kind: "audio",
      mediaPath: "/media/whatsapp/A/PTT.bin",
      mime: "audio/ogg; codecs=opus",
      filename: "ptt.ogg",
      seconds: 14,
      voice: true,
      isHistorical: false,
    });
  });

  it("gates voice notes and video audio on their own switches", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeVoiceNote("A/PTT", channelId, actorId));
    insertEvent(makeRichMediaEvent("A/VID", channelId, actorId, "video"));

    expect(claimPendingTranscription(10, TRANSCRIBE_ALL).map((r) => r.id)).toEqual([
      "wa:A/PTT",
      "wa:A/VID",
    ]);
    expect(
      claimPendingTranscription(10, { ...TRANSCRIBE_ALL, videoAudio: false }).map((r) => r.id),
    ).toEqual(["wa:A/PTT"]);
    expect(
      claimPendingTranscription(10, { ...TRANSCRIBE_ALL, voiceNotes: false }).map((r) => r.id),
    ).toEqual(["wa:A/VID"]);
    expect(
      claimPendingTranscription(10, {
        voiceNotes: false,
        videoAudio: false,
        business: false,
      }),
    ).toEqual([]);
  });

  it("holds back business chats until that switch is on too", () => {
    const shop = upsertChannel({
      sourceId: "whatsapp",
      sourceExtId: "shop@s.whatsapp.net",
      name: "Corner Store",
      kind: "dm",
      isBusiness: true,
    });
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeVoiceNote("A/PTT", channelId, actorId));
    insertEvent(makeVoiceNote("B/PTT", shop, actorId));

    expect(claimPendingTranscription(10, TRANSCRIBE_ALL).map((r) => r.id)).toEqual(["wa:A/PTT"]);
    expect(
      claimPendingTranscription(10, { ...TRANSCRIBE_ALL, business: true })
        .map((r) => r.id)
        .sort(),
    ).toEqual(["wa:A/PTT", "wa:B/PTT"]);
  });

  it("never hands out a revoked row, and drains it from the queue", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeVoiceNote("A/PTT", channelId, actorId));
    expect(claimPendingTranscription(10, TRANSCRIBE_ALL)).toHaveLength(1);

    applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "A/PTT",
      revokedAt: "2026-07-02T13:00:00.000Z",
    });

    expect(claimPendingTranscription(10, TRANSCRIBE_ALL)).toEqual([]);
    expect(
      getDb().prepare(`SELECT transcript_status AS s FROM events WHERE id = 'wa:A/PTT'`).get(),
    ).toEqual({ s: null });
  });

  it("recordTranscript clears the row from the queue and makes it searchable", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeVoiceNote("A/PTT", channelId, actorId));

    recordTranscript(id, {
      transcript: "kal subah nikalte hain, ferry pakadni hai",
      model: "ggml-large-v3-turbo-q5_0",
      status: "done",
    });

    expect(claimPendingTranscription(10, TRANSCRIBE_ALL)).toEqual([]);
    expect(searchEvents({ q: "ferry" }).map((h) => h.eventId)).toEqual([id]);
    expect(getChannelMessages({ channelId, limit: 10 })[0].transcript).toBe(
      "kal subah nikalte hain, ferry pakadni hai",
    );
    expect(getEventById(id)!.transcript).toBe("kal subah nikalte hain, ferry pakadni hai");
    expect(
      getDb()
        .prepare(`SELECT transcript_model AS m, transcript_ts AS t FROM events WHERE id = ?`)
        .get(id),
    ).toMatchObject({ m: "ggml-large-v3-turbo-q5_0" });
  });

  it("records silence as unsupported rather than storing an invented sentence", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeVoiceNote("A/PTT", channelId, actorId));

    recordTranscript(id, { status: "unsupported", error: "degenerate output on silence" });

    expect(claimPendingTranscription(10, TRANSCRIBE_ALL)).toEqual([]);
    expect(
      getDb()
        .prepare(
          `SELECT transcript AS x, transcript_status AS s, transcript_error AS e FROM events WHERE id = ?`,
        )
        .get(id),
    ).toEqual({ x: null, s: "unsupported", e: "degenerate output on silence" });
  });

  it("keeps a partial transcript readable without passing it off as complete", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeVoiceNote("A/PTT", channelId, actorId));

    recordTranscript(id, {
      transcript: "kal subah nikalte hain",
      model: "ggml-large-v3-turbo-q5_0",
      status: "error",
      error: "partial: 2 of 5 chunks",
    });

    // Off the queue, searchable, and flagged — 'done' would be the lie.
    expect(claimPendingTranscription(10, TRANSCRIBE_ALL)).toEqual([]);
    expect(searchEvents({ q: "nikalte" }).map((h) => h.eventId)).toEqual([id]);
    expect(
      getDb().prepare(`SELECT transcript_error AS e FROM events WHERE id = ?`).get(id),
    ).toEqual({ e: "partial: 2 of 5 chunks" });
  });

  it("rescan 'transcript' re-queues transcribed rows and drops the stale text", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    const { id } = insertEvent(makeVoiceNote("A/PTT", channelId, actorId));
    insertEvent(makeRichMediaEvent("A/IMG", channelId, actorId, "image"));
    recordTranscript(id, {
      transcript: "ferry pakadni hai",
      model: "ggml-large-v3-turbo-q5_0",
      status: "done",
    });

    expect(rescanMedia(["transcript"])).toEqual({
      media: 0,
      links: 0,
      transcripts: 1,
      frames: 0,
    });
    expect(claimPendingTranscription(10, TRANSCRIBE_ALL).map((r) => r.id)).toEqual([id]);
    expect(searchEvents({ q: "ferry" })).toEqual([]);
    expect(
      getDb()
        .prepare(
          `SELECT transcript AS x, transcript_model AS m, transcript_ts AS t FROM events WHERE id = ?`,
        )
        .get(id),
    ).toEqual({ x: null, m: null, t: null });
  });

  it("rescan 'transcript' never resurrects a revoked row", () => {
    const { channelId, actorId } = seedSourceChannelActor();
    insertEvent(makeVoiceNote("A/PTT", channelId, actorId));
    applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "A/PTT",
      revokedAt: "2026-07-02T13:00:00.000Z",
    });

    expect(rescanMedia(["transcript"]).transcripts).toBe(0);
    expect(claimPendingTranscription(10, TRANSCRIBE_ALL)).toEqual([]);
  });
});
