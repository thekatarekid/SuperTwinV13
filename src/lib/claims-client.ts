// [CODE] The read/write API behind the Claims surface — arch §14.5, build
// item 3.10.
//
// A claim is the product's understanding made inspectable, so every shape here
// exists to answer one question: **why do you think this?**
//
//  1. NO CLAIM WITHOUT PROVENANCE. `confidence`, `attribution`, `decidedBy`
//     and at least one VERBATIM `evidence` quote travel on every row. The view
//     type makes `evidence` required precisely so a worker that forgets it
//     fails the type, not the reader.
//  2. THE CHAIN IS DATA, NOT A RENDER. `versions` carries every version of the
//     claim key with its supersede reason; the surface browses it (§14.5's
//     HISTORY panel) rather than showing "v3" and hiding v1 and v2.
//  3. A CONFLICT SHIPS THE ADJUDICATOR'S OWN SENTENCE. `reasoning` is P-AG3's
//     text verbatim — never summarised, never truncated by the client
//     (build rule 9).
//  4. `active` VS `superseded` IS A DERIVED READ. `claims_active` is a VIEW in
//     the schema; the client only ever asks for a status, and never writes one.

import { getJson, pathId, qs, sendJson } from "./api-http";
import type { CoverageClient, GestureActor, MutationReceipt } from "./surfaces-client";

// ---------------------------------------------------------------------------
// Vocabulary — the closed sets, mirrored from the worker (§5.3, §11.4)
// ---------------------------------------------------------------------------

/** The kind IS the wire tag (§5.3). Eight, and there is no ninth. */
export const CLAIM_KINDS = [
  "fact",
  "preference",
  "belief",
  "interest",
  "opinion",
  "recommendation",
  "habit",
  "workflow",
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_ATTRIBUTIONS = [
  "first_person",
  "about_other",
  "reported_speech",
  "quoted_third_party",
] as const;
export type ClaimAttribution = (typeof CLAIM_ATTRIBUTIONS)[number];

/** §14.5 prints `1st-person`, not `first_person`. The mapping lives here once. */
export const ATTRIBUTION_LABEL: Readonly<Record<ClaimAttribution, string>> = {
  first_person: "1st-person",
  about_other: "about-other",
  reported_speech: "reported",
  quoted_third_party: "3rd-party",
};

export const CLAIM_STATUSES = ["active", "superseded"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

/** A claim's evidence: the event it came from and the VERBATIM quote (§6). */
export interface ClaimEvidenceView {
  eventId: string;
  quote: string;
  /** Where clicking through lands — the episode the quote was said in. */
  episodeId: string | null;
  at: string | null;
}

/** One rung of the supersede chain (§14.5's HISTORY panel). */
export interface ClaimVersionView {
  id: string;
  /** 1-based, oldest first. The worker numbers it; the surface never counts. */
  version: number;
  text: string;
  status: ClaimStatus;
  /** `events.ts` — when it was SAID. Never `ingested_at` (brief rule 8). */
  statedAt: string;
  /** "refined by better evidence", "original". The stated reason, verbatim. */
  reason: string | null;
  decidedBy: string | null;
  confidence: number | null;
}

export interface ClaimView {
  id: string;
  claimKey: string;
  kind: ClaimKind;
  /** The claim's own words. Never rewritten by this client (build rule 9). */
  text: string;
  subjectId: string | null;
  /** A name string is never an id — a hint renders as a hint. */
  subjectLabel: string;
  subjectIsHint: boolean;
  status: ClaimStatus;
  confidence: number | null;
  attribution: ClaimAttribution | null;
  /** `code:fact`, `agent:p-ag3`, `user` — §1.10's "zero silent guesses". */
  decidedBy: string | null;
  statedAt: string;
  validFrom: string | null;
  validTo: string | null;
  pinned: boolean;
  /** Live output on a still-open session (§14.0b). Marked, never withheld. */
  provisional: boolean;
  /** Required: no evidence → no write (§6), so no evidence → a bug on show. */
  evidence: ClaimEvidenceView[];
  /** Every version of the key, oldest first. Length 1 is an unsuperseded claim. */
  versions: ClaimVersionView[];
}

/** §14.5 groups by subject entity, and the worker owns the grouping. */
export interface ClaimGroupView {
  subjectId: string | null;
  subjectLabel: string;
  claims: ClaimView[];
}

/** A pair the write path could not reconcile — §14.5's conflict queue. */
export interface ClaimConflictView {
  id: string;
  subjectLabel: string;
  /** The incoming claim and the one already stored, both with their quotes. */
  incoming: ClaimView;
  stored: ClaimView;
  /** P-AG3's verdict: contradiction | refinement | unrelated | duplicate. */
  verdict: string | null;
  confidence: number | null;
  /** The adjudicator's OWN sentence. Verbatim (build rule 9). */
  reasoning: string;
  raisedAt: string | null;
}

export type ConflictAnswer = "accept" | "both_true" | "neither";

export interface ClaimsPage {
  /** Per-kind totals for the filter chips — the corpus, not this page. */
  counts: Partial<Record<ClaimKind, number>>;
  conflictCount: number;
  groups: ClaimGroupView[];
  /** Subject options, so the surface never invents a name. */
  subjects: { id: string | null; label: string }[];
}

export interface ClaimQuery {
  kind?: ClaimKind | null;
  subjectId?: string | null;
  attribution?: ClaimAttribution | null;
  status?: ClaimStatus | null;
  /** Below this the claim is hidden. 0 (or absent) hides nothing. */
  minConfidence?: number | null;
  q?: string;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface ClaimsClient extends CoverageClient {
  listClaims(query: ClaimQuery, signal?: AbortSignal): Promise<ClaimsPage>;
  listConflicts(signal?: AbortSignal): Promise<ClaimConflictView[]>;
  answerConflict(
    p: GestureActor & { id: string; answer: ConflictAnswer },
  ): Promise<MutationReceipt>;
  pinClaim(p: GestureActor & { id: string; pinned: boolean }): Promise<MutationReceipt>;
  /** Rejection TEACHES: it writes a user-sourced claim, it does not delete. */
  rejectClaim(p: GestureActor & { id: string; reason: string }): Promise<MutationReceipt>;
  correctClaim(p: GestureActor & { id: string; text: string }): Promise<MutationReceipt>;
  splitClaim(p: GestureActor & { id: string; texts: string[] }): Promise<MutationReceipt>;
}

export const claimsClient: ClaimsClient = {
  getCoverage: (signal) => getJson("/api/coverage", signal),

  listClaims: (query, signal) =>
    getJson<ClaimsPage>(
      `/api/claims${qs({
        kind: query.kind ?? undefined,
        subject: query.subjectId ?? undefined,
        attribution: query.attribution ?? undefined,
        status: query.status ?? undefined,
        minConfidence:
          query.minConfidence !== undefined && query.minConfidence !== null && query.minConfidence > 0
            ? String(query.minConfidence)
            : undefined,
        q: query.q,
      })}`,
      signal,
    ),

  listConflicts: (signal) => getJson<ClaimConflictView[]>("/api/claims/conflicts", signal),

  answerConflict: ({ id, answer, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/claims/conflicts/${pathId(id)}`, { answer, actor }),

  pinClaim: ({ id, pinned, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/claims/${pathId(id)}/pin`, { pinned, actor }),

  rejectClaim: ({ id, reason, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/claims/${pathId(id)}/reject`, { reason, actor }),

  correctClaim: ({ id, text, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/claims/${pathId(id)}/correct`, { text, actor }),

  splitClaim: ({ id, texts, actor }) =>
    sendJson<MutationReceipt>("POST", `/api/claims/${pathId(id)}/split`, { texts, actor }),
};
