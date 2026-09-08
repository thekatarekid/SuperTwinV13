// ===========================================================================
// The V13 JSON pass runner (build P1.2/P1.3, spec §8 conventions).
//
// The five V13 passes speak strict JSON, not the V11 STW-2 wire format, so
// they cannot ride prompts/runner.ts — but they keep every one of its
// commitments, through the same substrate:
//
//   1. TRACED, ALWAYS. Each call runs inside withTraceContext, so the
//      claude-local provider's TRC-01 assertion sees a scope and every
//      invocation lands in the trace store. A call without a trace throws in
//      dev — there is no untraced path out of this module.
//   2. EVERY CALL WRITES A `runs` ROW (+ its `extraction_runs` mirror), via
//      the same recordRun/logExtractionRun pair the wire runner uses — and
//      METERS the call into the rolling quota window (`db.addUsage`, S0.7 /
//      T0-11, SPD-08): one `quota_usage` row per `extraction_runs` row, so a
//      background pass spends against the same window the chat turn does.
//   2b. THE POOL'S ERROR POLICY IS HONOURED (S0.7 / T0-10, SPD-07). Every
//      outcome is reported to `pool.noteSuccess` / `pool.noteFailure` and the
//      returned decision is followed: a refusal pauses the lane (the pool holds
//      the next acquire), an ordinary failure walks 2 s / 10 s / 30 s and is
//      then quarantined, and ten consecutive non-refusal failures trip the
//      lane's breaker — 30 minutes paused, banner up. A pool overflow
//      (BND-12) is returned to the caller as backpressure, never retried.
//   3. ONE REPAIR ROUND. An answer that does not parse as JSON matching the
//      pass's schema is re-asked once, shown its own previous answer verbatim;
//      a second failure quarantines the unit with the parse error.
//   4. BYTE-IDENTICAL SYSTEM PROMPT per pass (spec §8: "shared byte-identical
//      preamble per pass for prompt caching"). stableSystemPrompt() memoises
//      the block per pass id and THROWS if a second caller renders a different
//      one — the ported legend.ts invariant.
//
// Model default: every V13 step defaults to Haiku (spec §14.9, build
// convention 7); per-pass override via app_state `selected_model_<pass>`.
// ===========================================================================

import { createHash, randomUUID } from "node:crypto";

import { getDb } from "../db/connection.js";
import { stepOverride } from "../settings/overrides.js";
import { reasoningRequestForResolvedCall } from "./reasoning.js";
import {
  addUsage as meterQuotaUsage,
  logExtractionRun,
  writeRunLedger,
  type AddUsageParams,
  type LogRunParams,
} from "../db/index.js";
import {
  recordRun,
  type RecordRunParams,
  type RunOrigin,
  type RunRole,
} from "../db/run-accounting.js";
import {
  requireMaxOutputTokens,
  resolveModelCall,
  type ResolvedModelCall,
} from "../providers/selection.js";
import {
  isPoolOverflow,
  resourcePool,
  type LaneKey,
  type LlmLane,
  type ResourcePool,
} from "../providers/pool.js";
import type { ProviderV2, Usage } from "../providers/types.js";
import {
  annotateTrace,
  bindTraceContext,
  withTraceContext,
} from "../traces/context.js";

// ---------------------------------------------------------------------------
// Model selection — Haiku by default, per-pass override.
// ---------------------------------------------------------------------------

/** Build convention 7 / spec §14.9: every V13 step ships defaulted to Haiku. */
export const DEFAULT_PASS_MODEL = "haiku";

/**
 * Selected model for a V13 pass: app_state `selected_model_<pass>` when set,
 * else Haiku. (The per-pass pickers surface the spec §8 recommendations in
 * Settings; upgrading is eval-gated — never silently applied here.)
 */
export function modelForPass(pass: string): string {
  // A candidate under the golden gate (settings/overrides.ts, SET-02) wins
  // over app_state; unset in every production boot and every unit test.
  const override = stepOverride(pass)?.model;
  if (override) return override;
  try {
    const stmt = getDb().prepare(`SELECT value FROM app_state WHERE key = ?`);
    // Settings keys its steps on the pass STEM (`orient`); a runner spending
    // under a versioned id (`orient.v7`) still honours that choice.
    for (const key of [pass, pass.split(".")[0]!]) {
      const row = stmt.get(`selected_model_${key}`) as { value: string } | undefined;
      if (row && typeof row.value === "string" && row.value.trim() !== "") {
        return row.value.trim();
      }
    }
  } catch {
    // No DB in a pure unit test — the default answers.
  }
  return DEFAULT_PASS_MODEL;
}

// ---------------------------------------------------------------------------
// Stable system prompt (the ported legend.ts invariant)
// ---------------------------------------------------------------------------

const systemCache = new Map<string, string>();

/**
 * Memoise the system prompt per pass id and throw if a second caller would
 * render a DIFFERENT block for the same pass — a prefix that changes
 * byte-for-byte between calls is a silent cache miss plus a write premium.
 */
export function stableSystemPrompt(pass: string, text: string): string {
  const held = systemCache.get(pass);
  if (held === undefined) {
    systemCache.set(pass, text);
    return text;
  }
  if (held !== text) {
    throw new Error(
      `system prompt for pass "${pass}" is not stable: the block changed ` +
        `between calls, which silently defeats prompt caching (spec §8)`,
    );
  }
  return held;
}

/** Test hook — the cache is process-wide by design. */
export function resetStableSystemPromptsForTests(): void {
  systemCache.clear();
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Parse the model's answer as JSON: strict first, then a fenced ```json block,
 * then the outermost {...} / [...] span. Returns undefined when nothing parses
 * — the repair round's trigger, never an exception.
 */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const attempts: string[] = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) attempts.push(fence[1].trim());
  const firstBrace = t.search(/[[{]/);
  if (firstBrace >= 0) {
    const open = t[firstBrace];
    const close = open === "{" ? "}" : "]";
    const last = t.lastIndexOf(close);
    if (last > firstBrace) attempts.push(t.slice(firstBrace, last + 1));
  }
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* next */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Spec + result
// ---------------------------------------------------------------------------

export interface JsonPassSpec<T> {
  /** Pass id + prompt version, e.g. "orient.v1". Names the trace + prompt file. */
  pass: string;
  /** The byte-stable system prompt (validated via stableSystemPrompt). */
  system: string;
  /** The packed, variable half — stdin. */
  user: string;
  /** Accounting role (`runs.role` is a closed enum; see db/run-accounting). */
  role: RunRole;
  /** @deprecated Production selection comes from provider-namespaced settings. */
  model?: string;
  cohortId?: string | null;
  /** The unit this call is for — quarantine parks it on double failure. */
  unit?: { kind: string; id: string };
  lane?: LlmLane;
  /**
   * `runs.origin` (S0.9 / T8-1): which lane the work came from. A pass over a
   * bundle passes the bundle's lane; an interactive call (the bar) leaves it
   * unset and the ledger records "live".
   */
  origin?: RunOrigin | null;
  timeoutMs?: number;
  /**
   * Validate + narrow the parsed JSON. Throw (with a message the repair round
   * shows the model) to reject a shape that parsed but is wrong.
   */
  validate: (parsed: unknown) => T;
}

export type JsonPassStatus = "ok" | "repaired" | "quarantined" | "failed";

export interface JsonPassResult<T> {
  pass: string;
  status: JsonPassStatus;
  /** The validated output; undefined unless status is ok|repaired. */
  output?: T;
  /** Every model response, verbatim, in call order. Discarded output: ZERO. */
  responses: string[];
  runIds: string[];
  usage: Usage;
  error?: { code: string; message: string };
  quarantineId?: string;
}

export interface JsonPassDeps {
  /** Exact strict-provider test seam; production resolves from the V2 registry. */
  provider?: ProviderV2;
  pool?: ResourcePool;
  /** Replaces BOTH accounting halves — a test with no DB observes every call. */
  recordRun?: (p: RecordRunParams) => string;
  logExtractionRun?: (p: LogRunParams) => void;
  /** The quota meter (`db.addUsage`). Defaults off when `recordRun` is swapped. */
  addUsage?: (p: AddUsageParams) => void;
  /**
   * Lane pauses one call waits out before giving up (default 3, as the wire
   * runner). The pool serves the pause; this only bounds one unit's patience.
   */
  maxPauses?: number;
  /** Waits out a retry delay (2 s / 10 s / 30 s). Tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
  quarantine?: (row: {
    id: string;
    unitKind: string;
    unitId: string;
    cohortId: string | null;
    runId: string | null;
    errorCode: string;
    lastError: string;
    attempts: number;
  }) => void;
  newId?: () => string;
  now?: () => Date;
  signal?: AbortSignal;
}

function providerErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
};

// NOT unref'd: a retry wait is live work. An unref'd timer let a process with
// nothing else on its loop (the eval CLI, a one-shot script) exit 0 silently
// mid-ladder, before the retry, the ledger status and the trace flush (S0-gate).
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function sumUsage(a: Usage, b: Usage): Usage {
  const cost =
    a.costUsd === undefined && b.costUsd === undefined
      ? undefined
      : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

function defaultQuarantine(row: {
  id: string;
  unitKind: string;
  unitId: string;
  cohortId: string | null;
  runId: string | null;
  errorCode: string;
  lastError: string;
  attempts: number;
}): void {
  getDb()
    .prepare(
      `INSERT INTO quarantine (id, unit_kind, unit_id, cohort_id, run_id, error_code, last_error, attempts)
       VALUES (@id, @unitKind, @unitId, @cohortId, @runId, @errorCode, @lastError, @attempts)`,
    )
    .run(row);
}

interface CallOutcome {
  runId: string;
  ok: boolean;
  text: string;
  usage: Usage;
  errorCode?: string;
  errorMessage?: string;
  retryAfterMs?: number;
  startedAt: string;
  endedAt: string;
  providerId: string;
  promptChars: number;
  /** Permanent pre-send/provider hold: caller must retain, never quarantine. */
  hardStop?: boolean;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * One JSON pass call: trace scope -> provider (via the LLM pool) -> runs row
 * -> JSON parse + validate -> one repair round -> quarantine on the far side.
 */
export async function runJsonPass<T>(
  spec: JsonPassSpec<T>,
  deps: JsonPassDeps = {},
): Promise<JsonPassResult<T>> {
  const system = stableSystemPrompt(spec.pass, spec.system);
  const promptVersion = createHash("sha1").update(system).digest("hex").slice(0, 12);
  const resolved = resolveModelCall(
    { source: "step", key: spec.pass },
    {
      ...(deps.provider ? { provider: deps.provider } : {}),
    },
  );
  // Bind the required request limit to the same immutable catalogue snapshot
  // before entering the pool. Unknown bounds are a capability failure, never
  // a spawned call, retry, or generic CLI error.
  const maxOutputTokens = requireMaxOutputTokens(resolved);
  return withTraceContext(
    { pass: spec.pass, caller: "brain/llm", promptVersion },
    async () => {
      const result = await execute(spec, system, resolved, maxOutputTokens, deps);
      annotateTrace({
        repairCount: Math.max(0, result.runIds.length - 1),
        parsedResult: {
          status: result.status,
          output: result.output ?? null,
          ...(result.error ? { error: result.error } : {}),
        },
      });
      return result;
    },
  );
}

async function callOnce<T>(
  spec: JsonPassSpec<T>,
  instructions: string,
  resolved: ResolvedModelCall,
  maxOutputTokens: number,
  userText: string,
  deps: JsonPassDeps,
): Promise<CallOutcome> {
  const newId = deps.newId ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const runId = newId();
  const startedAt = now().toISOString();
  const { provider } = resolved;
  const promptChars = instructions.length + userText.length;
  const pool = deps.pool ?? resourcePool;
  let text = "";
  let usage: Usage = { ...ZERO_USAGE };
  let failure = "";
  let failureCode: string | undefined;
  const lane: LlmLane = spec.lane ?? "understanding";
  try {
    const result = await pool.run(
      "llm",
      bindTraceContext(() =>
        provider.send({
          runId,
          model: resolved.model,
          instructions,
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: userText }],
          }],
          toolChoice: "none",
          plainCompletion: true,
          skipHostSettings: true,
          persistContinuation: false,
          maxOutputTokens,
          // Claude's plain-completion transport uses two CLI turns (one answer
          // plus one preamble allowance); ChatGPT performs one response.
          maxAgentTurns: resolved.providerId === "claude-local" ? 2 : 1,
          ...reasoningRequestForResolvedCall(resolved),
          timeoutMs: spec.timeoutMs,
          signal: deps.signal,
          onEvent: (ev) => {
            if (ev.type === "delta") text += ev.text;
            else if (ev.type === "usage") usage = ev.usage;
            else if (ev.type === "done") usage = ev.usage;
            else if (ev.type === "error") {
              failure = ev.message;
              failureCode = ev.code;
            }
          },
        }),
      ),
      {
        lane,
        providerId: resolved.providerId,
        signal: deps.signal,
      },
    );
    return {
      runId,
      ok: result.status === "ok",
      text,
      usage: result.usage ?? usage,
      errorCode: result.errorCode ?? failureCode,
      errorMessage: failure,
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
      startedAt,
      endedAt: now().toISOString(),
      providerId: resolved.providerId,
      promptChars,
    };
  } catch (err) {
    return {
      runId,
      ok: false,
      text,
      usage,
      // A full pool is backpressure, not a model failure: it carries its own
      // code so dispatch() can hand it back without touching the breaker.
      errorCode: isPoolOverflow(err)
        ? "POOL_OVERFLOW"
        : (failureCode ?? providerErrorCode(err) ?? "CLI_ERROR"),
      errorMessage: err instanceof Error ? err.message : String(err),
      startedAt,
      endedAt: now().toISOString(),
      providerId: resolved.providerId,
      promptChars,
    };
  }
}

/**
 * One call plus the pool's §4.6 ladder around it (T0-10, mirroring
 * prompts/runner.ts `dispatch`). Every outcome is reported to the pool; the
 * decision it returns is followed:
 *
 *   pause      — a refusal: the pool holds the lane; wait it out and re-call,
 *                up to `maxPauses` times. The unit's retry budget is untouched.
 *   retry      — an ordinary failure: sleep the ladder's delay and re-call.
 *   quarantine — the ladder is spent: hand the failure back.
 *   cancelled  — hand it back untouched.
 *   breaker    — this failure was the lane's tenth in a row (SPD-07): the lane
 *                is paused 30 min and the banner is up. The unit is handed back
 *                NOW, whatever rung of the ladder it was on — sitting on the
 *                pause and re-calling afterwards is the `silent-retry` shape.
 *
 * Every attempt that is followed by another one writes its own `runs` row as
 * "retried" here; the final attempt is logged by the caller, who alone knows
 * whether it was clean, repaired or quarantined. A POOL_OVERFLOW (BND-12) is
 * returned at once: nothing ran, the lane is not at fault, and the right
 * response is upstream backpressure — never a retry from inside the call.
 */
async function dispatch<T>(
  spec: JsonPassSpec<T>,
  instructions: string,
  resolved: ResolvedModelCall,
  maxOutputTokens: number,
  userText: string,
  deps: JsonPassDeps,
  sink: CallOutcome[],
): Promise<CallOutcome> {
  const pool = deps.pool ?? resourcePool;
  const lane: LaneKey = `llm:${spec.lane ?? "understanding"}`;
  const maxPauses = deps.maxPauses ?? 3;
  const sleep = deps.sleep ?? defaultSleep;
  let retriesSpent = 0;
  let pauses = 0;
  for (;;) {
    const call = await callOnce(
      spec,
      instructions,
      resolved,
      maxOutputTokens,
      userText,
      deps,
    );
    sink.push(call);
    if (call.ok) {
      pool.noteSuccess(
        lane,
        resolved.providerId,
        Math.max(0, Date.parse(call.endedAt) - Date.parse(call.startedAt)) || 0,
      );
      return call;
    }
    if (call.errorCode === "POOL_OVERFLOW") return call;
    const decision = pool.noteFailure(
      lane,
      {
        code: call.errorCode,
        message: call.errorMessage,
        retryAfterMs: call.retryAfterMs,
      },
      retriesSpent,
      resolved.providerId,
    );
    // FIX-C2. A turn-cap stop is handed straight back, unlogged: the model's
    // own bytes are in `call.text`, the caller salvages or runs its ONE repair
    // round (which asks narrowly, "JSON only, no preamble"), and the same
    // full-context call is never re-issued from in here.
    // FIX-C1. A hard stop (budget latch / kill switch) is handed straight back
    // too: nothing was spawned, nothing is owed, and no wait clears it. Never
    // retried and never paused — the lane's entry gate keeps the work.
    if (decision.hardStop) {
      call.hardStop = true;
      return call;
    }
    if (decision.softStop) return call;
    if (decision.breakerTripped) return call;
    if (decision.action === "pause" && pauses < maxPauses) {
      pauses += 1;
      logRun(spec, resolved, call, "retried", deps);
      continue;
    }
    if (decision.action === "retry") {
      retriesSpent += 1;
      logRun(spec, resolved, call, "retried", deps);
      await sleep(decision.waitMs);
      continue;
    }
    return call;
  }
}

function logRun<T>(
  spec: JsonPassSpec<T>,
  resolved: ResolvedModelCall,
  call: CallOutcome,
  status: "ok" | "retried" | "quarantined" | "error",
  deps: JsonPassDeps,
): void {
  // The quota meter rides beside the mirror (T0-11, SPD-08): a call that
  // wrote an `extraction_runs` row wrote a `quota_usage` row, unconditionally
  // — the spend of a timed-out or cancelled call is real, and mostly cache.
  const meter =
    deps.addUsage ?? (deps.recordRun ? () => {} : meterQuotaUsage);
  const model = resolved.model;
  const run: RecordRunParams = {
    id: call.runId,
    role: spec.role,
    model,
    cohortId: spec.cohortId ?? null,
    kind: spec.pass,
    // S0.9 / T8-1: attribution at insert — the pass is the trace's pass, the
    // origin is the bundle's lane when the caller knows it.
    pass: spec.pass,
    origin: spec.origin ?? null,
    status,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    usage: call.usage,
    errorCode: call.errorCode ? String(call.errorCode) : null,
    errorMsg: call.errorMessage && call.errorMessage !== "" ? call.errorMessage : null,
    ttftMs: null,
  };
  const log: LogRunParams = {
    provider: call.providerId,
    sessionId: null,
    runId: call.runId,
    kind: spec.pass,
    promptChars: call.promptChars,
    inputTokens: call.usage.inputTokens,
    cacheCreationInputTokens: call.usage.cacheCreationInputTokens,
    cacheReadInputTokens: call.usage.cacheReadInputTokens,
    outputTokens: call.usage.outputTokens,
    costUsd: call.usage.costUsd ?? null,
    durationMs: Math.max(0, Date.parse(call.endedAt) - Date.parse(call.startedAt)) || 0,
    status: call.ok ? "ok" : "error",
    errorCode: call.errorCode ? String(call.errorCode) : null,
    model,
    role: spec.role,
  };
  if (deps.recordRun || deps.logExtractionRun) {
    // A test swapped a half out: honour the swap, and no database is touched
    // behind it (a swapped `recordRun` silences the mirror, as before).
    const write = deps.recordRun ?? recordRun;
    const mirror =
      deps.logExtractionRun ?? (deps.recordRun ? () => {} : logExtractionRun);
    write(run);
    mirror(log);
  } else {
    // S0.9 / T8-2: `runs`, `extraction_runs` and the trace index row in ONE
    // transaction — a run can no longer exist without its trace.
    writeRunLedger({ run, log });
  }
  meter({
    inputTokens: call.usage.inputTokens,
    cacheCreationInputTokens: call.usage.cacheCreationInputTokens,
    cacheReadInputTokens: call.usage.cacheReadInputTokens,
    outputTokens: call.usage.outputTokens,
    runCount: 1,
  });
}

function parkUnit<T>(
  spec: JsonPassSpec<T>,
  deps: JsonPassDeps,
  runId: string | null,
  errorCode: string,
  lastError: string,
  attempts: number,
): string | undefined {
  if (!spec.unit) return undefined;
  const newId = deps.newId ?? randomUUID;
  const id = newId();
  (deps.quarantine ?? defaultQuarantine)({
    id,
    unitKind: spec.unit.kind,
    unitId: spec.unit.id,
    cohortId: spec.cohortId ?? null,
    runId,
    errorCode,
    lastError,
    attempts,
  });
  return id;
}

/** Parse + validate one answer. Returns the output or the failure message. */
function tryParse<T>(
  spec: JsonPassSpec<T>,
  text: string,
): { output?: T; problem?: string } {
  const parsed = extractJson(text);
  if (parsed === undefined) return { problem: "the answer is not valid JSON" };
  try {
    return { output: spec.validate(parsed) };
  } catch (err) {
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}

async function execute<T>(
  spec: JsonPassSpec<T>,
  instructions: string,
  resolved: ResolvedModelCall,
  maxOutputTokens: number,
  deps: JsonPassDeps,
): Promise<JsonPassResult<T>> {
  const calls: CallOutcome[] = [];
  const finish = (
    status: JsonPassStatus,
    parts: {
      output?: T;
      error?: { code: string; message: string };
      quarantineId?: string;
    } = {},
  ): JsonPassResult<T> => ({
    pass: spec.pass,
    status,
    ...(parts.output !== undefined ? { output: parts.output } : {}),
    responses: calls.map((c) => c.text),
    runIds: calls.map((c) => c.runId),
    usage: calls.reduce((acc, c) => sumUsage(acc, c.usage), { ...ZERO_USAGE }),
    ...(parts.error ? { error: parts.error } : {}),
    ...(parts.quarantineId ? { quarantineId: parts.quarantineId } : {}),
  });

  const first = await dispatch(
    spec,
    instructions,
    resolved,
    maxOutputTokens,
    spec.user,
    deps,
    calls,
  );
  // FIX-C2: MAX_TURNS is a soft stop, not a transport failure — fall through
  // to the parse. A preamble ("I'll process this bundle of 92 events…") burned
  // the turn but broke nothing, and the repair round below re-asks for the
  // JSON alone instead of paying for the whole pack a second time.
  const firstSoftStop = !first.ok && String(first.errorCode) === "MAX_TURNS";
  if (firstSoftStop) {
    console.warn(
      `[turn-cap] ${spec.pass} hit the CLI turn cap with ${first.text.length} chars in hand ` +
        `— salvaging or re-asking narrowly, never re-issuing the pack`,
    );
  }
  if (!first.ok && !firstSoftStop) {
    const code = String(first.errorCode ?? "CLI_ERROR");
    if (code === "POOL_OVERFLOW") {
      return finish("failed", { error: { code, message: first.errorMessage ?? "" } });
    }
    // A cancel and a full pool are both "not now", not the unit's fault:
    // logged as an error, handed back unquarantined.
    const handBack = first.hardStop || code === "CANCELLED";
    logRun(spec, resolved, first, handBack ? "error" : "quarantined", deps);
    if (handBack) {
      return finish("failed", { error: { code, message: first.errorMessage ?? "" } });
    }
    return finish("quarantined", {
      error: { code, message: first.errorMessage ?? "" },
      quarantineId: parkUnit(spec, deps, first.runId, code, first.errorMessage ?? "", 1),
    });
  }

  const round1 = tryParse(spec, first.text);
  if (round1.output !== undefined) {
    logRun(spec, resolved, first, "ok", deps);
    return finish("ok", { output: round1.output });
  }

  // One repair round (spec §8: one repair round → quarantine). The model is
  // shown its OWN previous answer verbatim — never a cleaned-up version.
  logRun(spec, resolved, first, "retried", deps);
  const repairUser = [
    spec.user,
    "",
    "YOUR PREVIOUS ANSWER:",
    first.text,
    "",
    firstSoftStop
      ? // Name the real cause (FIX-C2): the answer was a preamble that spent
        // the turn budget, so the ask is "skip the preamble", not "try again".
        "Your previous answer stopped at the turn limit before the JSON arrived."
      : `Your previous answer could not be used: ${round1.problem}.`,
    "Answer again with ONLY the JSON object required by the schema — no prose,",
    "no code fences, no commentary. Do not announce what you are about to do.",
  ].join("\n");
  const second = await dispatch(
    spec,
    instructions,
    resolved,
    maxOutputTokens,
    repairUser,
    deps,
    calls,
  );
  // A turn cap on the repair round leaves bytes too: try them before parking.
  const secondSoftStop = !second.ok && String(second.errorCode) === "MAX_TURNS";
  if (!second.ok && !(secondSoftStop && second.text.trim().length > 0)) {
    const code = String(second.errorCode ?? "CLI_ERROR");
    if (code === "POOL_OVERFLOW") {
      return finish("failed", { error: { code, message: second.errorMessage ?? "" } });
    }
    const handBack = second.hardStop || code === "CANCELLED";
    logRun(spec, resolved, second, handBack ? "error" : "quarantined", deps);
    if (handBack) {
      return finish("failed", { error: { code, message: second.errorMessage ?? "" } });
    }
    return finish("quarantined", {
      error: { code, message: second.errorMessage ?? "" },
      quarantineId: parkUnit(spec, deps, second.runId, code, second.errorMessage ?? "", 2),
    });
  }
  const round2 = tryParse(spec, second.text);
  if (round2.output !== undefined) {
    logRun(spec, resolved, second, "ok", deps);
    return finish("repaired", { output: round2.output });
  }
  logRun(spec, resolved, second, "quarantined", deps);
  return finish("quarantined", {
    error: { code: "json_invalid", message: round2.problem ?? "unparseable" },
    quarantineId: parkUnit(
      spec,
      deps,
      second.runId,
      "json_invalid",
      round2.problem ?? "unparseable",
      2,
    ),
  });
}
