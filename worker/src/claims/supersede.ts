// ===========================================================================
// [CODE] Precedence and supersession — arch §11.6 rules 3–6, build item 3.3.
//
// PURE. Nothing in this file touches the database, a clock or a model. It is
// the algebra `write.ts` applies and the eval executor re-runs: given a set of
// versions of one `claim_key`, which one is active, and given two claims and a
// P-AG3 verdict, who closes whom and when.
//
// THE ONE RULE, STATED THREE WAYS BECAUSE IT HAS BEEN GOT WRONG THREE TIMES
//
//   §11.6 rule 5: "Precedence is keyed on `stated_at` — when it was said —
//   never on write order or ingest time. Writing first must not mean winning."
//
//   1. `ingested_at` NEVER APPEARS HERE.  Not in a comparison, not in a
//      tiebreak, not as a fallback for a missing `stated_at`. It is written by
//      the schema for audit and this module cannot see it (evals R-027).
//
//   2. ARRIVAL ORDER NEVER APPEARS HERE EITHER.  The inputs are labelled
//      `stored` and `incoming`, which is STORAGE, not time. An older claim
//      arriving late is the ordinary case, not the exception: it lands as a
//      PREDECESSOR with a closed window and the newer one stays active
//      (R-021..026). `plan.incomingWins` is computed, never assumed.
//
//   3. THE MODEL'S `later` IS ADVICE.  §12.7 asks P-AG3 which claim describes
//      the later state, and the answer is kept — but when it disagrees with
//      `stated_at`, `stated_at` wins and the disagreement is RECORDED
//      (`laterDisagrees`), never silently taken and never thrown away.
//
// Ties are broken by id descending, which is what `claims_active` in migration
// 0020 does, so this module and the view can never disagree about which of two
// versions said at the same instant is the live one.
// ===========================================================================

import type { Ag3Relation, Ag3Verdict } from "../prompts/p-ag3.js";

/** The columns of `claim_versions` precedence is a function of. */
export interface ClaimVersionLike {
  id: string;
  claimKey: string;
  /** When it was SAID. The only basis for precedence. */
  statedAt: string;
  validFrom?: string | null;
  validTo?: string | null;
  closedBy?: string | null;
  closedReason?: string | null;
  confidence?: number | null;
  text?: string | null;
}

/** Is this version closed — either superseded, or its window has ended? */
export function isClosed(version: ClaimVersionLike, now: string): boolean {
  if (typeof version.closedBy === "string" && version.closedBy !== "") return true;
  const to = version.validTo;
  return typeof to === "string" && to !== "" && to <= now;
}

/**
 * Version order: latest-said first, id descending on a tie.
 *
 * Identical to `claims_active`'s `ORDER BY c2.stated_at DESC, c2.id DESC`.
 * ISO-8601 UTC timestamps sort lexicographically, which is why the schema
 * stores them that way and why no date is parsed here.
 */
export function byStatedAtDesc(a: ClaimVersionLike, b: ClaimVersionLike): number {
  if (a.statedAt !== b.statedAt) return a.statedAt < b.statedAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** The version set of one key, ordered as the view orders it. */
export function orderVersions<T extends ClaimVersionLike>(versions: readonly T[]): T[] {
  return [...versions].sort(byStatedAtDesc);
}

/**
 * The active version of a key: the greatest `stated_at` that is not closed.
 * A pure re-statement of the `claims_active` view, so a caller holding rows in
 * memory gets the same answer the database would give.
 */
export function activeVersion<T extends ClaimVersionLike>(
  versions: readonly T[],
  now: string,
): T | null {
  return orderVersions(versions).find((v) => !isClosed(v, now)) ?? null;
}

/** Every version of the key that is NOT the active one, latest-said first. */
export function predecessors<T extends ClaimVersionLike>(
  versions: readonly T[],
  now: string,
): T[] {
  const active = activeVersion(versions, now);
  return orderVersions(versions).filter((v) => v.id !== active?.id);
}

// ---- who is later ----------------------------------------------------------

export type Precedence = "incoming_later" | "stored_later";

/**
 * Which of two claims describes the LATER state, from `stated_at` alone.
 *
 * The tie goes to the id that `claims_active` would pick, so a pair said at
 * the same instant is resolved the same way here, in the view, and on a replay
 * in any order.
 */
export function precedenceOf(stored: ClaimVersionLike, incoming: ClaimVersionLike): Precedence {
  if (incoming.statedAt !== stored.statedAt) {
    return incoming.statedAt > stored.statedAt ? "incoming_later" : "stored_later";
  }
  return incoming.id > stored.id ? "incoming_later" : "stored_later";
}

// ---- the plan --------------------------------------------------------------

/** What a relation does to the pair. `insert` includes "and ask the user". */
export type SupersedeAction = "reinforce" | "insert" | "supersede";

/** One version to close, and why. Nothing is ever deleted (§11.6 rule 3). */
export interface ClosePlan {
  /** The version whose window ends. Always the EARLIER-SAID of the two. */
  id: string;
  /** The version that closed it — the later-said one. */
  closedBy: string;
  /** `contradiction` / `refinement` — the stored long form of the verdict. */
  closedReason: string;
  /**
   * The validity end. The model's `valid_to` when it gave one, else the later
   * claim's `stated_at`: the world changed no later than the moment somebody
   * said so. Never `now`, and never invented when a date was offered.
   */
  validTo: string;
}

export interface SupersessionPlan {
  relation: Ag3Relation;
  action: SupersedeAction;
  /** True when the incoming claim is the later-said one. From `stated_at` ONLY. */
  incomingWins: boolean;
  /** The id of the later-said claim, whichever side it came from. */
  laterId: string;
  /** The id of the earlier-said claim. */
  earlierId: string;
  /** The window to close, or null when the relation closes nothing. */
  close: ClosePlan | null;
  /** A question is owed to the user — `un` only (§11.6, evals R-020). */
  asksUser: boolean;
  /**
   * The model said one side was later and `stated_at` says the other. Kept as
   * a fact about the verdict; the plan still follows `stated_at`.
   */
  laterDisagrees: boolean;
  /** What the model said, verbatim, carried through for the audit trail. */
  verdict: Ag3Verdict | null;
}

export interface PlanInput {
  /** The version already in `claim_versions`. */
  stored: ClaimVersionLike;
  /** The version the write path is holding. Storage order, not time order. */
  incoming: ClaimVersionLike;
  relation: Ag3Relation;
  /** The model's `valid_to` for the earlier claim, if it gave one. */
  validTo?: string | null;
  /** The model's `later` side, as advice. `A` is stored, `B` is incoming. */
  later?: "A" | "B" | null;
  /** The whole verdict, kept on the plan for the mutation row. */
  verdict?: Ag3Verdict | null;
}

const CLOSING: Readonly<Record<Ag3Relation, boolean>> = {
  duplicate: false,
  refinement: true,
  contradiction: true,
  distinct: false,
  unsure: false,
};

/**
 * Turn a P-AG3 verdict into a plan.
 *
 *   dup → reinforce (the pair is one claim; no row is added)
 *   rfn → supersede, "refined by better evidence"
 *   ctr → supersede + a `valid_to` on the EARLIER-SAID claim
 *   dst → insert, two claims, both live
 *   un  → insert + a question for the user
 *
 * `rfn` and `ctr` differ only in the reason recorded: both close the earlier
 * claim's window and leave the later one active, and WHICH claim is earlier is
 * read off `stated_at` — never off which one this process happens to be
 * holding. That single line is the whole of R-021..026.
 */
export function planSupersession(input: PlanInput): SupersessionPlan {
  const { stored, incoming, relation } = input;
  const precedence = precedenceOf(stored, incoming);
  const incomingWins = precedence === "incoming_later";
  const later = incomingWins ? incoming : stored;
  const earlier = incomingWins ? stored : incoming;

  const modelLater = input.later ?? input.verdict?.later ?? null;
  const modelLaterId = modelLater === "A" ? stored.id : modelLater === "B" ? incoming.id : null;

  const stated = typeof input.validTo === "string" && input.validTo.trim() !== ""
    ? input.validTo.trim()
    : (input.verdict?.validTo ?? null);

  const close: ClosePlan | null = CLOSING[relation]
    ? {
        id: earlier.id,
        closedBy: later.id,
        closedReason: relation,
        validTo: stated !== null && stated !== "" ? stated : later.statedAt,
      }
    : null;

  return {
    relation,
    action: relation === "duplicate" ? "reinforce" : close ? "supersede" : "insert",
    incomingWins,
    laterId: later.id,
    earlierId: earlier.id,
    close,
    asksUser: relation === "unsure",
    laterDisagrees: modelLaterId !== null && modelLaterId !== later.id,
    verdict: input.verdict ?? null,
  };
}

/**
 * The plan for a claim that reached no adjudicator at all — no near hit, so it
 * is simply a new claim standing on its own. Stated as a plan so the write
 * path has one shape to apply and one shape to log.
 */
export function plainInsertPlan(incoming: ClaimVersionLike): SupersessionPlan {
  return {
    relation: "distinct",
    action: "insert",
    incomingWins: true,
    laterId: incoming.id,
    earlierId: incoming.id,
    close: null,
    asksUser: false,
    laterDisagrees: false,
    verdict: null,
  };
}
