// ===========================================================================
// [CODE] Session operations — everything that happens to a session AFTER the
// walk (arch §10.4 notes 2–9; build item 1.7).
//
// These are the rules that keep a sealed session honest. Each one exists
// because the obvious implementation is wrong in a way that only shows up
// months later:
//
//   REACTIONS (note 2)   attach to the parent event's session even when it is
//                        sealed, never open a session, and NEVER reset the
//                        debounce. A 👍 seven hours later is not a
//                        conversation, and treating it as one would hold a
//                        session open all night and then judge the two together.
//
//   EDITS (note 3)       in an OPEN session, mutate in place — the hash has not
//                        been taken yet, so nothing downstream saw the old text.
//                        AFTER the seal, the edit is stored and attached to its
//                        parent for provenance and `superseded_hash` is set, so
//                        the session is REPROCESSED at the new content rather
//                        than silently meaning something else.
//                        MEMBERSHIP NEVER CHANGES.
//
//   REVOKES (note 4)     the same shape: the event is marked revoked,
//                        membership is unchanged, and a sealed session gets a
//                        `superseded_hash`.
//
//   RECEIPTS (note 5)    are not events at all. Dropped at the adapter.
//
//   LATE ARRIVALS (8)    an event landing inside a sealed session's range forms
//                        a NEW session flagged `late_arrival` with `overlap_of`.
//                        A SEALED SESSION IS NEVER REOPENED — reopening one
//                        would invalidate every claim already extracted from it.
//
//   CLOCK SKEW (9)       `ts > now + 5 min` is clamped and flagged.
//
// The cohort-resume rule (§10.4 note 7's second half) lives here too: on boot,
// an in-flight cohort resumes at its LAST COMPLETED stage and reuses the
// verdicts it already has. Re-judging them would spend tokens to get a
// different answer to the same question, which is the one thing a replayable
// pipeline may not do.
// ===========================================================================

import { clampSkew, isNonContentKind, SKEW_TOLERANCE_MS } from "../adapters/normalize.js";
import type { MeasuredParams, SegEvent, SegSession } from "./segment.js";
import { contentHashOf, sessionIdOf, tsMs } from "./segment.js";
import type { SessionPolicy } from "./policies.js";
import type { EventTextIndex, HashableEvent } from "./seal.js";

// ---- notes 5 and 9: guards that already live at the adapter ---------------
//
// Both of these are ENFORCED IN `adapters/normalize.ts`, before ingestion — a
// receipt never becomes a row and a future timestamp is already clamped by the
// time the segmenter sees anything. They are re-exported here, not
// re-implemented: two spellings of "is this a real event" is exactly how a
// filter and a segmenter end up disagreeing about what a stream contains.

export { clampSkew, SKEW_TOLERANCE_MS };

/** §10.4 note 5 — a read receipt or delivery ack is not an event. */
export function isDroppedAtAdapter(kind: string): boolean {
  return isNonContentKind(kind);
}

// ---- superseding a sealed session -----------------------------------------

/**
 * Move a sealed session's content hash without touching its membership.
 *
 * `superseded_hash` holds the hash the session was UNDERSTOOD at; `content_hash`
 * becomes the new one. That pair is the whole reprocess signal (§8.5): the hash
 * gate sees a hash it has not judged, and `superseded_hash` says which stored
 * understanding is now stale.
 */
export function supersede(session: SegSession, members: readonly HashableEvent[]): SegSession {
  const next = contentHashOf(members);
  if (next === session.content_hash) return session;
  return { ...session, superseded_hash: session.content_hash, content_hash: next };
}

function membersOf(session: SegSession, texts: EventTextIndex): HashableEvent[] {
  return session.event_ids.map((id) => texts.get(id) ?? { external_id: id, text: "" });
}

// ---- note 2: reactions -----------------------------------------------------

export interface ReactionResult {
  sessions: SegSession[];
  /** The session the reaction attached to, or null when the parent is unknown. */
  attached_to: string | null;
  /** Always 0. A reaction never opens a session. */
  new_sessions: number;
  /** Always false. A 👍 seven hours later is not a conversation. */
  debounce_reset: boolean;
  /** Always false — the parent's membership does not move. */
  membership_changed: boolean;
  /** Always false — a reaction carries no text into the hash. */
  hash_changed: boolean;
}

/**
 * Attach a reaction to its parent event's session, sealed or not.
 *
 * Three things it deliberately does NOT do: open a session, reset the debounce,
 * or join the membership. A reaction is a gesture ABOUT a turn, not a turn — so
 * it is provenance on the session, and the content hash never moves for it.
 */
export function applyReaction(
  sessions: readonly SegSession[],
  reaction: { external_id: string; parent_external_id: string },
): ReactionResult {
  const out = sessions.map((s) => ({ ...s, attachments: [...s.attachments] }));
  const target = out.find((s) => s.event_ids.includes(reaction.parent_external_id)) ?? null;
  if (target && !target.attachments.includes(reaction.external_id)) {
    target.attachments.push(reaction.external_id);
  }
  return {
    sessions: out,
    attached_to: target?.id ?? null,
    new_sessions: 0,
    debounce_reset: false,
    membership_changed: false,
    hash_changed: false,
  };
}

// ---- notes 3 and 4: edits and revokes --------------------------------------

export interface MutationResult {
  sessions: SegSession[];
  /** The session the mutation landed in. */
  session_id: string | null;
  /** Whether it was sealed when the mutation arrived. */
  was_sealed: boolean;
  /** OPEN: the text was changed in place; the hash has not been taken yet. */
  mutated_in_place: boolean;
  /** SEALED: `superseded_hash` was set and the session is queued for reprocess. */
  superseded: boolean;
  /** NEVER true. Membership is immutable, both before and after the seal. */
  membership_changed: boolean;
  /** The hash before the mutation, when one was taken. */
  previous_hash: string | null;
  /** The hash after. */
  content_hash: string | null;
  /** SEALED: the mutation is attached to the parent for provenance. */
  attached_to_parent: boolean;
}

interface MutationInput {
  /** The event being edited or revoked. */
  target_external_id: string;
  /** The edit/revoke frame's own id, attached to the parent when sealed. */
  external_id?: string;
  /** The new body, for an edit. A revoke clears the body instead. */
  text?: string;
  enrichment_text?: string;
}

function applyMutation(
  sessions: readonly SegSession[],
  texts: Map<string, HashableEvent>,
  input: MutationInput,
  revoke: boolean,
): MutationResult {
  const out = sessions.map((s) => ({ ...s, attachments: [...s.attachments] }));
  const target = out.find((s) => s.event_ids.includes(input.target_external_id)) ?? null;
  const base: MutationResult = {
    sessions: out,
    session_id: target?.id ?? null,
    was_sealed: target?.status === "sealed",
    mutated_in_place: false,
    superseded: false,
    membership_changed: false,
    previous_hash: target?.content_hash ?? null,
    content_hash: target?.content_hash ?? null,
    attached_to_parent: false,
  };
  if (!target) return base;

  // The text moves either way — the difference is only what it costs.
  const existing = texts.get(input.target_external_id) ?? {
    external_id: input.target_external_id,
    text: "",
  };
  texts.set(input.target_external_id, {
    external_id: input.target_external_id,
    text: revoke ? "" : (input.text ?? existing.text),
    enrichment_text: revoke ? "" : (input.enrichment_text ?? existing.enrichment_text),
  });

  if (target.status !== "sealed") {
    // Nothing has hashed this session yet, so an in-place edit is free and
    // invisible: the hash taken at seal will already be the edited one.
    return { ...base, mutated_in_place: true, content_hash: null, previous_hash: null };
  }

  const superseded = supersede(target, membersOf(target, texts));
  const at = out.indexOf(target);
  const attachId = input.external_id;
  const attachments = attachId && !superseded.attachments.includes(attachId)
    ? [...superseded.attachments, attachId]
    : superseded.attachments;
  out[at] = { ...superseded, attachments };
  return {
    ...base,
    sessions: out,
    superseded: superseded.superseded_hash !== target.superseded_hash || superseded.content_hash !== target.content_hash,
    previous_hash: target.content_hash,
    content_hash: superseded.content_hash,
    attached_to_parent: Boolean(attachId),
  };
}

/** §10.4 note 3. Membership never changes — before the seal or after it. */
export function applyEdit(
  sessions: readonly SegSession[],
  texts: Map<string, HashableEvent>,
  input: MutationInput,
): MutationResult {
  return applyMutation(sessions, texts, input, false);
}

/** §10.4 note 4. The event is marked revoked; membership is unchanged. */
export function applyRevoke(
  sessions: readonly SegSession[],
  texts: Map<string, HashableEvent>,
  input: MutationInput,
): MutationResult {
  return applyMutation(sessions, texts, input, true);
}

// ---- note 8: late arrivals -------------------------------------------------

export interface LateArrivalResult {
  /** The new session, or null when the event does not land inside a sealed one. */
  session: SegSession | null;
  /** The sealed session it overlaps. */
  overlap_of: string | null;
  /** Always false. A sealed session is NEVER reopened. */
  reopened: boolean;
  measured: MeasuredParams;
}

/**
 * An event whose `ts` falls inside an already-sealed session's range.
 *
 * It forms a NEW session flagged `late_arrival` with `overlap_of` pointing at
 * the session it overlaps. The sealed session is untouched — its membership,
 * its hash and everything already extracted from it stay exactly as they were,
 * because the alternative is a claim whose evidence quietly changed underneath
 * it.
 */
export function lateArrival(
  sessions: readonly SegSession[],
  ev: SegEvent,
  stream: { key: string; tz: string; source_id?: string },
  policy: SessionPolicy,
): LateArrivalResult {
  const at = tsMs(ev.ts);
  const overlapped = sessions.find(
    (s) => s.status === "sealed" && at >= tsMs(s.started_at) && at <= tsMs(s.ended_at),
  );
  if (!overlapped) {
    return { session: null, overlap_of: null, reopened: false, measured: { inside_sealed: false } };
  }
  const measured: MeasuredParams = {
    rule: "late_arrival",
    overlap_of: overlapped.id,
    overlap_started_at: overlapped.started_at,
    overlap_ended_at: overlapped.ended_at,
  };
  const session: SegSession = {
    id: sessionIdOf(stream.key, ev.ts, ev.external_id),
    stream_key: stream.key,
    source_id: stream.source_id ?? null,
    tz: stream.tz,
    kind: policy.kind,
    started_at: ev.ts,
    ended_at: ev.ts,
    event_ids: [ev.external_id],
    actors: [ev.actor],
    boundary_reason_start: "late_arrival",
    boundary_reason_end: null,
    boundary_params: { start: measured, end: null },
    status: "open",
    seal_mode: null,
    sealed_at: null,
    content_hash: null,
    superseded_hash: null,
    hash_version: overlapped.hash_version,
    late_arrival: true,
    overlap_of: overlapped.id,
    attachments: [],
    event_count: 1,
    chars: (ev.text ?? "").length + (ev.enrichment_text ?? "").length,
    tokens: 0,
    collapsed_count: 0,
    active_ms: 0,
    coarse: false,
  };
  return { session, overlap_of: overlapped.id, reopened: false, measured };
}

// ---- note 7 (second half): cohort resume ----------------------------------

/**
 * The cohort pipeline's stages, in the order migration 0020 lists them on
 * `work_queue.stage`. `done` terminates.
 */
export const COHORT_STAGES = [
  "enrich",
  "entity",
  "segment",
  "episode",
  "arc",
  "extract",
  "triage",
  "derive",
  "done",
] as const;
export type CohortStage = (typeof COHORT_STAGES)[number];

export function isCohortStage(v: unknown): v is CohortStage {
  return typeof v === "string" && (COHORT_STAGES as readonly string[]).includes(v);
}

export interface CohortResume {
  /** The stage the cohort had finished when the app quit. */
  last_completed: CohortStage | null;
  /** Where it picks back up. */
  resume_at: CohortStage;
  /** Stages whose verdicts are REUSED, never re-judged. */
  reused: CohortStage[];
  rejudged: CohortStage[];
}

/**
 * Where an in-flight cohort resumes after a restart.
 *
 * Everything up to and including the last completed stage is REUSED. Nothing is
 * re-judged: a stored verdict is the record of what the model actually said,
 * and asking again would spend tokens to get a possibly different answer to a
 * question that was already answered — which would make the pipeline
 * unreplayable and the accounting a lie.
 */
export function resumeCohort(interruptedAt: string): CohortResume {
  if (!isCohortStage(interruptedAt)) {
    return { last_completed: null, resume_at: "enrich", reused: [], rejudged: [] };
  }
  const at = COHORT_STAGES.indexOf(interruptedAt);
  // The stage it was IN when it quit did not complete, so it is where it
  // resumes; every stage before it did, so every one of those is reused.
  const reused = COHORT_STAGES.slice(0, at) as CohortStage[];
  return {
    last_completed: at === 0 ? null : COHORT_STAGES[at - 1]!,
    resume_at: interruptedAt,
    reused: [...reused],
    rejudged: [],
  };
}
