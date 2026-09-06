// ===========================================================================
// Stream keys (V6 P1 S3.4) and browser chains.
//
// The canonical key shapes for every source live in ../stream-keys.ts and are
// re-exported here because the build plan names this file as their home:
//
//   wa:<jid> · browser:<browser>:<profile>:<domain>:<day> ·
//   screen:<bundleId>:<session> · doc:<path>
//
// For the browser, a stream is ONE DOMAIN ON ONE (UTC) DAY (Product_V6 §11.1,
// T2-10 — the re-key measured 2,436 → 643 streams and 1.4 → 5.4 events per
// call over the P0.8 per-chain keys). The referrer chain (from_visit /
// redirect_source, split by a 30-minute gap) is still computed: it tells us
// which visit a page came from (`referrerUrl`) and lets Safari's unknown
// dwell be inferred from the next hop, but it no longer names the stream.
//
// Keys are deterministic from the visit's own facts, so re-reading the same
// history rows on the next poll reproduces the same keys — required for
// idempotent append.
// ===========================================================================

import { domainOf } from "./envelope.js";
import type { RawVisit } from "./history-db.js";
import { browserStreamKey, utcDayOf } from "../stream-keys.js";

export {
  browserStreamKey,
  DEFAULT_BROWSER_PROFILE,
  docPathOf,
  docStreamKey,
  normaliseProfile,
  parseStreamKey,
  SCREEN_SESSION_GAP_MS,
  ScreenSessionTracker,
  screenStreamKey,
  sessionIdOf,
  sessionStartMs,
  UNKNOWN_DOMAIN,
  utcDayOf,
  waStreamKey,
  type ParsedStreamKey,
  type ScreenSessionSeed,
} from "../stream-keys.js";

export const CHAIN_GAP_MS = 30 * 60 * 1000;

export interface ChainedVisit extends RawVisit {
  /** `browser:<browser>:<profile>:<domain>:<day>`. */
  streamKey: string;
  /** Referrer chain this visit belongs to (root visit's key); dwell inference runs per chain. */
  chainId: string;
  /** URL of the referring visit within the read window, null when root. */
  referrerUrl: string | null;
  /** Dwell after gap-inference (fills Safari's unknown 0 from the next visit). */
  inferredDwellMs: number;
}

export interface AssignChainsOptions {
  /** Browser profile directory (`Default`, `Profile 1`); Safari passes its one profile. */
  profile?: string;
  /** Referrer gap that starts a new chain. Default CHAIN_GAP_MS. */
  gapMs?: number;
  /** Day slot of a visit. Default: UTC calendar day (as the day-bundler). */
  dayOf?: (tsMs: number) => string;
}

/**
 * Assign every visit its stream key and its referrer chain.
 *
 * Stream key: `browser:<browser>:<profile>:<domain>:<day>` — the visit's own
 * facts, nothing from its neighbours.
 *
 * Chain (for `referrerUrl` and dwell inference), in order:
 *   1. referrer link (from_visit) to a visit in the window → same chain,
 *      UNLESS the gap to the referrer exceeds gapMs (stale parent — e.g. a
 *      tab reopened next morning starts a new chain);
 *   2. otherwise → this visit roots a new chain.
 *
 * Dwell for sources that do not record it (Safari): gap to the next visit in
 * the same chain, capped at gapMs; the last hop keeps 0 ("still open").
 */
export function assignChains(visits: readonly RawVisit[], opts: AssignChainsOptions = {}): ChainedVisit[] {
  const gapMs = opts.gapMs ?? CHAIN_GAP_MS;
  const dayOf = opts.dayOf ?? utcDayOf;
  const sorted = [...visits].sort((a, b) => a.tsMs - b.tsMs || a.visitId - b.visitId);
  const byId = new Map<string, RawVisit>();
  for (const v of sorted) byId.set(`${v.browser}:${v.visitId}`, v);

  const chainOf = new Map<string, string>(); // visit key -> chain id
  const out: ChainedVisit[] = [];

  for (const v of sorted) {
    const selfKey = `${v.browser}:${v.visitId}`;
    const refKey = v.referrerVisitId ? `${v.browser}:${v.referrerVisitId}` : null;
    const ref = refKey ? byId.get(refKey) : undefined;

    let chainId: string | undefined;
    if (ref && v.tsMs - ref.tsMs <= gapMs) chainId = chainOf.get(refKey!);
    if (!chainId) chainId = selfKey;
    chainOf.set(selfKey, chainId);

    out.push({
      ...v,
      streamKey: browserStreamKey(v.browser, opts.profile, domainOf(v.url), dayOf(v.tsMs)),
      chainId,
      referrerUrl: ref ? ref.url : null,
      inferredDwellMs: v.dwellMs,
    });
  }

  // ---- Dwell inference (per chain, chronological): a 0-dwell visit gets the
  // gap to the NEXT visit in the same chain, capped. The last visit of a chain
  // keeps 0 — "still open / unknown" is honest.
  const lastByChain = new Map<string, ChainedVisit>();
  for (const v of out) {
    const prev = lastByChain.get(v.chainId);
    if (prev && prev.inferredDwellMs === 0) {
      prev.inferredDwellMs = Math.min(v.tsMs - prev.tsMs, gapMs);
    }
    lastByChain.set(v.chainId, v);
  }
  return out;
}
