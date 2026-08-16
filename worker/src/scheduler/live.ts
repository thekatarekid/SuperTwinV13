// ===========================================================================
// [CODE] The live trigger, in the database — arch §8.3 (near-realtime) and
// §9.7 (pacing, stalls, progress); build item 3.4.
//
// ./lanes.ts owns the DECISION — `liveTrigger`, `effectiveInterval`, the delta
// cost model. It is pure and has no idea what a session is. This file is the
// RUNTIME around it: which open sessions exist, which events a pass has not
// seen yet, how many passes a stream has already spent this hour, and what the
// pass costs against the four shipped budgets. Nothing here re-implements a
// decision from lanes.ts; every branch that matters is delegated, so there is
// one live-trigger rule and not two that drift.
//
// SESSION BOUNDARIES DO NOT MOVE (§8.3). The wrong fix for latency is a shorter
// conversation gap, which shreds topical coherence to buy seconds. Only the
// extraction cadence changes: the session stays OPEN, marked
// "◍ conversation in progress", and delta passes emit claims into it.
//
// DELTA EXTRACTION IS MANDATORY, NOT AN OPTIMISATION. `deltaEventIds` returns
// only the events newer than `sessions.last_delta_at`, and `last_delta_at`
// advances on every recorded pass — so across a whole session each event is
// sent exactly once (O(n)). Re-reading the session whole at a 30 s cadence is
// O(n^2); `wholeSessionPassCost` in lanes.ts exists so a test can price both
// rather than trust this comment.
//
// THE HOURLY CAP AND THE CALL BUDGET LIVE IN THE DB, in ./live-budgets.ts —
// a ledger in memory is a ledger that resets on restart, and the restart is
// exactly when a runaway stream would blow through guard 2. That file also owns
// the four shipped budgets; everything it exports is re-exported here so a
// caller has one import for "the live path".
// ===========================================================================

import { getDb } from "../db/connection.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import { computePriority, isTier, type Tier } from "../tiers/priority.js";
import type { SchedulerMode } from "./horizons.js";
import {
  clampLiveInterval,
  deltaPassCost,
  liveTrigger,
  LIVE_EVENT_TRIGGER,
  LIVE_INTERVAL_DEFAULT_MS,
  type LiveTriggerDecision,
} from "./lanes.js";

export { LIVE_EVENT_TRIGGER, LIVE_PASSES_PER_HOUR } from "./lanes.js";
import { passesThisHour, recordLivePass, visibilityDeadlineMs } from "./live-budgets.js";
import { enqueueWork, type EnqueueOutcome } from "./queue.js";

export {
  budgetReport,
  intervalNote,
  liveCallsInWindow,
  LIVE_BUDGETS,
  passesThisHour,
  quietDayEstimate,
  readLedger,
  recordLivePass,
  silentGapMs,
  visibilityDeadlineMs,
  type BudgetCheck,
  type BudgetInput,
  type LedgerEntry,
  type LivePassKind,
  type QuietDayEstimate,
} from "./live-budgets.js";

const TEN_MINUTES_MS = 600_000;

/** The in-progress marker every live-updated surface renders (§8.3). */
export const IN_PROGRESS_MARKER = "◍ conversation in progress";

// ---------------------------------------------------------------------------
// Settings — `live_interval`, 30 s – 6 h, default 30 s (§8.3)
// ---------------------------------------------------------------------------

export const LIVE_INTERVAL_KEY = "live_interval_ms";
export const LIVE_EVENT_TRIGGER_KEY = "live_event_trigger";

/**
 * The configured interval, always inside the documented range.
 *
 * Clamping on READ and not only on write is deliberate: an out-of-range row
 * from an older build, a hand-edited sqlite shell or a bad API call must not be
 * able to produce a 1 s cadence. The setting is a user preference; the range is
 * a guard.
 */
export function getLiveIntervalMs(): number {
  const raw = appStateGet(LIVE_INTERVAL_KEY);
  if (raw === null || raw.trim() === "") return LIVE_INTERVAL_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) ? clampLiveInterval(n) : LIVE_INTERVAL_DEFAULT_MS;
}

/** Store the interval, clamped. Returns what was actually stored. */
export function setLiveIntervalMs(ms: number): number {
  const clamped = clampLiveInterval(ms);
  appStateSet(LIVE_INTERVAL_KEY, String(clamped));
  return clamped;
}

/** K new events, the trigger's second arm. Default 10, floor 1. */
export function getLiveEventTrigger(): number {
  const raw = appStateGet(LIVE_EVENT_TRIGGER_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : LIVE_EVENT_TRIGGER;
}

export function setLiveEventTrigger(k: number): number {
  const value = Number.isFinite(k) ? Math.max(1, Math.floor(k)) : LIVE_EVENT_TRIGGER;
  appStateSet(LIVE_EVENT_TRIGGER_KEY, String(value));
  return value;
}

// ---------------------------------------------------------------------------
// Open sessions — the candidates a live tick considers
// ---------------------------------------------------------------------------

export interface LiveCandidate {
  sessionId: string;
  streamId: string;
  sourceId: string | null;
  tier: Tier;
  /** ISO of the last delta pass, or null when none has run. */
  lastDeltaAt: string | null;
  deltaPassCount: number;
  contentHash: string | null;
  /** Events newer than `lastDeltaAt` — what the next pass would send. */
  newEvents: number;
  /** The session's newest event instant, ms. */
  newestEventMs: number | null;
  /** Milliseconds since that newest event — the quiet the trigger measures. */
  quietMs: number;
  /** Events in the trailing ten minutes — the backpressure signal. */
  eventsInLastTenMinutes: number;
}

interface CandidateRow {
  id: string;
  stream_id: string | null;
  source_id: string | null;
  tier: string | null;
  last_delta_at: string | null;
  delta_pass_count: number;
  content_hash: string | null;
  new_events: number;
  newest_ts: string | null;
  recent_events: number;
}

/**
 * Every OPEN session, with the counts the trigger needs.
 *
 * Open is the whole filter. A sealed session is the cohort scheduler's business
 * (`candidateSessions` in ./cohorts.ts draws only sealed ones), and the two
 * never contend for the same session: bootstrap understands sealed history,
 * the live trigger understands the one session still being written.
 *
 * The counts are computed in SQL over `session.event_ids`, not in JS over a
 * loaded event list — the point of a delta is not to load the session.
 */
export function liveCandidates(nowMs: number): LiveCandidate[] {
  const tenMinutesAgo = new Date(nowMs - TEN_MINUTES_MS).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT s.id                     AS id,
              s.stream_id              AS stream_id,
              s.source_id              AS source_id,
              st.tier                  AS tier,
              s.last_delta_at          AS last_delta_at,
              s.delta_pass_count       AS delta_pass_count,
              s.content_hash           AS content_hash,
              (SELECT COUNT(*)
                 FROM json_each(COALESCE(s.event_ids, '[]')) je
                 JOIN events e ON e.id = je.value
                WHERE s.last_delta_at IS NULL OR e.ts > s.last_delta_at) AS new_events,
              (SELECT MAX(e.ts)
                 FROM json_each(COALESCE(s.event_ids, '[]')) je
                 JOIN events e ON e.id = je.value)                       AS newest_ts,
              (SELECT COUNT(*)
                 FROM json_each(COALESCE(s.event_ids, '[]')) je
                 JOIN events e ON e.id = je.value
                WHERE e.ts > ?)                                          AS recent_events
         FROM sessions s
         LEFT JOIN streams st ON st.id = s.stream_id
        WHERE s.status = 'open'
        ORDER BY s.id`,
    )
    .all(tenMinutesAgo) as CandidateRow[];

  return rows.map((row) => {
    const newestEventMs = row.newest_ts ? Date.parse(row.newest_ts) : NaN;
    const newest = Number.isFinite(newestEventMs) ? newestEventMs : null;
    return {
      sessionId: row.id,
      streamId: row.stream_id ?? "",
      sourceId: row.source_id,
      tier: isTier(row.tier) ? row.tier : "T3",
      lastDeltaAt: row.last_delta_at,
      deltaPassCount: row.delta_pass_count ?? 0,
      contentHash: row.content_hash,
      newEvents: row.new_events ?? 0,
      newestEventMs: newest,
      quietMs: newest === null ? 0 : Math.max(0, nowMs - newest),
      eventsInLastTenMinutes: row.recent_events ?? 0,
    };
  });
}

/**
 * The event ids a delta pass would send: strictly newer than `sinceIso`.
 *
 * This is the O(n) guarantee in one query. `sinceIso` is `last_delta_at`, which
 * `recordDeltaPass` advances to the newest event the pass covered, so an event
 * is sent by exactly one pass over the life of the session.
 */
export function deltaEventIds(sessionId: string, sinceIso: string | null, limit?: number): string[] {
  const rows = getDb()
    .prepare(
      `SELECT e.id AS id
         FROM sessions s
         JOIN json_each(COALESCE(s.event_ids, '[]')) je
         JOIN events e ON e.id = je.value
        WHERE s.id = ?
          AND (? IS NULL OR e.ts > ?)
        ORDER BY e.ts, e.id`,
    )
    .all(sessionId, sinceIso, sinceIso) as { id: string }[];
  const ids = rows.map((r) => r.id);
  return typeof limit === "number" ? ids.slice(0, Math.max(0, limit)) : ids;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface LivePassPlan {
  sessionId: string;
  streamId: string;
  tier: Tier;
  /** The session's newest event instant, ms — what the pass is priced from. */
  newestEventMs: number | null;
  decision: LiveTriggerDecision;
  /** Ids this pass would send. Empty when the pass does not fire. */
  eventIds: string[];
  /** Estimated input tokens for the delta call (new events + running summary). */
  inputTokens: number;
  /** Wall-clock this pass's claims must be on screen by. */
  visibilityDeadlineMs: number | null;
  /** What a surface renders while the session stays open. */
  marker: string;
}

export interface LiveTickPlan {
  nowMs: number;
  mode: SchedulerMode;
  intervalMs: number;
  plans: LivePassPlan[];
  /** Backpressure labels to show, one per affected stream (guard 1). */
  labels: { streamId: string; label: string }[];
}

export interface LiveTickOptions {
  nowMs: number;
  mode: SchedulerMode;
  /** Overrides the stored setting — tests and the API pass one. */
  liveIntervalMs?: number;
}

/**
 * What the next tick would do, without doing it.
 *
 * Planning is separated from execution so a surface can render the effective
 * interval, the backpressure label and the in-progress markers without firing
 * anything, and so a test can assert the decision without a work queue.
 */
export function planLiveTick(options: LiveTickOptions): LiveTickPlan {
  const intervalMs = clampLiveInterval(options.liveIntervalMs ?? getLiveIntervalMs());
  const k = getLiveEventTrigger();
  const plans: LivePassPlan[] = [];
  const labels: { streamId: string; label: string }[] = [];
  const seenLabels = new Set<string>();

  for (const candidate of liveCandidates(options.nowMs)) {
    const decision = liveTrigger({
      mode: options.mode,
      liveIntervalMs: intervalMs,
      quietMs: candidate.quietMs,
      // K is configurable, and lanes' `liveTrigger` compares against its own
      // constant — so a lowered K is expressed by scaling what we hand it,
      // which keeps ONE comparison rather than a second copy of the rule.
      newEvents: k === LIVE_EVENT_TRIGGER ? candidate.newEvents : scaleToTrigger(candidate.newEvents, k),
      passesThisHour: passesThisHour(candidate.streamId, options.nowMs),
      eventsInLastTenMinutes: candidate.eventsInLastTenMinutes,
    });
    const eventIds = decision.fires ? deltaEventIds(candidate.sessionId, candidate.lastDeltaAt) : [];
    plans.push({
      sessionId: candidate.sessionId,
      streamId: candidate.streamId,
      tier: candidate.tier,
      newestEventMs: candidate.newestEventMs,
      decision,
      eventIds,
      inputTokens: decision.fires ? deltaPassCost(eventIds.length, Math.max(1, eventIds.length)).inputTokens : 0,
      visibilityDeadlineMs:
        candidate.newestEventMs === null ? null : visibilityDeadlineMs(candidate.newestEventMs, decision.intervalMs),
      marker: IN_PROGRESS_MARKER,
    });
    if (decision.backpressureLabel && !seenLabels.has(candidate.streamId)) {
      seenLabels.add(candidate.streamId);
      labels.push({ streamId: candidate.streamId, label: decision.backpressureLabel });
    }
  }

  return { nowMs: options.nowMs, mode: options.mode, intervalMs, plans, labels };
}

/**
 * A configured K below the built-in one, expressed as a count.
 *
 * `n` events against a threshold of `k` is the same test as `n * (10 / k)`
 * events against 10. Scaling the input rather than branching on K keeps the
 * fire/hold comparison in exactly one function (lanes' `liveTrigger`).
 */
function scaleToTrigger(newEvents: number, k: number): number {
  if (newEvents <= 0) return 0;
  return Math.floor((newEvents * LIVE_EVENT_TRIGGER) / Math.max(1, k));
}

export interface LivePassResult extends LivePassPlan {
  /** The work-queue row this pass enqueued, when it fired. */
  work: EnqueueOutcome | null;
  passesThisHour: number;
}

export interface LiveTickResult {
  plan: LiveTickPlan;
  fired: LivePassResult[];
  held: LivePassResult[];
}

/**
 * Plan, then commit: enqueue the extraction, advance `last_delta_at` and stamp
 * the ledger.
 *
 * THE HOOK INTO THE COHORT SCHEDULER IS THE WORK QUEUE, NOT A SECOND PIPELINE.
 * A live pass enqueues `extract` on the session with a `live`-horizon priority
 * from ../tiers/priority.ts — the same priority function, the same queue and
 * the same dequeue-by-priority that a bootstrap cohort's work goes through. It
 * deliberately does NOT create a cohort: cohorts are bounded sets of SEALED
 * sessions (§9.2), and the session a live pass reads is still open. That is why
 * `candidateSessions` filters on `status = 'sealed'` and this filters on
 * `'open'` — the two schedulers cannot claim the same unit.
 */
export function runLiveTick(options: LiveTickOptions): LiveTickResult {
  const plan = planLiveTick(options);
  const fired: LivePassResult[] = [];
  const held: LivePassResult[] = [];

  for (const pass of plan.plans) {
    if (!pass.decision.fires) {
      held.push({ ...pass, work: null, passesThisHour: passesThisHour(pass.streamId, options.nowMs) });
      continue;
    }
    const priority = computePriority({
      tier: pass.tier,
      horizon: "live",
      ts: pass.newestEventMs ?? options.nowMs,
      now: options.nowMs,
    });
    const work = enqueueWork({
      unitKind: "session",
      unitId: pass.sessionId,
      stage: "extract",
      priority,
    });
    recordDeltaPass(pass.sessionId, pass.streamId, options.nowMs);
    fired.push({ ...pass, work, passesThisHour: passesThisHour(pass.streamId, options.nowMs) });
  }

  return { plan, fired, held };
}

/**
 * Advance the session's delta cursor and stamp the ledger.
 *
 * The cursor moves to the NEWEST EVENT THE PASS COVERED, never to `now`. Moving
 * it to `now` would swallow an event that landed between the query and the
 * write — a silently unread message, the worst failure this whole path can
 * have. Where the session has no events at all the cursor does not move.
 */
export function recordDeltaPass(sessionId: string, streamId: string, nowMs: number): void {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT (SELECT MAX(e.ts)
                 FROM json_each(COALESCE(s.event_ids, '[]')) je
                 JOIN events e ON e.id = je.value) AS newest_ts,
              s.content_hash AS content_hash
         FROM sessions s WHERE s.id = ?`,
    )
    .get(sessionId) as { newest_ts: string | null; content_hash: string | null } | undefined;
  if (row?.newest_ts) {
    db.prepare(
      `UPDATE sessions
          SET last_delta_at    = ?,
              delta_pass_count = delta_pass_count + 1
        WHERE id = ?`,
    ).run(row.newest_ts, sessionId);
  } else {
    db.prepare(`UPDATE sessions SET delta_pass_count = delta_pass_count + 1 WHERE id = ?`).run(sessionId);
  }
  appStateSet(deltaHashKey(sessionId), row?.content_hash ?? "");
  recordLivePass(streamId, nowMs, "delta");
}

// ---------------------------------------------------------------------------
// Guard 4 — consolidation at seal is conditional
// ---------------------------------------------------------------------------

function deltaHashKey(sessionId: string): string {
  return `live_delta_hash:${sessionId}`;
}

export interface ConsolidationVerdict {
  run: boolean;
  reason: "never_extracted" | "material_change" | "hash_unchanged" | "no_content";
  hash: string | null;
  coveredHash: string | null;
}

/**
 * Does sealing this session need the full P-CL1 consolidation pass?
 *
 * §8.3 guard 4: if the deltas already covered everything and the hash has not
 * moved, seal costs NOTHING. The hash is the whole test — it is content-keyed,
 * so a re-segmentation that produces the same members with the same text is
 * free, and a late caption, which genuinely changes what the session says,
 * correctly is not.
 *
 * A session no delta ever touched consolidates unconditionally: that is not a
 * live session at all, it is the ordinary seal path.
 */
export function consolidationVerdict(sessionId: string): ConsolidationVerdict {
  const row = getDb()
    .prepare(`SELECT content_hash, delta_pass_count FROM sessions WHERE id = ?`)
    .get(sessionId) as { content_hash: string | null; delta_pass_count: number } | undefined;
  const hash = row?.content_hash ?? null;
  const raw = appStateGet(deltaHashKey(sessionId));
  const coveredHash = raw === null || raw === "" ? null : raw;
  if (!row || (row.delta_pass_count ?? 0) === 0) {
    return { run: true, reason: "never_extracted", hash, coveredHash };
  }
  if (hash === null) return { run: true, reason: "no_content", hash, coveredHash };
  if (coveredHash !== null && coveredHash === hash) {
    return { run: false, reason: "hash_unchanged", hash, coveredHash };
  }
  return { run: true, reason: "material_change", hash, coveredHash };
}

/** Stamp a consolidation into the ledger — it is a model call like any other. */
export function recordConsolidation(sessionId: string, streamId: string, nowMs: number): void {
  const row = getDb().prepare(`SELECT content_hash FROM sessions WHERE id = ?`).get(sessionId) as
    | { content_hash: string | null }
    | undefined;
  appStateSet(deltaHashKey(sessionId), row?.content_hash ?? "");
  recordLivePass(streamId, nowMs, "consolidation");
}

