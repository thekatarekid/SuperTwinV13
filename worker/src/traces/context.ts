// ===========================================================================
// Trace context (build P0.7): the mechanism that makes a ghost call impossible.
//
// The rule (spec §17, eval TRC-01): every model invocation carries a trace,
// zero anonymous calls. Enforced at the SINGLE spawn site — the claude-local
// provider — not at N call sites:
//
//   - a call site opens a scope with withTraceContext({pass, caller, ...}, fn)
//     (AsyncLocalStorage, so it survives awaits and nested calls);
//   - the provider records each CLI invocation into the active scope via
//     recordProviderInvocation();
//   - the scope flushes every invocation as a full TraceRecord when fn
//     settles, after the caller has had the chance to annotateTrace() the
//     parse-side fields (parsed_result, repair_count, verdicts).
//
// GHOST CALLS (no active scope):
//   - dev (NODE_ENV !== "production"): the provider's assertTraceContext()
//     THROWS GhostCallError before anything spawns — the TRC-01 assertion.
//   - production: never crash the product over instrumentation — the
//     invocation is written immediately with pass/caller "ghost", so even a
//     bypass still leaves a trace.
//   - SUPERTWIN_TRACE_ENFORCE=0 disables both (escape hatch for direct
//     provider tests that exercise the transport, not the pipeline).
//
// TEST HERMETICITY: under vitest (VITEST=true) the default flush sink is a
// no-op unless SUPERTWIN_TRACE_TEST_WRITES=1 — an unrelated suite that
// happens to open a trace scope must not write into the developer's real
// ~/SuperTwinV13. The trace store's own tests opt in (or pass a sink).
// ===========================================================================

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { Usage } from "../providers/types.js";
import {
  usageToTokens4Way,
  writeTrace,
  type TraceRecord,
} from "./store.js";

/** Thrown (dev only) when a model call is attempted with no trace context. */
export class GhostCallError extends Error {
  constructor(detail: string) {
    super(
      `TRC-01 ghost call: model invocation without a trace context (${detail}). ` +
        `Wrap the call site in withTraceContext({pass, caller}, ...).`,
    );
    this.name = "GhostCallError";
  }
}

/** What a call site declares when it opens a trace scope. */
export interface TraceMeta {
  /** Which pass/agent this is (P-CL1, chat, media, …). */
  pass: string;
  /** The code path making the call (prompts/runner, server/chat, …). */
  caller: string;
  /** Version/hash of the prompt this scope dispatches. */
  promptVersion?: string;
  /** Override the persistence sink (tests). Default: writeTrace. */
  sink?: (record: TraceRecord) => void;
}

/** Parse-side fields the caller learns after the provider returns. */
export interface TraceAnnotations {
  parsedResult?: unknown;
  repairCount?: number;
  verdicts?: unknown;
}

/** What the provider knows about one CLI invocation. */
export interface ProviderInvocation {
  runId: string;
  attempt: number;
  model: string | null;
  systemPrompt: string | null;
  packedContext: string;
  rawOutput: string;
  usage: Usage;
  latencyMs: number;
  status: string;
  ts: string;
  /**
   * The trace id this invocation will be persisted under. Minted when the
   * invocation is recorded (not at flush) so the run ledger can index the row
   * — and link `runs.trace_id` to it — before the scope closes, and the flush
   * later replaces that same row rather than adding a second one (S0.9).
   */
  traceId?: string;
}

class TraceScope {
  readonly meta: TraceMeta;
  readonly annotations: TraceAnnotations = {};
  readonly invocations: ProviderInvocation[] = [];
  constructor(meta: TraceMeta) {
    this.meta = meta;
  }
}

const als = new AsyncLocalStorage<TraceScope>();

function enforcementOn(): boolean {
  return process.env.SUPERTWIN_TRACE_ENFORCE !== "0";
}

function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

function defaultSink(): (record: TraceRecord) => void {
  // Hermetic under vitest unless a suite opts in — see the header.
  if (process.env.VITEST && process.env.SUPERTWIN_TRACE_TEST_WRITES !== "1") {
    return () => {};
  }
  return writeTrace;
}

function assemble(
  meta: TraceMeta,
  annotations: TraceAnnotations,
  inv: ProviderInvocation,
): TraceRecord {
  return {
    trace_id: inv.traceId ?? randomUUID(),
    ts: inv.ts,
    run_id: inv.runId,
    attempt: inv.attempt,
    pass: meta.pass,
    caller: meta.caller,
    model: inv.model,
    prompt_version: meta.promptVersion ?? null,
    system_prompt: inv.systemPrompt,
    packed_context: inv.packedContext,
    raw_output: inv.rawOutput,
    parsed_result: annotations.parsedResult ?? null,
    repair_count: annotations.repairCount ?? 0,
    verdicts: annotations.verdicts ?? null,
    tokens_4way: usageToTokens4Way(inv.usage),
    cost_usd: inv.usage.costUsd ?? null,
    latency_ms: inv.latencyMs,
    status: inv.status,
  };
}

function flush(scope: TraceScope): void {
  const sink = scope.meta.sink ?? defaultSink();
  for (const inv of scope.invocations) {
    try {
      sink(assemble(scope.meta, scope.annotations, inv));
    } catch (err) {
      // A trace failure must never fail the model call it describes.
      console.error("[traces] failed to persist trace:", err);
    }
  }
  scope.invocations.length = 0;
}

/**
 * Open a trace scope around one logical run (one pass dispatch, one chat turn,
 * one media read). Every provider invocation inside `fn` — awaits, repair
 * rounds, poison fallbacks included — is captured and flushed when `fn`
 * settles (also on throw: the money was spent either way).
 */
export async function withTraceContext<T>(
  meta: TraceMeta,
  fn: () => Promise<T> | T,
): Promise<T> {
  const scope = new TraceScope(meta);
  try {
    return await als.run(scope, fn);
  } finally {
    flush(scope);
  }
}

/** Is a trace scope active on this async path? */
export function hasTraceContext(): boolean {
  return als.getStore() !== undefined;
}

/**
 * The meta of the ACTIVE scope, or null outside one. Read-only view for the
 * gates that sit at the spawn site (providers/budget.ts needs pass/caller to
 * tell an interactive chat or bar call from background work).
 */
export function currentTraceMeta(): Readonly<Pick<TraceMeta, "pass" | "caller" | "promptVersion">> | null {
  const scope = als.getStore();
  if (!scope) return null;
  const { pass, caller, promptVersion } = scope.meta;
  return { pass, caller, promptVersion };
}

/**
 * The trace records the ACTIVE scope holds for `runId`, assembled with the
 * annotations known so far — empty outside a scope, or when the scope has no
 * invocation for that run yet. The run ledger (db/index.ts) writes these as
 * index rows in the same transaction as the `runs` row (S0.9 / T8-2); their
 * ids are stable, so the flush at scope end replaces rather than duplicates.
 */
export function pendingTraceRecords(runId: string): TraceRecord[] {
  const scope = als.getStore();
  if (!scope) return [];
  return scope.invocations
    .filter((inv) => inv.runId === runId)
    .map((inv) => assemble(scope.meta, scope.annotations, inv));
}

/**
 * Attach parse-side fields to every invocation of the ACTIVE scope. No-op
 * outside a scope (the ghost path already wrote what it had).
 */
export function annotateTrace(patch: TraceAnnotations): void {
  const scope = als.getStore();
  if (scope) Object.assign(scope.annotations, patch);
}

/**
 * Capture the active scope and return `fn` re-bound to it. Needed when a
 * closure will be INVOKED from a detached async path (a queue drain, a pool
 * slot release) where AsyncLocalStorage would otherwise have lost the scope.
 */
export function bindTraceContext<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const scope = als.getStore();
  if (!scope) return fn;
  return (...args: A) => als.run(scope, () => fn(...args));
}

/**
 * The TRC-01 assertion, called by the provider BEFORE it spawns anything.
 * Dev + enforcement on + no scope => throw. Production never throws here —
 * the ghost fallback in recordProviderInvocation still writes the trace.
 */
export function assertTraceContext(detail: string): void {
  if (als.getStore()) return;
  if (!enforcementOn()) return;
  if (isDev()) throw new GhostCallError(detail);
}

/**
 * Record one CLI invocation. Inside a scope: buffered and flushed with the
 * scope's annotations. Outside (production ghost): written immediately with
 * "ghost" attribution — a bypass still leaves a trace. With enforcement off
 * and no scope: dropped (transport-only tests).
 */
export function recordProviderInvocation(inv: ProviderInvocation): void {
  if (!inv.traceId) inv.traceId = randomUUID();
  const scope = als.getStore();
  if (scope) {
    scope.invocations.push(inv);
    return;
  }
  if (!enforcementOn()) return;
  try {
    defaultSink()(
      assemble({ pass: "ghost", caller: "ghost" }, {}, inv),
    );
  } catch (err) {
    console.error("[traces] failed to persist ghost trace:", err);
  }
}
