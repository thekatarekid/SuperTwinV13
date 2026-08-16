// ===========================================================================
// [CODE] Episode aging — arch §11.1 rule 5, build item 2.1.
//
//     "Aging: open episode quiet 14 days → closed/faded [CODE]. A topic
//      returning later is a NEW episode bound to the same arc."
//
// Two consequences the rest of the system leans on:
//
//   * The candidate set stays small and honest. P-EP2 is only ever offered
//     episodes that are still live in that stream (§11.1 rule 3, "candidate
//     sets stay at 5–10 real items"), and a faded one can no longer be
//     attached to by anybody.
//   * A returning topic does NOT reopen anything. It starts a new episode, and
//     the continuity lives one level up, on the arc. Reopening would make
//     "when did this happen" unanswerable — a single episode would span the
//     gap it was supposed to record.
//
// No model is involved and none ever will be: this is a clock and a comparison.
// `outcome = faded` is the specific word §11.1 uses, and it is distinct from
// the outcomes a model or a user can set on an episode that actually concluded.
// ===========================================================================

import { getDb } from "../db/connection.js";

/** §11.1 rule 5, in days and in milliseconds. */
export const EPISODE_QUIET_DAYS = 14;
export const EPISODE_QUIET_MS = EPISODE_QUIET_DAYS * 24 * 60 * 60 * 1000;

/** `episodes.arc_state` — the episode's own liveness, CODE-written only. */
export const EPISODE_OPEN = "open";
export const EPISODE_CLOSED = "closed";
/** `episodes.outcome` when the close was the clock's doing, not a conclusion. */
export const EPISODE_FADED = "faded";

/** An episode as the clock sees it. */
export interface AgingEpisode {
  id: string;
  arcState: string | null;
  /** Last activity: the end of its most recent session. */
  lastActiveAt: string | null;
}

export interface FadeDecision {
  episodeId: string;
  arcState: typeof EPISODE_CLOSED;
  outcome: typeof EPISODE_FADED;
  lastActiveAt: string;
  quietMs: number;
  quietDays: number;
}

function parseMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso.trim() === "") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * How long this episode has been quiet, or null when it has no readable last
 * activity. Null is "unknown", and an unknown age never ages anything out — a
 * row with no timestamp is a data problem, not a fourteen-day silence.
 */
export function quietMs(lastActiveAt: string | null | undefined, now: number): number | null {
  const at = parseMs(lastActiveAt);
  if (at === null) return null;
  return now - at;
}

/** Quiet for 14 days or more. The boundary day itself fades (`>=`). */
export function isQuiet(lastActiveAt: string | null | undefined, now: number): boolean {
  const ms = quietMs(lastActiveAt, now);
  return ms !== null && ms >= EPISODE_QUIET_MS;
}

/**
 * Which of these open episodes the clock closes. Pure — the caller decides
 * whether to write them, and the eval harness reads them without a database.
 * Ordered by id so two runs over the same input produce the same list.
 */
export function fadeDecisions(episodes: readonly AgingEpisode[], now: number): FadeDecision[] {
  const out: FadeDecision[] = [];
  for (const episode of episodes) {
    if (episode.arcState !== null && episode.arcState !== EPISODE_OPEN) continue;
    const ms = quietMs(episode.lastActiveAt, now);
    if (ms === null || ms < EPISODE_QUIET_MS) continue;
    out.push({
      episodeId: episode.id,
      arcState: EPISODE_CLOSED,
      outcome: EPISODE_FADED,
      lastActiveAt: episode.lastActiveAt as string,
      quietMs: ms,
      quietDays: Math.floor(ms / (24 * 60 * 60 * 1000)),
    });
  }
  out.sort((a, b) => (a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0));
  return out;
}

/**
 * Every episode still open (or with no state written yet — a row minted before
 * this module existed is treated as open, never as silently closed).
 */
export function readOpenEpisodesForAging(streamId?: string): AgingEpisode[] {
  const where = streamId === undefined ? "" : " AND stream_id = @streamId";
  const rows = getDb()
    .prepare(
      `SELECT id,
              arc_state                       AS arc_state,
              COALESCE(ended_at, started_at)  AS last_active_at
         FROM episodes
        WHERE (arc_state IS NULL OR arc_state = '${EPISODE_OPEN}')${where}
        ORDER BY id`,
    )
    .all(streamId === undefined ? {} : { streamId }) as {
    id: string;
    arc_state: string | null;
    last_active_at: string | null;
  }[];
  return rows.map((r) => ({ id: r.id, arcState: r.arc_state, lastActiveAt: r.last_active_at }));
}

/**
 * Run the clock. Returns what it closed — an empty array is the common answer
 * and is not a failure. Idempotent: a second run finds nothing left to close.
 */
export function ageEpisodes(opts: { now?: number; streamId?: string } = {}): FadeDecision[] {
  const now = opts.now ?? Date.now();
  const decisions = fadeDecisions(readOpenEpisodesForAging(opts.streamId), now);
  if (decisions.length === 0) return decisions;

  const db = getDb();
  const stamp = new Date(now).toISOString();
  const update = db.prepare(
    `UPDATE episodes
        SET arc_state = @arcState, outcome = @outcome, updated_at = @updatedAt
      WHERE id = @id`,
  );
  const tx = db.transaction((items: readonly FadeDecision[]) => {
    for (const item of items) {
      update.run({
        id: item.episodeId,
        arcState: item.arcState,
        outcome: item.outcome,
        updatedAt: stamp,
      });
    }
  });
  tx(decisions);
  return decisions;
}
