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
//      the same recordRun/logExtractionRun pair the wire runner uses.
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
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDb } from "../db/connection.js";
import { logExtractionRun, type LogRunParams } from "../db/index.js";
import { recordRun, type RecordRunParams, type RunRole } from "../db/run-accounting.js";
import { get as getProvider, DEFAULT_PROVIDER_ID } from "../providers/registry.js";
import { resourcePool, type LlmLane, type ResourcePool } from "../providers/pool.js";
import type { Provider, Usage } from "../providers/types.js";
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
  try {
    const row = getDb()
      .prepare(`SELECT value FROM app_state WHERE key = ?`)
      .get(`selected_model_${pass}`) as { value: string } | undefined;
    if (row && typeof row.value === "string" && row.value.trim() !== "") {
      return row.value.trim();
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

const promptFiles = new Map<string, string>();

/** The system half goes to a file (adapter passes --append-system-prompt). */
function systemPromptFileFor(pass: string, text: string): string {
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
  const safe = pass.replace(/[^A-Za-z0-9._-]/g, "_");
  const path = join(tmpdir(), `supertwinv13-${safe}-${hash}.txt`);
  if (promptFiles.get(path) !== hash) {
    writeFileSync(path, text, "utf8");
    promptFiles.set(path, hash);
  }
  return path;
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
  /** Model id; default = modelForPass(pass). */
  model?: string;
  cohortId?: string | null;
  /** The unit this call is for — quarantine parks it on double failure. */
  unit?: { kind: string; id: string };
  lane?: LlmLane;
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
  provider?: Provider;
  providerId?: string;
  pool?: ResourcePool;
  /** Replaces BOTH accounting halves — a test with no DB observes every call. */
  recordRun?: (p: RecordRunParams) => string;
  logExtractionRun?: (p: LogRunParams) => void;
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

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
};

function addUsage(a: Usage, b: Usage): Usage {
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
  startedAt: string;
  endedAt: string;
  providerId: string;
  promptChars: number;
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
  return withTraceContext(
    { pass: spec.pass, caller: "brain/llm", promptVersion },
    async () => {
      const result = await execute(spec, system, deps);
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
  system: string,
  userText: string,
  deps: JsonPassDeps,
): Promise<CallOutcome> {
  const newId = deps.newId ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const runId = newId();
  const startedAt = now().toISOString();
  const configuredId = deps.providerId ?? DEFAULT_PROVIDER_ID;
  const provider = deps.provider ?? getProvider(configuredId);
  const promptChars = system.length + userText.length;
  if (!provider) {
    return {
      runId,
      ok: false,
      text: "",
      usage: { ...ZERO_USAGE },
      errorCode: "SPAWN_FAILED",
      errorMessage: `provider "${configuredId}" is not registered`,
      startedAt,
      endedAt: now().toISOString(),
      providerId: configuredId,
      promptChars,
    };
  }
  const pool = deps.pool ?? resourcePool;
  const systemFile = systemPromptFileFor(spec.pass, system);
  const model = spec.model ?? modelForPass(spec.pass);
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
          message: userText,
          systemPromptFile: systemFile,
          plainCompletion: true,
          maxTurns: 1,
          thinkingBudget: "off",
          allowedTools: [],
          model,
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
      { lane },
    );
    return {
      runId,
      ok: result.status === "ok",
      text,
      usage: result.usage ?? usage,
      errorCode: result.errorCode ?? failureCode,
      errorMessage: failure,
      startedAt,
      endedAt: now().toISOString(),
      providerId: provider.id,
      promptChars,
    };
  } catch (err) {
    return {
      runId,
      ok: false,
      text,
      usage,
      errorCode: failureCode ?? "CLI_ERROR",
      errorMessage: err instanceof Error ? err.message : String(err),
      startedAt,
      endedAt: now().toISOString(),
      providerId: provider.id,
      promptChars,
    };
  }
}

function logRun<T>(
  spec: JsonPassSpec<T>,
  call: CallOutcome,
  status: "ok" | "retried" | "quarantined" | "error",
  deps: JsonPassDeps,
): void {
  const write = deps.recordRun ?? recordRun;
  const mirror =
    deps.logExtractionRun ?? (deps.recordRun ? () => {} : logExtractionRun);
  const model = spec.model ?? modelForPass(spec.pass);
  write({
    id: call.runId,
    role: spec.role,
    model,
    cohortId: spec.cohortId ?? null,
    kind: spec.pass,
    status,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    usage: call.usage,
    errorCode: call.errorCode ? String(call.errorCode) : null,
    errorMsg: call.errorMessage && call.errorMessage !== "" ? call.errorMessage : null,
    ttftMs: null,
  });
  mirror({
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
  system: string,
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
    usage: calls.reduce((acc, c) => addUsage(acc, c.usage), { ...ZERO_USAGE }),
    ...(parts.error ? { error: parts.error } : {}),
    ...(parts.quarantineId ? { quarantineId: parts.quarantineId } : {}),
  });

  const first = await callOnce(spec, system, spec.user, deps);
  calls.push(first);
  if (!first.ok) {
    const code = String(first.errorCode ?? "CLI_ERROR");
    logRun(spec, first, code === "CANCELLED" ? "error" : "quarantined", deps);
    if (code === "CANCELLED") {
      return finish("failed", { error: { code, message: first.errorMessage ?? "" } });
    }
    return finish("quarantined", {
      error: { code, message: first.errorMessage ?? "" },
      quarantineId: parkUnit(spec, deps, first.runId, code, first.errorMessage ?? "", 1),
    });
  }

  const round1 = tryParse(spec, first.text);
  if (round1.output !== undefined) {
    logRun(spec, first, "ok", deps);
    return finish("ok", { output: round1.output });
  }

  // One repair round (spec §8: one repair round → quarantine). The model is
  // shown its OWN previous answer verbatim — never a cleaned-up version.
  logRun(spec, first, "retried", deps);
  const repairUser = [
    spec.user,
    "",
    "YOUR PREVIOUS ANSWER:",
    first.text,
    "",
    `Your previous answer could not be used: ${round1.problem}.`,
    "Answer again with ONLY the JSON object required by the schema — no prose,",
    "no code fences, no commentary.",
  ].join("\n");
  const second = await callOnce(spec, system, repairUser, deps);
  calls.push(second);
  if (!second.ok) {
    const code = String(second.errorCode ?? "CLI_ERROR");
    logRun(spec, second, "quarantined", deps);
    return finish("quarantined", {
      error: { code, message: second.errorMessage ?? "" },
      quarantineId: parkUnit(spec, deps, second.runId, code, second.errorMessage ?? "", 2),
    });
  }
  const round2 = tryParse(spec, second.text);
  if (round2.output !== undefined) {
    logRun(spec, second, "ok", deps);
    return finish("repaired", { output: round2.output });
  }
  logRun(spec, second, "quarantined", deps);
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
