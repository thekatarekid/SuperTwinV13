// ===========================================================================
// [CODE] Code facts — arch §11.4 "ALSO AT CREATION". Build item 3.2.
//
// Deterministic, zero model calls. These are the fields a model is never asked
// for and never allowed to write: `speaker_id`, `stated_at`, `party_pair`,
// `triage`, `state`. P-CL1 is told so in its own words — "State, triage and
// party_pair are NEVER yours to write. Code derives all three."
//
// GROUND TRUTH, NOT A FILTER. This module is what the model's answer is
// RECONCILED AGAINST. It never deletes a claim, never edits a word of text and
// never suppresses a loop. The one thing it changes is a single enum —
// `attribution` — and even then it raises a flag saying it did (build rule 9).
//
// THE FOUR CREATION RULES (§11.4), verbatim:
//
//   owner ≠ me AND cpty ≠ me      → triage = context (not a task)
//   attribution=first_person AND
//     subject_id ≠ speaker_id     → downgrade to about_other + flag
//   speaker_id                    → from events.actor_entity_id
//   stated_at                     → from the event ts (never ingest time)
//   horizon                       → computed from due − now   (→ loops/state)
//
// `ingested_at` IS NEVER READ HERE. It is not in any input type, it is not in
// the row reader, and `eventCodeFacts` takes `ts` only. Precedence is
// `stated_at`, always (build rule 8).
// ===========================================================================

import {
  claimPartyPair,
  loopIsTaskEligible,
  loopPartyPair,
  pairInvolvesSelf,
  roleOf,
  type PartyPair,
  type PartySession,
} from "../entities/party.js";
import {
  deriveLoopState,
  isTaskState,
  type LoopHorizon,
  type LoopState,
  type LoopStateFacts,
  type LoopStateInput,
  type LoopStateReason,
  type NowLike,
} from "../loops/state.js";

// ---- flags -----------------------------------------------------------------

/**
 * Everything code noticed while deriving. A flag is a REPORT — the write path
 * (item 3.3) decides what to do with it. Nothing here acts on its own flag
 * except `attribution_downgraded`, which §11.4 names as a downgrade.
 */
export type CodeFactFlag =
  | "attribution_downgraded"
  | "subject_unresolved"
  | "speaker_unresolved"
  | "owner_unresolved"
  | "counterparty_unresolved"
  | "no_self_in_pair"
  | "stated_at_missing";

// ---- the event half --------------------------------------------------------

/** An `events` row, in either spelling. `ingested_at` is deliberately absent. */
export interface EventLike {
  id?: string | null;
  actor_entity_id?: string | null;
  actorEntityId?: string | null;
  /** `events.ts` — WHEN IT WAS SAID. The only basis for precedence. */
  ts?: string | null;
}

export interface EventCodeFacts {
  /** `claim_versions.speaker_id` / the loop's stating actor. */
  speakerId: string | null;
  /** `claim_versions.stated_at`. From `events.ts`, never from ingest time. */
  statedAt: string | null;
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * §11.4 — `speaker_id` from `events.actor_entity_id`, `stated_at` from the
 * event ts. Both may be null: an event with no resolved actor yields no
 * speaker, and NULL beats a guessed id (§5.2.2).
 */
export function eventCodeFacts(event: EventLike | null | undefined): EventCodeFacts {
  if (!event) return { speakerId: null, statedAt: null };
  return {
    speakerId: id(event.actorEntityId ?? event.actor_entity_id),
    statedAt: id(event.ts),
  };
}

// ---- attribution -----------------------------------------------------------

export const ATTRIBUTIONS = ["first_person", "about_other", "reported_speech", "quoted_third_party"] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

export function isAttribution(value: unknown): value is Attribution {
  return typeof value === "string" && (ATTRIBUTIONS as readonly string[]).includes(value);
}

export interface AttributionFacts {
  attribution: string | null;
  /** What the model said, kept verbatim even when the stored value differs. */
  statedAttribution: string | null;
  downgraded: boolean;
}

/**
 * §11.4 — `attribution=first_person AND subject_id ≠ speaker_id` → downgrade
 * to `about_other` + flag.
 *
 * The comparison needs BOTH ids. A subject that is still a `subject_hint`
 * string has no id, so there is nothing to compare and nothing is downgraded:
 * unknown beats wrong, and the write path asks rather than assumes. Any
 * attribution other than `first_person` passes through untouched.
 */
export function deriveAttribution(
  stated: string | null | undefined,
  subjectId: string | null | undefined,
  speakerId: string | null | undefined,
): AttributionFacts {
  const statedAttribution = id(stated);
  const subject = id(subjectId);
  const speaker = id(speakerId);
  const mismatch =
    statedAttribution === "first_person" && subject !== null && speaker !== null && subject !== speaker;
  return {
    attribution: mismatch ? "about_other" : statedAttribution,
    statedAttribution,
    downgraded: mismatch,
  };
}

// ---- claims ----------------------------------------------------------------

export interface ClaimCodeFactsInput {
  subjectId?: string | null;
  /** Supply either the event or an already-resolved speaker; the event wins. */
  speakerId?: string | null;
  attribution?: string | null;
  event?: EventLike | null;
  statedAt?: string | null;
}

export interface ClaimCodeFacts extends EventCodeFacts, AttributionFacts {
  /** `role(speaker) ‖ role(subject)`, or null when either end is unresolved. */
  partyPair: PartyPair | null;
  flags: CodeFactFlag[];
}

/**
 * Every code-written field of a `claim_versions` row. The claim's TEXT is not
 * an input and not an output: this module has no way to alter it.
 */
export function claimCodeFacts(input: ClaimCodeFactsInput, session: PartySession = {}): ClaimCodeFacts {
  const fromEvent = eventCodeFacts(input.event);
  const speakerId = fromEvent.speakerId ?? id(input.speakerId);
  const statedAt = fromEvent.statedAt ?? id(input.statedAt);
  const subjectId = id(input.subjectId);
  const attribution = deriveAttribution(input.attribution, subjectId, speakerId);
  const partyPair = claimPartyPair({ speakerId, subjectId }, session);

  const flags: CodeFactFlag[] = [];
  if (attribution.downgraded) flags.push("attribution_downgraded");
  if (subjectId === null) flags.push("subject_unresolved");
  if (speakerId === null) flags.push("speaker_unresolved");
  if (statedAt === null) flags.push("stated_at_missing");

  return { speakerId, statedAt, ...attribution, partyPair, flags };
}

// ---- triage ----------------------------------------------------------------

export const TRIAGE_CLASSES = ["auto", "approval", "context"] as const;
export type Triage = (typeof TRIAGE_CLASSES)[number];

export interface TriageInput {
  ownerId?: string | null;
  counterpartyId?: string | null;
  /** explicit | implicit. §11.5.2: implicit is NEVER `auto`. */
  origin?: string | null;
}

/**
 * §12.8 — "A loop owned by someone other than the user is ALWAYS cx", stated
 * again two lines later as a RULE: "owner not self is ALWAYS cx".
 * §11.5.2 — implicit is always `approval` or `context`, never `auto`.
 *
 * `auto` is therefore reachable only by a loop that (a) **I OWN** and (b) was
 * stated EXPLICITLY. An unknown origin is not an explicit one, so it lands on
 * `approval` — §9.5.1's "the safe default is never 'auto'".
 *
 * THE TEST IS THE OWNER, NOT "SELF SOMEWHERE IN THE PAIR". The distinction is
 * the whole `os` pair — "You owe me". Self IS at one end, so an either-end
 * test calls it `auto` and the system may act on it unasked. But it is not my
 * action to take: §14.7 files it under "waiting on others", context only. The
 * doc's own worked example does the same thing to t2 ("owned by Pranjali, not
 * the user" → `cx`). This function and `loops/triage.ts` `tr1RuleFor()` are
 * the two places the rule is applied — one against db entity ids through
 * `roleOf`, one against the wire's `self` alias — and they must not disagree
 * about which loops are mine.
 */
export function deriveTriage(input: TriageInput, session: PartySession = {}): Triage {
  if (roleOf(input.ownerId, session) !== "s") return "context";
  return input.origin === "explicit" ? "auto" : "approval";
}

// ---- loops -----------------------------------------------------------------

export interface LoopCodeFactsInput extends LoopStateInput, TriageInput {
  event?: EventLike | null;
  speakerId?: string | null;
}

export interface LoopCodeFacts extends EventCodeFacts {
  partyPair: PartyPair | null;
  triage: Triage;
  state: LoopState;
  stateReason: LoopStateReason;
  nextOccurrenceUtc: string | null;
  horizon: LoopHorizon;
  dueInPast: boolean;
  /**
   * §11.3.1 — `task = loop WHERE owner_id == me AND state ∈ {open, latent}`.
   * OWNER, not merely "self is somewhere in the pair": a loop someone else
   * owns surfaces on that PERSON (§11.3.2), never in your task list.
   */
  taskEligible: boolean;
  /** True when the loop belongs in Tasks right now: eligible AND open|latent. */
  isTask: boolean;
  flags: CodeFactFlag[];
}

/**
 * Every code-written field of a `loops` row: the party pair, the triage class,
 * and the whole state function. The model's `intent`, `stake`, `direction`,
 * `due` and `recurrence` are read and never written back.
 */
export function loopCodeFacts(
  input: LoopCodeFactsInput,
  session: PartySession = {},
  now: NowLike = Date.now(),
): LoopCodeFacts {
  const fromEvent = eventCodeFacts(input.event);
  const speakerId = fromEvent.speakerId ?? id(input.speakerId);
  const statedAtFromEvent = fromEvent.statedAt;
  const statedAt = statedAtFromEvent ?? id(input.statedAt);

  const ownerId = id(input.ownerId);
  const counterpartyId = id(input.counterpartyId);
  const partyPair = loopPartyPair({ ownerId, counterpartyId }, session);
  const triage = deriveTriage({ ownerId, counterpartyId, origin: input.origin }, session);

  const stateFacts: LoopStateFacts = deriveLoopState({ ...input, statedAt }, now);
  const ownerIsSelf = ownerId !== null && roleOf(ownerId, session) === "s";
  const taskEligible = ownerIsSelf && loopIsTaskEligible(partyPair);

  const flags: CodeFactFlag[] = [];
  if (ownerId === null) flags.push("owner_unresolved");
  if (counterpartyId === null) flags.push("counterparty_unresolved");
  if (!pairInvolvesSelf(partyPair)) flags.push("no_self_in_pair");
  if (speakerId === null) flags.push("speaker_unresolved");
  if (statedAt === null) flags.push("stated_at_missing");

  return {
    speakerId,
    statedAt,
    partyPair,
    triage,
    state: stateFacts.state,
    stateReason: stateFacts.stateReason,
    nextOccurrenceUtc: stateFacts.nextOccurrenceUtc,
    horizon: stateFacts.horizon,
    dueInPast: stateFacts.dueInPast,
    taskEligible,
    isTask: taskEligible && isTaskState(stateFacts.state),
    flags,
  };
}

// ---- the Tasks view --------------------------------------------------------

export interface TaskViewRow<T> {
  loop: T;
  facts: LoopCodeFacts;
}

/**
 * The Tasks view, as one function: derive, then admit only `owner == me` with
 * `state ∈ {open, latent}`. Item 3.2 acceptance — **zero non-self loops in
 * Tasks** — is this filter, and `nonSelfLoopsInTasks` below is its audit.
 *
 * A rejected loop is NOT discarded: it is still a row, still a member of its
 * arc, and still renders on the counterparty's People record. This function
 * selects a view; it never deletes anything.
 */
export function tasksFrom<T extends LoopCodeFactsInput>(
  loops: readonly T[],
  session: PartySession = {},
  now: NowLike = Date.now(),
): TaskViewRow<T>[] {
  const out: TaskViewRow<T>[] = [];
  for (const loop of loops) {
    const facts = loopCodeFacts(loop, session, now);
    if (facts.isTask) out.push({ loop, facts });
  }
  return out;
}

/**
 * Audit for the acceptance line. Returns the index of every row in a Tasks
 * list whose pair carries no `s` — which must always be empty.
 */
export function nonSelfLoopsInTasks(rows: readonly TaskViewRow<unknown>[]): number[] {
  const out: number[] = [];
  rows.forEach((row, index) => {
    if (!pairInvolvesSelf(row.facts.partyPair)) out.push(index);
  });
  return out;
}
