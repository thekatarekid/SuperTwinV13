// ===========================================================================
// Browser watcher public surface (build P0.8).
//
// `startBrowserWatcher()` is the production entrypoint the worker boot
// calls: discovers profiles, wires the single-writer sink (db/eventlog.ts,
// P0.4), starts polling. Everything degrades gracefully — no profiles,
// locked files, a throwing append: the worker still boots.
// ===========================================================================

import {
  BrowserWatcher,
  discoverProfiles,
  requireSinceMs,
  type BrowserProfile,
  type BrowserWatcherOptions,
} from "./watcher.js";
import { EventlogSink } from "./sink.js";

export {
  BrowserWatcher,
  CHROMIUM_ROOTS,
  SAFARI_HISTORY,
  discoverProfiles,
  requireSinceMs,
  BROWSER_SOURCE_ID,
} from "./watcher.js";
export type { BrowserProfile, BrowserWatcherOptions } from "./watcher.js";
export {
  COUNT_WINDOWS,
  FULL_DISK_ACCESS_SETTINGS_URL,
  RETENTION_DAYS,
  countProfile,
  disclosureText,
  discoverAndCount,
  plateauWindow,
  retentionNote,
  type BrowserDiscovery,
  type ProfileCounts,
  type WindowCount,
} from "./counts.js";
export {
  VISIT_COLLAPSE_MS,
  collapseVisitRuns,
  isVisitRun,
  renderVisitRun,
  visitRunHead,
  visitRunSpan,
  type RenderableEvent,
} from "./render.js";
export { EventlogSink, MemorySink, toEventEnvelope, type V13EventSink } from "./sink.js";
export {
  BROWSER_IDS,
  BROWSER_NAMES,
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
export {
  assignChains,
  browserStreamKey,
  CHAIN_GAP_MS,
  docStreamKey,
  parseStreamKey,
  screenStreamKey,
  utcDayOf,
  waStreamKey,
  type AssignChainsOptions,
  type ChainedVisit,
  type ParsedStreamKey,
} from "./chains.js";
export {
  chromeTimeToUnixMs,
  decodeChromeTransition,
  historyScratchDir,
  isPermissionError,
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
 * The profiles a consent row admits (V6 P1 S1.4). The connect card stores the
 * chosen history paths in `scope.profiles`; an absent or empty list means
 * "every profile found". A path the user chose that has since vanished is
 * simply not there — nothing is substituted for it.
 */
export function profilesForConsent(
  consent: { scope: unknown } | null | undefined,
  discovered: () => BrowserProfile[] = () => discoverProfiles(),
): BrowserProfile[] {
  const all = discovered();
  const scope = consent?.scope as { profiles?: unknown } | null | undefined;
  const wanted = Array.isArray(scope?.profiles) ? scope.profiles.filter((p): p is string => typeof p === "string") : [];
  if (wanted.length === 0) return all;
  const set = new Set(wanted);
  return all.filter((p) => set.has(p.historyPath));
}

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
