// ===========================================================================
// History SQLite readers (build P0.8; spec §4.2 source 3).
//
// Chrome and Arc share the Chromium `History` schema (urls + visits tables,
// WebKit epoch µs since 1601). Safari uses `History.db` (history_items +
// history_visits, Core Data epoch s since 2001).
//
// COPY-THEN-READ: the browsers hold these files open (and locked, WAL side
// files included). We never open the live file — each read copies the DB (and
// its -wal/-shm if present) into a scratch dir, opens the COPY readonly, reads,
// closes, deletes. A locked or mid-write source at worst costs us one poll.
// ===========================================================================

import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import type { BrowserId } from "./envelope.js";

// ---- Normalised visit (source-neutral) ------------------------------------

export interface RawVisit {
  /** Visit row id within the source DB — referrer links point at these. */
  visitId: number;
  url: string;
  title: string;
  /** Visit time, unix ms. */
  tsMs: number;
  /** Normalised transition (see envelope.BrowserVisitPayload.transition). */
  transition: string;
  /** True when the low bits said "typed" (address bar) — Cat-1 signal. */
  typed: boolean;
  /** True when the transition carried a redirect qualifier. */
  redirect: boolean;
  /** Visit id of the referring visit in the SAME read, 0 = none. */
  referrerVisitId: number;
  /** All-time visit count of the URL as the browser tracks it. */
  visitCount: number;
  /** Dwell, ms (Chrome visit_duration µs / 1000; Safari 0 = unknown). */
  dwellMs: number;
  browser: BrowserId;
}

// ---- Copy-then-read -------------------------------------------------------

let scratchOverride: string | null = null;

/** Tests point the scratch dir somewhere disposable. */
export function setHistoryScratchDir(dir: string | null): void {
  scratchOverride = dir;
}

function scratchDir(): string {
  const dir = scratchOverride ?? join(tmpdir(), "supertwinv13-history");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Where the copies land — disclosed on the connect card (V6 P1 S1.4 "local-
 * path disclosure"): the user sees which files are read and where the
 * short-lived copy goes. Never opens or creates anything beyond the dir.
 */
export function historyScratchDir(): string {
  return scratchOverride ?? join(tmpdir(), "supertwinv13-history");
}

/** True for the errno codes macOS raises when Full Disk Access is missing. */
export function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

/**
 * Copy `path` (+ WAL side files) into scratch and run `fn` on a readonly
 * handle of the copy. The copy is deleted before returning, success or not.
 */
export function withHistoryCopy<T>(path: string, fn: (db: Database.Database) => T): T {
  const stem = join(scratchDir(), `h-${randomBytes(6).toString("hex")}`);
  const copy = `${stem}.db`;
  copyFileSync(path, copy);
  for (const ext of ["-wal", "-shm"]) {
    if (existsSync(path + ext)) {
      try {
        copyFileSync(path + ext, copy + ext.replace("-", "."));
      } catch {
        // Best effort — a torn WAL copy just means we read the last checkpoint.
      }
    }
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(copy, { readonly: true });
    return fn(db);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
    for (const f of [copy, `${copy}.wal`, `${copy}.shm`]) {
      try {
        rmSync(f, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

// ---- Epoch conversions ----------------------------------------------------

/** WebKit epoch (µs since 1601-01-01) → unix ms. */
export function chromeTimeToUnixMs(us: number): number {
  return Math.round(us / 1000) - 11644473600000;
}

export function unixMsToChromeTime(ms: number): number {
  return (ms + 11644473600000) * 1000;
}

/** Core Data epoch (s since 2001-01-01) → unix ms. */
export function safariTimeToUnixMs(s: number): number {
  return Math.round((s + 978307200) * 1000);
}

export function unixMsToSafariTime(ms: number): number {
  return ms / 1000 - 978307200;
}

// ---- Chromium transitions -------------------------------------------------

const CORE_TRANSITION: Record<number, string> = {
  0: "link",
  1: "typed",
  2: "bookmark", // AUTO_BOOKMARK
  3: "auto_subframe",
  4: "manual_subframe",
  5: "generated",
  6: "start_page",
  7: "form_submit",
  8: "reload",
  9: "keyword",
  10: "keyword_generated",
};

const CLIENT_REDIRECT = 0x40000000;
const SERVER_REDIRECT = 0x80000000;

export function decodeChromeTransition(t: number): { transition: string; typed: boolean; redirect: boolean } {
  const u = t >>> 0;
  const core = u & 0xff;
  const redirect = (u & (CLIENT_REDIRECT | SERVER_REDIRECT)) !== 0;
  const name = redirect ? "redirect" : (CORE_TRANSITION[core] ?? "other");
  return { transition: name, typed: core === 1, redirect };
}

// ---- Readers --------------------------------------------------------------

/**
 * Read Chromium-format history (Chrome, Arc) newer than `sinceMs`. Returns
 * visits ascending by time. Throws only on I/O/schema errors — callers guard.
 */
export function readChromiumHistory(path: string, sinceMs: number, browser: BrowserId): RawVisit[] {
  return withHistoryCopy(path, (db) => {
    const rows = db
      .prepare(
        `SELECT v.id AS visit_id, v.visit_time, v.from_visit, v.transition,
                COALESCE(v.visit_duration, 0) AS visit_duration,
                u.url, COALESCE(u.title,'') AS title, COALESCE(u.visit_count,0) AS visit_count
           FROM visits v JOIN urls u ON u.id = v.url
          WHERE v.visit_time > ?
          ORDER BY v.visit_time ASC`,
      )
      .all(unixMsToChromeTime(sinceMs)) as Array<{
      visit_id: number;
      visit_time: number;
      from_visit: number;
      transition: number;
      visit_duration: number;
      url: string;
      title: string;
      visit_count: number;
    }>;
    return rows.map((r) => {
      const { transition, typed, redirect } = decodeChromeTransition(r.transition);
      return {
        visitId: r.visit_id,
        url: r.url,
        title: r.title,
        tsMs: chromeTimeToUnixMs(r.visit_time),
        transition,
        typed,
        redirect,
        referrerVisitId: r.from_visit ?? 0,
        visitCount: r.visit_count,
        dwellMs: Math.round(r.visit_duration / 1000),
        browser,
      };
    });
  });
}

/**
 * Read Safari History.db newer than `sinceMs`, ascending. Safari has no
 * transition enum: `redirect_source` marks redirect hops, everything else is
 * "link". Dwell is unknown at the DB level (0) — the chain layer infers it
 * from inter-visit gaps.
 */
export function readSafariHistory(path: string, sinceMs: number): RawVisit[] {
  return withHistoryCopy(path, (db) => {
    const rows = db
      .prepare(
        `SELECT v.id AS visit_id, v.visit_time, COALESCE(v.title,'') AS title,
                COALESCE(v.redirect_source, 0) AS redirect_source,
                i.url, COALESCE(i.visit_count,0) AS visit_count
           FROM history_visits v JOIN history_items i ON i.id = v.history_item
          WHERE v.visit_time > ?
          ORDER BY v.visit_time ASC`,
      )
      .all(unixMsToSafariTime(sinceMs)) as Array<{
      visit_id: number;
      visit_time: number;
      title: string;
      redirect_source: number;
      url: string;
      visit_count: number;
    }>;
    return rows.map((r) => ({
      visitId: r.visit_id,
      url: r.url,
      title: r.title,
      tsMs: safariTimeToUnixMs(r.visit_time),
      transition: r.redirect_source ? "redirect" : "link",
      typed: false,
      redirect: r.redirect_source !== 0,
      referrerVisitId: r.redirect_source ?? 0,
      visitCount: r.visit_count,
      dwellMs: 0,
      browser: "safari" as const,
    }));
  });
}
