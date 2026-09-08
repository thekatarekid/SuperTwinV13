// ===========================================================================
// SQLite data-access module (see docs/PHASE0_ARCHITECTURE.md §6, §11).
//
// Public API is FROZEN — server/adapter import exactly these names. Schema,
// migrations, and connection handling live in ./schema.ts and ./connection.ts.
// Everything here uses prepared, parameterized statements (no string-built SQL)
// and returns typed rows.
//
// Notes:
//   - `extraction_runs` is the non-negotiable log: logRun() inserts one row per
//     provider run (this is how "every Claude call is logged").
//   - Quota is a rolling window computed from the `quota_usage` table: addUsage()
//     appends a row, getQuota(windowMs) sums rows whose window_start is within
//     the window. Usage outside the window is excluded.
// ===========================================================================

import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { ProviderId, Usage } from "../providers/types.js";
import { billableTokens } from "../providers/usage.js";
import { getDb, runMigrations } from "./connection.js";
import {
  DEFAULT_MODEL_LABEL,
  isRunRole,
  recordRun,
  type RecordRunParams,
  type RunOrigin,
} from "./run-accounting.js";
import { currentTraceMeta, pendingTraceRecords } from "../traces/context.js";
import {
  indexedTraceIdFor,
  usageToTokens4Way,
  writeTraceIndexRow,
  type TraceRecord,
} from "../traces/store.js";

export { getDb, runMigrations };

// ---- Config ---------------------------------------------------------------

/** Default rolling quota window: 5 hours (matches the adapter's usage window). */
export const DEFAULT_QUOTA_WINDOW_MS = 18_000_000; // 5h

/**
 * Default `nearLimit` threshold on BILLABLE tokens within the window.
 * Deliberately high so it never blocks tests/evals; the adapter owns the real
 * quota gate. Override via SUPERTWIN_QUOTA_NEAR_LIMIT_TOKENS.
 */
export const DEFAULT_QUOTA_NEAR_LIMIT_TOKENS = 50_000_000;

function nearLimitThreshold(): number {
  const raw = process.env.SUPERTWIN_QUOTA_NEAR_LIMIT_TOKENS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_QUOTA_NEAR_LIMIT_TOKENS;
}

// ---- Shared row/param shapes ---------------------------------------------

export type ChatRole = "user" | "assistant" | "system";
export type SessionStatus = "active" | "poisoned";
export type RunKind = "chat" | "extraction" | (string & {});
export type RunStatus = "ok" | "error";

export interface ChatSession {
  conversationId: string;
  provider: string;
  cwd: string;
  promptBundleHash: string;
  title: string | null;
  status: SessionStatus;
  /** Phase 2: true when the session runs with brain access (grounded chat). */
  grounded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  conversationId: string;
  role: ChatRole;
  content: string;
  runId: string | null;
  usageJson: string | null;
  /** Phase 2: JSON array of citations parsed off the assistant reply, or null. */
  citationsJson: string | null;
  ts: string;
}

/** @deprecated Internal-key shape retained for the one-release server cutover. */
export interface LegacyChatSession {
  sessionId: string;
  provider: string;
  cwd: string;
  promptBundleHash: string;
  title: string | null;
  status: SessionStatus;
  grounded: boolean;
  createdAt: string;
  updatedAt: string;
}

/** @deprecated Internal-key shape retained for the one-release server cutover. */
export interface LegacyChatMessage {
  id: number;
  sessionId: string;
  role: ChatRole;
  content: string;
  runId: string | null;
  usageJson: string | null;
  citationsJson: string | null;
  ts: string;
}

export interface QuotaSnapshot {
  windowMs: number;
  windowStart: string;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  /** Weighted equivalent the gate compares against (cache bills differently). */
  billableTokens: number;
  /**
   * What chat spent over the window in USD, or null when no run in it reported
   * a cost (v4 §1). It is summed off extraction_runs — quota_usage counts
   * tokens and has never carried cost — so the UI can show a window figure
   * instead of pointing at Recent runs.
   */
  costUsd: number | null;
  runCount: number;
  nearLimit: boolean;
}

export interface LogRunParams {
  provider: string;
  sessionId: string | null;
  runId: string;
  kind: RunKind;
  promptChars: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number;
  status: RunStatus;
  errorCode: string | null;
  /**
   * The cache halves of the run's input (v3 §1). `inputTokens` is only the
   * uncached delta, so a run logged without these is recorded as costing
   * ~0.03% of what it did. Optional: a caller with no cache figures records 0.
   */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /**
   * The cache-write half split by TTL, when the provider reported it. A
   * 1-hour write bills at 2.0x a fresh input token against a 5-minute write's
   * 1.25x. Optional: a caller that omits them leaves the whole write
   * unattributed, which `billableTokens` prices at the 1-hour rate — the rate
   * this build's CLI actually charges (providers/usage.ts).
   */
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  /**
   * Phase 3/4: selected model id ("" = subscription default) and the process
   * role (chat|extraction|triage|done_detection|planning|execution). Both
   * optional/back-compatible — existing callers omit them and store NULL.
   */
  model?: string | null;
  role?: string | null;
  /**
   * S0.9 / T8-1: the `runs.pass` / `runs.origin` attribution for the mirror.
   * Optional — the mirror falls back to the active trace scope's pass, then
   * `kind`, and to origin "live" — so the mirrored row is never NULL there.
   */
  pass?: string | null;
  origin?: RunOrigin | null;
}

/** @deprecated Use CreateChatSessionParams with createChatSession(). */
export interface CreateSessionParams {
  sessionId: string;
  provider: string;
  cwd: string;
  promptBundleHash: string;
  title?: string | null;
  /** Phase 2: mark the session as grounded (brain access). Default false. */
  grounded?: boolean;
}

/** @deprecated Use AppendChatUserMessageParams or CommitAssistantTurnParams. */
export interface AppendMessageParams {
  sessionId: string;
  role: ChatRole;
  content: string;
  runId?: string | null;
  usageJson?: string | null;
  /** Phase 2: JSON array of citations for an assistant message, or null. */
  citationsJson?: string | null;
}

export interface ChatUserMessageInput {
  content: string;
  runId?: string | null;
}

export interface CreateChatSessionParams {
  /** Optional deterministic test/import seam; production normally omits it. */
  conversationId?: string;
  provider: ProviderId;
  model: string;
  cwd: string;
  /** SHA-256 of the exact prompt bundle bound to provider continuation. */
  promptBundleHash: string;
  title?: string | null;
  grounded?: boolean;
  userMessage: ChatUserMessageInput;
}

export interface AppendChatUserMessageParams extends ChatUserMessageInput {
  conversationId: string;
}

export interface ChatAssistantMessageInput {
  content: string;
  runId?: string | null;
  usageJson?: string | null;
  citationsJson?: string | null;
}

/**
 * Provider-dispatch state. This is an internal service boundary: never return
 * it from an HTTP route or merge it into the public ChatSession shape.
 */
export interface ChatContinuationState {
  conversationId: string;
  provider: ProviderId | null;
  model: string | null;
  promptBundleHash: string | null;
  continuation: string | null;
  generation: number;
}

export interface ContinuationCas {
  conversationId: string;
  expectedGeneration: number;
}

export interface RebindChatContinuationParams extends ContinuationCas {
  provider: ProviderId;
  model: string;
  promptBundleHash: string;
}

export type ReserveChatTurnParams = RebindChatContinuationParams;

export interface CommitAssistantTurnParams extends RebindChatContinuationParams {
  continuation: string | null;
  assistantMessage: ChatAssistantMessageInput;
}

export interface AddUsageParams {
  inputTokens: number;
  outputTokens: number;
  /** Cache write/read halves of the input (v3 §1). Absent reads as 0. */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  runCount?: number;
}

// ---- Internal DB row shapes (snake_case, as stored) ----------------------

/** Private storage record. Neither key nor continuation enters ChatSession. */
interface ChatSessionRecord {
  session_id: string;
  conversation_id: string;
  provider: string;
  cwd: string;
  prompt_bundle_hash: string;
  title: string | null;
  status: SessionStatus;
  grounded: number;
  created_at: string;
  updated_at: string;
  provider_continuation: string | null;
  continuation_provider: ProviderId | null;
  continuation_model: string | null;
  continuation_prompt_bundle_hash: string | null;
  continuation_generation: number;
}

interface MessageRow {
  id: number;
  session_id: string;
  conversation_id?: string;
  role: ChatRole;
  content: string;
  run_id: string | null;
  usage_json: string | null;
  citations_json: string | null;
  ts: string;
}

interface QuotaAggRow {
  input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  output_tokens: number | null;
  billable_tokens: number | null;
  run_count: number | null;
}

function toSession(r: ChatSessionRecord): ChatSession {
  return {
    conversationId: r.conversation_id,
    provider: r.continuation_provider ?? r.provider,
    cwd: r.cwd,
    promptBundleHash: r.continuation_prompt_bundle_hash ?? r.prompt_bundle_hash,
    title: r.title,
    status: r.status,
    grounded: r.grounded === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toLegacySession(r: ChatSessionRecord): LegacyChatSession {
  return {
    sessionId: r.session_id,
    provider: r.provider,
    cwd: r.cwd,
    promptBundleHash: r.prompt_bundle_hash,
    title: r.title,
    status: r.status,
    grounded: r.grounded === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id!,
    role: r.role,
    content: r.content,
    runId: r.run_id,
    usageJson: r.usage_json,
    citationsJson: r.citations_json,
    ts: r.ts,
  };
}

function toLegacyMessage(r: MessageRow): LegacyChatMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    runId: r.run_id,
    usageJson: r.usage_json,
    citationsJson: r.citations_json,
    ts: r.ts,
  };
}

// ---------------------------------------------------------------------------
// Prepared-statement cache. Statements are prepared lazily against the current
// handle and cached; if the handle changes (tests swap SUPERTWIN_DB_PATH) the
// cache is rebuilt against the new database.
// ---------------------------------------------------------------------------

interface Statements {
  db: Database.Database;
  insertRun: Database.Statement;
  insertChatSession: Database.Statement;
  insertChatUserMessage: Database.Statement;
  getChatSession: Database.Statement;
  listChatSessions: Database.Statement;
  getChatMessages: Database.Statement;
  getChatContinuation: Database.Statement;
  reserveChatTurn: Database.Statement;
  clearChatContinuation: Database.Statement;
  rebindChatContinuation: Database.Statement;
  commitChatContinuation: Database.Statement;
  insertSession: Database.Statement;
  poisonSession: Database.Statement;
  touchSession: Database.Statement;
  getSession: Database.Statement;
  listSessions: Database.Statement;
  insertMessage: Database.Statement;
  getMessages: Database.Statement;
  insertUsage: Database.Statement;
  sumUsage: Database.Statement;
  sumCost: Database.Statement;
}

let stmts: Statements | null = null;

function statements(): Statements {
  const db = getDb();
  if (stmts && stmts.db === db) return stmts;

  stmts = {
    db,
    insertRun: db.prepare(`
      INSERT INTO extraction_runs
        (provider, session_id, run_id, kind, prompt_chars,
         input_tokens, cache_creation_input_tokens,
         cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
         cache_read_input_tokens,
         output_tokens, cost_usd, duration_ms, status, error_code,
         model, role)
      VALUES
        (@provider, @sessionId, @runId, @kind, @promptChars,
         @inputTokens, @cacheCreationInputTokens,
         @cacheCreation5mInputTokens, @cacheCreation1hInputTokens,
         @cacheReadInputTokens,
         @outputTokens, @costUsd, @durationMs, @status, @errorCode,
         @model, @role)
    `),
    insertChatSession: db.prepare(`
      INSERT INTO chat_sessions
        (session_id, conversation_id, provider, cwd, prompt_bundle_hash,
         title, grounded, continuation_provider, continuation_model,
         continuation_prompt_bundle_hash, continuation_generation)
      VALUES
        (@internalSessionKey, @conversationId, @provider, @cwd,
         @promptBundleHash, @title, @grounded, @provider, @model,
         @promptBundleHash, 1)
    `),
    insertChatUserMessage: db.prepare(`
      INSERT INTO chat_messages
        (session_id, role, content, run_id, usage_json, citations_json)
      SELECT session_id, 'user', @content, @runId, NULL, NULL
        FROM chat_sessions
       WHERE conversation_id = @conversationId
    `),
    getChatSession: db.prepare(`
      SELECT * FROM chat_sessions WHERE conversation_id = ?
    `),
    listChatSessions: db.prepare(`
      SELECT * FROM chat_sessions ORDER BY updated_at DESC, created_at DESC
    `),
    getChatMessages: db.prepare(`
      SELECT m.*, s.conversation_id
        FROM chat_messages m
        JOIN chat_sessions s ON s.session_id = m.session_id
       WHERE s.conversation_id = ?
       ORDER BY m.ts ASC, m.id ASC
    `),
    getChatContinuation: db.prepare(`
      SELECT * FROM chat_sessions WHERE conversation_id = ?
    `),
    reserveChatTurn: db.prepare(`
      UPDATE chat_sessions
         SET continuation_generation = continuation_generation + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE conversation_id = @conversationId
         AND continuation_generation = @expectedGeneration
         AND continuation_generation < 2147483647
         AND continuation_provider = @provider
         AND continuation_model = @model
         AND continuation_prompt_bundle_hash = @promptBundleHash
      RETURNING provider_continuation, continuation_generation
    `),
    clearChatContinuation: db.prepare(`
      UPDATE chat_sessions
         SET provider_continuation = NULL,
             continuation_generation = continuation_generation + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE conversation_id = @conversationId
         AND continuation_generation = @expectedGeneration
         AND continuation_generation < 2147483647
      RETURNING continuation_generation
    `),
    rebindChatContinuation: db.prepare(`
      UPDATE chat_sessions
         SET continuation_provider = @provider,
             continuation_model = @model,
             continuation_prompt_bundle_hash = @promptBundleHash,
             continuation_generation = continuation_generation + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE conversation_id = @conversationId
         AND continuation_generation = @expectedGeneration
         AND continuation_generation < 2147483647
         AND provider_continuation IS NULL
      RETURNING continuation_generation
    `),
    commitChatContinuation: db.prepare(`
      UPDATE chat_sessions
         SET provider_continuation = @continuation,
             continuation_generation = continuation_generation + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE conversation_id = @conversationId
         AND continuation_generation = @expectedGeneration
         AND continuation_generation < 2147483647
         AND continuation_provider = @provider
         AND continuation_model = @model
         AND continuation_prompt_bundle_hash = @promptBundleHash
      RETURNING session_id, continuation_generation
    `),
    insertSession: db.prepare(`
      INSERT INTO chat_sessions
        (session_id, provider, cwd, prompt_bundle_hash, title, grounded)
      VALUES
        (@sessionId, @provider, @cwd, @promptBundleHash, @title, @grounded)
      ON CONFLICT(session_id) DO UPDATE SET
        provider           = excluded.provider,
        cwd                = excluded.cwd,
        prompt_bundle_hash = excluded.prompt_bundle_hash,
        title              = COALESCE(excluded.title, chat_sessions.title),
        grounded           = excluded.grounded,
        updated_at         = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `),
    poisonSession: db.prepare(`
      UPDATE chat_sessions
         SET status = 'poisoned',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE session_id = ?
    `),
    touchSession: db.prepare(`
      UPDATE chat_sessions
         SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE session_id = ?
    `),
    getSession: db.prepare(`SELECT * FROM chat_sessions WHERE session_id = ?`),
    listSessions: db.prepare(
      `SELECT * FROM chat_sessions ORDER BY updated_at DESC, created_at DESC`,
    ),
    insertMessage: db.prepare(`
      INSERT INTO chat_messages
        (session_id, role, content, run_id, usage_json, citations_json)
      VALUES
        (@sessionId, @role, @content, @runId, @usageJson, @citationsJson)
    `),
    getMessages: db.prepare(
      `SELECT * FROM chat_messages WHERE session_id = ? ORDER BY ts ASC, id ASC`,
    ),
    insertUsage: db.prepare(`
      INSERT INTO quota_usage
        (input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
         output_tokens, billable_tokens, run_count)
      VALUES
        (@inputTokens, @cacheCreationInputTokens, @cacheReadInputTokens,
         @outputTokens, @billableTokens, @runCount)
    `),
    // Sum rows whose window_start is at or after the cutoff (window filtering).
    sumUsage: db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0)                AS input_tokens,
        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
        COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens,
        COALESCE(SUM(output_tokens), 0)               AS output_tokens,
        COALESCE(SUM(billable_tokens), 0)             AS billable_tokens,
        COALESCE(SUM(run_count), 0)                   AS run_count
      FROM quota_usage
      WHERE window_start >= ?
    `),
    // Cost lives only on the run row, so a per-window figure has to be summed
    // per process. SUM stays NULL when no run reported one, which is how a
    // window nobody priced is told apart from one that genuinely cost nothing.
    sumCost: db.prepare(`
      SELECT SUM(cost_usd) AS cost_usd
      FROM extraction_runs
      WHERE COALESCE(role, kind) = ? AND created_at >= ?
    `),
  };
  return stmts;
}

// ---- Data-access API ------------------------------------------------------

/**
 * Log a single provider run into `extraction_runs` (§11: every call logged) AND
 * mirror it into `runs`, the V2 accounting table (see {@link mirrorRun}).
 *
 * THE DUAL-WRITE INVARIANT, stated once, for both directions:
 *
 *   ONE provider call = ONE `extraction_runs` row + ONE `runs` row, joined on
 *   the run id, and WHICH TABLE IS WRITTEN FIRST is decided by where the call
 *   entered the system:
 *
 *     chat / on-demand media  ->  HERE. extraction_runs first (it is the §11
 *                                 log), then mirrored into `runs` with a NULL
 *                                 cohort and the id `er:<rowid>`.
 *     the derivation pipeline ->  prompts/runner.ts. `runs` first (it is the
 *                                 only path that knows the call's role AND its
 *                                 cohort), then mirrored into extraction_runs
 *                                 via {@link logExtractionRun}.
 *
 * The two directions must never meet. `logExtractionRun` deliberately does NOT
 * mirror, and the runner deliberately does NOT call `logRun` — either would
 * double-count every call in both tables.
 */
export function logRun(params: LogRunParams): void {
  // S0.9 / T8-2: the log row, its `runs` mirror and the trace index row land
  // in ONE transaction — a crash between them can no longer leave a run with
  // no trace (1,508 such rows in the 13.4 ledger).
  getDb().transaction(() => {
    mirrorRun(params, insertExtractionRun(params));
  })();
}

// ---- The run ledger (S0.9 / T8-1, T8-2) ------------------------------------

/** One provider call, both accounting halves, as the pipeline runners know it. */
export interface RunLedgerEntry {
  /** The `runs` row (role + cohort — only the runner knows these). */
  run: RecordRunParams;
  /** The `extraction_runs` §11 log row for the same call. */
  log: LogRunParams;
}

/**
 * The pipeline's side of the dual write, made atomic: `runs` row, its
 * `extraction_runs` mirror and the call's trace index row in ONE SQLite
 * transaction. prompts/runner.ts and brain/llm.ts call this instead of
 * `recordRun` + `logExtractionRun` back to back.
 *
 * The trace half is what closes T8-2. The trace scope (traces/context.ts)
 * flushes when the scope SETTLES — after this write — so a process that died
 * in between left a run without a trace. Now the scope's pending records for
 * this run id are indexed here, in the same transaction, under ids the flush
 * later reuses (INSERT OR REPLACE), so the flush completes the row rather than
 * adding a second one. `runs.trace_id` links to it.
 *
 * Returns the `runs` id.
 */
export function writeRunLedger(entry: RunLedgerEntry): string {
  const db = getDb();
  return db.transaction(() => {
    const id = recordRun(attributed(db, entry.run));
    insertExtractionRun(entry.log);
    return id;
  })();
}

/**
 * Resolve the attribution columns for a `runs` write and index its trace, in
 * the caller's open transaction:
 *
 *   pass    — explicit, else the active trace scope's pass, else `kind`, else
 *             `role` (recordRun's own fallback).
 *   origin  — explicit, else "live" (recordRun's default).
 *   trace   — the scope's pending invocation(s) for this run id are written as
 *             index rows now; when the scope already flushed (chat and media
 *             log after their scope closes) the indexed row is linked instead;
 *             a run with no invocation at all (spawn refused, provider missing)
 *             gets a synthesized index row so `runs` and `traces` keep the
 *             same cardinality — a call that cost a row in one costs a row in
 *             the other.
 */
function attributed(db: Database.Database, run: RecordRunParams): RecordRunParams {
  const meta = currentTraceMeta();
  const runId = run.id ?? null;
  const pass = (run.pass ?? meta?.pass ?? run.kind ?? "").trim() || run.role;
  let traceId = run.traceId ?? null;
  if (runId !== null && traceId === null) {
    const pending = pendingTraceRecords(runId);
    if (pending.length > 0) {
      for (const rec of pending) writeTraceIndexRow(db, rec);
      traceId = pending[pending.length - 1]!.trace_id;
    } else {
      traceId = indexedTraceIdFor(db, runId);
      if (traceId === null) {
        const rec = synthesizedTrace(runId, pass, meta?.caller ?? "ledger", run);
        writeTraceIndexRow(db, rec);
        traceId = rec.trace_id;
      }
    }
  }
  return { ...run, pass, origin: run.origin ?? undefined, traceId };
}

/**
 * The index row for a run the provider never recorded an invocation for. It
 * carries what the ledger knows — tokens, cost, status, latency — and nothing
 * it does not: no prompt, no output.
 */
function synthesizedTrace(
  runId: string,
  pass: string,
  caller: string,
  run: RecordRunParams,
): TraceRecord {
  const startedAt = run.startedAt ?? new Date().toISOString();
  const started = Date.parse(startedAt);
  const ended = run.endedAt ? Date.parse(run.endedAt) : NaN;
  const latency =
    Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : 0;
  return {
    trace_id: `ledger:${runId}`,
    ts: startedAt,
    run_id: runId,
    attempt: 1,
    pass,
    caller,
    model: run.model?.trim() || null,
    prompt_version: currentTraceMeta()?.promptVersion ?? null,
    system_prompt: null,
    packed_context: "",
    raw_output: "",
    parsed_result: null,
    repair_count: 0,
    verdicts: null,
    tokens_4way: usageToTokens4Way(run.usage),
    cost_usd: run.usage.costUsd ?? null,
    latency_ms: latency,
    status: run.status ?? "ok",
  };
}

/**
 * The `extraction_runs` half ALONE — no `runs` mirror.
 *
 * This is the pipeline's side of the invariant above: prompts/runner.ts has
 * already written the `runs` row (with the role and cohort only it knows), and
 * needs the §11 log row so Settings → Recent runs, which reads
 * `extraction_runs`, stops rendering the entire derivation pipeline as $0.
 *
 * Returns the log's rowid, the same way `logRun` gets it.
 */
export function logExtractionRun(params: LogRunParams): number | bigint {
  return insertExtractionRun(params);
}

function insertExtractionRun(params: LogRunParams): number | bigint {
  const info = statements().insertRun.run({
    provider: params.provider,
    sessionId: params.sessionId,
    runId: params.runId,
    kind: params.kind,
    promptChars: params.promptChars,
    inputTokens: params.inputTokens,
    cacheCreationInputTokens: params.cacheCreationInputTokens ?? 0,
    cacheCreation5mInputTokens: params.cacheCreation5mInputTokens ?? 0,
    cacheCreation1hInputTokens: params.cacheCreation1hInputTokens ?? 0,
    cacheReadInputTokens: params.cacheReadInputTokens ?? 0,
    outputTokens: params.outputTokens,
    costUsd: params.costUsd,
    durationMs: params.durationMs,
    status: params.status,
    errorCode: params.errorCode,
    model: params.model ?? null,
    role: params.role ?? null,
  });
  return info.lastInsertRowid;
}

/**
 * Dual-write the run into `runs` — the V2 accounting table that Settings →
 * Usage, its cache hit rate, cohort pacing, estimateImportSpend and (via the
 * latency mark recordRun writes beside it) the Latency panel all read.
 *
 * It goes HERE, in the one function chat and media runs pass through, rather
 * than at the call sites: `runs` previously had a single writer,
 * prompts/runner.ts, so an installed build whose real spend is chat plus
 * background media reading rendered an empty Usage board over money that had
 * genuinely been spent. The pipeline's calls come the OTHER way round — see the
 * invariant on {@link logRun} — and reach extraction_runs via
 * {@link logExtractionRun}, which is why this must never be reached from there.
 *
 * Two decisions this write has to make, pinned here so they are made once:
 *
 *   * COHORT — NULL. Chat and on-demand media reading belong to no import
 *     cohort. A sentinel cohort row would be worse in both directions: the
 *     scheduler's `pendingCohorts` takes every cohort that is not done, and
 *     estimateImportSpend divides done cohorts' spend by their event counts.
 *     NULL keeps these runs out of both while leaving them in the unfiltered
 *     totals, which is where the money is. See RecordRunParams.cohortId.
 *
 *   * ID — `er:<extraction_runs rowid>`. `runs.id` is a primary key, but a
 *     provider run id is NOT unique: a retried media row reuses
 *     `media-<event id>`, and a second attempt would collide and throw inside
 *     chat's streaming path. The log's rowid is unique by construction and
 *     names the exact row this mirrors.
 */
function mirrorRun(p: LogRunParams, extractionRunRowId: number | bigint): void {
  const role = p.role ?? p.kind;
  // A run whose role is outside RUN_ROLES is deliberately NOT mirrored. `runs`
  // exists so a block labelled "Chat" really is chat; guessing a role would
  // undo exactly that. Every production caller passes one of them.
  if (!isRunRole(role)) return;

  const usage: Usage = {
    inputTokens: p.inputTokens,
    cacheCreationInputTokens: p.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: p.cacheReadInputTokens ?? 0,
    outputTokens: p.outputTokens,
  };
  // Absent stays absent: an unattributed write bills at the 1-hour rate, and
  // writing 0/0 would claim the wire said the writes were neither TTL.
  if (p.cacheCreation5mInputTokens !== undefined) {
    usage.cacheCreation5mInputTokens = p.cacheCreation5mInputTokens;
  }
  if (p.cacheCreation1hInputTokens !== undefined) {
    usage.cacheCreation1hInputTokens = p.cacheCreation1hInputTokens;
  }
  // Cost stays absent when the run reported none, so recordRun records 0 spend
  // rather than a locally recomputed price.
  if (p.costUsd !== null) usage.costUsd = p.costUsd;

  // extraction_runs stamps only completion, so the start is walked back by the
  // measured duration — that is what gives the latency mark a real total_ms.
  const endedMs = Date.now();
  const startedMs = endedMs - Math.max(0, p.durationMs);

  // The mirror's run id is the log's rowid, but the TRACE was recorded under
  // the provider run id — so the trace lookup runs on `p.runId` and the
  // resolved attribution is carried onto the mirrored row.
  const linked = attributed(statements().db, {
    id: p.runId,
    role,
    model: p.model?.trim() || DEFAULT_MODEL_LABEL,
    cohortId: null,
    kind: p.kind,
    pass: p.pass ?? undefined,
    origin: p.origin ?? undefined,
    status: p.status,
    startedAt: new Date(startedMs).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    usage,
  });
  recordRun({
    id: `er:${String(extractionRunRowId)}`,
    role,
    model: p.model?.trim() || DEFAULT_MODEL_LABEL,
    cohortId: null,
    kind: p.kind,
    pass: linked.pass,
    origin: linked.origin,
    traceId: linked.traceId,
    status: p.status,
    startedAt: new Date(startedMs).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    usage,
    errorCode: p.errorCode,
    // These callers never measure a first-token time. NULL says so; a 0 would
    // claim the call was instantaneous, and `ttftCoverage` counts the gap.
    ttftMs: null,
  });
}

/** Create the public conversation and its first user message atomically. */
export function createChatSession(params: CreateChatSessionParams): ChatSession {
  const s = statements();
  const conversationId = params.conversationId ?? randomUUID();
  let internalSessionKey = randomUUID();
  while (internalSessionKey === conversationId) internalSessionKey = randomUUID();
  const create = s.db.transaction(() => {
    s.insertChatSession.run({
      internalSessionKey,
      conversationId,
      provider: params.provider,
      model: params.model,
      cwd: params.cwd,
      promptBundleHash: params.promptBundleHash,
      title: params.title ?? null,
      grounded: params.grounded ? 1 : 0,
    });
    const message = s.insertMessage.run({
      sessionId: internalSessionKey,
      role: "user",
      content: params.userMessage.content,
      runId: params.userMessage.runId ?? null,
      usageJson: null,
      citationsJson: null,
    });
    if (message.changes !== 1) throw new Error("chat user message was not created");
  });
  create();
  const session = getChatSession(conversationId);
  if (!session) throw new Error("chat session was not created");
  return session;
}

/** Fetch one public chat session by conversation id. */
export function getChatSession(conversationId: string): ChatSession | null {
  const row = statements().getChatSession.get(conversationId) as ChatSessionRecord | undefined;
  return row ? toSession(row) : null;
}

/** List public chat sessions without internal keys or opaque continuations. */
export function listChatSessions(): ChatSession[] {
  const rows = statements().listChatSessions.all() as ChatSessionRecord[];
  return rows.map(toSession);
}

/**
 * Append a subsequent user message by public id. A dispatch path must call
 * reserveChatTurn first so a losing cross-process caller leaves no orphan
 * message; fresh createChatSession already owns its first message atomically.
 */
export function appendChatUserMessage(params: AppendChatUserMessageParams): void {
  const result = statements().insertChatUserMessage.run({
    conversationId: params.conversationId,
    content: params.content,
    runId: params.runId ?? null,
  });
  if (result.changes !== 1) throw new Error("chat conversation not found");
}

/** Fetch public messages by conversation id, oldest first. */
export function getChatMessages(conversationId: string): ChatMessage[] {
  const rows = statements().getChatMessages.all(conversationId) as MessageRow[];
  return rows.map(toMessage);
}

/** @internal Provider dispatch only. Never serialize this state. */
export function getChatContinuation(conversationId: string): ChatContinuationState | null {
  const row = statements().getChatContinuation.get(conversationId) as ChatSessionRecord | undefined;
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    provider: row.continuation_provider,
    model: row.continuation_model,
    promptBundleHash: row.continuation_prompt_bundle_hash,
    continuation: row.provider_continuation,
    generation: row.continuation_generation,
  };
}

/**
 * Reserve one provider send before inference. Two processes holding the same
 * generation cannot both win; the loser receives null and must not dispatch.
 */
export function reserveChatTurn(params: ReserveChatTurnParams): ChatContinuationState | null {
  const row = statements().reserveChatTurn.get(params) as
    | { provider_continuation: string | null; continuation_generation: number }
    | undefined;
  if (!row) return null;
  return {
    conversationId: params.conversationId,
    provider: params.provider,
    model: params.model,
    promptBundleHash: params.promptBundleHash,
    continuation: row.provider_continuation,
    generation: row.continuation_generation,
  };
}

/** Invalidate the opaque token if the caller still owns the generation. */
export function clearChatContinuation(params: ContinuationCas): number | null {
  const row = statements().clearChatContinuation.get(params) as
    | { continuation_generation: number }
    | undefined;
  return row?.continuation_generation ?? null;
}

/** Rebind provider/model/prompt only after the token has been cleared. */
export function rebindChatContinuation(params: RebindChatContinuationParams): number | null {
  const row = statements().rebindChatContinuation.get(params) as
    | { continuation_generation: number }
    | undefined;
  return row?.continuation_generation ?? null;
}

/**
 * Commit a successful assistant message and its successor continuation as one
 * generation-CAS transaction. A stale generation writes neither half.
 */
export function commitAssistantTurn(params: CommitAssistantTurnParams): number | null {
  const s = statements();
  const commit = s.db.transaction((): number | null => {
    const updated = s.commitChatContinuation.get({
      conversationId: params.conversationId,
      expectedGeneration: params.expectedGeneration,
      provider: params.provider,
      model: params.model,
      promptBundleHash: params.promptBundleHash,
      continuation: params.continuation,
    }) as { session_id: string; continuation_generation: number } | undefined;
    if (!updated) return null;
    const message = s.insertMessage.run({
      sessionId: updated.session_id,
      role: "assistant",
      content: params.assistantMessage.content,
      runId: params.assistantMessage.runId ?? null,
      usageJson: params.assistantMessage.usageJson ?? null,
      citationsJson: params.assistantMessage.citationsJson ?? null,
    });
    if (message.changes !== 1) throw new Error("chat assistant message was not created");
    return updated.continuation_generation;
  });
  return commit();
}

/** @deprecated Internal provider-key API; use createChatSession(). */
export function createSession(params: CreateSessionParams): void {
  statements().insertSession.run({
    sessionId: params.sessionId,
    provider: params.provider,
    cwd: params.cwd,
    promptBundleHash: params.promptBundleHash,
    title: params.title ?? null,
    grounded: params.grounded ? 1 : 0,
  });
}

/** @deprecated Internal provider-key API retained for the server cutover. */
export function markSessionPoisoned(sessionId: string): void {
  statements().poisonSession.run(sessionId);
}

/** @deprecated Internal provider-key API retained for the server cutover. */
export function updateSessionTimestamp(sessionId: string): void {
  statements().touchSession.run(sessionId);
}

/** @deprecated Internal provider-key API; use getChatSession(). */
export function getSession(sessionId: string): LegacyChatSession | null {
  const row = statements().getSession.get(sessionId) as ChatSessionRecord | undefined;
  return row ? toLegacySession(row) : null;
}

/** @deprecated Internal provider-key API; use listChatSessions(). */
export function listSessions(): LegacyChatSession[] {
  const rows = statements().listSessions.all() as ChatSessionRecord[];
  return rows.map(toLegacySession);
}

/** @deprecated Internal provider-key API; use appendChatUserMessage(). */
export function appendMessage(params: AppendMessageParams): void {
  statements().insertMessage.run({
    sessionId: params.sessionId,
    role: params.role,
    content: params.content,
    runId: params.runId ?? null,
    usageJson: params.usageJson ?? null,
    citationsJson: params.citationsJson ?? null,
  });
}

/** @deprecated Internal provider-key API; use getChatMessages(). */
export function getMessages(sessionId: string): LegacyChatMessage[] {
  const rows = statements().getMessages.all(sessionId) as MessageRow[];
  return rows.map(toLegacyMessage);
}

/**
 * Current rolling quota snapshot over the given window (ms; default 5h).
 * Sums quota_usage rows whose window_start is within the window; rows older than
 * the window are excluded. All four raw counts come back so the UI can show what
 * was actually spent, but `nearLimit` trips on the BILLABLE equivalent (v3 §1) —
 * a raw sum would trip roughly ten times sooner than real spend, because cache
 * reads are most of every run and bill at ~10%.
 */
export function getQuota(windowMs: number = DEFAULT_QUOTA_WINDOW_MS): QuotaSnapshot {
  const now = Date.now();
  // Millisecond-precision ISO ("...T..:..:..sssZ") matches how rows are stored
  // via strftime('%Y-%m-%dT%H:%M:%fZ'), so string comparison filters correctly.
  const windowStartIso = new Date(now - windowMs).toISOString();

  const agg = statements().sumUsage.get(windowStartIso) as QuotaAggRow;

  return {
    windowMs,
    windowStart: windowStartIso,
    inputTokens: agg.input_tokens ?? 0,
    cacheCreationInputTokens: agg.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: agg.cache_read_input_tokens ?? 0,
    outputTokens: agg.output_tokens ?? 0,
    billableTokens: agg.billable_tokens ?? 0,
    costUsd: costSince("chat", windowStartIso),
    runCount: agg.run_count ?? 0,
    nearLimit: (agg.billable_tokens ?? 0) >= nearLimitThreshold(),
  };
}

/**
 * Summed cost in USD for one process (`chat`, `media`, …) over the window, or
 * null when no run in it reported one. The counterpart to getQuota's token
 * counts for anything the quota window does not accumulate — media reading logs
 * runs but deliberately never touches quota_usage.
 */
export function getWindowCost(
  role: string,
  windowMs: number = DEFAULT_QUOTA_WINDOW_MS,
): number | null {
  return costSince(role, new Date(Date.now() - windowMs).toISOString());
}

function costSince(role: string, cutoffIso: string): number | null {
  const row = statements().sumCost.get(role, cutoffIso) as
    | { cost_usd: number | null }
    | undefined;
  return row?.cost_usd ?? null;
}

/**
 * Accumulate reported token usage into the rolling quota window. The billable
 * equivalent is stored alongside the raw counts rather than derived on read, so
 * the gate never has to re-weight rows written under a different weighting.
 */
export function addUsage(params: AddUsageParams): void {
  const usage = {
    inputTokens: params.inputTokens,
    cacheCreationInputTokens: params.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: params.cacheReadInputTokens ?? 0,
    outputTokens: params.outputTokens,
  };
  statements().insertUsage.run({
    ...usage,
    billableTokens: billableTokens(usage),
    runCount: params.runCount ?? 1,
  });
}
