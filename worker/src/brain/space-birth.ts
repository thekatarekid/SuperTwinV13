// ===========================================================================
// Space-birth dedupe (V6 P1 S3.7; Product_V6_Phase1 §13.3 "Birth is deduped
// by the critic, even for user-created spaces").
//
// Two halves, both code:
//   1. `findBirthDuplicate(label, goal)` — the mechanical backstop the commit
//      path and (S5.1) the bar's create route consult before minting a space:
//      a live space whose normalized label equals the candidate's, or whose
//      label tokens overlap it at ≥ JACCARD_MIN, is the same space.
//   2. `resolveCriticOverlap(spaceId)` — the critic's `flag_overlap` verdict
//      names the space a proposal duplicates; when that space is live the
//      proposal files INTO it instead of being born beside it.
//
// The near-match list the critic sees (brain/critic.ts nearMatches) is FTS
// over the same labels; this module decides what the verdict does.
// ===========================================================================

import { getDb } from "../db/connection.js";

/** Token-overlap floor for a code-side duplicate (conservative: near-identical labels). */
export const JACCARD_MIN = 0.75;

export interface BirthDuplicate {
  spaceId: string;
  label: string;
  /** How the duplicate was found. */
  via: "exact_label" | "token_overlap" | "critic";
  score: number;
}

const STOP = new Set(["the", "a", "an", "and", "of", "for", "with", "in", "to", "on", "at", "my", "our"]);

export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t !== "")
    .join(" ");
}

export function labelTokens(label: string): Set<string> {
  return new Set(normalizeLabel(label).split(" ").filter((t) => t.length >= 2 && !STOP.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Live spaces: anything not archived or rejected (a proposed space counts). */
function liveSpaces(): { id: string; label: string }[] {
  return getDb()
    .prepare(`SELECT id, label FROM spaces WHERE status NOT IN ('archived','rejected')`)
    .all() as { id: string; label: string }[];
}

/**
 * The live space a new label would duplicate, or null. Exact normalized
 * label first; else the best token overlap at or above JACCARD_MIN.
 */
export function findBirthDuplicate(label: string, _goal?: string | null): BirthDuplicate | null {
  const norm = normalizeLabel(label);
  if (norm === "") return null;
  const tokens = labelTokens(label);
  let best: BirthDuplicate | null = null;
  for (const s of liveSpaces()) {
    if (normalizeLabel(s.label) === norm) {
      return { spaceId: s.id, label: s.label, via: "exact_label", score: 1 };
    }
    const score = jaccard(tokens, labelTokens(s.label));
    if (score >= JACCARD_MIN && (best === null || score > best.score)) {
      best = { spaceId: s.id, label: s.label, via: "token_overlap", score };
    }
  }
  return best;
}

/** The critic's flagged space, if it is a live row a proposal can file into. */
export function resolveCriticOverlap(spaceId: string | null | undefined): BirthDuplicate | null {
  if (!spaceId) return null;
  const row = getDb()
    .prepare(`SELECT id, label FROM spaces WHERE id = ? AND status NOT IN ('archived','rejected')`)
    .get(spaceId) as { id: string; label: string } | undefined;
  return row ? { spaceId: row.id, label: row.label, via: "critic", score: 1 } : null;
}
