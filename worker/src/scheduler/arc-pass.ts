// ===========================================================================
// [CODE] The arc stage — L5's production caller, and the loop→arc bind.
// Arch §11.2 (the ladder and its two-phase commit), §11.3 (a space is a
// promoted arc), §9.4 (where a free stage sits in the tick).
//
// ⚠ THE DEFECT THIS FILE EXISTS FOR — the third of its species this build.
// `arcs/ladder.ts` has exported `runArcLadder` and `arcs/provisional.ts` has
// exported `applyLadderResult` since item 2.4, and NOTHING IN PRODUCTION HAS
// EVER CALLED EITHER. Their only reference was `evals/executors/arcs.ts`. The
// consequence is a chain, not a single hole:
//
//   no ladder call → `arc_episodes` and `provisional_arcs` stay empty
//                  → `arcs/reconcile.ts` has no provisional to commit, so
//                    `arcs` stays empty and THREADS renders nothing
//                  → `promoteArcs` has no arc to promote, so `promoted = 1`
//                    is never written and SPACES renders nothing
//                  → `loops.arc_id` stays NULL, so `readEmergenceInput`'s
//                    `JOIN arcs a ON a.id = l.arc_id` matches no row and GOALS
//                    stays 0 even once the two above are fixed.
//
// A live install with 9 episodes, 27 claims and 4 loops therefore showed the
// user two empty tabs. Every rung of the ladder worked; nobody rang the bell.
//
// WHAT A PASS DOES, per unplaced episode:
//
//   * builds a `LadderEpisode` out of the row — anchors off `entity_ids` with
//     their `entities.type` (rung ② weights the TYPE, and a missing one scores
//     every person as a topic), `ambient` off the stream's kind (§2.1; the
//     ladder never guesses it, because guessing it wrong opens the rung §11.2
//     shuts), and `bridgeIds` off the episode's own sessions and events, which
//     is what rung ① intersects.
//   * runs `runArcLadder` against `readArcCandidates()` — rung ① bridges,
//     rung ② entity overlap, both `[CODE]`.
//   * hands the result to `applyLadderResult`, the ONLY writer of arc
//     membership: a join writes `arc_episodes` now, everything else parks a
//     `provisional_arcs` row that surfaces nothing until reconcile commits it.
//
// THE COST GUARANTEE IS STRUCTURAL, LIKE `entity-pass.ts`'s. This module is
// synchronous and imports no transport, and it passes NO `adjudicator` — so
// rung ④ takes `ladder.ts`'s own "P-AG2 is not on this path" branch, decides
// `defer`, and spends nothing. Rung ③ nominates nobody either: `readArcCandidates`
// reports `cosine: null` because nothing writes arc topic vectors yet, and an
// unmeasured cosine is "not measured", never "far". `report.llmCalls` is the
// literal `0` that says so out loud. A later item that wants P-AG2 injects an
// adjudicator through `ArcPassOptions` and pays for it through the tick's
// wallet, the way P-EP2 and P-CL1 already do.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { logMutation } from "../entities/merge.js";
import { runArcLadder, type ArcAdjudicator, type LadderEpisode } from "../arcs/ladder.js";
import { applyLadderResult, readArcCandidates } from "../arcs/provisional.js";
import type { AnchorRef } from "../arcs/key.js";

/** How many episodes one pass places. Bounded like every other stage's chunk. */
export const ARC_PASS_LIMIT = 128;

/** Every loop→arc bind carries this actor, so a sweep is one undoable run. */
export const ARC_BIND_ACTOR = "code:arc-bind";

function log(line: string): void {
  console.error(`[arc] ${line}`);
}

function jsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function text(raw: unknown): string | null {
  return raw === null || raw === undefined ? null : String(raw);
}

export interface ArcPassReport {
  /** Episodes taken off the pending list and decided. */
  episodes: number;
  /** Bound to an EXISTING arc — rung ① or ②. `arc_episodes` written now. */
  joined: number;
  /** Parked in `provisional_arcs`. Surfaces nothing until reconcile commits. */
  provisional: number;
  /** `ask_user` verdicts — a question row, and the episode still parked. */
  questions: number;
  /**
   * Always 0, and typed as `0` so a future edit that reaches for a model has
   * to change the TYPE to do it. No adjudicator is passed, so rung ④ defers.
   */
  llmCalls: 0;
  errors: string[];
}

export function emptyArcPassReport(): ArcPassReport {
  return { episodes: 0, joined: 0, provisional: 0, questions: 0, llmCalls: 0, errors: [] };
}

export interface ArcPassOptions {
  now?: number;
  limit?: number;
  /** The cohort whose boundary will reconcile these provisionals (§11.2). */
  batchId?: string | null;
  runId?: string | null;
  /**
   * P-AG2's transport. Absent on the first-paint path by design — see the
   * header's cost note. A caller that supplies one owns its budget.
   */
  adjudicator?: ArcAdjudicator | null;
}

interface EpisodeRow {
  id: string;
  stream_id: string | null;
  source_id: string | null;
  topic_label: string | null;
  session_ids: string | null;
  event_ids: string | null;
  entity_ids: string | null;
  started_at: string | null;
  ended_at: string | null;
  stream_kind: string | null;
}

/**
 * Episodes no ladder pass has decided.
 *
 * Pending is a property of the ROWS — "an episode with neither a membership nor
 * a verdict" — rather than of a queue or a watermark, for the same reason the
 * roster sweep is: an install whose episodes were written before this file
 * existed has no queue rows to drain and still owes 9 placements. It therefore
 * self-heals and converges: every pass writes a verdict per episode, and an
 * episode with a verdict is never re-judged (§11.2 — replay REUSES a verdict,
 * it never re-decides it).
 *
 * `arc_episodes` is checked as well as `arc_verdicts` so an episode a user
 * moved by hand (`server/arcs-routes.ts`) is settled without a verdict row.
 */
export function pendingArcEpisodes(opts: { limit?: number } = {}): string[] {
  const limit = Math.max(1, Math.floor(opts.limit ?? ARC_PASS_LIMIT));
  return (
    getDb()
      .prepare(
        `SELECT e.id AS id
           FROM episodes e
          WHERE NOT EXISTS (SELECT 1 FROM arc_episodes ae WHERE ae.episode_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM arc_verdicts av WHERE av.episode_id = e.id)
          ORDER BY COALESCE(e.started_at, e.created_at), e.id
          LIMIT ?`,
      )
      .all(limit) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * The anchors of one episode, WITH their entity type. Read rather than
 * defaulted: `weightedOverlap` scores a `person` anchor far above a `topic`
 * one, and a null type is the weakest tier — so defaulting would quietly stop
 * rung ② from ever joining two conversations about the same human.
 */
function anchorsOf(entityIds: readonly string[]): AnchorRef[] {
  if (entityIds.length === 0) return [];
  const marks = entityIds.map(() => "?").join(", ");
  const typeOf = new Map<string, string>();
  for (const row of getDb()
    .prepare(`SELECT id, type FROM entities WHERE id IN (${marks})`)
    .all(...entityIds) as { id: string; type: string }[]) {
    typeOf.set(row.id, row.type);
  }
  // Only entities that EXIST become anchors: an id the episode carries but the
  // table has lost is not an anchor, and `arcKey` would hash it into a key no
  // second run could reproduce.
  return entityIds.filter((id) => typeOf.has(id)).map((id) => ({ entityId: id, type: typeOf.get(id) ?? null }));
}

function toLadderEpisode(row: EpisodeRow): { episode: LadderEpisode; anchors: AnchorRef[] } {
  const anchors = anchorsOf(jsonArray(row.entity_ids));
  const episode: LadderEpisode = {
    id: row.id,
    label: text(row.topic_label),
    sourceId: text(row.source_id),
    // §2.1 — read off the stream's kind, never guessed. Rungs ③ and ④ are
    // closed to an ambient episode whatever a topic vector would have said.
    ambient: row.stream_kind === "ambient",
    anchors,
    // Rung ① is a set intersection, so every id a `bridges` row could name
    // this episode by goes in: the episode, its sessions, its events.
    bridgeIds: [row.id, ...jsonArray(row.session_ids), ...jsonArray(row.event_ids)],
    span: row.started_at === null ? null : `${row.started_at} – ${row.ended_at ?? row.started_at}`,
  };
  return { episode, anchors };
}

/**
 * Place every undecided episode on the arc ladder.
 *
 * SYNCHRONOUS ON PURPOSE, like `drainEntityQueue` and `bindStreamParticipants`:
 * there is no transport to await, so the free-stage guarantee is the function's
 * signature rather than a comment.
 *
 * An episode that throws is recorded and SKIPPED, never retried in place: it
 * wrote no verdict, so the pending query offers it again next pass, and one
 * unreadable episode must not cost the other eight their arcs.
 */
export function arcPass(opts: ArcPassOptions = {}): ArcPassReport {
  const report = emptyArcPassReport();
  const now = opts.now ?? Date.now();
  const ids = pendingArcEpisodes({ limit: opts.limit ?? ARC_PASS_LIMIT });
  if (ids.length === 0) return report;

  const read = getDb().prepare(
    `SELECT e.id, e.stream_id, e.source_id, e.topic_label, e.session_ids, e.event_ids,
            e.entity_ids, e.started_at, e.ended_at, s.stream_kind AS stream_kind
       FROM episodes e LEFT JOIN streams s ON s.id = e.stream_id
      WHERE e.id = ?`,
  );

  for (const id of ids) {
    try {
      const row = read.get(id) as EpisodeRow | undefined;
      if (row === undefined) continue;
      const { episode, anchors } = toLadderEpisode(row);
      // Re-read per episode: a join written a moment ago is a candidate for the
      // next one, which is what lets two episodes of the same matter land in
      // one arc within a single pass.
      const result = runArcLadder(episode, readArcCandidates(), {
        now,
        ...(opts.adjudicator === undefined ? {} : { adjudicator: opts.adjudicator }),
      });
      const applied = applyLadderResult(result, {
        anchors,
        label: episode.label,
        sourceId: episode.sourceId,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        batchId: opts.batchId ?? null,
        runId: opts.runId ?? null,
        now,
      });
      report.episodes += 1;
      if (applied.arcId !== null) report.joined += 1;
      if (applied.provisionalId !== null) report.provisional += 1;
      if (applied.questionId !== null) report.questions += 1;
    } catch (err) {
      report.errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(
    `episodes=${report.episodes} joined=${report.joined} provisional=${report.provisional} ` +
      `questions=${report.questions} llm=${report.llmCalls} errors=${report.errors.length}`,
  );
  return report;
}

// ---------------------------------------------------------------------------
// The loop → arc bind
// ---------------------------------------------------------------------------

interface LoopArcRow {
  loop_id: string;
  arc_id: string;
  n: number;
}

/**
 * Give every unplaced loop the arc its own evidence already sits in.
 *
 * `loops.arc_id` is the last link in the chain and NOTHING has ever written it
 * outside the confluence harness. Without it `arcs/promote-store.ts` reads zero
 * loops for every arc (so no arc has a live loop, so no arc is a space) and
 * `goals/emerge.ts` joins `loops → arcs` on NULL (so no goal can emerge).
 *
 * The link is already in the database and is not a guess: `cl1-apply.ts` stamps
 * `evidence.episode_id` on every loop evidence row, and `arc_episodes` says
 * which arc that episode belongs to. This is §11.6 rule 7 — derived state is
 * RECOMPUTED from the evidence set — expressed as one join.
 *
 * A loop whose evidence spans two arcs takes the arc backing MOST of it, ties
 * broken on arc id, so two runs over the same evidence never disagree (§11.6
 * rule 6, confluence). Only NULL rows are written: a loop the user or reconcile
 * has already placed keeps its arc, exactly as `LOOP_UPSERT`'s `DO UPDATE`
 * promises.
 */
export function bindLoopArcs(opts: { runId?: string | null; actor?: string } = {}): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT l.id AS loop_id, ae.arc_id AS arc_id, COUNT(*) AS n
         FROM loops l
         JOIN evidence ev
           ON ev.subject_kind = 'loop' AND ev.subject_id = l.id AND ev.episode_id IS NOT NULL
         JOIN arc_episodes ae ON ae.episode_id = ev.episode_id
        WHERE l.arc_id IS NULL
        GROUP BY l.id, ae.arc_id
        ORDER BY l.id, ae.arc_id`,
    )
    .all() as LoopArcRow[];
  if (rows.length === 0) return 0;

  // Picked in JS rather than with a bare column under `GROUP BY`: SQLite only
  // guarantees which row a bare column comes from for `min`/`max`, and a
  // tie-break that depends on the query planner is not a tie-break.
  const best = new Map<string, { arcId: string; n: number }>();
  for (const row of rows) {
    const held = best.get(row.loop_id);
    if (held === undefined || row.n > held.n || (row.n === held.n && row.arc_id < held.arcId)) {
      best.set(row.loop_id, { arcId: row.arc_id, n: row.n });
    }
  }

  const update = db.prepare(`UPDATE loops SET arc_id = ? WHERE id = ? AND arc_id IS NULL`);
  const actor = opts.actor ?? ARC_BIND_ACTOR;
  let bound = 0;
  db.transaction(() => {
    for (const [loopId, pick] of best) {
      if (update.run(pick.arcId, loopId).changes === 0) continue;
      bound += 1;
      // §11.6 rule 9 — every write emits a `mutations` row, so the bind is
      // part of the run the user can undo.
      logMutation({
        actor,
        runId: opts.runId ?? null,
        targetKind: "loop",
        targetId: loopId,
        field: "arc_id",
        oldValue: null,
        newValue: pick.arcId,
        reason: `${pick.n} evidence event(s) sit in an episode bound to ${pick.arcId}`,
      });
    }
  })();

  if (bound > 0) log(`loops bound to arcs: ${bound}`);
  return bound;
}
