// ===========================================================================
// [CODE] The prompt runner — shared plumbing for all 12 prompts.
// arch §4.4.3 (stable prefix), §4.6 (error handling), §5.8 (failure handling),
// §5.9 (round trip). Build item 1.9.
//
// One path, used by every LLM call in the pipeline:
//
//     legend + instructions -> system file (the stable, cacheable prefix)
//     packed input          -> stdin
//     call  ->  parse  ->  violations  ->  ONE repair round  ->  merge
//                                       \-> quarantine on a second failure
//
// Four commitments:
//
//  1. EVERY CALL WRITES A `runs` ROW. Round one, the repair round, and every
//     transport retry. A call that does not appear in `runs` is spend nobody
//     can attribute, and §4.4.4 exists because that has already happened once.
//     The write is in a `finally`, so it survives a throw.
//
//  2. ZERO MODEL OUTPUT IS DISCARDED. `responses[]` holds every answer verbatim
//     in order; violations quote the rejected lines byte-for-byte; skipped
//     lines keep their original text. The repair loop RE-ASKS. It does not
//     rewrite, trim, censor or filter anything the model said — not even the
//     part that was wrong.
//
//  3. THE REPAIR ROUND IS BOUNDED AT ONE (§5.8.2). Accepted round-1 lines are
//     kept and merged. A second failure quarantines the unit and keeps the
//     violations. Quarantine parks the work with its error, replayable — it
//     never deletes it.
//
//  4. A REFUSAL IS AN OUTAGE, NOT THE UNIT'S FAULT (§4.6.1). It pauses the lane
//     and does NOT spend the unit's retry budget. Every other failure walks the
//     2 s / 10 s / 30 s ladder and is then quarantined so the rest keep moving.
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
import type { Provider, ProviderErrorCode, Usage } from "../providers/types.js";
import { parseWire } from "../wire/index.js";
import type { WireRecord } from "../wire/codec.js";
import type { WireSkip, WireViolation } from "../wire/tolerance.js";
import { legendFor, type LegendSpec } from "./legend.js";
import {
  annotateTrace,
  bindTraceContext,
  withTraceContext,
} from "../traces/context.js";
import {
  buildRepairAsk,
  mergeRepairRound,
  singleRound,
  violationSummary,
  type RepairCoverage,
  type RepairOutcome,
} from "./repair.js";

// ---------------------------------------------------------------------------
// The stable prefix (§4.4.3.2 / §5.9.4)
// ---------------------------------------------------------------------------

const promptFiles = new Map<string, string>();

/**
 * The instruction half goes to a file because the adapter passes it via
 * `--append-system-prompt` on fresh sessions. Keyed by content hash, so the
 * same call type maps to the same path forever and a changed legend cannot
 * quietly reuse the previous file.
 */
export function systemPromptPath(callType: string, text: string): string {
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
  const safe = callType.replace(/[^A-Za-z0-9._-]/g, "_");
  const path = join(tmpdir(), `supertwin-${safe}-${hash}.txt`);
  if (promptFiles.get(path) !== hash) {
    writeFileSync(path, text, "utf8");
    promptFiles.set(path, hash);
  }
  return path;
}

/** Test hook — forces the next call to rewrite its prompt file. */
export function resetPromptFilesForTests(): void {
  promptFiles.clear();
}

/** legend + the prompt's own instructions, in that order, always. */
export function buildSystemPrompt(spec: PromptCallSpec): string {
  const legend = typeof spec.legend === "string" ? spec.legend : legendFor(spec.legend);
  const own = spec.instructions.trim();
  return own === "" ? legend : `${legend}\n\n${own}`;
}

// ---------------------------------------------------------------------------
// Spec and result
// ---------------------------------------------------------------------------

export interface PromptCallSpec {
  /** Prompt id — `P-CL1`. Names the legend, the prompt file and the log line. */
  callType: string;
  /** The legend spec (rendered + memoised here) or a prebuilt block. */
  legend: LegendSpec | string;
  /** The prompt's own SYSTEM half, appended after the legend. */
  instructions: string;
  /** The packed, variable half — goes on stdin, never in the cached prefix. */
  user: string;
  /** Accounting attribution. `role` is mandatory: `runs` rejects a NULL one. */
  role: RunRole;
  /**
   * The import cohort this call belongs to, or an explicit `null` for a call
   * that belongs to none.
   *
   * NULL is a real answer, not a missing one. `runs.cohort_id` is a FOREIGN KEY
   * onto `cohorts`, so a made-up id ("steady", "-") does not park the call
   * outside the import — it throws `FOREIGN KEY constraint failed` inside the
   * accounting write and loses the very row that was supposed to account for
   * the money. Steady-state P-EP2 and the boot tier backfill are exactly that
   * case. `recordRun` documents what NULL means downstream.
   */
  cohortId: string | null;
  model: string;
  /** The unit this call is for; quarantine needs it, so it is required to park. */
  unit?: { kind: string; id: string };
  /** Which half of the LLM pool (§4.4.1.1). Default: understanding. */
  lane?: LlmLane;
  timeoutMs?: number;
  cwd?: string;
}

export type PromptRunStatus = "ok" | "repaired" | "quarantined" | "failed";
export type QuarantineReason = "violations" | "transport" | "cancelled";

export interface PromptRunResult {
  callType: string;
  status: PromptRunStatus;
  records: WireRecord[];
  /** What is still wrong after the bounded round — never silently dropped. */
  violations: WireViolation[];
  skipped: WireSkip[];
  rounds: number;
  coverage: RepairCoverage;
  /** Every model response, verbatim, in call order. Discarded output: ZERO. */
  responses: string[];
  runIds: string[];
  usage: Usage;
  error?: { code: string; message: string };
  quarantineReason?: QuarantineReason;
  quarantineId?: string;
}

export interface QuarantineRow {
  id: string;
  unitKind: string;
  unitId: string;
  /** `quarantine.cohort_id` is the same FK as `runs.cohort_id` — see the spec. */
  cohortId: string | null;
  runId: string | null;
  errorCode: string;
  lastError: string;
  attempts: number;
}

export interface RunnerDeps {
  provider?: Provider;
  providerId?: string;
  pool?: ResourcePool;
  /**
   * The accounting write, WHOLE. Supplying it replaces both halves — the `runs`
   * row and its `extraction_runs` mirror — so a unit test with no database
   * still observes every call exactly once, and nothing reaches SQLite behind
   * its back. Production supplies neither half.
   */
  recordRun?: (p: RecordRunParams) => string;
  /** The `extraction_runs` mirror on its own. See {@link recordRun} above. */
  logExtractionRun?: (p: LogRunParams) => void;
  quarantine?: (row: QuarantineRow) => void;
  newId?: () => string;
  now?: () => Date;
  signal?: AbortSignal;
  /**
   * How many lane pauses a single call will wait out before giving up. The
   * pause itself is served by the pool; this only stops one unit from waiting
   * on an outage forever.
   */
  maxPauses?: number;
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

/** Default sink: park the unit in `quarantine`. Parked, with its error, replayable. */
function defaultQuarantine(row: QuarantineRow): void {
  getDb()
    .prepare(
      `INSERT INTO quarantine (id, unit_kind, unit_id, cohort_id, run_id, error_code, last_error, attempts)
       VALUES (@id, @unitKind, @unitId, @cohortId, @runId, @errorCode, @lastError, @attempts)`,
    )
    .run(row);
}

// ---------------------------------------------------------------------------
// One transport call
// ---------------------------------------------------------------------------

interface CallOutcome {
  runId: string;
  ok: boolean;
  /** The model's answer, byte-for-byte as it arrived. */
  text: string;
  usage: Usage;
  errorCode?: ProviderErrorCode | string;
  errorMessage?: string;
  startedAt: string;
  endedAt: string;
  /** Dispatch → first streamed token, ms. null = no token ever arrived (4.2). */
  ttftMs: number | null;
  /** Who answered, and how big the ask was — the `extraction_runs` columns. */
  providerId: string;
  promptChars: number;
}

/** Run status for the `runs` row this call produces. */
type RunStatus = "ok" | "retried" | "quarantined" | "error";

/** The mirror's null object — see the constructor's note on `recordRun`. */
function noMirror(): void {
  /* the caller replaced the accounting write wholesale */
}

/** Wall-clock ms for one call, or 0 when the clock gave nothing usable. */
function durationOf(call: CallOutcome): number {
  const started = Date.parse(call.startedAt);
  const ended = Date.parse(call.endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : 0;
}

/** TTFT from a dispatch instant and the first-token instant; null = no token. */
function ttftFrom(startedMs: number, firstTokenAtMs: number | null): number | null {
  if (firstTokenAtMs === null || !Number.isFinite(startedMs)) return null;
  return Math.max(0, firstTokenAtMs - startedMs);
}

export class PromptRunner {
  private readonly deps: RunnerDeps;
  private readonly pool: ResourcePool;
  private readonly write: (p: RecordRunParams) => string;
  private readonly mirror: (p: LogRunParams) => void;
  private readonly park: (row: QuarantineRow) => void;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(deps: RunnerDeps = {}) {
    this.deps = deps;
    this.pool = deps.pool ?? resourcePool;
    this.write = deps.recordRun ?? recordRun;
    // `recordRun` stands in for the WHOLE accounting write: a test that swaps
    // it out has said it has no database, so the mirror must not go looking
    // for one either. Both halves are real, or neither is.
    this.mirror = deps.logExtractionRun ?? (deps.recordRun ? noMirror : logExtractionRun);
    this.park = deps.quarantine ?? defaultQuarantine;
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }

  private provider(): Provider | undefined {
    return this.deps.provider ?? getProvider(this.deps.providerId ?? DEFAULT_PROVIDER_ID);
  }

  /** One provider call. Never throws: a thrown transport error becomes an outcome. */
  private async callOnce(spec: PromptCallSpec, userText: string): Promise<CallOutcome> {
    const runId = this.newId();
    const startedAt = this.now().toISOString();
    const configuredId = this.deps.providerId ?? DEFAULT_PROVIDER_ID;
    const system = buildSystemPrompt(spec);
    const promptChars = system.length + userText.length;
    const provider = this.provider();
    if (!provider) {
      return {
        runId,
        ok: false,
        text: "",
        usage: { ...ZERO_USAGE },
        errorCode: "SPAWN_FAILED",
        errorMessage: `provider "${configuredId}" is not registered`,
        startedAt,
        endedAt: this.now().toISOString(),
        ttftMs: null,
        providerId: configuredId,
        promptChars,
      };
    }

    const systemFile = systemPromptPath(spec.callType, system);
    let text = "";
    let usage: Usage = { ...ZERO_USAGE };
    let failure = "";
    let failureCode: ProviderErrorCode | undefined;
    // TTFT (item 4.2, §9.5.3 rule 4): the instant the FIRST delta arrives,
    // measured with the same injectable clock as startedAt/endedAt. null until
    // a token streams — an errored call has no TTFT and must not fake one.
    const startedMs = Date.parse(startedAt);
    let firstTokenAtMs: number | null = null;

    const lane: LlmLane = spec.lane ?? "understanding";
    try {
      const result = await this.pool.run(
        "llm",
        // The pool may invoke this closure from a queue-drain path where
        // AsyncLocalStorage has lost the trace scope — re-bind it explicitly
        // so the provider's TRC-01 assertion always sees the context.
        bindTraceContext(() =>
          provider.send({
            runId,
            message: userText,
            systemPromptFile: systemFile,
            // Bounded, tool-free, single-turn, thinking off (§4.3): extraction
            // with a fixed output grammar gains nothing from reasoning tokens.
            plainCompletion: true,
            maxTurns: 1,
            thinkingBudget: "off",
            allowedTools: [],
            model: spec.model,
            cwd: spec.cwd,
            timeoutMs: spec.timeoutMs,
            signal: this.deps.signal,
            onEvent: (ev) => {
              // Concatenated verbatim. No trimming, no filtering, no cleanup.
              if (ev.type === "delta") {
                if (firstTokenAtMs === null) firstTokenAtMs = this.now().getTime();
                text += ev.text;
              }
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
        endedAt: this.now().toISOString(),
        ttftMs: ttftFrom(startedMs, firstTokenAtMs),
        providerId: provider.id,
        promptChars,
      };
    } catch (err) {
      return {
        runId,
        ok: false,
        // Whatever streamed before the throw is still the model's words.
        text,
        usage,
        errorCode: failureCode ?? "CLI_ERROR",
        errorMessage: err instanceof Error ? err.message : String(err),
        startedAt,
        endedAt: this.now().toISOString(),
        // Whatever streamed before the throw still has an honest TTFT.
        ttftMs: ttftFrom(startedMs, firstTokenAtMs),
        providerId: provider.id,
        promptChars,
      };
    }
  }

  /**
   * The accounting rows for one call — BOTH of them. Called for every call, ok
   * or not.
   *
   * THE DUAL-WRITE INVARIANT (the other half is db/index.ts `logRun`): one
   * provider call is one `runs` row and one `extraction_runs` row, joined on
   * the run id, and the table it is written to FIRST says where it came from.
   * The pipeline enters HERE, `runs` first, because this is the only path that
   * knows the call's role AND its cohort; `logExtractionRun` then adds the §11
   * log row and deliberately does NOT mirror back. db/index.ts `logRun` is the
   * opposite direction for chat and on-demand media, and the two must never
   * meet — either one reaching the other would double-count every call.
   *
   * The mirror is what puts derivation spend in Settings → Recent runs, which
   * reads `extraction_runs`: without it the whole pipeline rendered as $0
   * there while `runs` held the real money.
   */
  private logRun(spec: PromptCallSpec, call: CallOutcome, status: RunStatus): string {
    const id = this.write({
      id: call.runId,
      role: spec.role,
      model: spec.model,
      cohortId: spec.cohortId,
      kind: spec.callType,
      status,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      usage: call.usage,
      errorCode: call.errorCode ? String(call.errorCode) : null,
      errorMsg: call.errorMessage && call.errorMessage !== "" ? call.errorMessage : null,
      // Item 4.2: the runs write also persists this call's latency mark, so
      // TTFT and tokens/sec are recorded per model per call type (§9.5.3 r4).
      ttftMs: call.ttftMs,
    });
    this.mirror({
      provider: call.providerId,
      // No chat session is involved: this is background derivation, and
      // claiming a session id would put it in someone's conversation.
      sessionId: null,
      runId: call.runId,
      kind: spec.callType,
      promptChars: call.promptChars,
      inputTokens: call.usage.inputTokens,
      cacheCreationInputTokens: call.usage.cacheCreationInputTokens,
      cacheReadInputTokens: call.usage.cacheReadInputTokens,
      ...(call.usage.cacheCreation5mInputTokens === undefined
        ? {}
        : { cacheCreation5mInputTokens: call.usage.cacheCreation5mInputTokens }),
      ...(call.usage.cacheCreation1hInputTokens === undefined
        ? {}
        : { cacheCreation1hInputTokens: call.usage.cacheCreation1hInputTokens }),
      outputTokens: call.usage.outputTokens,
      // Verbatim or null — never a locally recomputed price.
      costUsd: call.usage.costUsd ?? null,
      durationMs: durationOf(call),
      // `extraction_runs.status` is the two-way one. The finer grade (retried,
      // quarantined) lives on the `runs` row this mirrors.
      status: call.ok ? "ok" : "error",
      errorCode: call.errorCode ? String(call.errorCode) : null,
      model: spec.model,
      role: spec.role,
    });
    return id;
  }

  /**
   * One call plus the §4.6 ladder around it. A refusal pauses the lane and does
   * NOT spend the retry budget; TIMEOUT and other CLI errors walk 2 s/10 s/30 s
   * and are then quarantined. Every attempt writes its own `runs` row.
   */
  private async dispatch(
    spec: PromptCallSpec,
    userText: string,
    sink: CallOutcome[],
    log: (call: CallOutcome, status: RunStatus) => void,
  ): Promise<CallOutcome> {
    const lane = `llm:${spec.lane ?? "understanding"}` as const;
    const maxPauses = this.deps.maxPauses ?? 3;
    let retriesSpent = 0;
    let pauses = 0;

    for (;;) {
      const call = await this.callOnce(spec, userText);
      sink.push(call);
      if (call.ok) {
        this.pool.noteSuccess(lane);
        // Left unlogged on purpose: only the caller knows whether this answer
        // was clean ("ok"), the round that triggered a repair ("retried"), or
        // the one whose violations survived it ("quarantined").
        return call;
      }
      const decision = this.pool.noteFailure(
        lane,
        { code: call.errorCode, message: call.errorMessage },
        retriesSpent,
      );
      if (decision.action === "pause" && pauses < maxPauses) {
        // The pool holds the pause; the next acquire waits it out. The unit's
        // retry budget is deliberately untouched (§4.6.1).
        pauses += 1;
        log(call, "retried");
        continue;
      }
      if (decision.action === "retry") {
        retriesSpent += 1;
        log(call, "retried");
        continue;
      }
      log(call, decision.action === "cancelled" ? "error" : "quarantined");
      return call;
    }
  }

  /** The repair turn: the original input, the model's own answer, then the ask. */
  private repairUser(spec: PromptCallSpec, previous: string, ask: string): string {
    return [
      spec.user,
      "",
      "YOUR PREVIOUS ANSWER:",
      // Echoed verbatim. The model is shown what it said, never a cleaned-up
      // version of what it said.
      previous,
      "",
      ask,
    ].join("\n");
  }

  private quarantine(
    spec: PromptCallSpec,
    runId: string | null,
    errorCode: string,
    lastError: string,
    attempts: number,
  ): string | undefined {
    if (!spec.unit) return undefined;
    const id = this.newId();
    this.park({
      id,
      unitKind: spec.unit.kind,
      unitId: spec.unit.id,
      cohortId: spec.cohortId,
      runId,
      errorCode,
      lastError,
      attempts,
    });
    return id;
  }

  /**
   * Pack -> call -> parse -> violations -> one repair round -> merge, with the
   * quarantine on the far side — inside a trace scope (build P0.7): every
   * provider invocation this run makes is captured, and the parse-side fields
   * (parsed result, repair count) are annotated onto the trace before it
   * flushes. prompt_version is the same content hash that names the system
   * prompt file, so a changed prompt is a changed version by construction.
   */
  async run(spec: PromptCallSpec): Promise<PromptRunResult> {
    const system = buildSystemPrompt(spec);
    const promptVersion = createHash("sha1").update(system).digest("hex").slice(0, 12);
    return withTraceContext(
      { pass: spec.callType, caller: "prompts/runner", promptVersion },
      async () => {
        const result = await this.execute(spec);
        annotateTrace({
          repairCount: Math.max(0, result.runIds.length - 1),
          parsedResult: {
            status: result.status,
            records: result.records,
            violations: result.violations,
            skipped: result.skipped,
          },
        });
        return result;
      },
    );
  }

  /** The untraced body of {@link run} — every call path stays identical. */
  private async execute(spec: PromptCallSpec): Promise<PromptRunResult> {
    const calls: CallOutcome[] = [];
    const logged = new Set<string>();
    const logOnce = (call: CallOutcome, status: RunStatus): void => {
      if (logged.has(call.runId)) return;
      logged.add(call.runId);
      this.logRun(spec, call, status);
    };

    try {
      const first = await this.dispatch(spec, spec.user, calls, logOnce);
      if (!first.ok) {
        const code = String(first.errorCode ?? "CLI_ERROR");
        const cancelled = code === "CANCELLED";
        return this.finish(spec, calls, {
          status: cancelled ? "failed" : "quarantined",
          outcome: emptyOutcome(),
          error: { code, message: first.errorMessage ?? "" },
          quarantineReason: cancelled ? "cancelled" : "transport",
          quarantineId: cancelled
            ? undefined
            : this.quarantine(
                spec,
                first.runId,
                code,
                first.errorMessage ?? "",
                calls.length,
              ),
        });
      }

      const parse1 = parseWire(first.text);
      const ask = buildRepairAsk(parse1);
      if (!ask.needed) {
        logOnce(first, "ok");
        return this.finish(spec, calls, { status: "ok", outcome: singleRound(parse1) });
      }

      // One repair round. Only the failing lines are re-asked (§5.8.2).
      logOnce(first, "retried");
      const second = await this.dispatch(
        spec,
        this.repairUser(spec, first.text, ask.message),
        calls,
        logOnce,
      );
      if (!second.ok) {
        const outcome = singleRound(parse1);
        const code = String(second.errorCode ?? "CLI_ERROR");
        return this.finish(spec, calls, {
          status: "quarantined",
          outcome,
          error: { code, message: second.errorMessage ?? "" },
          quarantineReason: "transport",
          quarantineId: this.quarantine(
            spec,
            second.runId,
            code,
            second.errorMessage ?? "",
            calls.length,
          ),
        });
      }

      const parse2 = parseWire(second.text);
      const merged = mergeRepairRound(parse1, parse2, ask);
      if (!merged.quarantine) {
        logOnce(second, "ok");
        return this.finish(spec, calls, { status: "repaired", outcome: merged });
      }
      logOnce(second, "quarantined");
      return this.finish(spec, calls, {
        status: "quarantined",
        outcome: merged,
        quarantineReason: "violations",
        quarantineId: this.quarantine(
          spec,
          second.runId,
          "wire_violations",
          violationSummary(merged.violations),
          merged.rounds,
        ),
      });
    } finally {
      // Every call writes a runs row — including one that threw its way out of
      // the method above. An unattributed call is spend nobody can account for.
      for (const call of calls) logOnce(call, call.ok ? "ok" : "error");
    }
  }

  private finish(
    spec: PromptCallSpec,
    calls: readonly CallOutcome[],
    parts: {
      status: PromptRunStatus;
      outcome: RepairOutcome;
      error?: { code: string; message: string };
      quarantineReason?: QuarantineReason;
      quarantineId?: string;
    },
  ): PromptRunResult {
    return {
      callType: spec.callType,
      status: parts.status,
      records: parts.outcome.records,
      violations: parts.outcome.violations,
      skipped: parts.outcome.skipped,
      rounds: parts.outcome.rounds,
      coverage: parts.outcome.coverage,
      responses: calls.map((c) => c.text),
      runIds: calls.map((c) => c.runId),
      usage: calls.reduce((acc, c) => addUsage(acc, c.usage), { ...ZERO_USAGE }),
      ...(parts.error ? { error: parts.error } : {}),
      ...(parts.quarantineReason ? { quarantineReason: parts.quarantineReason } : {}),
      ...(parts.quarantineId ? { quarantineId: parts.quarantineId } : {}),
    };
  }
}

function emptyOutcome(): RepairOutcome {
  return {
    records: [],
    violations: [],
    skipped: [],
    rounds: 1,
    coverage: { asked: 0, answered: 0, unanswered: 0, pairingCertain: true },
    quarantine: true,
  };
}

/** Convenience: one call through a runner built from `deps`. */
export function runPrompt(spec: PromptCallSpec, deps: RunnerDeps = {}): Promise<PromptRunResult> {
  return new PromptRunner(deps).run(spec);
}
