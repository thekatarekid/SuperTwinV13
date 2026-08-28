// ===========================================================================
// Tab-chain stream keys (build P0.8).
//
// A "stream" for the browser source is a navigation chain: visits linked by
// referrer (from_visit / redirect_source), split by a 30-minute inactivity
// gap. History DBs carry no live tab id, so the chain root IS the tab
// surrogate — a new root (no referrer in sight, or a gap) is a new chain.
//
// The stream key is deterministic from the chain's ROOT visit
// (`browser:<browser>:chain:<hash(root url + root ts)>`), so re-reading the
// same history rows on the next poll reproduces the same keys — required for
// idempotent append.
// ===========================================================================

import { browserContentHash } from "./envelope.js";
import type { RawVisit } from "./history-db.js";

export const CHAIN_GAP_MS = 30 * 60 * 1000;

export interface ChainedVisit extends RawVisit {
  streamKey: string;
  /** URL of the referring visit within the read window, null when root. */
  referrerUrl: string | null;
  /** Dwell after gap-inference (fills Safari's unknown 0 from the next visit). */
  inferredDwellMs: number;
}

/**
 * Assign every visit a chain stream key.
 *
 * Rules, in order:
 *   1. referrer link (from_visit) to a visit in the window → same chain,
 *      UNLESS the gap to the referrer exceeds CHAIN_GAP_MS (stale parent —
 *      e.g. a tab reopened next morning starts a new chain);
 *   2. otherwise → this visit roots a new chain.
 *
 * Also infers dwell for sources that do not record it (Safari): gap to the
 * next visit in the same chain, capped at CHAIN_GAP_MS.
 */
export function assignChains(visits: readonly RawVisit[], gapMs: number = CHAIN_GAP_MS): ChainedVisit[] {
  const sorted = [...visits].sort((a, b) => a.tsMs - b.tsMs || a.visitId - b.visitId);
  const byId = new Map<string, RawVisit>();
  for (const v of sorted) byId.set(`${v.browser}:${v.visitId}`, v);

  const chainOf = new Map<string, string>(); // visit key -> stream key
  const out: ChainedVisit[] = [];

  for (const v of sorted) {
    const selfKey = `${v.browser}:${v.visitId}`;
    const refKey = v.referrerVisitId ? `${v.browser}:${v.referrerVisitId}` : null;
    const ref = refKey ? byId.get(refKey) : undefined;

    let streamKey: string | undefined;
    if (ref && v.tsMs - ref.tsMs <= gapMs) {
      streamKey = chainOf.get(refKey!);
    }
    if (!streamKey) {
      streamKey = `browser:${v.browser}:chain:${browserContentHash([v.browser, v.url, v.tsMs]).slice(0, 16)}`;
    }
    chainOf.set(selfKey, streamKey);
    out.push({
      ...v,
      streamKey,
      referrerUrl: ref ? ref.url : null,
      inferredDwellMs: v.dwellMs,
    });
  }

  // ---- Dwell inference (per chain, chronological): a 0-dwell visit gets the
  // gap to the NEXT visit in the same chain, capped. The last visit of a chain
  // keeps 0 — "still open / unknown" is honest.
  const lastByChain = new Map<string, ChainedVisit>();
  for (const v of out) {
    const prev = lastByChain.get(v.streamKey);
    if (prev && prev.inferredDwellMs === 0) {
      prev.inferredDwellMs = Math.min(v.tsMs - prev.tsMs, gapMs);
    }
    lastByChain.set(v.streamKey, v);
  }
  return out;
}
