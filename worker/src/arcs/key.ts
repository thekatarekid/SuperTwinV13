// ===========================================================================
// [CODE] Arc anchors and arc identity — arch §11.2, build item 2.5.
//
//     arc_key = sha1(sorted(top-3 anchor_entity_ids) │ normalize(label_stem))
//
// "Arc-id stability is the point of `arc_key`. As older cohorts land and arcs
// grow, re-derivation rebinds to the same ids, so labels, pins, spaces and user
// corrections survive the entire import."
//
// Two things live here and nothing else does:
//
//   IDENTITY   `arcKey` and `arcIdForKey`. The id is DERIVED from the key, not
//              minted at random, so a re-derivation that produces the same key
//              lands on the same id even on a database that has never seen the
//              arc before. Reconcile still looks the key up first, because an
//              arc whose key has since MOVED (a user relabel, a fourth anchor
//              outgrowing the third) must keep the id it was surfaced under.
//
//   WEIGHT     the anchor weights of rung ②. §11.2: "person/place/occasion 1.0
//              · product/service/media 0.7 · topic 0.4". The three tiers are
//              who/where/when (an anchor), the concrete matter (a thing), and
//              what it is *about* (a topic, which drifts). The closed entity
//              type set (§4.1) has three types §11.2 does not name — `group`,
//              `org`, `document` — and they are placed by that same reasoning
//              and not by preference: a group IS a set of people, an org is a
//              counterparty like a vendor, a document is a concrete artefact.
//
// Rung ② is not just a number. "Topics drift, people anchor" (evals L-017): an
// overlap made ENTIRELY of shared topic entities does not join, whatever the
// ratio comes to, because two afternoons that share only "travel" share
// nothing. `overlapJoins` is where that is enforced.
// ===========================================================================

import { createHash } from "node:crypto";

/** §11.2 — the key is built from the three strongest anchors, no more. */
export const ANCHOR_KEY_COUNT = 3;

/** §11.2 rung ② — "weighted Jaccard ≥ 0.5". */
export const ARC_OVERLAP_MIN = 0.5;

/**
 * Floating point mercy on the bar itself. Evals L-011 poses exactly 0.50 and
 * expects a join; a ratio that is 0.49999999999999994 in binary must not turn
 * a stated 0.5 into a refusal.
 */
export const OVERLAP_EPSILON = 1e-9;

/** The weakest tier. A shared topic alone is not evidence of a shared matter. */
export const TOPIC_WEIGHT = 0.4;

/** §11.2, over the closed entity type set of §4.1. */
export const ANCHOR_WEIGHTS: Readonly<Record<string, number>> = {
  person: 1,
  group: 1,
  place: 1,
  occasion: 1,
  org: 0.7,
  thing: 0.7,
  media_work: 0.7,
  document: 0.7,
  topic: TOPIC_WEIGHT,
};

/**
 * A type this build does not know is treated as the WEAKEST tier, never the
 * strongest. An unrecognised type is not evidence that a person was there, and
 * the cost of being wrong upward (a false arc merge) is the one §11.2 spends
 * the whole ladder avoiding.
 */
export const UNKNOWN_ANCHOR_WEIGHT = TOPIC_WEIGHT;

/** One entity as an arc anchor. `count` is how often it was seen, if known. */
export interface AnchorRef {
  entityId: string;
  /** An `entities.type` value. Unknown values fall to the weakest tier. */
  type?: string | null;
  count?: number;
}

export function anchorWeight(type: string | null | undefined): number {
  if (typeof type !== "string") return UNKNOWN_ANCHOR_WEIGHT;
  const w = ANCHOR_WEIGHTS[type];
  return typeof w === "number" ? w : UNKNOWN_ANCHOR_WEIGHT;
}

// ---- label stems -----------------------------------------------------------

/**
 * Words that carry no identity. Dropping them is what makes "the Goa trip" and
 * "Goa trip" one key instead of two, which is the whole reason a *stem* is
 * hashed rather than the label.
 */
export const LABEL_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "at", "for", "from", "in", "into", "of", "on", "or", "our",
  "the", "this", "that", "to", "with", "my", "his", "her", "their", "its",
]);

/**
 * `normalize(label_stem)` — lowercase, unaccented, punctuation-free, stopwords
 * dropped, duplicates dropped, tokens SORTED.
 *
 * Sorting is deliberate. "Goa trip" and "trip to Goa" are one thread named two
 * ways across two cohorts, and an id that changed because a later cohort said
 * it the other way round would break the one property this file exists for.
 */
export function normaliseLabelStem(label: string | null | undefined): string {
  if (typeof label !== "string") return "";
  const tokens = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t !== "" && !LABEL_STOPWORDS.has(t));
  return [...new Set(tokens)].sort().join(" ");
}

// ---- anchor ranking --------------------------------------------------------

interface RankedAnchor {
  entityId: string;
  weight: number;
  count: number;
}

/** Fold repeats: one row per entity, the strongest weight and the total count. */
export function foldAnchors(anchors: readonly AnchorRef[]): Map<string, RankedAnchor> {
  const folded = new Map<string, RankedAnchor>();
  for (const anchor of anchors) {
    const id = typeof anchor?.entityId === "string" ? anchor.entityId.trim() : "";
    if (id === "") continue;
    const weight = anchorWeight(anchor.type);
    const count = Number.isFinite(anchor.count) ? Math.max(0, Number(anchor.count)) : 1;
    const held = folded.get(id);
    if (held === undefined) folded.set(id, { entityId: id, weight, count });
    else {
      held.weight = Math.max(held.weight, weight);
      held.count += count;
    }
  }
  return folded;
}

/**
 * Anchors in significance order: strongest tier first, then most-seen, then by
 * id so two runs over the same set never disagree.
 */
export function rankAnchors(anchors: readonly AnchorRef[]): string[] {
  return [...foldAnchors(anchors).values()]
    .sort((a, b) => b.weight - a.weight || b.count - a.count || (a.entityId < b.entityId ? -1 : 1))
    .map((a) => a.entityId);
}

/** `sorted(top-3 anchor_entity_ids)` — ranked, cut to three, then sorted. */
export function topAnchorIds(anchors: readonly AnchorRef[], n: number = ANCHOR_KEY_COUNT): string[] {
  return rankAnchors(anchors).slice(0, Math.max(0, n)).sort();
}

// ---- the key ---------------------------------------------------------------

/** `sha1(sorted(top-3 anchor_entity_ids) │ normalize(label_stem))`, §11.2. */
export function arcKey(anchors: readonly AnchorRef[], label: string | null | undefined): string {
  const ids = topAnchorIds(anchors);
  return createHash("sha1").update(`${ids.join(",")}|${normaliseLabelStem(label)}`).digest("hex");
}

/**
 * The id a key mints when no arc holds it yet. Derived rather than random so a
 * full re-derivation on a fresh database reproduces the same ids — evals
 * L-032..L-035. Reconcile still prefers an existing row with the same key.
 */
export function arcIdForKey(key: string): string {
  return `arc_${String(key).slice(0, 16)}`;
}

// ---- rung ② ----------------------------------------------------------------

export interface OverlapMeasure {
  score: number;
  /** Entity ids on both sides, sorted. */
  shared: string[];
  /** The heaviest tier present in `shared`. 0 when nothing is shared. */
  sharedTopWeight: number;
  /** True when everything shared is topic-tier — "topics drift" (L-017). */
  topicOnly: boolean;
}

/**
 * Weighted Jaccard over two anchor sets: shared weight over union weight, with
 * each entity counted once at the strongest tier either side gave it.
 */
export function weightedOverlap(a: readonly AnchorRef[], b: readonly AnchorRef[]): OverlapMeasure {
  const left = foldAnchors(a);
  const right = foldAnchors(b);
  const shared: string[] = [];
  let intersection = 0;
  let union = 0;
  let sharedTopWeight = 0;

  const ids = new Set([...left.keys(), ...right.keys()]);
  for (const id of ids) {
    const l = left.get(id);
    const r = right.get(id);
    const weight = Math.max(l?.weight ?? 0, r?.weight ?? 0);
    union += weight;
    if (l !== undefined && r !== undefined) {
      intersection += weight;
      shared.push(id);
      sharedTopWeight = Math.max(sharedTopWeight, weight);
    }
  }

  shared.sort();
  return {
    score: union === 0 ? 0 : intersection / union,
    shared,
    sharedTopWeight,
    topicOnly: shared.length > 0 && sharedTopWeight <= TOPIC_WEIGHT,
  };
}

/**
 * Does rung ② fire? The ratio must clear 0.5 AND the shared set must contain
 * something stronger than a topic. Evals L-009/L-010 (below the bar) fail on
 * the first test; L-017 (a perfect ratio made only of shared topics) fails on
 * the second, which is §11.2's "topics drift, people anchor" as code.
 */
export function overlapJoins(measure: OverlapMeasure): boolean {
  if (measure.shared.length === 0) return false;
  if (measure.score + OVERLAP_EPSILON < ARC_OVERLAP_MIN) return false;
  return !measure.topicOnly;
}
