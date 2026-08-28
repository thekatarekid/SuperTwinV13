// ===========================================================================
// Browser watcher (build P0.8; spec §4.2 source 3, §4.2.3, §5.1).
//
// Polls Chrome/Safari/Arc history DBs (copy-then-read) + Chromium bookmarks
// files, and appends `browser.visit` / `browser.bookmark` v13 envelopes to
// the sink. Stream keys are tab chains (referrer links + 30-min gap,
// ./chains.ts). Per-domain Cat-1/2 by code heuristics (./category.ts).
//
// Page content (spec §4.2.3): AX capture (P2.1) covers frontmost pages;
// fetch-by-reference lands with the SuperTwin Browser (P3.4). Until then,
// every uncovered Cat-1 visit and every bookmark is marked
// `content_pending: true` so the backlog is fetchable later. The AX-coverage
// probe is a hook (default: nothing covered).
//
// Guarding: a machine with none of the profiles present, a locked DB, a
// missing table — all degrade to "0 events this poll", never a crash.
// Incognito never appears in these DBs — nothing to filter (spec §4.3.1).
// ===========================================================================

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ageBandOf,
  browserContentHash,
  domainOf,
  SELF_ROLES,
  ulid,
  type BrowserCategory,
  type BrowserId,
  type V13Event,
} from "./envelope.js";
import { readChromiumBookmarks, type RawBookmark } from "./bookmarks.js";
import { assignChains, type ChainedVisit } from "./chains.js";
import {
  aggregateDomains,
  DomainCategorizer,
  isDroppableTrackerHop,
  type AmbiguousResolver,
} from "./category.js";
import { readChromiumHistory, readSafariHistory, type RawVisit } from "./history-db.js";
import type { V13EventSink } from "./sink.js";

export const BROWSER_SOURCE_ID = "browser";

// ---- Profile discovery -----------------------------------------------------

export interface BrowserProfile {
  browser: BrowserId;
  historyPath: string;
  /** Chromium only; Safari bookmarks (binary plist) are skipped in P0.8. */
  bookmarksPath: string | null;
}

/** Default macOS profile locations; only existing files are returned. */
export function discoverProfiles(home: string = homedir()): BrowserProfile[] {
  const candidates: BrowserProfile[] = [
    {
      browser: "chrome",
      historyPath: join(home, "Library/Application Support/Google/Chrome/Default/History"),
      bookmarksPath: join(home, "Library/Application Support/Google/Chrome/Default/Bookmarks"),
    },
    {
      browser: "arc",
      historyPath: join(home, "Library/Application Support/Arc/User Data/Default/History"),
      bookmarksPath: join(home, "Library/Application Support/Arc/User Data/Default/Bookmarks"),
    },
    {
      browser: "safari",
      historyPath: join(home, "Library/Safari/History.db"),
      bookmarksPath: null,
    },
  ];
  return candidates
    .filter((p) => {
      try {
        return existsSync(p.historyPath);
      } catch {
        return false;
      }
    })
    .map((p) => ({
      ...p,
      bookmarksPath: p.bookmarksPath && existsSync(p.bookmarksPath) ? p.bookmarksPath : null,
    }));
}

// ---- Watcher ---------------------------------------------------------------

export interface BrowserWatcherOptions {
  sink: V13EventSink;
  profiles?: BrowserProfile[];
  /** Poll interval, ms (default 60s). */
  pollMs?: number;
  /** Import floor: visits older than this are ignored (default: 90d back). */
  sinceMs?: number;
  /** Cached-cheap-call hook for ambiguous domains (wired to tiers in P1). */
  ambiguousResolver?: AmbiguousResolver | null;
  /** AX-coverage probe (P2.1): true = page text already captured for ts+url. */
  hasAxCoverage?: (url: string, tsMs: number) => boolean;
  log?: (line: string) => void;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class BrowserWatcher {
  private readonly sink: V13EventSink;
  private readonly profiles: BrowserProfile[];
  private readonly pollMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly hasAxCoverage: (url: string, tsMs: number) => boolean;
  private readonly categorizer: DomainCategorizer;

  /** Per history-path high-water mark (unix ms of the newest visit seen). */
  private readonly cursors = new Map<string, number>();
  /** Per bookmarks-path mtimeMs at last read. */
  private readonly bookmarkMtimes = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: BrowserWatcherOptions) {
    this.sink = opts.sink;
    this.profiles = opts.profiles ?? discoverProfiles();
    this.pollMs = opts.pollMs ?? 60_000;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    this.hasAxCoverage = opts.hasAxCoverage ?? (() => false);
    this.categorizer = new DomainCategorizer(opts.ambiguousResolver ?? null);
    const floor = opts.sinceMs ?? this.now() - 90 * DAY_MS;
    for (const p of this.profiles) this.cursors.set(p.historyPath, floor);
  }

  /** Begin polling. Idempotent. An immediate first poll runs asynchronously. */
  start(): void {
    if (this.timer) return;
    if (this.profiles.length === 0) {
      this.log("[browser] no browser profiles found — watcher idle");
    }
    this.timer = setInterval(() => this.pollSafe(), this.pollMs);
    this.timer.unref?.();
    queueMicrotask(() => this.pollSafe());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private pollSafe(): void {
    try {
      this.poll();
    } catch (err) {
      this.log(`[browser] poll failed (continuing): ${(err as Error).message}`);
    }
  }

  /** One poll across every profile. Returns events appended. Exposed for tests. */
  poll(): number {
    let written = 0;
    for (const profile of this.profiles) {
      written += this.pollProfile(profile);
    }
    return written;
  }

  private pollProfile(profile: BrowserProfile): number {
    // ---- Bookmarks first: a fresh bookmark is a Cat-1 signal for the
    // visits read in the same poll.
    const bookmarks = this.readNewBookmarks(profile);

    let visits: RawVisit[] = [];
    const since = this.cursors.get(profile.historyPath) ?? 0;
    try {
      visits =
        profile.browser === "safari"
          ? readSafariHistory(profile.historyPath, since)
          : readChromiumHistory(profile.historyPath, since, profile.browser);
    } catch (err) {
      this.log(`[browser] ${profile.browser} history read failed (skipping poll): ${(err as Error).message}`);
      visits = [];
    }
    if (visits.length > 0) {
      this.cursors.set(profile.historyPath, Math.max(...visits.map((v) => v.tsMs)));
    }

    const bookmarkedDomains = new Set<string>();
    for (const b of this.allBookmarks(profile)) {
      const d = domainOf(b.url);
      if (d) bookmarkedDomains.add(d);
    }

    const events = [
      ...this.visitEvents(visits, bookmarkedDomains),
      ...this.bookmarkEvents(bookmarks, profile.browser),
    ];
    return events.length === 0 ? 0 : this.sink.append(events);
  }

  // ---- Visits → events -----------------------------------------------------

  /** Build `browser.visit` envelopes from raw visits. Exposed for tests. */
  visitEvents(visits: readonly RawVisit[], bookmarkedDomains: ReadonlySet<string>): V13Event[] {
    const chained = assignChains(visits);
    const stats = aggregateDomains(
      chained.map((v) => ({ url: v.url, typed: v.typed, redirect: v.redirect, dwellMs: v.inferredDwellMs })),
      bookmarkedDomains,
    );
    const out: V13Event[] = [];
    for (const v of chained) {
      const domain = domainOf(v.url);
      const s = stats.get(domain);
      // Gate: pure tracker redirect hops are plumbing, not behaviour.
      if (isDroppableTrackerHop(domain, { url: v.url, typed: v.typed, redirect: v.redirect, dwellMs: v.inferredDwellMs })) {
        continue;
      }
      const category: BrowserCategory = s ? this.categorizer.categorize(s) : "ambiguous";
      out.push(this.visitEvent(v, domain, category));
    }
    return out;
  }

  private visitEvent(v: ChainedVisit, domain: string, category: BrowserCategory): V13Event {
    const nowMs = this.now();
    const contentPending = category === "cat1" && !this.hasAxCoverage(v.url, v.tsMs);
    return {
      id: ulid(nowMs),
      ts: new Date(v.tsMs).toISOString(),
      captured_at: new Date(nowMs).toISOString(),
      source: BROWSER_SOURCE_ID,
      kind: "browser.visit",
      origin: nowMs - v.tsMs <= 10 * 60 * 1000 ? "live" : "backfill",
      age_band: ageBandOf(v.tsMs, nowMs),
      stream_key: v.streamKey,
      actor: "self",
      roles: { ...SELF_ROLES, audience: [...SELF_ROLES.audience], receiver: [...SELF_ROLES.receiver], mentions: [] },
      text: v.title ? `${v.title} ${v.url}` : v.url,
      payload: {
        url: v.url,
        title: v.title,
        transition: v.transition,
        referrer: v.referrerUrl,
        visit_count: v.visitCount,
        dwell_ms: v.inferredDwellMs,
        domain,
        category,
        content_pending: contentPending,
        browser: v.browser,
      },
      content_hash: browserContentHash([BROWSER_SOURCE_ID, "visit", v.browser, v.url, v.tsMs, v.visitId]),
      blob_refs: [],
    };
  }

  // ---- Bookmarks → events --------------------------------------------------

  private lastBookmarkSets = new Map<string, Set<string>>();

  private allBookmarks(profile: BrowserProfile): RawBookmark[] {
    if (!profile.bookmarksPath) return [];
    return readChromiumBookmarks(profile.bookmarksPath);
  }

  /** Bookmarks not yet emitted for this profile (mtime + set diff). */
  private readNewBookmarks(profile: BrowserProfile): RawBookmark[] {
    if (!profile.bookmarksPath) return [];
    let mtime = 0;
    try {
      mtime = statSync(profile.bookmarksPath).mtimeMs;
    } catch {
      return [];
    }
    const seenMtime = this.bookmarkMtimes.get(profile.bookmarksPath);
    if (seenMtime !== undefined && seenMtime === mtime) return [];
    this.bookmarkMtimes.set(profile.bookmarksPath, mtime);

    const all = this.allBookmarks(profile);
    const key = profile.bookmarksPath;
    const seen = this.lastBookmarkSets.get(key) ?? new Set<string>();
    const fresh = all.filter((b) => !seen.has(b.url));
    this.lastBookmarkSets.set(key, new Set(all.map((b) => b.url)));
    return fresh;
  }

  /** Build `browser.bookmark` envelopes. Exposed for tests. */
  bookmarkEvents(bookmarks: readonly RawBookmark[], browser: BrowserId): V13Event[] {
    const nowMs = this.now();
    return bookmarks.map((b) => {
      const domain = domainOf(b.url);
      // A bookmark IS engagement: the domain is Cat 1 by definition (spec §5.1)
      // and a stale cached verdict must not stand in the way.
      this.categorizer.invalidate(domain);
      const tsMs = b.addedMs > 0 ? b.addedMs : nowMs;
      return {
        id: ulid(nowMs),
        ts: new Date(tsMs).toISOString(),
        captured_at: new Date(nowMs).toISOString(),
        source: BROWSER_SOURCE_ID,
        kind: "browser.bookmark",
        origin: nowMs - tsMs <= 10 * 60 * 1000 ? "live" : "backfill",
        age_band: ageBandOf(tsMs, nowMs),
        stream_key: `browser:${browser}:bookmarks`,
        actor: "self",
        roles: { ...SELF_ROLES, audience: [...SELF_ROLES.audience], receiver: [...SELF_ROLES.receiver], mentions: [] },
        text: b.title ? `${b.title} ${b.url}` : b.url,
        payload: {
          url: b.url,
          title: b.title,
          folder: b.folder,
          added_ts: new Date(tsMs).toISOString(),
          domain,
          category: "cat1" as const,
          content_pending: true,
          browser,
        },
        content_hash: browserContentHash([BROWSER_SOURCE_ID, "bookmark", browser, b.url, b.addedMs]),
        blob_refs: [],
      };
    });
  }
}
