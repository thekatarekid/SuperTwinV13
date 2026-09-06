// ===========================================================================
// T2 consolidation (build P1.5, spec §15.2; V6 P1 S3.9 — consolidation ON
// CHANGE, Product_V6 §11.4 item 8 / §23.6 item 4, P1 §10).
//
// Runs within minutes of a `flag_overlap` (the Critic writes t2_review_queue
// rows — 0102_content_economy); otherwise hourly, and ONLY over what changed:
// the roll first asks the database what was written since the last roll
// (events, episodes, spaces, claims, tasks, decisions, review queues). Nothing
// written → no model call, the roll is logged as a no-op (CON-01). Something
// written → merge/split over the touched spaces, second look over the pending
// rows. Dormancy and the unsorted review are clock work in code and never a
// call, so they still run.
//
// HARD GATES in code, never in the prompt:
//   false_auto_merge = 0   a judge verdict "merge" is NEVER applied by the
//                          machine. Every one becomes a merge QUESTION — a
//                          suggest_merge decision plus a questions row the
//                          review surface shows (CON-02: "a merge question,
//                          never a silent merge"). mergeSpaces() is the
//                          reversible apply path the user's answer takes.
//   splits NEVER auto-apply in P1: always suggest_split.
//   NOTHING DELETED (CON-03): a merge archives the loser and moves its
//                          objects; an old claim gets an end date (t3.ts).
//   IDEMPOTENT (IDEM-01):  every step checks current state first; a second
//                          run on identical state changes nothing.
//   REVERSIBLE: every mutation is a decisions row carrying the old state; a
//               merge's row lists every moved id.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { writeDecision, decisionsFor } from "../db/decisions.js";
import { reverseDecision } from "./reversal.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import { runJsonPass, type JsonPassDeps } from "../brain/llm.js";
import { packEpisode, packSpaceState } from "../brain/thin-pack.js";
import {
  validateConsolidateOutput,
  type ConsolidateVerdict,
} from "../prompts/consolidate.v1.js";
import { CONSOLIDATE_V3_SYSTEM } from "../prompts/consolidate.v3.js";
import {
  SWEEP_REVIEW_V1_SYSTEM,
  validateSweepReviewOutput,
  type SweepReviewOutput,
} from "../prompts/sweep-review.v1.js";
import { ATTACH_FLOOR } from "./sweep.js";

/**
 * Tables whose writes make an hourly roll worth running, with the column
 * that dates the write. A roll over a database with no row past the last
 * roll's watermark in any of these is a no-op (CON-01).
 */
export const T2_CHANGE_SOURCES: readonly { table: string; column: string; where?: string }[] = [
  { table: "events", column: "captured_at" },
  { table: "episodes", column: "COALESCE(updated_at, created_at)" },
  { table: "spaces", column: "COALESCE(updated_at, created_at)" },
  // A version the deep pass ended (t3.ts) is bookkeeping, not new knowledge.
  { table: "claim_versions", column: "COALESCE(updated_at, created_at)", where: "COALESCE(closed_by, '') != 'consolidate:t3'" },
  { table: "tasks", column: "COALESCE(updated_at, created_at)" },
  // Consolidation's own bookkeeping (dormancy, unsorted archive, T3) is not
  // change — otherwise every roll would wake the next one.
  { table: "decisions", column: "created_at", where: "COALESCE(pass, '') NOT IN ('consolidate', 'code:t3')" },
  { table: "t2_review_queue", column: "created_at" },
  { table: "second_look", column: "created_at" },
  { table: "unsorted", column: "created_at" },
];
/** Days without activity before an active space goes dormant. */
export const DORMANCY_DAYS = 30;
/** Days an unsorted episode stays open before the periodic review archives it. */
export const UNSORTED_ARCHIVE_DAYS = 30;
/** app_state key holding the last hourly-roll instant. */
export const T2_LAST_ROLL_KEY = "consolidation.t2_last_roll_at";
/** Pair-judge budget per run — T2 is scoped, not a full rescan. */
const PAIR_CAP = 6;

export interface T2Report {
  flagsProcessed: number;
  /** Always 0 since S3.9 — the machine never applies a merge (kept for the ops surface). */
  merged: number;
  mergeSuggestions: number;
  splitSuggestions: number;
  dormant: number;
  secondLookConfirmed: number;
  secondLookDetached: number;
  unsortedArchived: number;
  runIds: string[];
  /** True when the hourly roll found nothing written since the last roll and made no call. */
  rollSkipped: boolean;
  /** Rows written since the last roll, per T2_CHANGE_SOURCES (0 on a flags-only run). */
  changedRows: number;
  /** Judge calls this run made (pair judge + second look). */
  modelCalls: number;
}

function emptyReport(): T2Report {
  return {
    flagsProcessed: 0,
    merged: 0,
    mergeSuggestions: 0,
    splitSuggestions: 0,
    dormant: 0,
    secondLookConfirmed: 0,
    secondLookDetached: 0,
    unsortedArchived: 0,
    runIds: [],
    rollSkipped: false,
    changedRows: 0,
    modelCalls: 0,
  };
}

// ---------------------------------------------------------------------------
// The lookup before the call (Product_V6 §23.6 item 4)
// ---------------------------------------------------------------------------

/**
 * Rows written since `sinceIso` across T2_CHANGE_SOURCES. Code only, a few
 * indexed COUNTs — this is what makes the hourly roll skip outright when
 * nothing changed instead of scanning and then calling.
 */
export function changedRowsSince(sinceIso: string): number {
  const db = getDb();
  let n = 0;
  for (const src of T2_CHANGE_SOURCES) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${src.table} WHERE ${src.column} >= ?${src.where ? ` AND ${src.where}` : ""}`,
      )
      .get(sinceIso) as { n: number };
    n += row.n;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The pair judge
// ---------------------------------------------------------------------------

async function judgePair(
  aId: string,
  bId: string,
  deps: JsonPassDeps,
  report: T2Report,
): Promise<ConsolidateVerdict | undefined> {
  const a = packSpaceState(aId);
  const b = packSpaceState(bId);
  if (!a || !b) return undefined;
  const exemplarsOf = (spaceId: string): string[] => {
    const rows = getDb()
      .prepare(
        `SELECT id FROM episodes WHERE space_id = ? ORDER BY last_ts DESC, created_at DESC LIMIT 3`,
      )
      .all(spaceId) as { id: string }[];
    return rows
      .map((r) => packEpisode(r.id)?.text)
      .filter((t): t is string => typeof t === "string");
  };
  const user = [
    "SPACE A:",
    a.text,
    ...exemplarsOf(aId),
    "",
    "SPACE B:",
    b.text,
    ...exemplarsOf(bId),
  ].join("\n\n");
  const result = await runJsonPass<ConsolidateVerdict>(
    {
      pass: "consolidate",
      system: CONSOLIDATE_V3_SYSTEM,
      user,
      role: "consolidate",
      cohortId: null,
      unit: { kind: "t2_pair", id: `${aId}~${bId}` },
      validate: validateConsolidateOutput,
    },
    deps,
  );
  report.runIds.push(...result.runIds);
  report.modelCalls += 1;
  return result.output;
}

// ---------------------------------------------------------------------------
// Merge — evidenced, reversible, every moved id in the decision row
// ---------------------------------------------------------------------------

/**
 * Merge `loserId` into `survivorId`. Returns the decision id. NOT called by
 * the roll since S3.9 — this is the apply path for an ANSWERED merge question
 * (and the reversal suite's subject). Nothing is deleted: the loser is
 * archived, its episodes, chapters, tasks and claim refs move.
 */
export function mergeSpaces(survivorId: string, loserId: string, runId: string | null, reason: string | null, confidence: number | null): string | null {
  const db = getDb();
  const survivor = db.prepare(`SELECT id, status FROM spaces WHERE id = ?`).get(survivorId) as
    | { id: string; status: string }
    | undefined;
  const loser = db.prepare(`SELECT id, status, label FROM spaces WHERE id = ?`).get(loserId) as
    | { id: string; status: string; label: string }
    | undefined;
  if (!survivor || !loser || survivorId === loserId) return null;
  if (loser.status === "archived") return null; // already merged — idempotent

  const ids = (sql: string): string[] =>
    (db.prepare(sql).all(loserId) as { id: string }[]).map((r) => r.id);
  const movedEpisodes = ids(`SELECT id FROM episodes WHERE space_id = ?`);
  const movedChapters = ids(`SELECT id FROM chapters WHERE space_id = ?`);
  const movedTasks = ids(`SELECT id FROM tasks WHERE space_id = ?`);
  const movedClaims = (db.prepare(`SELECT claim_key FROM space_claims WHERE space_id = ?`).all(loserId) as {
    claim_key: string;
  }[]).map((r) => r.claim_key);

  const apply = db.transaction(() => {
    db.prepare(`UPDATE episodes SET space_id = ? WHERE space_id = ?`).run(survivorId, loserId);
    db.prepare(`UPDATE chapters SET space_id = ? WHERE space_id = ?`).run(survivorId, loserId);
    db.prepare(`UPDATE tasks SET space_id = ? WHERE space_id = ?`).run(survivorId, loserId);
    db.prepare(
      `INSERT OR IGNORE INTO space_claims (space_id, claim_key, added_by)
       SELECT ?, claim_key, 'consolidate' FROM space_claims WHERE space_id = ?`,
    ).run(survivorId, loserId);
    db.prepare(`DELETE FROM space_claims WHERE space_id = ?`).run(loserId);
    db.prepare(`UPDATE unsorted SET claimed_by_space_id = ? WHERE claimed_by_space_id = ?`).run(
      survivorId,
      loserId,
    );
    db.prepare(
      `UPDATE spaces SET status = 'archived',
              archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run(loserId);
  });
  apply();

  return writeDecision({
    runId,
    pass: "consolidate",
    targetKind: "space",
    targetId: loserId,
    action: "merge",
    old: { status: loser.status, movedEpisodes, movedChapters, movedTasks, movedClaims },
    new: { mergedInto: survivorId },
    reason,
    confidence,
  });
}

/** Deterministic id: one open merge question per unordered pair. */
export function mergeQuestionId(aId: string, bId: string): string {
  return `q_merge_${[aId, bId].sort().join("~")}`.slice(0, 120);
}

/**
 * Raise the merge question: a `suggest_merge` decision (the review queue's
 * unit) plus an open `questions` row (the surface the user answers). Both
 * idempotent — an open question for the pair is not asked twice. Returns true
 * when a new question was raised.
 */
export function askMerge(
  survivorId: string,
  loserId: string,
  runId: string | null,
  reason: string | null,
  confidence: number | null,
): boolean {
  const db = getDb();
  const qid = mergeQuestionId(survivorId, loserId);
  const open = db.prepare(`SELECT 1 FROM questions WHERE id = ? AND status = 'open'`).get(qid);
  if (open) return false;
  const labelOf = (id: string): string =>
    (db.prepare(`SELECT label FROM spaces WHERE id = ?`).get(id) as { label: string } | undefined)?.label ?? id;
  const ask = db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO questions (id, kind, target_kind, target_id, question, options_json, status)
       VALUES (?, 'merge', 'space', ?, ?, ?, 'open')`,
    ).run(
      qid,
      loserId,
      `Are "${labelOf(loserId)}" and "${labelOf(survivorId)}" the same thing? Merge them?`,
      JSON.stringify([
        { id: "merge", label: `Merge into "${labelOf(survivorId)}"`, survivor: survivorId, loser: loserId },
        { id: "keep", label: "Keep both" },
      ]),
    );
    writeDecision({
      runId,
      pass: "consolidate",
      targetKind: "space",
      targetId: loserId,
      action: "suggest_merge",
      old: null,
      new: { mergeInto: survivorId, questionId: qid },
      reason,
      confidence,
    });
  });
  ask();
  return true;
}

async function reviewPair(
  aId: string,
  bId: string,
  deps: JsonPassDeps,
  report: T2Report,
): Promise<void> {
  const verdict = await judgePair(aId, bId, deps, report);
  if (verdict === undefined) return;
  const runId = report.runIds.length > 0 ? report.runIds[report.runIds.length - 1] : null;
  if (verdict.verdict === "merge") {
    const survivor = verdict.survivor === bId ? bId : aId;
    const loser = survivor === aId ? bId : aId;
    // CON-02: a merge is a QUESTION, whatever the confidence. Never silent.
    if (askMerge(survivor, loser, runId, verdict.reason, verdict.confidence)) report.mergeSuggestions += 1;
  } else if (verdict.verdict === "split") {
    const target = verdict.splitSpace === bId ? bId : aId;
    writeDecision({
      runId,
      pass: "consolidate",
      targetKind: "space",
      targetId: target,
      action: "suggest_split",
      old: null,
      new: null,
      reason: verdict.reason,
      confidence: verdict.confidence,
    });
    report.splitSuggestions += 1;
  }
}

// ---------------------------------------------------------------------------
// Flags (t2_review_queue — the Critic's flag_overlap lands here)
// ---------------------------------------------------------------------------

async function processFlags(deps: JsonPassDeps, report: T2Report): Promise<void> {
  const db = getDb();
  const flags = db
    .prepare(
      `SELECT id, space_id, overlap_space_id FROM t2_review_queue
        WHERE status = 'pending' ORDER BY created_at LIMIT ?`,
    )
    .all(PAIR_CAP) as { id: string; space_id: string | null; overlap_space_id: string | null }[];
  const judged = new Set<string>();
  for (const flag of flags) {
    if (flag.space_id !== null && flag.overlap_space_id !== null) {
      const key = [flag.space_id, flag.overlap_space_id].sort().join("~");
      if (!judged.has(key)) {
        judged.add(key);
        await reviewPair(flag.space_id, flag.overlap_space_id, deps, report);
      }
    }
    db.prepare(
      `UPDATE t2_review_queue
          SET status = 'done', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND status = 'pending'`,
    ).run(flag.id);
    report.flagsProcessed += 1;
  }
}

// ---------------------------------------------------------------------------
// Rolling merge scan over touched spaces
// ---------------------------------------------------------------------------

function touchedSpacesSince(sinceIso: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT id FROM (
         SELECT target_id AS id FROM decisions
          WHERE target_kind = 'space' AND created_at >= ?
         UNION
         SELECT space_id AS id FROM episodes
          WHERE space_id IS NOT NULL AND (created_at >= ? OR updated_at >= ?)
       )`,
    )
    .all(sinceIso, sinceIso, sinceIso) as { id: string }[];
  return rows.map((r) => r.id);
}

async function rollingMergeScan(
  sinceIso: string,
  deps: JsonPassDeps,
  report: T2Report,
): Promise<void> {
  const db = getDb();
  const touched = touchedSpacesSince(sinceIso);
  if (touched.length === 0) return;
  let budget = PAIR_CAP;
  const judged = new Set<string>();
  for (const spaceId of touched) {
    if (budget <= 0) break;
    const me = db
      .prepare(`SELECT id, label, status FROM spaces WHERE id = ? AND status IN ('active','dormant')`)
      .get(spaceId) as { id: string; label: string; status: string } | undefined;
    if (!me) continue;
    // Overlap candidates: another live space sharing a normalised label word
    // set is the cheap-but-honest P1 signal; the judge decides.
    const twins = db
      .prepare(
        `SELECT id FROM spaces
          WHERE id != ? AND status IN ('active','dormant')
            AND LOWER(label) = LOWER(?)
          LIMIT 2`,
      )
      .all(spaceId, me.label) as { id: string }[];
    for (const twin of twins) {
      const key = [spaceId, twin.id].sort().join("~");
      if (judged.has(key) || budget <= 0) continue;
      judged.add(key);
      budget -= 1;
      await reviewPair(spaceId, twin.id, deps, report);
    }
  }
}

// ---------------------------------------------------------------------------
// Dormancy — code-only, idempotent, reversible
// ---------------------------------------------------------------------------

export function applyDormancy(now: Date, report: T2Report): void {
  const db = getDb();
  const cutoff = new Date(now.getTime() - DORMANCY_DAYS * 86_400_000).toISOString();
  const stale = db
    .prepare(
      `SELECT s.id, s.status FROM spaces s
        WHERE s.status = 'active'
          AND COALESCE((SELECT MAX(COALESCE(e.last_ts, e.created_at)) FROM episodes e WHERE e.space_id = s.id),
                       COALESCE(s.updated_at, s.created_at)) < ?`,
    )
    .all(cutoff) as { id: string; status: string }[];
  for (const s of stale) {
    db.prepare(
      `UPDATE spaces SET status = 'dormant', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND status = 'active'`,
    ).run(s.id);
    writeDecision({
      pass: "consolidate",
      targetKind: "space",
      targetId: s.id,
      action: "dormant",
      old: { status: "active" },
      new: { status: "dormant" },
      reason: `no activity for ${DORMANCY_DAYS} days`,
    });
    report.dormant += 1;
  }
}

// ---------------------------------------------------------------------------
// Second-look processing (spec §9.5): re-verify 0.60–0.75 attaches
// ---------------------------------------------------------------------------

/** Detach = REVERSE the original attach: restore, mark the decision reversed. */
function detachEpisode(episodeId: string, spaceId: string, runId: string | null): void {
  const db = getDb();
  const ep = db.prepare(`SELECT space_id FROM episodes WHERE id = ?`).get(episodeId) as
    | { space_id: string | null }
    | undefined;
  if (!ep || ep.space_id !== spaceId) return; // moved since — nothing to undo
  // The attach was a decision: reverse IT (restores the pre-attach space) —
  // the mutation-log undo path, exercised here in production. An attach that
  // predates decision rows (or was code-made) falls back to a direct restore.
  const attach = decisionsFor("episode", episodeId).find(
    (d) => d.action === "attach" && d.reversedAt === null,
  );
  const reversed = attach !== undefined && reverseDecision(attach, "consolidate:second_look");
  if (!reversed) {
    db.prepare(
      `UPDATE episodes SET space_id = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).run(episodeId);
  }
  db.prepare(
    `UPDATE episodes SET chapter_id = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND space_id IS NULL`,
  ).run(episodeId);
  // Only an episode that landed spaceless goes (back) to unsorted; a reversal
  // that restored a PREVIOUS space keeps it there.
  const after = db.prepare(`SELECT space_id FROM episodes WHERE id = ?`).get(episodeId) as
    | { space_id: string | null }
    | undefined;
  if (after !== undefined && after.space_id === null) {
    const reopened = db
      .prepare(
        `UPDATE unsorted SET status = 'open', claimed_by_space_id = NULL, resolved_at = NULL
          WHERE episode_id = ?`,
      )
      .run(episodeId);
    if (reopened.changes === 0) {
      db.prepare(
        `INSERT OR IGNORE INTO unsorted (id, episode_id, reason, status)
         VALUES (?, ?, 'second_look detach', 'open')`,
      ).run(`uns_${episodeId.slice(0, 24)}`, episodeId);
    }
  }
  writeDecision({
    runId,
    pass: "consolidate",
    targetKind: "episode",
    targetId: episodeId,
    action: "detach",
    old: { spaceId },
    new: { spaceId: null },
    reason: "second look did not confirm the attach",
  });
}

async function processSecondLook(deps: JsonPassDeps, report: T2Report): Promise<void> {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT id, episode_id, space_id, attach_confidence FROM second_look
        WHERE status = 'pending' ORDER BY created_at LIMIT 20`,
    )
    .all() as { id: string; episode_id: string; space_id: string; attach_confidence: number }[];
  if (pending.length === 0) return;

  const bySpace = new Map<string, typeof pending>();
  for (const row of pending) {
    const list = bySpace.get(row.space_id) ?? [];
    list.push(row);
    bySpace.set(row.space_id, list);
  }

  for (const [spaceId, rows] of bySpace) {
    const space = packSpaceState(spaceId);
    if (!space) {
      // Space is gone — the attach cannot stand; detach every row.
      for (const row of rows) {
        db.prepare(
          `UPDATE second_look SET status = 'detached',
                  resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ? AND status = 'pending'`,
        ).run(row.id);
        detachEpisode(row.episode_id, spaceId, null);
        report.secondLookDetached += 1;
      }
      continue;
    }
    const packed = rows
      .map((r) => packEpisode(r.episode_id))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const user = [
      space.text,
      "",
      "CANDIDATE EPISODES (second look — previously attached at 0.60-0.75):",
      ...packed.map((p) => p.text),
    ].join("\n\n");
    const result = await runJsonPass<SweepReviewOutput>(
      {
        pass: "sweep",
        system: SWEEP_REVIEW_V1_SYSTEM,
        user,
        role: "consolidate",
        cohortId: null,
        unit: { kind: "second_look_space", id: spaceId },
        validate: validateSweepReviewOutput,
      },
      deps,
    );
    report.runIds.push(...result.runIds);
    report.modelCalls += 1;
    if (result.output === undefined) continue; // quarantined — rows stay pending
    const runId = result.runIds.length > 0 ? result.runIds[result.runIds.length - 1] : null;
    const verdictByEpisode = new Map(result.output.attachments.map((a) => [a.episode, a]));
    for (const row of rows) {
      const verdict = verdictByEpisode.get(row.episode_id);
      if (verdict === undefined) continue; // unanswered — stays pending
      const confirmed = verdict.attach && verdict.confidence >= ATTACH_FLOOR;
      db.prepare(
        `UPDATE second_look SET status = ?,
                resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'pending'`,
      ).run(confirmed ? "confirmed" : "detached", row.id);
      if (confirmed) {
        report.secondLookConfirmed += 1;
      } else {
        detachEpisode(row.episode_id, spaceId, runId);
        report.secondLookDetached += 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Unsorted periodic review — 30 days unclaimed → archived (still searchable)
// ---------------------------------------------------------------------------

export function reviewUnsorted(now: Date, report: T2Report): void {
  const db = getDb();
  const cutoff = new Date(now.getTime() - UNSORTED_ARCHIVE_DAYS * 86_400_000).toISOString();
  const stale = db
    .prepare(`SELECT id FROM unsorted WHERE status = 'open' AND created_at < ?`)
    .all(cutoff) as { id: string }[];
  for (const row of stale) {
    db.prepare(
      `UPDATE unsorted SET status = 'archived',
              resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND status = 'open'`,
    ).run(row.id);
    writeDecision({
      pass: "consolidate",
      targetKind: "unsorted",
      targetId: row.id,
      action: "archive",
      old: { status: "open" },
      new: { status: "archived" },
      reason: `unclaimed for ${UNSORTED_ARCHIVE_DAYS} days (still searchable, still sweepable)`,
    });
    report.unsortedArchived += 1;
  }
}

// ---------------------------------------------------------------------------
// The T2 run
// ---------------------------------------------------------------------------

export interface T2Options {
  /** Flag-triggered mode: only the review queue, skip the hourly roll. */
  flagsOnly?: boolean;
  now?: Date;
}

/**
 * One T2 pass. Safe to re-run: identical state in, zero changes out.
 *
 * The hourly roll is a lookup before it is a call: with no row written since
 * the last roll it skips the judge entirely (`rollSkipped`, zero model calls)
 * and only the clock-driven code steps (dormancy, unsorted review) run.
 */
export async function runT2(deps: JsonPassDeps = {}, opts: T2Options = {}): Promise<T2Report> {
  const report = emptyReport();
  const now = opts.now ?? new Date();
  await processFlags(deps, report);
  if (opts.flagsOnly === true) return report;

  const since =
    appStateGet(T2_LAST_ROLL_KEY) ?? new Date(now.getTime() - 3_600_000).toISOString();
  report.changedRows = changedRowsSince(since);
  if (report.changedRows > 0) {
    await rollingMergeScan(since, deps, report);
    await processSecondLook(deps, report);
  } else {
    report.rollSkipped = true; // nothing written since the last roll — no call (CON-01)
  }
  applyDormancy(now, report);
  reviewUnsorted(now, report);
  appStateSet(T2_LAST_ROLL_KEY, now.toISOString());
  return report;
}
