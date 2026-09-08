// Additive provider-continuation migration. SQLite only; zero network/model calls.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { runMigrationsOn } from "../connection.js";
import { MIGRATIONS } from "../schema.js";
import { CHAT_PROVIDER_CONTINUATIONS } from "./0214_chat_provider_continuations.js";

const PUBLIC_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_UUID = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const HASH = "c".repeat(64);

function openLegacy(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE chat_sessions (
      session_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      prompt_bundle_hash TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT 'legacy-created',
      updated_at TEXT NOT NULL DEFAULT 'legacy-updated'
    );
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);
  return db;
}

function expectUuid(value: unknown): void {
  expect(value).toEqual(expect.stringMatching(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ));
}

function insertSession(
  db: Database.Database,
  sessionId: string,
  conversationId: string | null,
): void {
  db.prepare(`
    INSERT INTO chat_sessions
      (session_id, provider, cwd, prompt_bundle_hash, conversation_id)
    VALUES (?, 'claude-local', '/safe', 'legacy-hash', ?)
  `).run(sessionId, conversationId);
}

describe("0214_chat_provider_continuations", () => {
  it("is registered directly after the browser-PKCE decision", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids.indexOf("0214_chat_provider_continuations")).toBe(
      ids.indexOf("0213_chatgpt_browser_pkce_decision") + 1,
    );
  });

  it("backfills random UUIDv4 public ids and preserves legacy rows and foreign keys", () => {
    const db = openLegacy();
    db.prepare(`
      INSERT INTO chat_sessions
        (session_id, provider, cwd, prompt_bundle_hash, title)
      VALUES (?, 'claude-local', '/one', 'old-one', 'first')
    `).run("legacy-a");
    db.prepare(`
      INSERT INTO chat_sessions
        (session_id, provider, cwd, prompt_bundle_hash, title)
      VALUES ('legacy-z', 'claude-local', '/two', 'old-two', 'second')
    `).run();
    db.prepare(`
      INSERT INTO chat_messages (session_id, role, content)
      VALUES (?, 'user', 'preserve me')
    `).run("legacy-a");

    db.exec(CHAT_PROVIDER_CONTINUATIONS);

    const rows = db.prepare(`
      SELECT session_id, conversation_id, provider_continuation,
             continuation_provider, continuation_model,
             continuation_prompt_bundle_hash, continuation_generation,
             cwd, prompt_bundle_hash, title
        FROM chat_sessions ORDER BY session_id
    `).all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => ({ ...row, conversation_id: undefined }))).toEqual([
      {
        session_id: "legacy-a",
        conversation_id: undefined,
        provider_continuation: null,
        continuation_provider: null,
        continuation_model: null,
        continuation_prompt_bundle_hash: null,
        continuation_generation: 0,
        cwd: "/one",
        prompt_bundle_hash: "old-one",
        title: "first",
      },
      {
        session_id: "legacy-z",
        conversation_id: undefined,
        provider_continuation: null,
        continuation_provider: null,
        continuation_model: null,
        continuation_prompt_bundle_hash: null,
        continuation_generation: 0,
        cwd: "/two",
        prompt_bundle_hash: "old-two",
        title: "second",
      },
    ]);
    for (const row of rows) {
      expectUuid(row.conversation_id);
      expect(row.conversation_id).not.toBe(row.session_id);
    }
    expect(rows[0].conversation_id).not.toBe(rows[1].conversation_id);

    const otherInstall = openLegacy();
    for (const sessionId of ["legacy-a", "legacy-z"]) {
      otherInstall.prepare(`
        INSERT INTO chat_sessions
          (session_id, provider, cwd, prompt_bundle_hash)
        VALUES (?, 'claude-local', '/other', 'old-hash')
      `).run(sessionId);
    }
    otherInstall.exec(CHAT_PROVIDER_CONTINUATIONS);
    const otherIds = otherInstall.prepare(`
      SELECT conversation_id FROM chat_sessions ORDER BY session_id
    `).pluck().all();
    expect(otherIds).not.toEqual(rows.map((row) => row.conversation_id));
    otherInstall.close();

    expect(db.prepare(`SELECT content FROM chat_messages`).get()).toEqual({
      content: "preserve me",
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    db.close();
  });

  it("keeps legacy inserts working while generating an independent public UUID", () => {
    const db = openLegacy();
    db.exec(CHAT_PROVIDER_CONTINUATIONS);

    insertSession(db, "legacy-provider-token", null);
    const row = db.prepare(`
      SELECT session_id, conversation_id FROM chat_sessions
    `).get() as { session_id: string; conversation_id: string };
    expectUuid(row.conversation_id);
    expect(row.conversation_id).not.toBe(row.session_id);
    db.close();
  });

  it("enforces public identity, complete bindings, bounds, generation, and continuation ownership", () => {
    const db = openLegacy();
    db.exec(CHAT_PROVIDER_CONTINUATIONS);

    insertSession(db, "internal-a", PUBLIC_UUID);
    expect(() => insertSession(db, PUBLIC_UUID, PUBLIC_UUID)).toThrow(/distinct/);
    expect(() => insertSession(db, "internal-b", "not-a-uuid")).toThrow(/CHECK/);
    expect(() => insertSession(db, "internal-b", PUBLIC_UUID)).toThrow(/UNIQUE/);
    expect(() => db.prepare(`
      UPDATE chat_sessions SET conversation_id = NULL WHERE session_id = 'internal-a'
    `).run()).toThrow(/non-null/);
    expect(() => db.prepare(`
      UPDATE chat_sessions SET conversation_id = ? WHERE session_id = 'internal-a'
    `).run(OTHER_UUID)).toThrow(/immutable/);

    expect(() => db.prepare(`
      UPDATE chat_sessions
         SET continuation_provider = 'claude-local', continuation_generation = 1
       WHERE session_id = 'internal-a'
    `).run()).toThrow(/complete binding/);
    expect(() => db.prepare(`
      UPDATE chat_sessions
         SET continuation_provider = 'Claude Local',
             continuation_model = 'claude-sonnet',
             continuation_prompt_bundle_hash = ?,
             continuation_generation = 1
       WHERE session_id = 'internal-a'
    `).run(HASH)).toThrow(/CHECK/);
    expect(() => db.prepare(`
      UPDATE chat_sessions
         SET continuation_provider = 'claude-local',
             continuation_model = 'claude\\nsonnet',
             continuation_prompt_bundle_hash = ?,
             continuation_generation = 1
       WHERE session_id = 'internal-a'
    `).run(HASH)).toThrow(/CHECK/);
    expect(() => db.prepare(`
      UPDATE chat_sessions
         SET continuation_provider = 'claude-local',
             continuation_model = 'claude-sonnet',
             continuation_prompt_bundle_hash = upper(?),
             continuation_generation = 1
       WHERE session_id = 'internal-a'
    `).run(HASH)).toThrow(/CHECK/);

    // A complete binding with no continuation is the reconstruction state.
    db.prepare(`
      UPDATE chat_sessions
         SET continuation_provider = 'claude-local',
             continuation_model = 'claude-sonnet',
             continuation_prompt_bundle_hash = ?,
             continuation_generation = 1
       WHERE session_id = 'internal-a'
    `).run(HASH);
    expect(() => db.prepare(`
      UPDATE chat_sessions SET provider_continuation = 'opaque-token'
       WHERE session_id = 'internal-a'
    `).run()).toThrow(/token change/);
    expect(() => db.prepare(`
      UPDATE chat_sessions SET continuation_generation = -1
       WHERE session_id = 'internal-a'
    `).run()).toThrow(/cannot decrease|CHECK/);
    expect(() => db.prepare(`
      UPDATE chat_sessions SET continuation_generation = 1.5
       WHERE session_id = 'internal-a'
    `).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`
      UPDATE chat_sessions
         SET provider_continuation = ?, continuation_generation = 2
       WHERE session_id = 'internal-a'
    `).run("x".repeat(4097))).toThrow(/CHECK/);

    db.prepare(`
      UPDATE chat_sessions
         SET provider_continuation = 'opaque-token', continuation_generation = 2
       WHERE session_id = 'internal-a'
    `).run();
    expect(() => db.prepare(`
      UPDATE chat_sessions
         SET continuation_model = 'claude-opus',
             provider_continuation = NULL,
             continuation_generation = 3
       WHERE session_id = 'internal-a'
    `).run()).toThrow(/rebind requires a null token/);
    expect(() => db.prepare(`
      UPDATE chat_sessions SET continuation_generation = 0
       WHERE session_id = 'internal-a'
    `).run()).toThrow(/cannot decrease/);
    expect(() => db.prepare(`
      UPDATE chat_sessions SET provider_continuation = 'replacement-token'
       WHERE session_id = 'internal-a'
    `).run()).toThrow(/token change/);
    expect(() => db.prepare(`
      UPDATE chat_sessions
         SET provider_continuation = 'stale-token', continuation_generation = 1
       WHERE session_id = 'internal-a'
    `).run()).toThrow(/token change|cannot decrease/);
    expect(() => db.prepare(`
      UPDATE chat_sessions SET provider_continuation = NULL
       WHERE session_id = 'internal-a'
    `).run()).toThrow(/token change/);

    // Invalidation advances the token version but retains the old binding.
    db.prepare(`
      UPDATE chat_sessions
         SET provider_continuation = NULL, continuation_generation = 3
       WHERE session_id = 'internal-a'
    `).run();
    expect(() => db.prepare(`
      UPDATE chat_sessions SET continuation_model = 'claude-opus'
       WHERE session_id = 'internal-a'
    `).run()).toThrow(/generation advance/);
    db.prepare(`
      UPDATE chat_sessions
         SET continuation_model = 'claude-opus', continuation_generation = 4
       WHERE session_id = 'internal-a'
    `).run();
    expect(() => db.prepare(`
      UPDATE chat_sessions SET provider_continuation = 'replacement-token'
       WHERE session_id = 'internal-a'
    `).run()).toThrow(/token change/);
    db.prepare(`
      UPDATE chat_sessions
         SET provider_continuation = 'replacement-token',
             continuation_generation = 5
       WHERE session_id = 'internal-a'
    `).run();

    insertSession(db, "internal-c", OTHER_UUID);
    db.prepare(`
      UPDATE chat_sessions
         SET continuation_provider = 'claude-local',
             continuation_model = 'claude-opus',
             continuation_prompt_bundle_hash = ?,
             continuation_generation = 1
       WHERE session_id = 'internal-c'
    `).run(HASH);
    expect(() => db.prepare(`
      UPDATE chat_sessions
         SET provider_continuation = 'replacement-token',
             continuation_generation = 2
       WHERE session_id = 'internal-c'
    `).run()).toThrow(/UNIQUE/);

    // Tokens are opaque inside a provider namespace, not globally conflated.
    db.prepare(`
      UPDATE chat_sessions
         SET continuation_provider = 'chatgpt-oauth',
             continuation_model = 'gpt-5.6-sol',
             continuation_prompt_bundle_hash = ?,
             continuation_generation = 2
       WHERE session_id = 'internal-c'
    `).run(HASH);
    db.prepare(`
      UPDATE chat_sessions
         SET provider_continuation = 'replacement-token',
             continuation_generation = 3
       WHERE session_id = 'internal-c'
    `).run();

    // Intentional invalidation keeps the rebound tuple and advances CAS state.
    db.prepare(`
      UPDATE chat_sessions SET provider_continuation = NULL,
                               continuation_generation = 6
       WHERE session_id = 'internal-a'
    `).run();
    expect(db.prepare(`
      SELECT provider_continuation, continuation_provider,
             continuation_model, continuation_prompt_bundle_hash,
             continuation_generation
        FROM chat_sessions WHERE session_id = 'internal-a'
    `).get()).toEqual({
      provider_continuation: null,
      continuation_provider: "claude-local",
      continuation_model: "claude-opus",
      continuation_prompt_bundle_hash: HASH,
      continuation_generation: 6,
    });
    db.close();
  });

  it("replays safely after an interrupted migration without changing the backfill", () => {
    const db = openLegacy();
    db.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT 'seeded'
      )
    `);
    const record = db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`);
    for (const migration of MIGRATIONS) {
      if (migration.id !== "0214_chat_provider_continuations") {
        record.run(migration.id);
      }
    }
    db.prepare(`
      INSERT INTO chat_sessions
        (session_id, provider, cwd, prompt_bundle_hash)
      VALUES ('legacy-replay', 'claude-local', '/safe', 'old-hash')
    `).run();

    runMigrationsOn(db);
    const first = db.prepare(`
      SELECT conversation_id FROM chat_sessions WHERE session_id = 'legacy-replay'
    `).get();
    db.prepare(`
      DELETE FROM schema_migrations WHERE id = '0214_chat_provider_continuations'
    `).run();
    runMigrationsOn(db);

    expect(db.prepare(`
      SELECT conversation_id FROM chat_sessions WHERE session_id = 'legacy-replay'
    `).get()).toEqual(first);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations
       WHERE id = '0214_chat_provider_continuations'
    `).get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'trigger' AND name LIKE 'chat_sessions_%_guard'
    `).get()).toEqual({ count: 4 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'trigger' AND name LIKE 'chat_sessions_continuation_%'
    `).get()).toEqual({ count: 5 });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    db.close();
  });
});
