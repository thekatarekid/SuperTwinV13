// ===========================================================================
// [CODE] The episode stage — the scheduler's caller for the episode engine.
// Arch §7 (L4 sits under the cohort scheduler), §9.4 (a Lane-U stage), §11.1
// (the pass itself, and rule 5's 14-day clock).
//
// Item 2.1 built the engine and item 2.2 built the P-EP2 adapter, and nothing
// in production called either: `worker/src/episodes/` was reachable only from
// the eval harness, and no clock ran the aging rule. This file is that wiring,
// and only that wiring — it decides WHEN the engine runs and feeds it what a
// pass needs (the sealed session, the [ML] pre-flag over the stored event
// vectors, the real P-EP2 judge). Every decision stays the engine's.
//
// THREE CALLERS, ONE PASS:
//
//   * the cohort path — `enqueueEpisodePasses` puts a cohort's sealed sessions
//     on the shared `work_queue` at stage `episode`, and `drainEpisodeQueue`
//     works them in §9.3 priority order. The queue's own verdict check (§9.7
//     rule 5) keeps an already-judged session from ever being re-enqueued;
//   * the seal path — `episodePassAfterSeal` is the steady-state seam: a
//     stream's sessions go straight through the same enqueue + drain the
//     moment they seal (§8.3's consolidation runs on session content the same
//     way, and the episode pass is what makes the sealed session visible to
//     L5+);
//   * the clock — `startEpisodeClock` follows `reconcile/index.ts`'s nightly
//     pattern: tick often, ask the DB whether a day has passed, run
//     `ageEpisodes` when it has (§11.1 rule 5 is CODE's job, never a model's),
//     and drain any episode work the queue is holding.
//
// THE JUDGE IS THE REAL ONE. `ep2Judge` (item 2.2) builds the P-EP2 prompt and
// the engine reads the answer — but the engine's seam is synchronous and every
// real transport is not. So the stage PREFETCHES: it asks the engine's own
// guards (the hash gate, the drift pre-flag, the candidate set) whether this
// pass would buy the call, makes the async call first when it would, and hands
// `runEpisodePass` a judge that replays that one answer through the identical
// prompt. A transport failure hands back null, which the engine reads as the
// safe 1:1 fallback (a wrong split is repairable; a wrong merge destroys).
// ===========================================================================

import { appStateGet, appStateSet } from "../db/ingest.js";
import { getDb } from "../db/connection.js";
import { getProcessEnabled, getSelectedModel } from "../db/settings.js";
import { ageEpisodes, type FadeDecision } from "../episodes/aging.js";
import {
  hashGateWouldReuse,
  runEpisodePass,
  type EngineSession,
  type EpisodeJudge,
  type EpisodePassResult,
} from "../episodes/engine.js";
import { driftWantsModel, preflagDrift, type DriftEvent, type PreflagResult } from "../episodes/preflag.js";
import { MAX_EPISODE_CANDIDATES, readOpenEpisodes, retractVerdict } from "../episodes/store.js";
import { ep2InputFor, ep2Judge } from "../prompts/p-ep2-judge.js";
import { P_EP2, P_EP2_SESSION_MARKER, P_EP2_SYSTEM, buildEp2Prompt, ep2Legend } from "../prompts/p-ep2.js";
import { runPrompt, type PromptRunStatus, type RunnerDeps } from "../prompts/runner.js";
import { decodeVector } from "../db/embeddings.js";
import { activeEmbeddingModel } from "../retrieval/model-registry.js";
import { computePriority, horizonFor, isTier, type Tier } from "../tiers/priority.js";
import { salvageAnswer, type Cl1Partial } from "./cl1-runner.js";
import {
  claimWork,
  completeWork,
  enqueueWork,
  failWork,
  type EnqueueOutcome,
  type WorkItem,
} from "./queue.js";

function log(line: string): void {
  console.error(`[episode] ${line}`);
}

// ---------------------------------------------------------------------------
// Reading a sealed session back as the engine's view of it
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  stream_id: string | null;
  source_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  event_ids: string | null;
  participant_entity_ids: string | null;
  content_hash: string | null;
  status: string;
}

function parseIds(raw: string | null): string[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The `EngineSession` view over a sealed `sessions` row, per-event timestamps
 * included so segment spans (and therefore the aging clock) run on the events'
 * own instants. Null for a missing or still-open session: an open session is
 * the live trigger's business (§8.3), never a backfill pass's.
 */
export function engineSessionOf(sessionId: string): EngineSession | null {
  const row = getDb()
    .prepare(
      `SELECT id, stream_id, source_id, started_at, ended_at, event_ids,
              participant_entity_ids, content_hash, status
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  if (row === undefined || row.status !== "sealed" || row.stream_id === null) return null;
  const eventIds = parseIds(row.event_ids);
  if (eventIds.length === 0) return null;

  const marks = eventIds.map(() => "?").join(",");
  const times = getDb()
    .prepare(`SELECT id, ts FROM events WHERE id IN (${marks})`)
    .all(...eventIds) as { id: string; ts: string | null }[];
  const eventTimes: Record<string, string> = {};
  for (const t of times) if (t.ts !== null) eventTimes[t.id] = t.ts;

  return {
    id: row.id,
    streamId: row.stream_id,
    sourceId: row.source_id,
    contentHash: row.content_hash,
    eventIds,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    entityIds: parseIds(row.participant_entity_ids),
    eventTimes,
  };
}

/**
 * The [ML] pre-flag over the session's STORED event vectors — the ones the
 * semantic indexer wrote in the active embedding space. An event with no text
 * of its own is a placeholder (§12.3: no topic signal); an event the indexer
 * has not reached yet is simply unembedded, and `preflagDrift`'s own rules
 * decide what an unmeasurable session costs (the cheap default).
 */
export function sessionPreflag(session: EngineSession, opts: { now?: number } = {}): PreflagResult {
  const spec = activeEmbeddingModel();
  const marks = session.eventIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT e.id AS id, e.text AS text, v.vector AS vector
         FROM events e
         LEFT JOIN event_embeddings v
           ON v.event_id = e.id AND v.model = ? AND v.dim = ?
        WHERE e.id IN (${marks})`,
    )
    .all(spec.id, spec.dim, ...session.eventIds) as {
    id: string;
    text: string | null;
    vector: Buffer | null;
  }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const drift: DriftEvent[] = session.eventIds.map((id) => {
    const row = byId.get(id);
    const placeholder = row === undefined || row.text === null || row.text.trim() === "";
    return {
      id,
      vector: row?.vector ? decodeVector(row.vector) : null,
      placeholder,
    };
  });
  return preflagDrift(drift, { model: spec.id, ...(opts.now === undefined ? {} : { now: opts.now }) });
}

// ---------------------------------------------------------------------------
// The real P-EP2 transport
// ---------------------------------------------------------------------------

/** An async `Ep2Invoke` — what a real transport can actually be. */
export type AsyncEp2Invoke = (prompt: {
  system: string;
  user: string;
  model: string;
}) => Promise<string | null>;

/**
 * What ONE P-EP2 attempt actually did — the two facts a null answer destroys.
 *
 * `null` is all the engine is allowed to be told (its 1:1 fallback is the safe
 * direction), and that is precisely why a caller who only sees the null cannot
 * tell a cheap pass from a total provider outage: four SPAWN_FAILEDs and four
 * genuinely-uneventful sessions look identical in the report. This is the side
 * channel that keeps them apart.
 *
 *   * `providerCalls` — provider calls actually made, RETRIES INCLUDED. One
 *     logical invocation routinely bills two (status `retried`, then `ok`), so
 *     a wallet that counts invocations caps at half of what it pays.
 *   * `error` — non-null whenever the model never produced a usable answer.
 *     The verdict that follows is MODEL-FREE, and a caller must be able to
 *     refuse to bless it.
 */
export interface Ep2CallOutcome {
  providerCalls: number;
  /** The runner's terminal status, or `disabled` when the process is off. */
  status: PromptRunStatus | "disabled";
  error: { code: string; message: string } | null;
  /**
   * Set when the unit was QUARANTINED and still handed back usable wire lines
   * (`salvageAnswer` — the records are the authority, not the status). Not an
   * error — the answer is being applied — and not nothing either, which is why
   * it is its own field rather than a silent `error: null`.
   */
  partial: Cl1Partial | null;
}

/** Told about every attempt, before its answer reaches the engine. */
export type Ep2Observer = (outcome: Ep2CallOutcome) => void;

/**
 * The production transport: P-EP2 through the shared prompt runner (item 1.9),
 * which owns the `runs` accounting row, the lane slot, the bounded repair
 * round and quarantine. Returns the model's words verbatim (every round's,
 * §5.8 keeps them all) or null — and null is all a transport failure is
 * allowed to say to the ENGINE, because the 1:1 fallback is the safe
 * direction. `observe` is how the SCHEDULER hears about it anyway.
 */
export function ep2RunnerInvoke(
  opts: {
    cohortId?: string | null;
    sessionId?: string;
    deps?: RunnerDeps;
    observe?: Ep2Observer;
  } = {},
): AsyncEp2Invoke {
  return async (prompt) => {
    if (!getProcessEnabled("episode")) {
      opts.observe?.({ providerCalls: 0, status: "disabled", error: null, partial: null });
      return null;
    }
    const result = await runPrompt(
      {
        callType: P_EP2.id,
        legend: ep2Legend(),
        instructions: `${P_EP2_SYSTEM}\n\n${P_EP2_SESSION_MARKER}`,
        user: prompt.user,
        role: "episode",
        // Steady state belongs to no import cohort, and `runs.cohort_id` is a
        // FK onto `cohorts`: the old "steady" sentinel threw inside the
        // accounting write and lost the row (see PromptCallSpec.cohortId).
        cohortId: opts.cohortId ?? null,
        model: getSelectedModel("episode"),
        unit: { kind: "session", id: opts.sessionId ?? "-" },
        lane: "understanding",
        timeoutMs: P_EP2.timeoutSeconds * 1000,
      },
      opts.deps ?? {},
    );
    // THE RECORDS ARE THE AUTHORITY, NOT THE STATUS (`salvageAnswer`, P-CL1's
    // rule, reused verbatim). One prose sentence used to void the whole paid
    // answer into a model-free fallback. The engine re-reads every line itself
    // (`segmentsFromWire` keeps valid G lines, counts the rest as violations),
    // so nothing is tolerated that the engine would not reject again — only
    // the blast radius changed. Cancelled/empty answers still fail loudly.
    const salvaged = salvageAnswer(result, "the P-EP2 call produced no usable answer");
    opts.observe?.({
      // Every provider call pushes its run id, retries included — so this is
      // the billed count, not the invocation count.
      providerCalls: result.runIds.length,
      status: result.status,
      error: salvaged.error,
      partial: salvaged.partial,
    });
    return salvaged.text;
  };
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

export interface EpisodePassJobOptions {
  now?: number;
  runId?: string | null;
  /** A synchronous judge (tests, frozen replays). Wins over `invoke`. */
  judge?: EpisodeJudge;
  /** The async transport. Prefetched only when the engine would buy the call. */
  invoke?: AsyncEp2Invoke;
  tz?: string;
}

/**
 * Prefetch the P-EP2 answer IF this pass would ask for one. The guards are the
 * engine's own, asked in the engine's order: the hash gate first (a reuse
 * spends nothing), then §11.1's routing condition (drift, or open episodes to
 * attach to). When the call is warranted the answer is fetched once and
 * replayed through `ep2Judge`, which rebuilds the identical prompt and alias
 * table — one reader, one prompt, one call.
 */
async function prefetchJudge(
  session: EngineSession,
  candidates: ReturnType<typeof readOpenEpisodes>,
  preflag: PreflagResult,
  invoke: AsyncEp2Invoke,
  tz: string | undefined,
): Promise<EpisodeJudge | undefined> {
  if (hashGateWouldReuse(session)) return undefined;
  if (!driftWantsModel(preflag) && candidates.length === 0) return undefined;
  const input = ep2InputFor({ session, candidates, preflag }, tz);
  if (input === null) return undefined;
  const prompt = buildEp2Prompt(input);
  if (prompt === null || prompt.stats.sessions === 0) return undefined;
  const response = await invoke({ system: prompt.system, user: prompt.user, model: P_EP2.model });
  return ep2Judge(() => response, tz === undefined ? {} : { tz });
}

/**
 * Run the episode pass for one sealed session — pre-flag, judge and all.
 * Null when the session is missing, open, or empty; everything else is the
 * engine's verdict, hash gate and fallbacks included.
 */
export async function runSessionEpisodePass(
  sessionId: string,
  opts: EpisodePassJobOptions = {},
): Promise<EpisodePassResult | null> {
  const session = engineSessionOf(sessionId);
  if (session === null) return null;
  const now = opts.now ?? Date.now();
  const preflag = sessionPreflag(session, { now });
  const candidates = readOpenEpisodes(session.streamId, { now, limit: MAX_EPISODE_CANDIDATES });
  let judge = opts.judge;
  if (judge === undefined && opts.invoke !== undefined) {
    judge = await prefetchJudge(session, candidates, preflag, opts.invoke, opts.tz);
  }
  return runEpisodePass(session, {
    now,
    preflag,
    candidates,
    runId: opts.runId ?? null,
    ...(judge === undefined ? {} : { judge }),
  });
}

// ---------------------------------------------------------------------------
// The queue: sealed sessions in, episodes out
// ---------------------------------------------------------------------------

/** §9.3 priority for one sealed session, off its stream's tier and its recency. */
function sessionPriority(sessionId: string, now: number): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(s.ended_at, s.started_at) AS ts_hi, st.tier AS tier
         FROM sessions s LEFT JOIN streams st ON st.id = s.stream_id
        WHERE s.id = ?`,
    )
    .get(sessionId) as { ts_hi: string | null; tier: string | null } | undefined;
  const rawTier = row?.tier;
  const tier: Tier = isTier(rawTier) ? rawTier : "T3";
  const ts = row?.ts_hi ?? now;
  return computePriority({ tier, horizon: horizonFor(ts, now), ts, now });
}

/**
 * Put sealed sessions on the shared queue at stage `episode`. `enqueueWork`
 * itself refuses a session whose verdict already exists (§9.7 rule 5), so
 * calling this over the same cohort twice re-judges nothing.
 */
export function enqueueEpisodePasses(
  sessionIds: readonly string[],
  opts: { cohortId?: string | null; now?: number } = {},
): EnqueueOutcome[] {
  const now = opts.now ?? Date.now();
  return sessionIds.map((sessionId) =>
    enqueueWork({
      unitKind: "session",
      unitId: sessionId,
      stage: "episode",
      priority: sessionPriority(sessionId, now),
      cohortId: opts.cohortId ?? null,
    }),
  );
}

/** Every sealed session with no episode verdict yet — the catch-up query. */
export function unjudgedSealedSessions(opts: { limit?: number } = {}): string[] {
  const limit = Math.max(1, Math.floor(opts.limit ?? 500));
  const rows = getDb()
    .prepare(
      `SELECT s.id AS id
         FROM sessions s
        WHERE s.status = 'sealed'
          AND NOT EXISTS (SELECT 1 FROM episode_verdicts v WHERE v.session_id = s.id)
        ORDER BY COALESCE(s.ended_at, s.started_at) DESC, s.id
        LIMIT ?`,
    )
    .all(limit) as { id: string }[];
  return rows.map((r) => r.id);
}

export interface EpisodeDrainReport {
  claimed: number;
  ran: number;
  /** Sessions the pass could not read (missing/open) — parked as retries. */
  skipped: number;
  decisions: { sessionId: string; decision: string }[];
  /**
   * Verdicts the engine reached WITHOUT a model (`one_to_one_fallback`): the
   * pass warranted P-EP2 and got nothing usable back. Distinct from
   * `one_to_one`, which is the free "nothing to judge" default and costs
   * nothing — the DB keeps the same distinction in `episode_verdicts.decision`.
   * A non-zero count here is a model-free result wearing a normal verdict's
   * clothes, and a caller that marks work `done` on it is lying about it.
   */
  fallbacks: number;
}

/**
 * Work the episode stage of the queue, highest priority first. Each completed
 * unit is marked `done`; a session the pass cannot read yet is put back with a
 * retry ticket rather than lost. Errors quarantine the unit (the queue's
 * ladder), never the drain.
 */
export async function drainEpisodeQueue(
  opts: EpisodePassJobOptions & { limit?: number } = {},
): Promise<EpisodeDrainReport> {
  const now = opts.now ?? Date.now();
  const items: WorkItem[] = claimWork({
    stages: ["episode"],
    limit: Math.max(1, Math.floor(opts.limit ?? 8)),
    nowIso: new Date(now).toISOString(),
  });
  const report: EpisodeDrainReport = {
    claimed: items.length,
    ran: 0,
    skipped: 0,
    decisions: [],
    fallbacks: 0,
  };
  for (const item of items) {
    try {
      const result = await runSessionEpisodePass(item.unitId, { ...opts, runId: opts.runId ?? item.cohortId });
      if (result === null) {
        report.skipped += 1;
        failWork(item.id, { action: "retry", notBeforeAt: new Date(now + 60_000).toISOString() });
        continue;
      }
      report.ran += 1;
      if (result.decision === "one_to_one_fallback") {
        report.fallbacks += 1;
        // LOUD on purpose: this verdict is model-free and the queue's verdict
        // gate would otherwise settle it forever. `rejudgeFallbackSessions`
        // is how it gets another hearing.
        log(`WARN fallback session=${item.unitId} — ${result.reason}`);
      }
      report.decisions.push({ sessionId: item.unitId, decision: result.decision });
      completeWork(item.id);
    } catch {
      failWork(item.id, { action: "quarantine" });
    }
  }
  return report;
}

/**
 * The seal seam (§7, §9.4): sessions that just sealed go through the same
 * enqueue + drain as a cohort's. One entry point for both cadences, the way
 * `reconcile/index.ts` funnels its three triggers into one run.
 */
export async function episodePassAfterSeal(
  sessionIds: readonly string[],
  opts: EpisodePassJobOptions & { cohortId?: string | null } = {},
): Promise<EpisodeDrainReport> {
  enqueueEpisodePasses(sessionIds, { cohortId: opts.cohortId ?? null, ...(opts.now === undefined ? {} : { now: opts.now }) });
  const { cohortId: _cohortId, ...rest } = opts;
  return drainEpisodeQueue({ ...rest, limit: sessionIds.length });
}

// ---------------------------------------------------------------------------
// The second hearing — a fallback verdict is temporary, not a downgrade
// ---------------------------------------------------------------------------

export interface FallbackRejudgeReport {
  /** Sessions whose fallback verdict was retracted and re-enqueued. */
  sessions: string[];
  retracted: number;
  enqueued: EnqueueOutcome[];
}

/**
 * Give every `one_to_one_fallback` verdict another hearing. A fallback is the
 * engine's SAFE answer to a lost model call — but it is persisted like any
 * verdict, and both settling gates (the queue's verdict check, §11.1's hash
 * gate) read that row: without this, one provider outage is a permanent,
 * model-free segmentation. The fix is retraction, not tolerance:
 * `retractVerdict` takes the fallback verdict AND everything it wrote back out
 * (its 1:1 episodes included), re-opening both gates, and the session goes
 * back on the queue. Only a session whose LATEST verdict is a fallback
 * qualifies, and the caller still owns WHEN to drain (`drainEpisodeQueue` with
 * a live `invoke`) — this never spends a model call itself. If the fresh pass
 * loses its call too, the engine writes another fallback and this finds it.
 */
export function rejudgeFallbackSessions(
  opts: { limit?: number; now?: number; cohortId?: string | null } = {},
): FallbackRejudgeReport {
  const now = opts.now ?? Date.now();
  const limit = Math.max(1, Math.floor(opts.limit ?? 100));
  const rows = getDb()
    .prepare(
      `SELECT v.id AS id, v.session_id AS session_id
         FROM episode_verdicts v
         JOIN sessions s ON s.id = v.session_id AND s.status = 'sealed'
        WHERE v.decision = 'one_to_one_fallback'
          AND NOT EXISTS (
            SELECT 1 FROM episode_verdicts w
             WHERE w.session_id = v.session_id
               AND (w.created_at > v.created_at
                    OR (w.created_at = v.created_at AND w.rowid > v.rowid))
          )
        ORDER BY v.created_at, v.rowid
        LIMIT ?`,
    )
    .all(limit) as { id: string; session_id: string }[];

  const report: FallbackRejudgeReport = { sessions: [], retracted: 0, enqueued: [] };
  for (const row of rows) {
    const retraction = retractVerdict(row.id);
    if (retraction === null) continue;
    report.retracted += 1;
    report.sessions.push(row.session_id);
    // The queue keeps the drained unit's row at `done`, and "finished work
    // stays finished" would refuse the re-enqueue — but the retraction just
    // unfinished it. Clearing the stale row is part of re-opening the gates.
    getDb()
      .prepare(
        `DELETE FROM work_queue
          WHERE stage = 'episode' AND unit_kind = 'session' AND unit_id = ? AND state = 'done'`,
      )
      .run(row.session_id);
    log(
      `rejudge session=${row.session_id} — fallback verdict ${row.id} retracted` +
        `${retraction.episodesDeleted.length > 0 ? `, episode(s) ${retraction.episodesDeleted.join(",")} removed` : ""}`,
    );
  }
  if (report.sessions.length > 0) {
    report.enqueued = enqueueEpisodePasses(report.sessions, { cohortId: opts.cohortId ?? null, now });
  }
  return report;
}

// ---------------------------------------------------------------------------
// The aging clock — §11.1 rule 5, on a schedule at last
// ---------------------------------------------------------------------------

/** "Daily" means "not again within a day", the `reconcile` convention. */
export const EPISODE_AGING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const LAST_AGING_KEY = "episodes.last_aging_at";

export function episodeAgingDue(now: number = Date.now()): boolean {
  const last = appStateGet(LAST_AGING_KEY);
  if (last === null) return true;
  const at = Date.parse(last);
  if (!Number.isFinite(at)) return true;
  return now - at >= EPISODE_AGING_INTERVAL_MS;
}

/**
 * Run the 14-day clock if a day has passed since it last ran. Stamped even
 * when nothing faded — "we looked" is what keeps the tick cheap for the rest
 * of the day. `force` is the manual override.
 */
export function runEpisodeAging(opts: { now?: number; force?: boolean } = {}): FadeDecision[] | null {
  const now = opts.now ?? Date.now();
  if (opts.force !== true && !episodeAgingDue(now)) return null;
  const faded = ageEpisodes({ now });
  appStateSet(LAST_AGING_KEY, new Date(now).toISOString());
  return faded;
}

export interface EpisodeClock {
  stop(): void;
}

/**
 * The scheduled caller the episode layer never had. Each tick: age what the
 * 14-day clock owes (§11.1 rule 5), sweep sealed-but-unjudged sessions onto
 * the queue, and drain a bounded slice of it through the real judge. Ticks
 * often, asks the DB what is due, and `unref`s so a pending tick never holds
 * the process open — the `startNightlyTimer` pattern, on purpose.
 */
export function startEpisodeClock(
  opts: { intervalMs?: number; drainLimit?: number; invoke?: AsyncEp2Invoke } = {},
): EpisodeClock {
  const intervalMs = opts.intervalMs ?? 15 * 60_000;
  const invoke = opts.invoke ?? ep2RunnerInvoke();
  let ticking = false;
  const handle = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      try {
        runEpisodeAging();
        // The second hearing first: retract what fallbacks the queue is
        // sitting on so this same tick's drain buys their real calls.
        rejudgeFallbackSessions({ limit: opts.drainLimit ?? 8 });
        enqueueEpisodePasses(unjudgedSealedSessions({ limit: opts.drainLimit ?? 8 }));
        await drainEpisodeQueue({ invoke, limit: opts.drainLimit ?? 8 });
      } catch {
        /* a failed tick is retried on the next one, never fatal */
      } finally {
        ticking = false;
      }
    })();
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}
