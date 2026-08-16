// ===========================================================================
// [CODE] Applying a P-CL1 answer — arch §12.4, §11.4, §11.6. The write half of
// the P-CL1 stage: `./cl1-runner.ts` owns the transport, the batching and the
// budget, `./cl1-pack.ts` builds the call, `./cl1-entity.ts` guards the entity
// foreign keys, and this file owns the rows the answer becomes.
//
// THE WRITE SHAPE IS NOT INVENTED HERE. `confluence/pipeline.ts`'s
// `applyFrozenExtractions` substitutes FROZEN_CLAIMS / FROZEN_LOOPS for exactly
// this stage and is the authoritative spec: CLAIM BEFORE LOOP, per unit,
// through `writeClaim` and the loop state function. What this file adds is that
// the code facts come from `claims/codefacts.ts` — speaker, stated_at, the
// attribution downgrade, party_pair, triage — rather than being assembled
// inline. Those are §11.4's rules and there is no reason for a second copy.
//
// NOTHING HERE EDITS A WORD THE MODEL WROTE (build rule 9). `intent`, `text`,
// `stake`, `direction`, `due` and `recurrence` are stored verbatim; `state`,
// `horizon`, `triage`, `party_pair`, `speaker_id` and `stated_at` are CODE's
// and are never read off the wire.
//
// EVERY ENTITY COLUMN IS WRITTEN THROUGH `./cl1-entity.ts`, and that is not a
// style preference. `subject_id`, `speaker_id`, `owner_id` and
// `counterparty_id` are foreign keys onto `entities`; the packer will mint an
// `a<n>` alias for ANY speaker id it is handed and the parser resolves that
// alias straight back to that id, so an actor whose identity has not been bound
// yet arrives here looking exactly like a roster entity and fails the
// constraint mid-batch. Resolution is verified against the row, unresolvable
// references are counted and written NULL, and a claim with nowhere to sit at
// all is REFUSED — on a personal history, a mis-attributed claim is worse than
// a missing one.
//
// NOT IN SCOPE, STATED: P-CL1 emits no edge tag (`P_CL1_TAGS` is
// Y F P B O I R H W T Q). `FROZEN_EDGES` is P-EP1's output (§12.1 "L EDGES"),
// and P-EP1 has no production runner either. This file writes claims and loops
// and does not pretend to write edges.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { claimCodeFacts, loopCodeFacts } from "../claims/codefacts.js";
import type { Cl1Answer, ExtractedClaim, ExtractedLoop } from "../claims/extract.js";
import { claimKey, claimVersionId, loopIdForKey, loopKey } from "../claims/keys.js";
import { CLAIM_NEAR_HIT_MIN, pickNearHit, writeClaim } from "../claims/write.js";
import { nearHitCandidates, versionsOfKey, type ClaimVersionRow } from "../claims/store.js";
import type { ClaimAdjudicator, ClaimWriteInput, NearCandidate } from "../claims/types.js";
import { similarityRungEnabled } from "../retrieval/calibration.js";
import { P_AG3, buildAg3Prompt, type Ag3Input } from "../prompts/p-ag3.js";
import {
  entityFk,
  resolveEntityRef,
  toEntityId,
  type EntityId,
  type EntityRef,
} from "./cl1-entity.js";
import type { Cl1Context, EventRow } from "./cl1-pack.js";

// The FK boundary and the call builder are separate FILES for the same reason
// this one is: they are re-exported so a caller still has one import site.
export * from "./cl1-entity.js";
export * from "./cl1-pack.js";

/** An async prompt transport — what a real one can actually be. */
export type AsyncPromptInvoke = (prompt: {
  system: string;
  user: string;
  model: string;
}) => Promise<string | null>;

/** `claim_versions.decided_by` for a row this pass produced — `llm:p-ep1`'s convention. */
export const CL1_DECIDER = "llm:p-cl1";

// ---------------------------------------------------------------------------
// The near-hit rung
// ---------------------------------------------------------------------------

/** Calibrated similarities for stored claims about the same subject and kind. */
export type NearHitScorer = (input: ClaimWriteInput, key: string) => readonly NearCandidate[];

/**
 * The production near-hit scorer.
 *
 * The `claim_text` rung needs a MEASURED floor and a vector per stored claim.
 * Nothing writes `claim_embeddings` on a live install, so `similarityRungEnabled`
 * is false, there is no cosine to calibrate, and the honest answer is NO
 * CANDIDATE — which `writeClaim` reads as "insert", never as "duplicate".
 * Returning a guessed number here would be the one thing §7 forbids: an
 * uncalibrated cosine presented as a decision.
 */
export function defaultNearCandidates(): readonly NearCandidate[] {
  if (!similarityRungEnabled("claim_text")) return [];
  // Rung ready but no vector source wired yet — same answer, different reason.
  return [];
}

// ---------------------------------------------------------------------------
// Applying one answer
// ---------------------------------------------------------------------------

export interface Cl1ApplyReport {
  claimsWritten: number;
  claimsReinforced: number;
  claimsAdjudicated: number;
  loopsWritten: number;
  evidenceRows: number;
  ag3Calls: number;
  /** Claims/loops the model emitted citing no event this prompt sent (§12.4). */
  unsupported: number;
  /**
   * Claims REFUSED for having no subject at all — no entity, no hint. A claim
   * that names nobody is not a claim about the user; it is a claim about
   * nobody, and every surface groups by subject. Missing beats mis-attributed.
   */
  claimsRefused: number;
  /**
   * Subject / owner / counterparty references that named something this stage
   * could not bind to an entity — an unbound actor, an off-roster alias, or
   * `self` on an install with no me entity. Written NULL, never guessed, and
   * counted here so "identity binding has not run" is VISIBLE rather than
   * showing up as a quiet drop in claim count.
   */
  unresolvedRefs: number;
  summaries: number;
  questions: number;
  violations: number;
  /**
   * Per-item failures. A claim that threw must not take the rest of its batch
   * with it, and the rows already committed must still be counted — the
   * `claims=0+0` that a live run logged while 13 claims sat on disk was one
   * throw escaping past the fold.
   */
  errors: string[];
}

export function emptyApply(): Cl1ApplyReport {
  return {
    claimsWritten: 0,
    claimsReinforced: 0,
    claimsAdjudicated: 0,
    loopsWritten: 0,
    evidenceRows: 0,
    ag3Calls: 0,
    unsupported: 0,
    claimsRefused: 0,
    unresolvedRefs: 0,
    summaries: 0,
    questions: 0,
    violations: 0,
    errors: [],
  };
}

export interface ApplyOptions {
  now: number;
  runId?: string | null;
  cohortId?: string | null;
  /** Prefetched P-AG3 transport. Absent → a near hit defers, never guesses. */
  ag3?: AsyncPromptInvoke;
  scoreNearHits?: NearHitScorer;
  /** Charge one model call. Returns false when the budget refuses it. */
  spend?: () => boolean;
}

/**
 * Resolve one model-supplied reference, counting what it could not bind.
 *
 * `self` is the wire's RESERVED ALIAS, not an id (§5.2): `targetEntityId` hands
 * it back verbatim, while `claim_versions.subject_id`, `claim_versions.speaker_id`,
 * `loops.owner_id` and `loops.counterparty_id` are all FOREIGN KEYS onto
 * `entities`. So is every roster alias the packer minted for a speaker with no
 * bound entity — that one resolves to an ACTOR id, which looks like a perfectly
 * good reference and is not one. Writing either fails the constraint and takes
 * the rest of the batch with it (the same trap `runs.cohort_id` set for P-EP2).
 *
 * Both come back here as `unbound`: NULL on the row, +1 on the counter, and
 * never an id (§5.2.2, §5.8.6).
 */
function refOf(id: string | null, ctx: Cl1Context, report: Cl1ApplyReport): EntityRef {
  const ref = resolveEntityRef(id, ctx.me);
  if (ref.unbound !== null) report.unresolvedRefs += 1;
  return ref;
}

/** The first cited event that this prompt actually sent — precedence's anchor. */
function anchorEvent(ctx: Cl1Context, eventIds: readonly string[]): EventRow | null {
  for (const id of eventIds) {
    const row = ctx.events.get(id);
    if (row !== undefined) return row;
  }
  return null;
}

/**
 * `ag3InputFor`'s shape, rebuilt here for the same reason `prefetchJudge`
 * rebuilds the P-EP2 prompt: `ClaimAdjudicator` is SYNCHRONOUS and every real
 * transport is not, so the answer is fetched first and replayed. `writeClaim`
 * builds its own prompt from its own copy and parses the answer against it —
 * ONE reader, exactly as P-EP2 does.
 */
function ag3InputFor(
  stored: ClaimVersionRow,
  incoming: ClaimWriteInput,
  incomingId: string,
  similarity: number,
): Ag3Input {
  return {
    subject: { entityId: stored.subjectId, name: stored.subjectHint ?? incoming.subjectHint ?? null },
    stored: {
      id: stored.id,
      tag: incoming.tag ?? "",
      text: stored.text ?? "",
      statedAt: stored.statedAt,
      validFrom: stored.validFrom,
      validTo: stored.validTo,
    },
    incoming: {
      id: incomingId,
      tag: incoming.tag ?? "",
      text: incoming.text,
      statedAt: incoming.statedAt,
      validFrom: incoming.validFrom ?? null,
      validTo: incoming.validTo ?? null,
    },
    similarity,
  };
}

/**
 * WHO THIS CLAIM IS ABOUT — the decision F1 turns on.
 *
 * §11.4's creation rule reads `attribution=first_person AND subject_id ≠
 * speaker_id → downgrade`, and P-CL1's own instructions read "if self says 'I
 * love X', the subject is me". Both say the same thing: under `first_person`
 * the subject IS the speaker. So a `1p` claim that named no subject is not
 * ambiguous — code completes it from `events.actor_entity_id`, which is the
 * one party fact code owns outright, and the claim lands on whoever actually
 * spoke rather than on the user by default.
 *
 * When the speaker is unbound too, nothing is completed: `first_person` is then
 * an UNVERIFIABLE claim of self-reference, and it is downgraded to
 * `about_other` exactly as a mismatch would be. That is the whole of F1 — a
 * counterparty's own words can no longer arrive as the user's first-person
 * fact, because the only way to keep `first_person` is to have an id on both
 * ends and have them agree.
 */
function subjectOf(
  claim: ExtractedClaim,
  stated: EntityRef,
  speakerId: EntityId | null,
): { subjectId: EntityId | null; attribution: string | null } {
  const firstPerson = claim.attribution === "first_person";
  if (stated.id !== null) return { subjectId: stated.id, attribution: claim.attribution };
  if (firstPerson && speakerId !== null) return { subjectId: speakerId, attribution: claim.attribution };
  return { subjectId: null, attribution: firstPerson ? "about_other" : claim.attribution };
}

async function applyClaim(
  claim: ExtractedClaim,
  ctx: Cl1Context,
  opts: ApplyOptions,
  report: Cl1ApplyReport,
): Promise<void> {
  const event = anchorEvent(ctx, claim.eventIds);
  // The speaker is CODE's (§11.4), and it is verified before it is compared to
  // anything: an `events.actor_entity_id` pointing at a merged or missing row
  // is not a speaker.
  const speakerId = toEntityId(event?.actor_entity_id ?? null);
  const stated = refOf(claim.subjectId, ctx, report);
  const { subjectId, attribution } = subjectOf(claim, stated, speakerId);
  const facts = claimCodeFacts(
    {
      subjectId,
      attribution,
      event: event === null ? null : { id: event.id, actorEntityId: speakerId, ts: event.ts },
    },
    { selfEntityId: ctx.me, participantEntityIds: ctx.participants },
  );
  // No event of this prompt → no stated_at → no precedence. §11.6 rule: a
  // claim with nowhere to sit on the timeline is not written, and it is
  // counted so the number is visible rather than absent.
  if (facts.statedAt === null) {
    report.unsupported += 1;
    return;
  }
  // …and no subject and no hint is the same fact one axis over: §11.3 allows a
  // claim to be "a roster entity id, or NULL + subject_hint", never NULL and
  // nothing. Refused, and counted — a claim about nobody reads as a claim about
  // the user on every surface that groups by subject.
  if (subjectId === null && (claim.subjectHint ?? "") === "") {
    report.claimsRefused += 1;
    return;
  }

  const input: ClaimWriteInput = {
    kind: claim.kind,
    tag: claim.tag,
    subjectId: entityFk("claim_versions.subject_id", subjectId),
    subjectHint: claim.subjectHint,
    // §11.6: extraction emits one text field, so the predicate IS the text.
    predicate: claim.text,
    text: claim.text,
    speakerId: entityFk("claim_versions.speaker_id", facts.speakerId),
    attribution: facts.attribution,
    partyPair: facts.partyPair,
    confidence: claim.confidence,
    statedAt: facts.statedAt,
    validFrom: claim.validFrom,
    evidence: claim.eventIds
      .map((id) => ({ id, row: ctx.events.get(id) }))
      .filter((e): e is { id: string; row: EventRow } => e.row !== undefined)
      .map((e) => ({
        eventId: e.id,
        // A VERBATIM quote is the EVENT's words, not the model's paraphrase of
        // them; the claim text is the fallback for a media-only event.
        quote: e.row.text ?? claim.text,
        episodeId: ctx.episodeOfEvent.get(e.id) ?? null,
      })),
  };

  // The near-hit rung, and the ONE case that buys a P-AG3 call (§11.6). An
  // exact key hit is settled by code and never adjudicated, so it is checked
  // first — the same order `writeClaim` checks in, for the same reason.
  const key = claimKey(input);
  const candidates = (opts.scoreNearHits ?? defaultNearCandidates)(input, key);
  let adjudicator: ClaimAdjudicator | null = null;
  if (candidates.length > 0 && opts.ag3 !== undefined && versionsOfKey(key).length === 0) {
    const near = pickNearHit(nearHitCandidates(input, key), candidates);
    if (near !== null && near.similarity >= CLAIM_NEAR_HIT_MIN && opts.spend?.() !== false) {
      const incomingId = claimVersionId(key, input.statedAt, input.text);
      const prompt = buildAg3Prompt(ag3InputFor(near.row, input, incomingId, near.similarity));
      const answer = await opts.ag3({ system: prompt.system, user: prompt.user, model: P_AG3.model });
      report.ag3Calls += 1;
      if (answer !== null) adjudicator = () => ({ response: answer, model: P_AG3.model, calls: 1 });
    }
  }

  const result = writeClaim(input, {
    now: new Date(opts.now).toISOString(),
    runId: opts.runId ?? null,
    decidedBy: CL1_DECIDER,
    candidates,
    adjudicator,
  });
  if (result.route === "adjudicated") report.claimsAdjudicated += 1;
  if (result.created) report.claimsWritten += 1;
  if (result.reinforced) report.claimsReinforced += 1;
  report.evidenceRows += result.evidenceAdded.length;
}

const LOOP_UPSERT = `
INSERT INTO loops (id, loop_key, intent, origin, owner_id, counterparty_id, party_pair, direction,
                   stake, horizon, due_utc, recurrence, next_occurrence_utc, state, state_reason,
                   triage, confidence, stated_at, updated_at)
VALUES (@id, @loopKey, @intent, @origin, @ownerId, @counterpartyId, @partyPair, @direction,
        @stake, @horizon, @dueUtc, @recurrence, @nextOccurrence, @state, @stateReason,
        @triage, @confidence, @statedAt, @updatedAt)
ON CONFLICT(id) DO UPDATE SET
  intent              = excluded.intent,
  origin              = excluded.origin,
  party_pair          = excluded.party_pair,
  direction           = excluded.direction,
  stake               = excluded.stake,
  horizon             = excluded.horizon,
  due_utc             = excluded.due_utc,
  recurrence          = excluded.recurrence,
  next_occurrence_utc = excluded.next_occurrence_utc,
  state               = excluded.state,
  state_reason        = excluded.state_reason,
  triage              = excluded.triage,
  confidence          = MAX(COALESCE(loops.confidence, 0), COALESCE(excluded.confidence, 0)),
  stated_at           = MIN(loops.stated_at, excluded.stated_at),
  updated_at          = excluded.updated_at`;

/**
 * One loop row. `INSERT … ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`:
 * a replace would blank `arc_id` and `resolution_evidence_event_id`, and a loop
 * that has already been placed in an arc or resolved by later evidence must not
 * lose either because it was restated.
 */
function applyLoop(
  loop: ExtractedLoop,
  ctx: Cl1Context,
  opts: ApplyOptions,
  report: Cl1ApplyReport,
): void {
  const event = anchorEvent(ctx, loop.eventIds);
  // A loop keeps its unresolvable ends as NULL rather than being refused: the
  // task test is `owner_id == me` (§11.3.1), so a loop with no owner can never
  // reach the user's Tasks by accident — it lands as `context` and surfaces in
  // its arc. A claim has no such backstop, which is why that one is refused.
  const ownerId = refOf(loop.ownerId, ctx, report).id;
  const counterpartyId = refOf(loop.counterpartyId, ctx, report).id;
  const key = loopKey({
    ownerId,
    ownerHint: loop.ownerHint,
    counterpartyId,
    counterpartyHint: loop.counterpartyHint,
    intent: loop.intent,
  });
  const facts = loopCodeFacts(
    {
      ownerId,
      counterpartyId,
      origin: loop.origin,
      intent: loop.intent,
      dueUtc: loop.due,
      recurrence: loop.recurrence,
      event,
    },
    { selfEntityId: ctx.me, participantEntityIds: ctx.participants },
    opts.now,
  );
  if (facts.statedAt === null) {
    report.unsupported += 1;
    return;
  }

  const id = loopIdForKey(key);
  const stamp = new Date(opts.now).toISOString();
  const db = getDb();
  db.prepare(LOOP_UPSERT).run({
    id,
    loopKey: key,
    intent: loop.intent,
    origin: loop.origin,
    ownerId: entityFk("loops.owner_id", ownerId),
    counterpartyId: entityFk("loops.counterparty_id", counterpartyId),
    partyPair: facts.partyPair,
    direction: loop.direction,
    stake: loop.stake,
    // §11.4: horizon is COMPUTED from due − now. The model's `horizon` field is
    // read and never written back.
    horizon: facts.horizon,
    dueUtc: loop.due,
    recurrence: loop.recurrence,
    nextOccurrence: facts.nextOccurrenceUtc,
    state: facts.state,
    stateReason: facts.stateReason,
    triage: facts.triage,
    confidence: loop.confidence,
    statedAt: facts.statedAt,
    updatedAt: stamp,
  });
  report.loopsWritten += 1;

  const evidence = db.prepare(
    `INSERT OR IGNORE INTO evidence (subject_kind, subject_id, event_id, episode_id, quote)
     VALUES ('loop', ?, ?, ?, ?)`,
  );
  for (const eventId of loop.eventIds) {
    const row = ctx.events.get(eventId);
    if (row === undefined) continue;
    const written = evidence.run(id, eventId, ctx.episodeOfEvent.get(eventId) ?? null, row.text ?? loop.intent);
    report.evidenceRows += written.changes;
  }
}

function describe(what: string, err: unknown): string {
  return `${what}: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Apply ONE parsed answer: claims, then loops, in the order
 * `applyFrozenExtractions` fixes. Serialized by construction — the caller
 * awaits this one batch at a time.
 *
 * TWO PROPERTIES THE COUNTERS DEPEND ON (F3).
 *
 * ONE ITEM NEVER TAKES THE BATCH. A claim that throws is an error ON THE
 * REPORT and the next claim is still attempted. The previous shape let the
 * first FK failure abort the loop, so every later claim AND EVERY LOOP of that
 * batch was lost to one bad subject id — which is exactly how a live run
 * reached `loops = 0`.
 *
 * THE REPORT IS THE CALLER'S. It is passed in, not merely returned, so rows
 * already
 * committed are counted even if this function throws on its way out. A report
 * that understates what is on disk is the same class of bug as one that
 * overstates it, and this stage has now shipped both.
 */
export async function applyCl1Answer(
  answer: Cl1Answer,
  ctx: Cl1Context,
  opts: ApplyOptions,
  report: Cl1ApplyReport = emptyApply(),
): Promise<Cl1ApplyReport> {
  report.unsupported += answer.unsupported.length;
  report.summaries += answer.summaries.length;
  report.questions += answer.questions.length;
  report.violations += answer.violations.length;
  for (const claim of answer.claims) {
    try {
      await applyClaim(claim, ctx, opts, report);
    } catch (err) {
      report.errors.push(describe(`claim line ${claim.line}`, err));
    }
  }
  for (const loop of answer.loops) {
    try {
      applyLoop(loop, ctx, opts, report);
    } catch (err) {
      report.errors.push(describe(`loop line ${loop.line}`, err));
    }
  }
  return report;
}

