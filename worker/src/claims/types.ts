// ===========================================================================
// [CODE] The write path's vocabulary — arch §11.6. Build item 3.3.
//
// Input and option shapes only, in their own file so `write.ts` (the path),
// `store.ts` (the reads) and `undo.ts` (the reverse replay) can share them
// without any of the three importing another's implementation.
// ===========================================================================

import type { Ag3Input, Ag3Prompt } from "../prompts/p-ag3.js";
import type { ClaimKeyInput } from "./keys.js";

// ---- inputs ----------------------------------------------------------------

export interface ClaimEvidenceInput {
  eventId: string;
  /** A VERBATIM quote. No evidence → no write (§6). */
  quote: string;
  episodeId?: string | null;
}

export interface ClaimWriteInput extends ClaimKeyInput {
  /** The wire tag (`F`, `P`, …) — shown to P-AG3, since the kind IS the tag. */
  tag?: string | null;
  object?: string | null;
  /** The model's words, verbatim. Never rewritten (build rule 9). */
  text: string;
  speakerId?: string | null;
  addresseeId?: string | null;
  attribution?: string | null;
  partyPair?: string | null;
  confidence?: number | null;
  /** `events.ts` — when it was SAID. The whole basis of precedence. */
  statedAt: string;
  validFrom?: string | null;
  validTo?: string | null;
  evidence?: readonly ClaimEvidenceInput[];
}

/** One stored claim the caller measured against the incoming one. */
export interface NearCandidate {
  claimId: string;
  /** The CALIBRATED score. Never a raw cosine, never a guess. */
  similarity: number;
}

export interface Ag3Request {
  prompt: Ag3Prompt;
  input: Ag3Input;
  storedId: string;
  incomingId: string;
}

export interface Ag3Response {
  /** The model's answer, verbatim. */
  response: string;
  model?: string;
  calls?: number;
}

/** P-AG3's caller implements this. The write path never talks to a provider. */
export type ClaimAdjudicator = (req: Ag3Request) => Ag3Response | null;

export interface WriteOptions {
  runId?: string | null;
  actor?: string;
  /** The instant `valid_to` windows are compared against. Frozen in tests. */
  now?: string;
  adjudicator?: ClaimAdjudicator | null;
  /** Calibrated similarities for stored claims about the same subject+kind. */
  candidates?: readonly NearCandidate[];
  /** `agent:p-ag3`, `user`, … Recorded on the row the decision produced. */
  decidedBy?: string | null;
}
