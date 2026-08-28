// ===========================================================================
// Decision reversal (build P1.5, spec §15.4 / build convention 1.4).
//
// "All merges/splits are decisions: evidenced, reversible (mutation log,
// one-tap undo)." The decisions table already carries `old_json` (the restore
// payload); THIS is the code that applies it for every mutation Lane B's
// passes write, then marks the decision reversed. One-tap undo (UI, P1.7) and
// the second-look detach path both land here.
//
// Unknown (action, kind) pairs return false and change nothing — a reversal
// must never guess.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { markReversed, type DecisionRow } from "../db/decisions.js";

function oldOf(decision: DecisionRow): Record<string, unknown> | null {
  if (decision.oldJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(decision.oldJson);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function newOf(decision: DecisionRow): Record<string, unknown> | null {
  if (decision.newJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(decision.newJson);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Undo a space merge: move everything listed in old_json back, revive the loser. */
function reverseMerge(decision: DecisionRow): boolean {
  const db = getDb();
  const old = oldOf(decision);
  if (old === null) return false;
  const loserId = decision.targetId;
  const back = db.transaction(() => {
    for (const id of ids(old.movedEpisodes)) {
      db.prepare(`UPDATE episodes SET space_id = ? WHERE id = ?`).run(loserId, id);
    }
    for (const id of ids(old.movedChapters)) {
      db.prepare(`UPDATE chapters SET space_id = ? WHERE id = ?`).run(loserId, id);
    }
    for (const id of ids(old.movedTasks)) {
      db.prepare(`UPDATE tasks SET space_id = ? WHERE id = ?`).run(loserId, id);
    }
    const survivorId = str(newOf(decision)?.mergedInto);
    for (const key of ids(old.movedClaims)) {
      db.prepare(`INSERT OR IGNORE INTO space_claims (space_id, claim_key, added_by) VALUES (?, ?, 'undo')`).run(
        loserId,
        key,
      );
      if (survivorId !== null) {
        db.prepare(`DELETE FROM space_claims WHERE space_id = ? AND claim_key = ?`).run(survivorId, key);
      }
    }
    db.prepare(
      `UPDATE spaces SET status = ?, archived_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run(str(old.status) ?? "active", loserId);
  });
  back();
  return true;
}

/** Restore a single-column old state for the simple mutations. */
function reverseSimple(decision: DecisionRow): boolean {
  const db = getDb();
  const old = oldOf(decision);
  const key = `${decision.targetKind}:${decision.action}`;
  switch (key) {
    case "episode:attach":
    case "episode:detach": {
      if (old === null) return false;
      db.prepare(
        `UPDATE episodes SET space_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(str(old.spaceId), decision.targetId);
      return true;
    }
    case "episode:link_chapter": {
      if (old === null) return false;
      db.prepare(
        `UPDATE episodes SET chapter_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(str(old.chapterId), decision.targetId);
      return true;
    }
    case "task:close": {
      if (old === null) return false;
      db.prepare(
        `UPDATE tasks SET status = ?, closed_at = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`,
      ).run(str(old.status) ?? "open", decision.targetId);
      return true;
    }
    case "space:dormant": {
      db.prepare(
        `UPDATE spaces SET status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'dormant'`,
      ).run(decision.targetId);
      return true;
    }
    case "space:update_plan": {
      if (old === null) return false;
      db.prepare(
        `UPDATE spaces SET plan_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      ).run(str(old.planJson), decision.targetId);
      return true;
    }
    case "space:sweep": {
      // The marker itself: reversing it re-arms the sweep. No data to restore.
      return true;
    }
    case "unsorted:archive": {
      db.prepare(
        `UPDATE unsorted SET status = 'open', resolved_at = NULL WHERE id = ? AND status = 'archived'`,
      ).run(decision.targetId);
      return true;
    }
    case "space:merge":
      return reverseMerge(decision);
    default:
      return false;
  }
}

/**
 * Apply a decision's `old_json` and mark it reversed. Returns false — and
 * changes nothing — for a decision already reversed or one whose (kind,
 * action) this build does not know how to restore.
 */
export function reverseDecision(decision: DecisionRow, by: string): boolean {
  if (decision.reversedAt !== null) return false;
  if (!reverseSimple(decision)) return false;
  return markReversed(decision.id, by);
}
