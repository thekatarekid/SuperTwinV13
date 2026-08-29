// ===========================================================================
// Run undo — reverse-replay every derived change one run wrote.
//
// The ops surface has always DOCUMENTED `POST /api/ops/runs/:id/undo`
// ("reverse-replay one run's mutations"), and the Settings › Runs & Traces
// viewer has always rendered an "undo run" link for it, but the route was
// never implemented: the request fell through to `{"error":"unknown ops
// route"}` and the link could only ever print "undo failed". This module is
// the missing half.
//
// Two entry points, deliberately split so a destructive action can be READ
// before it is TAKEN:
//
//   runUndoPreview(runId)  pure. What WOULD be reverted, row by row, plus the
//                          rows that cannot be (unknown shape, already
//                          reversed, or a human's own edit). The Settings
//                          confirm step renders exactly this.
//   undoRun(runId, by)     applies it, newest decision first, in one
//                          transaction, through the same `reverseDecision`
//                          the one-tap undo chip uses.
//
// Two rules the code enforces rather than trusts:
//   * a human's row is never reversed — `pass = 'user'` decisions (including
//     approvals and corrections) are the user's own edits, not the run's.
//   * a decision whose (kind, action) this build cannot restore is SKIPPED and
//     reported, never guessed at.
//
// The bound that follows from rule 2, stated plainly because a surface has to
// tell the user: `reverseDecision` restores what a run MOVED (attach/detach,
// link_chapter, close, dormant, update_plan, sweep, archive, merge). It has no
// restore path for a `create`, and this module does not invent one — deleting
// a created space/episode/unsorted row would cascade through everything
// derived from it, and hard deletion has its own honest path (library/
// delete-cascade.ts). So a pure understanding run reports "nothing to revert"
// rather than half-undoing itself.
// ===========================================================================

import { getDb } from "../db/connection.js";
import type { DecisionRow } from "../db/decisions.js";
import { canReverseDecision, reverseDecision } from "./reversal.js";

/** Who a run-undo is attributed to in `decisions.reversed_by`. */
export const RUN_UNDO_BY = "user:undo-run";

export interface RunUndoItem {
  decisionId: string;
  pass: string | null;
  targetKind: string;
  targetId: string;
  action: string;
  reason: string | null;
  createdAt: string;
  /** True when `reverseDecision` would actually restore this row. */
  reversible: boolean;
  /** Why not, when `reversible` is false — rendered verbatim by the UI. */
  skipReason: string | null;
}

export interface RunUndoPreview {
  runId: string;
  /** Every decision the run wrote, newest first. */
  items: RunUndoItem[];
  /** How many of them an undo would actually revert. */
  reversible: number;
  /** How many it would leave alone (already reversed, user's own, unknown). */
  skipped: number;
}

export interface RunUndoResult extends RunUndoPreview {
  /** How many rows were reverted by this call. */
  reversed: number;
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
 * Every decision one run wrote, newest first — undo unwinds in that order.
 *
 * Tie-broken on `rowid` (insertion order), not `id`. One run writes its whole
 * batch inside a single millisecond, so `created_at` cannot separate them and
 * the random-hex `id` was shuffling the unwind order — which silently broke
 * the "a merge is undone before the moves that fed it" guarantee below.
 */
export function decisionsForRun(runId: string): DecisionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM decisions WHERE run_id = ? ORDER BY created_at DESC, rowid DESC`,
    )
    .all(runId) as Record<string, unknown>[];
  return rows.map(hydrate);
}

function classify(d: DecisionRow): RunUndoItem {
  let skipReason: string | null = null;
  if (d.pass === "user") skipReason = "your own edit — an undo never reverses a human's row";
  else if (d.reversedAt !== null) skipReason = "already reversed";
  else if (!canReverseDecision(d)) skipReason = `no restore path for ${d.targetKind}:${d.action}`;
  return {
    decisionId: d.id,
    pass: d.pass,
    targetKind: d.targetKind,
    targetId: d.targetId,
    action: d.action,
    reason: d.reason,
    createdAt: d.createdAt,
    reversible: skipReason === null,
    skipReason,
  };
}

/**
 * What an undo of this run WOULD do. Reads only — safe to call from a GET, and
 * the exact list the confirm step shows before anything is touched.
 */
export function runUndoPreview(runId: string): RunUndoPreview {
  const items = decisionsForRun(runId).map(classify);
  const reversible = items.filter((i) => i.reversible).length;
  return { runId, items, reversible, skipped: items.length - reversible };
}

/**
 * Reverse-replay one run. Newest decision first (so a merge is undone before
 * the moves that fed it), all-or-nothing inside a single transaction, and only
 * the rows `runUndoPreview` said were reversible.
 */
export function undoRun(runId: string, by: string = RUN_UNDO_BY): RunUndoResult {
  const decisions = decisionsForRun(runId);
  const items = decisions.map(classify);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  let reversed = 0;

  const apply = getDb().transaction(() => {
    for (const item of items) {
      if (!item.reversible) continue;
      const row = byId.get(item.decisionId);
      if (row && reverseDecision(row, by)) {
        reversed++;
      } else {
        item.reversible = false;
        item.skipReason = "restore refused at apply time";
      }
    }
  });
  apply();

  const reversible = items.filter((i) => i.reversible).length;
  return { runId, items, reversible, skipped: items.length - reversible, reversed };
}
