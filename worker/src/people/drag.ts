// ===========================================================================
// [CODE] Merge and split by drag, with undo — V6 P1 S5.4 (Product_V6_Phase1
// §11.3 "drag to merge/split, undo always", Product_V6 §11.5).
//
// The People surface has exactly two identity gestures and both are drags:
//
//   drop person A onto person B   → MERGE. A becomes a tombstone pointing at
//                                   B (entities.merged_into). One UPDATE; no
//                                   row moves, so nothing is lost.
//   drag an alias OFF a person    → SPLIT. The tombstone's merged_into clears
//                                   and both people are live again.
//
// UNDO IS THE INVERSE GESTURE, not a second concept. Every gesture returns an
// `undo` handle (the mutation id `entities/merge.ts` logged); `undoDrag()`
// reads that row and applies the opposite operation.
//
// The one subtlety: `splitEntity` records a PERMANENT `different` verdict for
// the pair, which is exactly right for a deliberate split and exactly wrong
// for an accidental one. So undoing a split first records the reversing
// `same` verdict AS THE USER (`recordDecision` lets a user overwrite a user
// verdict, and only a user) and then merges. Undoing a merge leaves the
// `different` the split wrote — a merge the user took back IS a "no", and the
// negative pair keeps automation from proposing it again.
//
// Nothing here guesses. A drag is a user act; the ladder and the merge-forward
// path (provisional.ts) are where the machine's own proposals live, and those
// go through the question queue, never through this module.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import {
  isNegativePair,
  logMutation,
  mergeEntities,
  recordDecision,
  splitEntity,
  type MergeResult,
  type SplitResult,
} from "../entities/merge.js";
import { getEntity, mergedAliasIds, readEntityRaw, resolveEntityId } from "../entities/registry.js";

export const DRAG_ACTOR = "user";

export interface DragResult {
  ok: boolean;
  action: "merge" | "split";
  /** Human line for the undo chip. */
  summary: string;
  /** The mutation to hand back to `undoDrag`. Null when nothing happened. */
  undoId: string | null;
  winner: string | null;
  loser: string | null;
  /** Set when the gesture was refused, naming the rule that refused it. */
  refused?: string;
}

function label(id: string): string {
  return getEntity(id)?.canonical ?? id;
}

/** The mutation `mergeEntities` / `splitEntity` just wrote for this entity. */
function latestMergeMutation(entityId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT id FROM mutations WHERE target_kind = 'entity' AND target_id = ? AND field = 'merged_into'
        ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get(entityId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Drop `loser` onto `winner` in the People view. The winner survives (it is
 * the card the user dropped onto), the loser becomes a tombstone, and the
 * whole thing is one mutation row so undo is exact.
 */
export function mergeByDrag(params: { loser: string; winner: string; reason?: string | null }): DragResult {
  const loser = resolveEntityId(params.loser);
  const winner = resolveEntityId(params.winner);
  const reason = params.reason ?? "user dragged one person onto another in People";
  if (!loser || !winner) {
    return { ok: false, action: "merge", summary: "one of those people is gone", undoId: null, winner, loser, refused: "missing" };
  }
  if (loser === winner) {
    return { ok: false, action: "merge", summary: "that is already one person", undoId: null, winner, loser, refused: "same_entity" };
  }
  const names = `${label(loser)} → ${label(winner)}`;
  const result: MergeResult = mergeEntities({ loser, winner, actor: DRAG_ACTOR, reason });
  if (!result.merged) {
    return {
      ok: false,
      action: "merge",
      summary:
        result.refused === "negative_pair"
          ? `${names} are recorded as different people — say they are the same first`
          : `merge refused (${result.refused ?? "unknown"})`,
      undoId: null,
      winner,
      loser,
      refused: result.refused,
    };
  }
  writeDecision({
    pass: DRAG_ACTOR,
    targetKind: "entity",
    targetId: loser,
    action: "merge",
    old: { merged_into: null },
    new: { merged_into: winner },
    reason,
    confidence: 1,
  });
  return { ok: true, action: "merge", summary: `merged ${names}`, undoId: latestMergeMutation(loser), winner, loser };
}

/**
 * Drag an alias off a person. `entityId` is the TOMBSTONE (the alias chip the
 * user pulled out), which is what the card renders in `mergedAliases`.
 */
export function splitByDrag(params: { entityId: string; reason?: string | null }): DragResult {
  const raw = readEntityRaw(params.entityId);
  const reason = params.reason ?? "user dragged an alias out of a person in People";
  if (!raw) {
    return { ok: false, action: "split", summary: "no such person", undoId: null, winner: null, loser: params.entityId, refused: "missing" };
  }
  if (raw.mergedInto === null) {
    return {
      ok: false,
      action: "split",
      summary: `${label(raw.id)} is not merged into anyone`,
      undoId: null,
      winner: null,
      loser: raw.id,
      refused: "not_merged",
    };
  }
  const from = resolveEntityId(raw.mergedInto);
  const result: SplitResult = splitEntity({ entityId: raw.id, actor: DRAG_ACTOR, reason });
  if (!result.split) {
    return { ok: false, action: "split", summary: "split refused", undoId: null, winner: from, loser: raw.id, refused: "not_merged" };
  }
  writeDecision({
    pass: DRAG_ACTOR,
    targetKind: "entity",
    targetId: raw.id,
    action: "split",
    old: { merged_into: from },
    new: { merged_into: null },
    reason,
    confidence: 1,
  });
  return {
    ok: true,
    action: "split",
    summary: `split ${label(raw.id)} out of ${from ? label(from) : "the merge"}`,
    undoId: latestMergeMutation(raw.id),
    winner: from,
    loser: raw.id,
  };
}

export interface UndoResult {
  ok: boolean;
  /** What the undo did (the inverse of the gesture it reversed). */
  action: "merge" | "split" | null;
  summary: string;
  /** The handle for undoing THE UNDO — every gesture is reversible, forever. */
  undoId: string | null;
  reason?: string;
}

/**
 * Reverse one merge/split mutation. Idempotence is by state, not by a flag:
 * an undo whose effect is already in place reports `ok: false` with a reason
 * instead of merging the person a second time.
 */
export function undoDrag(mutationId: string): UndoResult {
  const row = getDb()
    .prepare(`SELECT target_kind, target_id, field, old_json, new_json FROM mutations WHERE id = ?`)
    .get(mutationId) as
    | { target_kind: string; target_id: string; field: string | null; old_json: string | null; new_json: string | null }
    | undefined;
  if (!row || row.target_kind !== "entity" || row.field !== "merged_into") {
    return { ok: false, action: null, summary: "nothing to undo", undoId: null, reason: "unknown_mutation" };
  }
  const entityId = row.target_id;
  const raw = readEntityRaw(entityId);
  if (!raw) return { ok: false, action: null, summary: "that person is gone", undoId: null, reason: "missing" };
  const newValue = row.new_json === null ? null : (JSON.parse(row.new_json) as string | null);

  // The mutation MERGED (null → winner): undo is a split.
  if (newValue !== null) {
    if (raw.mergedInto === null) {
      return { ok: false, action: null, summary: "already split", undoId: null, reason: "already_applied" };
    }
    const back = splitByDrag({ entityId, reason: `undo of merge ${mutationId}` });
    return { ok: back.ok, action: "split", summary: back.ok ? `undone — ${back.summary}` : back.summary, undoId: back.undoId, reason: back.refused };
  }

  // The mutation SPLIT (winner → null): undo is a merge back onto the winner.
  const oldValue = row.old_json === null ? null : (JSON.parse(row.old_json) as string | null);
  const winner = oldValue ? resolveEntityId(oldValue) : null;
  if (!winner) return { ok: false, action: null, summary: "the other half is gone", undoId: null, reason: "missing" };
  if (raw.mergedInto !== null) {
    return { ok: false, action: null, summary: "already merged", undoId: null, reason: "already_applied" };
  }
  // The split wrote a permanent `different`. Undoing it is the user saying
  // "same" — the one actor allowed to overwrite a user verdict.
  if (isNegativePair(entityId, winner)) {
    recordDecision({
      left: entityId,
      right: winner,
      verdict: "same",
      decidedBy: DRAG_ACTOR,
      reason: `undo of split ${mutationId}`,
    });
  }
  const back = mergeByDrag({ loser: entityId, winner, reason: `undo of split ${mutationId}` });
  return { ok: back.ok, action: "merge", summary: back.ok ? `undone — ${back.summary}` : back.summary, undoId: back.undoId, reason: back.refused };
}

/** The alias chips a person card shows — every tombstone pointing at it. */
export function aliasChips(entityId: string): { id: string; name: string | null }[] {
  const id = resolveEntityId(entityId);
  if (!id) return [];
  return (
    mergedAliasIds(id)
      .filter((a) => a !== id)
      // readEntityRaw, not getEntity: a chip must show the ALIAS's own name,
      // and getEntity follows the tombstone to the survivor.
      .map((a) => ({ id: a, name: readEntityRaw(a)?.canonical ?? null }))
  );
}

/** Record the "no, different people" verdict a user gives on a merge question. */
export function markDifferent(a: string, b: string, reason = "user said different people"): void {
  const left = resolveEntityId(a);
  const right = resolveEntityId(b);
  if (!left || !right || left === right) return;
  recordDecision({ left, right, verdict: "different", decidedBy: DRAG_ACTOR, reason });
  logMutation({
    actor: DRAG_ACTOR,
    targetKind: "entity_pair",
    targetId: `${left}|${right}`,
    field: "verdict",
    oldValue: null,
    newValue: "different",
    reason,
  });
}
