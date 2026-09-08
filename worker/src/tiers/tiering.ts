// ===========================================================================
// [CODE + one cached call] V6 stream tiering — Product_V6 §11.1, P1 §5.2;
// build S3.8; evals TIER-01..04.
//
//   T1  replied-in chats, and everything the user actively does
//   T2  businesses the user transacts with (orders, OTPs, bookings, bills)
//   T3  groups and DMs the user is in but never replied to; past businesses
//   T4  marketing from businesses the user never interacted with
//
// Two deciders, in this order, and nothing else:
//
//   CODE   did the user ever write into this stream? (a reply, a reaction, a
//          message of their own — `events.actor = 'self'`, or the source's own
//          self identity on the actor row). Yes → T1, whatever the stream is.
//          A never-replied chat → T3. A screen session, a browser day, a
//          document — the user's own doing — → T1. Code never asks the model
//          about any of this.
//   MODEL  ONE business sender the user never wrote to: `tier.v1` (P-07), one
//          call, cached on the stream. The cache key is the channel's
//          CHARACTER (tiers/classify.ts's tx/pm/ambiguous verdict over the
//          current sample, plus a log2 volume bucket) — not a hash of the
//          newest lines, which would re-ask on every message. Same character,
//          same answer, no call (TIER-03: one call per business).
//
// Misclassification costs latency, never data (§11.1 rule 3): a tier moving UP
// re-queues the stream's already-stamped history (tiers/promote.ts), so a T4
// index-only channel that turns out to be a bill sender is understood in full.
// Promotion on engagement is the same path, triggered from the writers
// (categories/promotion.ts → promoteOnEngagement).
//
// The model call goes through the traced, pooled, budgeted provider path
// exactly like every other pass; a failed or unparseable answer defaults to
// T2 ("unsure → transactional") WITHOUT caching, so it is asked again later.
// ===========================================================================

import { randomUUID } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeRunLedger } from "../db/index.js";
import { reasoningRequestForResolvedCall } from "../brain/reasoning.js";
import { packTierUser, parseTierV1, TIER_SAMPLE_MAX, TIER_V1_ID, TIER_V1_SYSTEM, type TierV1Result } from "../prompts/tier.v1.js";
import { reportBackgroundHold } from "../providers/budget.js";
import { resourcePool, type ResourcePool } from "../providers/pool.js";
import {
  ProviderSelectionError,
  requireMaxOutputTokens,
  resolveModelCall,
  type ResolvedModelCall,
} from "../providers/selection.js";
import type {
  NeutralProviderResult,
  ProviderErrorCode,
  ProviderV2,
} from "../providers/types.js";
import { emptyUsage } from "../providers/usage.js";
import { annotateTrace, bindTraceContext, withTraceContext } from "../traces/context.js";
import { classifyBusinessSample } from "./classify.js";
import {
  assertTierCoverage,
  assignTier,
  countChannelMessages,
  listStreamFacts,
  readChannelSample,
  readStreamFacts,
  readTier,
  unresolvedBusinessDecision,
  type StreamFacts,
  type TierChange,
  type TierDecision,
} from "./derive.js";
import type { Tier } from "./priority.js";
import { requeueStreamHistory, tierRank } from "./promote.js";

export const TIER_DEFAULT_MODEL = "haiku";
export const TIER_TIMEOUT_MS = 60_000;

/** Stream kinds that are a person-to-person chat the user may never have answered. */
const DM_KINDS = new Set(["dm", "direct", "private", "chat", "user", "contact", "individual"]);
const GROUP_KINDS = new Set(["group", "grp", "community"]);

// ---- facts -------------------------------------------------------------------

/**
 * Messages the user themself wrote into the stream. Two spellings of "me" are
 * counted: the V13 envelope's `actor = 'self'` (every adapter since S1) and the
 * legacy actor row bound to the source's self identity.
 */
export function countUserMessagesV6(streamId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM events e
         LEFT JOIN actors a ON a.id = e.actor_id
        WHERE e.stream_id = ?
          AND e.revoked_at IS NULL
          AND (
            e.actor = 'self'
            OR (a.source_ext_id IS NOT NULL
                AND a.source_ext_id = (SELECT value FROM app_state
                                        WHERE key = 'source.' || e.source_id || '.self_identity'))
          )`,
    )
    .get(streamId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** derive.ts's facts with the V6 reply count folded in. */
export function readFactsV6(streamId: string): StreamFacts | null {
  const facts = readStreamFacts(streamId);
  if (!facts) return null;
  return { ...facts, userMessageCount: Math.max(facts.userMessageCount, countUserMessagesV6(streamId)) };
}

export function listFactsV6(): StreamFacts[] {
  return listStreamFacts().map((f) => ({
    ...f,
    userMessageCount: Math.max(f.userMessageCount, countUserMessagesV6(f.streamId)),
  }));
}

// ---- the code rules ------------------------------------------------------------

/**
 * A stream the V6 writer (db/eventlog.ts appendEvents) created carries no
 * `stream_kind`; the WhatsApp key still says what it is: `…@g.us` is a group,
 * `…@s.whatsapp.net` / `…@lid` a DM. Anything else stays unknown (""), which
 * the rules read as the user's own activity.
 */
export function inferKindFromStreamId(streamId: string): string {
  const cut = streamId.indexOf(":st:");
  const source = cut > 0 ? streamId.slice(0, cut) : "";
  const key = cut > 0 ? streamId.slice(cut + 4) : streamId;
  if (source !== "wa" && source !== "whatsapp") return "";
  if (/@g\.us$/i.test(key)) return "group";
  if (/@(s\.whatsapp\.net|lid|c\.us)$/i.test(key)) return "dm";
  return "";
}

/**
 * §11.1 rule 2, the code half. `tier: null` means "a business the user never
 * wrote to" — the one question that goes to the model.
 */
export function decideTierByCode(facts: StreamFacts): TierDecision {
  const kind = ((facts.kind ?? "") || inferKindFromStreamId(facts.streamId)).toLowerCase();
  if (facts.userMessageCount > 0) {
    return {
      tier: "T1",
      rule: "engaged",
      source: "code",
      confidence: null,
      reason: `the user wrote ${facts.userMessageCount} message(s) here`,
      needsModel: false,
    };
  }
  if (facts.isBusiness) {
    return {
      tier: null,
      rule: "business_needs_model",
      source: "code",
      confidence: null,
      reason: "a business sender the user never wrote to — the split is the model's",
      needsModel: true,
    };
  }
  if (facts.isGroup || GROUP_KINDS.has(kind)) {
    return {
      tier: "T3",
      rule: "group_never_replied",
      source: "code",
      confidence: null,
      reason: "a group the user is in but never replied to",
      needsModel: false,
    };
  }
  if (DM_KINDS.has(kind)) {
    return {
      tier: "T3",
      rule: "dm_never_replied",
      source: "code",
      confidence: null,
      reason: "a DM the user never replied to",
      needsModel: false,
    };
  }
  return {
    tier: "T1",
    rule: "self_activity",
    source: "code",
    confidence: null,
    reason: "the user's own activity (screen, browser, document)",
    needsModel: false,
  };
}

// ---- the business character (cache key) --------------------------------------

/**
 * What "the stream changes character" means, made comparable: the code
 * heuristics' verdict over the current sample plus a log2 bucket of the
 * channel's volume. A promotional channel that starts sending bills flips the
 * verdict; a channel that doubles in size earns a second look; a new line of
 * the same kind changes nothing.
 */
export function businessCharacter(sample: readonly string[], totalMessages: number): string {
  const verdict = classifyBusinessSample(sample).verdict;
  const bucket = Math.floor(Math.log2(Math.max(1, totalMessages)));
  return `char:${verdict}/${bucket}`;
}

function cachedBusinessDecision(streamId: string, character: string): TierDecision | null {
  const row = getDb()
    .prepare(`SELECT tier, tier_rule, tier_source, tier_confidence, tier_reason, tier_sample_hash FROM streams WHERE id = ?`)
    .get(streamId) as
    | { tier: string | null; tier_rule: string | null; tier_source: string | null; tier_confidence: number | null; tier_reason: string | null; tier_sample_hash: string | null }
    | undefined;
  if (!row || row.tier_source !== "tier.v1" || row.tier_sample_hash !== character) return null;
  if (row.tier !== "T2" && row.tier !== "T3" && row.tier !== "T4") return null;
  return {
    tier: row.tier,
    rule: row.tier_rule ?? "business_tier_model",
    source: "tier.v1",
    confidence: row.tier_confidence,
    reason: row.tier_reason ?? "cached tier.v1 verdict",
    needsModel: false,
    sampleHash: character,
  };
}

export function decisionFromTierResult(result: TierV1Result, character: string): TierDecision {
  return {
    tier: `T${result.tier}` as Tier,
    rule: "business_tier_model",
    source: "tier.v1",
    confidence: result.confidence,
    reason: result.reason,
    needsModel: false,
    sampleHash: character,
  };
}

// ---- the model call -------------------------------------------------------------

export interface TieringDeps {
  /** Strict provider injection for isolated tests. Production uses the V2 registry. */
  provider?: ProviderV2;
  pool?: ResourcePool;
  timeoutMs?: number;
  now?: () => number;
  /** How many of the channel's newest messages the model sees. */
  sampleSize?: number;
}

export interface TierCallReport {
  status: "ok" | "failed";
  result?: TierV1Result;
  violations: string[];
  error?: string;
  errorCode?: ProviderErrorCode;
}

const PROVIDER_ERROR_CODES = {
  TIMEOUT: true,
  SPAWN_FAILED: true,
  CLI_ERROR: true,
  POISONED_SESSION: true,
  CANCELLED: true,
  QUOTA_EXCEEDED: true,
  BUDGET_EXCEEDED: true,
  MODEL_ACTIVITY_PAUSED: true,
  MAX_TURNS: true,
  BAD_REQUEST: true,
  AUTH_REQUIRED: true,
  AUTH_EXPIRED: true,
  PROVIDER_UNAVAILABLE: true,
  MODEL_UNAVAILABLE: true,
  CAPABILITY_UNSUPPORTED: true,
  BACKEND_UNSUPPORTED: true,
  RATE_LIMITED: true,
  TRANSPORT_ERROR: true,
} as const satisfies Record<ProviderErrorCode, true>;

function providerErrorCode(error: unknown): ProviderErrorCode | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && Object.hasOwn(PROVIDER_ERROR_CODES, code)
    ? code as ProviderErrorCode
    : undefined;
}

/** ONE P-07 call, traced, pooled (understanding lane), ledgered as role `classify`. */
export async function runTierCall(
  input: { streamId: string; name: string | null; sample: readonly string[]; totalMessages: number; userMessages: number },
  deps: TieringDeps = {},
): Promise<TierCallReport> {
  const user = packTierUser({
    name: input.name,
    sample: input.sample,
    totalMessages: input.totalMessages,
    userMessages: input.userMessages,
  });
  return withTraceContext(
    { pass: "tier", caller: "tiers/tiering", promptVersion: TIER_V1_ID },
    async (): Promise<TierCallReport> => {
      let text = "";
      const runId = randomUUID();
      let resolved: ResolvedModelCall;
      let maxOutputTokens: number;
      try {
        resolved = resolveModelCall(
          { source: "step", key: TIER_V1_ID },
          deps.provider ? { provider: deps.provider } : {},
        );
        if (!resolved.modelSnapshot.inputModalities.includes("text")) {
          throw new ProviderSelectionError(
            "CAPABILITY_UNSUPPORTED",
            `model ${resolved.model} does not accept tier text input`,
            {
              providerId: resolved.providerId,
              key: resolved.key,
              model: resolved.model,
            },
          );
        }
        maxOutputTokens = requireMaxOutputTokens(resolved);
      } catch (error) {
        const failure = error instanceof ProviderSelectionError
          ? error
          : new ProviderSelectionError(
              "MODEL_UNAVAILABLE",
              "tier model selection failed",
              { key: TIER_V1_ID, model: null },
            );
        return {
          status: "failed",
          violations: [],
          error: failure.message,
          errorCode: failure.code,
        };
      }
      const model = resolved.model;
      const startedAt = new Date().toISOString();
      const pool = deps.pool ?? resourcePool;
      let res: NeutralProviderResult;
      try {
        res = await pool.run(
          "llm",
          bindTraceContext(() =>
            resolved.provider.send({
              runId,
              model,
              instructions: TIER_V1_SYSTEM,
              input: [{
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: user }],
              }],
              toolChoice: "none",
              text: { format: { type: "text" } },
              plainCompletion: true,
              skipHostSettings: true,
              persistContinuation: false,
              maxOutputTokens,
              maxAgentTurns: resolved.providerId === "claude-local" ? 2 : 1,
              ...reasoningRequestForResolvedCall(resolved),
              timeoutMs: deps.timeoutMs ?? TIER_TIMEOUT_MS,
              onEvent: (e) => {
                if (e.type === "delta") text += e.text;
              },
            }),
          ),
          { lane: "understanding" },
        );
      } catch (err) {
        const errorCode = providerErrorCode(err) ?? "CLI_ERROR";
        res = { continuation: null, usage: emptyUsage(), freshFallback: false, status: "error", errorCode };
        logTierRun(runId, model, startedAt, res, user.length + TIER_V1_SYSTEM.length, resolved.providerId);
        return { status: "failed", violations: [], error: errorCode, errorCode };
      }
      logTierRun(runId, model, startedAt, res, user.length + TIER_V1_SYSTEM.length, resolved.providerId);
      if (res.status !== "ok") {
        return {
          status: "failed",
          violations: [],
          error: res.errorCode ?? "provider error",
          ...(res.errorCode ? { errorCode: res.errorCode } : {}),
        };
      }
      const { result, violations } = parseTierV1(text);
      if (!result) return { status: "failed", violations, error: "unparseable tier output" };
      annotateTrace({ parsedResult: { streamId: input.streamId, ...result } });
      return { status: "ok", result, violations };
    },
  );
}

function logTierRun(runId: string, model: string, startedAt: string, res: NeutralProviderResult, promptChars: number, providerId: string): void {
  const endedAt = new Date().toISOString();
  const usage = res.usage;
  const status = res.status === "ok" ? "ok" : "error";
  const errorCode = res.errorCode ? String(res.errorCode) : null;
  try {
    writeRunLedger({
      run: {
        id: runId,
        role: "classify",
        model,
        cohortId: null,
        kind: TIER_V1_ID,
        pass: TIER_V1_ID,
        origin: "backfill",
        status,
        startedAt,
        endedAt,
        usage,
        errorCode,
        ttftMs: null,
      },
      log: {
        provider: providerId,
        sessionId: null,
        runId,
        kind: TIER_V1_ID,
        promptChars,
        inputTokens: usage.inputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        ...(usage.cacheCreation5mInputTokens === undefined
          ? {}
          : { cacheCreation5mInputTokens: usage.cacheCreation5mInputTokens }),
        ...(usage.cacheCreation1hInputTokens === undefined
          ? {}
          : { cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens }),
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd ?? null,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || 0,
        status,
        errorCode,
        model,
        role: "classify",
      },
    });
  } catch (err) {
    console.error("[tier] run ledger write failed:", err);
  }
}

// ---- tier one stream ---------------------------------------------------------------

export interface TierStreamReport {
  streamId: string;
  decision: TierDecision;
  change: TierChange;
  /** Model calls this decision cost: 0 or 1. */
  modelCalls: number;
  /** True when a business verdict was served from the stream's cache. */
  cached: boolean;
  /** True when the model was asked and gave nothing usable (defaulted to T2, not cached). */
  defaulted: boolean;
  /** Stamped history rows re-queued because the tier moved up. */
  requeued: number;
}

/**
 * Decide and store one stream's tier. Code first; a never-replied business goes
 * to the cached model call. A tier that moves UP re-queues the stream's stamped
 * history so nothing stays understood at the wrong granularity.
 */
export async function tierStream(streamId: string, deps: TieringDeps = {}): Promise<TierStreamReport> {
  const facts = readFactsV6(streamId);
  if (!facts) throw new Error(`tierStream(${streamId}): no such stream`);
  const now = deps.now?.() ?? Date.now();
  let decision = decideTierByCode(facts);
  let modelCalls = 0;
  let cached = false;
  let defaulted = false;

  if (decision.tier === null) {
    const sample = readChannelSample(streamId, deps.sampleSize ?? TIER_SAMPLE_MAX);
    const total = countChannelMessages(streamId);
    const character = businessCharacter(sample, total);
    const hit = cachedBusinessDecision(streamId, character);
    if (hit) {
      decision = hit;
      cached = true;
    } else if (reportBackgroundHold("stream tiering").held) {
      // FIX-C1. Model work is hard-stopped (budget latch / kill switch): the
      // call would be refused before spawn, so it is not made. The stream takes
      // the same UNRESOLVED fallback a failed call takes — T2, not cached — so
      // the next pass after the operator resumes asks it properly. No call, no
      // `runs` row, no cached guess made from an answer nobody gave.
      decision = unresolvedBusinessDecision();
      defaulted = true;
    } else {
      modelCalls = 1;
      const call = await runTierCall(
        { streamId, name: facts.label, sample, totalMessages: total, userMessages: facts.userMessageCount },
        deps,
      );
      if (call.status === "ok" && call.result) {
        decision = decisionFromTierResult(call.result, character);
      } else {
        // Unsure → transactional, and NOT cached: the stream is asked again
        // on the next pass instead of sitting on a guess forever.
        decision = unresolvedBusinessDecision();
        defaulted = true;
      }
    }
  }

  const change = assignTier(streamId, decision);
  let requeued = 0;
  if (change.changed && tierRank(change.to) < tierRank(change.from)) {
    requeued = requeueStreamHistory(streamId, { nowMs: now }).requeued;
  }
  return { streamId, decision, change, modelCalls, cached, defaulted, requeued };
}

// ---- the boot pass -----------------------------------------------------------------

export interface TieringPassReport {
  streams: number;
  assigned: number;
  byTier: Record<Tier, number>;
  modelCalls: number;
  cached: string[];
  defaulted: string[];
  changes: TierChange[];
  requeued: number;
  coverage: number;
}

/**
 * Tier every stream (boot, and any time the operator asks). Code rules cost
 * nothing; each never-replied business costs at most one call, once. Ends in
 * derive.ts's coverage assertion — every stream has a tier or boot says so.
 */
export async function tierAllStreams(deps: TieringDeps = {}): Promise<TieringPassReport> {
  const report: TieringPassReport = {
    streams: 0,
    assigned: 0,
    byTier: { T1: 0, T2: 0, T3: 0, T4: 0 },
    modelCalls: 0,
    cached: [],
    defaulted: [],
    changes: [],
    requeued: 0,
    coverage: 0,
  };
  for (const facts of listFactsV6()) {
    report.streams += 1;
    const r = await tierStream(facts.streamId, deps);
    report.assigned += 1;
    report.byTier[r.change.to] += 1;
    report.modelCalls += r.modelCalls;
    if (r.cached) report.cached.push(facts.streamId);
    if (r.defaulted) report.defaulted.push(facts.streamId);
    if (r.change.changed) report.changes.push(r.change);
    report.requeued += r.requeued;
  }
  report.coverage = assertTierCoverage().coverage;
  return report;
}

/** The stored tier, for callers that only want to read. */
export { readTier };

// ---- the job ----------------------------------------------------------------------

/** How often the worker re-tiers: new streams get a tier, changed characters get re-asked. */
export const TIERING_INTERVAL_MS = 15 * 60_000;

export interface TieringJob {
  stop(): void;
  /** One pass now (boot, tests, an operator). */
  runNow(): Promise<TieringPassReport>;
}

/**
 * Boot + periodic tiering. One pass shortly after boot, then every
 * TIERING_INTERVAL_MS; passes never overlap. Code rules cost nothing; each
 * never-replied business costs at most one pooled, budgeted call, once, and
 * the answer is cached on the stream. A failing pass is logged and never
 * stops the worker.
 */
export function startTieringJob(
  opts: { intervalMs?: number; log?: (line: string) => void; deps?: TieringDeps; immediate?: boolean } = {},
): TieringJob {
  const log = opts.log ?? ((line: string) => console.error(line));
  let running: Promise<TieringPassReport> | null = null;
  let stopped = false;

  const runNow = (): Promise<TieringPassReport> => {
    if (running) return running;
    running = tierAllStreams(opts.deps ?? {})
      .then((report) => {
        if (report.streams > 0) {
          log(
            `[tiers] ${report.assigned}/${report.streams} streams ` +
              `(T1=${report.byTier.T1} T2=${report.byTier.T2} T3=${report.byTier.T3} T4=${report.byTier.T4}) ` +
              `calls=${report.modelCalls} cached=${report.cached.length} changed=${report.changes.length} requeued=${report.requeued}` +
              `${report.defaulted.length > 0 ? ` defaulted=${report.defaulted.length}` : ""}`,
          );
        }
        return report;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  const guarded = (): void => {
    if (stopped) return;
    runNow().catch((err) => log(`[tiers] pass failed (continuing): ${err instanceof Error ? err.message : String(err)}`));
  };

  if (opts.immediate !== false) guarded();
  const timer = setInterval(guarded, opts.intervalMs ?? TIERING_INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow,
  };
}
