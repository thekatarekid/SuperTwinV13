// ===========================================================================
// [CODE] Reverse-replaying a run — arch §11.6 rule 9. Build item 3.3.
//
// `POST /api/runs/:id/undo` is not a special code path: every write already
// left a `mutations` row carrying its run id and the old value of whatever it
// touched, so undo is that list, newest first, applied backwards.
//
// TWO RULES.
//
//   A HUMAN'S EDIT IS NEVER REVERSED.  `actor = 'user'` rows are skipped and
//   reported. Undoing a run must not undo the correction a person made while
//   it was running (evals R-039).
//
//   UNDOING TWICE CHANGES NOTHING.  A reversed row is removed from `mutations`
//   and one summary row is written in its place, so the second call finds
//   nothing left to reverse.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { logMutation } from "../entities/merge.js";

// ---- undo ------------------------------------------------------------------

export interface UndoResult {
  runId: string;
  /** Mutation rows reversed, newest first. */
  reversed: string[];
  /** Rows left alone because a human made them. */
  skippedUserMutations: string[];
}

interface MutationRow {
  id: string;
  actor: string | null;
  target_kind: string;
  target_id: string;
  field: string | null;
  old_json: string | null;
  new_json: string | null;
}

const UNDOABLE_COLUMNS: Readonly<Record<string, string>> = {
  statedAt: "stated_at",
  confidence: "confidence",
  closedBy: "closed_by",
  closedReason: "closed_reason",
  validTo: "valid_to",
  validFrom: "valid_from",
};

function reverseOne(row: MutationRow): void {
  const db = getDb();
  const old = row.old_json === null ? null : (JSON.parse(row.old_json) as Record<string, unknown>);
  if (row.target_kind === "claim_version") {
    if (old === null) {
      db.prepare(`DELETE FROM claim_versions WHERE id = ?`).run(row.target_id);
      db.prepare(`DELETE FROM evidence WHERE subject_kind = 'claim' AND subject_id = ?`).run(row.target_id);
      return;
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, column] of Object.entries(UNDOABLE_COLUMNS)) {
      if (!(field in old)) continue;
      sets.push(`${column} = ?`);
      values.push(old[field] ?? null);
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE claim_versions SET ${sets.join(", ")} WHERE id = ?`).run(...values, row.target_id);
    }
    return;
  }
  if (row.target_kind === "evidence") {
    const parts = row.target_id.split("|");
    if (parts.length === 3) {
      db.prepare(`DELETE FROM evidence WHERE subject_kind = ? AND subject_id = ? AND event_id = ?`).run(
        parts[0],
        parts[1],
        parts[2],
      );
    }
    return;
  }
  if (row.target_kind === "question") {
    db.prepare(`DELETE FROM questions WHERE id = ?`).run(row.target_id);
  }
}

/**
 * `POST /api/runs/:id/undo` — reverse-replay one run's mutations.
 *
 * Newest first, so a close is lifted before the row it closed is removed. A
 * mutation whose actor is `user` is NEVER reversed: undoing a run must not
 * undo a human's correction that happened to land inside it (evals R-039).
 * The reversed rows are removed from `mutations` so a second undo is a no-op,
 * and one summary row is written in their place naming every id it undid.
 */
export function undoRun(runId: string, options: { actor?: string } = {}): UndoResult {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, actor, target_kind, target_id, field, old_json, new_json
         FROM mutations WHERE run_id = ? ORDER BY ts DESC, rowid DESC`,
    )
    .all(runId) as MutationRow[];

  const reversed: string[] = [];
  const skipped: string[] = [];
  const apply = db.transaction(() => {
    for (const row of rows) {
      if (row.actor === "user") {
        skipped.push(row.id);
        continue;
      }
      // The summary row a previous undo left behind is a record OF an undo,
      // not a write to reverse. Skipping it makes a second undo a no-op.
      if (row.target_kind === "run") continue;
      reverseOne(row);
      db.prepare(`DELETE FROM mutations WHERE id = ?`).run(row.id);
      reversed.push(row.id);
    }
  });
  apply();

  if (reversed.length > 0) {
    logMutation({
      actor: options.actor ?? "code:undo",
      runId,
      targetKind: "run",
      targetId: runId,
      field: "undo",
      oldValue: reversed,
      reason: `reverse-replayed ${reversed.length} mutation(s)`,
    });
  }
  return { runId, reversed, skippedUserMutations: skipped };
}
