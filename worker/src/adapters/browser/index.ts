// ===========================================================================
// Browser watcher public surface (build P0.8).
//
// `startBrowserWatcher()` is the production entrypoint the worker boot
// calls: discovers profiles, wires the single-writer sink (db/eventlog.ts,
// P0.4), starts polling. Everything degrades gracefully — no profiles,
// locked files, a throwing append: the worker still boots.
// ===========================================================================

import { BrowserWatcher, discoverProfiles, requireSinceMs, type BrowserWatcherOptions } from "./watcher.js";
import { EventlogSink } from "./sink.js";

export { BrowserWatcher, discoverProfiles, requireSinceMs, BROWSER_SOURCE_ID } from "./watcher.js";
export type { BrowserProfile, BrowserWatcherOptions } from "./watcher.js";
export { EventlogSink, MemorySink, toEventEnvelope, type V13EventSink } from "./sink.js";
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

/** `startBrowserWatcher` options: everything optional EXCEPT the import floor. */
export type StartBrowserWatcherOptions = Partial<Omit<BrowserWatcherOptions, "sinceMs">> &
  Pick<BrowserWatcherOptions, "sinceMs">;

/**
 * Production wiring: discover real profiles, poll into the shared worker DB
 * via the single-writer path. Returns the watcher (started). `sinceMs` is
 * required (V6 P1 S1.3 / T4-4): the boot path derives it from the browser
 * consent row (adapters/supervisor.ts) — a missing floor throws here, before
 * any history file is opened.
 */
export function startBrowserWatcher(opts: StartBrowserWatcherOptions): BrowserWatcher {
  const log = opts.log ?? ((line: string) => console.error(line));
  const watcher = new BrowserWatcher({
    sink: opts.sink ?? new EventlogSink(log),
    profiles: opts.profiles ?? discoverProfiles(),
    log,
    ...opts,
    sinceMs: requireSinceMs(opts.sinceMs),
  });
  watcher.start();
  return watcher;
}
