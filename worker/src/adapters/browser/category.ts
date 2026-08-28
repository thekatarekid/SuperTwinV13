// ===========================================================================
// Per-domain Cat-1/Cat-2 heuristics (build P0.8; spec §5.1, eval CAT-02).
//
// Code-first: no model call decides a domain the heuristics can decide.
//
//   Cat 1: typed visits, bookmarked domains, repeat visits, real dwell.
//   Cat 2: ad/tracker domains (blocklist), one-touch redirect hops (~0 dwell).
//   Ambiguous: ONE cached cheap call (resolver hook, wired to the tier caller
//   in P1) — cached forever per domain, never repeated (CAT-02 gate).
//
// Safety (spec §5.1): Cat 2 is later + coarser, NEVER dropped; engagement
// (e.g. bookmarking) instantly promotes. Misclassification costs latency,
// never data — so `dropped` exists only for pure tracker redirect hops.
// ===========================================================================

import type { BrowserCategory } from "./envelope.js";
import { domainOf } from "./envelope.js";

// ---- Tracker / ad blocklist ------------------------------------------------

/**
 * Domain suffixes that are ad/tracker infrastructure, never user interest
 * ("user interested in adclick.doubleclick" is the CAT-02 `wrong[]`).
 * Matched on the domain or any parent suffix.
 */
export const TRACKER_SUFFIXES: readonly string[] = [
  "doubleclick.net",
  "googleadservices.com",
  "googlesyndication.com",
  "googletagmanager.com",
  "google-analytics.com",
  "adservice.google.com",
  "adnxs.com",
  "adsrvr.org",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "scorecardresearch.com",
  "quantserve.com",
  "moatads.com",
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "casalemedia.com",
  "amazon-adsystem.com",
  "facebook.net",
  "branch.io",
  "app.link",
  "adjust.com",
  "appsflyer.com",
  "onelink.me",
  "bing.com/aclick",
  "awstrack.me",
  "mailchimp.com/track",
  "list-manage.com",
  "sendgrid.net",
  "click.email",
];

export function isTrackerDomain(domain: string): boolean {
  if (!domain) return false;
  return TRACKER_SUFFIXES.some((s) => domain === s || domain.endsWith(`.${s}`));
}

// ---- Per-domain aggregation ------------------------------------------------

/** What the categorizer looks at, aggregated across a domain's visits. */
export interface DomainStats {
  domain: string;
  visits: number;
  typedVisits: number;
  bookmarked: boolean;
  /** Longest observed dwell, ms. */
  maxDwellMs: number;
  /** Every visit was a redirect hop. */
  allRedirects: boolean;
}

export interface VisitLike {
  url: string;
  typed: boolean;
  redirect: boolean;
  dwellMs: number;
}

/** Fold a window of visits (+ known bookmarked domains) into per-domain stats. */
export function aggregateDomains(
  visits: readonly VisitLike[],
  bookmarkedDomains: ReadonlySet<string> = new Set(),
): Map<string, DomainStats> {
  const map = new Map<string, DomainStats>();
  for (const v of visits) {
    const domain = domainOf(v.url);
    if (!domain) continue;
    let s = map.get(domain);
    if (!s) {
      s = { domain, visits: 0, typedVisits: 0, bookmarked: bookmarkedDomains.has(domain), maxDwellMs: 0, allRedirects: true };
      map.set(domain, s);
    }
    s.visits += 1;
    if (v.typed) s.typedVisits += 1;
    if (!v.redirect) s.allRedirects = false;
    if (v.dwellMs > s.maxDwellMs) s.maxDwellMs = v.dwellMs;
  }
  return map;
}

// ---- Categorizer -----------------------------------------------------------

/** Repeat-visit floor for Cat 1 (spec §5.1 "repeat visits"). */
export const REPEAT_VISITS_MIN = 3;
/** "Real dwell" floor for Cat 1, ms. */
export const REAL_DWELL_MS = 30_000;
/** "~0 dwell" ceiling for the one-touch-redirect Cat-2 rule, ms. */
export const ZERO_DWELL_MS = 1_500;

/**
 * The cached-cheap-call hook for ambiguous domains (spec §5.1). Wired to the
 * tier caller in P1; unit tests inject a counter. Must be cheap to call —
 * the categorizer guarantees at most ONE call per domain per process, cached.
 */
export type AmbiguousResolver = (domain: string, stats: DomainStats) => BrowserCategory;

export class DomainCategorizer {
  private readonly cache = new Map<string, BrowserCategory>();
  private readonly resolver: AmbiguousResolver | null;

  constructor(resolver: AmbiguousResolver | null = null) {
    this.resolver = resolver;
  }

  /** Pure heuristic verdict — null when the code cannot decide. */
  heuristic(stats: DomainStats): BrowserCategory | null {
    if (isTrackerDomain(stats.domain)) return "cat2";
    if (stats.typedVisits > 0) return "cat1";
    if (stats.bookmarked) return "cat1";
    if (stats.visits >= REPEAT_VISITS_MIN) return "cat1";
    if (stats.maxDwellMs >= REAL_DWELL_MS) return "cat1";
    // One-touch redirect hops with ~0 dwell: tracker-shaped even off-blocklist.
    if (stats.allRedirects && stats.maxDwellMs <= ZERO_DWELL_MS) return "cat2";
    return null;
  }

  /**
   * Categorize a domain. Heuristics first; ambiguous domains go to the
   * resolver ONCE and the answer is cached forever (CAT-02: "one cached cheap
   * call, never repeated"). No resolver wired → stays "ambiguous" (treated as
   * Cat 2 for ordering — later, coarser, never dropped).
   */
  categorize(stats: DomainStats): BrowserCategory {
    const hit = this.cache.get(stats.domain);
    if (hit) return hit;
    let cat = this.heuristic(stats);
    if (cat === null) {
      cat = this.resolver ? this.resolver(stats.domain, stats) : "ambiguous";
    }
    this.cache.set(stats.domain, cat);
    return cat;
  }

  /** A later, stronger signal (e.g. a new bookmark) re-decides the domain. */
  invalidate(domain: string): void {
    this.cache.delete(domain);
  }
}

/**
 * Should this visit event be emitted at all? Pure tracker redirect hops with
 * ~0 dwell are the ONE thing the gate drops (CAT-02 "dropped by gate") — they
 * are plumbing, not behaviour. Everything else is kept (Cat 2 ≠ dropped).
 */
export function isDroppableTrackerHop(domain: string, visit: VisitLike): boolean {
  return isTrackerDomain(domain) && visit.redirect && visit.dwellMs <= ZERO_DWELL_MS;
}
