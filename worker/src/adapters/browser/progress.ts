// ===========================================================================
// Browser import progress (V6 P1 S6d L5; user issue 5 — "after connecting,
// nothing shows for a very long time").
//
// WHAT WAS BROKEN. The browser connect card said "Connected — reading your
// history now." and the panel then sat on the generic
//
//     connected — reading your history; visits appear here as they land
//
// for minutes, because nothing anywhere knew what the watcher was doing. The
// only number the panel could show was `event_count`, an unbounded
// `COUNT(*) FROM events WHERE source_id='browser'` that queues behind the
// importer's writes (measured on the user's live app: 0.13 s / 3.0 s / 6.9 s
// for the same query, minutes apart) — so the one number it had was both slow
// and silent about which profile was being read.
//
// THE SHAPE. The watcher reports what it is doing per PROFILE; this module is
// the process-local ledger of those reports, and the connect surface reads it.
// Deliberately in-memory:
//
//   * it costs nothing to read, so the panel can poll it every couple of
//     seconds while the import runs without adding a query to the queue the
//     importer is already blocking;
//   * it is per-process by nature ("what is this watcher doing right now"),
//     and a worker restart honestly reports `known: false` rather than
//     replaying a stale story from the database.
//
// `expected_visits` comes from OUTSIDE — the counts the connect card measured
// before consent, carried on the consent row's scope. This module never
// counts anything itself, and never reads or writes the event log.
// ===========================================================================

import { BROWSER_NAMES, type BrowserId } from "./envelope.js";

export type ProfileImportState = "pending" | "reading" | "done" | "failed";

export interface ProfileImportProgress {
  history_path: string;
  browser: BrowserId;
  browser_name: string;
  profile: string;
  label: string | null;
  state: ProfileImportState;
  /** Raw visits read from this profile's history file since the watcher started. */
  visits_read: number;
  /** Rows the single-writer actually appended (deduped by content hash). */
  events_written: number;
  /** What the connect card measured for this profile, when the caller knows it. */
  expected_visits: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface BrowserImportProgress {
  /** False when no watcher has reported in this process (fresh boot, or stopped). */
  known: boolean;
  /** True while at least one profile is mid-read. */
  reading: boolean;
  /** True once every profile has been through one complete pass. */
  first_pass_done: boolean;
  profiles: ProfileImportProgress[];
  visits_read: number;
  events_written: number;
  /** Sum of the per-profile expectations; null when none is known. */
  expected_visits: number | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface BrowserProfileIdentity {
  browser: BrowserId;
  profile: string;
  label: string | null;
  historyPath: string;
}

/** The empty answer — "no watcher has said anything in this process". */
export const UNKNOWN_IMPORT_PROGRESS: BrowserImportProgress = {
  known: false,
  reading: false,
  first_pass_done: false,
  profiles: [],
  visits_read: 0,
  events_written: 0,
  expected_visits: null,
  started_at: null,
  finished_at: null,
};

interface Entry extends ProfileImportProgress {
  /** Passes completed for this profile — the first pass is the history import. */
  passes: number;
}

const entries = new Map<string, Entry>();
let armedAt: string | null = null;

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

/**
 * A watcher is starting: declare the profiles it will read, all `pending`.
 * Called by `startBrowserWatcher` so the panel can name the profiles the
 * moment consent lands — before the first byte is read.
 */
export function armBrowserImportProgress(
  profiles: readonly BrowserProfileIdentity[],
  now: () => number = Date.now,
): void {
  entries.clear();
  armedAt = nowIso(now);
  for (const p of profiles) {
    entries.set(p.historyPath, {
      history_path: p.historyPath,
      browser: p.browser,
      browser_name: BROWSER_NAMES[p.browser],
      profile: p.profile,
      label: p.label,
      state: "pending",
      visits_read: 0,
      events_written: 0,
      expected_visits: null,
      started_at: null,
      finished_at: null,
      error: null,
      passes: 0,
    });
  }
}

/** The watcher stopped (disconnect / pause): the ledger says "nothing running". */
export function disarmBrowserImportProgress(): void {
  entries.clear();
  armedAt = null;
}

export type BrowserProgressEvent =
  | { type: "profile-start"; profile: BrowserProfileIdentity; at: number }
  | {
      type: "profile-done";
      profile: BrowserProfileIdentity;
      visitsRead: number;
      eventsWritten: number;
      at: number;
    }
  | { type: "profile-error"; profile: BrowserProfileIdentity; message: string; at: number }
  /** The watcher stopped (disconnect, pause, teardown): the ledger empties. */
  | { type: "stopped"; at: number };

/** Fold one watcher report into the ledger. Never throws. */
export function recordBrowserProgress(ev: BrowserProgressEvent): void {
  if (ev.type === "stopped") {
    disarmBrowserImportProgress();
    return;
  }
  const key = ev.profile.historyPath;
  let e = entries.get(key);
  if (!e) {
    e = {
      history_path: key,
      browser: ev.profile.browser,
      browser_name: BROWSER_NAMES[ev.profile.browser] ?? ev.profile.browser,
      profile: ev.profile.profile,
      label: ev.profile.label,
      state: "pending",
      visits_read: 0,
      events_written: 0,
      expected_visits: null,
      started_at: null,
      finished_at: null,
      error: null,
      passes: 0,
    };
    entries.set(key, e);
  }
  const at = new Date(ev.at).toISOString();
  if (armedAt === null) armedAt = at;
  switch (ev.type) {
    case "profile-start":
      e.state = "reading";
      e.started_at ??= at;
      break;
    case "profile-done":
      e.state = "done";
      e.visits_read += ev.visitsRead;
      e.events_written += ev.eventsWritten;
      e.finished_at = at;
      e.error = null;
      e.passes += 1;
      break;
    case "profile-error":
      e.state = "failed";
      e.error = ev.message;
      e.finished_at = at;
      e.passes += 1;
      break;
    default:
      break;
  }
}

/**
 * The ledger, as the connect surface renders it. `expected` maps history path
 * → visits the connect card measured (from the consent row's scope); paths it
 * does not name simply have no expectation, which the UI shows as "reading…"
 * rather than a fake percentage.
 */
export function getBrowserImportProgress(
  expected: Readonly<Record<string, number>> = {},
): BrowserImportProgress {
  if (entries.size === 0) return { ...UNKNOWN_IMPORT_PROGRESS, profiles: [] };
  const profiles: ProfileImportProgress[] = [];
  let visits = 0;
  let events = 0;
  let expectedTotal: number | null = null;
  let reading = false;
  let firstPassDone = true;
  let finished: string | null = null;
  for (const e of entries.values()) {
    const exp = Object.prototype.hasOwnProperty.call(expected, e.history_path)
      ? Math.max(0, Math.trunc(expected[e.history_path] ?? 0))
      : null;
    if (exp !== null) expectedTotal = (expectedTotal ?? 0) + exp;
    visits += e.visits_read;
    events += e.events_written;
    if (e.state === "reading") reading = true;
    if (e.passes === 0) firstPassDone = false;
    if (e.finished_at !== null && (finished === null || e.finished_at > finished)) finished = e.finished_at;
    const { passes: _passes, ...view } = e;
    profiles.push({ ...view, expected_visits: exp });
  }
  return {
    known: true,
    reading,
    first_pass_done: firstPassDone,
    profiles,
    visits_read: visits,
    events_written: events,
    expected_visits: expectedTotal,
    started_at: armedAt,
    finished_at: firstPassDone ? finished : null,
  };
}

/** Test seam — the module is a process-local singleton by design. */
export function resetBrowserImportProgress(): void {
  disarmBrowserImportProgress();
}
