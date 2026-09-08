// ===========================================================================
// Trace store (build P0.7, spec §17). Every model (CLI) invocation writes one
// TraceRecord: the full prompt, the packed context, the raw output, the parse,
// tokens, cost, latency and attribution — inspectable later from any
// decision's "why?".
//
// Storage is two-layer, both written by writeTrace():
//   1. ~/SuperTwinV13/traces/YYYY-MM-DD.jsonl — the full record, one JSON line
//      per invocation, one file per day (append-only until retention).
//   2. `traces` index rows in supertwinv13.db — the cheap columns (ids, pass,
//      caller, tokens, cost, latency, day+file pointer) so the trace viewer
//      can filter without reading jsonl.
//
// SCHEMA COEXISTENCE: the build plan has LANE A creating the `traces` table in
// migration 0100_v13_core concurrently with this lane. ensureTracesSchema()
// therefore CREATEs IF NOT EXISTS to the spec shape and then patches any
// missing columns with ALTER TABLE — whichever lane lands first, the index
// write always finds the columns it needs.
// ===========================================================================

import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { homeRoot } from "../home.js";
import { getDb } from "../db/connection.js";
import type { Usage } from "../providers/types.js";

export const MAX_TRACE_HEAVY_FIELD_BYTES = 256 * 1024;
export const MAX_TRACE_LINE_BYTES = 1024 * 1024;

/** The 4-way token split every trace carries (spec §17.1). */
export interface Tokens4Way {
  input: number;
  cache_creation: number;
  cache_read: number;
  output: number;
}

/**
 * Placeholder a heavy field becomes when the 30-day retention job compresses
 * it: the content hash + original size, instead of the content.
 */
export interface CompressedField {
  sha256: string;
  chars: number;
}

/** One full trace: one CLI invocation, everything the model saw and said. */
export interface TraceRecord {
  trace_id: string;
  /** ISO timestamp of the invocation (also names the day file). */
  ts: string;
  run_id: string;
  /** 1 for the primary invocation; 2 for a poison-fallback re-run, etc. */
  attempt: number;
  /** Which pass/agent made the call (P-CL1, chat, media, …). */
  pass: string;
  /** The code path that made the call (prompts/runner, server/chat, …). */
  caller: string;
  /** Model id the call asked for; null = subscription default. */
  model: string | null;
  prompt_version: string | null;
  system_prompt: string | CompressedField | null;
  /** The packed, variable half — byte-what-the-model-saw on stdin. */
  packed_context: string | CompressedField;
  /** The model's answer, verbatim as streamed. */
  raw_output: string | CompressedField;
  parsed_result: unknown;
  repair_count: number;
  /** Critic verdicts, once the critic pass exists (P1). null until then. */
  verdicts: unknown;
  tokens_4way: Tokens4Way;
  cost_usd: number | null;
  latency_ms: number;
  /** "ok" or the provider error code the invocation ended with. */
  status: string;
  /** Set by the retention job when heavy fields were hashed away. */
  compressed?: boolean;
  /** Set by the retention job on records kept whole as samples. */
  sampled_keep?: boolean;
}

/** Resolve the traces directory: <homeRoot()>/traces (P0.1 home layout). */
export function tracesRoot(): string {
  return join(homeRoot(), "traces");
}

/** The day (YYYY-MM-DD) a record belongs to, from its timestamp. */
export function dayOf(ts: string): string {
  return ts.slice(0, 10);
}

/** Day-file path for a given day. */
export function dayFilePath(day: string): string {
  return join(tracesRoot(), `${day}.jsonl`);
}

export function usageToTokens4Way(usage: Usage): Tokens4Way {
  return {
    input: usage.inputTokens ?? 0,
    cache_creation: usage.cacheCreationInputTokens ?? 0,
    cache_read: usage.cacheReadInputTokens ?? 0,
    output: usage.outputTokens ?? 0,
  };
}

function compressed(value: string): CompressedField {
  return {
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
    chars: value.length,
  };
}

function boundedString(value: string | CompressedField): string | CompressedField;
function boundedString(value: string | CompressedField | null): string | CompressedField | null;
function boundedString(value: string | CompressedField | null): string | CompressedField | null {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_TRACE_HEAVY_FIELD_BYTES
    ? compressed(value)
    : value;
}

function boundedJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { omitted: "unserializable" };
  }
  if (typeof encoded !== "string") return { omitted: "unserializable" };
  return Buffer.byteLength(encoded, "utf8") > MAX_TRACE_HEAVY_FIELD_BYTES
    ? { omitted: "size-limit", ...compressed(encoded) }
    : value;
}

/** Bound every attacker/provider-influenced trace payload before disk append. */
export function boundedTraceRecord(record: TraceRecord): TraceRecord {
  const systemPrompt = boundedString(record.system_prompt);
  const packedContext = boundedString(record.packed_context);
  const rawOutput = boundedString(record.raw_output);
  const parsedResult = boundedJson(record.parsed_result);
  const verdicts = boundedJson(record.verdicts);
  const heavyFieldCompressed = systemPrompt !== record.system_prompt
    || packedContext !== record.packed_context
    || rawOutput !== record.raw_output
    || parsedResult !== record.parsed_result
    || verdicts !== record.verdicts;
  let bounded: TraceRecord = {
    ...record,
    system_prompt: systemPrompt,
    packed_context: packedContext,
    raw_output: rawOutput,
    parsed_result: parsedResult,
    verdicts,
    ...(heavyFieldCompressed ? { compressed: true } : {}),
  };
  let encoded = JSON.stringify(bounded);
  if (Buffer.byteLength(encoded, "utf8") + 1 > MAX_TRACE_LINE_BYTES) {
    bounded = {
      ...bounded,
      system_prompt: typeof record.system_prompt === "string" ? compressed(record.system_prompt) : record.system_prompt,
      packed_context: typeof record.packed_context === "string" ? compressed(record.packed_context) : record.packed_context,
      raw_output: typeof record.raw_output === "string" ? compressed(record.raw_output) : record.raw_output,
      parsed_result: { omitted: "trace-line-limit" },
      verdicts: { omitted: "trace-line-limit" },
      compressed: true,
    };
    encoded = JSON.stringify(bounded);
  }
  if (Buffer.byteLength(encoded, "utf8") + 1 > MAX_TRACE_LINE_BYTES) {
    throw new Error("trace metadata exceeds the storage limit");
  }
  return bounded;
}

// ---------------------------------------------------------------------------
// Index schema (see the coexistence note in the header).
// ---------------------------------------------------------------------------

/** Column -> type/default, used both to CREATE and to patch a foreign table. */
const INDEX_COLUMNS: Record<string, string> = {
  id: "TEXT PRIMARY KEY",
  run_id: "TEXT",
  attempt: "INTEGER DEFAULT 1",
  pass: "TEXT",
  caller: "TEXT",
  model: "TEXT",
  prompt_version: "TEXT",
  repair_count: "INTEGER DEFAULT 0",
  input_tokens: "INTEGER DEFAULT 0",
  cache_creation_input_tokens: "INTEGER DEFAULT 0",
  cache_read_input_tokens: "INTEGER DEFAULT 0",
  output_tokens: "INTEGER DEFAULT 0",
  cost_usd: "REAL",
  latency_ms: "INTEGER",
  status: "TEXT",
  day: "TEXT",
  file: "TEXT",
  compressed: "INTEGER DEFAULT 0",
  created_at: "TEXT",
};

/** Handles already ensured this process — ensure runs once per connection. */
const ensured = new WeakSet<Database.Database>();

/**
 * Make sure the `traces` table exists and carries every index column. Safe to
 * run against a table another migration already created: missing columns are
 * added, existing ones are left alone.
 */
export function ensureTracesSchema(db: Database.Database): void {
  if (ensured.has(db)) return;

  const cols = Object.entries(INDEX_COLUMNS)
    .map(([name, type]) => `${name} ${type}`)
    .join(",\n  ");
  db.exec(`CREATE TABLE IF NOT EXISTS traces (\n  ${cols}\n);`);

  // Patch a table someone else created with a different column set.
  const present = new Set(
    (db.prepare("PRAGMA table_info(traces)").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  for (const [name, type] of Object.entries(INDEX_COLUMNS)) {
    if (present.has(name)) continue;
    // ALTER ADD cannot carry PRIMARY KEY; strip constraints beyond the default.
    const addType = type.replace(/\s*PRIMARY KEY\s*/i, " ").trim() || "TEXT";
    try {
      db.exec(`ALTER TABLE traces ADD COLUMN ${name} ${addType};`);
    } catch {
      // Raced another writer adding the same column — fine either way.
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_traces_run  ON traces(run_id);
    CREATE INDEX IF NOT EXISTS idx_traces_day  ON traces(day);
    CREATE INDEX IF NOT EXISTS idx_traces_pass ON traces(pass, created_at);
  `);
  ensured.add(db);
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/**
 * Persist one trace: append the full record to its day's jsonl file AND insert
 * the index row. Throws on failure — the CALLER (the trace context flush, or
 * the ghost-call fallback) decides that a trace failure must not kill the
 * model call, and catches.
 */
export interface TraceWriteDependencies {
  db?: Database.Database;
  append?: (file: string, line: string) => void;
  index?: (db: Database.Database, record: TraceRecord) => void;
  serialize?: <T>(db: Database.Database, fn: () => T) => T;
}

/** SQLite owns the cross-process lease; the OS releases it if a writer dies. */
export function withTraceDbLock<T>(db: Database.Database, fn: () => T): T {
  // A caller-owned deferred transaction may not yet hold SQLite's write lock,
  // so proceeding inside it could race another process's file append. Keep
  // the paired JSONL+index operation explicit instead of weakening the lock.
  if (db.inTransaction) throw new Error("trace persistence cannot join an outer transaction");
  return db.transaction(fn).immediate();
}

function repairUnterminatedTail(file: string): void {
  let fd: number;
  try { fd = openSync(file, "r"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return;
    const last = Buffer.allocUnsafe(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;
    const chunk = Buffer.allocUnsafe(Math.min(size, MAX_TRACE_LINE_BYTES));
    const start = size - chunk.length;
    readSync(fd, chunk, 0, chunk.length, start);
    const newline = chunk.lastIndexOf(0x0a);
    truncateSync(file, newline < 0 ? 0 : start + newline + 1);
  } finally {
    closeSync(fd);
  }
}

function fileContainsTrace(file: string, traceId: string): boolean {
  let contents: string;
  try { contents = readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return contents.split("\n").some((line) => {
    if (!line) return false;
    try { return (JSON.parse(line) as { trace_id?: unknown }).trace_id === traceId; }
    catch { return false; }
  });
}

export function writeTrace(record: TraceRecord, deps: TraceWriteDependencies = {}): void {
  const safeRecord = boundedTraceRecord(record);
  const day = dayOf(safeRecord.ts);
  const file = dayFilePath(day);
  mkdirSync(tracesRoot(), { recursive: true });
  const line = `${JSON.stringify(safeRecord)}\n`;
  const db = deps.db ?? getDb();
  const append = deps.append ?? ((path: string, value: string) => appendFileSync(path, value, "utf8"));
  const index = deps.index ?? writeTraceIndexRow;
  const serialize = deps.serialize ?? withTraceDbLock;
  serialize(db, () => {
    // Append first: an index must never point at a line that was not durable.
    // If indexing fails, retry observes the existing id and repairs only the
    // index, avoiding a duplicate JSONL entry.
    repairUnterminatedTail(file);
    if (!fileContainsTrace(file, safeRecord.trace_id)) {
      let originalLength = 0;
      try { originalLength = statSync(file).size; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        append(file, line);
      } catch (error) {
        // append(2) can report an error after a partial write. Restore the
        // exact pre-attempt boundary while still holding the day lease.
        try { truncateSync(file, originalLength); } catch { /* retain cause */ }
        throw error;
      }
    }
    index(db, safeRecord);
  });
}

/**
 * The `traces` index row ALONE, keyed on `trace_id` and idempotent (INSERT OR
 * REPLACE), so the same record can be written twice and land once:
 *
 *   1. by the run ledger (db/index.ts `writeRunLedger`), inside the SAME
 *      transaction as the `runs` + `extraction_runs` rows — S0.9 / T8-2: a
 *      run row can no longer exist without its trace row;
 *   2. by the scope flush (writeTrace above) once the caller has annotated the
 *      parse-side fields — same id, so it replaces the ledger's early row.
 *
 * Takes the handle so it can join a transaction the caller already opened.
 */
export function writeTraceIndexRow(db: Database.Database, record: TraceRecord): void {
  const day = dayOf(record.ts);
  const file = dayFilePath(day);
  ensureTracesSchema(db);
  db.prepare(
    `INSERT OR REPLACE INTO traces
       (id, run_id, attempt, pass, caller, model, prompt_version, repair_count,
        input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        output_tokens, cost_usd, latency_ms, status, day, file, compressed,
        created_at)
     VALUES
       (@id, @run_id, @attempt, @pass, @caller, @model, @prompt_version,
        @repair_count, @input_tokens, @cache_creation_input_tokens,
        @cache_read_input_tokens, @output_tokens, @cost_usd, @latency_ms,
        @status, @day, @file, @compressed, @created_at)`,
  ).run({
    id: record.trace_id,
    run_id: record.run_id,
    attempt: record.attempt,
    pass: record.pass,
    caller: record.caller,
    model: record.model,
    prompt_version: record.prompt_version,
    repair_count: record.repair_count,
    input_tokens: record.tokens_4way.input,
    cache_creation_input_tokens: record.tokens_4way.cache_creation,
    cache_read_input_tokens: record.tokens_4way.cache_read,
    output_tokens: record.tokens_4way.output,
    cost_usd: record.cost_usd,
    latency_ms: record.latency_ms,
    status: record.status,
    day,
    file,
    compressed: record.compressed ? 1 : 0,
    created_at: record.ts,
  });
}

/**
 * The id of the trace already indexed for `runId`, or null. The ledger uses it
 * when the scope has flushed before the run row is written (chat and media log
 * after their scope closes), so the run links to the existing trace instead of
 * a second one being minted.
 */
export function indexedTraceIdFor(db: Database.Database, runId: string): string | null {
  ensureTracesSchema(db);
  const row = db
    .prepare(`SELECT id FROM traces WHERE run_id = ? ORDER BY attempt DESC, created_at DESC LIMIT 1`)
    .get(runId) as { id: string } | undefined;
  return row?.id ?? null;
}
