// ===========================================================================
// 0200_v6_core tests (vitest) — V6 P1 S1.1 (Build §4.1).
//
//   1. migrate up on an EMPTY db; re-running is a no-op; every V6 table
//      exists; the envelope gained consent_id + tier; the dropped consent-
//      shaped columns stay gone; the V2 progress meter moved to
//      `coverage_progress`.
//   2. round-trip each table through db/v6core.ts — consents (one live row per
//      source, CNS-03's Understand ≤ Index rejection, the capture gate),
//      archive (zlib text + raw payload, idempotent by hash, cascades with the
//      event), explicit episode membership (range readers still see it),
//      bundle attempts (3 → dead letter, never auto-retried), blobs
//      (content-addressed, second put stores nothing), coverage (upsert,
//      floor), and the envelope's consentId / tier / origin='archive'.
//
// Zero model calls: pure SQLite on a temp file.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { episodeEvents } from "../../brain/thin-pack.js";
import { closeDb, getDb, runMigrations, runMigrationsOn } from "../connection.js";
import { appendEvent, readEnvelope, type EventEnvelope } from "../eventlog.js";
import { MIGRATIONS } from "../schema.js";
import {
  addEpisodeEvents,
  archiveCount,
  blobAddress,
  blobStats,
  bundleKey,
  captureAllowed,
  clearBundleAttempts,
  ConsentWindowError,
  coverageFloor,
  coverageFor,
  episodeMemberIds,
  getBlob,
  getBlobText,
  getBundleAttempt,
  getConsent,
  grantConsent,
  hasBlob,
  isDeadLettered,
  listConsents,
  listDeadLetters,
  MAX_BUNDLE_ATTEMPTS,
  noteBundleAttempt,
  putBlob,
  readArchive,
  readArchiveByEvent,
  revokeConsent,
  setConsentState,
  setConsentWindows,
  understandFloor,
  upsertCoverage,
  writeArchive,
} from "../v6core.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-0200-"));
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

function tables(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
}

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    ts: "2026-08-25T14:12:10.000Z",
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "9198xx-1602@g.us",
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: "lock goa 18-21 dec" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Migrate up on empty
// ---------------------------------------------------------------------------

describe("0200_v6_core — migrate up on empty", () => {
  it("is registered after 0108 and applies clean on a fresh file; a second run is a no-op", () => {
    // 0201_v6_graph (S2.1) follows it; the pin is on order, not on being last.
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids.indexOf("0200_v6_core")).toBe(ids.indexOf("0108_prune_sources") + 1);
    const fresh = new Database(join(tmpDir, "fresh.db"));
    fresh.pragma("foreign_keys = ON");
    runMigrationsOn(fresh);
    const applied = () =>
      (fresh.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as { id: string }[]).map(
        (r) => r.id,
      );
    const first = applied();
    expect(first).toContain("0200_v6_core");
    runMigrationsOn(fresh);
    expect(applied()).toEqual(first);
    fresh.close();
  });

  it("creates every V6 table and moves the V2 meter to coverage_progress", () => {
    const t = tables(getDb());
    for (const name of ["consents", "archive", "episode_events", "bundle_attempts", "blobs", "coverage", "coverage_progress"]) {
      expect(t.has(name), name).toBe(true);
    }
    expect(columns(getDb(), "coverage")).toEqual(
      expect.arrayContaining(["source", "range_start", "range_end", "status", "events", "note", "updated_at"]),
    );
    expect(columns(getDb(), "coverage_progress")).toEqual(
      expect.arrayContaining(["scope_kind", "scope_id", "horizon", "total_units", "done_units"]),
    );
    expect(columns(getDb(), "consents")).toEqual(
      expect.arrayContaining([
        "source", "state", "granted_at", "granted_build", "scope_json", "index_all", "index_from",
        "understand_from", "decision_id", "revoked_at",
      ]),
    );
    expect(columns(getDb(), "bundle_attempts")).toEqual(
      expect.arrayContaining(["attempts", "last_attempt_at", "dead_letter_at"]),
    );
  });

  it("grows the envelope (consent_id, tier, roles) and keeps the dropped columns gone", () => {
    const ev = columns(getDb(), "events");
    expect(ev).toContain("consent_id");
    expect(ev).toContain("tier");
    expect(ev).toContain("roles_json");
    expect(ev).not.toContain("content_pending");
    const src = columns(getDb(), "sources");
    expect(src).not.toContain("connected_at");
    expect(src).not.toContain("enabled");
    expect(columns(getDb(), "episode_events")).toContain("event_id");
  });
});

// ---------------------------------------------------------------------------
// 2. Round-trips
// ---------------------------------------------------------------------------

describe("consents", () => {
  it("grants, reads back, and keeps ONE live row per source", () => {
    const a = grantConsent({ source: "wa", scope: { chats: "all" }, understandFrom: "2026-07-26T00:00:00.000Z" });
    expect(a.state).toBe("connected");
    expect(a.indexAll).toBe(true);
    expect(a.scope).toEqual({ chats: "all" });
    expect(a.grantedBuild).toBeTruthy();
    expect(getConsent("wa")?.id).toBe(a.id);
    expect(understandFloor("wa")).toBe("2026-07-26T00:00:00.000Z");

    const b = grantConsent({ source: "wa" });
    expect(getConsent("wa")?.id).toBe(b.id);
    const all = listConsents({ includeRevoked: true }).filter((c) => c.source === "wa");
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.id === a.id)?.revokedAt).toBeTruthy();
    expect(listConsents()).toHaveLength(1);
  });

  it("rejects Understand wider than Index (CNS-03) and writes nothing", () => {
    expect(() =>
      grantConsent({
        source: "browser",
        indexFrom: "2026-07-27T00:00:00.000Z",
        understandFrom: "2026-05-28T00:00:00.000Z",
      }),
    ).toThrow(ConsentWindowError);
    expect(getConsent("browser")).toBeNull();

    grantConsent({ source: "browser", indexFrom: "2026-07-27T00:00:00.000Z", understandFrom: "2026-08-19T00:00:00.000Z" });
    expect(() => setConsentWindows("browser", { understandFrom: "2026-05-28T00:00:00.000Z" })).toThrow(
      ConsentWindowError,
    );
    expect(getConsent("browser")?.understandFrom).toBe("2026-08-19T00:00:00.000Z");
    // Widening Index first makes the same Understand legal.
    setConsentWindows("browser", { indexAll: true });
    const widened = setConsentWindows("browser", { understandFrom: "2026-05-28T00:00:00.000Z" });
    expect(widened?.understandFrom).toBe("2026-05-28T00:00:00.000Z");
  });

  it("captureAllowed is true only for a live 'connected' row", () => {
    expect(captureAllowed("screen")).toBe(false);
    grantConsent({ source: "screen" });
    expect(captureAllowed("screen")).toBe(true);
    setConsentState("screen", "paused");
    expect(captureAllowed("screen")).toBe(false);
    setConsentState("screen", "connected");
    expect(captureAllowed("screen")).toBe(true);
    expect(revokeConsent("screen")).toBe(true);
    expect(captureAllowed("screen")).toBe(false);
    expect(getConsent("screen")).toBeNull();
    expect(revokeConsent("screen")).toBe(false);
  });
});

describe("archive", () => {
  it("round-trips zlib text and the raw payload, idempotent by content_hash", () => {
    const text = "the villa with the pool — 6 beds, ".repeat(40);
    const payload = { text, url: "https://example.com/villa?utm_source=x", raw: { a: 1 } };
    const w = writeArchive({ source: "browser", streamKey: "example.com/2026-08-25", ts: "2026-08-25T10:00:00.000Z", kind: "browser.visit", contentHash: "h1", text, payload, tier: 1 });
    expect(w.inserted).toBe(true);
    const again = writeArchive({ source: "browser", ts: "2026-08-25T10:00:00.000Z", contentHash: "h1", text, payload });
    expect(again).toEqual({ id: w.id, inserted: false });
    expect(archiveCount()).toBe(1);
    expect(archiveCount("browser")).toBe(1);
    expect(archiveCount("wa")).toBe(0);

    const back = readArchive(w.id)!;
    expect(back.text).toBe(text);
    expect(back.textLen).toBe(text.length);
    expect(back.payload).toEqual(payload);
    expect(back.tier).toBe(1);
    expect(back.streamKey).toBe("example.com/2026-08-25");
    // Narrow: the stored text is smaller than the text it holds.
    const raw = getDb().prepare(`SELECT length(text_z) AS n FROM archive WHERE id = ?`).get(w.id) as { n: number };
    expect(raw.n).toBeLessThan(text.length / 4);
  });

  it("cascades with the event it mirrors", () => {
    // S1.2: the funnel writes the archive row itself, in the append transaction.
    const { id } = appendEvent(envelope());
    expect(readArchiveByEvent(id)?.text).toBe("lock goa 18-21 dec");
    getDb().prepare(`DELETE FROM events WHERE id = ?`).run(id);
    expect(readArchiveByEvent(id)).toBeNull();
    expect(archiveCount()).toBe(0);
  });
});

describe("episode_events — explicit membership", () => {
  it("adds explicit members that both the exact and the range readers see", () => {
    const ids = [1, 2, 3].map((i) => appendEvent(envelope({ payload: { text: `m${i}` } })).id);
    const db = getDb();
    db.prepare(`INSERT INTO episodes (id, stream_id, state, summary) VALUES ('ep1', 'wa:st:9198xx-1602@g.us', 'open', 'goa')`).run();
    expect(addEpisodeEvents("ep1", [ids[0], ids[2], "missing"], "test")).toBe(2);
    expect(addEpisodeEvents("ep1", [ids[0]])).toBe(0); // idempotent
    expect(episodeMemberIds("ep1")).toEqual([ids[0], ids[2]]);
    // 0101 range readers: a member is a range of one.
    expect(episodeEvents("ep1", "wa:st:9198xx-1602@g.us").map((e) => e.id)).toEqual([ids[0], ids[2]]);
    // Cascade: deleting a member event removes its membership row.
    db.prepare(`DELETE FROM events WHERE id = ?`).run(ids[0]);
    expect(episodeMemberIds("ep1")).toEqual([ids[2]]);
  });
});

describe("bundle_attempts", () => {
  const ref = { streamId: "wa:st:x", minRowid: 10, maxRowid: 42 };

  it("dead-letters on the 3rd attempt and stops counting after", () => {
    expect(bundleKey(ref)).toBe("wa:st:x:10-42");
    expect(getBundleAttempt(ref)).toBeNull();
    expect(noteBundleAttempt(ref, { error: "timeout" }).attempts).toBe(1);
    expect(isDeadLettered(ref)).toBe(false);
    noteBundleAttempt(ref, { error: "timeout" });
    const third = noteBundleAttempt(ref, { error: "parse" });
    expect(third.attempts).toBe(MAX_BUNDLE_ATTEMPTS);
    expect(third.deadLetterAt).toBeTruthy();
    expect(third.lastError).toBe("parse");
    expect(isDeadLettered(ref)).toBe(true);
    const fourth = noteBundleAttempt(ref, { error: "again" });
    expect(fourth.attempts).toBe(3);
    expect(fourth.lastError).toBe("parse");
    expect(listDeadLetters().map((r) => r.bundleKey)).toEqual(["wa:st:x:10-42"]);
    expect(clearBundleAttempts(ref)).toBe(true);
    expect(getBundleAttempt(ref)).toBeNull();
  });
});

describe("blobs", () => {
  it("stores by content address once and bumps refs on repeats", () => {
    const text = "Heartbeat: the same 22 KB of screen text ".repeat(500);
    const a = putBlob(text);
    expect(a.sha256).toBe(blobAddress(text));
    expect(a.size).toBe(Buffer.byteLength(text));
    expect(a.inserted).toBe(true);
    const b = putBlob(text);
    expect(b.inserted).toBe(false);
    expect(blobStats()).toEqual({ count: 1, rawBytes: Buffer.byteLength(text), refs: 2 });
    expect(hasBlob(a.sha256)).toBe(true);
    expect(getBlobText(a.sha256)).toBe(text);
    expect(getBlob("00".repeat(32))).toBeNull();
    const bin = putBlob(Buffer.from([0, 1, 2, 255]), "bin");
    expect(getBlob(bin.sha256)).toEqual(Buffer.from([0, 1, 2, 255]));
  });
});

describe("coverage — source × date range × status", () => {
  it("upserts, replaces in place, and reports the floor", () => {
    expect(coverageFloor("wa")).toBeNull();
    upsertCoverage({ source: "wa", rangeStart: "2024-01-01", rangeEnd: "2024-01-31", status: "captured", events: 120 });
    upsertCoverage({ source: "wa", rangeStart: "2023-01-01", rangeEnd: "2023-12-31", status: "missing", note: "history plateau" });
    upsertCoverage({ source: "wa", rangeStart: "2024-01-01", rangeEnd: "2024-01-31", status: "understood", events: 121 });
    const rows = coverageFor("wa");
    expect(rows.map((r) => [r.rangeStart, r.status, r.events])).toEqual([
      ["2023-01-01", "missing", 0],
      ["2024-01-01", "understood", 121],
    ]);
    expect(rows[0].note).toBe("history plateau");
    expect(coverageFloor("wa")).toBe("2024-01-01");
    expect(coverageFor("browser")).toEqual([]);
    expect(() => upsertCoverage({ source: "wa", rangeStart: "2024-02-01", rangeEnd: "2024-01-01", status: "captured" })).toThrow(/precedes/);
    expect(() => upsertCoverage({ source: "wa", rangeStart: "yesterday", rangeEnd: "2024-01-01", status: "captured" })).toThrow(/YYYY-MM-DD/);
  });

  it("leaves the V2 meter reachable under coverage_progress", () => {
    getDb()
      .prepare(`INSERT INTO coverage_progress (scope_kind, scope_id, horizon, total_units, done_units) VALUES ('global','all','d30',10,3)`)
      .run();
    const r = getDb().prepare(`SELECT done_units AS d FROM coverage_progress`).get() as { d: number };
    expect(r.d).toBe(3);
  });
});

describe("envelope — consent_id, tier, origin='archive'", () => {
  it("round-trips through appendEvent / readEnvelope", () => {
    const cns = grantConsent({ source: "wa" });
    const { id } = appendEvent(envelope({ origin: "archive", consentId: cns.id, tier: 3 }));
    const back = readEnvelope(id)!;
    expect(back.origin).toBe("archive");
    expect(back.consentId).toBe(cns.id);
    expect(back.tier).toBe(3);
    const plain = readEnvelope(appendEvent(envelope({ payload: { text: "other" } })).id)!;
    expect(plain.consentId).toBeNull();
    expect(plain.tier).toBeNull();
  });
});
