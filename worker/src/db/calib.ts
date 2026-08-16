// ===========================================================================
// [CODE] embedder_calib storage — arch §6 (table), §10.3 ("Embedder
// calibration — a prerequisite, not an optimisation"), build item 0.7.
//
// One measured number per (model, use_case): the cosine FLOOR of unrelated
// pairs in that embedding space. Everything above this module — the [ML]
// similarity rung — reads the floor from here and normalises against it. It
// never invents one, which is why this module has no default and no fallback:
// a missing row reads back as null, and the caller's only legal move is to
// stop using similarity for that pair (see retrieval/calibration.ts).
//
// Two shapes live here:
//
//   1. the calib rows themselves (read / upsert / delete), and
//   2. the VECTOR SOURCES a floor is measured from — one stored-vector table
//      per use case, always filtered by (model, dim), so a floor is never
//      measured across two embedding spaces whose cosines mean different
//      things.
//
// Nothing here decides whether a floor is fresh, stale or good enough. That is
// policy and lives one layer up.
// ===========================================================================

import type Database from "better-sqlite3";

import { getDb } from "./connection.js";
import { decodeVector, type EmbeddingModelKey } from "./embeddings.js";

// ---- Use cases ------------------------------------------------------------

/**
 * The six independent similarity use cases (arch §10.3 ¶3). They are separate
 * rows because they are separate text distributions: the cosine floor of
 * "entity rich text" is not the floor of "loop intent", and one number
 * covering both is a guessed threshold wearing a measurement's clothes.
 */
export const CALIB_USE_CASES = [
  "entity_name",
  "entity_rich_text",
  "episode_topic",
  "arc_topic",
  "claim_text",
  "loop_intent",
] as const;

export type CalibUseCase = (typeof CALIB_USE_CASES)[number];

const USE_CASE_SET: ReadonlySet<string> = new Set(CALIB_USE_CASES);

export function isCalibUseCase(value: unknown): value is CalibUseCase {
  return typeof value === "string" && USE_CASE_SET.has(value);
}

/** One `embedder_calib` row, in worker shapes. */
export interface CalibRow {
  model: string;
  useCase: CalibUseCase;
  /** Unrelated-pair cosine floor for this space. Always finite, in [0, 1). */
  floor: number;
  /** ISO-8601 UTC. Null only on a hand-written row. */
  measuredAt: string | null;
  /** How many unrelated pairs the floor was measured from. */
  nPairs: number | null;
}

export interface PutCalibParams {
  model: string;
  useCase: CalibUseCase;
  floor: number;
  nPairs: number;
  /** ISO-8601 UTC; defaults to now. Injectable so tests can age a row. */
  measuredAt?: string;
}

// ---- Vector sources -------------------------------------------------------

export interface CalibVectorSource {
  readonly table: string;
  readonly idColumn: string;
  readonly vecColumn: string;
}

/**
 * Where each use case's floor is measured from.
 *
 * `entity_name` and `entity_rich_text` share `entity_embeddings` on purpose:
 * arch §10.3 ¶4 forbids embedding a bare name at all, so there is no table of
 * bare-name vectors to measure and there never will be. The two rows still
 * differ, because they carry different BARS (retrieval/calibration.ts) over
 * the same measured floor.
 *
 * `arc_topic` reads `episode_embeddings` for the same reason: §6 mints no
 * `arc_embeddings` table — an arc's topic vector is the episode-topic space —
 * and the arc bar sits strictly above the episode bar rather than on a
 * separately measured floor.
 */
export const CALIB_VECTOR_SOURCES: Readonly<Record<CalibUseCase, CalibVectorSource>> = {
  entity_name: { table: "entity_embeddings", idColumn: "entity_id", vecColumn: "vec" },
  entity_rich_text: { table: "entity_embeddings", idColumn: "entity_id", vecColumn: "vec" },
  episode_topic: { table: "episode_embeddings", idColumn: "episode_id", vecColumn: "vec" },
  arc_topic: { table: "episode_embeddings", idColumn: "episode_id", vecColumn: "vec" },
  claim_text: { table: "claim_embeddings", idColumn: "claim_id", vecColumn: "vec" },
  loop_intent: { table: "loop_embeddings", idColumn: "loop_id", vecColumn: "vec" },
};

/** Hard cap on vectors pulled into one measurement pass. */
export const CALIB_VECTOR_READ_LIMIT = 4096;

// ---- Handles --------------------------------------------------------------

interface HandleCache {
  db: Database.Database;
  stmts: Map<string, Database.Statement>;
  /** Only POSITIVE results are memoised — a table can appear, never vanish. */
  present: Set<string>;
}

let cache: HandleCache | null = null;

function handle(): HandleCache {
  const db = getDb();
  if (!cache || cache.db !== db) cache = { db, stmts: new Map(), present: new Set() };
  return cache;
}

function stmt(sql: string): Database.Statement {
  const h = handle();
  let prepared = h.stmts.get(sql);
  if (!prepared) {
    prepared = h.db.prepare(sql);
    h.stmts.set(sql, prepared);
  }
  return prepared;
}

/**
 * Whether a table exists. Every read here is a best-effort read against a DB
 * that may predate migration 0020, and a missing table must read as "no data",
 * not as a crash on the boot path.
 */
function tableExists(name: string): boolean {
  const h = handle();
  if (h.present.has(name)) return true;
  const row = h.db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined;
  if (row) {
    h.present.add(name);
    return true;
  }
  return false;
}

const CALIB_TABLE = "embedder_calib";

/** Whether `embedder_calib` exists at all (migration 0020 applied). */
export function calibTablePresent(): boolean {
  return tableExists(CALIB_TABLE);
}

// ---- Validation -----------------------------------------------------------

/**
 * A floor of 1.0 makes `(cos − floor) / (1 − floor)` a division by zero, and a
 * floor above 1 or below 0 is not a cosine of anything. Both are rejected at
 * the WRITE, because a bad floor read back later is indistinguishable from a
 * good one and silently rescales every score in that space.
 */
export function assertValidFloor(floor: number, where: string): void {
  if (!Number.isFinite(floor) || floor < 0 || floor >= 1) {
    throw new Error(`${where}: floor must be a cosine in [0, 1), got ${floor}`);
  }
}

function assertUseCase(useCase: string, where: string): asserts useCase is CalibUseCase {
  if (!isCalibUseCase(useCase)) {
    throw new Error(
      `${where}: unknown calibration use case '${useCase}' (expected one of ${CALIB_USE_CASES.join(", ")})`,
    );
  }
}

// ---- Reads ----------------------------------------------------------------

interface RawCalibRow {
  model: string;
  use_case: string;
  floor: number;
  measured_at: string | null;
  n_pairs: number | null;
}

function toRow(raw: RawCalibRow): CalibRow | null {
  // A row with an unknown use case, or a floor outside [0, 1), is a row this
  // code cannot honour. It reads back as absent — which blocks the rung —
  // rather than as a threshold nobody measured.
  if (!isCalibUseCase(raw.use_case)) return null;
  if (!Number.isFinite(raw.floor) || raw.floor < 0 || raw.floor >= 1) return null;
  return {
    model: raw.model,
    useCase: raw.use_case,
    floor: raw.floor,
    measuredAt: raw.measured_at,
    nPairs: raw.n_pairs,
  };
}

/** One calibration row, or null when it has never been measured. */
export function readCalib(model: string, useCase: CalibUseCase): CalibRow | null {
  if (!calibTablePresent()) return null;
  const raw = stmt(
    `SELECT model, use_case, floor, measured_at, n_pairs
       FROM ${CALIB_TABLE} WHERE model = @model AND use_case = @useCase`,
  ).get({ model, useCase }) as RawCalibRow | undefined;
  return raw ? toRow(raw) : null;
}

/** Every calibration row for one model, use-case order as declared. */
export function readCalibForModel(model: string): CalibRow[] {
  if (!calibTablePresent()) return [];
  const raws = stmt(
    `SELECT model, use_case, floor, measured_at, n_pairs
       FROM ${CALIB_TABLE} WHERE model = @model`,
  ).all({ model }) as RawCalibRow[];
  const byUseCase = new Map<string, CalibRow>();
  for (const raw of raws) {
    const row = toRow(raw);
    if (row) byUseCase.set(row.useCase, row);
  }
  return CALIB_USE_CASES.map((uc) => byUseCase.get(uc)).filter((r): r is CalibRow => !!r);
}

/** Every calibration row, all models — for the status surface. */
export function readAllCalib(): CalibRow[] {
  if (!calibTablePresent()) return [];
  const raws = stmt(
    `SELECT model, use_case, floor, measured_at, n_pairs
       FROM ${CALIB_TABLE} ORDER BY model, use_case`,
  ).all() as RawCalibRow[];
  return raws.map(toRow).filter((r): r is CalibRow => !!r);
}

// ---- Writes ---------------------------------------------------------------

/** Upsert one measured floor. Re-measuring REPLACES, never accumulates. */
export function putCalib(params: PutCalibParams): void {
  assertUseCase(params.useCase, "putCalib");
  assertValidFloor(params.floor, "putCalib");
  if (!Number.isFinite(params.nPairs) || params.nPairs < 0) {
    throw new Error(`putCalib: n_pairs must be a non-negative count, got ${params.nPairs}`);
  }
  if (!calibTablePresent()) {
    throw new Error("putCalib: embedder_calib is missing — migration 0020 has not been applied");
  }
  stmt(
    `INSERT INTO ${CALIB_TABLE} (model, use_case, floor, measured_at, n_pairs)
     VALUES (@model, @useCase, @floor, @measuredAt, @nPairs)
     ON CONFLICT(model, use_case) DO UPDATE SET
       floor       = excluded.floor,
       measured_at = excluded.measured_at,
       n_pairs     = excluded.n_pairs`,
  ).run({
    model: params.model,
    useCase: params.useCase,
    floor: params.floor,
    measuredAt: params.measuredAt ?? new Date().toISOString(),
    nPairs: Math.floor(params.nPairs),
  });
}

/** Several at once, in one transaction. Returns how many were written. */
export function putCalibRows(rows: readonly PutCalibParams[]): number {
  const h = handle();
  const tx = h.db.transaction((items: readonly PutCalibParams[]) => {
    for (const item of items) putCalib(item);
    return items.length;
  });
  return tx(rows);
}

/**
 * Drop calibration. With no argument, all of it — which is exactly what a
 * "recalibrate from scratch" is, and what leaves the similarity rung blocked
 * until the next measurement lands.
 */
export function clearCalib(opts?: { model?: string; useCase?: CalibUseCase }): number {
  if (!calibTablePresent()) return 0;
  if (opts?.model && opts?.useCase) {
    return stmt(`DELETE FROM ${CALIB_TABLE} WHERE model = @model AND use_case = @useCase`).run({
      model: opts.model,
      useCase: opts.useCase,
    }).changes;
  }
  if (opts?.model) {
    return stmt(`DELETE FROM ${CALIB_TABLE} WHERE model = @model`).run({ model: opts.model })
      .changes;
  }
  if (opts?.useCase) {
    return stmt(`DELETE FROM ${CALIB_TABLE} WHERE use_case = @useCase`).run({
      useCase: opts.useCase,
    }).changes;
  }
  return stmt(`DELETE FROM ${CALIB_TABLE}`).run().changes;
}

// ---- Vector sampling source ----------------------------------------------

/**
 * How many stored vectors exist for a use case in ONE embedding space.
 * Zero when the source table predates the migration that creates it.
 */
export function countCalibVectors(useCase: CalibUseCase, key: EmbeddingModelKey): number {
  assertUseCase(useCase, "countCalibVectors");
  const src = CALIB_VECTOR_SOURCES[useCase];
  if (!tableExists(src.table)) return 0;
  const row = stmt(
    `SELECT COUNT(*) AS n FROM ${src.table} WHERE model = @model AND dim = @dim`,
  ).get({ model: key.model, dim: key.dim }) as { n: number };
  return row.n;
}

/**
 * The stored vectors a floor is measured from, for one use case in one space.
 *
 * The (model, dim) filter is the whole point: vectors written by a PREVIOUS
 * embedder are invisible here, so a model swap cannot leave the new model's
 * floor measured against the old model's geometry.
 */
export function readCalibVectors(
  useCase: CalibUseCase,
  key: EmbeddingModelKey,
  limit = CALIB_VECTOR_READ_LIMIT,
): Float32Array[] {
  assertUseCase(useCase, "readCalibVectors");
  const src = CALIB_VECTOR_SOURCES[useCase];
  if (!tableExists(src.table)) return [];
  const rows = stmt(
    `SELECT ${src.vecColumn} AS vec FROM ${src.table}
      WHERE model = @model AND dim = @dim
      LIMIT @limit`,
  ).all({
    model: key.model,
    dim: key.dim,
    limit: clampLimit(limit, CALIB_VECTOR_READ_LIMIT),
  }) as { vec: Buffer }[];

  const out: Float32Array[] = [];
  for (const row of rows) {
    const vec = decodeVector(row.vec);
    // A row whose blob disagrees with its own `dim` is corrupt; including it
    // would put a shorter vector into a cosine that silently returns 0.
    if (vec.length === key.dim) out.push(vec);
  }
  return out;
}

function clampLimit(raw: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return max;
  return Math.min(Math.floor(n), max);
}

/** Drops memoised handles/statements. Tests that swap DB files call this. */
export function resetCalibCacheForTests(): void {
  cache = null;
}
