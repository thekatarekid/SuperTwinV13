// ===========================================================================
// Unsorted — the weekly review, on change only (V6 P1 S5.1; Product_V6_Phase1
// §9.6 / §13; Product_V6 §11.10 "Unsorted is not a grave").
//
// Episodes with no space wait in `unsorted`. They are re-reviewed
//   * at every space birth — the activation sweep (consolidation/sweep.ts),
//   * weekly, ONLY when anything new landed there since the last review
//     (SPC-07: an unchanged unsorted is not re-read — zero calls),
// and archive after 30 days (consolidation/t2.ts reviewUnsorted) — still
// searchable, still sweepable when a space is finally born.
//
// The weekly pass is a lookup before it is a call: `changedUnsortedSince()`
// counts rows written since `unsorted.last_review_at`; zero means the pass
// returns without touching a provider. When something did land, each ACTIVE
// space gets at most one sweep-review.v1 call over the changed rows whose
// events lexically match its label/goal — never every row against every
// space. Attaches go through the sweep's `attachEpisode` (a decisions row,
// reversible); below the floor the episode stays where it is.
// ===========================================================================

import { runJsonPass, type JsonPassDeps } from "../brain/llm.js";
import { packEpisode, packSpaceState } from "../brain/thin-pack.js";
import { ATTACH_FLOOR, SECOND_LOOK_FLOOR, attachEpisode } from "../consolidation/sweep.js";
import { getDb } from "../db/connection.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import {
  SWEEP_REVIEW_V1_SYSTEM,
  validateSweepReviewOutput,
  type SweepReviewOutput,
} from "../prompts/sweep-review.v1.js";

/** app_state: ISO instant of the last weekly review (the change watermark). */
export const UNSORTED_LAST_REVIEW_KEY = "unsorted.last_review_at";
/** The weekly cadence. */
export const UNSORTED_REVIEW_INTERVAL_MS = 7 * 86_400_000;
/** Candidate rows per space per review — one bounded call. */
export const UNSORTED_REVIEW_CAP = 30;
/** Changed unsorted rows scanned per space before the term filter. */
export const UNSORTED_SCAN_CAP = 200;

export interface UnsortedReviewReport {
  /** True when nothing landed in unsorted since the last review — no call. */
  skipped: boolean;
  changedRows: number;
  spacesReviewed: number;
  modelCalls: number;
  attached: number;
  runIds: string[];
  reviewedAt: string | null;
}

/** Rows created or resolved in `unsorted` after `since`. */
export function changedUnsortedSince(since: string | null): number {
  const db = getDb();
  if (since === null) {
    return (db.prepare(`SELECT COUNT(*) AS n FROM unsorted`).get() as { n: number }).n;
  }
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM unsorted
          WHERE created_at > ? OR (resolved_at IS NOT NULL AND resolved_at > ?)`,
      )
      .get(since, since) as { n: number }
  ).n;
}

/** Is the weekly review due? (never reviewed → due) */
export function unsortedReviewDue(now: Date = new Date()): boolean {
  const last = appStateGet(UNSORTED_LAST_REVIEW_KEY);
  if (last === null) return true;
  return now.getTime() - Date.parse(last) >= UNSORTED_REVIEW_INTERVAL_MS;
}

/** Words worth matching on — three letters or more, deduped, lowercased. */
function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3),
  );
}

/**
 * Open, still-spaceless unsorted episodes that landed after `since` and share
 * at least one term with the space's label/goal. Code only — the shortlist
 * that ONE bounded review call is allowed to look at, never every row against
 * every space.
 *
 * Matching is over the episode's own summary (what the review would be shown)
 * plus the text of its member events when the summary is missing, so an
 * episode is not skipped just because orient left it unsummarised.
 */
export function unsortedCandidatesFor(spaceId: string, since: string | null): string[] {
  const db = getDb();
  const space = db.prepare(`SELECT label, goal FROM spaces WHERE id = ?`).get(spaceId) as
    | { label: string; goal: string | null }
    | undefined;
  if (!space) return [];
  const wanted = terms(`${space.label} ${space.goal ?? ""}`);
  if (wanted.size === 0) return [];
  const rows = db
    .prepare(
      `SELECT u.episode_id AS id,
              COALESCE(ep.summary, '') AS summary,
              COALESCE((SELECT group_concat(e.text, ' ')
                          FROM episode_events ee
                          JOIN events e ON ee.start_rowid IS NOT NULL AND ee.end_rowid IS NOT NULL
                               AND e.rowid BETWEEN ee.start_rowid AND ee.end_rowid
                         WHERE ee.episode_id = ep.id), '') AS body
         FROM unsorted u
         JOIN episodes ep ON ep.id = u.episode_id AND ep.space_id IS NULL
        WHERE u.status = 'open'
          AND (? IS NULL OR u.created_at > ?)
        ORDER BY u.created_at DESC
        LIMIT ?`,
    )
    .all(since, since, UNSORTED_SCAN_CAP) as { id: string; summary: string; body: string }[];
  const out: string[] = [];
  for (const r of rows) {
    const have = terms(`${r.summary} ${r.body}`);
    if ([...wanted].some((w) => have.has(w))) out.push(r.id);
    if (out.length >= UNSORTED_REVIEW_CAP) break;
  }
  return out;
}

/**
 * The weekly review. `force` runs it even when the cadence says not yet (the
 * job calls with the cadence; tests and the ops surface may force). The
 * change check is never bypassed: unchanged unsorted → skipped, zero calls.
 */
export async function reviewUnsortedWeekly(
  deps: JsonPassDeps = {},
  opts: { now?: Date; force?: boolean } = {},
): Promise<UnsortedReviewReport> {
  const now = opts.now ?? new Date();
  const report: UnsortedReviewReport = {
    skipped: false,
    changedRows: 0,
    spacesReviewed: 0,
    modelCalls: 0,
    attached: 0,
    runIds: [],
    reviewedAt: null,
  };
  if (opts.force !== true && !unsortedReviewDue(now)) {
    report.skipped = true;
    return report;
  }
  const since = appStateGet(UNSORTED_LAST_REVIEW_KEY);
  report.changedRows = changedUnsortedSince(since);
  if (report.changedRows === 0) {
    // Nothing landed since the last review: the review is a no-op and the
    // watermark moves so the cadence restarts — no provider is touched.
    report.skipped = true;
    appStateSet(UNSORTED_LAST_REVIEW_KEY, now.toISOString());
    report.reviewedAt = now.toISOString();
    return report;
  }

  const db = getDb();
  const spaces = db
    .prepare(`SELECT id FROM spaces WHERE status = 'active' ORDER BY updated_at DESC, created_at DESC`)
    .all() as { id: string }[];
  for (const s of spaces) {
    const candidates = unsortedCandidatesFor(s.id, since);
    if (candidates.length === 0) continue;
    const card = packSpaceState(s.id);
    if (!card) continue;
    const packed = candidates
      .map((id) => packEpisode(id))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const result = await runJsonPass<SweepReviewOutput>(
      {
        pass: "unsorted-review",
        system: SWEEP_REVIEW_V1_SYSTEM,
        user: [card.text, "", "CANDIDATE EPISODES (unsorted, landed since the last review):", ...packed.map((p) => p.text)].join("\n\n"),
        role: "consolidate",
        cohortId: null,
        unit: { kind: "unsorted_review", id: s.id },
        validate: validateSweepReviewOutput,
      },
      deps,
    );
    report.spacesReviewed += 1;
    report.modelCalls += result.runIds.length > 0 ? result.runIds.length : result.responses.length;
    report.runIds.push(...result.runIds);
    const runId = result.runIds.length > 0 ? result.runIds[result.runIds.length - 1]! : null;
    const allowed = new Set(candidates);
    for (const a of result.output?.attachments ?? []) {
      if (!allowed.has(a.episode) || !a.attach || a.confidence < SECOND_LOOK_FLOOR) continue;
      if (a.confidence < ATTACH_FLOOR) continue; // the weekly pass has no second look — leave it
      if (attachEpisode(s.id, a.episode, a.confidence, a.reason ?? null, runId, "unsorted-review")) {
        report.attached += 1;
      }
    }
  }
  appStateSet(UNSORTED_LAST_REVIEW_KEY, now.toISOString());
  report.reviewedAt = now.toISOString();
  return report;
}
