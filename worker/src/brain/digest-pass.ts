// ===========================================================================
// The Digest pass runner — digest.v2 (Prompts_V6_Phase1 P-06; Product_V6
// §23.2; V6 P1 S3.8; evals DIG-01, DIG-02).
//
// A tier-3 stream — a never-replied group, a past business — is not understood
// live or by the day. scheduler/v6/digest.ts hands this runner ONE bundle per
// (stream, ended week with new events); this runner makes ONE call over it and
// commits propose-only. An empty week never reaches here (DIG-01).
//
// Rules of the house, all enforced here:
//   * The call goes through the traced, pooled, budgeted provider path —
//     withTraceContext() wraps it, so a call without a trace throws in dev;
//     the pool's understanding lane caps its concurrency (S0.9 / T8-3).
//   * Model defaults to Haiku (build convention 1.7).
//   * PROPOSE-ONLY: the default commit writes decisions rows (action
//     "digest_summary" / "propose" / "propose_recurrence"), never activates
//     anything. Tasks, episodes, spaces, schedules, closures, questions are
//     STRIPPED by the parser (digest-inflation) — a digested stream cannot
//     mint them even if the model tries, and nothing here is ever "active" or
//     "needs the user" (DIG-02). A due date is at most a recurrence candidate.
//   * Evidence is the S3.1 rule: aliases resolve to the real ids this call
//     packed, quotes are verbatim, or the item is dropped.
//
// Production caller: scheduler/v6/dispatch.ts routes digest-lane bundles here
// through its digest sink and marks them on success.
// ===========================================================================

import { randomUUID } from "node:crypto";

import { writeDecision } from "../db/decisions.js";
import { writeRunLedger } from "../db/index.js";
import {
  DIGEST_V2_ID,
  DIGEST_V2_SYSTEM,
  packDigestV2User,
  parseDigestV2,
  type DigestResultV2,
} from "../prompts/digest.v2.js";
import { systemPromptPath } from "../prompts/runner.js";
import { resourcePool, type ResourcePool } from "../providers/pool.js";
import { DEFAULT_PROVIDER_ID, get as getProvider } from "../providers/registry.js";
import type { Provider, ProviderResult } from "../providers/types.js";
import { emptyUsage } from "../providers/usage.js";
import type { DeltaBundle } from "../scheduler/v6/bundle.js";
import { weekKey } from "../scheduler/v6/digest.js";
import { annotateTrace, bindTraceContext, withTraceContext } from "../traces/context.js";

/** Every LLM step defaults to Haiku (spec §14.9, build convention 1.7). */
export const DIGEST_DEFAULT_MODEL = "haiku";
export const DIGEST_TIMEOUT_MS = 120_000;

/** The result type the pass commits — digest.v2's. */
export type DigestResult = DigestResultV2;

export interface DigestCommit {
  /** decisions rows written (all propose-only). */
  proposals: number;
}

export interface DigestPassDeps {
  provider?: Provider;
  /** The LLM pool this call takes a slot from (S0.9 / T8-3). Default: the process pool. */
  pool?: ResourcePool;
  model?: string;
  timeoutMs?: number;
  /** Replaces the default propose-only decisions commit (tests). */
  commit?: (bundle: DeltaBundle, result: DigestResult, violations: string[]) => DigestCommit;
}

export interface DigestPassReport {
  status: "ok" | "failed";
  bundle: { streamId: string; part: number; partCount: number; week: string };
  result?: DigestResult;
  violations: string[];
  proposals: number;
  error?: string;
}

/** The ISO week (Monday) a digest bundle covers — from its first event. */
export function bundleWeek(bundle: DeltaBundle): string {
  const first = bundle.events.find((e) => e.ts && Number.isFinite(Date.parse(e.ts)));
  if (first?.ts) return weekKey(Date.parse(first.ts));
  const day = Date.parse(bundle.day ?? "");
  return Number.isFinite(day) ? weekKey(day) : bundle.day ?? "?";
}

/**
 * Propose-only commit: one decisions row per digest artifact. Nothing here
 * creates a space, task or episode — target kinds are the PROPOSAL surface
 * the review queue reads, and old_json/new_json make every row reversible.
 */
export function commitDigestProposals(
  bundle: DeltaBundle,
  result: DigestResult,
  violations: string[],
): DigestCommit {
  const week = bundleWeek(bundle);
  let proposals = 0;
  writeDecision({
    pass: "digest",
    targetKind: "stream",
    targetId: bundle.streamId,
    action: "digest_summary",
    new: {
      summary: result.summary,
      week,
      part: bundle.part,
      partCount: bundle.partCount,
      violations,
    },
    reason: `${DIGEST_V2_ID} weekly summary for the week of ${week} (propose-only, Product_V6 §23.2)`,
  });
  proposals += 1;
  for (const claim of result.claims) {
    writeDecision({
      pass: "digest",
      targetKind: "claim",
      targetId: `${bundle.streamId}#digest`,
      action: "propose",
      new: { ...claim, week },
      reason: `${DIGEST_V2_ID} durable claim (evidence resolved verbatim, propose-only)`,
    });
    proposals += 1;
  }
  for (const rec of result.recurrences) {
    writeDecision({
      pass: "digest",
      targetKind: "task",
      targetId: `${bundle.streamId}#recurrence`,
      action: "propose_recurrence",
      new: { ...rec, week },
      reason: `${DIGEST_V2_ID} recurrence candidate — never an active task (propose-only, P1 §5.5)`,
    });
    proposals += 1;
  }
  return { proposals };
}

/**
 * Run ONE Digest call over one tier-3 weekly bundle. Traced, Haiku by
 * default, propose-only. A failed run reports and leaves the bundle
 * un-marked, so the dispatcher re-plans it (three strikes → dead-letter).
 */
export async function runDigestPass(
  bundle: DeltaBundle,
  deps: DigestPassDeps = {},
): Promise<DigestPassReport> {
  const week = bundleWeek(bundle);
  const base: DigestPassReport = {
    status: "failed",
    bundle: { streamId: bundle.streamId, part: bundle.part, partCount: bundle.partCount, week },
    violations: [],
    proposals: 0,
  };
  const provider = deps.provider ?? getProvider(DEFAULT_PROVIDER_ID);
  if (!provider) return { ...base, error: "no provider registered" };

  const packed = packDigestV2User({
    streamKey: bundle.streamKey,
    week,
    events: bundle.events,
  });
  const user = packed.text;

  return withTraceContext(
    { pass: "digest", caller: "brain/digest-pass", promptVersion: DIGEST_V2_ID },
    async (): Promise<DigestPassReport> => {
      let text = "";
      const runId = randomUUID();
      const model = deps.model ?? DIGEST_DEFAULT_MODEL;
      const systemFile = systemPromptPath(DIGEST_V2_ID, DIGEST_V2_SYSTEM);
      const startedAt = new Date().toISOString();
      const pool = deps.pool ?? resourcePool;
      let res: ProviderResult;
      try {
        // S0.9 / T8-3: through the pool's understanding lane — digest is
        // backfill understanding and must not bypass the concurrency cap.
        res = await pool.run(
          "llm",
          bindTraceContext(() =>
            provider.send({
              runId,
              message: user,
              systemPromptFile: systemFile,
              plainCompletion: true,
              model,
              timeoutMs: deps.timeoutMs ?? DIGEST_TIMEOUT_MS,
              onEvent: (e) => {
                if (e.type === "delta") text += e.text;
              },
            }),
          ),
          { lane: "understanding" },
        );
      } catch (err) {
        res = {
          sessionId: "",
          usage: emptyUsage(),
          freshFallback: false,
          status: "error",
          errorCode: "CLI_ERROR",
        };
        logDigestRun(runId, model, startedAt, res, user.length + DIGEST_V2_SYSTEM.length, provider.id);
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
      // S0.9 / T8-1: every digest call has a ledger row — its spend renders
      // and TRC-03 sees the pass alive.
      logDigestRun(runId, model, startedAt, res, user.length + DIGEST_V2_SYSTEM.length, provider.id);
      if (res.status !== "ok") {
        return { ...base, error: res.errorCode ?? "provider error" };
      }
      const { result, violations } = parseDigestV2(text, { aliases: packed.aliases, textById: packed.textById });
      if (!result) return { ...base, violations, error: "unparseable digest output" };
      annotateTrace({ parsedResult: { week, ...result } });
      const commit = deps.commit ?? commitDigestProposals;
      const { proposals } = commit(bundle, result, violations);
      return { ...base, status: "ok", result, violations, proposals };
    },
  );
}

/** Both ledger halves for one digest call — role digest, origin backfill. */
function logDigestRun(
  runId: string,
  model: string,
  startedAt: string,
  res: ProviderResult,
  promptChars: number,
  providerId: string,
): void {
  const endedAt = new Date().toISOString();
  const usage = res.usage;
  const status = res.status === "ok" ? "ok" : "error";
  const errorCode = res.errorCode ? String(res.errorCode) : null;
  try {
    writeRunLedger({
      run: {
        id: runId,
        role: "digest",
        model,
        cohortId: null,
        kind: DIGEST_V2_ID,
        pass: DIGEST_V2_ID,
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
        kind: DIGEST_V2_ID,
        promptChars,
        inputTokens: usage.inputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd ?? null,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || 0,
        status,
        errorCode,
        model,
        role: "digest",
      },
    });
  } catch (err) {
    // The ledger must never fail the pass it describes — but it is said.
    console.error("[digest] run ledger write failed:", err);
  }
}
