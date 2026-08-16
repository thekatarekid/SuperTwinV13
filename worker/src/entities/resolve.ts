// ===========================================================================
// [CODE] The resolution ladder — arch §10.3, build item 1.10.
//
//   ① exact (source_id, kind, value_norm)  [CODE] ──► BIND    conf 1.0
//   ② cross-source exact, phone/email only [CODE] ──► BIND    conf 1.0
//   ③ calibrated similarity                [ML]   ──► BIND at/above the bind bar
//   ④ P-AG1, ≤3 turns, read-only, 60 s     [AGENT]──► BIND at/above 0.8
//   ⑤ the resolution queue                        ──► ASK THE HUMAN
//
// Rungs ① and ② live in `binding.ts` and are already exact. This file owns
// ③, ④ and ⑤, and four rules govern all of it.
//
// ZERO SILENT GUESSES. Every outcome carries `decided_by` and a confidence,
// and `assertProvenance` refuses to let a bind through without both. A merge
// that nobody can attribute is a merge nobody can undo.
//
// THE [ML] RUNG IS OFF WHEN CALIBRATION IS MISSING OR STALE. Not "defaulted",
// not "run with 0.85" — OFF. `similarityRungEnabled` (item 0.7) is asked
// BEFORE anything is scored, and a pair that arrives with no usable floor
// carries no score at all into the next rung: reporting one is what makes a
// blocked comparison look like a weak match downstream. There is no threshold
// constant in this file that was not measured or stated by the architecture.
//
// A `different` IS NEVER RE-PROPOSED. `mayPropose` is the first thing the
// ladder asks, above every rung — so a pair the user split stays split through
// every re-derivation, whatever a later score says. And an `unsure` from the
// agent goes to the queue and STOPS: it is never auto-retried, because the
// thing that made it a question has not changed.
//
// THE AGENT IS NEVER ON THE FIRST-PAINT PATH. `routePair` refuses to send a
// first-paint pair to rung ④ at all, and during bootstrap pairs are batched to
// horizon boundaries instead of being adjudicated one at a time — so a backlog
// of maybe-duplicates can never sit between the user and their data.
//
// Rung ④ itself — the P-AG1 call, the batch and the verdict — is `./adjudicate.ts`.
// It is the only asynchronous part of the ladder, so it is the part that is
// split off: nothing in THIS file can reach the network, which is what lets
// `resolvePair` be called from a synchronous ingest path without a second
// thought. Rung ④ ends by coming back through `applyRoute` here, so there is
// exactly one place a merge happens and one place provenance is asserted.
// ===========================================================================

import {
  calibrationFor,
  normalizedScore,
  similarityRungEnabled,
  USE_CASE_BARS,
  type CalibrationVerdict,
  type CalibUseCase,
  type UseCaseBars,
} from "../retrieval/calibration.js";
import type { SchedulerMode } from "../scheduler/horizons.js";
import type { Horizon } from "../tiers/priority.js";
import { bindIdentity, type BindParams, type BindResult } from "./binding.js";
import {
  isNegativePair,
  logMutation,
  mayPropose,
  mergeEntities,
  queueResolution,
  readDecision,
  type MergeResult,
} from "./merge.js";
import { resolveEntityId } from "./registry.js";

/** The rungs, in order. `mint` is rung ②'s "nothing matched" outcome. */
export const LADDER_RUNGS = ["exact", "cross_source", "mint", "ml", "agent", "queue"] as const;
export type LadderRung = (typeof LADDER_RUNGS)[number];

/** What actually happened to the pair. */
export type PairOutcome = "merged" | "different" | "queued" | "deferred" | "refused";

/** Where the router says the pair goes next. */
export type PairNext = "bind" | "different" | "agent" | "queue" | "refuse";

/**
 * The bar an agent verdict must clear to bind on its own — evals G-039..044
 * ("expect same conf>=0.8; below bar -> resolution queue") and the §12.2
 * worked example, which binds at 0.88. Stated by the specification, not
 * chosen here.
 */
export const AGENT_BIND_BAR = 0.8;

/** The similarity channel an entity pair is scored on by default (§10.3). */
export const DEFAULT_PAIR_USE_CASE: CalibUseCase = "entity_name";

export const AGENT_DECIDER = "agent:p-ag1";

// ---- provenance ------------------------------------------------------------

/**
 * The one thing every bind must carry. Called on every path that changes the
 * graph, so "who decided this, and how sure were they" is structurally
 * impossible to omit rather than merely discouraged.
 */
export function assertProvenance(decidedBy: string, confidence: number | null): void {
  if (typeof decidedBy !== "string" || decidedBy.trim() === "") {
    throw new Error("resolve: a bind with no decided_by is a silent guess");
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new Error(`resolve: ${decidedBy} bound a pair with no confidence`);
  }
}

// ---- routing ---------------------------------------------------------------

export interface PairContext {
  left: string;
  right: string;
  /** Which calibrated channel the score came from. Default `entity_name`. */
  useCase?: CalibUseCase;
  /** Embedding model id. Defaults to the active one. */
  model?: string;
  now?: number;
  /** Raw cosine. Normalised HERE against the measured floor, never before. */
  cosine?: number;
  /** An already-normalised calibrated score, when the caller did the maths. */
  score?: number;
  /** Measured bars. Defaults to the use case's row in `USE_CASE_BARS`. */
  bars?: UseCaseBars;
  /** Bootstrap batches the agent rung; steady may run it inline. */
  mode?: SchedulerMode;
  horizon?: Horizon;
  /** True on the path the user is waiting on. Bars the agent rung outright. */
  firstPaint?: boolean;
  /** False when no agent lane exists at all — the agent rung folds to ⑤. */
  agentAvailable?: boolean;
  /** The wording the queue shows the human. */
  question?: string;
}

export interface PairRoute {
  left: string;
  right: string;
  rung: LadderRung;
  next: PairNext;
  /** Normalised score, or null when the rung was never allowed to score. */
  score: number | null;
  cosine: number | null;
  bars: UseCaseBars;
  /** Null only when the pair never reached the [ML] rung. */
  calibration: CalibrationVerdict | null;
  /** Whether the [ML] rung was allowed to run at all. */
  mlEnabled: boolean;
  decidedBy: string;
  confidence: number | null;
  reason: string;
  refused?: "missing" | "same_entity" | "negative_pair";
}

function bail(
  left: string,
  right: string,
  bars: UseCaseBars,
  refused: NonNullable<PairRoute["refused"]>,
  reason: string,
): PairRoute {
  return {
    left,
    right,
    rung: "queue",
    next: "refuse",
    score: null,
    cosine: null,
    bars,
    calibration: null,
    mlEnabled: false,
    decidedBy: "code:ladder",
    confidence: null,
    reason,
    refused,
  };
}

/** Has the agent already answered about this pair? Then it is not re-asked. */
export function agentAlreadyAsked(left: string, right: string): boolean {
  const decided = readDecision(left, right);
  return decided !== null && (decided.decidedBy ?? "").startsWith(AGENT_DECIDER);
}

/**
 * Decide which rung this pair belongs on. Pure with respect to the graph — it
 * reads decisions and calibration, and changes nothing. `applyRoute` performs.
 */
export function routePair(ctx: PairContext): PairRoute {
  const useCase = ctx.useCase ?? DEFAULT_PAIR_USE_CASE;
  const bars = ctx.bars ?? USE_CASE_BARS[useCase];
  const left = resolveEntityId(ctx.left);
  const right = resolveEntityId(ctx.right);

  if (!left || !right) {
    return bail(ctx.left, ctx.right, bars, "missing", "one side of the pair is not an entity");
  }
  if (left === right) {
    return bail(left, right, bars, "same_entity", "both sides already resolve to one entity");
  }
  // Above every rung: a stored `different` is permanent and is never re-asked,
  // however confident a later score is (evals G-029..038, G-051..054).
  if (!mayPropose(left, right)) {
    return bail(left, right, bars, "negative_pair", "a stored `different` verdict is permanent");
  }

  // ③ [ML] — the gate first, the maths second. A missing or stale floor
  // DISABLES the rung; no score is computed and none is reported.
  const calibration = calibrationFor(useCase, { model: ctx.model, now: ctx.now });
  const ready = calibration.state === "ready" && calibration.floor !== null;
  // Rung ③ could not decide (disabled, unscored, or in-band): rung ④ takes it,
  // unless the agent is barred — no lane, the first-paint path, or it has
  // already answered about this pair — in which case rung ⑤ does.
  const escalate = (reason: string, mlEnabled: boolean, score: number | null): PairRoute => {
    const agentBarred =
      ctx.agentAvailable === false || ctx.firstPaint === true || agentAlreadyAsked(left, right);
    return {
      left,
      right,
      rung: agentBarred ? "queue" : "agent",
      next: agentBarred ? "queue" : "agent",
      score,
      cosine: ctx.cosine ?? null,
      bars,
      calibration,
      mlEnabled,
      decidedBy: agentBarred ? queueDecider(ctx, left, right) : AGENT_DECIDER,
      confidence: null,
      reason,
    };
  };

  if (!ready) {
    return escalate(`[ML] similarity disabled: ${calibration.reason}`, false, null);
  }

  const score =
    typeof ctx.score === "number" && Number.isFinite(ctx.score)
      ? ctx.score
      : typeof ctx.cosine === "number" && Number.isFinite(ctx.cosine)
        ? normalizedScore(ctx.cosine, calibration.floor as number)
        : null;

  if (score === null) {
    // Calibrated, but nobody handed this pair a similarity to judge. That is
    // not a zero and it is not a match — it is an unscored pair.
    return escalate("[ML] rung is calibrated but the pair carries no similarity", true, null);
  }

  if (score >= bars.bind) {
    return {
      left,
      right,
      rung: "ml",
      next: "bind",
      score,
      cosine: ctx.cosine ?? null,
      bars,
      calibration,
      mlEnabled: true,
      decidedBy: `ml:${useCase}`,
      confidence: score,
      reason: `normalised ${score.toFixed(3)} ≥ bind bar ${bars.bind}`,
    };
  }
  if (score >= bars.band) {
    return escalate(`normalised ${score.toFixed(3)} is in the ${bars.band}–${bars.bind} band`, true, score);
  }
  return {
    left,
    right,
    rung: "ml",
    next: "different",
    score,
    cosine: ctx.cosine ?? null,
    bars,
    calibration,
    mlEnabled: true,
    decidedBy: `ml:${useCase}`,
    confidence: score,
    reason: `normalised ${score.toFixed(3)} < band floor ${bars.band}`,
  };
}

function queueDecider(ctx: PairContext, left: string, right: string): string {
  if (agentAlreadyAsked(left, right)) return `${AGENT_DECIDER}:unsure`;
  if (ctx.firstPaint === true) return "code:first_paint";
  return "code:no_agent";
}

// ---- applying --------------------------------------------------------------

export interface PairResolution {
  left: string;
  right: string;
  rung: LadderRung;
  outcome: PairOutcome;
  decidedBy: string;
  confidence: number | null;
  score: number | null;
  reason: string;
  /** Set when the pair was parked for the batched agent lane. */
  horizon: Horizon | null;
  questionId: string | null;
  merge: MergeResult | null;
  refused: PairRoute["refused"] | null;
}

/** One pair waiting for the agent lane. `adjudicate.ts` drains these. */
export interface PendingAdjudication {
  left: string;
  right: string;
  horizon: Horizon | null;
  useCase: CalibUseCase;
  score: number | null;
  reason: string;
}

/**
 * The batch, seen from here: somewhere to park a pair. The real one lives in
 * `adjudicate.ts` — this module knows only that it can be handed a pair, which
 * is what keeps the synchronous half free of the asynchronous half.
 */
export interface AgentBatchSink {
  add(pending: PendingAdjudication): void;
}

export interface ApplyOptions {
  /** Bootstrap parks agent-rung pairs here instead of calling out per pair. */
  batch?: AgentBatchSink;
  runId?: string | null;
}

function questionText(ctx: PairContext): string {
  return ctx.question ?? "Are these the same person?";
}

/**
 * Park the pair as a question for the human — rung ⑤, and the terminus of
 * every rung above it that could not decide. Exported because rung ④ lives in
 * `adjudicate.ts` and must end in exactly this queue, not a second one.
 */
export function queuePair(route: PairRoute, ctx: PairContext, reason: string): PairResolution {
  const questionId = queueResolution({
    left: route.left,
    right: route.right,
    question: questionText(ctx),
    reason,
  });
  return {
    left: route.left,
    right: route.right,
    rung: "queue",
    outcome: "queued",
    decidedBy: reason,
    confidence: route.score,
    score: route.score,
    reason: route.reason,
    horizon: ctx.horizon ?? null,
    questionId,
    merge: null,
    refused: null,
  };
}

/**
 * Bind. `decided_by` and confidence are asserted before the write, the merge
 * itself is `merge.ts`'s tombstone, and a second mutation row records WHICH
 * RUNG bound them — which is the row an "explain this merge" surface reads.
 */
function bind(route: PairRoute, ctx: PairContext, opts: ApplyOptions): PairResolution {
  assertProvenance(route.decidedBy, route.confidence);
  const merge = mergeEntities({
    loser: route.right,
    winner: route.left,
    actor: route.decidedBy,
    runId: opts.runId ?? null,
    reason: route.reason,
  });
  if (!merge.merged) {
    // The graph refused after the router allowed it (a decision landed in
    // between). It is a question now, not a retry.
    return { ...queuePair(route, ctx, `${route.decidedBy}:refused`), refused: merge.refused ?? null };
  }
  logMutation({
    actor: route.decidedBy,
    runId: opts.runId ?? null,
    targetKind: "entity_pair",
    targetId: `${route.left}|${route.right}`,
    field: "resolution",
    newValue: { rung: route.rung, decidedBy: route.decidedBy, confidence: route.confidence, score: route.score },
    reason: route.reason,
  });
  return {
    left: route.left,
    right: route.right,
    rung: route.rung,
    outcome: "merged",
    decidedBy: route.decidedBy,
    confidence: route.confidence,
    score: route.score,
    reason: route.reason,
    horizon: ctx.horizon ?? null,
    questionId: null,
    merge,
    refused: null,
  };
}

/**
 * Perform a route. The only rung this cannot perform is ④ — calling the agent
 * is asynchronous and, in bootstrap, batched; `adjudicatePair` does that.
 */
export function applyRoute(route: PairRoute, ctx: PairContext, opts: ApplyOptions = {}): PairResolution {
  const base = {
    left: route.left,
    right: route.right,
    score: route.score,
    reason: route.reason,
    horizon: ctx.horizon ?? null,
    questionId: null,
    merge: null,
    refused: null,
  };
  switch (route.next) {
    case "refuse":
      return {
        ...base,
        rung: route.rung,
        outcome: "refused",
        decidedBy: route.decidedBy,
        confidence: null,
        refused: route.refused ?? null,
      };
    case "bind":
      return bind(route, ctx, opts);
    case "different":
      // Below the band the pair is simply not similar. NOTHING is written: a
      // low score is not a verdict, and storing it as one would make a
      // permanent negative pair out of an embedding's shrug.
      return {
        ...base,
        rung: route.rung,
        outcome: "different",
        decidedBy: route.decidedBy,
        confidence: route.confidence,
      };
    case "agent": {
      // Bootstrap parks it for the horizon boundary; steady hands it back for
      // the caller to adjudicate now. Either way nothing is decided yet.
      if (opts.batch) {
        opts.batch.add({
          left: route.left,
          right: route.right,
          horizon: ctx.horizon ?? null,
          useCase: ctx.useCase ?? DEFAULT_PAIR_USE_CASE,
          score: route.score,
          reason: route.reason,
        });
      }
      return {
        ...base,
        rung: "agent",
        outcome: "deferred",
        decidedBy: AGENT_DECIDER,
        confidence: null,
      };
    }
    case "queue":
    default:
      return queuePair(route, ctx, route.decidedBy);
  }
}

/**
 * Rungs ③–⑤ for one pair, synchronously. The agent is never CALLED here — a
 * pair that belongs to it comes back `deferred`, parked on the batch when one
 * was supplied. Nothing in this function can reach the network.
 */
export function resolvePair(ctx: PairContext, opts: ApplyOptions = {}): PairResolution {
  return applyRoute(routePair(ctx), ctx, opts);
}

// ---- the whole ladder for one incoming identity ----------------------------

export interface IdentityLadderParams extends BindParams {
  /** Entities rung ③ should consider when rungs ①/② mint a new one. */
  candidates?: readonly string[];
  /** Per-candidate similarity, keyed by candidate entity id. */
  scores?: Readonly<Record<string, number>>;
  ladder?: Omit<PairContext, "left" | "right" | "score">;
  apply?: ApplyOptions;
}

export interface IdentityResolution {
  bind: BindResult;
  /** The rung that answered — `exact`, `cross_source`, or `mint` plus more. */
  rung: LadderRung;
  /** One entry per candidate the ladder escalated. Empty when ①/② answered. */
  escalations: PairResolution[];
}

/**
 * One incoming identity, all five rungs. Rungs ① and ② are `bindIdentity`'s
 * and are exact; only a MINT escalates, because only a mint is a claim that
 * this is somebody new — and that claim is the one worth checking.
 */
export function resolveIdentity(params: IdentityLadderParams): IdentityResolution {
  const bind = bindIdentity(params);
  assertProvenance(bind.decidedBy, bind.confidence);
  if (bind.rung !== "mint") {
    return { bind, rung: bind.rung, escalations: [] };
  }

  const escalations: PairResolution[] = [];
  for (const candidate of params.candidates ?? []) {
    const resolved = resolveEntityId(candidate);
    if (!resolved || resolved === bind.entityId) continue;
    if (isNegativePair(resolved, bind.entityId)) continue;
    const score = params.scores?.[candidate] ?? params.scores?.[resolved];
    const resolution = resolvePair(
      {
        ...(params.ladder ?? {}),
        left: resolved,
        right: bind.entityId,
        ...(typeof score === "number" ? { score } : {}),
      },
      params.apply ?? {},
    );
    escalations.push(resolution);
    if (resolution.outcome === "merged") break;
  }
  return { bind, rung: escalations.at(-1)?.rung ?? "mint", escalations };
}

/** Whether this pair is settled and must not be proposed again. */
export function pairIsSettled(left: string, right: string): boolean {
  return isNegativePair(left, right) || agentAlreadyAsked(left, right);
}

export { similarityRungEnabled };
