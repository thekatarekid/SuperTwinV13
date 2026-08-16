// ===========================================================================
// [AGENT] Rung ④ of the resolution ladder, and the bootstrap batch that feeds
// it — arch §10.3 and §12.2, build item 1.10.
//
// Split out of `resolve.ts` because it is the only asynchronous half of the
// ladder: rungs ①–③ and ⑤ are decisions this process can make on its own,
// while ④ is a call out to P-AG1 and everything about it — turns, timeout,
// batching, first-paint exclusion — exists to keep that call off the path the
// user is waiting on.
//
// Two rules this file exists to hold:
//
//   NEVER ON FIRST PAINT     `adjudicatePair` throws on `firstPaint: true`
//                            rather than politely declining, because a rule
//                            that fails quietly is a rule that stops being
//                            true one refactor later (§9.5.1).
//
//   BATCHED IN BOOTSTRAP     a backlog of maybe-duplicates is drained one
//                            HORIZON at a time, at the boundary — never one
//                            pair at a time as the importer walks past.
//                            A parked pair is re-routed before it is asked
//                            about, because the human may have answered it
//                            while it waited.
//
// The agent PROPOSES. Everything that changes the graph goes back through
// `resolve.ts`'s `applyRoute`, so there is one place a merge can happen and
// one place provenance is asserted.
// ===========================================================================

import { USE_CASE_BARS, type CalibUseCase } from "../retrieval/calibration.js";
import type { Horizon } from "../tiers/priority.js";
import { recordDecision } from "./merge.js";
import { resolveEntityId } from "./registry.js";
import {
  AGENT_BIND_BAR,
  AGENT_DECIDER,
  DEFAULT_PAIR_USE_CASE,
  applyRoute,
  queuePair,
  routePair,
  type ApplyOptions,
  type PairContext,
  type PendingAdjudication,
  type PairResolution,
  type PairRoute,
} from "./resolve.js";

export type AgentVerdictKind = "same" | "different" | "unsure";

export interface AgentVerdict {
  left: string;
  right: string;
  verdict: AgentVerdictKind;
  confidence: number | null;
  reason: string;
  evidence?: readonly string[];
}

export interface AgentRequest {
  left: string;
  right: string;
  useCase: CalibUseCase;
  /** The calibrated score, or null when the [ML] rung was disabled. */
  score: number | null;
  reason: string;
}

export type Ag1Adjudicator = (request: AgentRequest) => Promise<AgentVerdict | null>;

/**
 * Apply a P-AG1 verdict. `same` binds only at or above `AGENT_BIND_BAR`;
 * below it, and on `un`, the pair goes to the queue and STAYS there — §12.2:
 * "`un` → resolution queue, never auto-retried".
 */
export function applyAgentVerdict(
  verdict: AgentVerdict,
  ctx: PairContext,
  opts: ApplyOptions = {},
): PairResolution {
  const left = resolveEntityId(verdict.left) ?? verdict.left;
  const right = resolveEntityId(verdict.right) ?? verdict.right;
  const confidence = typeof verdict.confidence === "number" ? verdict.confidence : null;
  const bars = ctx.bars ?? USE_CASE_BARS[ctx.useCase ?? DEFAULT_PAIR_USE_CASE];
  const route: PairRoute = {
    left,
    right,
    rung: "agent",
    next: "queue",
    score: confidence,
    cosine: null,
    bars,
    calibration: null,
    mlEnabled: false,
    decidedBy: AGENT_DECIDER,
    confidence,
    reason: verdict.reason,
  };

  if (verdict.verdict === "same" && confidence !== null && confidence >= AGENT_BIND_BAR) {
    return applyRoute({ ...route, next: "bind" }, ctx, opts);
  }
  if (verdict.verdict === "different") {
    recordDecision({ left, right, verdict: "different", decidedBy: AGENT_DECIDER, reason: verdict.reason });
    return {
      left,
      right,
      rung: "agent",
      outcome: "different",
      decidedBy: AGENT_DECIDER,
      confidence,
      score: confidence,
      reason: verdict.reason,
      horizon: ctx.horizon ?? null,
      questionId: null,
      merge: null,
      refused: null,
    };
  }
  const decider = verdict.verdict === "unsure" ? `${AGENT_DECIDER}:unsure` : `${AGENT_DECIDER}:below_bar`;
  return queuePair(route, ctx, decider);
}

export class FirstPaintViolation extends Error {
  constructor() {
    super("resolve: the P-AG1 rung is barred from the first-paint path (§12.2, build item 1.10)");
    this.name = "FirstPaintViolation";
  }
}

/**
 * The whole ladder, including rung ④. Throws rather than run the agent on the
 * first-paint path — a rule the type system cannot state, so it is stated here
 * loudly instead of being left to a caller's good manners.
 */
export async function adjudicatePair(
  ctx: PairContext,
  adjudicate: Ag1Adjudicator,
  opts: ApplyOptions = {},
): Promise<PairResolution> {
  if (ctx.firstPaint === true) throw new FirstPaintViolation();
  const route = routePair(ctx);
  if (route.next !== "agent") return applyRoute(route, ctx, opts);

  const verdict = await adjudicate({
    left: route.left,
    right: route.right,
    useCase: ctx.useCase ?? DEFAULT_PAIR_USE_CASE,
    score: route.score,
    reason: route.reason,
  });
  if (!verdict) {
    // The agent produced nothing usable. That is a question, not a retry.
    return queuePair(route, ctx, `${AGENT_DECIDER}:no_verdict`);
  }
  return applyAgentVerdict({ ...verdict, left: route.left, right: route.right }, ctx, opts);
}

// ---- the bootstrap batch ---------------------------------------------------

/**
 * Pairs waiting for the agent lane, keyed by horizon. During bootstrap the
 * ladder never calls P-AG1 per pair: it parks them here and the scheduler
 * drains one horizon at a time, at the boundary, off the first-paint path.
 */
export class AgentBatch {
  private readonly pairs = new Map<string, PendingAdjudication>();

  private static key(p: PendingAdjudication): string {
    const [a, b] = p.left <= p.right ? [p.left, p.right] : [p.right, p.left];
    return `${p.horizon ?? "-"}|${a}|${b}`;
  }

  add(pending: PendingAdjudication): void {
    const key = AgentBatch.key(pending);
    if (!this.pairs.has(key)) this.pairs.set(key, pending);
  }

  pending(horizon?: Horizon | null): PendingAdjudication[] {
    const all = [...this.pairs.values()];
    return horizon === undefined ? all : all.filter((p) => p.horizon === horizon);
  }

  size(horizon?: Horizon | null): number {
    return this.pending(horizon).length;
  }

  /** Remove and return one horizon's pairs — the unit the scheduler drains. */
  take(horizon?: Horizon | null): PendingAdjudication[] {
    const taken = this.pending(horizon);
    for (const p of taken) this.pairs.delete(AgentBatch.key(p));
    return taken;
  }

  clear(): void {
    this.pairs.clear();
  }
}

/** The process-wide batch a bootstrap fills. Explicit batches beat it in tests. */
export const bootstrapAgentBatch = new AgentBatch();

/**
 * Drain one horizon's parked pairs through the agent, in order, and apply each
 * verdict. Called at a horizon boundary and nowhere else.
 */
export async function flushAgentBatch(
  horizon: Horizon | null,
  adjudicate: Ag1Adjudicator,
  opts: ApplyOptions & { batch?: AgentBatch; ctx?: Omit<PairContext, "left" | "right"> } = {},
): Promise<PairResolution[]> {
  const batch = opts.batch ?? bootstrapAgentBatch;
  const out: PairResolution[] = [];
  for (const pending of batch.take(horizon)) {
    const ctx: PairContext = {
      ...(opts.ctx ?? {}),
      left: pending.left,
      right: pending.right,
      useCase: pending.useCase,
      horizon: pending.horizon ?? undefined,
      firstPaint: false,
    };
    // The pair may have been settled while it waited. Re-route before asking.
    const route = routePair({ ...ctx, score: pending.score ?? undefined });
    if (route.next !== "agent") {
      out.push(applyRoute(route, ctx, { runId: opts.runId ?? null }));
      continue;
    }
    const verdict = await adjudicate({
      left: route.left,
      right: route.right,
      useCase: pending.useCase,
      score: route.score,
      reason: route.reason,
    });
    out.push(
      verdict
        ? applyAgentVerdict({ ...verdict, left: route.left, right: route.right }, ctx, {
            runId: opts.runId ?? null,
          })
        : queuePair(route, ctx, `${AGENT_DECIDER}:no_verdict`),
    );
  }
  return out;
}
