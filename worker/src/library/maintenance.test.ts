// ===========================================================================
// Library maintenance + the runtime pragmas behind it — V6 P1 S6d L1.
//
// Two things that only look like configuration until you measure them:
//
//   - `synchronous = NORMAL`. In WAL mode SQLite still defaults to FULL, which
//     fsyncs on every commit; ingest opens one transaction per imported
//     message, so a history import was one durable fsync per row (4.7 ms each
//     on a 400k-row scratch corpus, ~54 s of blocked event loop for the
//     11,466 rows the user had left).
//   - the warm/checkpoint sweep. The measured half of the Storage panel is
//     taken off the request path, and the WAL — 801 MB on the user's real home
//     beside a 1.05 GB database — is truncated once the log goes quiet.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkpointWal, closeDb, getDb, runMigrations } from "../db/connection.js";
import { startLibraryMaintenance } from "./maintenance.js";
import { invalidateStorageSnapshot, storageOverview } from "./storage.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-library-maint-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  invalidateStorageSnapshot();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runtime pragmas", () => {
  it("opens WAL with NORMAL sync, a busy timeout and room to cache", () => {
    const db = getDb();
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    // 1 = NORMAL. FULL (2) is the default in WAL and is the fsync-per-commit
    // that made every imported message cost milliseconds.
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5_000);
    // Negative cache_size is kibibytes, not pages: -65536 is 64 MB.
    expect(db.pragma("cache_size", { simple: true })).toBe(-65_536);
    expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(2_000);
  });

  it("truncates the WAL on demand", () => {
    const db = getDb();
    const ins = db.prepare(
      `INSERT INTO events (id, source_type, ts, kind, text) VALUES (?, 'whatsapp', ?, 'wa.message', ?)`,
    );
    const write = db.transaction(() => {
      for (let i = 0; i < 2_000; i++) {
        ins.run(`ev${i}`, new Date(Date.now() - i * 1_000).toISOString(), `body ${i} `.repeat(20));
      }
    });
    write();
    const walBytes = (): number => {
      try {
        return statSync(`${db.name}-wal`).size;
      } catch {
        return 0;
      }
    };
    expect(walBytes()).toBeGreaterThan(0);
    checkpointWal(db);
    expect(walBytes()).toBe(0);
  });
});

describe("the maintenance sweep", () => {
  it("warms the storage snapshot once the log is still, and only once", async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO events (id, source_type, ts, kind, text, payload_json)
         VALUES ('e1', 'whatsapp', '2026-09-01T10:00:00.000Z', 'wa.message', 'hello', '{"text":"hello"}')`,
    ).run();
    invalidateStorageSnapshot();

    const lines: string[] = [];
    const handle = startLibraryMaintenance({
      log: (l) => lines.push(l),
      sweepMs: 5,
      warmQuietMs: 0,
      warmDeadlineMs: 0,
      checkpointQuietMs: 10 * 60_000,
    });
    try {
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      handle.stop();
    }
    expect(lines.filter((l) => l.includes("storage snapshot warmed"))).toHaveLength(1);

    // Warmed means the next read is served from the snapshot, not measured.
    const first = storageOverview(tmpDir);
    const second = storageOverview(tmpDir);
    expect(first.as_of).toBe(second.as_of);
    expect(first.sources.map((s) => s.source)).toContain("whatsapp");
  });

  it("holds the warm back while the log is still moving", async () => {
    const db = getDb();
    const ins = db.prepare(
      `INSERT INTO events (id, source_type, ts, kind, text) VALUES (?, 'whatsapp', ?, 'wa.message', 'x')`,
    );
    let n = 0;
    const writer = setInterval(() => ins.run(`w${n++}`, new Date().toISOString()), 3);

    const lines: string[] = [];
    const handle = startLibraryMaintenance({
      log: (l) => lines.push(l),
      sweepMs: 5,
      warmQuietMs: 60_000,
      warmDeadlineMs: 60_000,
      checkpointQuietMs: 60_000,
    });
    try {
      await new Promise((r) => setTimeout(r, 60));
    } finally {
      handle.stop();
      clearInterval(writer);
    }
    expect(n).toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes("storage snapshot warmed"))).toHaveLength(0);
  });
});
