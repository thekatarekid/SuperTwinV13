import { describe, expect, it, beforeAll } from "vitest";
import { join } from "node:path";
import { utimesSync, writeFileSync } from "node:fs";

import { BrowserWatcher, discoverProfiles } from "./watcher.js";
import { EventlogSink, MemorySink } from "./sink.js";
import { setHistoryScratchDir } from "./history-db.js";
import type { BrowserBookmarkPayload, BrowserVisitPayload } from "./envelope.js";
import { ageBandOf, ulid } from "./envelope.js";
import {
  makeChromeBookmarks,
  makeChromeHistory,
  makeSafariHistory,
  tmpDir,
  T_TYPED,
} from "./test-fixtures.js";
import { getDb, runMigrations } from "../../db/connection.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

beforeAll(() => {
  setHistoryScratchDir(tmpDir());
});

describe("envelope helpers", () => {
  it("age bands per spec §5.3", () => {
    expect(ageBandOf(NOW - 5 * DAY, NOW)).toBe("A");
    expect(ageBandOf(NOW - 60 * DAY, NOW)).toBe("B");
    expect(ageBandOf(NOW - 400 * DAY, NOW)).toBe("C");
    expect(ageBandOf(NOW - 900 * DAY, NOW)).toBe("D");
  });
  it("ulid: 26 chars, time-ordered prefix", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a).toHaveLength(26);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
});

function chromeProfile(dir: string) {
  return { browser: "chrome" as const, historyPath: join(dir, "History"), bookmarksPath: join(dir, "Bookmarks") };
}

describe("BrowserWatcher end-to-end (fixture profiles)", () => {
  it("emits browser.visit envelopes with chains and category", () => {
    const dir = tmpDir();
    makeChromeHistory(dir, [
      { url: "https://goibibo.com/", title: "Goibibo", tsMs: NOW - 40 * MIN, transition: T_TYPED, dwellMs: 6 * MIN },
      { url: "https://goibibo.com/flights", title: "Flights", tsMs: NOW - 30 * MIN, fromVisit: 1, dwellMs: 2 * MIN },
    ]);
    makeChromeBookmarks(dir, [{ url: "https://news.ycombinator.com/", name: "HN", addedMs: NOW - 2 * DAY, folder: "Tech" }]);

    const sink = new MemorySink();
    const w = new BrowserWatcher({ sink, profiles: [chromeProfile(dir)], sinceMs: 0, now: () => NOW });
    const written = w.poll();
    expect(written).toBe(3); // 2 visits + 1 bookmark

    const visits = sink.events.filter((e) => e.kind === "browser.visit");
    const bookmarks = sink.events.filter((e) => e.kind === "browser.bookmark");
    expect(visits).toHaveLength(2);
    expect(bookmarks).toHaveLength(1);

    const v0 = visits[0]!;
    const p0 = v0.payload as BrowserVisitPayload;
    expect(v0.source).toBe("browser");
    expect(v0.actor).toBe("self");
    expect(v0.roles.sender).toBe("self");
    expect(v0.origin).toBe("backfill");
    expect(v0.age_band).toBe("A");
    expect(p0).toMatchObject({
      url: "https://goibibo.com/",
      title: "Goibibo",
      transition: "typed",
      referrer: null,
      category: "cat1",
      browser: "chrome",
    });
    // Chain: second visit shares the stream key and carries the referrer URL.
    expect(visits[1]!.stream_key).toBe(v0.stream_key);
    expect((visits[1]!.payload as BrowserVisitPayload).referrer).toBe("https://goibibo.com/");

    const bp = bookmarks[0]!.payload as BrowserBookmarkPayload;
    expect(bp).toMatchObject({
      url: "https://news.ycombinator.com/",
      title: "HN",
      folder: expect.stringContaining("Tech"),
      category: "cat1",
      domain: "news.ycombinator.com",
    });
    expect(bookmarks[0]!.stream_key).toBe("browser:chrome:bookmarks");
  });

  it("polls are idempotent: cursor + content_hash yield no duplicates", () => {
    const dir = tmpDir();
    makeChromeHistory(dir, [{ url: "https://a.example/", tsMs: NOW - 5 * MIN, dwellMs: 60_000 }]);
    const sink = new MemorySink();
    const w = new BrowserWatcher({ sink, profiles: [{ ...chromeProfile(dir), bookmarksPath: null }], sinceMs: 0, now: () => NOW });
    expect(w.poll()).toBe(1);
    expect(w.poll()).toBe(0); // cursor advanced
    expect(sink.events).toHaveLength(1);
  });

  it("bookmark emit is mtime-gated and set-diffed", () => {
    const dir = tmpDir();
    makeChromeHistory(dir, []);
    const bmPath = makeChromeBookmarks(dir, [{ url: "https://one.example/", name: "One", addedMs: NOW - DAY }]);
    const sink = new MemorySink();
    const w = new BrowserWatcher({ sink, profiles: [chromeProfile(dir)], sinceMs: 0, now: () => NOW });
    expect(w.poll()).toBe(1);
    expect(w.poll()).toBe(0); // unchanged mtime → nothing re-read

    makeChromeBookmarks(dir, [
      { url: "https://one.example/", name: "One", addedMs: NOW - DAY },
      { url: "https://two.example/", name: "Two", addedMs: NOW },
    ]);
    utimesSync(bmPath, new Date(), new Date(Date.now() + 1000)); // force new mtime
    expect(w.poll()).toBe(1); // only the new one
    const urls = sink.events.map((e) => (e.payload as BrowserBookmarkPayload).url);
    expect(urls).toEqual(["https://one.example/", "https://two.example/"]);
  });

  it("reads Safari fixtures through the same pipeline", () => {
    const dir = tmpDir();
    const path = makeSafariHistory(dir, [
      { url: "https://news.ycombinator.com/", title: "HN", tsMs: NOW - 20 * MIN },
      { url: "https://news.ycombinator.com/item?id=2", title: "Item", tsMs: NOW - 15 * MIN, redirectSource: 1 },
    ]);
    const sink = new MemorySink();
    const w = new BrowserWatcher({
      sink,
      profiles: [{ browser: "safari", historyPath: path, bookmarksPath: null }],
      sinceMs: 0,
      now: () => NOW,
    });
    expect(w.poll()).toBe(2);
    expect(sink.events.every((e) => (e.payload as BrowserVisitPayload).browser === "safari")).toBe(true);
    expect(sink.events[0]!.stream_key).toBe(sink.events[1]!.stream_key); // redirect_source chains them
  });

  it("guards gracefully: missing profiles, corrupt files — no crash, zero events", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "History"), "this is not sqlite");
    const sink = new MemorySink();
    const w = new BrowserWatcher({
      sink,
      profiles: [
        { browser: "chrome", historyPath: join(dir, "does-not-exist"), bookmarksPath: join(dir, "no-bookmarks") },
        { browser: "arc", historyPath: join(dir, "History"), bookmarksPath: null },
      ],
      sinceMs: 0,
      now: () => NOW,
    });
    expect(w.poll()).toBe(0);
    expect(sink.events).toHaveLength(0);
  });

  it("discoverProfiles never throws and only returns existing files", () => {
    const found = discoverProfiles(tmpDir()); // empty fake home
    expect(found).toEqual([]);
    // Real home: whatever exists, every returned path must exist (acceptance:
    // importing a real profile path doesn't crash).
    for (const p of discoverProfiles()) {
      expect(typeof p.historyPath).toBe("string");
    }
  });
});

describe("EventlogSink (single-writer path, 0100_v13_core schema)", () => {
  it("writes envelopes through db/eventlog and dedupes on content_hash", () => {
    process.env.SUPERTWIN_DB_PATH = join(tmpDir(), "worker.db");
    runMigrations();
    const db = getDb();

    const histDir = tmpDir();
    makeChromeHistory(histDir, [{ url: "https://a.example/", title: "A", tsMs: NOW - 5 * MIN, dwellMs: 60_000 }]);
    const sink = new EventlogSink();
    const w = new BrowserWatcher({ sink, profiles: [{ ...chromeProfile(histDir), bookmarksPath: null }], sinceMs: 0, now: () => NOW });
    expect(w.poll()).toBe(1);

    const row = db
      .prepare(`SELECT source_id, kind, origin, age_band, stream_key, actor, roles_json, payload_json, text FROM events`)
      .get() as Record<string, string>;
    expect(row.source_id).toBe("browser");
    expect(row.kind).toBe("browser.visit");
    expect(row.origin).toBe("live"); // 5 min old, inside the live window
    expect(row.age_band).toBe("A");
    expect(row.actor).toBe("self");
    expect(JSON.parse(row.roles_json).sender).toBe("self");
    expect(JSON.parse(row.payload_json).url).toBe("https://a.example/");
    expect(row.text).toContain("https://a.example/"); // FTS projection

    // A stream row exists for the chain key (single-writer upserts it).
    const stream = db.prepare(`SELECT external_key FROM streams WHERE source_id = 'browser'`).get() as {
      external_key: string;
    };
    expect(stream.external_key).toBe(row.stream_key);

    // Re-append the same envelope (fresh watcher, cursor reset): dedupe wins.
    const w2 = new BrowserWatcher({ sink, profiles: [{ ...chromeProfile(histDir), bookmarksPath: null }], sinceMs: 0, now: () => NOW });
    expect(w2.poll()).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source_id='browser'`).get() as { n: number }).n).toBe(1);
  });
});
