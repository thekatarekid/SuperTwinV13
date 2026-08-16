// [CODE] The read/write API behind the People surface — arch §14.1/§14.8,
// build item 3.10.
//
// People is Entities narrowed to `person`, plus everything the twin knows
// about the RELATIONSHIP. Three rules shape the types:
//
//  1. THE TIER IS COMPUTED, NOT DECLARED. The worker ships the counts the rule
//     runs on (`bidirectionalWeeks12`, `lastBidirectionalAt`, …) alongside the
//     tier it computed, so the surface can show its work — and does, via
//     `people/tier.ts`, which re-derives it. A tier badge with no arithmetic
//     behind it is exactly the kind of unexplained assertion §14 forbids.
//  2. A PERSON HAS THREADS, NOT TASKS. There is no task list and no priority
//     on this surface (item 3.10): another person's loops belong in the
//     relationship, never in yours. `openLoops` is split by DIRECTION and both
//     halves are labelled as context.
//  3. RECIPROCITY AND RHYTHM ARE MEASURED VALUES. Every one of them arrives
//     with the window it was measured over, so "reciprocity 0.6" is never a
//     number without a denominator.

import { getJson, pathId, qs, sendJson } from "./api-http";
import type { CoverageClient, GestureActor, MutationReceipt } from "./surfaces-client";

// ---------------------------------------------------------------------------
// Tier
// ---------------------------------------------------------------------------

export const PERSON_TIERS = ["inner_circle", "active", "dormant", "archived"] as const;
export type PersonTier = (typeof PERSON_TIERS)[number];

export const TIER_LABEL: Readonly<Record<PersonTier, string>> = {
  inner_circle: "inner circle",
  active: "active",
  dormant: "dormant",
  archived: "archived",
};

/**
 * The measurements the tier rule runs on (item 3.10). They ship with the
 * person so the surface can re-derive the tier and print the arithmetic.
 */
export interface ContactStats {
  /** Weeks, of the last 12, with traffic in BOTH directions. */
  bidirectionalWeeks12: number;
  /** Any bidirectional exchange in the last 4 weeks. */
  bidirectionalLast4Weeks: boolean;
  /** Days since the last contact in either direction. Null: never. */
  daysSinceContact: number | null;
  /** Sent / (sent + received) over the measured window. */
  reciprocity: number | null;
  reciprocityWindow: string | null;
  /** "≈ 2× a week", the worker's phrasing of the observed cadence. */
  rhythmLabel: string | null;
}

// ---------------------------------------------------------------------------
// The person
// ---------------------------------------------------------------------------

export interface PersonIdentityView {
  id: string;
  kind: string;
  /** Already elided by the worker — "9177…03", never the full number. */
  value: string;
  sourceLabel: string | null;
  decidedBy: string | null;
}

export interface PersonClaimView {
  id: string;
  kind: string;
  text: string;
  confidence: number | null;
  attribution: string | null;
  decidedBy: string | null;
  /** VERBATIM. No claim renders on this surface without one (§6). */
  quote: string;
  eventId: string | null;
}

export interface PersonThreadView {
  arcId: string;
  label: string;
  state: string;
  lastActiveAt: string | null;
}

export interface PersonSpaceView {
  spaceId: string;
  label: string;
  archetype: string | null;
}

/** An open loop in the relationship. Direction decides which half it is in. */
export interface PersonLoopView {
  id: string;
  intent: string;
  /** `you_owe_them` or `they_owe_you`. Context on this surface either way. */
  direction: "you_owe_them" | "they_owe_you";
  dueLabel: string | null;
  quote: string;
}

export interface PersonRecommendationView {
  claimId: string;
  text: string;
  at: string | null;
  quote: string;
}

export interface PersonTimelineEntry {
  at: string;
  /** "first message", "met in person", "moved to Indiranagar" — the worker's. */
  label: string;
  sourceLabel: string | null;
}

export interface PersonView {
  id: string;
  label: string;
  /** "sister", "colleague at Acme" — a claim, and it carries its evidence. */
  relationship: string | null;
  relationshipQuote: string | null;
  tier: PersonTier;
  stats: ContactStats;
  pinned: boolean;
  provisional: boolean;
  identities: PersonIdentityView[];
  claims: PersonClaimView[];
  threads: PersonThreadView[];
  sharedSpaces: PersonSpaceView[];
  openLoops: PersonLoopView[];
  recommendations: PersonRecommendationView[];
  timeline: PersonTimelineEntry[];
}

export interface PeoplePage {
  counts: Record<PersonTier, number>;
  people: PersonView[];
}

export interface PeopleQuery {
  tier?: PersonTier | null;
  q?: string;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface PeopleClient extends CoverageClient {
  listPeople(query: PeopleQuery, signal?: AbortSignal): Promise<PeoplePage>;
  pinPerson(p: GestureActor & { id: string; pinned: boolean }): Promise<MutationReceipt>;
  renamePerson(p: GestureActor & { id: string; canonical: string }): Promise<MutationReceipt>;
}

export const peopleClient: PeopleClient = {
  getCoverage: (signal) => getJson("/api/coverage", signal),

  listPeople: (query, signal) =>
    getJson<PeoplePage>(
      `/api/people${qs({ tier: query.tier ?? undefined, q: query.q })}`,
      signal,
    ),

  pinPerson: ({ id, pinned, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/people/${pathId(id)}/pin`, { pinned, actor }),

  renamePerson: ({ id, canonical, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/people/${pathId(id)}/rename`, { canonical, actor }),
};
