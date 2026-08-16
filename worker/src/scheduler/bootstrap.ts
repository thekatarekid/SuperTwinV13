// ===========================================================================
// [CODE] The bootstrap derivation driver — arch §9.1-§9.7, §10.4; build item
// 1.8's missing caller.
//
// Every stage below already existed and every one of them had ZERO production
// callers: `backfillTiers`, `segment`, `sealStream`, `candidateSessions`,
// `sealCohort`, `advanceCohort` and `reconcileAfterTransition` were reachable
// only from tests and from `confluence/pipeline.ts` — which runs the same walk
// over a FROZEN corpus, not over the user's database. That is why a live
// install ships `streams.tier` NULL on every row and zero sessions, episodes
// and claims: nothing ever called any of it. This file is that caller, and it
// is the only thing here that is new.
//
// Four properties it is built around:
//
//   1. NOTHING IS RE-IMPLEMENTED. Tiering (`tiers/ensure.ts`, which owns the
//      P-TI1 opt-in), the walk, the seal, cohort planning, the state machine
//      and reconcile are imported. This module decides WHAT is still
//      outstanding and IN WHICH ORDER; it never decides where a session ends
//      or which tier a stream is.
//
//   2. REMAINING WORK IS DERIVED FROM THE DB, NEVER FROM MEMORY (§9.7 rule 5).
//      A tick asks "which streams have no tier", "which streams have events
//      past their newest session", "which cohorts are mid-ladder" — so a kill
//      -9 halfway through a cohort costs the in-flight rung and nothing else.
//      There is no cursor, no progress file and no accumulator to drift.
//
//   3. COST IS A FIRST-CLASS INPUT, not a consequence. The default mode is
//      `off`; `dry` makes zero provider calls and zero writes; `slice` is
//      bounded in streams, sessions, cohorts AND total model calls. Every
//      model call passes through ONE `spend()` gate, so the cap is a property
//      of the code rather than of how carefully the stages were written.
//      `getProcessEnabled` is read-on-by-default and is NOT a cost control.
//
//   4. A FAILED TICK IS LOUD. `startEpisodeClock`'s shape is copied exactly —
//      interval, re-entrancy latch, `unref` — except for its silent `catch {}`:
//      a driver nobody can debug is how the last build shipped a pipeline that
//      never ran. Errors are logged with the stage and the unit that threw and
//      the next tick retries.
//
// SCOPE (honest): the ladder implemented here is
// tier -> IDENTITY -> segment -> seal -> cohort -> episodes -> extract ->
// reconcile, and it is now complete end to end. The P-CL1 claims/loops stage
// remains an INJECTED seam (`deps.extract`) — this module decides WHEN it runs
// and what budget it gets, never how it runs — but the seam is FILLED at the
// production entry: `startBootstrapDriver` defaults it to
// `scheduler/cl1-runner.ts`'s `cl1ExtractStage()`, and `planBootstrap` projects
// its call count off the same `cl1Batches` the runner batches with. Only
// `runBootstrapTick`, called directly, still runs without one.
//
// ⚠ WHY IDENTITY IS RUNG TWO AND NOT AN AFTERTHOUGHT. It used to be nowhere:
// `tiers/rescan.ts` filed a `stage='entity'` row per event and no drainer ever
// claimed one, so `entities` was empty, `events.actor_entity_id` was NULL on
// every row, and P-CL1 was handed an EMPTY participant roster. An empty roster
// does not fail — it makes the model guess, and it guessed the counterparty's
// facts onto the user as first-person claims. So the order below is a
// correctness constraint with two distinct reasons, not a preference:
//
//   * BEFORE `segment`, because `toSegEvent` reads `actor_entity_id ?? actor_id`
//     — bind first and a session's `participant_entity_ids` are entity ids, the
//     thing the column is named after; bind later and they are actor strings
//     forever, because a sealed session's membership is immutable (§10.4).
//   * BEFORE `extract`, because P-CL1's `#A` roster and its `self` alias are
//     read out of `entities` at pack time (`cl1-pack.ts`). This is the one that
//     silently corrupts.
//
// AFTER `tier`, because an event's queue priority is computed off its stream's
// tier (§9.3) — sweeping first would file 3,000 rows at the default T3.
//
// The stage is FREE and structurally so: `entityPass` is synchronous and
// imports no transport, its `llmCalls` is typed as the literal `0`, and rung ④
// (P-AG1) is PARKED on the agent batch rather than called (§10.3 rule 6). It
// therefore draws nothing from the wallet — which is why it is allowed to run
// before the first paid stage rather than competing with one.
// ===========================================================================

import { getManifest, isStreamKind, type StreamKind } from "../adapters/registry.js";
import { getDb } from "../db/connection.js";
import { appStateGet, importDoneKey } from "../db/ingest.js";
import { markSourceBackfillComplete } from "../db/watermarks.js";
import { get as getProvider, DEFAULT_PROVIDER_ID } from "../providers/registry.js";
import { onArcChange, reconcileAfterTransition } from "../reconcile/index.js";
import { isDroppedAtAdapter } from "../sessions/ops.js";
import { parseOverride, resolvePolicy, type SessionPolicy } from "../sessions/policies.js";
import { sealStream, textIndex } from "../sessions/seal.js";
import { segment, type SegEvent, type SegSession } from "../sessions/segment.js";
import { chunkChannels } from "../prompts/p-ti1.js";
import { tierCoverage, type BackfillReport } from "../tiers/derive.js";
import {
  ambiguousChannels,
  ensureTiers,
  tierModelEnabled,
  DEFAULT_MAX_MODEL_CALLS,
} from "../tiers/ensure.js";
import type { Ti1Invoke } from "../tiers/ti1-runner.js";
import {
  advanceCohort,
  candidateSessions,
  pendingCohorts,
  readCohort,
  resumeCohorts,
  sealCohort,
  COHORT_LADDER,
  type Candidate,
  type Cohort,
  type CohortState,
} from "./cohorts.js";
import {
  arcPass,
  emptyArcPassReport,
  pendingArcEpisodes,
  ARC_PASS_LIMIT,
  type ArcPassReport,
} from "./arc-pass.js";
import { cl1ExtractStage, pendingExtractionEpisodes, projectCl1Calls } from "./cl1-runner.js";
import {
  emptyEntityReport,
  entityPass,
  pendingEntityWork,
  type EntityDrainReport,
} from "./entity-pass.js";
import {
  drainEpisodeQueue,
  enqueueEpisodePasses,
  ep2RunnerInvoke,
  type AsyncEp2Invoke,
  type Ep2Observer,
} from "./episode-pass.js";
import {
  cohortBudget,
  fillCohort,
  horizonLadder,
  modeAfterBackfill,
  paceCohort,
  type SessionSize,
} from "./horizons.js";
import { pendingStreamRosters, STREAM_ROSTER_LIMIT } from "./stream-participants.js";

// ---------------------------------------------------------------------------
// Mode + limits
// ---------------------------------------------------------------------------

export const BOOTSTRAP_MODES = ["off", "dry", "slice", "full"] as const;
export type BootstrapMode = (typeof BOOTSTRAP_MODES)[number];

export function isBootstrapMode(value: unknown): value is BootstrapMode {
  return typeof value === "string" && (BOOTSTRAP_MODES as readonly string[]).includes(value);
}

/** The opt-in, in `app_state`. Set it and the next tick picks the mode up. */
export const BOOTSTRAP_MODE_KEY = "bootstrap.mode";
/** The same opt-in from the environment, for a run started from a shell. */
export const BOOTSTRAP_MODE_ENV = "SUPERTWIN_BOOTSTRAP";

export interface BootstrapLimits {
  /**
   * Stop identity binding after N events. NOT a cost control — the stage cannot
   * bill — it is a LATENCY control: one tick should not sit on a 3,000-event
   * backlog when a cohort is waiting behind it. Whatever it does not reach this
   * tick is still `ready` on the queue for the next one.
   */
  maxEntityEvents?: number;
  /** Stop segmenting after N streams. */
  maxStreams?: number;
  /** Stop sealing after N new sessions. */
  maxSessions?: number;
  /** Stop after N cohorts reach `done` in one tick. */
  maxCohorts?: number;
  /** HARD cap on model calls across ALL stages of one tick. */
  maxLlmCalls?: number;
  /** Fixed at 1 — one cohort is in flight, ever (§9.4). */
  cohortConcurrency?: 1;
  /** Extraction fan-out inside a cohort (§13): 4 bootstrap, 2 steady. */
  extractParallelism?: number;
}

type ResolvedLimits = Required<Omit<BootstrapLimits, "cohortConcurrency">> & { cohortConcurrency: 1 };

/** Unbounded, but still a number — `Infinity` in a report reads as a bug. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * `slice` is the proving run: bounded on every axis, and small enough that its
 * worst case is a bill the user can look at without flinching. `full` is still
 * capped — an "unbounded" mode is how a corpus turns into an overnight spend.
 */
const LIMITS_BY_MODE: Record<BootstrapMode, ResolvedLimits> = {
  off: { maxEntityEvents: 0, maxStreams: 0, maxSessions: 0, maxCohorts: 0, maxLlmCalls: 0, cohortConcurrency: 1, extractParallelism: 0 },
  dry: { maxEntityEvents: UNBOUNDED, maxStreams: UNBOUNDED, maxSessions: UNBOUNDED, maxCohorts: UNBOUNDED, maxLlmCalls: 0, cohortConcurrency: 1, extractParallelism: 0 },
  // `slice` binds far more events than it segments streams on purpose: the
  // stage is free, and a slice whose roster is half-bound reproduces exactly
  // the mis-attribution the stage exists to prevent — on the run the user is
  // most likely to judge the whole pipeline by.
  slice: { maxEntityEvents: 5_000, maxStreams: 5, maxSessions: 25, maxCohorts: 2, maxLlmCalls: 40, cohortConcurrency: 1, extractParallelism: 4 },
  full: { maxEntityEvents: UNBOUNDED, maxStreams: UNBOUNDED, maxSessions: UNBOUNDED, maxCohorts: UNBOUNDED, maxLlmCalls: 400, cohortConcurrency: 1, extractParallelism: 4 },
};

function resolveLimits(mode: BootstrapMode, limits: BootstrapLimits = {}): ResolvedLimits {
  const base = LIMITS_BY_MODE[mode];
  const { maxEntityEvents, maxStreams, maxSessions, maxCohorts, maxLlmCalls, extractParallelism } = limits;
  return {
    // 0 is a legitimate cap here too ("do not bind anything this tick"), so it
    // is read the same way `maxLlmCalls` is rather than through `positive`.
    maxEntityEvents:
      typeof maxEntityEvents === "number" && maxEntityEvents >= 0 ? maxEntityEvents : base.maxEntityEvents,
    maxStreams: positive(maxStreams) ? maxStreams : base.maxStreams,
    maxSessions: positive(maxSessions) ? maxSessions : base.maxSessions,
    maxCohorts: positive(maxCohorts) ? maxCohorts : base.maxCohorts,
    // 0 is a legitimate cap ("no model calls at all"), so this one is not
    // `positive` — it is "a number was supplied".
    maxLlmCalls: typeof maxLlmCalls === "number" && maxLlmCalls >= 0 ? maxLlmCalls : base.maxLlmCalls,
    cohortConcurrency: 1,
    extractParallelism: positive(extractParallelism) ? extractParallelism : base.extractParallelism,
  };
}

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * `opts.mode` → `app_state` → env → `off`. NOTHING on the boot path may resolve
 * to `full` implicitly: a driver that starts a whole-corpus run because a row
 * was left behind in a settings table is the exact failure the opt-in exists to
 * prevent, so an unreadable or unknown value is `off`.
 */
export function resolveBootstrapMode(explicit?: BootstrapMode): BootstrapMode {
  if (explicit !== undefined) return explicit;
  let stored: string | null = null;
  try {
    stored = appStateGet(BOOTSTRAP_MODE_KEY);
  } catch {
    stored = null; // no DB yet — the env is still allowed to speak.
  }
  if (isBootstrapMode(stored)) return stored;
  const env = process.env[BOOTSTRAP_MODE_ENV];
  return isBootstrapMode(env) ? env : "off";
}

// ---------------------------------------------------------------------------
// Plan + report
// ---------------------------------------------------------------------------

export interface BootstrapPlan {
  /** Streams `backfillTiers` still owes a tier — §9.3 rule 4's regression. */
  streamsWithoutTier: number;
  /**
   * Events with no `actor_entity_id` that the identity stage would bind, capped
   * by the same `maxEntityEvents` the run is capped by — so this is what the
   * NEXT TICK does, not the size of the corpus.
   *
   * It carries no entry in `llmCallsProjected` because it buys nothing: rungs
   * ①/②/mint are `[CODE]` and rung ④ is parked (§10.3 rule 6). It is projected
   * anyway because "free" is not the same as "invisible" — an unbound backlog
   * is the difference between a claim attributed to the user and a claim
   * attributed to whoever was talking, and the user is entitled to see that
   * number before they decide whether the run is worth paying for.
   */
  eventsWithoutIdentity: number;
  /**
   * Streams holding a bound actor their stored `participant_entity_ids` lacks
   * — the roster/edge sweep at the tail of the identity stage. Free, like the
   * line above and for the same reason: a participant list is a fact the
   * source stated, so no entry in `llmCallsProjected`. Projected anyway
   * because it is what stands between the user and a populated Threads tab.
   */
  streamsWithoutRoster: number;
  /**
   * Episodes no arc ladder pass has decided. Free: rungs ①/② are `[CODE]` and
   * rung ④ is off this path (no adjudicator is injected), so `arcPass` cannot
   * bill. This is the number that becomes arcs, and therefore spaces.
   */
  episodesWithoutArc: number;
  /** Sessions the walk would seal that the DB does not have yet. */
  sessionsProjected: number;
  cohortsProjected: number;
  llmCallsProjected: { ti1: number; ep2: number; cl1: number; ag3: number };
  /** Billable — via `paceCohort`, never a raw token sum (§4.4.4.5). */
  billableTokensProjected: number;
}

export interface BootstrapReport extends BootstrapPlan {
  mode: BootstrapMode;
  tier: BackfillReport | null;
  /**
   * What the identity stage did, verbatim from `entityPass` — null when the
   * stage did not run (mode `off`/`dry`, or a zero cap). Reported as the whole
   * sub-report rather than as a bound count for the same reason `tier` is: the
   * numbers that matter downstream are `selfBound` (attribution works at all)
   * and `pairsDeferred` (merges nobody has decided yet), and a driver that
   * flattened those to one integer would hide the second one entirely.
   *
   * It is the SUM over the tick's chunks; see `foldEntity` for the one field
   * (`actorsResolved`) that a sum does not mean what a single drain's does.
   */
  identity: EntityDrainReport | null;
  /**
   * What the arc stage did, verbatim from `arcPass` — null when it did not run
   * (mode `off`/`dry`, or a tick that reached no cohort). `joined` and
   * `provisional` are both progress: the first surfaces immediately, the
   * second surfaces at the cohort boundary when reconcile commits it.
   */
  arcs: ArcPassReport | null;
  sessionsSealed: number;
  cohortsDone: string[];
  /**
   * BILLED provider calls, retries included — not logical invocations. One
   * budgeted P-EP2 call routinely costs two (`retried`, then `ok`), so a cap
   * counted per invocation bills roughly twice what it says.
   */
  llmCallsSpent: number;
  /** Watermark rows repaired by step A — the §5 backfill-flag backstop. */
  backfillFlagsRepaired: number;
  /**
   * Verdicts written this tick WITHOUT a model answer (`one_to_one_fallback`).
   * Any of these means the tick produced results the model never saw; the
   * cohort they belong to is paused rather than marked `done`, so nothing
   * downstream inherits them as if a model had agreed.
   */
  fallbackVerdicts: number;
  /**
   * Why the tick stopped. `provider_outage` is the loud one: the model was
   * asked and never answered (a missing registration, SPAWN_FAILED, a timeout
   * ladder that ran out), which the engine absorbs as a safe 1:1 fallback and
   * which therefore used to read as a perfectly healthy tick.
   */
  stoppedBy: "budget" | "no_work" | "stopped" | "error" | "provider_outage" | null;
  /** Every stage failure, with the unit that threw. Never swallowed. */
  errors: string[];
}

export interface BootstrapDriver {
  stop(): void;
  status(): BootstrapReport;
}

/**
 * What the extraction seam did: what it SPENT, and what went wrong.
 *
 * A bare call count is not enough, and for the same reason `Ep2CallOutcome`
 * exists: a stage that answers "0" because the corpus held no claims and one
 * that answers "0" because every P-CL1 call hit a dead provider are the same
 * number, and the second one must not let a cohort walk to `done`. Returning a
 * plain number is still accepted — a test fake has nothing to report.
 */
export interface ExtractOutcome {
  /** BILLED provider calls, retries included — charged to the tick's wallet. */
  calls: number;
  /** Every failure, verbatim. Each one lands on the tick's error list. */
  errors?: readonly string[];
}

/** The seams this module deliberately does not own. */
export interface BootstrapDeps {
  /** P-TI1 transport, handed to `ensureTiers`. Its own opt-in still gates it. */
  tierInvoke?: Ti1Invoke;
  /** P-EP2 transport. Defaults to the real runner; tests pass a fake. */
  invoke?: AsyncEp2Invoke;
  /**
   * P-CL1. The cohort's extraction stage, injected so this module never owns a
   * prompt: `cl1ExtractStage()` (scheduler/cl1-runner.ts) is the production
   * implementation, defaulted in by `startBootstrapDriver`, and a test passes a
   * fake. Reports the model calls it spent — charged to the same budget every
   * other stage draws on — and, via {@link ExtractOutcome}, the failures the
   * tick would otherwise never hear about.
   */
  extract?: (input: {
    cohort: Cohort;
    sessionIds: readonly string[];
    budget: number;
    now: number;
  }) => Promise<number | ExtractOutcome> | number | ExtractOutcome;
}

function emptyPlan(): BootstrapPlan {
  return {
    streamsWithoutTier: 0,
    eventsWithoutIdentity: 0,
    streamsWithoutRoster: 0,
    episodesWithoutArc: 0,
    sessionsProjected: 0,
    cohortsProjected: 0,
    llmCallsProjected: { ti1: 0, ep2: 0, cl1: 0, ag3: 0 },
    billableTokensProjected: 0,
  };
}

function emptyReport(mode: BootstrapMode): BootstrapReport {
  return {
    ...emptyPlan(),
    mode,
    tier: null,
    identity: null,
    arcs: null,
    sessionsSealed: 0,
    cohortsDone: [],
    llmCallsSpent: 0,
    backfillFlagsRepaired: 0,
    fallbackVerdicts: 0,
    stoppedBy: null,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Stream reads — the same shape `server/sessions-routes.ts` walks with
// ---------------------------------------------------------------------------

interface StreamRow {
  id: string;
  source_id: string | null;
  external_key: string | null;
  label: string | null;
  stream_kind: string | null;
  tz: string | null;
  segmentation_override_json: string | null;
  actor_model: string | null;
}

interface EventRow {
  id: string;
  external_id: string | null;
  ts: string | null;
  actor_id: string | null;
  actor_entity_id: string | null;
  actor_raw: string | null;
  kind: string | null;
  text: string | null;
  media_description: string | null;
  transcript: string | null;
  link_scraped_text: string | null;
  reply_to_external_id: string | null;
  ts_end: string | null;
  salience: number | null;
}

/**
 * Streams with events past their newest session — the only ones a walk can
 * produce anything for. Ordered tier-first then recency, so a `slice` run
 * spends its stream budget where §9.3 says the value is.
 *
 * `MAX(e.ts)` versus the newest session's end is the whole "is there anything
 * left" test: it is a property of the rows, so an interrupted run re-derives
 * exactly the same answer on the next tick.
 */
function streamsNeedingSessions(limit: number): StreamRow[] {
  if (limit <= 0) return [];
  return getDb()
    .prepare(
      `SELECT st.id, st.source_id, st.external_key, st.label, st.stream_kind, st.tz,
              st.segmentation_override_json, so.actor_model AS actor_model
         FROM streams st
         LEFT JOIN sources so ON so.id = st.source_id
        WHERE EXISTS (SELECT 1 FROM events e WHERE e.stream_id = st.id)
          AND (SELECT MAX(e.ts) FROM events e WHERE e.stream_id = st.id) >
              COALESCE((SELECT MAX(COALESCE(s.ended_at, s.started_at)) FROM sessions s
                         WHERE s.stream_id = st.id), '')
        ORDER BY COALESCE(st.tier, 'T9'),
                 (SELECT MAX(e.ts) FROM events e WHERE e.stream_id = st.id) DESC,
                 st.id
        LIMIT ?`,
    )
    .all(Math.min(limit, UNBOUNDED)) as StreamRow[];
}

/** Which of the five shapes this lane is (§2.1) — the manifest owns the answer. */
function kindOf(stream: StreamRow): StreamKind {
  const manifest = stream.source_id ? getManifest(stream.source_id) : undefined;
  if (manifest) {
    return manifest.stream_kind_of({
      external_key: stream.external_key ?? stream.id,
      kind: stream.stream_kind ?? undefined,
      label: stream.label ?? undefined,
    });
  }
  return isStreamKind(stream.stream_kind) ? stream.stream_kind : "conversation";
}

/** The policy this lane is segmented by, per-stream override included. */
function policyFor(stream: StreamRow): SessionPolicy {
  const manifest = stream.source_id ? getManifest(stream.source_id) : undefined;
  return resolvePolicy({
    kind: kindOf(stream),
    segmentation: manifest?.segmentation ?? null,
    lane: stream.stream_kind,
    override: parseOverride(stream.segmentation_override_json),
    actor_model: stream.actor_model === "single_actor" ? "single_actor" : "multi_actor",
  });
}

/** One stream's events in `ts` order — never rowid, never `ingested_at` (§3.3 rule 8). */
function streamEvents(streamId: string): EventRow[] {
  return getDb()
    .prepare(
      `SELECT id, external_id, ts, actor_id, actor_entity_id, actor_raw, kind, text,
              media_description, transcript, link_scraped_text, reply_to_external_id,
              ts_end, salience
         FROM events WHERE stream_id = ? ORDER BY ts, id`,
    )
    .all(streamId) as EventRow[];
}

/** Enrichment text is inside the size cap AND the content hash (§10.4). */
function toSegEvent(row: EventRow): SegEvent {
  return {
    external_id: row.external_id ?? row.id,
    ts: row.ts ?? "",
    actor: row.actor_entity_id ?? row.actor_id ?? row.actor_raw ?? "unknown",
    kind: row.kind ?? "message",
    text: row.text ?? "",
    enrichment_text: row.transcript ?? row.media_description ?? row.link_scraped_text ?? undefined,
    reply_to_external_id: row.reply_to_external_id,
    ts_end: row.ts_end,
    salience: row.salience ?? undefined,
  };
}

interface WalkResult {
  sealed: SegSession[];
  /** `external_id → events.id`; `sessions.event_ids` stores DB ids. */
  dbIdByExternal: Map<string, string>;
}

/**
 * The bootstrap walk over one stream. PURE — no writes — so `planBootstrap`
 * and the real run share it and a dry run cannot disagree with the run it
 * predicted.
 */
function walkStream(stream: StreamRow, now: number): WalkResult {
  const rows = streamEvents(stream.id).filter((r) => !isDroppedAtAdapter(r.kind ?? "message"));
  const events = rows.map(toSegEvent);
  const policy = policyFor(stream);
  const walked = segment({
    stream: { key: stream.id, tz: stream.tz ?? "UTC", source_id: stream.source_id ?? undefined },
    policy,
    events,
    run_mode: "bootstrap",
  });
  const done = sealStream(
    walked.sessions,
    { policy, run_mode: "bootstrap", now },
    textIndex(events.map((e) => ({ external_id: e.external_id, text: e.text, enrichment_text: e.enrichment_text }))),
  );
  return {
    sealed: done.sessions.filter((s) => s.status === "sealed"),
    dbIdByExternal: new Map(rows.map((r) => [r.external_id ?? r.id, r.id])),
  };
}

/**
 * Persist the sealed sessions of one walk.
 *
 * `ON CONFLICT(id) DO NOTHING` is what makes the whole driver re-runnable:
 * `SegSession.id` is derived from (stream, start instant, first event), so a
 * re-walk of unchanged events produces byte-identical ids and the second run
 * writes nothing. A sealed session's membership is IMMUTABLE (§10.4), so the
 * conflict branch must never be an UPDATE — the re-cut path
 * (`/api/streams/:id/segmentation/apply`) is the only thing allowed to move a
 * boundary, and it deletes first.
 */
function insertSealedSessions(stream: StreamRow, walk: WalkResult, budget: number): number {
  if (budget <= 0) return 0;
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, tz, event_ids,
                           participant_entity_ids, boundary_reason_start, boundary_reason_end,
                           boundary_params_json, seal_mode, content_hash, superseded_hash,
                           hash_version, status, sealed_at, late_arrival, overlap_of)
     VALUES (@id, @streamId, @sourceId, @startedAt, @endedAt, @tz, @eventIds, @participants,
             @boundaryStart, @boundaryEnd, @boundaryParams, @sealMode, @contentHash,
             @supersededHash, @hashVersion, 'sealed', @sealedAt, @lateArrival, @overlapOf)
     ON CONFLICT(id) DO NOTHING`,
  );
  let written = 0;
  db.transaction(() => {
    for (const s of walk.sealed) {
      // The budget counts ROWS WRITTEN, not rows attempted: a re-run whose
      // first twenty sessions already exist must still reach the new ones.
      if (written >= budget) break;
      const memberDbIds = s.event_ids
        .map((ext) => walk.dbIdByExternal.get(ext))
        .filter((v): v is string => v !== undefined);
      if (memberDbIds.length === 0) continue;
      const info = insert.run({
        id: s.id,
        streamId: stream.id,
        sourceId: s.source_id ?? stream.source_id,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        tz: s.tz,
        eventIds: JSON.stringify(memberDbIds),
        // Entity ids, because step B2 ran first: `toSegEvent` prefers
        // `actor_entity_id` and the identity stage has filled it for every
        // event the tick reached. An actor id here now means the ladder could
        // not bind that actor at all (no `source_ext_id`) — a fact worth
        // keeping, not a placeholder to overwrite: this driver still never
        // mints an entity behind the ladder's back.
        participants: JSON.stringify([...new Set(s.actors)].sort()),
        boundaryStart: s.boundary_reason_start,
        boundaryEnd: s.boundary_reason_end,
        boundaryParams: JSON.stringify(s.boundary_params),
        sealMode: s.seal_mode,
        contentHash: s.content_hash,
        supersededHash: s.superseded_hash,
        hashVersion: s.hash_version,
        sealedAt: s.sealed_at,
        lateArrival: s.late_arrival ? 1 : 0,
        overlapOf: s.overlap_of,
      });
      written += info.changes;
    }
  })();
  return written;
}

/** Sessions of this walk the DB does not have — what a dry run projects. */
function unwrittenSessions(walk: WalkResult): SegSession[] {
  const db = getDb();
  const seen = db.prepare(`SELECT 1 AS ok FROM sessions WHERE id = ?`);
  return walk.sealed.filter((s) => seen.get(s.id) === undefined);
}

// ---------------------------------------------------------------------------
// Step A — the backfill-flag backstop (§5)
// ---------------------------------------------------------------------------

/**
 * `markSourceBackfillComplete` ran BEFORE the last streams existed on this
 * install: the daemon's `backfill_complete` edge landed at 14:43:44 and the
 * newest stream row was created at 14:45:20, so 93 watermark rows still read
 * `backfill_complete = 0` and `modeAfterBackfill` answers "bootstrap" forever.
 * The ingest side now re-seals on a debounce; this is the crash-safe backstop
 * for the window between the edge and that timer, and it is free: one indexed
 * UPDATE per stream of a source whose import is already done.
 */
function repairBackfillFlags(): number {
  const db = getDb();
  const sources = db.prepare(`SELECT id FROM sources`).all() as { id: string }[];
  let repaired = 0;
  for (const { id } of sources) {
    if (appStateGet(importDoneKey(id)) !== "true") continue;
    const before = db
      .prepare(
        `SELECT COUNT(*) AS n FROM watermarks w JOIN streams s ON s.id = w.stream_id
          WHERE s.source_id = ? AND w.backfill_complete = 0`,
      )
      .get(id) as { n: number };
    if (before.n === 0) continue;
    markSourceBackfillComplete(id);
    repaired += before.n;
  }
  return repaired;
}

// ---------------------------------------------------------------------------
// Step B2 — identity binding (§10.3)
// ---------------------------------------------------------------------------

/**
 * How many events one `entityPass` sweeps and drains. Matches the drainer's own
 * default: a chunk is a claim/settle unit, so a smaller one loses less to a
 * kill -9 and a larger one saves nothing measurable (the whole 3,141-row
 * backlog binds in ~1.3s).
 */
const ENTITY_CHUNK = 256;

/**
 * Ceiling on how many pending ids a PROJECTION will materialise. A plan makes
 * no writes and must also make no work: `full` caps the stage at
 * MAX_SAFE_INTEGER, and `SELECT ... LIMIT 9007199254740991` over a large corpus
 * is a plan that costs more than the tick it describes.
 */
const MAX_PROJECTED_ENTITY_EVENTS = 100_000;

/** How many entity errors reach `report.errors` verbatim before they are summarised. */
const ENTITY_ERROR_SAMPLE = 5;

function foldEntity(total: EntityDrainReport, pass: EntityDrainReport): void {
  total.claimed += pass.claimed;
  total.bound += pass.bound;
  // ⚠ READ THIS AS LADDER WALKS, NOT AS DISTINCT ACTORS. `drainEntityQueue`
  // memoises one resolution per actor per CALL, so an actor that speaks in two
  // chunks is walked twice and this sum exceeds the actor count (the real
  // backlog: 187 walks over 100 actors, 13 chunks). Every repeat is a rung ①
  // exact hit on an indexed identity row — free, and it mints nothing, so
  // `minted` stays exact and is the number to trust for "how many are new".
  total.actorsResolved += pass.actorsResolved;
  total.minted += pass.minted;
  total.selfBound += pass.selfBound;
  // Not summed: the same sources are re-bound on every chunk (`bindSelfIdentities`
  // is idempotent and runs once per drain), so adding them would report four
  // WhatsApp accounts where there is one.
  total.selfSources = Math.max(total.selfSources, pass.selfSources);
  total.unbound += pass.unbound;
  total.orphaned += pass.orphaned;
  total.pairsDeferred += pass.pairsDeferred;
  total.pairsQueued += pass.pairsQueued;
  // Summed like the rest: the roster sweep's own pending query empties on the
  // first chunk, so chunks 2..n contribute zero and the sum is the pass's real
  // total. Left unfolded, `report.identity.rosters` read 0 on every multi-chunk
  // tick while 93 rosters were being written underneath it.
  total.rosters.streams += pass.rosters.streams;
  total.rosters.groups += pass.rosters.groups;
  total.rosters.participants += pass.rosters.participants;
  total.rosters.edgesAsserted += pass.rosters.edgesAsserted;
  total.rosters.errors.push(...pass.rosters.errors);
  total.errors.push(...pass.errors);
}

/**
 * Bind identities until the backlog is empty, the cap is spent, or the driver
 * is asked to stop.
 *
 * Chunked rather than one enormous claim so that `shouldStop` is honoured
 * between units and a crash leaves at most `ENTITY_CHUNK` rows in `running` for
 * `resumeQueue` to hand back. Termination is on `claimed === 0`, which is a
 * property of the queue rather than of the loop's arithmetic: a chunk that
 * settles rows without binding any (orphans, actor-less events) still makes
 * progress, and one that claims nothing has nothing left to make progress on.
 *
 * Spends nothing. It is deliberately NOT handed the wallet — there is no
 * parameter for it to spend through, so the free-stage guarantee survives a
 * later edit to this function.
 */
function bindIdentitiesStage(limit: number, now: number, report: BootstrapReport, stopped: () => boolean): void {
  if (limit <= 0) return;
  const total = emptyEntityReport();
  let room = limit;
  let sampled = 0;

  while (room > 0 && !stopped()) {
    let pass: EntityDrainReport;
    try {
      // `entityPass` sweeps THEN drains, and its sweep dedupes on the real key
      // `(stage, unit_kind, unit_id)` — so the rows `tiers/rescan.ts` has been
      // filing since item 1.2 are claimed, not duplicated, and no event is
      // bound twice.
      pass = entityPass({ limit: Math.min(room, ENTITY_CHUNK), now, mode: "bootstrap", runId: null });
    } catch (err) {
      note(report, "entity", "-", err);
      break;
    }
    foldEntity(total, pass);
    if (pass.claimed === 0) break;
    room -= pass.claimed;
  }

  report.identity = total;
  for (const err of total.errors) {
    if (sampled >= ENTITY_ERROR_SAMPLE) break;
    note(report, "entity", "-", new Error(err));
    sampled += 1;
  }
  if (total.errors.length > sampled) {
    // The count is on the report either way; what this refuses to do is let a
    // 300-error drain read as a 5-error one.
    note(
      report,
      "entity",
      "-",
      new Error(`${total.errors.length - sampled} further identity error(s) — see report.identity.errors`),
    );
  }
  // `rosters.streams` is in the gate because a fully-bound install claims
  // nothing and still writes 93 rosters — the same "silent counter" the whole
  // build has been undoing.
  if (total.claimed > 0 || total.rosters.streams > 0 || total.errors.length > 0) {
    log(
      `identity claimed=${total.claimed} bound=${total.bound} self=${total.selfBound} ` +
        `actors=${total.actorsResolved} minted=${total.minted} unbound=${total.unbound} ` +
        `orphaned=${total.orphaned} pairs=${total.pairsDeferred}+${total.pairsQueued} ` +
        `rosters=${total.rosters.streams} edges=${total.rosters.edgesAsserted} ` +
        `llm=${total.llmCalls} errors=${total.errors.length}`,
    );
  }
}

/**
 * Place every undecided episode on the arc ladder — stage L5, between L4's
 * episodes and L6's understanding.
 *
 * Spends nothing, and like `bindIdentitiesStage` it is deliberately NOT handed
 * the wallet: there is no parameter for it to spend through, so the free-stage
 * guarantee survives a later edit. `batchId` is the cohort's id so that the
 * `reconcileAfterTransition` fired when this cohort reaches `done` commits
 * exactly the provisionals this pass parked (§11.2's two-phase boundary).
 *
 * Folded across cohorts rather than overwritten: two cohorts in one tick each
 * place episodes, and a report that kept only the last one would understate
 * the tick that finally filled the Threads tab.
 */
function placeArcs(cohortId: string, report: BootstrapReport): void {
  let pass: ArcPassReport;
  try {
    pass = arcPass({ batchId: cohortId, runId: cohortId });
  } catch (err) {
    note(report, "arcs", cohortId, err);
    return;
  }
  const total = report.arcs ?? emptyArcPassReport();
  total.episodes += pass.episodes;
  total.joined += pass.joined;
  total.provisional += pass.provisional;
  total.questions += pass.questions;
  total.errors.push(...pass.errors);
  report.arcs = total;
  for (const err of pass.errors) note(report, "arcs", cohortId, new Error(err));
}

// ---------------------------------------------------------------------------
// The plan — pure, zero calls, zero writes
// ---------------------------------------------------------------------------

/**
 * How many P-TI1 calls the tier stage would buy. Zero unless the model was
 * opted into (`tierModelEnabled` is OFF by default), and the batching is
 * `chunkChannels`' own — ≤ 10 channels per call, §12.11 — rather than a second
 * arithmetic that can drift from it.
 */
function projectTi1Calls(): number {
  if (!tierModelEnabled()) return 0;
  const channels = ambiguousChannels();
  if (channels.length === 0) return 0;
  return Math.min(chunkChannels(channels).length, DEFAULT_MAX_MODEL_CALLS);
}

/** Sealed sessions no cohort has claimed, newest horizon first. */
function unclaimedCandidates(now: number): Candidate[] {
  const out: Candidate[] = [];
  for (const horizon of horizonLadder()) {
    out.push(...candidateSessions({ mode: "bootstrap", horizon, now }));
  }
  return out;
}

/** How many `cohorts` rows this mode already sealed — the `cohortBudget` ramp. */
function bootstrapCohortSeq(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM cohorts WHERE mode = 'bootstrap'`).get() as {
    n: number;
  };
  return row.n;
}

/** Sessions with no episode verdict — the ones P-EP2 would actually be asked about. */
function unjudged(sessionIds: readonly string[]): string[] {
  if (sessionIds.length === 0) return [];
  const db = getDb();
  const has = db.prepare(`SELECT 1 AS ok FROM episode_verdicts WHERE session_id = ?`);
  return sessionIds.filter((id) => has.get(id) === undefined);
}

/**
 * What a run WOULD do. Makes no provider call and writes no row — this is the
 * number the user gets to look at before they opt in to spending anything.
 *
 * The projection walks the same `segment`/`sealStream`/`fillCohort` code the
 * run does, so it is a rehearsal rather than an estimate: the only reason the
 * two can disagree is new events arriving in between.
 */
export function planBootstrap(limits: BootstrapLimits = {}, opts: { now?: number } = {}): BootstrapPlan {
  const now = opts.now ?? Date.now();
  const resolved = resolveLimits("full", limits);
  const plan = emptyPlan();

  plan.streamsWithoutTier = tierCoverage().unassigned.length;
  plan.llmCallsProjected.ti1 = projectTi1Calls();

  // The identity stage, projected off the SAME query the drain sweeps with
  // (`pendingEntityWork`) and the same cap the drain runs under — a rehearsal
  // rather than a second count that can drift from it. `limit` is clamped
  // because the projection materialises ids: at `full` the cap is
  // MAX_SAFE_INTEGER, and a plan is not allowed to be the expensive part.
  plan.eventsWithoutIdentity =
    resolved.maxEntityEvents <= 0
      ? 0
      : pendingEntityWork({ limit: Math.min(resolved.maxEntityEvents, MAX_PROJECTED_ENTITY_EVENTS) }).length;

  // The two free derivation stages, projected off the SAME pending queries the
  // stages sweep with. Both are capped by their own stage constant rather than
  // by `maxEntityEvents`, because that is the cap the stage really runs under —
  // a plan that promised 93 rosters from a stage that does 256 at a time would
  // be describing a different run.
  plan.streamsWithoutRoster =
    resolved.maxEntityEvents <= 0 ? 0 : pendingStreamRosters({ limit: STREAM_ROSTER_LIMIT }).length;
  plan.episodesWithoutArc = pendingArcEpisodes({ limit: ARC_PASS_LIMIT }).length;

  // Projected sessions: the real walk, nothing written.
  const projected: SessionSize[] = [];
  let sessionRoom = resolved.maxSessions;
  for (const stream of streamsNeedingSessions(resolved.maxStreams)) {
    if (sessionRoom <= 0) break;
    const fresh = unwrittenSessions(walkStream(stream, now)).slice(0, sessionRoom);
    sessionRoom -= fresh.length;
    plan.sessionsProjected += fresh.length;
    for (const s of fresh) projected.push({ id: s.id, eventCount: s.event_count, charCount: s.chars });
  }

  // Projected cohorts: the ramp applied to (already sealed + about to be
  // sealed), filled by the same `fillCohort` the sealer uses.
  const pool: SessionSize[] = [
    ...unclaimedCandidates(now).map((c) => ({ id: c.id, eventCount: c.eventCount, charCount: c.charCount })),
    ...projected,
  ];
  let seq = bootstrapCohortSeq();
  let remaining = pool;
  let inputTokens = 0;
  let outputTokens = 0;
  const cohortSessionIds: string[] = [];
  while (remaining.length > 0 && plan.cohortsProjected < resolved.maxCohorts) {
    const fill = fillCohort(remaining, cohortBudget(seq));
    if (fill.taken.length === 0) break;
    plan.cohortsProjected += 1;
    inputTokens += fill.inputTokens;
    outputTokens += fill.outputTokens;
    for (const s of fill.taken) cohortSessionIds.push(s.id);
    const taken = new Set(fill.taken.map((s) => s.id));
    remaining = remaining.filter((s) => !taken.has(s.id));
    seq += 1;
  }

  // P-EP2 is one call per not-yet-judged session; a session already in the
  // DB with a verdict costs nothing (the hash gate), and a projected session
  // has no verdict by construction.
  const known = new Set(pool.map((s) => s.id));
  const claimed = cohortSessionIds.filter((id) => known.has(id));
  plan.llmCallsProjected.ep2 = unjudged(claimed).length;

  // P-CL1 is the DOMINANT cost of the pipeline, so this number is the one the
  // user actually decides on — an UNDER-projection here is a real harm, and it
  // is deliberately an upper bound. Two sources of episodes:
  //
  //   * episodes already in the DB with nothing extracted out of them yet, and
  //   * episodes this run's P-EP2 pass is about to create. The engine emits AT
  //     MOST one new episode per unjudged session (an attach makes zero), so
  //     the ep2 count above is exactly that ceiling.
  //
  // `projectCl1Calls` applies §12.4's own batching (`cl1Batches`, ≤4 episodes
  // per call) rather than a second arithmetic that can drift from it.
  plan.llmCallsProjected.cl1 = projectCl1Calls(
    pendingExtractionEpisodes({ sessionIds: claimed }).length + plan.llmCallsProjected.ep2,
  );
  // P-AG3 fires only on a near hit, and a near hit needs the calibrated [ML]
  // `claim_text` rung. Nothing writes `claim_embeddings` yet, so the rung is
  // blocked, `defaultNearCandidates` offers no candidate and a run provably
  // buys zero adjudications. This 0 is a fact, not a placeholder.
  plan.llmCallsProjected.ag3 = 0;

  // Billable, not summed: `paceCohort` owns the cache-weighted formula
  // (§4.4.4.5). The window is left unbounded because a projection is not an
  // admission decision — the run's own `maxLlmCalls` is the cost control.
  plan.billableTokensProjected = paceCohort({
    inputTokens,
    outputTokens,
    spentInWindow: 0,
    windowLimit: UNBOUNDED,
    windowRemainingMs: 0,
  }).billable;
  return plan;
}

// ---------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------

export interface BootstrapTickOptions {
  mode: BootstrapMode;
  limits?: BootstrapLimits;
  now?: number;
  deps?: BootstrapDeps;
  /** The driver's stop flag — checked between units, never mid-write. */
  shouldStop?: () => boolean;
}

/** The one place a model call is charged. Nothing else may spend. */
interface Wallet {
  spent: number;
  cap: number;
}

function remainingCalls(wallet: Wallet): number {
  return Math.max(0, wallet.cap - wallet.spent);
}

function log(line: string): void {
  console.error(`[bootstrap] ${line}`);
}

function note(report: BootstrapReport, stage: string, unit: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  report.errors.push(`${stage}(${unit}): ${message}`);
  // Loud on purpose: `startEpisodeClock`'s silent catch is how a pipeline that
  // never ran looked healthy for a whole build.
  log(`ERROR stage=${stage} unit=${unit} — ${message}`);
}

/**
 * One pass over everything that is outstanding, in dependency order.
 *
 * The order is not a preference: cohorts draw from `sessions` joined to
 * `streams.tier`, so a tick that segmented before tiering would plan cohorts
 * out of §9.3 order, and `rescanOnTierChange` would then have to re-price work
 * that had already been claimed.
 */
export async function runBootstrapTick(opts: BootstrapTickOptions): Promise<BootstrapReport> {
  const mode = opts.mode;
  const now = opts.now ?? Date.now();
  const limits = resolveLimits(mode, opts.limits);
  const deps = opts.deps ?? {};
  const report = emptyReport(mode);
  const wallet: Wallet = { spent: 0, cap: limits.maxLlmCalls };
  const stopped = (): boolean => opts.shouldStop?.() === true;

  // ---- A. the free repair, in EVERY mode including `off`.
  try {
    report.backfillFlagsRepaired = repairBackfillFlags();
  } catch (err) {
    note(report, "backfill_flags", "-", err);
  }
  if (mode === "off") return report;

  // ---- the projection. `dry` stops here, having written nothing.
  try {
    // The RESOLVED limits, not the caller's: a slice run must project the slice
    // it is about to do, not the whole corpus.
    Object.assign(report, planBootstrap(limits, { now }), {
      mode,
      backfillFlagsRepaired: report.backfillFlagsRepaired,
      errors: report.errors,
    });
  } catch (err) {
    note(report, "plan", "-", err);
    report.stoppedBy = "error";
    return report;
  }
  if (mode === "dry") return report;

  // ---- A2. THE PROVIDER MUST EXIST BEFORE ANYTHING IS ALLOWED TO SPEND.
  //
  // `register(claudeLocalProvider)` lives in index.ts's `main()`, not here, so
  // a driver started any other way (a script, a test harness, an integrator's
  // own entry point) has an EMPTY registry. Every P-EP2 call then fails with
  // SPAWN_FAILED, `ep2RunnerInvoke` hands the engine a null, the engine reads
  // that as its safe 1:1 fallback — and the tick reports `errors: []`,
  // `stoppedBy: null` and a cohort marked `done` over verdicts no model ever
  // saw. That has already happened once on this build.
  //
  // Refuse instead, before the first dollar. An injected `invoke` is the
  // stated exception: the caller has supplied its own transport and the
  // registry is not what it goes through.
  if (limits.maxLlmCalls > 0 && deps.invoke === undefined && getProvider(DEFAULT_PROVIDER_ID) === undefined) {
    note(
      report,
      "provider",
      DEFAULT_PROVIDER_ID,
      new Error(
        `provider "${DEFAULT_PROVIDER_ID}" is not registered — call register(claudeLocalProvider) ` +
          `before starting the driver (worker/src/index.ts does this in main()). Refusing to run: ` +
          `every model call would fail and every verdict would silently be a model-free fallback`,
      ),
    );
    report.stoppedBy = "provider_outage";
    return report;
  }

  // ---- B. tiers, through `ensureTiers` — the tier layer owns its own model
  // opt-in, its own batching and its own coverage assertion, and it never
  // throws. This tick's only additions are the gate (nothing to do → one
  // `SELECT id, tier FROM streams`) and the wallet: whatever P-TI1 spent here
  // is unavailable to the understanding rung below.
  //
  // Vacuously complete on a cold install (zero streams), which is exactly why
  // the boot-time call alone was never enough (§9.3 rule 4).
  if (tierCoverage().unassigned.length > 0) {
    const ensured = await ensureTiers({
      now,
      reason: "bootstrap_tick",
      // A ceiling, never a floor: the tier layer's own key may ask for fewer.
      maxModelCalls: Math.min(remainingCalls(wallet), DEFAULT_MAX_MODEL_CALLS),
      ...(deps.tierInvoke === undefined ? {} : { invoke: deps.tierInvoke }),
    });
    report.tier = ensured.report;
    wallet.spent += ensured.modelCalls;
    if (!ensured.ok && ensured.error !== null) note(report, "tier", "-", ensured.error);
    log(
      `tier assigned=${ensured.assigned}/${ensured.streams} ambiguous=${ensured.ambiguous} ` +
        `cached=${ensured.cached} calls=${ensured.modelCalls} defaulted=${ensured.defaulted} ` +
        `coverage=${ensured.coverage}`,
    );
  }
  if (stopped()) {
    report.stoppedBy = "stopped";
    return report;
  }

  // ---- B2. IDENTITY. After tiers (queue priority is computed off the stream's
  // tier) and before sessions (`toSegEvent` reads `actor_entity_id`, and a
  // sealed session's participants are immutable) — and therefore before the
  // extract stage, whose roster is the thing this exists for. Free by
  // construction: no wallet is passed, and none can be spent.
  //
  // The projection above deliberately still runs FIRST, because `dry` has to
  // return before any write. On a stream segmented by `author_shift` that makes
  // the first tick's `sessionsProjected` a pre-binding rehearsal and the run a
  // post-binding one, so the two can differ by a boundary; from the second tick
  // on there is nothing left to bind and they agree again. Session IDS do not
  // move either way — `sessionIdOf` is (stream, instant, first event).
  bindIdentitiesStage(limits.maxEntityEvents, now, report, stopped);
  if (stopped()) {
    report.stoppedBy = "stopped";
    return report;
  }

  // ---- C. sessions. Per stream so an interruption loses at most one walk.
  let sessionRoom = limits.maxSessions;
  for (const stream of streamsNeedingSessions(limits.maxStreams)) {
    if (sessionRoom <= 0 || stopped()) break;
    try {
      const written = insertSealedSessions(stream, walkStream(stream, now), sessionRoom);
      sessionRoom -= written;
      report.sessionsSealed += written;
    } catch (err) {
      note(report, "segment", stream.id, err);
    }
  }
  if (report.sessionsSealed > 0) log(`sealed ${report.sessionsSealed} session(s)`);
  if (stopped()) {
    report.stoppedBy = "stopped";
    return report;
  }

  // ---- C2. THE ARC BACKLOG, and the reconcile that surfaces it.
  //
  // Stage L5 inside `understandCohort` covers every episode THIS tick makes.
  // It does not cover the install that already ran: on a database whose cohorts
  // are all `done`, neither `resumeCohorts` nor `planNextCohort` fires, no
  // cohort reaches the understanding rung, and the 9 episodes already sitting
  // there would never be placed. That is the exact defect this stage exists to
  // undo, so the wiring must not reintroduce it — pending is a property of the
  // rows, and the tick sweeps them whether or not a cohort ran.
  //
  // BEFORE D/E, NOT AFTER, and the reason is money. Every stopping path in the
  // cohort ladder — budget, provider outage, error — RETURNS out of this
  // function. A free stage placed behind them is a free stage the user only
  // gets when they can afford the paid ones, which is precisely backwards: the
  // first thing a run out of budget should still deliver is the derivation that
  // costs nothing. Fresh episodes are covered per cohort a few lines down, so
  // running the backlog first loses nothing.
  //
  // `onArcChange` is the designed commit trigger for provisionals that arrive
  // outside a cohort boundary (§8.1's "on change"): it refuses when nothing is
  // pending, coalesces so a tick every 60 s cannot re-run the whole table, and
  // funnels into the same `runReconcile` — one run id, one undo.
  if (pendingArcEpisodes({ limit: 1 }).length > 0) {
    placeArcs("backlog", report);
    try {
      onArcChange({ now, mode: "bootstrap" });
    } catch (err) {
      note(report, "reconcile", "backlog", err);
    }
    if (stopped()) {
      report.stoppedBy = "stopped";
      return report;
    }
  }

  // ---- D. in-flight cohorts FIRST (§9.7 rule 5). A cohort caught mid-ladder
  // is re-entered at the rung it was on; nothing before it is redone.
  for (const resume of resumeCohorts()) {
    if (report.cohortsDone.length >= limits.maxCohorts || stopped()) break;
    const cohort = readCohort(resume.id);
    if (cohort === null) continue;
    log(`resume cohort=${cohort.id} from=${resume.resumeFrom} at=${resume.resumeAt}`);
    const outcome = await runCohortForward(cohort, { now, wallet, deps, report });
    if (outcome !== null) {
      report.llmCallsSpent = wallet.spent;
      report.stoppedBy = outcome;
      return report;
    }
  }

  // ---- E. new cohorts, newest horizon first.
  while (report.cohortsDone.length < limits.maxCohorts && !stopped()) {
    const cohort = planNextCohort(now, report);
    if (cohort === null) break;
    const outcome = await runCohortForward(cohort, { now, wallet, deps, report });
    if (outcome !== null) {
      report.llmCallsSpent = wallet.spent;
      report.stoppedBy = outcome;
      return report;
    }
  }

  report.llmCallsSpent = wallet.spent;
  if (
    report.stoppedBy === null &&
    report.sessionsSealed === 0 &&
    report.cohortsDone.length === 0 &&
    // Binding 3,000 events IS work. Without this clause the tick that finally
    // fixed attribution would report `no_work` — the same class of lying
    // counter as the `[cl1] claims=0` line that hid 13 written claims. The
    // roster sweep and the arc pass are in the clause for the same reason:
    // both write rows on an install that claims and seals nothing.
    (report.identity?.bound ?? 0) === 0 &&
    (report.identity?.rosters.streams ?? 0) === 0 &&
    (report.arcs?.episodes ?? 0) === 0
  ) {
    // A tick that achieved nothing says WHY: an idle pipeline with work
    // outstanding is §9.7 rule 1's defect, and "no_work" is the only innocent
    // reason for one.
    report.stoppedBy = report.errors.length > 0 ? "error" : "no_work";
  }
  if (stopped()) report.stoppedBy = "stopped";
  log(
    `tick mode=${mode} identity=${report.identity?.bound ?? 0} ` +
      `rosters=${report.identity?.rosters.streams ?? 0} sessions=${report.sessionsSealed} ` +
      `arcs=${report.arcs?.joined ?? 0}+${report.arcs?.provisional ?? 0} ` +
      `cohorts=${report.cohortsDone.length} ` +
      `llm=${report.llmCallsSpent}/${limits.maxLlmCalls} fallbacks=${report.fallbackVerdicts} ` +
      `stopped=${report.stoppedBy ?? "-"} errors=${report.errors.length}`,
  );
  return report;
}

/**
 * Seal the next cohort off the candidate ladder, or null when nothing is due.
 *
 * `seq` is read from the DB (`COUNT(*) WHERE mode='bootstrap'`) so the
 * `cohortBudget` ramp survives a restart: an install that has already run three
 * cohorts must not re-enter at cohort 0's first-paint budget.
 */
function planNextCohort(now: number, report: BootstrapReport): Cohort | null {
  for (const horizon of horizonLadder()) {
    let candidates: Candidate[];
    try {
      candidates = candidateSessions({ mode: "bootstrap", horizon, now });
    } catch (err) {
      note(report, "candidates", horizon, err);
      return null;
    }
    if (candidates.length === 0) continue;
    try {
      const seq = bootstrapCohortSeq();
      const cohort = sealCohort({ mode: "bootstrap", horizon, seq, now, candidates });
      if (cohort.sessionIds.length === 0) continue;
      log(
        `sealed cohort=${cohort.id} tier=${cohort.tier} sessions=${cohort.sessionIds.length} ` +
          `events=${cohort.eventCount} in=${cohort.tokenEstimate} out=${cohort.outputEstimate} ` +
          `closed=${cohort.closedBy}`,
      );
      return cohort;
    } catch (err) {
      note(report, "seal_cohort", horizon, err);
      return null;
    }
  }
  return null;
}

interface CohortContext {
  now: number;
  wallet: Wallet;
  deps: BootstrapDeps;
  report: BootstrapReport;
}

/** Where a cohort re-enters the ladder — `paused` keeps its place at `planned`. */
function entryIndex(state: CohortState): number {
  if (state === "paused") return 0;
  const at = COHORT_LADDER.indexOf(state);
  return at < 0 ? 0 : at + 1;
}

/**
 * Walk one cohort up the ladder, buying the understanding stage on the way.
 *
 * Returns null when the cohort finished, or the reason the tick must stop.
 * EVERY transition writes coverage (§9.1 rule 3) — that is `advanceCohort`'s
 * job, not this function's — and only the `done` transition is handed to
 * `reconcileAfterTransition`, which is the seam item 1.8 left open and nothing
 * has ever called.
 */
async function runCohortForward(
  cohort: Cohort,
  ctx: CohortContext,
): Promise<BootstrapReport["stoppedBy"]> {
  const { now, wallet, report } = ctx;
  let current = cohort;

  for (let i = entryIndex(current.state); i < COHORT_LADDER.length; i += 1) {
    const to = COHORT_LADDER[i]!;

    // `understanding` is the only rung that can spend. Buy it BEFORE the
    // transition so a budget stop leaves the cohort at the rung it really
    // reached, not one ahead of it.
    if (to === "understanding") {
      const budget = remainingCalls(wallet);
      if (budget <= 0) {
        pause(current, report, "budget");
        return "budget";
      }
      let modelFree: number;
      try {
        modelFree = await understandCohort(current, ctx);
      } catch (err) {
        note(report, "understand", current.id, err);
        pause(current, report, "error");
        return "error";
      }
      if (modelFree > 0) {
        // The verdicts exist and are marked `one_to_one_fallback` in
        // `episode_verdicts` — they are not deleted, and the next opt-in run
        // re-judges the sessions that have none. What this refuses to do is
        // walk the cohort to `done` and write a `done` coverage row on the
        // back of them: "done" would then mean "the model agreed", and it
        // would not have. `paused` is where a cohort waits for a real answer.
        note(
          report,
          "understand",
          current.id,
          new Error(
            `${modelFree} session(s) got a MODEL-FREE 1:1 fallback verdict — the pass warranted ` +
              `P-EP2 and no usable answer came back. Not marking this cohort done`,
          ),
        );
        pause(current, report, "provider_outage");
        return "provider_outage";
      }
      if (remainingCalls(wallet) <= 0 && unjudged(current.sessionIds).length > 0) {
        // Out of money with work left in this cohort: park it. `resumeCohorts`
        // hands it back at `planned` on the next opt-in run and the verdicts
        // already written are not re-bought (§9.7 rule 5).
        pause(current, report, "budget");
        return "budget";
      }
    }

    let transition;
    try {
      transition = advanceCohort(current.id, to);
    } catch (err) {
      note(report, "advance", `${current.id}->${to}`, err);
      return "error";
    }
    if (transition.refused) {
      log(`refused cohort=${current.id} ${transition.from}->${to} (stale transition, ignored)`);
      continue;
    }
    current = transition.cohort;

    if (to === "done") {
      report.cohortsDone.push(current.id);
      try {
        const reconciled = reconcileAfterTransition(transition, { now, mode: "bootstrap" });
        log(
          `done cohort=${current.id} sessions=${current.sessionIds.length} ` +
            `reconcile=${reconciled === null ? "skipped" : "ran"} llm=${wallet.spent}/${wallet.cap}`,
        );
      } catch (err) {
        note(report, "reconcile", current.id, err);
      }
    }
  }
  report.llmCallsSpent = wallet.spent;
  return null;
}

function pause(cohort: Cohort, report: BootstrapReport, why: string): void {
  try {
    advanceCohort(cohort.id, "paused");
    log(`paused cohort=${cohort.id} reason=${why} — resumes on the next opt-in run`);
  } catch (err) {
    note(report, "pause", cohort.id, err);
  }
}

/**
 * The understanding rung: P-EP2 over the cohort's sessions, then whatever
 * extraction runner was injected.
 *
 * The drain limit IS the budget — `drainEpisodeQueue` buys at most one call per
 * claimed unit, and the hash gate makes a repeat free — so the cap cannot be
 * overrun by a stage forgetting to check it. `enqueueEpisodePasses` refuses a
 * session that already has a verdict, so re-entering this rung after a crash
 * re-judges nothing.
 *
 * Returns the number of verdicts this rung reached WITHOUT a model that should
 * have had one — the caller refuses to walk the cohort to `done` on them.
 */
async function understandCohort(cohort: Cohort, ctx: CohortContext): Promise<number> {
  const { now, wallet, deps, report } = ctx;
  const pending = unjudged(cohort.sessionIds);
  let modelFree = 0;

  if (pending.length > 0) {
    enqueueEpisodePasses(cohort.sessionIds, { cohortId: cohort.id, now });
    const limit = Math.min(pending.length, remainingCalls(wallet));
    if (limit > 0) {
      // Every provider call the transport makes, and every failure it hits.
      // Both are invisible from the engine's side: it is handed a null and
      // cannot tell one retried-then-billed-twice call from one call, or a
      // total outage from a session with nothing to judge.
      let billed = 0;
      let declined = 0;
      const observe: Ep2Observer = (outcome) => {
        billed += outcome.providerCalls;
        // A process the user switched OFF is a stated decision, not an outage:
        // its 1:1 fallbacks are the documented cheap path and must not park
        // the cohort forever. Everything else is an outage.
        if (outcome.status === "disabled") declined += 1;
        if (outcome.error !== null) {
          note(
            report,
            "episode",
            cohort.id,
            new Error(`${outcome.error.code}: ${outcome.error.message}`),
          );
        }
      };
      const base = deps.invoke ?? ep2RunnerInvoke({ cohortId: cohort.id, observe });
      // The ONE spend gate. Every P-EP2 call in the system passes through it,
      // and it refuses rather than overspends — a refusal costs the session its
      // model judgement for this run, and the engine's 1:1 fallback is the safe
      // direction (`runEpisodePass`).
      const counted: AsyncEp2Invoke = async (prompt) => {
        if (remainingCalls(wallet) <= 0) return null;
        // Charged BEFORE the call so a failure cannot spend for free, then
        // trued up to what the transport really billed: a repair round and
        // every transport retry are separate provider calls and separate
        // money, and a cap counted per invocation lets a 400-call run bill
        // ~800. An injected `invoke` reports nothing, so it stays at one.
        const before = billed;
        wallet.spent += 1;
        const answer = await base(prompt);
        wallet.spent += Math.max(0, billed - before - 1);
        return answer;
      };
      const drained = await drainEpisodeQueue({ invoke: counted, limit, now, runId: cohort.id });
      modelFree = Math.max(0, drained.fallbacks - declined);
      report.fallbackVerdicts += drained.fallbacks;
      report.llmCallsSpent = wallet.spent;
      log(
        `episodes cohort=${cohort.id} claimed=${drained.claimed} ran=${drained.ran} ` +
          `skipped=${drained.skipped} fallbacks=${drained.fallbacks} llm=${wallet.spent}/${wallet.cap}`,
      );
    }
  }

  // ---- L5. ARCS. After the episodes exist (there is nothing to place before
  // that) and BEFORE extraction, which is the spec's own lane order — L5 sits
  // between L4 EPISODES and L6 UNDERSTAND. Running it here rather than as a
  // top-level stage is what keeps the whole chain inside ONE tick: the cohort's
  // `done` transition a few lines up the ladder hands these provisionals to
  // `reconcileAfterTransition`, which commits them into `arcs`, and the
  // promotion and goal steps registered beside it turn those arcs into spaces.
  // As a top-level stage after D/E it would miss that boundary by one tick.
  //
  // Not gated on this cohort having judged anything: `pendingArcEpisodes` is a
  // property of the rows, so an install whose episodes predate this stage is
  // swept by whichever cohort runs next — the same self-healing shape as the
  // roster sweep. It is also why the early return that used to sit at the top
  // of this function is gone: "nothing to judge, nothing to extract" was not
  // the same as "nothing to place".
  placeArcs(cohort.id, report);

  if (deps.extract !== undefined) {
    const budget = remainingCalls(wallet);
    if (budget > 0) {
      const outcome = await deps.extract({ cohort, sessionIds: cohort.sessionIds, budget, now });
      const spent = typeof outcome === "number" ? outcome : outcome.calls;
      wallet.spent += Math.max(0, Math.floor(spent));
      report.llmCallsSpent = wallet.spent;
      // The stage's failures are the TICK's failures. Left on the stage's own
      // log line they are invisible to `status()`, to the tests and to anyone
      // reading the report — which is how a cohort with zero claims in it read
      // as a clean run for a whole build.
      if (typeof outcome !== "number") {
        for (const err of outcome.errors ?? []) note(report, "extract", cohort.id, new Error(err));
      }
    }
  }
  return modelFree;
}

// ---------------------------------------------------------------------------
// Bootstrap → steady (§4)
// ---------------------------------------------------------------------------

export interface BootstrapSettled {
  settled: boolean;
  backfillComplete: boolean;
  noCandidates: boolean;
  noPendingCohorts: boolean;
  tierComplete: boolean;
}

/**
 * All four conditions for leaving bootstrap, each read from the DB.
 *
 * The flip itself — `sources.mode = 'steady'` plus starting the live loop — is
 * deliberately NOT done here: `scheduler/live.ts` has no caller yet, and a
 * driver that silently started a second scheduler would be the same class of
 * surprise this file exists to remove. The integrate step owns that switch.
 */
export function bootstrapSettled(now: number = Date.now()): BootstrapSettled {
  const rows = getDb().prepare(`SELECT backfill_complete FROM watermarks`).all() as {
    backfill_complete: number;
  }[];
  const backfillComplete =
    rows.length > 0 && modeAfterBackfill(rows.map((r) => ({ backfillComplete: r.backfill_complete === 1 }))) === "steady";
  const noCandidates = unclaimedCandidates(now).length === 0;
  const noPendingCohorts = pendingCohorts().length === 0;
  const tierComplete = tierCoverage().coverage === 1;
  return {
    settled: backfillComplete && noCandidates && noPendingCohorts && tierComplete,
    backfillComplete,
    noCandidates,
    noPendingCohorts,
    tierComplete,
  };
}

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

/** Slower than the episode clock on purpose: a cohort is expensive. */
export const BOOTSTRAP_INTERVAL_MS = 60_000;

export interface StartBootstrapOptions {
  intervalMs?: number;
  mode?: BootstrapMode;
  limits?: BootstrapLimits;
  deps?: BootstrapDeps;
}

/**
 * The scheduled caller the derivation layer never had.
 *
 * Shaped exactly like `startEpisodeClock`: an interval, a `ticking` latch so a
 * long cohort never overlaps itself, `unref` so a pending tick cannot hold the
 * process open, and a `stop()` that clears the handle. The ONE difference is
 * that a failing tick is logged with its stage instead of being swallowed.
 *
 * Boot-safe: with no opt-in the mode resolves to `off` and the tick does
 * nothing but the free watermark repair — plus a single `planBootstrap()` line
 * in the log, so the user can see what a run WOULD cost without paying for it.
 *
 * THE `extract` SEAM IS FILLED HERE, not at the boot call site. `runBootstrapTick`
 * keeps taking it injected — a tick with no runner is a legitimate unit under
 * test — but the SCHEDULED driver is production, and a production run that
 * quietly produces episodes and zero claims is the defect this whole file was
 * written to end. Defaulting it at the one production entry means an integrator
 * who starts the driver from their own script gets the claims stage too, the
 * same way they already get `ep2RunnerInvoke` without asking for it.
 */
export function startBootstrapDriver(opts: StartBootstrapOptions = {}): BootstrapDriver {
  const intervalMs = opts.intervalMs ?? BOOTSTRAP_INTERVAL_MS;
  const mode = resolveBootstrapMode(opts.mode);
  // `?? ` rather than a spread order: `exactOptionalPropertyTypes` is off, so
  // `{ extract: undefined }` is a legal object whose spread would silently
  // erase the default and give the caller a claim-free pipeline.
  const deps: BootstrapDeps = { ...opts.deps, extract: opts.deps?.extract ?? cl1ExtractStage() };
  let last = emptyReport(mode);
  let ticking = false;
  let stopped = false;

  try {
    const plan = planBootstrap(opts.limits ?? {});
    log(
      `mode=${mode} interval=${intervalMs}ms projection: streams_without_tier=${plan.streamsWithoutTier} ` +
        `events_without_identity=${plan.eventsWithoutIdentity} (free) ` +
        `sessions=${plan.sessionsProjected} cohorts=${plan.cohortsProjected} ` +
        `llm(ti1=${plan.llmCallsProjected.ti1} ep2=${plan.llmCallsProjected.ep2} cl1=${plan.llmCallsProjected.cl1}) ` +
        `billable_tokens=${plan.billableTokensProjected}` +
        (mode === "off" ? " — set app_state bootstrap.mode (dry|slice|full) to opt in" : ""),
    );
    last = { ...last, ...plan, mode };
  } catch (err) {
    log(`projection failed at start (the driver still runs): ${err instanceof Error ? err.message : String(err)}`);
  }

  const handle = setInterval(() => {
    if (ticking || stopped) return;
    ticking = true;
    void (async () => {
      try {
        last = await runBootstrapTick({
          mode: resolveBootstrapMode(opts.mode),
          ...(opts.limits === undefined ? {} : { limits: opts.limits }),
          deps,
          shouldStop: () => stopped,
        });
      } catch (err) {
        // Unreachable in principle — every stage catches — so if it fires the
        // message is the only thing that will explain it.
        last = { ...last, stoppedBy: "error", errors: [...last.errors, String(err)] };
        log(`tick threw outside a stage: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      } finally {
        ticking = false;
      }
    })();
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();

  return {
    stop(): void {
      stopped = true;
      clearInterval(handle);
    },
    status(): BootstrapReport {
      return last;
    },
  };
}
