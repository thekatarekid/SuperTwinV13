// ===========================================================================
// Space-activation sweep (build P1.5, spec §9.2).
//
// When a space becomes active (approved proposal, or user-created), retrieval
// over UNSORTED + THE LOG pulls related past episodes in — including the very
// message that justified creation. Candidates go to one Orient-style review
// call (prompts/sweep-review.v1); code applies the answers:
//
//   confidence ≥ 0.75          attach (episode → space, unsorted row claimed)
//   0.60 ≤ confidence < 0.75   attach + second_look row (re-verified at T2)
//   below / attach=false       leave alone — unsorted is a good answer
//
// Every attach is a decisions row with the old state (reversible), and the
// sweep itself leaves a marker decision on the space so a second activation
// of unchanged state does nothing (CON-08).
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { runJsonPass, type JsonPassDeps } from "../brain/llm.js";
import { packEpisode, packSpaceState } from "../brain/thin-pack.js";
import {
  SWEEP_REVIEW_V1_SYSTEM,
  validateSweepReviewOutput,
  type SweepReviewOutput,
} from "../prompts/sweep-review.v1.js";

export const ATTACH_FLOOR = 0.75;
export const SECOND_LOOK_FLOOR = 0.6;
/** Candidate cap per sweep — one review call, bounded input. */
export const SWEEP_CANDIDATE_CAP = 40;
/**
 * Seats inside that cap that the LOG half may always claim (V6 P1 S6e · E2).
 *
 * Both halves used to compete for the same 40, with unsorted taking its LIMIT
 * first — so on any home with 40 or more open unsorted rows the label-matched
 * FTS hits were appended to a list that was already full and then sliced away.
 * On a fresh install that never shows: there is nothing in unsorted yet. On
 * the user's install there are 395, and every one of them is newer than the
 * episodes a restored space was founded on — so the sweep for that space would
 * have been offered forty promotional messages and NOT the two episodes whose
 * text names it. The half that answers "does this belong to THIS space" cannot
 * be the half that gets crowded out.
 */
export const SWEEP_LOG_RESERVE = 16;

export interface SweepReport {
  spaceId: string;
  swept: boolean; // false = marker already present, nothing ran
  candidates: number;
  attached: number;
  secondLook: number;
  runIds: string[];
}

/** Has an unreversed sweep marker already been left on this space? */
export function sweepDone(spaceId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT id FROM decisions
        WHERE target_kind = 'space' AND target_id = ? AND action = 'sweep'
          AND reversed_at IS NULL
        LIMIT 1`,
    )
    .get(spaceId) as { id: string } | undefined;
  return row !== undefined;
}

/** FTS terms from a space's label + goal — quoted, OR-joined, injection-safe. */
function ftsQueryFor(label: string, goal: string | null): string | null {
  const words = `${label} ${goal ?? ""}`
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);
  if (words.length === 0) return null;
  return [...new Set(words)].map((w) => `"${w}"`).join(" OR ");
}

/**
 * Unsorted episodes (open first, then the 30-day archived ones — "still
 * sweepable when a space is finally born", Product_V6 §11.10) + log retrieval
 * over spaceless episodes.
 */
export function sweepCandidates(spaceId: string): string[] {
  const space = getDb().prepare(`SELECT label, goal FROM spaces WHERE id = ?`).get(spaceId) as
    | { label: string; goal: string | null }
    | undefined;
  if (!space) return [];
  return sweepCandidatesFor(space.label, space.goal);
}

/**
 * The same retrieval, addressed by label + goal instead of by a space row, so
 * a caller can price a sweep for a space that does not exist yet (V6 P1 S6e ·
 * E2: the existing-home repair previews what restoring a discarded proposal
 * would offer, before it writes anything). One query set, one answer — the
 * repair must never grow a second idea of what "related" means.
 */
export function sweepCandidatesFor(label: string, goal: string | null): string[] {
  const db = getDb();
  // The LOG half first, so the seats it needs are known before unsorted asks
  // for the rest. Nothing about the ORDER of the returned list changes —
  // unsorted still leads — only how the cap is shared.
  const matched: string[] = [];
  const match = ftsQueryFor(label, goal);
  if (match !== null) {
    try {
      const hits = db
        .prepare(
          `SELECT DISTINCT ee.episode_id
             FROM events_fts f
             JOIN events e   ON e.rowid = f.rowid
             JOIN episode_events ee
                  ON ee.start_rowid IS NOT NULL AND ee.end_rowid IS NOT NULL
                 AND e.rowid BETWEEN ee.start_rowid AND ee.end_rowid
             JOIN episodes ep ON ep.id = ee.episode_id AND ep.space_id IS NULL
            WHERE events_fts MATCH ?
            LIMIT ?`,
        )
        .all(match, SWEEP_LOG_RESERVE) as { episode_id: string }[];
      for (const r of hits) matched.push(r.episode_id);
    } catch {
      // A pathological FTS query must not kill the sweep; unsorted still runs.
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const unsorted = db
    .prepare(
      `SELECT u.episode_id FROM unsorted u
        JOIN episodes e ON e.id = u.episode_id
        WHERE u.status IN ('open','archived') AND e.space_id IS NULL
        ORDER BY (u.status = 'open') DESC, u.created_at DESC LIMIT ?`,
    )
    .all(SWEEP_CANDIDATE_CAP - matched.length) as { episode_id: string }[];
  for (const r of unsorted) {
    if (!seen.has(r.episode_id)) {
      seen.add(r.episode_id);
      out.push(r.episode_id);
    }
  }
  for (const id of matched) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out.slice(0, SWEEP_CANDIDATE_CAP);
}

/** Attach one episode to the space — decision row with the old state. */
export function attachEpisode(
  spaceId: string,
  episodeId: string,
  confidence: number,
  reason: string | null,
  runId: string | null,
  pass = "sweep",
): boolean {
  const db = getDb();
  const ep = db.prepare(`SELECT space_id FROM episodes WHERE id = ?`).get(episodeId) as
    | { space_id: string | null }
    | undefined;
  if (!ep || ep.space_id === spaceId) return false; // gone or already attached
  db.prepare(
    `UPDATE episodes SET space_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  ).run(spaceId, episodeId);
  db.prepare(
    `UPDATE unsorted
        SET status = 'claimed', claimed_by_space_id = ?,
            resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE episode_id = ? AND status IN ('open','archived')`,
  ).run(spaceId, episodeId);
  writeDecision({
    runId,
    pass,
    targetKind: "episode",
    targetId: episodeId,
    action: "attach",
    old: { spaceId: ep.space_id },
    new: { spaceId },
    reason,
    confidence,
  });
  return true;
}

function queueSecondLook(episodeId: string, spaceId: string, confidence: number): void {
  getDb()
    .prepare(
      `INSERT INTO second_look (id, episode_id, space_id, attach_confidence)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (episode_id, space_id) DO NOTHING`,
    )
    .run(`sl_${randomBytes(9).toString("hex")}`, episodeId, spaceId, confidence);
}

/**
 * The sweep. Runs at most once per activation (marker decision); re-run after
 * an undo by reversing the marker. LLM transport injectable via deps.
 */
export async function sweepSpaceOnActivation(
  spaceId: string,
  deps: JsonPassDeps = {},
): Promise<SweepReport> {
  const report: SweepReport = {
    spaceId,
    swept: false,
    candidates: 0,
    attached: 0,
    secondLook: 0,
    runIds: [],
  };
  if (sweepDone(spaceId)) return report;
  const space = packSpaceState(spaceId);
  if (!space || space.status !== "active") return report;

  const candidates = sweepCandidates(spaceId);
  report.candidates = candidates.length;
  report.swept = true;

  let review: SweepReviewOutput | undefined;
  if (candidates.length > 0) {
    const packedCandidates = candidates
      .map((id) => packEpisode(id))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const user = [
      space.text,
      "",
      "CANDIDATE EPISODES (unsorted + log retrieval):",
      ...packedCandidates.map((p) => p.text),
    ].join("\n\n");
    const result = await runJsonPass<SweepReviewOutput>(
      {
        pass: "sweep",
        system: SWEEP_REVIEW_V1_SYSTEM,
        user,
        role: "consolidate",
        cohortId: null,
        unit: { kind: "sweep_space", id: spaceId },
        validate: validateSweepReviewOutput,
      },
      deps,
    );
    report.runIds = result.runIds;
    review = result.output;
  }

  const runId = report.runIds.length > 0 ? report.runIds[report.runIds.length - 1] : null;
  const allowed = new Set(candidates);
  for (const a of review?.attachments ?? []) {
    if (!allowed.has(a.episode)) continue; // only episodes we actually offered
    if (!a.attach || a.confidence < SECOND_LOOK_FLOOR) continue;
    if (attachEpisode(spaceId, a.episode, a.confidence, a.reason ?? null, runId)) {
      report.attached += 1;
      if (a.confidence < ATTACH_FLOOR) {
        queueSecondLook(a.episode, spaceId, a.confidence);
        report.secondLook += 1;
      }
    }
  }

  writeDecision({
    runId,
    pass: "sweep",
    targetKind: "space",
    targetId: spaceId,
    action: "sweep",
    old: null,
    new: { candidates: report.candidates, attached: report.attached, secondLook: report.secondLook },
    reason: "space-activation sweep over unsorted + log",
  });
  return report;
}

/** Active spaces that have never been swept — the job's work list. */
export function unsweptActiveSpaces(limit = 8): string[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id FROM spaces s
        WHERE s.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM decisions d
             WHERE d.target_kind = 'space' AND d.target_id = s.id
               AND d.action = 'sweep' AND d.reversed_at IS NULL)
        ORDER BY s.updated_at DESC, s.created_at DESC
        LIMIT ?`,
    )
    .all(limit) as { id: string }[];
  return rows.map((r) => r.id);
}
