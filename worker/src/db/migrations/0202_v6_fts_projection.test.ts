// ===========================================================================
// 0202_v6_fts_projection tests (vitest) — V6 P1 S2.3 (Build §5.2 lane A).
//
//   1. migrate up on an EMPTY db; re-running is a no-op; 0202 follows 0201;
//      `events` gained app / window_title / doc_key; events_fts has exactly
//      the ten columns db/retrieval.ts EVENTS_FTS_COLUMNS lists, in order
//      (ordinals are bm25 weights and snippet indexes); chunks_fts exists.
//   2. the single writer projects the payload: a screen snapshot fills all
//      three columns, a browser visit projects its tab title + URL, a chat
//      message projects NULL (never "").
//   3. chunks_fts follows chunks through insert, text update and delete.
//
// Zero model calls: pure SQLite on a temp file.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toScreenEnvelope } from "../../adapters/screen/envelope.js";
import { villaFrame } from "../../retrieval/__fixtures__/screen-frames.js";
import { closeDb, getDb, runMigrations } from "../connection.js";
import { appendEvent, ftsProjection } from "../eventlog.js";
import { EVENTS_FTS_COLUMNS } from "../retrieval.js";
import { MIGRATIONS } from "../schema.js";
import { deleteChunks, upsertChunk } from "../v6graph.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-0202-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function applied(db: Database.Database): string[] {
  return (db.prepare(`SELECT id FROM schema_migrations ORDER BY rowid`).all() as { id: string }[]).map((r) => r.id);
}

describe("0202_v6_fts_projection — schema", () => {
  it("applies once, after 0201, and re-running is a no-op", () => {
    const db = getDb();
    const ids = applied(db);
    // Directly after 0201; later V6 migrations (0203_v6_space_card, S3.7) follow it.
    expect(ids).toContain("0202_v6_fts_projection");
    expect(ids.indexOf("0202_v6_fts_projection")).toBe(ids.indexOf("0201_v6_graph") + 1);
    expect(MIGRATIONS.map((m) => m.id).indexOf("0202_v6_fts_projection")).toBe(
      MIGRATIONS.map((m) => m.id).indexOf("0201_v6_graph") + 1,
    );
    runMigrations();
    expect(applied(getDb()).filter((id) => id === "0202_v6_fts_projection")).toHaveLength(1);
  });

  it("events gained app / window_title / doc_key", () => {
    const cols = columns(getDb(), "events");
    expect(cols).toEqual(expect.arrayContaining(["app", "window_title", "doc_key"]));
  });

  it("events_fts has exactly the ten columns EVENTS_FTS_COLUMNS lists, in order", () => {
    const cols = columns(getDb(), "events_fts");
    expect(cols).toEqual([...EVENTS_FTS_COLUMNS]);
    expect(cols.slice(0, 7)).toEqual([
      "text",
      "media_description",
      "link_title",
      "link_description",
      "link_scraped_text",
      "transcript",
      "reply_to_text",
    ]);
    expect(cols.slice(7)).toEqual(["app", "window_title", "doc_key"]);
  });

  it("chunks_fts exists over chunks.text with its three triggers", () => {
    const db = getDb();
    expect(columns(db, "chunks_fts")).toEqual(["text"]);
    const triggers = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'chunks'`).all() as { name: string }[]
    ).map((t) => t.name);
    expect(triggers.sort()).toEqual(["chunks_ad", "chunks_ai", "chunks_au"]);
  });
});

describe("0202_v6_fts_projection — the single writer projects the payload", () => {
  it("a screen snapshot fills app, window_title and doc_key", () => {
    const { id } = appendEvent(toScreenEnvelope(villaFrame()));
    const row = getDb()
      .prepare(`SELECT app, window_title, doc_key, text FROM events WHERE id = ?`)
      .get(id) as { app: string; window_title: string; doc_key: string; text: string };
    expect(row).toEqual({
      app: "Safari",
      window_title: "Villas in Goa – Airbnb",
      doc_key: "airbnb.com/s/Goa/homes",
      text: "6 beds · swimming pool · ₹18,000 / night",
    });
    // And the projection is in the index: the title is searchable, the diff was already.
    const hit = getDb()
      .prepare(`SELECT rowid FROM events_fts WHERE events_fts MATCH 'window_title : villas'`)
      .all();
    expect(hit).toHaveLength(1);
  });

  it("a browser visit projects its tab title and URL", () => {
    expect(
      ftsProjection({
        url: "https://www.airbnb.com/s/Goa/homes",
        title: "Beach villas near Anjuna",
        transition: "link",
        domain: "airbnb.com",
      }),
    ).toEqual({ app: null, windowTitle: "Beach villas near Anjuna", docKey: "https://www.airbnb.com/s/Goa/homes" });
  });

  it("a chat message projects NULL, never an empty string", () => {
    expect(ftsProjection({ text: "book it", title: "   " })).toEqual({ app: null, windowTitle: null, docKey: null });
    const { id } = appendEvent({
      ts: "2026-09-01T10:00:00.000Z",
      source: "wa",
      kind: "wa.message",
      origin: "live",
      streamKey: "9198xx-1602@g.us",
      actor: "contact:rohan",
      roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
      payload: { text: "book it" },
    });
    const row = getDb().prepare(`SELECT app, window_title, doc_key FROM events WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row).toEqual({ app: null, window_title: null, doc_key: null });
  });
});

describe("0202_v6_fts_projection — chunks_fts follows chunks", () => {
  const search = (term: string): number[] =>
    (getDb().prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?`).all(term) as { rowid: number }[]).map((r) => r.rowid);

  it("insert → searchable by rowid; update of text → re-indexed; delete → gone", () => {
    const { id } = upsertChunk({ kind: "space", refId: "spc_1", text: "Goa trip — villa shortlist, Nov 14–17" });
    expect(search("villa")).toEqual([id]);

    getDb().prepare(`UPDATE chunks SET text = ?, content_hash = 'h2' WHERE id = ?`).run("Goa trip — hostel shortlist", id);
    expect(search("villa")).toEqual([]);
    expect(search("hostel")).toEqual([id]);

    expect(deleteChunks("space", { refId: "spc_1" })).toBe(1);
    expect(search("hostel")).toEqual([]);
  });

  it("a card and a chat window are both in the one index", () => {
    const card = upsertChunk({ kind: "person", refId: "ent_1", text: "Rohan — cousin; organises the Goa villa trips" }).id;
    const win = upsertChunk({ kind: "chat", source: "wa", streamKey: "g.us", text: "rohan: villa advance by 5pm?\nyou: yes, book it" }).id;
    expect(search("villa").sort()).toEqual([card, win].sort());
  });
});
