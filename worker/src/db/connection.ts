// ===========================================================================
// Database connection + migration runner (see docs/PHASE0_ARCHITECTURE.md §6).
//
//   - Resolves the DB path with the same precedence as brain/media so one env
//     var isolates all worker data (see resolveDbPath): SUPERTWIN_DB_PATH (tests
//     point this at a temp file), else SUPERTWIN_HOME/supertwinv13.db, else
//     ~/SuperTwinV13/supertwinv13.db. The parent dir is created if missing.
//   - Sets 16 KB pages (fresh files), enables WAL journaling and `PRAGMA foreign_keys = ON`.
//   - Runs ordered migrations transactionally; records applied ids in
//     `schema_migrations` so running them twice is a no-op the second time.
//
// A single handle is memoized per process. The handle is keyed on the resolved
// path, so if SUPERTWIN_DB_PATH changes (as it does between tests) we transparently
// reopen against the new file instead of returning a stale handle.
// ===========================================================================

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { MIGRATIONS } from "./schema.js";

let db: Database.Database | null = null;
let openedPath: string | null = null;

/**
 * Resolve the DB file path. Precedence (mirrors brainRoot()/mediaRoot() so a
 * single env var sandboxes db+brain+media together):
 *   1. SUPERTWIN_DB_PATH  — most specific; tests + the eval runner rely on it.
 *   2. SUPERTWIN_HOME/supertwinv13.db — one home dir isolates all worker data.
 *   3. ~/SuperTwinV13/supertwinv13.db    — real default.
 */
export function resolveDbPath(): string {
  const override = process.env.SUPERTWIN_DB_PATH;
  if (override && override.trim().length > 0) return override;
  const home = process.env.SUPERTWIN_HOME;
  if (home && home.trim().length > 0) return join(home, "supertwinv13.db");
  return join(homedir(), "SuperTwinV13", "supertwinv13.db");
}

/**
 * Open (or reuse) the shared handle and ensure migrations have run.
 * Reopens transparently if the resolved path has changed since the last open.
 */
export function getDb(): Database.Database {
  const path = resolveDbPath();
  if (db && openedPath === path) return db;

  // Path changed (or first open): drop any stale handle and open fresh.
  if (db && openedPath !== path) {
    try {
      db.close();
    } catch {
      // ignore — best effort close of the previous handle
    }
    db = null;
    openedPath = null;
  }

  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const handle = new Database(path);
  // 16 KB pages (V6 S2.1, T5-3): int8 chunk vectors pack ~20 to a page. Must
  // precede the first table and the switch to WAL; on a file that already has
  // pages this is a no-op (a page size only changes through VACUUM).
  handle.pragma("page_size = 16384");
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  applyRuntimePragmas(handle);

  db = handle;
  openedPath = path;

  runMigrationsOn(handle);
  return handle;
}

/**
 * Runtime pragmas — V6 P1 S6d L1 (Library latency root-cause).
 *
 * better-sqlite3 is SYNCHRONOUS and this process keeps ONE handle, so an
 * importer writing history does not merely contend with a reader: it OWNS the
 * event loop for as long as its writes take, and every HTTP read queues behind
 * it. Measured on a 400k-row scratch corpus with the pre-existing settings, one
 * imported WhatsApp message cost 4.7 ms — a durable fsync per row, because WAL
 * mode still defaults to `synchronous = FULL`. An 11,466-message history import
 * is therefore ~54 seconds during which nothing else in the worker can run.
 * That is exactly the "frozen screen, sometimes a minute" the Library shows.
 *
 *   synchronous = NORMAL   the standard WAL setting: a commit no longer fsyncs.
 *                          Durability across an OS crash or power loss is
 *                          traded for it; a process crash is still safe, since
 *                          the WAL survives. Everything here is re-derivable
 *                          capture, so the trade is the right way round.
 *   busy_timeout = 5000    the media sidecar and the Go daemon can hold the
 *                          file briefly; wait rather than throw SQLITE_BUSY.
 *   cache_size = -65536    64 MB of page cache. The Library's aggregates walk
 *                          the same index pages repeatedly; at the default
 *                          2 MB they were re-read from disk every request.
 *   temp_store = MEMORY    GROUP BY / ORDER BY spills stay off the disk.
 *   mmap_size = 256 MB     read the hot part of the file without a copy.
 *   wal_autocheckpoint     2000 pages = 32 MB at this page size. The user's
 *                          real home had grown an 801 MB WAL beside a 1.05 GB
 *                          database, which every reader then has to consult.
 *
 * Pragma failures are swallowed on purpose: an older SQLite that does not know
 * one of these should still open the database.
 */
export function applyRuntimePragmas(handle: Database.Database): void {
  for (const p of [
    "synchronous = NORMAL",
    "busy_timeout = 5000",
    "cache_size = -65536",
    "temp_store = MEMORY",
    "mmap_size = 268435456",
    "wal_autocheckpoint = 2000",
  ]) {
    try {
      handle.pragma(p);
    } catch {
      // an unknown pragma is not a reason to fail the open
    }
  }
}

/**
 * Copy the WAL back into the database and truncate it. Called from the worker's
 * idle sweep: a passive autocheckpoint keeps the WAL bounded but never shrinks
 * the file, so a home that once imported a large history carries the high-water
 * mark forever (801 MB on the user's). TRUNCATE only completes when no reader
 * holds a snapshot, and returns quietly when one does.
 */
export function checkpointWal(handle: Database.Database = getDb()): void {
  try {
    handle.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // a busy checkpoint is a no-op, not an error
  }
}

/**
 * Apply any not-yet-recorded migrations against the given handle, inside a
 * transaction. Idempotent: already-applied ids (recorded in schema_migrations)
 * are skipped, so a second call does nothing.
 */
export function runMigrationsOn(handle: Database.Database): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const isApplied = handle.prepare(
    "SELECT 1 FROM schema_migrations WHERE id = ?",
  );
  const record = handle.prepare(
    "INSERT INTO schema_migrations (id) VALUES (?)",
  );

  const apply = handle.transaction(() => {
    for (const m of MIGRATIONS) {
      if (isApplied.get(m.id)) continue;
      execMigration(handle, m.sql);
      record.run(m.id);
    }
  });

  apply();
}

/**
 * Execute a migration body. Normally a single `exec()` of the whole body is
 * enough. But `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` form, so on a
 * dev DB where the column was already added by hand (a partially-applied
 * migration) a plain `exec()` would throw "duplicate column name". To stay
 * robust, we fall back to running statements one at a time and swallow ONLY the
 * duplicate-column error on ADD COLUMN — every other error still aborts the
 * (transactional) migration. Fresh DBs and clean Phase-0 DBs take the fast path.
 */
function execMigration(handle: Database.Database, sql: string): void {
  try {
    handle.exec(sql);
    return;
  } catch (err) {
    if (!isDuplicateColumnError(err)) throw err;
  }

  // Re-run statement-by-statement, tolerating only duplicate-column on ADD COLUMN.
  for (const stmt of splitSqlStatements(sql)) {
    try {
      handle.exec(stmt);
    } catch (err) {
      if (isDuplicateColumnError(err) && /add\s+column/i.test(stmt)) continue;
      throw err;
    }
  }
}

function isDuplicateColumnError(err: unknown): boolean {
  return /duplicate column name/i.test((err as Error)?.message ?? "");
}

/**
 * Naive SQL splitter for migration bodies: strips `--` line comments and splits
 * on `;`. Migration SQL here is simple DDL (no embedded semicolons in strings),
 * so this is sufficient and only used on the rare duplicate-column fallback
 * path. A `CREATE TRIGGER … BEGIN … END` body does carry its own `;`s, so those
 * fragments are re-joined up to the matching END and executed as one statement.
 */
function splitSqlStatements(sql: string): string[] {
  const body = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const out: string[] = [];
  let buf = "";
  for (const part of body.split(";")) {
    buf += part;
    if (/\bBEGIN\b/i.test(buf) && !/\bEND\b\s*$/i.test(buf)) {
      buf += ";";
      continue;
    }
    const stmt = buf.trim();
    if (stmt.length > 0) out.push(stmt);
    buf = "";
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/** Run migrations against the shared handle (opens it if needed). */
export function runMigrations(): void {
  getDb();
}

/**
 * Close and forget the shared handle. Primarily for tests that recycle temp DB
 * files; safe to call when nothing is open.
 */
export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  db = null;
  openedPath = null;
}
