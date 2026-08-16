// ===========================================================================
// [CODE] The segmenter — one walk, five policies, two seal modes (arch §10.4;
// build item 1.7).
//
// ⚠ ZERO MODEL CALLS. A session boundary is arithmetic over timestamps, actors
//   and counts. Sealing is independent of understanding (§10.4): the live
//   trigger extracts from a session while it is still open, and nothing in this
//   file waits for it.
//
// The three properties this walk exists to have:
//
//   1. **Backfill and live are the same code.** §10.4 note 1. The only
//      difference between a 24-month import and the live tail is `run_mode`,
//      which decides how a session is SEALED — never where it is CUT.
//
//   2. **Ordered by `ts`, never by rowid.** History arrives newest-page-first
//      and out of order; insertion order is an accident of the network. The
//      walk sorts by `(ts, external_id)` — the same pair the per-stream
//      durability watermark is kept on — so the tie-break is stable too.
//
//   3. **Deterministic to the byte.** Same events + same policy = same
//      sessions, same ids, same hashes. Every id is derived from content, never
//      minted from a counter or a clock.
//
// Rule precedence is FIXED and documented (see `boundaryFor`). Two rules can be
// true at the same instant; which one is reported has to be a property of the
// code, not of the order the fields happened to be read in.
// ===========================================================================

import { createHash } from "node:crypto";

import {
  crossesDayBoundary,
  localDayKey,
  registrableDomain,
  tokensOfChars,
  tsMs,
  type BoundaryReason,
  type SealMode,
  type SegmentRunMode,
  type SessionPolicy,
} from "./policies.js";
import { collapseFrames, NO_COLLAPSE, type Collapsed } from "./prefilter.js";

// `tsMs` is time arithmetic, not segmentation — it lives in ./policies.ts next
// to the day-boundary maths and is re-exported here for the modules that read
// timestamps off a session.
export { tsMs };

// ---- input -----------------------------------------------------------------

/**
 * One event as the segmenter sees it. Source-neutral on purpose: the adapter
 * has already dropped protocol chatter and clamped clock skew (§10.4 notes 5
 * and 9, `adapters/normalize.ts`), so everything here is a real thing someone
 * did.
 */
export interface SegEvent {
  external_id: string;
  /** ISO-8601. The ONLY basis for order (§3.3 rule 8). */
  ts: string;
  /** Canonical actor / author id. */
  actor: string;
  kind: string;
  text: string;
  /** Caption, transcript, scraped page text — counted in the cap AND the hash. */
  enrichment_text?: string;
  /** The event this one quotes (CONVERSATION reply-chain break). */
  reply_to_external_id?: string | null;
  /** DOCUMENT: who wrote this revision. Defaults to `actor`. */
  author?: string;
  /** ACTIVITY/AMBIENT: an already-computed context key (app id, vertical, speaker·scene). */
  context?: string | null;
  /** ACTIVITY: the URL a context key falls out of when `context` is absent. */
  url?: string | null;
  /** ACTIVITY: a transaction. Always its own single-event session (§2.1). */
  transaction?: boolean;
  /** BOUNDED: the record's end. Defaults to `ts`. */
  ts_end?: string | null;
  /**
   * BOUNDED: which record this event belongs to. A calendar entry emits one
   * event and is its own record; a meeting transcript emits 160 utterances that
   * are all the SAME record. Defaults to `external_id`, which makes the
   * one-event case fall out for free.
   */
  record_id?: string | null;
  /** AMBIENT: perceptual hash, for the collapse that runs before segmentation. */
  phash?: string | null;
  /** AMBIENT: §10.2 salience, for the low-salience coarse collapse. */
  salience?: number;
}

export interface SegStream {
  /** Stable stream key — part of every session id derived here. */
  key: string;
  /** IANA zone the lane is lived in. Day cuts are computed in it (§10.4 note 6). */
  tz: string;
  source_id?: string;
}

export interface SegmentInput {
  stream: SegStream;
  policy: SessionPolicy;
  events: readonly SegEvent[];
  /**
   * `bootstrap` = history is complete, so the next event is already known and
   * every session but the newest seals AT ONCE. `steady` = live, so the tail
   * waits for the debounce.
   */
  run_mode: SegmentRunMode;
  /**
   * `external_id -> ts` for events this walk does not carry — the older half of
   * a stream a reply may reach back into. A reply whose target is unknown never
   * breaks the chain: an unmeasurable rule must not fire.
   */
  known_event_ts?: ReadonlyMap<string, string>;
  /**
   * AMBIENT: max hamming distance still counted as the same frame. Frames that
   * collapse never reach the boundary rules at all (§2.1: prefilter FIRST).
   */
  dedupe_distance?: number;
  /** AMBIENT: salience at or below which a run collapses to ONE coarse session. */
  coarse_salience_max?: number;
}

// ---- output ----------------------------------------------------------------

/** The rule that cut here, and the numbers it measured. Never a bare label. */
export interface BoundaryRecord {
  reason: BoundaryReason;
  /** The measured value the rule fired on, and the threshold it crossed. */
  measured: Readonly<Record<string, number | string | boolean>>;
}

export type MeasuredParams = Readonly<Record<string, number | string | boolean>>;

export interface SegSession {
  id: string;
  stream_key: string;
  source_id: string | null;
  tz: string;
  kind: string;
  started_at: string;
  ended_at: string;
  /** Member events, in `ts` order. Membership is IMMUTABLE once sealed. */
  event_ids: string[];
  /** Distinct actors, sorted — the participant set, not a turn log. */
  actors: string[];
  boundary_reason_start: BoundaryReason;
  boundary_reason_end: BoundaryReason | null;
  /** The MEASURED params for each end, not a guess. §10.4's explainability. */
  boundary_params: { start: MeasuredParams; end: MeasuredParams | null };
  status: "open" | "sealed";
  seal_mode: SealMode | null;
  sealed_at: string | null;
  content_hash: string | null;
  superseded_hash: string | null;
  hash_version: string;
  late_arrival: boolean;
  overlap_of: string | null;
  /** Reactions and post-seal edits: attached for provenance, never members. */
  attachments: string[];
  /** Running totals the caps are measured against. */
  event_count: number;
  chars: number;
  tokens: number;
  /** AMBIENT: every frame this session collapsed away. */
  collapsed_count: number;
  /** AMBIENT: accumulated span between frames that survived the collapse. */
  active_ms: number;
  /** AMBIENT: nothing here cleared the salience floor. One coarse pass, no LLM. */
  coarse: boolean;
}

/**
 * A session mid-walk. The three extra fields are the walk's memory — who opened
 * the session, what context it is in, and whether it is an isolated
 * transaction — and they are stripped from the sealed record because a boundary
 * must be re-derivable from the events alone.
 */
export interface SessionCursor extends SegSession {
  initiator: string;
  context: string | null;
  transaction: boolean;
  /** BOUNDED: the record this session IS. */
  record: string;
}

export interface SegmentResult {
  sessions: SegSession[];
  /** The one session per stream that is still open, when there is one. */
  open: SegSession | null;
  /** Frames the perceptual collapse removed before any rule ran. */
  collapsed: number;
  /** Events the walk saw, after collapse. */
  considered: number;
}

// ---- hashing ---------------------------------------------------------------

export const HASH_VERSION = "stw2-sess-1";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * §10.4: `sha256(sorted external_ids + text hashes, INCLUDING enrichment text)`.
 *
 * Sorted, so the hash is a property of the SET of events and not of the order
 * they were walked in. Enrichment text is inside the hash on purpose — that is
 * exactly the mechanism that lets a caption arriving late move the hash and
 * trip the HASH GATE, instead of a session quietly meaning something different
 * than the last time it was understood.
 */
export function contentHashOf(
  events: readonly { external_id: string; text: string; enrichment_text?: string }[],
): string {
  const lines = events
    .map((e) => `${e.external_id}\t${sha256(`${e.text ?? ""} ${e.enrichment_text ?? ""}`)}`)
    .sort();
  return sha256(`${HASH_VERSION}\n${lines.join("\n")}`);
}

/** Deterministic session id — content-derived, so a re-run mints the same one. */
export function sessionIdOf(streamKey: string, startedAt: string, firstExternalId: string): string {
  return `sess:${sha256(`${streamKey} ${startedAt} ${firstExternalId}`).slice(0, 24)}`;
}

// ---- ordering --------------------------------------------------------------

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * `(ts, external_id)` ascending — the pair the durability watermark is kept on.
 * Never rowid, never insertion order (§10.4 note 1).
 */
export function orderEvents(events: readonly SegEvent[]): SegEvent[] {
  return [...events].sort((a, b) => {
    const at = tsMs(a.ts);
    const bt = tsMs(b.ts);
    if (at !== bt) return at - bt;
    return a.external_id < b.external_id ? -1 : a.external_id > b.external_id ? 1 : 0;
  });
}

// ---- measurement helpers ---------------------------------------------------

export function charsOf(ev: SegEvent): number {
  return (ev.text ?? "").length + (ev.enrichment_text ?? "").length;
}

/** ACTIVITY/AMBIENT context key: what the caller computed, else the domain. */
export function contextKeyOf(ev: SegEvent): string | null {
  if (typeof ev.context === "string" && ev.context !== "") return ev.context;
  return registrableDomain(ev.url);
}

function authorOf(ev: SegEvent): string {
  return ev.author ?? ev.actor;
}

/** BOUNDED: the record an event belongs to. One event with no record id IS one. */
export function recordKeyOf(ev: SegEvent): string {
  return ev.record_id ?? ev.external_id;
}

/** Reactions are attachments, never members — §10.4 note 2, applied in `ops.ts`. */
export function isReaction(ev: SegEvent): boolean {
  return ev.kind === "reaction";
}

// ---- boundary rules --------------------------------------------------------

export interface BoundaryContext {
  policy: SessionPolicy;
  tz: string;
  /** `external_id -> epoch ms` across the whole stream, for the reply-chain rule. */
  eventTs: ReadonlyMap<string, number>;
}

/**
 * Does `ev` belong to `session`, or does it start a new one?
 *
 * PRECEDENCE, fixed so a tie is a property of the code:
 *
 *   1. record_bounded — BOUNDED, and ACTIVITY transactions. A record with its
 *      own start and end is never inferred into a burst (§2.1).
 *   2. gap            — the primary rule, and the one every kind has.
 *   3. ceiling        — the session has simply run too long.
 *   4. reply_break    — a reply reaching back past G is a new subject.
 *   5. participant_shift — the CONJUNCTION: gap ≥ shift_min_gap AND the
 *      initiator flipped. Either half alone is turn-taking.
 *   6. author_shift   — DOCUMENT. A different author is a different sitting.
 *   7. context_shift  — ACTIVITY domain/app/vertical, AMBIENT app·speaker·scene
 *      and silence > 90s.
 *   8. day_boundary   — local midnight in the STREAM's tz.
 *   9. size_cap       — 40 events / 6k tokens, or the kind's own caps.
 *
 * Returns null when the event continues the session.
 */
export function boundaryFor(
  session: SessionCursor,
  ev: SegEvent,
  ctx: BoundaryContext,
): BoundaryRecord | null {
  const { policy, tz } = ctx;
  const prevMs = tsMs(session.ended_at);
  const evMs = tsMs(ev.ts);
  const gap = evMs - prevMs;

  // 1. a record is the session — and so is a transaction. A record with many
  //    events (a meeting transcript) is still ONE session; the record id, not
  //    the event count, is what ends it. Caps never apply here (§2.1).
  if (policy.kind === "bounded") {
    const record = recordKeyOf(ev);
    if (record === session.record) return null;
    return { reason: "record_bounded", measured: { rule: "record_bounded", record } };
  }
  if (policy.transaction_isolates) {
    if (ev.transaction === true) {
      return { reason: "record_bounded", measured: { rule: "transaction", kind: ev.kind } };
    }
    if (session.transaction) {
      return { reason: "record_bounded", measured: { rule: "transaction_sealed_alone", kind: ev.kind } };
    }
  }

  // 2. gap.
  if (Number.isFinite(policy.gap_ms) && gap > policy.gap_ms) {
    return { reason: "gap", measured: { gap_ms: gap, threshold_ms: policy.gap_ms } };
  }

  // 3. ceiling.
  const span = evMs - tsMs(session.started_at);
  if (Number.isFinite(policy.ceiling_ms) && span > policy.ceiling_ms) {
    return { reason: "ceiling", measured: { span_ms: span, ceiling_ms: policy.ceiling_ms } };
  }

  // 4. reply-chain break: a reply targeting an event more than G older. The old
  //    session stays sealed — this opens a new one, it never reaches back.
  if (policy.reply_break && ev.reply_to_external_id) {
    const target = ctx.eventTs.get(ev.reply_to_external_id);
    if (typeof target === "number") {
      const age = evMs - target;
      if (age > policy.gap_ms) {
        return {
          reason: "reply_break",
          measured: { reply_age_ms: age, threshold_ms: policy.gap_ms, target: ev.reply_to_external_id },
        };
      }
    }
  }

  // 5. participant shift — a CONJUNCTION, never a bare flip.
  if (policy.participant_shift) {
    const flipped = ev.actor !== session.initiator;
    const enoughGap = gap >= policy.shift_min_gap_ms;
    if (flipped && enoughGap) {
      return {
        reason: "participant_shift",
        measured: {
          gap_ms: gap,
          shift_min_gap_ms: policy.shift_min_gap_ms,
          initiator: session.initiator,
          actor: ev.actor,
        },
      };
    }
  }

  // 6. author shift (DOCUMENT) — no minimum gap; a co-author is a new sitting.
  if (policy.author_shift && authorOf(ev) !== session.initiator) {
    return {
      reason: "author_shift",
      measured: { gap_ms: gap, author: authorOf(ev), previous_author: session.initiator },
    };
  }

  // 7. context shift.
  if (policy.context_shift) {
    if (policy.silence_ms > 0 && gap > policy.silence_ms) {
      return { reason: "context_shift", measured: { silence_ms: gap, threshold_ms: policy.silence_ms } };
    }
    const next = contextKeyOf(ev);
    if (next !== null && session.context !== null && next !== session.context) {
      return { reason: "context_shift", measured: { context: next, previous_context: session.context } };
    }
  }

  // 8. local midnight, in the STREAM's tz.
  if (policy.day_boundary && crossesDayBoundary(prevMs, evMs, tz)) {
    return {
      reason: "day_boundary",
      measured: { tz, from_day: localDayKey(prevMs, tz), to_day: localDayKey(evMs, tz) },
    };
  }

  // 9. caps. Both are "adding this event would exceed", so the session that
  //    cut is the one that reached exactly the cap.
  if (policy.caps_apply) {
    if (session.event_count + 1 > policy.size_cap_events) {
      return {
        reason: "size_cap",
        measured: { events: session.event_count, cap_events: policy.size_cap_events },
      };
    }
    if (session.chars + charsOf(ev) > policy.size_cap_chars) {
      return {
        reason: "size_cap",
        measured: {
          chars: session.chars,
          cap_chars: policy.size_cap_chars,
          tokens: tokensOfChars(session.chars),
          cap_tokens: tokensOfChars(policy.size_cap_chars),
        },
      };
    }
    if (Number.isFinite(policy.active_cap_ms) && session.active_ms + Math.max(0, gap) > policy.active_cap_ms) {
      return {
        reason: "size_cap",
        measured: { active_ms: session.active_ms, cap_active_ms: policy.active_cap_ms },
      };
    }
  }

  return null;
}

// ---- the walk --------------------------------------------------------------

function endOf(ev: SegEvent, collapsed: Collapsed): number {
  if (ev.ts_end) return Math.max(tsMs(ev.ts_end), tsMs(ev.ts));
  return tsMs(ev.ts) + (collapsed.collapsedInto.get(ev.external_id)?.span_ms ?? 0);
}

function openSession(
  ev: SegEvent,
  input: SegmentInput,
  reason: BoundaryReason,
  measured: MeasuredParams,
  collapsed: Collapsed,
): SessionCursor {
  const chars = charsOf(ev);
  const isTx = input.policy.transaction_isolates && ev.transaction === true;
  return {
    id: sessionIdOf(input.stream.key, ev.ts, ev.external_id),
    stream_key: input.stream.key,
    source_id: input.stream.source_id ?? null,
    tz: input.stream.tz,
    kind: input.policy.kind,
    started_at: ev.ts,
    ended_at: isoOf(endOf(ev, collapsed)),
    event_ids: [ev.external_id],
    actors: [ev.actor],
    boundary_reason_start: reason,
    boundary_reason_end: null,
    boundary_params: { start: measured, end: null },
    status: "open",
    seal_mode: null,
    sealed_at: null,
    content_hash: null,
    superseded_hash: null,
    hash_version: HASH_VERSION,
    late_arrival: false,
    overlap_of: null,
    attachments: [],
    event_count: 1,
    chars,
    tokens: tokensOfChars(chars),
    collapsed_count: collapsed.collapsedInto.get(ev.external_id)?.count ?? 0,
    active_ms: 0,
    coarse: false,
    initiator: input.policy.author_shift ? authorOf(ev) : ev.actor,
    context: contextKeyOf(ev),
    transaction: isTx,
    record: recordKeyOf(ev),
  };
}

function appendEvent(session: SessionCursor, ev: SegEvent, collapsed: Collapsed): void {
  const gap = tsMs(ev.ts) - tsMs(session.ended_at);
  session.event_ids.push(ev.external_id);
  if (!session.actors.includes(ev.actor)) session.actors.push(ev.actor);
  session.event_count += 1;
  session.chars += charsOf(ev);
  session.tokens = tokensOfChars(session.chars);
  session.collapsed_count += collapsed.collapsedInto.get(ev.external_id)?.count ?? 0;
  session.active_ms += Math.max(0, gap);
  session.ended_at = isoOf(Math.max(endOf(ev, collapsed), tsMs(session.ended_at)));
  const context = contextKeyOf(ev);
  if (context !== null) session.context = context;
}

/** The sealed shape: the walk's private memory does not survive into the record. */
export function strip(session: SessionCursor): SegSession {
  const { initiator: _i, context: _c, transaction: _t, record: _rec, ...rest } = session;
  return { ...rest, actors: [...rest.actors].sort() };
}

/**
 * Segment one stream. Pure — no DB, no clock, no model.
 *
 * The walk decides WHERE the cuts are. It does not decide when a session seals:
 * bootstrap and steady disagree about that, and only about that, which is why
 * `./seal.ts` owns it and this file does not branch on `run_mode` at all.
 */
export function segment(input: SegmentInput): SegmentResult {
  const ordered = orderEvents(input.events.filter((e) => !isReaction(e)));
  const collapsed =
    input.policy.kind === "ambient"
      ? collapseFrames(
          ordered,
          input.dedupe_distance ?? 6,
          input.policy.silence_ms > 0 ? input.policy.silence_ms : Infinity,
        )
      : { ...NO_COLLAPSE, events: ordered };

  const eventTs = new Map<string, number>();
  for (const [id, iso] of input.known_event_ts ?? []) eventTs.set(id, tsMs(iso));
  for (const ev of ordered) eventTs.set(ev.external_id, tsMs(ev.ts));
  const ctx: BoundaryContext = { policy: input.policy, tz: input.stream.tz, eventTs };

  const sessions: SessionCursor[] = [];
  let current: SessionCursor | null = null;

  for (const ev of collapsed.events) {
    if (current === null) {
      // A BOUNDED lane's first session exists because the RECORD does — saying
      // "stream_start" there would name the import, not the thing.
      const [reason, measured]: [BoundaryReason, MeasuredParams] =
        input.policy.kind === "bounded"
          ? ["record_bounded", { rule: "record_bounded", record: recordKeyOf(ev) }]
          : ["stream_start", { rule: "stream_start" }];
      current = openSession(ev, input, reason, measured, collapsed);
      sessions.push(current);
      continue;
    }
    const boundary = boundaryFor(current, ev, ctx);
    if (boundary === null) {
      appendEvent(current, ev, collapsed);
      continue;
    }
    current.boundary_reason_end = boundary.reason;
    current.boundary_params = { start: current.boundary_params.start, end: boundary.measured };
    current = openSession(ev, input, boundary.reason, boundary.measured, collapsed);
    sessions.push(current);
  }

  // AMBIENT low-salience collapse: a run where nothing cleared the floor is ONE
  // coarse session (§10.2). It is not worth an LLM call, and slicing it into
  // fifteen-minute pieces would only multiply the nothing.
  const floor = input.coarse_salience_max;
  const merged =
    input.policy.kind === "ambient" && typeof floor === "number"
      ? coarsen(sessions, collapsed.events, floor)
      : sessions;

  const out = merged.map(strip);
  return {
    sessions: out,
    open: out.length > 0 ? out[out.length - 1]! : null,
    collapsed: collapsed.removed,
    considered: collapsed.events.length,
  };
}

/**
 * Merge consecutive sessions whose every event is at or below the salience
 * floor into ONE coarse session, marked so downstream knows it is worth one
 * cheap pass and zero model calls.
 */
function coarsen(sessions: SessionCursor[], events: readonly SegEvent[], floor: number): SessionCursor[] {
  const salience = new Map(events.map((e) => [e.external_id, e.salience ?? 1]));
  const dull = (s: SessionCursor): boolean => s.event_ids.every((id) => (salience.get(id) ?? 1) <= floor);
  const out: SessionCursor[] = [];
  for (const session of sessions) {
    const prev = out[out.length - 1];
    if (prev && prev.coarse && dull(session)) {
      prev.event_ids.push(...session.event_ids);
      for (const a of session.actors) if (!prev.actors.includes(a)) prev.actors.push(a);
      prev.event_count += session.event_count;
      prev.chars += session.chars;
      prev.tokens = tokensOfChars(prev.chars);
      prev.collapsed_count += session.collapsed_count;
      prev.active_ms += session.active_ms;
      prev.ended_at = session.ended_at;
      prev.boundary_reason_end = session.boundary_reason_end;
      prev.boundary_params = { start: prev.boundary_params.start, end: session.boundary_params.end };
      continue;
    }
    if (dull(session)) session.coarse = true;
    out.push(session);
  }
  return out;
}
