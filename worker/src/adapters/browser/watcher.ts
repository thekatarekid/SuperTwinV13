// ===========================================================================
// Browser watcher (build P0.8; spec §4.2 source 3, §4.2.3, §5.1).
//
// Polls every installed browser's history DB (Chrome, Brave, Arc, Edge,
// Comet, Safari — every profile; copy-then-read) + Chromium bookmarks files,
// and appends `browser.visit` / `browser.bookmark` v13 envelopes to the sink.
//
// URLs (V6 P1 S1.4, T6-1/T6-2): `text` carries the TEXT FORM of the URL —
// tracking params stripped, per-domain content params kept, survivors sorted
// (bridges/normalise.urlTextForm). `payload.url` is the visit byte-for-byte.
// Stream keys are tab chains (referrer links + 30-min gap, ./chains.ts).
// Per-domain Cat-1/2 by code heuristics (./category.ts).
//
// Every visit is kept — there is no drop policy (V6 P1 S0.5 / T6-6 deleted the
// tracker blocklist) and no `content_pending` flag (writers, zero readers).
//
// Guarding: a machine with none of the profiles present, a locked DB, a
// missing table — all degrade to "0 events this poll", never a crash.
// Incognito never appears in these DBs — nothing to filter (spec §4.3.1).
// ===========================================================================

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
import { aggregateDomains, DomainCategorizer, type AmbiguousResolver } from "./category.js";
import { readChromiumHistory, readSafariHistory, type RawVisit } from "./history-db.js";
import type { V13EventSink } from "./sink.js";
import { urlTextForm } from "../../bridges/normalise.js";

export const BROWSER_SOURCE_ID = "browser";

// ---- Profile discovery -----------------------------------------------------

export interface BrowserProfile {
  browser: BrowserId;
  /** Profile directory name — "Default", "Profile 2"; Safari has one: "Safari". */
  profile: string;
  /** Human name from Chromium's `Local State` (`profile.info_cache[dir].name`), else null. */
  label: string | null;
  historyPath: string;
  /** Chromium only; Safari bookmarks (binary plist) are skipped in P1. */
  bookmarksPath: string | null;
}

/**
 * Chromium-family roots under ~/Library/Application Support. Every one of
 * them keeps `Local State` at the root and one directory per profile
 * (`Default`, `Profile 1`, …) holding `History` and `Bookmarks`.
 */
export const CHROMIUM_ROOTS: ReadonlyArray<{ browser: Exclude<BrowserId, "safari">; root: string }> = [
  { browser: "chrome", root: "Library/Application Support/Google/Chrome" },
  { browser: "brave", root: "Library/Application Support/BraveSoftware/Brave-Browser" },
  { browser: "arc", root: "Library/Application Support/Arc/User Data" },
  { browser: "edge", root: "Library/Application Support/Microsoft Edge" },
  { browser: "comet", root: "Library/Application Support/Comet" },
];

export const SAFARI_HISTORY = "Library/Safari/History.db";

/** Profile directories Chromium creates for people. Guest/System profiles are not history. */
const PROFILE_DIR_RE = /^(Default|Profile \d+)$/;

/** True when the file exists — OR exists behind a permission wall (Safari without Full Disk Access). */
function presentOrProtected(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code === "EPERM" || code === "EACCES";
  }
}

/** `profile.info_cache` names from a Chromium `Local State`; {} on any trouble. */
function profileLabels(root: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(root, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    const cache = raw.profile?.info_cache ?? {};
    const out: Record<string, string> = {};
    for (const [dir, info] of Object.entries(cache)) {
      if (typeof info?.name === "string" && info.name.trim() !== "") out[dir] = info.name.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Every browser, every profile (V6 P1 S1.4). Chrome, Brave, Arc, Edge, Comet
 * by enumerating their profile directories; Safari's single History.db. Only
 * profiles whose History file is present are returned — a Safari file the
 * process cannot stat because Full Disk Access is missing is still returned
 * (the counts step turns that into the FDA message; hiding it would look like
 * "no Safari"). Never throws.
 */
export function discoverProfiles(home: string = homedir()): BrowserProfile[] {
  const out: BrowserProfile[] = [];
  for (const { browser, root } of CHROMIUM_ROOTS) {
    const rootDir = join(home, root);
    let dirs: string[] = [];
    try {
      dirs = readdirSync(rootDir).filter((d) => PROFILE_DIR_RE.test(d));
    } catch {
      continue;
    }
    if (dirs.length === 0) continue;
    const labels = profileLabels(rootDir);
    dirs.sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b, undefined, { numeric: true })));
    for (const dir of dirs) {
      const historyPath = join(rootDir, dir, "History");
      if (!presentOrProtected(historyPath)) continue;
      const bookmarksPath = join(rootDir, dir, "Bookmarks");
      out.push({
        browser,
        profile: dir,
        label: labels[dir] ?? null,
        historyPath,
        bookmarksPath: existsSync(bookmarksPath) ? bookmarksPath : null,
      });
    }
  }
  const safari = join(home, SAFARI_HISTORY);
  if (presentOrProtected(safari)) {
    out.push({ browser: "safari", profile: "Safari", label: null, historyPath: safari, bookmarksPath: null });
  }
  return out;
}

// ---- Watcher ---------------------------------------------------------------

export interface BrowserWatcherOptions {
  sink: V13EventSink;
  profiles?: BrowserProfile[];
  /** Poll interval, ms (default 60s). */
  pollMs?: number;
  /**
   * Import floor (unix ms): visits older than this are ignored. REQUIRED
   * (V6 P1 S1.3, T4-4): the pre-consent watcher defaulted this to "90 days
   * back", which is how a fresh boot imported three months of history nobody
   * had consented to. There is no default any more — the caller derives the
   * floor from the source's consent row (adapters/supervisor.ts), and a
   * missing or non-finite value throws at construction, not at first poll.
   */
  sinceMs: number;
  /** Cached-cheap-call hook for ambiguous domains (wired to tiers in P1). */
  ambiguousResolver?: AmbiguousResolver | null;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * The import floor is a hard precondition (T4-4). Type-level `sinceMs: number`
 * stops the omission in TypeScript; this stops it for a JS caller, a spread of
 * a Partial, or a NaN from `Date.parse` on a bad consent row. Exposed so the
 * supervisor and the tests assert the same rule.
 */
export function requireSinceMs(sinceMs: unknown): number {
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs)) {
    throw new TypeError(
      "BrowserWatcher: sinceMs (import floor, unix ms) is required — derive it from the " +
        "source's consent row; there is no 90-day default (V6 P1 S1.3 / T4-4)",
    );
  }
  return sinceMs;
}

export class BrowserWatcher {
  private readonly sink: V13EventSink;
  private readonly profiles: BrowserProfile[];
  private readonly pollMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
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
    this.categorizer = new DomainCategorizer(opts.ambiguousResolver ?? null);
    const floor = requireSinceMs(opts.sinceMs);
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
      ...this.visitEvents(visits, bookmarkedDomains, profile.profile),
      ...this.bookmarkEvents(bookmarks, profile.browser),
    ];
    return events.length === 0 ? 0 : this.sink.append(events);
  }

  // ---- Visits → events -----------------------------------------------------

  /** Build `browser.visit` envelopes from raw visits. Exposed for tests. */
  visitEvents(visits: readonly RawVisit[], bookmarkedDomains: ReadonlySet<string>, profile?: string): V13Event[] {
    const chained = assignChains(visits);
    const stats = aggregateDomains(
      chained.map((v) => ({ url: v.url, typed: v.typed, redirect: v.redirect, dwellMs: v.inferredDwellMs })),
      bookmarkedDomains,
    );
    const out: V13Event[] = [];
    for (const v of chained) {
      const domain = domainOf(v.url);
      const s = stats.get(domain);
      const category: BrowserCategory = s ? this.categorizer.categorize(s) : "ambiguous";
      out.push(this.visitEvent(v, domain, category, profile));
    }
    return out;
  }

  private visitEvent(v: ChainedVisit, domain: string, category: BrowserCategory, profile?: string): V13Event {
    const nowMs = this.now();
    // T6-1: the text field gets the stripped URL; the payload keeps the raw one.
    const urlText = urlTextForm(v.url);
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
      text: v.title ? `${v.title} ${urlText}` : urlText,
      payload: {
        url: v.url,
        title: v.title,
        transition: v.transition,
        referrer: v.referrerUrl,
        visit_count: v.visitCount,
        dwell_ms: v.inferredDwellMs,
        domain,
        category,
        browser: v.browser,
        ...(profile ? { profile } : {}),
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
          browser,
        },
        content_hash: browserContentHash([BROWSER_SOURCE_ID, "bookmark", browser, b.url, b.addedMs]),
        blob_refs: [],
      };
    });
  }
}
