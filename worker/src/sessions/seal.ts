// ===========================================================================
// [CODE] Sealing — two modes, one segmenter (arch §10.4; build item 1.7).
//
// The cut and the seal are different questions, and conflating them is how a
// backfill and a live tail end up with different sessions over the same events.
// `./segment.ts` decides WHERE a session ends. This file decides WHEN it stops
// being open, and the only input that differs between backfill and live is the
// run mode:
//
//   BOOTSTRAP — history is complete, so the next event is already on disk.
//               Every boundary is already known, so every session SEALS AT
//               ONCE (`seal_mode:"immediate"`). The one exception is the newest
//               session of each stream: nothing proves it is finished, so it
//               stays OPEN and is handed to the steady rules.
//
//   STEADY    — live. A session seals on debounce expiry, on any boundary
//               trigger, or on the 24h ceiling. The first two record
//               `seal_mode:"debounce"`, the third `seal_mode:"ceiling"`.
//
// ⚠ Sealing is INDEPENDENT of understanding (§10.4). The live trigger extracts
//   from a session every ~30 s while it is still open; nothing here waits for
//   it, and nothing here is delayed by it.
//
// On seal: the content hash is computed over the members INCLUDING their
// enrichment text, membership becomes immutable, and the boundary reason plus
// its MEASURED parameters are recorded. The hash is then the gate: a session
// already understood at this hash is skipped downstream.
// ===========================================================================

import type { BoundaryReason, SealMode, SegmentRunMode, SessionPolicy } from "./policies.js";
import { contentHashOf, tsMs, type MeasuredParams, type SegSession } from "./segment.js";

/** The text a member contributes to the content hash. */
export interface HashableEvent {
  external_id: string;
  text: string;
  /** Caption / transcript / scraped page text — INSIDE the hash (§10.4). */
  enrichment_text?: string;
}

export type EventTextIndex = ReadonlyMap<string, HashableEvent>;

/** Build the index `sealSession` hashes from. */
export function textIndex(events: readonly HashableEvent[]): Map<string, HashableEvent> {
  return new Map(events.map((e) => [e.external_id, e]));
}

// ---- deadlines -------------------------------------------------------------

/**
 * When a live session goes quiet enough to be worth judging. Recomputed from
 * the session's LAST EVENT TS, never from a timer object — §10.4 note 7: on
 * boot the timers are re-derived, and a timer that only existed in memory would
 * silently reset every restart.
 */
export function debounceDeadline(session: SegSession, policy: SessionPolicy): number {
  return tsMs(session.ended_at) + policy.debounce_ms;
}

/** The wall-clock ceiling, measured from the session's start. */
export function ceilingDeadline(session: SegSession, policy: SessionPolicy): number {
  if (!Number.isFinite(policy.ceiling_ms)) return Infinity;
  return tsMs(session.started_at) + policy.ceiling_ms;
}

// ---- the decision ----------------------------------------------------------

export interface SealDecision {
  seal: boolean;
  mode: SealMode | null;
  reason: BoundaryReason | null;
  /** The measured numbers behind the decision. Never a bare label. */
  measured: MeasuredParams;
  /** Epoch ms the session is recorded as sealed at. */
  at: number | null;
}

export interface SealContext {
  policy: SessionPolicy;
  run_mode: SegmentRunMode;
  /** Epoch ms "now". Frozen by callers that need replay. */
  now: number;
}

const NOT_DUE: SealDecision = { seal: false, mode: null, reason: null, measured: {}, at: null };

/**
 * Should this open session seal now?
 *
 * Bootstrap answers yes unconditionally — the caller has already established
 * that a later event exists, which is what "history is complete" means. Steady
 * answers on the clock: the ceiling first (it is absolute), then the debounce.
 */
export function sealDue(session: SegSession, ctx: SealContext): SealDecision {
  if (session.status === "sealed") return NOT_DUE;

  if (ctx.run_mode === "bootstrap") {
    return {
      seal: true,
      mode: "immediate",
      reason: session.boundary_reason_end ?? "gap",
      measured: session.boundary_params.end ?? { rule: "bootstrap_next_row_known" },
      at: tsMs(session.ended_at),
    };
  }

  // A session a rule already cut is finished by THAT rule, and says so. This is
  // checked before the clock on purpose: a session cut months ago is long past
  // any ceiling measured against `now`, and reporting "ceiling" for it would
  // erase the boundary that actually fired.
  if (session.boundary_reason_end !== null) {
    return {
      seal: true,
      mode: session.boundary_reason_end === "ceiling" ? "ceiling" : "debounce",
      reason: session.boundary_reason_end,
      measured: session.boundary_params.end ?? {},
      at: tsMs(session.ended_at),
    };
  }

  const ceiling = ceilingDeadline(session, ctx.policy);
  if (ctx.now >= ceiling) {
    return {
      seal: true,
      mode: "ceiling",
      reason: "ceiling",
      measured: {
        span_ms: ctx.now - tsMs(session.started_at),
        ceiling_ms: ctx.policy.ceiling_ms,
      },
      at: ceiling,
    };
  }

  const deadline = debounceDeadline(session, ctx.policy);
  const idle = ctx.now - tsMs(session.ended_at);
  if (ctx.now >= deadline) {
    return {
      seal: true,
      mode: "debounce",
      reason: "debounce",
      measured: { idle_ms: idle, debounce_ms: ctx.policy.debounce_ms },
      at: deadline,
    };
  }
  return { ...NOT_DUE, measured: { idle_ms: idle, debounce_ms: ctx.policy.debounce_ms } };
}

// ---- the seal --------------------------------------------------------------

export interface SealOptions {
  mode: SealMode;
  reason: BoundaryReason;
  measured?: MeasuredParams;
  /** Epoch ms recorded as `sealed_at`. */
  at: number;
  texts: EventTextIndex;
}

/**
 * Seal a session: freeze membership, compute the content hash over the members
 * INCLUDING their enrichment text, and record the reason with its measured
 * params. Returns a new object — a sealed session is never mutated in place,
 * because "immutable membership" that relies on nobody pushing to an array is
 * not immutable.
 */
export function sealSession(session: SegSession, options: SealOptions): SegSession {
  const members: HashableEvent[] = session.event_ids.map(
    (id) => options.texts.get(id) ?? { external_id: id, text: "" },
  );
  return {
    ...session,
    event_ids: [...session.event_ids],
    actors: [...session.actors],
    attachments: [...session.attachments],
    status: "sealed",
    seal_mode: options.mode,
    sealed_at: new Date(options.at).toISOString(),
    boundary_reason_end: session.boundary_reason_end ?? options.reason,
    boundary_params: {
      start: session.boundary_params.start,
      end: session.boundary_params.end ?? options.measured ?? {},
    },
    content_hash: contentHashOf(members),
    superseded_hash: session.superseded_hash,
  };
}

// ---- sealing a whole stream ------------------------------------------------

export interface SealStreamResult {
  sessions: SegSession[];
  /** The still-open tail, when there is one. */
  open: SegSession | null;
  /** True when bootstrap deliberately left the newest session open (§10.4). */
  handed_to_steady: boolean;
  sealed_count: number;
}

/**
 * Apply the seal rules to one stream's sessions.
 *
 * BOOTSTRAP seals everything but the newest and hands that one to the steady
 * rules — which may still seal it, if it is already past its debounce or its
 * ceiling by the time the import finishes.
 */
export function sealStream(
  sessions: readonly SegSession[],
  ctx: SealContext,
  texts: EventTextIndex,
): SealStreamResult {
  const out: SegSession[] = [];
  let open: SegSession | null = null;
  let handed = false;

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!;
    const isNewest = i === sessions.length - 1;
    if (session.status === "sealed") {
      out.push(session);
      continue;
    }
    // §10.4's open-tail exception: nothing proves the newest session of a
    // bootstrap is over, so it is handed to the STEADY rules rather than sealed
    // on faith — which may still seal it, if the import finished long after it.
    const effective: SealContext =
      ctx.run_mode === "bootstrap" && isNewest ? { ...ctx, run_mode: "steady" } : ctx;
    if (effective !== ctx) handed = true;

    const decision = sealDue(session, effective);
    if (!decision.seal) {
      out.push(session);
      open = session;
      continue;
    }
    out.push(
      sealSession(session, {
        mode: decision.mode!,
        reason: decision.reason!,
        measured: decision.measured,
        at: decision.at ?? tsMs(session.ended_at),
        texts,
      }),
    );
  }

  return {
    sessions: out,
    open,
    handed_to_steady: handed,
    sealed_count: out.filter((s) => s.status === "sealed").length,
  };
}

// ---- restart safety (§10.4 note 7) ----------------------------------------

export interface RestartResult {
  sessions: SegSession[];
  /** Sessions whose window had already passed when the worker came back. */
  sealed_on_boot: string[];
  /** Sessions that are legitimately still open. */
  still_open: string[];
  /** Per session: the deadline recomputed from its last event ts. */
  deadlines: Record<string, number>;
}

/**
 * On boot, recompute every open session's timers FROM ITS LAST EVENT TS and
 * seal anything already past its window.
 *
 * The bug this prevents is subtle and permanent: a debounce held only in memory
 * restarts at zero every time the app does, so a session on a machine that
 * reboots hourly never seals at all. Deriving the deadline from data on disk
 * makes a restart invisible to the outcome.
 */
export function recomputeTimers(
  open: readonly SegSession[],
  ctx: SealContext,
  texts: EventTextIndex,
): RestartResult {
  const sessions: SegSession[] = [];
  const sealedOnBoot: string[] = [];
  const stillOpen: string[] = [];
  const deadlines: Record<string, number> = {};

  for (const session of open) {
    const steady: SealContext = { ...ctx, run_mode: "steady" };
    deadlines[session.id] = Math.min(debounceDeadline(session, ctx.policy), ceilingDeadline(session, ctx.policy));
    const decision = sealDue(session, steady);
    if (!decision.seal) {
      sessions.push(session);
      stillOpen.push(session.id);
      continue;
    }
    sessions.push(
      sealSession(session, {
        mode: decision.mode!,
        reason: decision.reason!,
        measured: decision.measured,
        at: decision.at ?? tsMs(session.ended_at),
        texts,
      }),
    );
    sealedOnBoot.push(session.id);
  }
  return { sessions, sealed_on_boot: sealedOnBoot, still_open: stillOpen, deadlines };
}

// ---- the hash gate ---------------------------------------------------------

export interface HashGateVerdict {
  hash: string | null;
  /** True when this exact content has already been understood. */
  skip: boolean;
}

/**
 * §10.4's HASH GATE. Understanding is keyed on content, not on session id, so a
 * re-segmentation that produces the same members with the same text costs
 * nothing downstream — and a late caption, which MOVES the hash, correctly does
 * not.
 */
export function hashGate(session: SegSession, understood: ReadonlySet<string>): HashGateVerdict {
  const hash = session.content_hash;
  return { hash, skip: hash !== null && understood.has(hash) };
}
