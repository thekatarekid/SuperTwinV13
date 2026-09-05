// ===========================================================================
// The Digest pass runner — build P1.6, spec §8.5; evals CAT-04, CAT-05.
//
// Cat-2 backfill bundles do NOT go through the full pass ladder; they get ONE
// haiku-class Digest call per chunk (dispatch's max-size split gives band-D
// history its chat-month granularity, spec §5.3, with BND-05 predecessor
// summaries keeping the chunks cumulative).
//
// Rules of the house, all enforced here:
//   * The call goes through the traced claude-local provider path —
//     withTraceContext() wraps it, so a call without a trace throws in dev.
//   * Model defaults to Haiku (build convention 1.7).
//   * PROPOSE-ONLY: the default commit writes decisions rows (action
//     "propose"), never activates anything. Episodes/tasks/spaces are already
//     stripped by the parser (CAT-04 digest-inflation) — a digested stream
//     cannot mint them even if the model tries.
//
// Production caller: dispatch.startDispatcher routes Cat-2 backfill bundles
// here through its digest sink.
// ===========================================================================

import { randomUUID } from "node:crypto";

import { writeDecision } from "../db/decisions.js";
import {
  DIGEST_V1_ID,
  DIGEST_V1_SYSTEM,
  packDigestUser,
  parseDigestV1,
  type DigestResult,
} from "../prompts/digest.v1.js";
import { writeRunLedger } from "../db/index.js";
import { systemPromptPath } from "../prompts/runner.js";
import { resourcePool, type ResourcePool } from "../providers/pool.js";
import { DEFAULT_PROVIDER_ID, get as getProvider } from "../providers/registry.js";
import type { Provider, ProviderResult } from "../providers/types.js";
import { emptyUsage } from "../providers/usage.js";
import { annotateTrace, bindTraceContext, withTraceContext } from "../traces/context.js";
import type { DeltaBundle } from "./dispatch.js";

/** Every LLM step defaults to Haiku (spec §14.9, build convention 1.7). */
export const DIGEST_DEFAULT_MODEL = "haiku";
export const DIGEST_TIMEOUT_MS = 120_000;

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
  bundle: { streamId: string; part: number; partCount: number };
  result?: DigestResult;
  violations: string[];
  proposals: number;
  error?: string;
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
  let proposals = 0;
  writeDecision({
    pass: "digest",
    targetKind: "stream",
    targetId: bundle.streamId,
    action: "digest_summary",
    new: {
      summary: result.summary,
      part: bundle.part,
      partCount: bundle.partCount,
      violations,
    },
    reason: `digest.v1 month-chunk summary (propose-only, spec §8.5)`,
  });
  proposals += 1;
  for (const claim of result.claims) {
    writeDecision({
      pass: "digest",
      targetKind: "claim",
      targetId: `${bundle.streamId}#digest`,
      action: "propose",
      new: claim,
      reason: "digest.v1 claim about known person (evidence-quoted, propose-only)",
    });
    proposals += 1;
  }
  for (const rec of result.recurrences) {
    writeDecision({
      pass: "digest",
      targetKind: "task",
      targetId: `${bundle.streamId}#recurrence`,
      action: "propose_recurrence",
      new: rec,
      reason: "digest.v1 recurrence candidate (propose-only, spec §5.3)",
    });
    proposals += 1;
  }
  return { proposals };
}

/**
 * Run ONE Digest call over one Cat-2 backfill bundle. Traced, Haiku by
 * default, propose-only. A failed run reports and leaves the bundle
 * un-marked, so the orphan scan re-queues it.
 */
export async function runDigestPass(
  bundle: DeltaBundle,
  deps: DigestPassDeps = {},
): Promise<DigestPassReport> {
  const base: DigestPassReport = {
    status: "failed",
    bundle: { streamId: bundle.streamId, part: bundle.part, partCount: bundle.partCount },
    violations: [],
    proposals: 0,
  };
  const provider = deps.provider ?? getProvider(DEFAULT_PROVIDER_ID);
  if (!provider) return { ...base, error: "no provider registered" };

  const user = packDigestUser({
    streamKey: bundle.streamKey,
    events: bundle.events,
    predecessorSummary: bundle.predecessorSummary,
  });

  return withTraceContext(
    { pass: "digest", caller: "scheduler/digest-pass", promptVersion: DIGEST_V1_ID },
    async (): Promise<DigestPassReport> => {
      let text = "";
      const runId = randomUUID();
      const model = deps.model ?? DIGEST_DEFAULT_MODEL;
      const systemFile = systemPromptPath(DIGEST_V1_ID, DIGEST_V1_SYSTEM);
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
        logDigestRun(runId, model, startedAt, res, user.length + DIGEST_V1_SYSTEM.length, provider.id);
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
      // S0.9 / T8-1: the digest call was the one pass with no ledger row — its
      // spend rendered nowhere and TRC-03 could never see it alive.
      logDigestRun(runId, model, startedAt, res, user.length + DIGEST_V1_SYSTEM.length, provider.id);
      if (res.status !== "ok") {
        return { ...base, error: res.errorCode ?? "provider error" };
      }
      const { result, violations } = parseDigestV1(text);
      if (!result) return { ...base, violations, error: "unparseable digest output" };
      annotateTrace({ parsedResult: result });
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
        kind: DIGEST_V1_ID,
        pass: DIGEST_V1_ID,
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
        kind: DIGEST_V1_ID,
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
