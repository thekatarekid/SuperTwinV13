// ===========================================================================
// Browser connect — counts before consent (V6 P1 S1.4; Build §4.2; Product
// §3.3 "After connecting, count what exists. Counts are real.").
//
// The connect card has to show REAL numbers per window before the user says
// yes, and it must do so without reading anything into the log. So this
// module does exactly one copy-then-read per profile (history-db.withHistoryCopy:
// copy, open the copy readonly, count, delete) and returns:
//
//   * visits and bookmarks per import window (adapters/types RANGES);
//   * oldest / newest visit — the honest "how far back this browser goes";
//   * the PLATEAU: Chromium expires history at 90 days, Safari at one year by
//     default, so every window past the retention edge shows the same count.
//     The card says why ("Chrome keeps 90 days") instead of letting the user
//     wonder why "3 years" equals "90 days";
//   * the Full Disk Access message when macOS refuses the copy (Safari's
//     History.db is protected; Chromium's is not) — with the deep link;
//   * the LOCAL-PATH DISCLOSURE: which files are read and where the short-
//     lived copy goes, so "copy-then-read" is a fact the user can check.
//
// Zero model calls, zero writes to the event log. Never throws — a broken or
// locked profile is reported as unreadable with its reason.
// ===========================================================================

import { existsSync } from "node:fs";

import { RANGES, type Range } from "../types.js";
import { rangeCutoffMs } from "../source-adapter.js";
import { BROWSER_NAMES, type BrowserId } from "./envelope.js";
import {
  historyScratchDir,
  isPermissionError,
  unixMsToChromeTime,
  unixMsToSafariTime,
  withHistoryCopy,
} from "./history-db.js";
import { readChromiumBookmarks } from "./bookmarks.js";
import type { BrowserProfile } from "./watcher.js";

/** Windows the card offers. `RANGES` minus the sub-day one nobody imports by. */
export const COUNT_WINDOWS: readonly Range[] = RANGES.filter((r) => r !== "24h");

/** Retention the browser enforces on its own history file, in days. */
export const RETENTION_DAYS: Record<BrowserId, number> = {
  chrome: 90,
  brave: 90,
  arc: 90,
  edge: 90,
  comet: 90,
  safari: 365,
};

/** Full Disk Access pane — served from here so the UI never hardcodes an OS URL. */
export const FULL_DISK_ACCESS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

export type ProfileReadError = "full-disk-access" | "locked" | "missing" | "unreadable";

export interface WindowCount {
  visits: number;
  bookmarks: number;
}

export interface ProfileCounts {
  browser: BrowserId;
  browser_name: string;
  profile: string;
  label: string | null;
  history_path: string;
  bookmarks_path: string | null;
  readable: boolean;
  error: { code: ProfileReadError; message: string; settings_url?: string } | null;
  /** Per-window counts, keyed by `Range`. Empty when unreadable. */
  windows: Record<string, WindowCount>;
  total_visits: number;
  total_bookmarks: number;
  oldest_visit_ts: string | null;
  newest_visit_ts: string | null;
  /**
   * The smallest window whose visit count already equals the all-time count —
   * every longer window is the same number. Null when unreadable or empty.
   */
  plateau_window: Range | null;
  /** Human sentence explaining the plateau when it is the browser's retention at work. */
  retention_note: string | null;
}

export interface BrowserDiscovery {
  now: string;
  windows: readonly Range[];
  profiles: ProfileCounts[];
  /** Sum over readable profiles, per window. */
  totals: Record<string, WindowCount>;
  /** Any profile that needs Full Disk Access to be read. */
  needs_full_disk_access: boolean;
  full_disk_access_settings_url: string;
  /** The copy-then-read disclosure, ready to render. */
  disclosure: { scratch_dir: string; text: string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyWindows(): Record<string, WindowCount> {
  const out: Record<string, WindowCount> = {};
  for (const w of COUNT_WINDOWS) out[w] = { visits: 0, bookmarks: 0 };
  return out;
}

function fdaMessage(browser: BrowserId): string {
  const name = BROWSER_NAMES[browser];
  return (
    `macOS protects ${name}'s history file. Give SuperTwin Full Disk Access in ` +
    `System Settings › Privacy & Security › Full Disk Access, then check again. ` +
    `Nothing else is read.`
  );
}

interface VisitStats {
  perWindow: Map<Range, number>;
  total: number;
  oldestMs: number | null;
  newestMs: number | null;
}

function chromiumStats(path: string, nowMs: number): VisitStats {
  return withHistoryCopy(path, (db) => {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM visits WHERE visit_time > ?`);
    const perWindow = new Map<Range, number>();
    for (const w of COUNT_WINDOWS) {
      const floor = rangeCutoffMs(w, nowMs);
      perWindow.set(w, (count.get(floor === 0 ? 0 : unixMsToChromeTime(floor)) as { n: number }).n);
    }
    const agg = db.prepare(`SELECT COUNT(*) AS n, MIN(visit_time) AS lo, MAX(visit_time) AS hi FROM visits`).get() as {
      n: number;
      lo: number | null;
      hi: number | null;
    };
    const toMs = (t: number | null) => (t === null ? null : Math.round(t / 1000) - 11644473600000);
    return { perWindow, total: agg.n, oldestMs: toMs(agg.lo), newestMs: toMs(agg.hi) };
  });
}

function safariStats(path: string, nowMs: number): VisitStats {
  return withHistoryCopy(path, (db) => {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM history_visits WHERE visit_time > ?`);
    const perWindow = new Map<Range, number>();
    for (const w of COUNT_WINDOWS) {
      const floor = rangeCutoffMs(w, nowMs);
      perWindow.set(w, (count.get(floor === 0 ? -1e12 : unixMsToSafariTime(floor)) as { n: number }).n);
    }
    const agg = db
      .prepare(`SELECT COUNT(*) AS n, MIN(visit_time) AS lo, MAX(visit_time) AS hi FROM history_visits`)
      .get() as { n: number; lo: number | null; hi: number | null };
    const toMs = (t: number | null) => (t === null ? null : Math.round((t + 978307200) * 1000));
    return { perWindow, total: agg.n, oldestMs: toMs(agg.lo), newestMs: toMs(agg.hi) };
  });
}

/** Bookmarks per window by `date_added`; undated bookmarks count in every window. */
function bookmarkCounts(path: string | null, nowMs: number): { perWindow: Map<Range, number>; total: number } {
  const perWindow = new Map<Range, number>();
  for (const w of COUNT_WINDOWS) perWindow.set(w, 0);
  if (!path) return { perWindow, total: 0 };
  let marks: { addedMs: number }[] = [];
  try {
    marks = readChromiumBookmarks(path);
  } catch {
    return { perWindow, total: 0 };
  }
  for (const b of marks) {
    for (const w of COUNT_WINDOWS) {
      const floor = rangeCutoffMs(w, nowMs);
      if (b.addedMs <= 0 || b.addedMs >= floor) perWindow.set(w, (perWindow.get(w) ?? 0) + 1);
    }
  }
  return { perWindow, total: marks.length };
}

/**
 * The plateau: the first window whose visits already equal the all-time
 * total. Everything longer is the same number, and the card says so.
 */
export function plateauWindow(windows: Record<string, WindowCount>, total: number): Range | null {
  if (total <= 0) return null;
  for (const w of COUNT_WINDOWS) {
    if ((windows[w]?.visits ?? 0) >= total) return w;
  }
  return null;
}

/**
 * "Chrome keeps 90 days": the oldest visit sits near the browser's retention
 * edge, so the plateau is the browser's doing, not the user's habits. Null
 * when the history simply does not go back that far (a new browser) or goes
 * back further (retention turned off / Safari set to "manually").
 */
export function retentionNote(browser: BrowserId, oldestMs: number | null, nowMs: number): string | null {
  if (oldestMs === null) return null;
  const keepDays = RETENTION_DAYS[browser];
  const ageDays = (nowMs - oldestMs) / DAY_MS;
  // Within ±15% of the retention edge: this is the browser's own cut.
  if (ageDays < keepDays * 0.85 || ageDays > keepDays * 1.15) return null;
  const name = BROWSER_NAMES[browser];
  const span = keepDays >= 365 ? "a year" : `${keepDays} days`;
  return `${name} keeps ${span} of history — anything older is already gone, so longer windows can't grow.`;
}

/** Count one profile. One copy, one read, copy deleted. Never throws. */
export function countProfile(profile: BrowserProfile, nowMs: number = Date.now()): ProfileCounts {
  const base: ProfileCounts = {
    browser: profile.browser,
    browser_name: BROWSER_NAMES[profile.browser],
    profile: profile.profile,
    label: profile.label,
    history_path: profile.historyPath,
    bookmarks_path: profile.bookmarksPath,
    readable: false,
    error: null,
    windows: emptyWindows(),
    total_visits: 0,
    total_bookmarks: 0,
    oldest_visit_ts: null,
    newest_visit_ts: null,
    plateau_window: null,
    retention_note: null,
  };
  let stats: VisitStats;
  try {
    stats = profile.browser === "safari" ? safariStats(profile.historyPath, nowMs) : chromiumStats(profile.historyPath, nowMs);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (isPermissionError(err)) {
      base.error = { code: "full-disk-access", message: fdaMessage(profile.browser), settings_url: FULL_DISK_ACCESS_SETTINGS_URL };
    } else if (e.code === "ENOENT" || !existsSync(profile.historyPath)) {
      base.error = { code: "missing", message: `${BROWSER_NAMES[profile.browser]}'s history file is gone: ${profile.historyPath}` };
    } else if (/SQLITE_BUSY|locked/i.test(e.message ?? "")) {
      base.error = { code: "locked", message: `${BROWSER_NAMES[profile.browser]} is writing its history right now — check again in a moment.` };
    } else {
      base.error = { code: "unreadable", message: `couldn't read ${BROWSER_NAMES[profile.browser]}'s history: ${e.message ?? String(err)}` };
    }
    return base;
  }
  const marks = bookmarkCounts(profile.bookmarksPath, nowMs);
  const windows: Record<string, WindowCount> = {};
  for (const w of COUNT_WINDOWS) {
    windows[w] = { visits: stats.perWindow.get(w) ?? 0, bookmarks: marks.perWindow.get(w) ?? 0 };
  }
  return {
    ...base,
    readable: true,
    windows,
    total_visits: stats.total,
    total_bookmarks: marks.total,
    oldest_visit_ts: stats.oldestMs === null ? null : new Date(stats.oldestMs).toISOString(),
    newest_visit_ts: stats.newestMs === null ? null : new Date(stats.newestMs).toISOString(),
    plateau_window: plateauWindow(windows, stats.total),
    retention_note: retentionNote(profile.browser, stats.oldestMs, nowMs),
  };
}

/** The sentence the card shows under the profile list. */
export function disclosureText(profiles: readonly BrowserProfile[], scratchDir: string): string {
  const files = profiles.length === 0 ? "no history files found" : `${profiles.length} history file${profiles.length === 1 ? "" : "s"}`;
  return (
    `SuperTwin reads ${files} by copying each one to ${scratchDir} and opening the copy read-only; ` +
    `the browser's own file is never opened and every copy is deleted right after the read. ` +
    `Incognito and private windows are never in these files.`
  );
}

/** Discover + count everything. The connect card's single call. */
export function discoverAndCount(profiles: readonly BrowserProfile[], nowMs: number = Date.now()): BrowserDiscovery {
  const counted = profiles.map((p) => countProfile(p, nowMs));
  const totals = emptyWindows();
  for (const c of counted) {
    if (!c.readable) continue;
    for (const w of COUNT_WINDOWS) {
      totals[w]!.visits += c.windows[w]?.visits ?? 0;
      totals[w]!.bookmarks += c.windows[w]?.bookmarks ?? 0;
    }
  }
  const scratch = historyScratchDir();
  return {
    now: new Date(nowMs).toISOString(),
    windows: COUNT_WINDOWS,
    profiles: counted,
    totals,
    needs_full_disk_access: counted.some((c) => c.error?.code === "full-disk-access"),
    full_disk_access_settings_url: FULL_DISK_ACCESS_SETTINGS_URL,
    disclosure: { scratch_dir: scratch, text: disclosureText(profiles, scratch) },
  };
}
