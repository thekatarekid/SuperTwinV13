// ===========================================================================
// TEST-ONLY fixture builders for the browser watcher suite (imported by the
// *.test.ts files in this directory; never by production code).
//
// Builds real SQLite files in the Chromium `History` and Safari `History.db`
// shapes, plus Chromium `Bookmarks` JSON — the same schemas the readers hit
// on a real profile.
// ===========================================================================

import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unixMsToChromeTime, unixMsToSafariTime } from "./history-db.js";

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "stv13-browser-"));
}

// ---- Chromium History fixture ---------------------------------------------

export interface ChromeVisitFixture {
  url: string;
  title?: string;
  tsMs: number;
  /** Raw Chromium transition value (core | qualifiers). */
  transition?: number;
  fromVisit?: number;
  /** Dwell in ms (stored as visit_duration µs). */
  dwellMs?: number;
}

export const T_LINK = 0;
export const T_TYPED = 1;
export const T_RELOAD = 8;
export const Q_SERVER_REDIRECT = 0x80000000;

/**
 * Write a Chromium-shaped History DB. Returns the path and the assigned visit
 * row ids (1-based, in input order) so tests can wire fromVisit references.
 */
export function makeChromeHistory(dir: string, visits: ChromeVisitFixture[]): string {
  const path = join(dir, "History");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE urls (
      id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT,
      visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0,
      last_visit_time INTEGER, hidden INTEGER DEFAULT 0
    );
    CREATE TABLE visits (
      id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL,
      from_visit INTEGER, transition INTEGER DEFAULT 0,
      segment_id INTEGER, visit_duration INTEGER DEFAULT 0
    );
  `);
  const urlIds = new Map<string, number>();
  const insUrl = db.prepare(`INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?,?,?,?)`);
  const bumpUrl = db.prepare(`UPDATE urls SET visit_count = visit_count + 1, last_visit_time = ? WHERE id = ?`);
  const insVisit = db.prepare(
    `INSERT INTO visits (url, visit_time, from_visit, transition, visit_duration) VALUES (?,?,?,?,?)`,
  );
  for (const v of visits) {
    let urlId = urlIds.get(v.url);
    const t = unixMsToChromeTime(v.tsMs);
    if (!urlId) {
      urlId = Number(insUrl.run(v.url, v.title ?? "", 1, t).lastInsertRowid);
      urlIds.set(v.url, urlId);
    } else {
      bumpUrl.run(t, urlId);
    }
    insVisit.run(urlId, t, v.fromVisit ?? 0, (v.transition ?? T_LINK) | 0, (v.dwellMs ?? 0) * 1000);
  }
  db.close();
  return path;
}

// ---- Safari History fixture -----------------------------------------------

export interface SafariVisitFixture {
  url: string;
  title?: string;
  tsMs: number;
  redirectSource?: number;
}

export function makeSafariHistory(dir: string, visits: SafariVisitFixture[]): string {
  const path = join(dir, "History.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE history_items (
      id INTEGER PRIMARY KEY, url TEXT NOT NULL, visit_count INTEGER DEFAULT 0
    );
    CREATE TABLE history_visits (
      id INTEGER PRIMARY KEY, history_item INTEGER NOT NULL, visit_time REAL NOT NULL,
      title TEXT, redirect_source INTEGER
    );
  `);
  const itemIds = new Map<string, number>();
  const insItem = db.prepare(`INSERT INTO history_items (url, visit_count) VALUES (?,1)`);
  const bump = db.prepare(`UPDATE history_items SET visit_count = visit_count + 1 WHERE id = ?`);
  const insVisit = db.prepare(
    `INSERT INTO history_visits (history_item, visit_time, title, redirect_source) VALUES (?,?,?,?)`,
  );
  for (const v of visits) {
    let id = itemIds.get(v.url);
    if (!id) {
      id = Number(insItem.run(v.url).lastInsertRowid);
      itemIds.set(v.url, id);
    } else {
      bump.run(id);
    }
    insVisit.run(id, unixMsToSafariTime(v.tsMs), v.title ?? "", v.redirectSource ?? null);
  }
  db.close();
  return path;
}

// ---- Chromium Bookmarks fixture -------------------------------------------

export function makeChromeBookmarks(
  dir: string,
  bookmarks: Array<{ url: string; name: string; addedMs?: number; folder?: string }>,
): string {
  const path = join(dir, "Bookmarks");
  const byFolder = new Map<string, typeof bookmarks>();
  for (const b of bookmarks) {
    const f = b.folder ?? "";
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f)!.push(b);
  }
  const children: unknown[] = [];
  for (const [folder, items] of byFolder) {
    const urls = items.map((b) => ({
      type: "url",
      url: b.url,
      name: b.name,
      date_added: b.addedMs ? String((b.addedMs + 11644473600000) * 1000) : "0",
    }));
    if (folder === "") children.push(...urls);
    else children.push({ type: "folder", name: folder, children: urls });
  }
  const doc = {
    version: 1,
    roots: {
      bookmark_bar: { type: "folder", name: "Bookmarks Bar", children },
      other: { type: "folder", name: "Other Bookmarks", children: [] },
      synced: { type: "folder", name: "Mobile Bookmarks", children: [] },
    },
  };
  writeFileSync(path, JSON.stringify(doc));
  return path;
}
