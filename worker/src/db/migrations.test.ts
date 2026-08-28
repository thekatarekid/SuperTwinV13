// ===========================================================================
// Migration-set tests (vitest). Four ids are retired from MIGRATIONS —
// `0004_phase2`, `0005_grounded_chat`, `0006_phase34` (V2 §3.2: the
// spaces/goals/milestones/tasks ontology) and `0007_phase5` — and the two
// halves of every retirement have to hold at once:
//
//   - a fresh DB never grows the retired objects, still ends up fully migrated,
//     and still gets the live pieces 0004–0006 used to carry, which moved to
//     `0021_v2_prep`;
//   - a DB installed back when those ran keeps its recorded ids, its orphan
//     tables and its rows, takes the later migrations on top, and still answers
//     grounded chat.
//
// The second half is seeded by hand from the historical bodies below — that SQL
// no longer exists in schema.ts and must not be resurrected there. 0021 then
// re-adds `chat_sessions.grounded` and friends on top of a DB that already has
// them, which is exactly the duplicate-column case runMigrationsOn absorbs.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrationsOn } from "./connection.js";
import {
  claimPendingMedia,
  claimPendingPosters,
  claimPendingTranscription,
  recordTranscript,
} from "./ingest.js";
import { getDb, runMigrations } from "./index.js";
import { MIGRATIONS } from "./schema.js";
import { buildContextBlock, searchEventHits } from "../server/chat-grounding.js";

/**
 * Exactly what `0004_phase2`, `0005_grounded_chat` and `0006_phase34` used to
 * apply, kept only as test fixtures. Trimmed to what a 0007-era DB needs to be
 * reconstructible: the tables and columns later migrations or these tests touch.
 */
const LEGACY_PHASE2 = /* sql */ `
ALTER TABLE spaces ADD COLUMN slug TEXT;
ALTER TABLE spaces ADD COLUMN user_pinned INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug   ON spaces(slug);
CREATE INDEX IF NOT EXISTS idx_spaces_status        ON spaces(status);

ALTER TABLE tasks ADD COLUMN title TEXT;
ALTER TABLE tasks ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN source_event_ids TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS space_people (
  space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (space_id, person_id)
);

CREATE TABLE IF NOT EXISTS evaluations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  output_type TEXT NOT NULL,
  output_id   TEXT NOT NULL,
  verdict     TEXT NOT NULL CHECK (verdict IN ('up','down')),
  note        TEXT,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS patterns (
  slug               TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('habit','workflow')),
  title              TEXT,
  status             TEXT NOT NULL DEFAULT 'candidate'
                       CHECK (status IN ('candidate','confirmed','dismissed')),
  evidence_count     INTEGER NOT NULL DEFAULT 0,
  evidence_event_ids TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

const LEGACY_GROUNDED_CHAT = /* sql */ `
ALTER TABLE chat_sessions ADD COLUMN grounded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN citations_json TEXT;
`;

const LEGACY_PHASE34 = /* sql */ `
ALTER TABLE tasks ADD COLUMN task_type              TEXT;
ALTER TABLE tasks ADD COLUMN triage                 TEXT;
ALTER TABLE tasks ADD COLUMN updated_at             TEXT;

ALTER TABLE extraction_runs ADD COLUMN model TEXT;
ALTER TABLE extraction_runs ADD COLUMN role  TEXT;

CREATE TABLE IF NOT EXISTS task_runs (
  id              TEXT PRIMARY KEY,
  task_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  space_id        TEXT,
  status          TEXT,
  plan            TEXT,
  transcript_path TEXT,
  model           TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  started_at      TEXT,
  finished_at     TEXT
);
`;

/** Exactly what `0007_phase5` used to apply, kept only as a test fixture. */
const LEGACY_PHASE5 = /* sql */ `
ALTER TABLE task_runs ADD COLUMN session_id TEXT;

CREATE TABLE IF NOT EXISTS nightly_runs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL,
  summary     TEXT,
  detail_json TEXT,
  error       TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_nightly_runs_kind ON nightly_runs(kind, started_at);

CREATE TABLE IF NOT EXISTS quality_snapshots (
  id          TEXT PRIMARY KEY,
  period      TEXT NOT NULL,
  output_type TEXT NOT NULL,
  up          INTEGER NOT NULL DEFAULT 0,
  down        INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  ts          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_snapshots_period ON quality_snapshots(period, output_type);
`;

const LEGACY_IDS = [
  "0001_init",
  "0002_phase1",
  "0003_phase1_threads",
  "0004_phase2",
  "0005_grounded_chat",
  "0006_phase34",
  "0007_phase5",
];

/** Everything a 0007-era install still owes. Ordered after 0007 by id. */
const POST_LEGACY_IDS = MIGRATIONS.map((m) => m.id).filter(
  (id) => !LEGACY_IDS.includes(id),
);

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-migrations-test-"));
  dbPath = join(tmpDir, "supertwinv13.db");
  process.env.SUPERTWIN_DB_PATH = dbPath;
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function tableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`)
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
}

/**
 * Write a DB in the state an install that last ran 0007 would be in: every
 * migration through 0007 applied AND recorded, with rows in the tables 0007
 * created plus one searchable event predating the 0008 FTS rebuild.
 */
function seedLegacyDb(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  for (const m of MIGRATIONS) {
    if (!LEGACY_IDS.includes(m.id)) continue;
    db.exec(m.sql);
  }
  // 0004–0007 are retired from MIGRATIONS, so their bodies come from the
  // fixtures above — that is what "the DB an old install is in" means here.
  db.exec(LEGACY_PHASE2);
  db.exec(LEGACY_GROUNDED_CHAT);
  db.exec(LEGACY_PHASE34);
  db.exec(LEGACY_PHASE5);

  const record = db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`);
  for (const id of LEGACY_IDS) record.run(id);

  db.prepare(`INSERT INTO channels (id, name, kind) VALUES ('c1', 'Goa Trip', 'group')`).run();
  db.prepare(`INSERT INTO actors (id, display_name) VALUES ('a1', 'Priya')`).run();
  db.prepare(
    `INSERT INTO events (id, channel_id, actor_id, ts, kind, text)
     VALUES ('e1', 'c1', 'a1', '2025-01-02T03:04:05.000Z', 'message', 'the hotel booking is confirmed')`,
  ).run();
  db.prepare(
    `INSERT INTO task_runs (id, task_id, status, session_id) VALUES ('tr1', NULL, 'done', 'sess-legacy')`,
  ).run();
  db.prepare(
    `INSERT INTO nightly_runs (id, kind, status, started_at) VALUES ('nr1', 'self_update', 'done', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO quality_snapshots (id, period, output_type, up, down, total, ts)
     VALUES ('2025-W01:chat_answer', '2025-W01', 'chat_answer', 3, 1, 4, 1)`,
  ).run();
  db.close();
}

describe("fresh DB", () => {
  it("migrates cleanly and never grows the retired objects", () => {
    runMigrations();
    const db = getDb();

    expect(
      (db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: string }[]).map(
        (r) => r.id,
      ),
    ).toEqual(MIGRATIONS.map((m) => m.id));

    const names = tableNames(db);
    expect(names.has("nightly_runs")).toBe(false);
    expect(names.has("quality_snapshots")).toBe(false);
    // The spaces/tasks ontology tables 0004/0006 created are gone outright.
    for (const t of ["space_people", "patterns", "task_runs"]) {
      expect(names.has(t), `retired table still created: ${t}`).toBe(false);
    }

    // Everything the app actually reads still arrives.
    for (const t of ["events", "events_fts", "app_state", "extraction_runs", "evaluations"]) {
      expect(names.has(t), `missing table: ${t}`).toBe(true);
    }
    expect(columns(db, "events")).toContain("media_description");
  });

  it("still grows what 0004–0006 carried that something reads (0021_v2_prep)", () => {
    // The three live pieces: without them grounded chat cannot record a session
    // or its citations, and the runs viewer cannot attribute a call.
    runMigrations();
    const db = getDb();
    expect(columns(db, "chat_sessions")).toContain("grounded");
    expect(columns(db, "chat_messages")).toContain("citations_json");
    expect(columns(db, "extraction_runs")).toEqual(
      expect.arrayContaining(["model", "role"]),
    );
  });
});

describe("DB installed at the old 0007 state", () => {
  it("opens, applies everything after 0007, and leaves the 0007 bookkeeping alone", () => {
    seedLegacyDb(dbPath);
    const db = getDb();

    const applied = (
      db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: string }[]
    ).map((r) => r.id);
    expect(applied).toEqual([...LEGACY_IDS, ...POST_LEGACY_IDS]);
    expect(columns(db, "events")).toContain("media_desc_status");
  });

  it("keeps the orphan tables and their rows", () => {
    seedLegacyDb(dbPath);
    const db = getDb();

    const names = tableNames(db);
    expect(names.has("nightly_runs")).toBe(true);
    expect(names.has("quality_snapshots")).toBe(true);
    expect(names.has("patterns")).toBe(true);
    expect(columns(db, "task_runs")).toContain("session_id");

    expect(db.prepare(`SELECT COUNT(*) AS n FROM nightly_runs`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM quality_snapshots`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT session_id FROM task_runs WHERE id = 'tr1'`).get()).toEqual({
      session_id: "sess-legacy",
    });
  });

  it("still serves grounded chat over events written before the upgrade", () => {
    seedLegacyDb(dbPath);

    const hits = searchEventHits("was the hotel booking confirmed?");
    expect(hits.map((h) => h.id)).toContain("e1");
    expect(hits[0].actor).toBe("Priya");
    expect(hits[0].chat).toBe("Goa Trip");

    const block = buildContextBlock("hotel booking");
    expect(block).toContain("<supertwin-context>");
    expect(block).toContain("[evt e1]");
  });
});

// ---------------------------------------------------------------------------
// 0009_media_backfill. Rows stored before 0008 have media_path but no mime, no
// thumbnail and no meta json, so the backfill has only `kind` and the file
// extension to work with — these cases pin what it derives from those two.
// ---------------------------------------------------------------------------

const BACKFILL_SQL = MIGRATIONS.find((m) => m.id === "0009_media_backfill")!.sql;

/** (external id, kind, media_path, media_thumb_path, seeded status) per row. */
const PRE_0009_ROWS: [string, string, string | null, string | null, string | null][] = [
  ["photo", "image", "/media/wa/a1.jpg", null, null],
  ["sticker", "sticker", "/media/wa/a2.webp", null, null],
  ["clip", "video", "/media/wa/a3.mp4", null, null],
  ["clip-thumbed", "video", "/media/wa/a4.mp4", "/media/wa/a4.thumb.jpg", null],
  ["voice", "audio", "/media/wa/a5.ogg", null, null],
  ["contract", "document", "/media/wa/a6.pdf", null, null],
  ["deck", "document", "/media/wa/a7.docx", null, null],
  ["rows", "document", "/media/wa/a8.CSV", null, null],
  ["vcard", "contact", "/media/wa/a9.vcf", null, null],
  ["plain", "message", null, null, null],
  ["described", "image", "/media/wa/b1.jpg", null, "done"],
  ["failed", "image", "/media/wa/b2.jpg", null, "error"],
  ["revoked", "image", null, null, "pending"],
];

/**
 * Write a DB in the state an install that last ran 0008 would be in: the media
 * columns exist, every id through 0008 is recorded, and the media rows carry the
 * NULL media_desc_status the pre-0009 insert path left behind.
 */
function seed0008Db(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  const record = db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`);
  for (const m of MIGRATIONS) {
    if (m.id === "0009_media_backfill") continue;
    db.exec(m.sql);
    record.run(m.id);
  }

  const insert = db.prepare(
    `INSERT INTO events (id, external_id, ts, kind, media_path, media_thumb_path, media_desc_status, media_description)
     VALUES (@id, @id, @ts, @kind, @path, @thumb, @status, @description)`,
  );
  for (const [id, kind, path_, thumb, status] of PRE_0009_ROWS) {
    insert.run({
      id,
      ts: "2025-01-02T03:04:05.000Z",
      kind,
      path: path_,
      thumb,
      status,
      description: status === "done" ? "a whiteboard covered in arrows" : null,
    });
  }
  db.close();
}

function statuses(db: Database.Database): Record<string, string | null> {
  const rows = db
    .prepare(`SELECT id, media_desc_status AS status FROM events`)
    .all() as { id: string; status: string | null }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

const EXPECTED_STATUSES: Record<string, string | null> = {
  photo: "pending",
  sticker: "pending",
  // No thumbnail (the daemon only started writing them in this release) => no
  // frame for the reader to look at.
  clip: "unsupported",
  "clip-thumbed": "pending",
  voice: "unsupported",
  contract: "pending",
  deck: "unsupported",
  // Extension matching is case-insensitive, like insertEvent's.
  rows: "pending",
  vcard: "unsupported",
  // No media at all => still nothing to read.
  plain: null,
  described: "done",
  failed: "error",
  revoked: "pending",
};

describe("DB installed at the 0008 state (0009_media_backfill)", () => {
  it("derives a status for every pre-0008 media row from kind + extension", () => {
    seed0008Db(dbPath);
    const db = getDb();

    expect(
      (db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: string }[]).map(
        (r) => r.id,
      ),
    ).toEqual(MIGRATIONS.map((m) => m.id));
    expect(statuses(db)).toEqual(EXPECTED_STATUSES);
  });

  it("leaves rows that already carry a status untouched, description included", () => {
    seed0008Db(dbPath);
    const db = getDb();

    expect(
      db.prepare(`SELECT media_description AS d FROM events WHERE id = 'described'`).get(),
    ).toEqual({ d: "a whiteboard covered in arrows" });
    expect(
      db.prepare(
        `SELECT COUNT(*) AS n FROM events WHERE media_path IS NOT NULL AND media_desc_status IS NULL`,
      ).get(),
    ).toEqual({ n: 0 });
  });

  it("is idempotent — a second application changes nothing", () => {
    seed0008Db(dbPath);
    const db = getDb();
    const after = statuses(db);

    // The reader moves a row on before the body is replayed, so a non-idempotent
    // backfill would show up as that row snapping back to 'pending'.
    db.prepare(`UPDATE events SET media_desc_status = 'done' WHERE id = 'photo'`).run();
    db.exec(BACKFILL_SQL);
    db.exec(BACKFILL_SQL);

    expect(statuses(db)).toEqual({ ...after, photo: "done" });
  });
});

// ---------------------------------------------------------------------------
// 0010–0012 (v3 §1/§2/§3) on a populated install. 0011 drops and rebuilds
// events_fts for the third time, so the thing that must be proven is that the
// rebuild carries the EXISTING index across — a silent empty index would look
// exactly like "nobody searched for that word yet".
// ---------------------------------------------------------------------------

/** A DB in the state a 0.2.x install is in: every id through 0009, with rows. */
function seed0009Db(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  const record = db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`);
  for (const m of MIGRATIONS) {
    if (m.id === "0010_token_truth") break;
    db.exec(m.sql);
    record.run(m.id);
  }

  db.prepare(`INSERT INTO channels (id, name, kind) VALUES ('c1', 'Goa Trip', 'group')`).run();
  db.prepare(
    `INSERT INTO events (id, channel_id, ts, kind, text, media_path, media_description, media_desc_status)
     VALUES ('e1', 'c1', '2026-01-02T03:04:05.000Z', 'message', 'the hotel booking is confirmed', NULL, NULL, NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO events (id, channel_id, ts, kind, text, media_path, media_description, media_desc_status)
     VALUES ('e2', 'c1', '2026-01-02T03:05:05.000Z', 'image', '', '/media/wa/b1.jpg', 'a whiteboard covered in arrows', 'done')`,
  ).run();
  db.prepare(
    `INSERT INTO quota_usage (input_tokens, output_tokens, run_count) VALUES (400, 100, 2)`,
  ).run();
  db.close();
}

function ftsHits(db: Database.Database, term: string): string[] {
  return (
    db
      .prepare(
        `SELECT e.id AS id FROM events_fts f JOIN events e ON e.rowid = f.rowid
          WHERE events_fts MATCH ?`,
      )
      .all(term) as { id: string }[]
  ).map((r) => r.id);
}

describe("DB installed at the 0009 state (0010–0012)", () => {
  it("applies the remaining ids and adds the token/link/business columns", () => {
    seed0009Db(dbPath);
    const db = getDb();

    expect(
      (db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: string }[]).map(
        (r) => r.id,
      ),
    ).toEqual(MIGRATIONS.map((m) => m.id));

    expect(columns(db, "extraction_runs")).toEqual(
      expect.arrayContaining(["cache_creation_input_tokens", "cache_read_input_tokens"]),
    );
    expect(columns(db, "quota_usage")).toEqual(
      expect.arrayContaining([
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "billable_tokens",
      ]),
    );
    expect(columns(db, "events")).toEqual(
      expect.arrayContaining([
        "link_url",
        "link_title",
        "link_description",
        "link_thumb_path",
        "link_preview_type",
        "link_scraped_text",
        "link_scrape_status",
        "link_scrape_error",
      ]),
    );
    expect(columns(db, "channels")).toContain("is_business");
  });

  it("keeps text and media_description searchable across the FTS rebuild", () => {
    seed0009Db(dbPath);
    const db = getDb();

    expect(ftsHits(db, "hotel")).toEqual(["e1"]);
    expect(ftsHits(db, "whiteboard")).toEqual(["e2"]);
    // snippet(events_fts, 0, …) — chat-grounding pins column 0 to the message
    // text, so the rebuild must not reorder the columns.
    expect(columns(db, "events_fts")[0]).toBe("text");

    const block = buildContextBlock("hotel booking");
    expect(block).toContain("[evt e1]");
  });

  it("indexes link title, blurb and scraped text through the new triggers", () => {
    seed0009Db(dbPath);
    const db = getDb();

    db.prepare(
      `UPDATE events SET link_url = ?, link_title = ?, link_description = ?, link_scraped_text = ?
        WHERE id = 'e1'`,
    ).run(
      "https://example.com/ferry",
      "Panjim ferry timetable",
      "Sailings every half hour",
      "the last sailing leaves from the northern gangplank",
    );

    expect(ftsHits(db, "timetable")).toEqual(["e1"]);
    expect(ftsHits(db, "sailings")).toEqual(["e1"]);
    expect(ftsHits(db, "gangplank")).toEqual(["e1"]);
  });

  it("seeds billable_tokens on rows that predate cache accounting", () => {
    seed0009Db(dbPath);
    const db = getDb();

    // Pre-0010 rows had no cache figures at all, so input+output IS what they
    // billed — leaving them 0 would read as free spend to the quota gate.
    expect(db.prepare(`SELECT billable_tokens AS b FROM quota_usage`).get()).toEqual({ b: 500 });
  });
});

// ---------------------------------------------------------------------------
// 0013–0014 (v4 §4b/§5) on the install every user is actually running: 0012 is
// the shipped head, so this is the upgrade that happens on the next launch. The
// rows already in that DB predate both flags, and the media queue reads them
// through the new ORDER BY the same night.
// ---------------------------------------------------------------------------

/** A DB in the state a 0.3.x install is in: every id through 0012, with rows. */
function seed0012Db(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  const record = db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`);
  for (const m of MIGRATIONS) {
    if (m.id === "0013_albums") break;
    db.exec(m.sql);
    record.run(m.id);
  }

  db.prepare(`INSERT INTO sources (id, type, name) VALUES ('whatsapp', 'whatsapp', 'WhatsApp')`).run();
  db.prepare(
    `INSERT INTO channels (id, source_id, source_ext_id, name, kind)
     VALUES ('c1', 'whatsapp', 'chat-1@s.whatsapp.net', 'Goa Trip', 'group')`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO events (id, source_id, channel_id, external_id, ts, kind, text, media_path,
                         media_thumb_path, media_desc_status)
     VALUES (@id, 'whatsapp', 'c1', @id, @ts, @kind, '', @path, @thumb, @status)`,
  );
  insert.run({
    id: "e-img",
    ts: "2026-01-02T03:04:05.000Z",
    kind: "image",
    path: "/media/wa/a1.jpg",
    thumb: null,
    status: "pending",
  });
  insert.run({
    id: "e-vid",
    ts: "2026-01-02T03:06:05.000Z",
    kind: "video",
    path: "/media/wa/a2.mp4",
    thumb: "/media/wa/a2.thumb.jpg",
    status: "pending",
  });
  db.close();
}

describe("DB installed at the 0012 state (0013–0014)", () => {
  it("applies both ids and adds the history column", () => {
    seed0012Db(dbPath);
    const db = getDb();

    expect(
      (db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: string }[]).map(
        (r) => r.id,
      ),
    ).toEqual(MIGRATIONS.map((m) => m.id));
    expect(columns(db, "events")).toEqual(expect.arrayContaining(["is_historical"]));
    // 0013 adds the album columns and 0019 takes them away again; an install
    // arriving here from 0012 goes through both in one transaction.
    expect(columns(db, "events")).not.toEqual(
      expect.arrayContaining(["album_id", "album_count"]),
    );
  });

  it("leaves the rows it found alone: live rather than historical", () => {
    seed0012Db(dbPath);
    const db = getDb();

    expect(
      db.prepare(`SELECT is_historical AS h FROM events ORDER BY id`).all(),
    ).toEqual([{ h: 0 }, { h: 0 }]);
  });

  it("still hands the pre-upgrade backlog to the media reader, batchable first", () => {
    seed0012Db(dbPath);

    // The video is newer, so a `ts DESC` claim would have led with the one row
    // that cannot share a call (v4 §4c).
    expect(
      claimPendingMedia(10, {
        images: true,
        video: true,
        documents: true,
        business: false,
      }).map((r) => r.id),
    ).toEqual(["e-img", "e-vid"]);
  });
});

// ---------------------------------------------------------------------------
// 0015–0016 (v5 §2/§3) on the install every user is actually running: 0014 is
// the shipped head. 0016 drops and rebuilds events_fts for the fourth time, so
// the same thing has to be proven again — the rebuild carries the EXISTING
// index across, and a silent empty one looks exactly like "nobody searched for
// that word yet". The backfill is the other half: without it every voice note
// already on disk stays invisible to a switch the user turns on later.
// ---------------------------------------------------------------------------

/** A DB in the state a 0.4.x install is in: every id through 0014, with rows. */
function seed0014Db(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  const record = db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`);
  for (const m of MIGRATIONS) {
    if (m.id === "0015_video_frames") break;
    db.exec(m.sql);
    record.run(m.id);
  }

  db.prepare(`INSERT INTO sources (id, type, name) VALUES ('whatsapp', 'whatsapp', 'WhatsApp')`).run();
  db.prepare(
    `INSERT INTO channels (id, source_id, source_ext_id, name, kind)
     VALUES ('c1', 'whatsapp', 'chat-1@s.whatsapp.net', 'Goa Trip', 'group')`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO events (id, source_id, channel_id, external_id, ts, kind, text, media_path,
                         media_thumb_path, media_description, media_desc_status, link_url,
                         link_scraped_text, link_scrape_status)
     VALUES (@id, 'whatsapp', 'c1', @id, @ts, @kind, @text, @path, @thumb, @description, @status,
             @linkUrl, @scraped, @linkStatus)`,
  );
  const row = {
    text: "",
    path: null as string | null,
    thumb: null as string | null,
    description: null as string | null,
    status: null as string | null,
    linkUrl: null as string | null,
    scraped: null as string | null,
    linkStatus: null as string | null,
  };
  insert.run({
    ...row,
    id: "e-text",
    ts: "2026-01-02T03:04:05.000Z",
    kind: "message",
    text: "the hotel booking is confirmed",
  });
  insert.run({
    ...row,
    id: "e-img",
    ts: "2026-01-02T03:05:05.000Z",
    kind: "image",
    path: "/media/wa/a1.jpg",
    description: "a whiteboard covered in arrows",
    status: "done",
  });
  insert.run({
    ...row,
    id: "e-link",
    ts: "2026-01-02T03:06:05.000Z",
    kind: "message",
    text: "https://example.com/ferry",
    linkUrl: "https://example.com/ferry",
    scraped: "the last sailing leaves from the northern gangplank",
    linkStatus: "done",
  });
  insert.run({
    ...row,
    id: "e-ptt",
    ts: "2026-01-02T03:07:05.000Z",
    kind: "audio",
    path: "/media/wa/a2.ogg",
    status: "unsupported",
  });
  insert.run({
    ...row,
    id: "e-vid",
    ts: "2026-01-02T03:08:05.000Z",
    kind: "video",
    path: "/media/wa/a3.mp4",
    thumb: "/media/wa/a3.thumb.jpg",
    status: "pending",
  });
  db.close();
}

describe("DB installed at the 0014 state (0015–0016)", () => {
  it("applies both ids and adds the frame + transcript columns", () => {
    seed0014Db(dbPath);
    const db = getDb();

    expect(
      (db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: string }[]).map(
        (r) => r.id,
      ),
    ).toEqual(MIGRATIONS.map((m) => m.id));
    expect(columns(db, "events")).toEqual(
      expect.arrayContaining([
        "media_frames_json",
        "transcript",
        "transcript_status",
        "transcript_model",
        "transcript_ts",
        "transcript_error",
      ]),
    );
  });

  it("keeps every indexed column searchable across the FTS rebuild", () => {
    seed0014Db(dbPath);
    const db = getDb();

    expect(ftsHits(db, "hotel")).toEqual(["e-text"]);
    expect(ftsHits(db, "whiteboard")).toEqual(["e-img"]);
    expect(ftsHits(db, "gangplank")).toEqual(["e-link"]);
    // chat-grounding pins column 0 to the message text, and 0016/0017 append
    // rather than reorder, so every earlier ordinal has to stay where it was.
    expect(columns(db, "events_fts")).toEqual([
      "text",
      "media_description",
      "link_title",
      "link_description",
      "link_scraped_text",
      "transcript",
      "reply_to_text",
    ]);

    const block = buildContextBlock("hotel booking");
    expect(block).toContain("[evt e-text]");
  });

  it("backfills a transcription status onto the rows that predate the column", () => {
    seed0014Db(dbPath);
    const db = getDb();

    expect(
      Object.fromEntries(
        (
          db
            .prepare(`SELECT id, transcript_status AS s FROM events ORDER BY id`)
            .all() as { id: string; s: string | null }[]
        ).map((r) => [r.id, r.s]),
      ),
    ).toEqual({
      "e-text": null,
      "e-img": "unsupported",
      "e-link": null,
      "e-ptt": "pending",
      "e-vid": "pending",
    });
  });

  it("hands the pre-upgrade voice notes to the transcriber, newest first", () => {
    seed0014Db(dbPath);

    expect(
      claimPendingTranscription(10, {
        voiceNotes: true,
        videoAudio: true,
        business: false,
      }).map((r) => r.id),
    ).toEqual(["e-vid", "e-ptt"]);

    // And a transcript recorded after the upgrade reaches the rebuilt index.
    recordTranscript("e-ptt", {
      transcript: "ferry pakadni hai",
      model: "ggml-large-v3-turbo-q5_0",
      status: "done",
    });
    expect(ftsHits(getDb(), "pakadni")).toEqual(["e-ptt"]);
  });

  it("leaves the media-reading queue exactly where it was", () => {
    seed0014Db(dbPath);

    expect(
      claimPendingMedia(10, {
        images: true,
        video: true,
        documents: true,
        business: false,
      }).map((r) => r.id),
    ).toEqual(["e-vid"]);
  });

  it("holds back a video with no still, and offers it a poster instead", () => {
    seed0014Db(dbPath);
    getDb()
      .prepare(
        `INSERT INTO events (id, source_id, channel_id, external_id, ts, kind, text,
                             media_path, media_desc_status)
         VALUES ('e-vid2', 'whatsapp', 'c1', 'e-vid2', '2026-01-02T03:09:05.000Z', 'video',
                 '', '/media/wa/a4.mp4', 'pending')`,
      )
      .run();

    expect(
      claimPendingMedia(10, {
        images: true,
        video: true,
        documents: true,
        business: false,
      }).map((r) => r.id),
    ).toEqual(["e-vid"]);
    expect(claimPendingPosters(10).map((r) => r.id)).toEqual(["e-vid2"]);
  });
});

// ---------------------------------------------------------------------------
// 0017–0018 (v6 §1) on the install every user is actually running: 0016 is the
// shipped head. 0017 drops and rebuilds events_fts for the fifth time, so the
// same thing has to be proven again — the rebuild carries the EXISTING index
// across, and it must ALSO pick up the reply_to_text that was sitting in the
// table unindexed all along (80 rows of it on the live DB).
// ---------------------------------------------------------------------------

/** A DB in the state a 0.4.x install is in: every id through 0016, with rows. */
function seed0016Db(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  const record = db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`);
  for (const m of MIGRATIONS) {
    if (m.id === "0017_reply_fts") break;
    db.exec(m.sql);
    record.run(m.id);
  }

  db.prepare(`INSERT INTO sources (id, type, name) VALUES ('whatsapp', 'whatsapp', 'WhatsApp')`).run();
  db.prepare(
    `INSERT INTO channels (id, source_id, source_ext_id, name, kind)
     VALUES ('c1', 'whatsapp', 'chat-1@g.us', 'Weekend lunches', 'group')`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO events (id, source_id, channel_id, external_id, ts, kind, text, media_path,
                         media_description, transcript, link_url, link_scraped_text,
                         reply_to_external_id, reply_to_text)
     VALUES (@id, 'whatsapp', 'c1', @id, @ts, @kind, @text, @path, @description, @transcript,
             @linkUrl, @scraped, @replyTo, @replyToText)`,
  );
  const row = {
    text: "",
    path: null as string | null,
    description: null as string | null,
    transcript: null as string | null,
    linkUrl: null as string | null,
    scraped: null as string | null,
    replyTo: null as string | null,
    replyToText: null as string | null,
  };
  insert.run({
    ...row,
    id: "e-text",
    ts: "2026-07-30T03:04:05.000Z",
    kind: "message",
    text: "sunday lunch chalna hai kahin?",
  });
  insert.run({
    ...row,
    id: "e-img",
    ts: "2026-07-30T03:05:05.000Z",
    kind: "image",
    path: "/media/wa/a1.jpg",
    description: "a whiteboard covered in arrows",
  });
  insert.run({
    ...row,
    id: "e-link",
    ts: "2026-07-30T03:06:05.000Z",
    kind: "message",
    text: "https://example.com/ferry",
    linkUrl: "https://example.com/ferry",
    scraped: "the last sailing leaves from the northern gangplank",
  });
  insert.run({
    ...row,
    id: "e-ptt",
    ts: "2026-07-30T03:07:05.000Z",
    kind: "audio",
    path: "/media/wa/a2.ogg",
    transcript: "ferry pakadni hai",
  });
  // The row 0017 exists for: nothing it says answers a question about lunch,
  // and everything it quotes does.
  insert.run({
    ...row,
    id: "e-reply",
    ts: "2026-07-30T03:08:05.000Z",
    kind: "message",
    text: "Can do. Place?",
    replyTo: "e-text",
    replyToText: "sunday lunch chalna hai kahin?",
  });
  db.close();
}

describe("DB installed at the 0016 state (0017–0018)", () => {
  it("applies both ids and adds the semantic-index table", () => {
    seed0016Db(dbPath);
    const db = getDb();

    expect(
      (db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: string }[]).map(
        (r) => r.id,
      ),
    ).toEqual(MIGRATIONS.map((m) => m.id));
    expect(tableNames(db).has("event_embeddings")).toBe(true);
    expect(columns(db, "event_embeddings")).toEqual([
      "event_id",
      "model",
      "dim",
      "vector",
      "indexed_at",
    ]);
  });

  it("keeps every indexed column searchable across the FTS rebuild", () => {
    seed0016Db(dbPath);
    const db = getDb();

    // "lunch" now also reaches the reply that quotes it — the point of 0017 —
    // so this only pins that the message itself is still findable.
    expect(ftsHits(db, "lunch")).toContain("e-text");
    expect(ftsHits(db, "whiteboard")).toEqual(["e-img"]);
    expect(ftsHits(db, "gangplank")).toEqual(["e-link"]);
    expect(ftsHits(db, "pakadni")).toEqual(["e-ptt"]);
    // chat-grounding pins column 0 to the message text, and 0017 appends rather
    // than reorders, so every earlier ordinal stays where it was.
    expect(columns(db, "events_fts")).toEqual([
      "text",
      "media_description",
      "link_title",
      "link_description",
      "link_scraped_text",
      "transcript",
      "reply_to_text",
    ]);

    const block = buildContextBlock("sunday lunch");
    expect(block).toContain("[evt e-text]");
  });

  it("backfills the quoted text of replies that predate the column being indexed", () => {
    seed0016Db(dbPath);
    const db = getDb();

    // The reply was stored long before 0017; the rebuild is what makes it
    // findable from the question it answers.
    expect(ftsHits(db, "chalna").sort()).toEqual(["e-reply", "e-text"]);
  });

  it("indexes a quoted reply arriving after the upgrade, through the new trigger", () => {
    seed0016Db(dbPath);
    const db = getDb();

    db.prepare(
      `INSERT INTO events (id, source_id, channel_id, external_id, ts, kind, text,
                           reply_to_external_id, reply_to_text)
       VALUES ('e-late', 'whatsapp', 'c1', 'e-late', '2026-07-30T03:09:05.000Z', 'message',
               'booked oye kake', 'e-reply', 'Can do. Place?')`,
    ).run();

    expect(ftsHits(db, "booked")).toEqual(["e-late"]);
    expect(ftsHits(db, '"Place"').sort()).toEqual(["e-late", "e-reply"]);
  });

  it("re-indexes a quote that is rewritten after the fact", () => {
    seed0016Db(dbPath);
    const db = getDb();

    // events_au has no `OF` clause, so it fires on a reply_to_text update the
    // same way it does on a late transcript.
    db.prepare(`UPDATE events SET reply_to_text = ? WHERE id = 'e-reply'`).run(
      "saturday brunch chalna hai kahin?",
    );

    expect(ftsHits(db, "brunch")).toEqual(["e-reply"]);
    expect(ftsHits(db, "chalna").sort()).toEqual(["e-reply", "e-text"]);
    // The old quote is gone from the index, not sitting beside the new one.
    expect(ftsHits(db, "sunday")).toEqual(["e-text"]);
  });
});

// ---------------------------------------------------------------------------
// 0019–0020 (v7 §1, §3) on the install the user is running now. 0019 is the
// first migration that takes a column AWAY from the table holding every
// message, so it is the one with the most to lose: rowids are what events_fts
// is indexed by, the FK from space_events and event_embeddings is what a
// cascade would empty, and both are invisible in a schema diff. 0020 re-opens
// the videos an earlier release wrote off for good.
// ---------------------------------------------------------------------------

/** A DB in the state a 0.5.x install is in: every id through 0018, with rows. */
function seed0018Db(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  const record = db.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`);
  for (const m of MIGRATIONS) {
    if (m.id === "0019_drop_albums") break;
    db.exec(m.sql);
    record.run(m.id);
  }

  db.prepare(`INSERT INTO sources (id, type, name) VALUES ('whatsapp', 'whatsapp', 'WhatsApp')`).run();
  db.prepare(
    `INSERT INTO channels (id, source_id, source_ext_id, name, kind)
     VALUES ('c1', 'whatsapp', 'chat-1@g.us', 'Goa Trip', 'group')`,
  ).run();
  db.prepare(
    `INSERT INTO actors (id, source_id, source_ext_id, display_name)
     VALUES ('a1', 'whatsapp', 'friend@s.whatsapp.net', 'Priya')`,
  ).run();
  const insert = db.prepare(
    `INSERT INTO events (id, source_id, channel_id, actor_id, external_id, ts, kind, text,
                         media_path, media_thumb_path, media_desc_status, media_desc_ts,
                         media_description, transcript, link_url, link_title, link_scraped_text,
                         reply_to_external_id, reply_to_text, album_id, album_count,
                         is_forwarded, is_historical)
     VALUES (@id, 'whatsapp', 'c1', 'a1', @id, @ts, @kind, @text, @path, @thumb, @status, @descTs,
             @description, @transcript, @linkUrl, @linkTitle, @scraped, @replyTo, @replyToText,
             @albumId, @albumCount, @forwarded, @historical)`,
  );
  const row = {
    text: "",
    path: null as string | null,
    thumb: null as string | null,
    status: null as string | null,
    descTs: null as string | null,
    description: null as string | null,
    transcript: null as string | null,
    linkUrl: null as string | null,
    linkTitle: null as string | null,
    scraped: null as string | null,
    replyTo: null as string | null,
    replyToText: null as string | null,
    albumId: null as string | null,
    albumCount: null as number | null,
    forwarded: 0,
    historical: 0,
  };
  insert.run({
    ...row,
    id: "e-text",
    ts: "2026-07-30T03:04:05.000Z",
    kind: "message",
    text: "sunday lunch chalna hai kahin?",
    forwarded: 1,
  });
  // The album header and one of its members: the rows 0019 is about.
  insert.run({
    ...row,
    id: "e-hdr",
    ts: "2026-07-30T03:05:00.000Z",
    kind: "image",
    path: "/media/wa/a1.jpg",
    thumb: "/media/wa/a1.thumb.jpg",
    status: "done",
    descTs: "2026-07-30T04:00:00.000Z",
    description: "a whiteboard covered in arrows",
    albumId: "e-hdr",
    albumCount: 2,
  });
  insert.run({
    ...row,
    id: "e-member",
    ts: "2026-07-30T03:05:01.000Z",
    kind: "image",
    path: "/media/wa/a2.jpg",
    status: "pending",
    albumId: "e-hdr",
    historical: 1,
  });
  insert.run({
    ...row,
    id: "e-link",
    ts: "2026-07-30T03:06:05.000Z",
    kind: "message",
    text: "https://example.com/ferry",
    linkUrl: "https://example.com/ferry",
    linkTitle: "Ferry timings",
    scraped: "the last sailing leaves from the northern gangplank",
  });
  insert.run({
    ...row,
    id: "e-ptt",
    ts: "2026-07-30T03:07:05.000Z",
    kind: "audio",
    path: "/media/wa/a3.ogg",
    transcript: "ferry pakadni hai",
  });
  insert.run({
    ...row,
    id: "e-reply",
    ts: "2026-07-30T03:08:05.000Z",
    kind: "message",
    text: "Can do. Place?",
    replyTo: "e-text",
    replyToText: "sunday lunch chalna hai kahin?",
  });
  // The 10-of-18 case: an mp4 on disk, no thumbnail, written off at insert.
  insert.run({
    ...row,
    id: "e-vid-nothumb",
    ts: "2026-07-30T03:09:05.000Z",
    kind: "video",
    path: "/media/wa/a4.mp4",
    status: "unsupported",
  });
  // A video the reader actually opened and could not use: its verdict stands.
  insert.run({
    ...row,
    id: "e-vid-read",
    ts: "2026-07-30T03:10:05.000Z",
    kind: "video",
    path: "/media/wa/a5.mp4",
    status: "unsupported",
    descTs: "2026-07-30T04:00:00.000Z",
  });

  // The two tables that hold a foreign key ON events. Nothing in a schema diff
  // would show these emptying.
  db.prepare(`INSERT INTO spaces (id, name) VALUES ('s1', 'Goa')`).run();
  db.prepare(`INSERT INTO space_events (space_id, event_id) VALUES ('s1', 'e-text')`).run();
  db.prepare(
    `INSERT INTO event_embeddings (event_id, model, dim, vector)
     VALUES ('e-text', 'multilingual-e5-small', 2, x'0000803f0000003f')`,
  ).run();
  db.close();
}

function indexNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?
          AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all(table) as { name: string }[]
  ).map((r) => r.name);
}

describe("DB installed at the 0018 state (0019–0020)", () => {
  it("drops the album columns and the index that named them", () => {
    seed0018Db(dbPath);
    const db = getDb();

    expect(
      (db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: string }[]).map(
        (r) => r.id,
      ),
    ).toEqual(MIGRATIONS.map((m) => m.id));
    expect(columns(db, "events")).not.toEqual(
      expect.arrayContaining(["album_id", "album_count"]),
    );
    expect(indexNames(db, "events")).not.toContain("idx_events_album");
  });

  it("keeps every other column of every row, to the character", () => {
    const before = (() => {
      seed0018Db(dbPath);
      const db = new Database(dbPath);
      const rows = db
        .prepare(
          `SELECT id, source_id, channel_id, actor_id, external_id, ts, kind, text, media_path,
                  media_thumb_path, media_desc_status, media_description, transcript, link_url,
                  link_title, link_scraped_text, reply_to_external_id, reply_to_text,
                  is_forwarded, is_historical, rowid AS rid
             FROM events ORDER BY id`,
        )
        .all();
      db.close();
      return rows;
    })();

    const db = getDb();
    const after = db
      .prepare(
        `SELECT id, source_id, channel_id, actor_id, external_id, ts, kind, text, media_path,
                media_thumb_path, media_desc_status, media_description, transcript, link_url,
                link_title, link_scraped_text, reply_to_external_id, reply_to_text,
                is_forwarded, is_historical, rowid AS rid
           FROM events ORDER BY id`,
      )
      .all()
      // 0020 is allowed to move exactly one status; everything else must be
      // byte-identical, rowid included.
      .map((r) => ({ ...(r as Record<string, unknown>) }));
    for (const row of after) {
      if (row.id === "e-vid-nothumb") row.media_desc_status = "unsupported";
    }
    expect(after).toEqual(before);
  });

  it("keeps every indexed column searchable, and the triggers working after", () => {
    seed0018Db(dbPath);
    const db = getDb();

    // The FTS index is external-content over events.rowid: a rebuild that
    // renumbered them would point each of these at a different message.
    expect(ftsHits(db, "chalna").sort()).toEqual(["e-reply", "e-text"]);
    expect(ftsHits(db, "whiteboard")).toEqual(["e-hdr"]);
    expect(ftsHits(db, "gangplank")).toEqual(["e-link"]);
    expect(ftsHits(db, "timings")).toEqual(["e-link"]);
    expect(ftsHits(db, "pakadni")).toEqual(["e-ptt"]);
    expect(columns(db, "events_fts")).toEqual([
      "text",
      "media_description",
      "link_title",
      "link_description",
      "link_scraped_text",
      "transcript",
      "reply_to_text",
    ]);

    db.prepare(
      `INSERT INTO events (id, source_id, channel_id, external_id, ts, kind, text)
       VALUES ('e-late', 'whatsapp', 'c1', 'e-late', '2026-07-30T03:20:05.000Z', 'message',
               'booked oye kake')`,
    ).run();
    expect(ftsHits(db, "booked")).toEqual(["e-late"]);
    db.prepare(`UPDATE events SET transcript = ? WHERE id = 'e-ptt'`).run("bus pakadni hai");
    expect(ftsHits(db, "bus")).toEqual(["e-ptt"]);
    db.prepare(`DELETE FROM events WHERE id = 'e-late'`).run();
    expect(ftsHits(db, "booked")).toEqual([]);

    const block = buildContextBlock("sunday lunch");
    expect(block).toContain("[evt e-text]");
  });

  it("leaves the rest of the schema exactly where it was", () => {
    seed0018Db(dbPath);
    const db = getDb();

    // 0022_v2_core rebuilds events: idx_events_channel/_channel_ts come back as
    // idx_events_stream/_stream_ts on the renamed column (plus the bridge index
    // that dies with channel_id in item 1.1), and the V2 columns get their own.
    // 0100_v13_core (P0.4) adds the envelope indexes: content_hash for the
    // single-writer idempotency lookup, (stream_key, ts) for thread history,
    // and the partial undispatched index the P0.5 window query keys on.
    expect(indexNames(db, "events")).toEqual([
      "idx_events_actor",
      "idx_events_actor_entity",
      "idx_events_channel_compat",
      "idx_events_content_hash",
      "idx_events_desc_status",
      "idx_events_enrichment",
      "idx_events_link_status",
      "idx_events_reply_to",
      "idx_events_source_external",
      "idx_events_stream",
      "idx_events_stream_key",
      "idx_events_stream_ts",
      "idx_events_transcript_status",
      "idx_events_ts",
      "idx_events_undispatched",
    ]);
    expect(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
          .all() as { name: string }[]
      ).map((r) => r.name),
    ).toEqual(["events_ad", "events_ai", "events_au", "events_stream_compat_ai"]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps the rows that hold a foreign key on events", () => {
    seed0018Db(dbPath);
    const db = getDb();

    // A hand-rolled rebuild drops `events` for a moment, and with foreign_keys
    // ON that implicit delete cascades into this one. 0022_v2_core rebuilds the
    // table for real (to shed the stale channels FK on the renamed column) and
    // stages these rows out and back; space_events, the other child, went with
    // the legacy ontology that migration drops.
    expect(db.prepare(`SELECT event_id FROM event_embeddings`).all()).toEqual([
      { event_id: "e-text" },
    ]);
    // Still enforced afterwards, in both directions.
    expect(() =>
      db
        .prepare(
          `INSERT INTO event_embeddings (event_id, model, dim, vector)
           VALUES ('nope', 'm', 1, x'00')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.prepare(`DELETE FROM events WHERE id = 'e-text'`).run();
    expect(db.prepare(`SELECT event_id FROM event_embeddings`).all()).toEqual([]);
  });

  it("re-opens the videos written off for having no thumbnail (0020)", () => {
    seed0018Db(dbPath);
    const db = getDb();

    expect(
      db
        .prepare(
          `SELECT id, media_desc_status AS s FROM events WHERE kind = 'video' ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: "e-vid-nothumb", s: "pending" },
      // The reader opened this one and said no; a verdict from the file itself
      // is not one to overrule.
      { id: "e-vid-read", s: "unsupported" },
    ]);

    // Pending, not claimable yet: there is still no still to hand the reader,
    // which is what the poster queue is for.
    expect(
      claimPendingMedia(10, {
        images: true,
        video: true,
        documents: true,
        business: false,
      }).map((r) => r.id),
    ).not.toContain("e-vid-nothumb");
    // Both videos are in the poster queue: a clip the reader could not describe
    // still has to LOOK like a clip.
    expect(claimPendingPosters(10).map((r) => r.id)).toEqual([
      "e-vid-read",
      "e-vid-nothumb",
    ]);
  });

  it("is a no-op the second time, columns and rows alike", () => {
    seed0018Db(dbPath);
    const before = getDb().prepare(`SELECT * FROM events ORDER BY id`).all();

    // Re-running is what the next launch does, and DROP COLUMN on a column
    // already gone is an error — the recorded id is what stands between them.
    runMigrationsOn(getDb());
    closeDb();
    const db = getDb();

    expect(db.prepare(`SELECT * FROM events ORDER BY id`).all()).toEqual(before);
    expect(columns(db, "events")).not.toEqual(
      expect.arrayContaining(["album_id", "album_count"]),
    );
  });
});
