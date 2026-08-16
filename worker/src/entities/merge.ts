// ===========================================================================
// [CODE] Merges, splits and the permanent record of what was decided.
// Build item 1.5, arch §10.3.
//
// A MERGE IS A TOMBSTONE, NOT A REWRITE. `entities.merged_into` on the loser
// points at the winner and that is the whole operation: one UPDATE, O(1), no
// matter how many identities, edges, mentions or claims reference the loser.
// Reads follow the redirect (`resolveEntityId`, `mergedAliasIds`), and
// reconcile compacts the references later when it is cheap to do so.
//
// The reason is not performance, it is REVERSIBILITY. A rewrite-merge destroys
// the information needed to undo it: once Rahul-Arora's rows say "Rahul-Mehta",
// nothing knows which half came from where. A tombstone keeps every row exactly
// where it was filed, so a split is `merged_into = NULL` and the two entities
// are simply back — with their evidence still attached by source identity.
//
// NEGATIVE PAIRS ARE PERMANENT. `resolution_decisions` stores every verdict.
// A `different` verdict is never re-proposed, and a `different` from the USER
// outranks any later automation score, however confident. That rule is why
// "Rahul Arora" and "Rahul Mehta" stay two people through every re-derivation.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { repointEdges } from "./edges.js";
import { repointIdentities, repointIdentitiesOfSource } from "./identities.js";
import { mergedAliasIds, readEntityRaw, resolveEntityId } from "./registry.js";

export type Verdict = "same" | "different" | "unsure";

export interface DecisionRow {
  id: string;
  leftId: string;
  rightId: string;
  verdict: Verdict;
  decidedBy: string | null;
  reason: string | null;
}

/** Pairs are unordered — `(A,B)` and `(B,A)` are one decision, stored sorted. */
function orderPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/** Every write emits one of these. "Undo run X" is reverse-replay over the table. */
export interface MutationParams {
  actor: string;
  runId?: string | null;
  targetKind: string;
  targetId: string;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}

export function logMutation(params: MutationParams): string {
  const id = mintId("mut");
  getDb()
    .prepare(
      `INSERT INTO mutations (id, actor, run_id, target_kind, target_id, field, old_json, new_json, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      params.actor,
      params.runId ?? null,
      params.targetKind,
      params.targetId,
      params.field ?? null,
      params.oldValue === undefined ? null : JSON.stringify(params.oldValue),
      params.newValue === undefined ? null : JSON.stringify(params.newValue),
      params.reason ?? null,
    );
  return id;
}

export function mutationsFor(targetKind: string, targetId: string): {
  id: string;
  actor: string | null;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
}[] {
  return (
    getDb()
      .prepare(
        `SELECT id, actor, field, old_json, new_json, reason FROM mutations
          WHERE target_kind = ? AND target_id = ? ORDER BY ts, rowid`,
      )
      .all(targetKind, targetId) as {
      id: string;
      actor: string | null;
      field: string | null;
      old_json: string | null;
      new_json: string | null;
      reason: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    actor: r.actor,
    field: r.field,
    oldValue: r.old_json === null ? null : (JSON.parse(r.old_json) as unknown),
    newValue: r.new_json === null ? null : (JSON.parse(r.new_json) as unknown),
    reason: r.reason,
  }));
}

// ---- decisions -------------------------------------------------------------

export interface RecordDecisionParams {
  left: string;
  right: string;
  verdict: Verdict;
  /** `user`, `agent:p-ag1`, `ml:entity_name`, `code:cross_source` … */
  decidedBy: string;
  reason?: string | null;
}

/**
 * Store a verdict about a pair. A `user` verdict is final: automation may not
 * overwrite it, at any confidence, ever. That is the whole of G-051..054 —
 * "actor:user outranks automation" is enforced here, not in the caller.
 */
export function recordDecision(params: RecordDecisionParams): DecisionRow {
  const [left, right] = orderPair(params.left, params.right);
  const existing = readDecision(left, right);
  if (existing) {
    const userLocked = existing.decidedBy === "user" && params.decidedBy !== "user";
    if (userLocked) return existing;
    getDb()
      .prepare(`UPDATE resolution_decisions SET verdict = ?, decided_by = ?, reason = ? WHERE id = ?`)
      .run(params.verdict, params.decidedBy, params.reason ?? null, existing.id);
    return readDecision(left, right)!;
  }
  const id = mintId("res");
  getDb()
    .prepare(
      `INSERT INTO resolution_decisions (id, left_id, right_id, verdict, decided_by, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, left, right, params.verdict, params.decidedBy, params.reason ?? null);
  return readDecision(left, right)!;
}

export function readDecision(a: string, b: string): DecisionRow | null {
  const [left, right] = orderPair(a, b);
  const row = getDb()
    .prepare(
      `SELECT id, left_id, right_id, verdict, decided_by, reason FROM resolution_decisions
        WHERE left_id = ? AND right_id = ?`,
    )
    .get(left, right) as
    | { id: string; left_id: string; right_id: string; verdict: string; decided_by: string | null; reason: string | null }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    leftId: row.left_id,
    rightId: row.right_id,
    verdict: row.verdict as Verdict,
    decidedBy: row.decided_by,
    reason: row.reason,
  };
}

/** A stored `different`. Permanent, and never re-proposed by anything. */
export function isNegativePair(a: string, b: string): boolean {
  return readDecision(a, b)?.verdict === "different";
}

/** May automation even ASK about this pair? No, once somebody has said no. */
export function mayPropose(a: string, b: string): boolean {
  return !isNegativePair(a, b);
}

export function listDecisions(verdict?: Verdict): DecisionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, left_id, right_id, verdict, decided_by, reason FROM resolution_decisions
        ${verdict ? "WHERE verdict = ?" : ""} ORDER BY left_id, right_id`,
    )
    .all(...(verdict ? [verdict] : [])) as {
    id: string;
    left_id: string;
    right_id: string;
    verdict: string;
    decided_by: string | null;
    reason: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    leftId: r.left_id,
    rightId: r.right_id,
    verdict: r.verdict as Verdict,
    decidedBy: r.decided_by,
    reason: r.reason,
  }));
}

// ---- the resolution queue --------------------------------------------------

export interface QueueParams {
  left: string;
  right: string;
  question: string;
  options?: readonly string[];
  /** `ml:in_band`, `agent:p-ag1:unsure`, `code:calib_absent` … */
  reason: string;
}

/**
 * An in-band pair, an `unsure` agent verdict, or a similarity rung that is
 * disabled for want of calibration. All three end here: a question for the
 * human. Nothing auto-retries out of this queue — that is what made it a
 * question in the first place.
 */
export function queueResolution(params: QueueParams): string {
  const [left, right] = orderPair(params.left, params.right);
  const id = mintId("qst");
  getDb()
    .prepare(
      `INSERT INTO questions (id, kind, target_kind, target_id, question, options_json, status)
       VALUES (?, 'identity', 'entity_pair', ?, ?, ?, 'open')`,
    )
    .run(id, `${left}|${right}`, params.question, JSON.stringify(params.options ?? [left, right, "different"]));
  recordDecision({ left, right, verdict: "unsure", decidedBy: params.reason, reason: params.reason });
  return id;
}

export function openResolutionQuestions(): { id: string; targetId: string; question: string }[] {
  return (
    getDb()
      .prepare(
        `SELECT id, target_id, question FROM questions
          WHERE kind = 'identity' AND status = 'open' ORDER BY asked_at, id`,
      )
      .all() as { id: string; target_id: string; question: string }[]
  ).map((r) => ({ id: r.id, targetId: r.target_id, question: r.question }));
}

// ---- merge and split -------------------------------------------------------

export interface MergeParams {
  /** The entity that becomes a tombstone. */
  loser: string;
  /** The entity that survives. */
  winner: string;
  actor: string;
  runId?: string | null;
  reason?: string | null;
}

export interface MergeResult {
  merged: boolean;
  winner: string;
  loser: string;
  /** Set when the merge was refused, naming the rule that refused it. */
  refused?: "negative_pair" | "same_entity" | "missing";
}

export function mergeEntities(params: MergeParams): MergeResult {
  const winner = resolveEntityId(params.winner);
  const loser = resolveEntityId(params.loser);
  if (!winner || !loser) {
    return { merged: false, winner: params.winner, loser: params.loser, refused: "missing" };
  }
  if (winner === loser) return { merged: false, winner, loser, refused: "same_entity" };

  // A stored `different` is permanent. Even the user does not merge through it
  // by accident: they have to record the reversing verdict first, which is a
  // deliberate act and leaves its own row.
  if (isNegativePair(loser, winner)) {
    return { merged: false, winner, loser, refused: "negative_pair" };
  }

  const db = getDb();
  db.prepare(`UPDATE entities SET merged_into = ? WHERE id = ?`).run(winner, loser);
  // Keep chains one hop deep so `resolveEntityId` stays a single lookup for
  // every id anybody actually holds.
  db.prepare(`UPDATE entities SET merged_into = ? WHERE merged_into = ?`).run(winner, loser);

  logMutation({
    actor: params.actor,
    runId: params.runId ?? null,
    targetKind: "entity",
    targetId: loser,
    field: "merged_into",
    oldValue: null,
    newValue: winner,
    reason: params.reason ?? null,
  });
  recordDecision({
    left: loser,
    right: winner,
    verdict: "same",
    decidedBy: params.actor,
    reason: params.reason ?? null,
  });
  return { merged: true, winner, loser };
}

export interface SplitParams {
  /** The tombstone to bring back. */
  entityId: string;
  actor: string;
  runId?: string | null;
  reason?: string | null;
}

export interface SplitResult {
  split: boolean;
  restored: string;
  from: string | null;
  /** Identity rows re-pointed back onto the restored entity by compaction undo. */
  identitiesRestored: number;
}

/**
 * Undo a merge. The tombstone's `merged_into` clears and both entities are live
 * again. If reconcile had already compacted the merge, the identities it moved
 * are moved back — BY SOURCE IDENTITY, which is the only key that says which
 * side a row came from once the names are gone.
 */
export function splitEntity(params: SplitParams): SplitResult {
  const row = readEntityRaw(params.entityId);
  if (!row || row.mergedInto === null) {
    return { split: false, restored: params.entityId, from: row?.mergedInto ?? null, identitiesRestored: 0 };
  }
  const winner = resolveEntityId(row.mergedInto);
  const db = getDb();
  db.prepare(`UPDATE entities SET merged_into = NULL WHERE id = ?`).run(row.id);

  // Compaction, if it ran, recorded every row it moved. Move those back.
  let restored = 0;
  if (winner) {
    for (const m of mutationsFor("entity_identity", row.id)) {
      if (m.field !== "entity_id") continue;
      const from = (m.oldValue as { entityId?: string } | null)?.entityId;
      const sourceId = (m.oldValue as { sourceId?: string | null } | null)?.sourceId ?? null;
      if (from !== row.id) continue;
      restored += repointIdentitiesOfSource(winner, row.id, sourceId);
    }
  }

  logMutation({
    actor: params.actor,
    runId: params.runId ?? null,
    targetKind: "entity",
    targetId: row.id,
    field: "merged_into",
    oldValue: row.mergedInto,
    newValue: null,
    reason: params.reason ?? "split",
  });
  if (winner) {
    recordDecision({
      left: row.id,
      right: winner,
      verdict: "different",
      decidedBy: params.actor,
      reason: params.reason ?? "split",
    });
  }
  return { split: true, restored: row.id, from: winner, identitiesRestored: restored };
}

/**
 * Reconcile's nightly compaction: move the loser's rows onto the winner so the
 * redirect stops costing a join. Every move is logged, which is what keeps the
 * split above possible afterwards.
 */
export function compactMerges(actor = "code:reconcile"): number {
  const db = getDb();
  const tombstones = db
    .prepare(`SELECT id, merged_into FROM entities WHERE merged_into IS NOT NULL`)
    .all() as { id: string; merged_into: string }[];
  let compacted = 0;
  for (const t of tombstones) {
    const winner = resolveEntityId(t.merged_into);
    if (!winner) continue;
    const sources = db
      .prepare(`SELECT DISTINCT source_id FROM entity_identities WHERE entity_id = ?`)
      .all(t.id) as { source_id: string | null }[];
    for (const s of sources) {
      logMutation({
        actor,
        targetKind: "entity_identity",
        targetId: t.id,
        field: "entity_id",
        oldValue: { entityId: t.id, sourceId: s.source_id },
        newValue: { entityId: winner },
        reason: "merge compaction",
      });
    }
    const moved = repointIdentities(t.id, winner);
    repointEdges(t.id, winner);
    db.prepare(`UPDATE mentions SET entity_id = ? WHERE entity_id = ?`).run(winner, t.id);
    if (moved > 0 || sources.length > 0) compacted += 1;
  }
  return compacted;
}

/** How many live ids currently redirect into this one. */
export function tombstoneCount(entityId: string): number {
  return Math.max(0, mergedAliasIds(entityId).length - 1);
}
