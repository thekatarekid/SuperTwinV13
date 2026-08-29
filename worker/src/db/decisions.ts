// ===========================================================================
// [CODE] Decision rows — build convention 1.4 (P1.1).
//
// Every derived-object change writes a decisions row (0100_v13_core), and
// mutations are reversible: `old_json` is the restore payload, `reversed_at`/
// `reversed_by` mark an undo. This is the ONE writer for that table so every
// caller records the same shape — the "why?" surface (spec §14) reads it back.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "./connection.js";

export interface DecisionInput {
  /** runs.id that proposed it; null for user-made changes. */
  runId?: string | null;
  /** Which pass (or code site) decided: orient|decide|user|code:ingest|... */
  pass?: string | null;
  targetKind: string; // space|episode|claim|task|entity|stream|...
  targetId: string;
  action: string; // create|update|merge|close|link|...
  /** State before the change (null on create) — the undo payload. */
  old?: unknown;
  /** State after the change. */
  new?: unknown;
  reason?: string | null;
  confidence?: number | null;
}

export function mintDecisionId(): string {
  return `dec_${randomBytes(9).toString("hex")}`;
}

/** Append one decision row. Returns its id. */
export function writeDecision(input: DecisionInput): string {
  const id = mintDecisionId();
  getDb()
    .prepare(
      `INSERT INTO decisions (id, run_id, pass, target_kind, target_id, action,
                              old_json, new_json, reason, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.runId ?? null,
      input.pass ?? null,
      input.targetKind,
      input.targetId,
      input.action,
      input.old === undefined ? null : JSON.stringify(input.old),
      input.new === undefined ? null : JSON.stringify(input.new),
      input.reason ?? null,
      input.confidence ?? null,
    );
  return id;
}

export interface DecisionRow {
  id: string;
  runId: string | null;
  pass: string | null;
  targetKind: string;
  targetId: string;
  action: string;
  oldJson: string | null;
  newJson: string | null;
  reason: string | null;
  confidence: number | null;
  createdAt: string;
  reversedAt: string | null;
  reversedBy: string | null;
}

function hydrate(r: Record<string, unknown>): DecisionRow {
  return {
    id: String(r.id),
    runId: (r.run_id as string | null) ?? null,
    pass: (r.pass as string | null) ?? null,
    targetKind: String(r.target_kind),
    targetId: String(r.target_id),
    action: String(r.action),
    oldJson: (r.old_json as string | null) ?? null,
    newJson: (r.new_json as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    createdAt: String(r.created_at),
    reversedAt: (r.reversed_at as string | null) ?? null,
    reversedBy: (r.reversed_by as string | null) ?? null,
  };
}

/**
 * Every decision recorded against one object, newest first.
 *
 * The tie-break is `rowid`, not `id`. `created_at` only has millisecond
 * precision, and a create followed by the user's approve (or a pass writing a
 * batch) lands inside the same millisecond the overwhelming majority of the
 * time — measured at 191/200. `id` is random hex, so tie-breaking on it
 * shuffled same-millisecond rows and the "why?" surface showed the superseded
 * decision as the latest one. `rowid` is insertion order: SQLite assigns
 * max(rowid)+1, which is greater than every surviving row even after deletes,
 * so it orders same-millisecond writes exactly as they happened.
 */
export function decisionsFor(targetKind: string, targetId: string): DecisionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM decisions WHERE target_kind = ? AND target_id = ?
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all(targetKind, targetId) as Record<string, unknown>[];
  return rows.map(hydrate);
}

/**
 * Mark a decision reversed (the caller performs the actual restore from
 * `old_json` — this records that it happened and by whom).
 */
export function markReversed(decisionId: string, by: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE decisions
          SET reversed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reversed_by = ?
        WHERE id = ? AND reversed_at IS NULL`,
    )
    .run(by, decisionId);
  return info.changes > 0;
}
