// ===========================================================================
// [CODE] Bundle attempts — three strikes (Product_V6_Phase1 §9.5 / §24.4;
// GoldenEvals BND-11).
//
// A bundle is attempted at most three times: at 0, 5 and 10 minutes. The third
// failure dead-letters it — it is stamped so it stops cycling, listed on
// /api/ops/quarantine, and never retried on its own. The rows live in
// `bundle_attempts` (db/v6core.ts); this file is the schedule and the two
// verbs the dispatcher speaks: "may I run this now?" and "it failed".
//
// A success clears the row. The consumer's per-item salvage path (held events
// failing three times) uses the same table with the same key.
// ===========================================================================

import {
  clearBundleAttempts,
  getBundleAttempt,
  listDeadLetters,
  noteBundleAttempt,
  MAX_BUNDLE_ATTEMPTS,
  type BundleAttemptRow,
  type BundleRef,
} from "../../db/v6core.js";

export { MAX_BUNDLE_ATTEMPTS, listDeadLetters };
export type { BundleAttemptRow, BundleRef };

/** Wait between consecutive attempts: the schedule is 0 · 5 · 10 minutes. */
export const RETRY_DELAY_MS = 5 * 60_000;

export interface AttemptEligibility {
  eligible: boolean;
  deadLettered: boolean;
  /** Epoch ms of the next allowed attempt; null when eligible now or dead. */
  nextAttemptAtMs: number | null;
  attempts: number;
  row: BundleAttemptRow | null;
}

/** Epoch ms the next attempt may run; null for a dead letter. */
export function nextAttemptAtMs(row: BundleAttemptRow | null): number | null {
  if (!row) return null;
  if (row.deadLetterAt) return null;
  if (row.attempts === 0 || !row.lastAttemptAt) return null;
  const last = Date.parse(row.lastAttemptAt);
  return Number.isFinite(last) ? last + RETRY_DELAY_MS : null;
}

/** May this bundle run at `nowMs`? A fresh bundle may; a dead letter never may. */
export function attemptEligibility(ref: BundleRef, nowMs: number): AttemptEligibility {
  const row = getBundleAttempt(ref);
  if (!row) return { eligible: true, deadLettered: false, nextAttemptAtMs: null, attempts: 0, row: null };
  if (row.deadLetterAt) return { eligible: false, deadLettered: true, nextAttemptAtMs: null, attempts: row.attempts, row };
  const next = nextAttemptAtMs(row);
  if (next === null || nowMs >= next) {
    return { eligible: true, deadLettered: false, nextAttemptAtMs: null, attempts: row.attempts, row };
  }
  return { eligible: false, deadLettered: false, nextAttemptAtMs: next, attempts: row.attempts, row };
}

export interface FailedAttempt {
  row: BundleAttemptRow;
  /** True when THIS failure was the third — the bundle is now dead-lettered. */
  deadLettered: boolean;
}

/** Record one failed attempt at `nowMs`. The third sets `dead_letter_at`. */
export function recordFailedAttempt(ref: BundleRef, error: string | null, nowMs: number): FailedAttempt {
  const row = noteBundleAttempt(ref, { error, at: new Date(nowMs).toISOString() });
  return { row, deadLettered: row.deadLetterAt !== null };
}

/** The bundle committed: forget its attempts. */
export function recordSuccess(ref: BundleRef): void {
  clearBundleAttempts(ref);
}
