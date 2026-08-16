// [CODE] The computed contact tier — build item 3.10, arch §14.1.
//
//   inner_circle  bidirectional in ≥8 of the last 12 weeks
//   active        bidirectional in the last 4 weeks
//   dormant       nothing for 3 months
//   archived      nothing for 12 months
//
// The rule is re-derived in the browser for one reason: the surface has to
// print the arithmetic. "inner circle" with no "9 of the last 12 weeks"
// beside it is an unexplained assertion, and §14 says every assertion answers
// "why do you think this?". Deriving it also makes a worker/UI disagreement
// visible instead of invisible — `tierAgreement` is what the surface renders
// when the two differ, rather than quietly preferring one.
//
// The ladder is evaluated STRONGEST FIRST and the thresholds are inclusive at
// the boundary they name (≥8 weeks, ≤4 weeks, ≥3 months, ≥12 months).

import type { ContactStats, PersonTier } from "../../lib/people-client";

export const INNER_CIRCLE_WEEKS = 8;
export const INNER_CIRCLE_WINDOW_WEEKS = 12;
const DAYS_DORMANT = 91; // ~3 months
const DAYS_ARCHIVED = 365; // 12 months

export interface TierDerivation {
  tier: PersonTier;
  /** The measurement that decided it, in words the surface prints verbatim. */
  because: string;
}

/** Re-derive the tier from the measurements, and say which one decided it. */
export function deriveTier(stats: ContactStats): TierDerivation {
  const weeks = stats.bidirectionalWeeks12;
  if (weeks >= INNER_CIRCLE_WEEKS) {
    return {
      tier: "inner_circle",
      because: `both ways in ${weeks} of the last ${INNER_CIRCLE_WINDOW_WEEKS} weeks`,
    };
  }
  if (stats.bidirectionalLast4Weeks) {
    return { tier: "active", because: "both ways within the last 4 weeks" };
  }

  const days = stats.daysSinceContact;
  if (days === null) return { tier: "archived", because: "no contact on record" };
  if (days >= DAYS_ARCHIVED) return { tier: "archived", because: `${days} days since contact` };
  if (days >= DAYS_DORMANT) return { tier: "dormant", because: `${days} days since contact` };

  // Contact inside 3 months but not bidirectional inside 4 weeks: still a
  // live relationship, just a one-sided or slow one. `active` is the honest
  // floor — `dormant` would overstate the silence.
  return { tier: "active", because: `last contact ${days} days ago` };
}

/**
 * Does the browser's derivation agree with the worker's stored tier? Null when
 * it does. A disagreement is a fact about the system and is shown as one.
 */
export function tierAgreement(stored: PersonTier, stats: ContactStats): string | null {
  const derived = deriveTier(stats);
  if (derived.tier === stored) return null;
  return `worker says ${stored}, these numbers say ${derived.tier}`;
}

/** "sent 6 of 10 · ≈ 2× a week" — never a bare ratio (see the header). */
export function reciprocityLabel(stats: ContactStats): string | null {
  if (stats.reciprocity === null) return null;
  const pct = Math.round(stats.reciprocity * 100);
  const window = stats.reciprocityWindow ? ` over ${stats.reciprocityWindow}` : "";
  return `you sent ${pct}%${window}`;
}
