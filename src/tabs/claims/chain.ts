// [CODE] Supersede chains and provenance completeness — arch §14.5, build
// item 3.10.
//
// Two small rules, both of which the surface would otherwise get wrong by
// accident:
//
//  1. A CHAIN IS ORDERED BY `stated_at`, NEWEST FIRST — and by NOTHING ELSE.
//     `ingested_at` is never compared for precedence (brief rule 8), and the
//     array order the worker happened to serialise is not an order. Ties break
//     on the version number so the display is stable.
//  2. PROVENANCE IS ALL-OR-NOTHING. §14 asks every assertion to answer "why do
//     you think this?", so a claim missing confidence, attribution, decided_by
//     or a verbatim quote is INCOMPLETE, and the surface says which piece is
//     missing rather than rendering a confident-looking row with a blank.

import { ATTRIBUTION_LABEL, type ClaimView, type ClaimVersionView } from "../../lib/claims-client";

/** The chain, newest first. `versions[0]` is the version now in force. */
export function chainNewestFirst(claim: ClaimView): ClaimVersionView[] {
  return [...claim.versions].sort((a, b) => {
    if (a.statedAt !== b.statedAt) return a.statedAt < b.statedAt ? 1 : -1;
    return b.version - a.version;
  });
}

/** A single-version claim has no history worth a panel. */
export function hasChain(claim: ClaimView): boolean {
  return claim.versions.length > 1;
}

/** Which provenance fields are missing. Empty means the claim is fully explained. */
export function missingProvenance(claim: ClaimView): string[] {
  const gaps: string[] = [];
  if (claim.confidence === null || claim.confidence === undefined) gaps.push("confidence");
  if (!claim.attribution) gaps.push("attribution");
  if (!claim.decidedBy) gaps.push("decided_by");
  if (claim.evidence.length === 0) gaps.push("evidence quote");
  return gaps;
}

/** `0.95 · 1st-person · agent:p-cl1` — the one-line provenance stamp. */
export function provenanceLine(claim: ClaimView): string {
  const parts: string[] = [];
  parts.push(claim.confidence === null ? "confidence —" : claim.confidence.toFixed(2));
  parts.push(claim.attribution ? ATTRIBUTION_LABEL[claim.attribution] : "attribution —");
  parts.push(claim.decidedBy ?? "decided_by —");
  return parts.join(" · ");
}
