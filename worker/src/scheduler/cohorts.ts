// ===========================================================================
// [CODE] Cohorts — planning, sealing and the state machine. Arch §9.1, §9.2 and
// §9.3; build item 1.8.
//
// A cohort is the unit of scheduling: a bounded set of sessions, drawn from one
// horizon, processed end to end together. It lives in the DB (`cohorts`), which
// is what makes an interrupted import resumable rather than restartable.
//
// TIME-FIRST, NOT STREAM-FIRST (§9.2 rule 1). A cohort draws from ALL streams
// inside its horizon. Processing stream by stream would produce a lopsided
// brain — all of one chat, none of the others — so the candidate query is
// ordered by the §9.3 priority across every stream and the cohort takes the
// head of that list, whatever stream each session came from.
//
// TIER IS THE PRIMARY KEY, RECENCY THE LAST (§9.3). `priority = tier x 10^9 +
// horizon x 10^6 + recency` comes out of ../tiers/priority.ts; nothing here
// re-implements it, and the ONE thing that must be true of the resulting order
// — recency descending inside a tier — is asserted by `orderInversions` rather
// than trusted.
//
// A COHORT IS THE UNIT OF PROGRESS (§9.1 rule 3). It moves
// `planned -> enriching -> ready -> understanding -> done`, and EVERY
// transition writes coverage. Not the last one: every one. A meter that only
// moves at the end is a meter that looks broken for the length of a cohort.
//
// The ramp is not a special case for cohort 0 (§9.1 rule 2). Every cohort
// travels the identical path; `seq` is the only thing that differs, and it is
// an argument to one formula in ./horizons.ts.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { isTier, type Tier } from "../tiers/priority.js";
import {
  cohortBudget,
  computePriority,
  fillCohort,
  horizonFor,
  horizonWindow,
  isHorizon,
  modeParams,
  type Budget,
  type Horizon,
  type SchedulerMode,
  type SessionSize,
} from "./horizons.js";
import { writeCoverage, type CoverageOutcome, type CoverageScope } from "./queue.js";

/** §9.1 rule 3, in order. `paused` and `quarantined` sit outside the ladder. */
export const COHORT_STATES = [
  "planned",
  "enriching",
  "ready",
  "understanding",
  "done",
  "paused",
  "quarantined",
] as const;
export type CohortState = (typeof COHORT_STATES)[number];

/** The forward ladder — the only path a healthy cohort takes. */
export const COHORT_LADDER: CohortState[] = ["planned", "enriching", "ready", "understanding", "done"];

export interface Cohort {
  id: string;
  sourceId: string | null;
  mode: SchedulerMode;
  horizon: Horizon;
  tier: Tier;
  seq: number;
  tsHi: string | null;
  tsLo: string | null;
  priority: number;
  sessionIds: string[];
  eventCount: number;
  tokenEstimate: number;
  /** Expected P-CL1 output tokens — the axis cohort 0 is sized on (§9.5.3). */
  outputEstimate: number;
  state: CohortState;
  budget: Budget;
  closedBy: string;
}

interface CohortRow {
  id: string;
  source_id: string | null;
  mode: string;
  horizon: string;
  seq: number;
  ts_hi: string | null;
  ts_lo: string | null;
  priority: number;
  session_ids: string | null;
  event_count: number;
  token_estimate: number;
  state: string;
  reason: string | null;
}

/**
 * `reason` carries the fields the table has no column for — tier, the output
 * estimate and which bound closed the cohort. Encoded as `k=v|k=v` rather than
 * JSON so it stays greppable in a sqlite shell, which is where anyone debugging
 * a stalled import will actually be.
 */
function packReason(cohort: Pick<Cohort, "tier" | "outputEstimate" | "closedBy">): string {
  return `tier=${cohort.tier}|out=${cohort.outputEstimate}|closed=${cohort.closedBy}`;
}

function unpackReason(reason: string | null): { tier: Tier; outputEstimate: number; closedBy: string } {
  const fields = new Map<string, string>();
  for (const part of (reason ?? "").split("|")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const tier = fields.get("tier");
  return {
    tier: isTier(tier) ? tier : "T1",
    outputEstimate: Number(fields.get("out") ?? 0) || 0,
    closedBy: fields.get("closed") ?? "exhausted",
  };
}

function toCohort(row: CohortRow): Cohort {
  const extra = unpackReason(row.reason);
  const sessionIds = row.session_ids ? (JSON.parse(row.session_ids) as string[]) : [];
  return {
    id: row.id,
    sourceId: row.source_id,
    mode: row.mode as SchedulerMode,
    horizon: (isHorizon(row.horizon) ? row.horizon : "older") as Horizon,
    tier: extra.tier,
    seq: row.seq,
    tsHi: row.ts_hi,
    tsLo: row.ts_lo,
    priority: row.priority,
    sessionIds,
    eventCount: row.event_count,
    tokenEstimate: row.token_estimate,
    outputEstimate: extra.outputEstimate,
    state: row.state as CohortState,
    budget: cohortBudget(row.seq),
    closedBy: extra.closedBy,
  };
}

// ---------------------------------------------------------------------------
// Candidates — §9.2 rule 1, drawn across ALL streams
// ---------------------------------------------------------------------------

export interface Candidate extends SessionSize {
  streamId: string;
  tier: Tier;
  /** The session's newest instant — what recency is computed from. */
  tsHi: string;
  tsLo: string;
  priority: number;
  horizon: Horizon;
}

export interface CandidateQuery {
  mode: SchedulerMode;
  horizon: Horizon;
  now: number;
  sourceId?: string | null;
  /** Only these tiers, highest first. Defaults to every tier. */
  tier?: Tier;
  limit?: number;
}

/**
 * Sessions in this horizon that no cohort has claimed yet, in §9.3 priority
 * order across every stream.
 *
 * Only SEALED sessions are drawn in bootstrap. §8.2's one exception — the
 * newest session of a stream, left open and handed to steady-state rules — is
 * respected by that filter rather than by a special case: an open session is
 * simply not a candidate for a backfill cohort, and steady's live trigger is
 * what understands it.
 */
export function candidateSessions(query: CandidateQuery): Candidate[] {
  const window = horizonWindow(query.horizon, query.now);
  const hi = new Date(window.hi).toISOString();
  const lo = Number.isFinite(window.lo) ? new Date(window.lo).toISOString() : "0000-01-01T00:00:00.000Z";
  const rows = getDb()
    .prepare(
      `SELECT s.id            AS id,
              s.stream_id     AS stream_id,
              s.started_at    AS started_at,
              s.ended_at      AS ended_at,
              st.tier         AS tier,
              (SELECT COUNT(*) FROM json_each(COALESCE(s.event_ids, '[]'))) AS event_count,
              (SELECT COALESCE(SUM(LENGTH(COALESCE(e.text, ''))), 0)
                 FROM json_each(COALESCE(s.event_ids, '[]')) je
                 JOIN events e ON e.id = je.value)                        AS char_count
         FROM sessions s
         JOIN streams st ON st.id = s.stream_id
        WHERE s.status = 'sealed'
          AND COALESCE(s.ended_at, s.started_at) >  ?
          AND COALESCE(s.ended_at, s.started_at) <= ?
          AND (? IS NULL OR s.source_id = ?)
          AND (? IS NULL OR st.tier = ?)
          -- Already claimed by a cohort? Membership is the session_ids JSON
          -- array on cohorts -- the schema's only record of it -- so the check
          -- reads that rather than inventing a second table to disagree with.
          AND NOT EXISTS (
            SELECT 1 FROM cohorts c, json_each(COALESCE(c.session_ids, '[]')) cj
             WHERE cj.value = s.id
          )`,
    )
    .all(
      lo,
      hi,
      query.sourceId ?? null,
      query.sourceId ?? null,
      query.tier ?? null,
      query.tier ?? null,
    ) as {
    id: string;
    stream_id: string;
    started_at: string | null;
    ended_at: string | null;
    tier: string | null;
    event_count: number;
    char_count: number;
  }[];

  const candidates: Candidate[] = rows.map((row) => {
    const tsHi = row.ended_at ?? row.started_at ?? new Date(query.now).toISOString();
    const tier: Tier = isTier(row.tier) ? row.tier : "T3";
    const horizon = horizonFor(tsHi, query.now);
    return {
      id: row.id,
      streamId: row.stream_id,
      tier,
      tsHi,
      tsLo: row.started_at ?? tsHi,
      eventCount: row.event_count,
      charCount: row.char_count,
      horizon,
      priority: computePriority({ tier, horizon, ts: tsHi, now: query.now }),
    };
  });

  // Tier, then horizon, then recency — all three already inside `priority`.
  // The id tiebreak keeps a replay deterministic when a whole cohort shares one
  // recency slot, which it usually does.
  candidates.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return typeof query.limit === "number" ? candidates.slice(0, Math.max(0, query.limit)) : candidates;
}

/**
 * Recency inversions inside a tier — gate `sched_recency_order` ("processing
 * order is recency-descending across all streams", any inversion fails).
 *
 * Across tiers an older session legitimately precedes a newer one, so only
 * same-tier neighbours are compared. That is the whole point of §9.3: recency
 * alone is not enough.
 */
export function orderInversions(order: readonly { id: string; tier: Tier; tsHi: string }[]): {
  before: string;
  after: string;
}[] {
  const out: { before: string; after: string }[] = [];
  const lastByTier = new Map<Tier, { id: string; ts: number }>();
  for (const item of order) {
    const ts = Date.parse(item.tsHi);
    const previous = lastByTier.get(item.tier);
    if (previous && Number.isFinite(ts) && ts > previous.ts) {
      out.push({ before: previous.id, after: item.id });
    }
    if (Number.isFinite(ts)) lastByTier.set(item.tier, { id: item.id, ts });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sealing a cohort
// ---------------------------------------------------------------------------

export interface SealInput {
  mode: SchedulerMode;
  horizon: Horizon;
  seq: number;
  now: number;
  sourceId?: string | null;
  candidates: readonly Candidate[];
  /** Overrides the ramp — only `shrinkToDeadline` should ever supply one. */
  budget?: Budget;
  idPrefix?: string;
}

/**
 * Close a cohort over the head of the candidate list and persist it.
 *
 * IMMEDIATE, NO DEBOUNCE (§9.5.4, `t=10–14 cohort 0 sealed — immediate`). The
 * budget decides when a cohort closes; the clock never does. A wall-clock
 * debounce here is how the first-paint budget is spent before the first call is
 * even dispatched.
 */
export function sealCohort(input: SealInput): Cohort {
  const budget = input.budget ?? cohortBudget(input.seq);
  const fill = fillCohort(input.candidates, budget);
  const taken = fill.taken as Candidate[];
  const tier: Tier = taken[0]?.tier ?? "T1";
  const tsHi = taken.reduce<string | null>((acc, s) => (acc === null || s.tsHi > acc ? s.tsHi : acc), null);
  const tsLo = taken.reduce<string | null>((acc, s) => (acc === null || s.tsLo < acc ? s.tsLo : acc), null);
  const id = `${input.idPrefix ?? "coh"}:${input.mode}:${input.horizon}:${input.seq}`;

  const cohort: Cohort = {
    id,
    sourceId: input.sourceId ?? null,
    mode: input.mode,
    horizon: input.horizon,
    tier,
    seq: input.seq,
    tsHi,
    tsLo,
    priority: computePriority({ tier, horizon: input.horizon, ts: tsHi ?? undefined, now: input.now }),
    sessionIds: taken.map((s) => s.id),
    eventCount: fill.eventCount,
    tokenEstimate: fill.inputTokens,
    outputEstimate: fill.outputTokens,
    state: "planned",
    budget,
    closedBy: fill.closedBy,
  };

  persistCohort(cohort);
  return cohort;
}

/**
 * Insert or update the cohort. Session membership rides in `session_ids` — the
 * schema's own record of it — so there is exactly one place a session's cohort
 * can be read from and no join table to fall out of step with it.
 */
export function persistCohort(cohort: Cohort): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO cohorts (id, source_id, mode, horizon, seq, ts_hi, ts_lo, priority,
                            session_ids, event_count, token_estimate, state, reason)
       VALUES (@id, @sourceId, @mode, @horizon, @seq, @tsHi, @tsLo, @priority,
               @sessionIds, @eventCount, @tokenEstimate, @state, @reason)
       ON CONFLICT(id) DO UPDATE SET
         session_ids    = excluded.session_ids,
         event_count    = excluded.event_count,
         token_estimate = excluded.token_estimate,
         priority       = excluded.priority,
         ts_hi          = excluded.ts_hi,
         ts_lo          = excluded.ts_lo,
         reason         = excluded.reason`,
    ).run({
      id: cohort.id,
      sourceId: cohort.sourceId,
      mode: cohort.mode,
      horizon: cohort.horizon,
      seq: cohort.seq,
      tsHi: cohort.tsHi,
      tsLo: cohort.tsLo,
      priority: cohort.priority,
      sessionIds: JSON.stringify(cohort.sessionIds),
      eventCount: cohort.eventCount,
      tokenEstimate: cohort.tokenEstimate,
      state: cohort.state,
      reason: packReason(cohort),
    });
  });
  tx();
}

export function readCohort(id: string): Cohort | null {
  const row = getDb().prepare(`SELECT * FROM cohorts WHERE id = ?`).get(id) as CohortRow | undefined;
  return row ? toCohort(row) : null;
}

/** Every cohort not yet `done`, highest priority first — never by rowid. */
export function pendingCohorts(): Cohort[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM cohorts
        WHERE state NOT IN ('done', 'quarantined')
        ORDER BY priority DESC, id`,
    )
    .all() as CohortRow[];
  return rows.map(toCohort);
}

// ---------------------------------------------------------------------------
// The state machine — §9.1 rule 3
// ---------------------------------------------------------------------------

export interface TransitionResult {
  cohort: Cohort;
  from: CohortState;
  to: CohortState;
  /** Coverage written by this transition — one row per scope touched. */
  coverage: CoverageOutcome[];
  /** True when the ladder was walked backwards and the write was refused. */
  refused: boolean;
}

const LADDER_INDEX = new Map<CohortState, number>(COHORT_LADDER.map((s, i) => [s, i]));

/** How far along the ladder a state is; `paused` keeps the cohort's place. */
function ladderIndex(state: CohortState): number {
  return LADDER_INDEX.get(state) ?? -1;
}

/**
 * Move a cohort one rung and write coverage for it.
 *
 * COVERAGE IS WRITTEN ON EVERY TRANSITION, NOT ONLY ON `done` (§9.1 rule 3,
 * §9.7 rule 3). A cohort halfway through understanding has genuinely made
 * progress, and the meter says so — that is the difference between "working"
 * and "hung" from the user's side of the screen.
 *
 * Going backwards is refused, not thrown: a stale transition arriving late is
 * ordinary in a concurrent pipeline, and coverage's own monotonic clamp is the
 * backstop.
 */
export function advanceCohort(
  id: string,
  to: CohortState,
  options: { scopes?: readonly { kind: CoverageScope; id: string }[] } = {},
): TransitionResult {
  const cohort = readCohort(id);
  if (!cohort) throw new Error(`advanceCohort: no cohort ${id}`);
  const from = cohort.state;
  const forward = ladderIndex(to) > ladderIndex(from) || to === "paused" || to === "quarantined";
  if (!forward) {
    return { cohort, from, to, coverage: [], refused: true };
  }

  const db = getDb();
  const stamp: Record<CohortState, string | null> = {
    planned: null,
    enriching: "enriched_at",
    ready: null,
    understanding: null,
    done: "understood_at",
    paused: null,
    quarantined: null,
  };
  const column = stamp[to];
  db.prepare(
    column
      ? `UPDATE cohorts SET state = ?, ${column} = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
      : `UPDATE cohorts SET state = ? WHERE id = ?`,
  ).run(to, id);

  const updated = { ...cohort, state: to };
  const scopes = options.scopes ?? defaultScopes(cohort);
  const coverage = scopes.map((scope) =>
    writeCoverage({
      scopeKind: scope.kind,
      scopeId: scope.id,
      horizon: cohort.horizon,
      totalUnits: horizonTotalUnits(scope, cohort.horizon),
      doneUnits: horizonDoneUnits(scope, cohort.horizon),
    }),
  );
  return { cohort: updated, from, to, coverage, refused: false };
}

function defaultScopes(cohort: Cohort): { kind: CoverageScope; id: string }[] {
  const scopes: { kind: CoverageScope; id: string }[] = [{ kind: "global", id: "all" }];
  if (cohort.sourceId) scopes.push({ kind: "source", id: cohort.sourceId });
  return scopes;
}

/**
 * Total and done UNITS are counted in sessions, and counted from the DB rather
 * than accumulated in memory — an accumulator is what makes a meter drift after
 * a restart.
 *
 * `progressWeight` is why a mid-ladder transition moves the meter at all: a
 * cohort in `understanding` is genuinely most of the way through its work, and
 * counting only `done` cohorts would leave the meter flat for a whole cohort at
 * a time.
 */
const PROGRESS_WEIGHT: Record<CohortState, number> = {
  planned: 0,
  enriching: 0.25,
  ready: 0.5,
  understanding: 0.75,
  done: 1,
  paused: 0,
  quarantined: 0,
};

function scopeClause(scope: { kind: CoverageScope; id: string }): { sql: string; params: unknown[] } {
  if (scope.kind === "global") return { sql: "1 = 1", params: [] };
  if (scope.kind === "source") return { sql: "source_id = ?", params: [scope.id] };
  // A stream scope is not a column on `cohorts` (a cohort spans streams by
  // construction, §9.2 rule 1), so it is resolved through membership.
  return {
    sql: `EXISTS (SELECT 1 FROM json_each(COALESCE(cohorts.session_ids, '[]')) cj
                    JOIN sessions s ON s.id = cj.value
                   WHERE s.stream_id = ?)`,
    params: [scope.id],
  };
}

function horizonTotalUnits(scope: { kind: CoverageScope; id: string }, horizon: Horizon): number {
  const clause = scopeClause(scope);
  const row = getDb()
    .prepare(`SELECT COALESCE(SUM(event_count), 0) AS n FROM cohorts WHERE horizon = ? AND ${clause.sql}`)
    .get(horizon, ...clause.params) as { n: number };
  return row.n;
}

function horizonDoneUnits(scope: { kind: CoverageScope; id: string }, horizon: Horizon): number {
  const clause = scopeClause(scope);
  const rows = getDb()
    .prepare(`SELECT state, COALESCE(SUM(event_count), 0) AS n FROM cohorts
               WHERE horizon = ? AND ${clause.sql} GROUP BY state`)
    .all(horizon, ...clause.params) as { state: string; n: number }[];
  let done = 0;
  for (const row of rows) done += (PROGRESS_WEIGHT[row.state as CohortState] ?? 0) * row.n;
  return Math.floor(done);
}

// ---------------------------------------------------------------------------
// Restart (§9.7 rule 5)
// ---------------------------------------------------------------------------

export interface CohortResume {
  id: string;
  /** The last state that actually completed — where work picks up. */
  resumeFrom: CohortState;
  /** The rung it is re-entered at. */
  resumeAt: CohortState;
}

/**
 * "On restart, in-flight cohorts resume from their last completed stage."
 *
 * A cohort caught in `enriching` re-enters at `enriching`; nothing before that
 * rung is redone. `done` cohorts are not returned at all, which — with
 * `queue.resumeQueue` refusing to re-run a stage that already has a verdict —
 * is the whole of gate `sched_restart_no_rejudge`.
 */
export function resumeCohorts(): CohortResume[] {
  return pendingCohorts()
    .filter((c) => c.state !== "planned")
    .map((c) => {
      const at = Math.max(0, ladderIndex(c.state));
      return {
        id: c.id,
        resumeFrom: COHORT_LADDER[Math.max(0, at - 1)]!,
        resumeAt: c.state === "paused" ? "planned" : c.state,
      };
    });
}

/** The mode's lookahead applied to a queue of cohorts (§9.4 rule 3). */
export function enrichLookahead(mode: SchedulerMode, queue: readonly Cohort[]): Cohort[] {
  return queue.slice(0, modeParams(mode).enrichLookahead);
}
