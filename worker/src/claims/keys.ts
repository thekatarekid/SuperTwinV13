// ===========================================================================
// [CODE] Claim and loop identity — arch §11.6, build item 3.3.
//
//     claim_key = sha1(kind │ subject_id │ normalize(predicate))
//     loop_key  = sha1(owner_id │ counterparty_id │ normalize(intent))
//
// TWO RULES AND ONE TRAP.
//
//   THE KEY IS WHAT MAKES A REINFORCEMENT POSSIBLE.  Two extractions of the
//   same fact must land on ONE key, or the graph accumulates near-duplicates
//   and every read shows the same thing twice. That is what `normalize` is
//   for, and why it strips articles, punctuation, accents and casing.
//
//   NORMALISATION MUST NEVER MERGE OPPOSITES.  Unlike `arcs/key.ts`, which
//   SORTS its tokens so "Goa trip" and "trip to Goa" are one arc, this
//   normaliser keeps WORD ORDER. "prefers tea over coffee" and "prefers
//   coffee over tea" are not the same claim, and no stemming happens either:
//   "lived in Ratlam" and "lives in Ratlam" are a past and a present tense,
//   which §12.7 spends four lines telling the adjudicator to tell apart. A
//   normaliser that collapsed them would delete that distinction before the
//   model ever saw it.
//
//   THE TRAP: `loop_key` MUST NOT CONTAIN `space_id` OR `arc_id` (§11.6 rule
//   2). Spaces derive FROM loops, so keying a loop on its space is circular —
//   the loop cannot be found again until it is placed, and it cannot be placed
//   until it is found. `loopKey` takes owner, counterparty and intent, and its
//   input type has no other field to give it.
//
// Version ids are DERIVED from content, never minted at random: a re-import of
// the same corpus in a different order has to reproduce the same rows for the
// graph to be confluent (§11.6 rule 6, evals R-028..031).
// ===========================================================================

import { createHash } from "node:crypto";

/**
 * Words that carry no identity of their own. Dropped so "my flat in Koramangala"
 * and "flat in Koramangala" are one key. Deliberately tiny: every word removed
 * here is a distinction the graph can no longer make, and negations, verbs,
 * prepositions and quantifiers all stay.
 */
export const KEY_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "my", "our", "your", "his", "her", "its", "their",
]);

/** The separator between key parts. `│` on the page, a bare pipe in the hash. */
export const KEY_SEPARATOR = "|";

/** Subject/owner/counterparty placeholder for "the model did not say". */
export const ABSENT_PART = "-";

/**
 * `normalize(predicate)` / `normalize(intent)` — lowercase, unaccented,
 * punctuation-free, articles dropped, whitespace collapsed, ORDER PRESERVED.
 */
export function normalizeKeyText(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t !== "" && !KEY_STOPWORDS.has(t))
    .join(" ");
}

/** §11.6's `normalize(predicate)`. */
export function normalizePredicate(predicate: string | null | undefined): string {
  return normalizeKeyText(predicate);
}

/** §11.6's `normalize(intent)`. */
export function normalizeIntent(intent: string | null | undefined): string {
  return normalizeKeyText(intent);
}

/**
 * The identity part for a subject or a party.
 *
 * A resolved entity id is the id. An UNRESOLVED subject keys on its hint,
 * normalised and marked `+`, so two mentions of "Pranjali's landlord" reinforce
 * each other instead of forking — and so neither is ever confused with an id.
 * A name string is never an id (§4.2), and the `+` is what keeps that true here.
 */
export function partyKeyPart(id: string | null | undefined, hint?: string | null): string {
  const real = typeof id === "string" ? id.trim() : "";
  if (real !== "") return real;
  const stem = normalizeKeyText(hint);
  return stem === "" ? ABSENT_PART : `+${stem}`;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

// ---- claims ----------------------------------------------------------------

export interface ClaimKeyInput {
  /** The stored long form — `fact`, `preference`, … The kind IS the tag (§5.3). */
  kind: string;
  /** `claim_versions.subject_id`, or null when the subject is only a hint. */
  subjectId?: string | null;
  /** `claim_versions.subject_hint` — a string, and never an id. */
  subjectHint?: string | null;
  /**
   * The predicate. Extraction emits one text field, so the caller passes the
   * claim text when it has nothing narrower; either way it is what `normalize`
   * runs over, and the same text produces the same key.
   */
  predicate?: string | null;
}

/** `sha1(kind │ subject_id │ normalize(predicate))`, §11.6. */
export function claimKey(input: ClaimKeyInput): string {
  const kind = normalizeKeyText(input.kind);
  const subject = partyKeyPart(input.subjectId, input.subjectHint);
  const predicate = normalizePredicate(input.predicate);
  return sha1([kind, subject, predicate].join(KEY_SEPARATOR));
}

/**
 * The id a version takes. DERIVED from (key, stated_at, text) rather than
 * minted, so re-importing the same corpus in another order reproduces the same
 * row instead of a second one that only differs by a random suffix — which is
 * what makes the confluence cases (R-028..031) comparable at all.
 */
export function claimVersionId(key: string, statedAt: string, text: string | null | undefined): string {
  const stem = sha1(
    [String(key), String(statedAt), normalizeKeyText(text)].join(KEY_SEPARATOR),
  ).slice(0, 16);
  return `clm_${stem}`;
}

// ---- loops -----------------------------------------------------------------

/**
 * Everything `loop_key` is allowed to be built from.
 *
 * There is deliberately no `spaceId` and no `arcId` field: §11.6 rule 2 bans
 * both, and the ban is enforced by the type having nowhere to put them.
 */
export interface LoopKeyInput {
  ownerId?: string | null;
  ownerHint?: string | null;
  counterpartyId?: string | null;
  counterpartyHint?: string | null;
  intent?: string | null;
}

/** The fields §11.6 rule 2 forbids. Asserted in tests, and never read here. */
export const LOOP_KEY_FORBIDDEN_FIELDS: readonly string[] = ["space_id", "arc_id", "spaceId", "arcId"];

/** `sha1(owner_id │ counterparty_id │ normalize(intent))`, §11.6. */
export function loopKey(input: LoopKeyInput): string {
  const owner = partyKeyPart(input.ownerId, input.ownerHint);
  const counterparty = partyKeyPart(input.counterpartyId, input.counterpartyHint);
  const intent = normalizeIntent(input.intent);
  return sha1([owner, counterparty, intent].join(KEY_SEPARATOR));
}

/** The id a loop key mints. Derived, for the same reason claim ids are. */
export function loopIdForKey(key: string): string {
  return `lp_${String(key).slice(0, 16)}`;
}
