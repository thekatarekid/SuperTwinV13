// ===========================================================================
// Browser watcher public surface (build P0.8).
//
// `startBrowserWatcher(db)` is the production entrypoint the worker boot
// calls: discovers profiles, wires the DB sink (buffers until 0100_v13_core
// lands), starts polling. Everything degrades gracefully — no profiles, no
// table, locked files: the worker still boots.
// ===========================================================================

import type Database from "better-sqlite3";

import { BrowserWatcher, discoverProfiles, type BrowserWatcherOptions } from "./watcher.js";
import { DbSink } from "./sink.js";

export { BrowserWatcher, discoverProfiles, BROWSER_SOURCE_ID } from "./watcher.js";
export type { BrowserProfile, BrowserWatcherOptions } from "./watcher.js";
export { DbSink, MemorySink, hasV13EventsTable, type V13EventSink } from "./sink.js";
export {
  ageBandOf,
  browserContentHash,
  domainOf,
  ulid,
  type AgeBand,
  type BrowserBookmarkPayload,
  type BrowserCategory,
  type BrowserId,
  type BrowserVisitPayload,
  type EventOrigin,
  type EventRoles,
  type V13Event,
} from "./envelope.js";
export {
  aggregateDomains,
  DomainCategorizer,
  isDroppableTrackerHop,
  isTrackerDomain,
  TRACKER_SUFFIXES,
  type AmbiguousResolver,
  type DomainStats,
} from "./category.js";
export { assignChains, CHAIN_GAP_MS, type ChainedVisit } from "./chains.js";
export {
  chromeTimeToUnixMs,
  decodeChromeTransition,
  readChromiumHistory,
  readSafariHistory,
  safariTimeToUnixMs,
  setHistoryScratchDir,
  unixMsToChromeTime,
  unixMsToSafariTime,
  withHistoryCopy,
  type RawVisit,
} from "./history-db.js";
export { parseChromiumBookmarks, readChromiumBookmarks, type RawBookmark } from "./bookmarks.js";

/**
 * Production wiring: discover real profiles, poll into the given DB.
 * Never throws; returns the watcher (already started).
 */
export function startBrowserWatcher(
  db: Database.Database,
  opts: Partial<BrowserWatcherOptions> = {},
): BrowserWatcher {
  const log = opts.log ?? ((line: string) => console.error(line));
  const watcher = new BrowserWatcher({
    sink: opts.sink ?? new DbSink(db, log),
    profiles: opts.profiles ?? discoverProfiles(),
    log,
    ...opts,
  });
  watcher.start();
  return watcher;
}
