// Shared admission/accounting gate for every physical provider attempt.
// Provider adapters retain wire/process ownership; this module owns the one
// ordering that must be identical across them:
// trace -> kill/budget preflight -> provider quota -> auth -> admission -> send.

import {
  assertTraceContext,
  recordProviderInvocation,
} from "../traces/context.js";
import {
  admitProviderCall,
  assertProviderQuotaAvailable,
  preflightProviderCall,
  recordCallCost,
} from "./budget.js";
import { noteRefusal, noteSpend, refusalCode } from "./spend-heartbeat.js";
import type {
  ProviderAuthState,
  ProviderErrorCode,
  ProviderId,
  ProviderStreamEvent,
  Usage,
} from "./types.js";
import { emptyUsage } from "./usage.js";

export type ProviderGateErrorCode = Extract<
  ProviderErrorCode,
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "PROVIDER_UNAVAILABLE"
  | "BACKEND_UNSUPPORTED"
>;

export class ProviderGateError extends Error {
  readonly code: ProviderGateErrorCode;

  constructor(code: ProviderGateErrorCode) {
    super(`${code}: provider attempt was refused before transport.`);
    this.name = "ProviderGateError";
    this.code = code;
  }
}

export function assertProviderAuthReady(state: ProviderAuthState): void {
  switch (state.status) {
    case "ready":
      return;
    case "signed_out":
      throw new ProviderGateError("AUTH_REQUIRED");
    case "expired":
      throw new ProviderGateError("AUTH_EXPIRED");
    case "unavailable":
      throw new ProviderGateError("PROVIDER_UNAVAILABLE");
    case "degraded":
      throw new ProviderGateError("BACKEND_UNSUPPORTED");
    default: {
      const neverState: never = state.status;
      throw new Error(`Unknown provider auth state: ${String(neverState)}`);
    }
  }
}

export interface GatedProviderAttemptResult {
  usage: Usage;
  failure?: { code: string };
  status?: "ok" | "error";
  errorCode?: ProviderErrorCode;
}

export interface GatedProviderAttemptOptions<
  T extends GatedProviderAttemptResult,
> {
  providerId: ProviderId;
  runId: string;
  attempt: number;
  model: string | null;
  systemPrompt: string | null;
  packedContext: string;
  onEvent: (event: ProviderStreamEvent) => void;
  /** Provider quota ceiling; throws a typed refusal when unavailable. */
  checkQuota?: () => void;
  /** Omit for providers such as local Claude that need no app-managed auth. */
  authState?: () => ProviderAuthState;
  execute: (onEvent: (event: ProviderStreamEvent) => void) => Promise<T>;
  now?: () => number;
}

/**
 * Run exactly one physical provider attempt through the shared gate.
 *
 * A poison-resume fallback calls this a second time, so it receives a second
 * admission, spend heartbeat entry and invocation trace. Pre-admission
 * refusals are counted as refusals and never as completed calls.
 */
export async function runGatedProviderAttempt<
  T extends GatedProviderAttemptResult,
>(opts: GatedProviderAttemptOptions<T>): Promise<T> {
  const now = opts.now ?? Date.now;
  const startedMs = now();
  const ts = new Date(startedMs).toISOString();
  let rawOutput = "";
  let streamedUsage: Usage | undefined;
  let admitted = false;
  let result: T | undefined;
  let thrown: unknown;

  assertTraceContext(`${opts.providerId} run ${opts.runId}`);

  try {
    // The first check establishes the mandated ordering without spending a
    // call. `admitCall` repeats it synchronously before committing the slot.
    preflightProviderCall(opts.providerId);
    assertProviderQuotaAvailable(opts.providerId);
    opts.checkQuota?.();
    if (opts.authState) assertProviderAuthReady(opts.authState());
    admitProviderCall(opts.providerId);
    admitted = true;

    result = await opts.execute((event) => {
      if (event.type === "delta") rawOutput += event.text;
      if (event.type === "usage") streamedUsage = event.usage;
      opts.onEvent(event);
    });
    return result;
  } catch (error) {
    thrown = error;
    if (!admitted) noteRefusal(error);
    throw error;
  } finally {
    if (admitted) {
      // A provider can emit terminal usage before its stream/parser rejects.
      // Preserve the last authoritative usage event on that throwing path;
      // a resolved result remains authoritative and must not be double-counted.
      const usage = result?.usage ?? streamedUsage ?? emptyUsage();
      const resultStatus =
        result?.failure?.code ??
        (result?.status === "error" ? (result.errorCode ?? "error") : undefined);
      recordCallCost(usage.costUsd);
      noteSpend(usage);
      recordProviderInvocation({
        runId: opts.runId,
        attempt: opts.attempt,
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        packedContext: opts.packedContext,
        rawOutput,
        usage,
        latencyMs: Math.max(0, now() - startedMs),
        status: resultStatus ?? (thrown ? refusalCode(thrown) : "ok"),
        ts,
      });
    }
  }
}
