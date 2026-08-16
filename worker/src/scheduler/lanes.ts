// ===========================================================================
// [CODE] The two lanes, pacing, stalls and the live trigger — arch §9.4, §9.6,
// §9.7 and §8.3; build item 1.8.
//
// LANE U NEVER WAITS FOR LANE E (§9.4 rule 2). This is the correction to the
// earlier "barrier" design: there is no waiting period and no threshold to
// tune. Text is understood the moment it lands, with unread attachments marked
// as explicit placeholders, and enrichment updates the same chunk later (§7.4).
// `LaneBoard` below models exactly that — U's readiness is computed WITHOUT
// consulting E, so a test can prove independence rather than read a comment
// claiming it.
//
// Lane E still runs a lookahead (2 cohorts in bootstrap, 1 in steady) — not
// because U depends on it, but because it smooths the enrichment queue so most
// attachments ARE readable by the time their cohort is understood.
//
// THE ONLY QUIET STATE IS A RATE-LIMIT PAUSE (§9.4 rule 5, §9.7 rule 1). Every
// other gap with work outstanding is a stall, and gate `sched_no_stall` fails
// above 90 s. `IdleTracker` measures the gap and subtracts pause windows — the
// subtraction is the whole reason the tracker exists, because a pause with a
// countdown on screen is not a silent failure and a 90 s hang is.
//
// §8.3's live trigger is here too, with its four guards: visible backpressure,
// a hard cap of 20 passes per stream per hour, steady-state only, and a
// conditional consolidation at seal. Delta extraction is MANDATORY, not an
// optimisation — at a 30 s interval a 40-message session re-read whole would be
// O(n^2) in session length.
// ===========================================================================

import { ENRICHMENT_SHARE, laneCaps, type LlmLane } from "../providers/pool.js";
import { modeParams, type SchedulerMode } from "./horizons.js";

export type Lane = LlmLane;

// ---------------------------------------------------------------------------
// Slot reservation (§9.4 rule 4, §9.5.3 rule 1)
// ---------------------------------------------------------------------------

/**
 * Lane caps for an LLM pool of `limit` slots.
 *
 * During first paint Lane E gets ZERO — not 40 % (§9.5.3 rule 1). Text-first
 * means captions are not needed for first output. The 40/60 split resumes the
 * moment first paint completes; the numbers come from ../providers/pool.ts,
 * which owns the pool, so there is one definition of the split and not two.
 */
export function laneSlots(limit: number, firstPaintComplete: boolean): Record<Lane, number> {
  return laneCaps(limit, !firstPaintComplete);
}

export { ENRICHMENT_SHARE };

// ---------------------------------------------------------------------------
// Lane independence (§9.4 rules 1, 2 and 5)
// ---------------------------------------------------------------------------

export interface CohortLaneState {
  cohortId: string;
  /** Lane E has finished this cohort's enrichment. */
  enriched: boolean;
  /** Lane U has finished understanding it. */
  understood: boolean;
  /** Attachments still unread when U ran — rendered as explicit placeholders. */
  unreadAttachments: number;
}

export interface LaneStep {
  lane: Lane;
  cohortId: string;
  /** Placeholders U had to emit because E had not caught up. Never a wait. */
  placeholders: number;
}

/**
 * One scheduling tick over a cohort queue.
 *
 * Lane U takes the head of the queue unconditionally. It does not read
 * `enriched`, and that is the point: §9.4 rule 2 forbids a barrier, so the
 * function has no branch that could become one. Lane E works `enrichLookahead`
 * cohorts ahead of wherever U happens to be.
 *
 * If E falls behind on video, U proceeds. If U is paused on quota, E keeps
 * going and deepens the lookahead (§9.4 rule 5) — hence the two independent
 * `paused` flags rather than one pipeline state.
 */
export function laneTick(
  queue: readonly CohortLaneState[],
  options: { mode: SchedulerMode; pausedLanes?: readonly Lane[] },
): LaneStep[] {
  const paused = new Set(options.pausedLanes ?? []);
  const steps: LaneStep[] = [];

  const nextForU = queue.find((c) => !c.understood);
  if (nextForU && !paused.has("understanding")) {
    steps.push({
      lane: "understanding",
      cohortId: nextForU.cohortId,
      // Unread attachments become explicit placeholders (§9.6 rule 7): UNKNOWN
      // content, never absent content and never an acknowledgement.
      placeholders: nextForU.enriched ? 0 : nextForU.unreadAttachments,
    });
  }

  if (!paused.has("enrichment")) {
    const lookahead = modeParams(options.mode).enrichLookahead;
    const pending = queue.filter((c) => !c.enriched).slice(0, lookahead);
    for (const cohort of pending) {
      steps.push({ lane: "enrichment", cohortId: cohort.cohortId, placeholders: 0 });
    }
  }

  return steps;
}

/**
 * Ticks in which U did nothing while unfinished cohorts existed and U was not
 * itself paused — gate `enrich_slow_attachment_blocks_text`. Must be empty.
 */
export function understandingBlocked(
  queue: readonly CohortLaneState[],
  steps: readonly LaneStep[],
  pausedLanes: readonly Lane[] = [],
): string[] {
  if (pausedLanes.includes("understanding")) return [];
  const pending = queue.filter((c) => !c.understood).map((c) => c.cohortId);
  if (pending.length === 0) return [];
  const ran = steps.some((s) => s.lane === "understanding");
  return ran ? [] : pending.slice(0, 1);
}

// ---------------------------------------------------------------------------
// Stalls and pauses (§9.4 rule 5, §9.7 rules 1–3)
// ---------------------------------------------------------------------------

export interface PauseWindow {
  fromMs: number;
  toMs: number;
  reason: "quota" | "auth";
}

export interface StallReport {
  /** The longest silent gap, in seconds, with pause windows removed. */
  maxIdleGapSeconds: number;
  /** Where that gap was, for a report that names the stall rather than scoring it. */
  atMs: number | null;
  /** Total seconds spent paused — legitimate quiet, excluded from the gap. */
  pausedSeconds: number;
}

/**
 * The no-stall clock.
 *
 * Every completed unit is a heartbeat. The gap between consecutive heartbeats
 * is the silence a user sees, and gate `sched_no_stall` fails above 90 s while
 * cohorts remain — EXCLUDING quota pauses, because §9.4 rule 5 makes a
 * countdown-rendered pause the one legitimate quiet state.
 *
 * The exclusion is arithmetic on the overlap, not a flag: a pause that covers
 * part of a gap shortens it by exactly its overlap, so a 120 s gap containing a
 * 60 s pause scores 60 and a 120 s gap containing none scores 120.
 */
export class IdleTracker {
  private readonly beats: number[] = [];
  private readonly pauses: PauseWindow[] = [];

  constructor(private readonly startedAtMs: number) {}

  /** A unit of work completed — a cohort transition, a claim written. */
  beat(atMs: number): void {
    this.beats.push(atMs);
  }

  pause(window: PauseWindow): void {
    this.pauses.push(window);
  }

  /** Overlap between `[from, to]` and every recorded pause window, in ms. */
  private pausedWithin(fromMs: number, toMs: number): number {
    let total = 0;
    for (const p of this.pauses) {
      const lo = Math.max(fromMs, p.fromMs);
      const hi = Math.min(toMs, p.toMs);
      if (hi > lo) total += hi - lo;
    }
    return total;
  }

  /** `nowMs` closes the final gap: silence up to now counts, not only between beats. */
  report(nowMs: number): StallReport {
    const marks = [this.startedAtMs, ...this.beats, nowMs].sort((a, b) => a - b);
    let worst = 0;
    let at: number | null = null;
    for (let i = 1; i < marks.length; i += 1) {
      const from = marks[i - 1]!;
      const to = marks[i]!;
      const gap = to - from - this.pausedWithin(from, to);
      if (gap > worst) {
        worst = gap;
        at = from;
      }
    }
    return {
      maxIdleGapSeconds: Math.round((worst / 1000) * 10) / 10,
      atMs: at,
      pausedSeconds: Math.round(this.pausedWithin(this.startedAtMs, nowMs) / 1000),
    };
  }
}

export interface PauseState {
  paused: boolean;
  /** "paused — rate limit, resumes in 04:12" (§14.0 rule 2). */
  label: string;
  remainingSeconds: number;
  /** §4.6: a refusal must NEVER consume the unit's retry budget. */
  retryBudgetSpent: boolean;
}

/** mm:ss, so a countdown reads as a countdown and not as a float. */
export function formatCountdown(remainingSeconds: number): string {
  const s = Math.max(0, Math.ceil(remainingSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * The paused lane's rendering. §9.7 rule 1 allows exactly one quiet state and
 * §14.0 rule 2 requires it to say so out loud: "a healthy mid-run system that
 * looks like a silent failure is itself a shipped defect."
 */
export function pauseState(pause: PauseWindow | null, nowMs: number): PauseState {
  if (!pause || nowMs >= pause.toMs) {
    return { paused: false, label: "", remainingSeconds: 0, retryBudgetSpent: false };
  }
  const remaining = (pause.toMs - nowMs) / 1000;
  const what = pause.reason === "quota" ? "rate limit" : "sign-in needed";
  return {
    paused: true,
    label: `paused — ${what}, resumes in ${formatCountdown(remaining)}`,
    remainingSeconds: Math.ceil(remaining),
    retryBudgetSpent: false,
  };
}

// ---------------------------------------------------------------------------
// The live trigger (§8.3)
// ---------------------------------------------------------------------------

/** §8.3: `live_interval` is user-configurable, 30 s – 6 h. */
export const LIVE_INTERVAL_MIN_MS = 30_000;
export const LIVE_INTERVAL_MAX_MS = 6 * 3_600_000;
export const LIVE_INTERVAL_DEFAULT_MS = 30_000;
/** §8.3: the trigger also fires on K new events. */
export const LIVE_EVENT_TRIGGER = 10;
/** §8.3 guard 2: hard cap, 20 live passes per stream per hour. */
export const LIVE_PASSES_PER_HOUR = 20;
/** The conversation gap a session boundary uses — 6 h meets it (§8.3 table). */
export const CONVERSATION_GAP_MS = 6 * 3_600_000;

export function clampLiveInterval(ms: number): number {
  if (!Number.isFinite(ms)) return LIVE_INTERVAL_DEFAULT_MS;
  return Math.min(LIVE_INTERVAL_MAX_MS, Math.max(LIVE_INTERVAL_MIN_MS, Math.floor(ms)));
}

/** The activity window backpressure is measured over. */
export const BACKPRESSURE_WINDOW_MS = 600_000;

/**
 * §8.3 guard 1: `effective_interval = max(live_interval, backpressure(activity))`.
 *
 * The rule is one line: EVERY PASS CARRIES AT LEAST ONE FULL BATCH. At the base
 * interval a 50-message burst would fire 20 passes of two or three messages
 * each — twenty calls to say almost nothing — so the interval stretches to the
 * spacing that puts `LIVE_EVENT_TRIGGER` messages in each pass, which for that
 * burst is exactly the doc's "batching every 2 min".
 *
 * A calm stream is untouched (`max` keeps the base) and so is a torrential one,
 * where the base interval already collects full batches. Only the middle needs
 * stretching, and that is where the wasted calls live.
 *
 * The lengthening must be VISIBLE — "high activity — batching every 2 min" — so
 * the caller gets the label with the number. A silent stretch would look like
 * the setting being ignored, which is the failure this guard exists to prevent.
 */
export function effectiveInterval(
  liveIntervalMs: number,
  eventsInLastTenMinutes: number,
): { intervalMs: number; backpressure: boolean; label: string } {
  const base = clampLiveInterval(liveIntervalMs);
  if (eventsInLastTenMinutes <= LIVE_EVENT_TRIGGER) {
    return { intervalMs: base, backpressure: false, label: "" };
  }
  const batchSpacing = Math.min(
    LIVE_INTERVAL_MAX_MS,
    Math.round((BACKPRESSURE_WINDOW_MS * LIVE_EVENT_TRIGGER) / eventsInLastTenMinutes),
  );
  const intervalMs = Math.max(base, batchSpacing);
  const minutes = Math.round((intervalMs / 60_000) * 10) / 10;
  return {
    intervalMs,
    backpressure: intervalMs > base,
    label: intervalMs > base ? `high activity — batching every ${minutes} min` : "",
  };
}

export interface LiveTriggerInput {
  mode: SchedulerMode;
  liveIntervalMs: number;
  /** Milliseconds of quiet on the open session. */
  quietMs: number;
  /** New events since the last pass. */
  newEvents: number;
  /** Passes already run on this stream inside the trailing hour. */
  passesThisHour: number;
  /** Activity over the last ten minutes, for backpressure. */
  eventsInLastTenMinutes?: number;
}

export interface LiveTriggerDecision {
  fires: boolean;
  reason: "quiet" | "event_count" | "not_steady" | "capped" | "waiting";
  intervalMs: number;
  backpressureLabel: string;
  /** Seconds from the newest event to the pass firing — the visibility gate. */
  visibilitySeconds: number;
}

/**
 * Should a delta pass fire on the open session right now?
 *
 * Guard 3 first: STEADY STATE ONLY. Bootstrap uses immediate-seal, so setting
 * `live_interval` to 6 h never slows an import or the 120 s target.
 *
 * At 6 h the interval meets the conversation gap, so the trigger effectively
 * never fires and the stream falls back to pure seal-time behaviour — chosen
 * deliberately, per §8.3's table, not a degenerate case.
 */
export function liveTrigger(input: LiveTriggerInput): LiveTriggerDecision {
  const { intervalMs, label } = effectiveInterval(input.liveIntervalMs, input.eventsInLastTenMinutes ?? 0);
  const base = {
    intervalMs,
    backpressureLabel: label,
    visibilitySeconds: Math.round(intervalMs / 1000),
  };
  if (!modeParams(input.mode).liveTrigger) return { ...base, fires: false, reason: "not_steady" };
  if (input.passesThisHour >= LIVE_PASSES_PER_HOUR) return { ...base, fires: false, reason: "capped" };
  // At >= the conversation gap the session seals before the interval elapses,
  // so the quiet branch can never win. Left as arithmetic rather than a special
  // case: the same comparison produces the documented behaviour.
  if (input.quietMs >= intervalMs && intervalMs < CONVERSATION_GAP_MS) {
    return { ...base, fires: true, reason: "quiet" };
  }
  if (input.newEvents >= LIVE_EVENT_TRIGGER && intervalMs < CONVERSATION_GAP_MS) {
    return { ...base, fires: true, reason: "event_count" };
  }
  return { ...base, fires: false, reason: "waiting" };
}

// ---------------------------------------------------------------------------
// Delta extraction (§8.3) — mandatory, not an optimisation
// ---------------------------------------------------------------------------

export interface PassCost {
  passes: number;
  /** Input tokens across every pass. */
  inputTokens: number;
  /** Growth in message count: "linear" is the requirement, not the hope. */
  growth: "linear" | "quadratic";
}

/** Tokens a running summary costs as context on a delta pass. */
export const RUNNING_SUMMARY_TOKENS = 120;
/** Tokens one message contributes. */
export const TOKENS_PER_MESSAGE = 25;

/**
 * What a session of `messages` costs, extracted by deltas of `batch` messages.
 *
 * Delta: each pass sends only the new events plus a compact running summary →
 * O(n) overall. Whole-session re-reads at the same cadence are O(n^2), which at
 * a 30 s interval on a 40-message session is 40 re-reads of a growing prompt.
 * Both are computed here so the eval can compare them instead of asserting a
 * remembered ratio.
 */
export function deltaPassCost(messages: number, batch = LIVE_EVENT_TRIGGER): PassCost {
  const passes = Math.max(1, Math.ceil(messages / Math.max(1, batch)));
  const inputTokens = passes * RUNNING_SUMMARY_TOKENS + messages * TOKENS_PER_MESSAGE;
  return { passes, inputTokens, growth: "linear" };
}

/** The same session re-read whole on every pass — the O(n^2) it replaces. */
export function wholeSessionPassCost(messages: number, batch = LIVE_EVENT_TRIGGER): PassCost {
  const passes = Math.max(1, Math.ceil(messages / Math.max(1, batch)));
  let inputTokens = 0;
  for (let i = 1; i <= passes; i += 1) {
    inputTokens += Math.min(messages, i * batch) * TOKENS_PER_MESSAGE;
  }
  return { passes, inputTokens, growth: "quadratic" };
}

/**
 * §8.3's seal trigger: ONE consolidation pass, "but only if the session gained
 * material content since the last delta. Otherwise the hash gate skips it
 * entirely." A re-sync that changed nothing costs nothing.
 */
export function consolidationAtSeal(input: {
  contentHash: string;
  lastConsolidatedHash: string | null;
}): { runs: boolean; reason: "hash_unchanged" | "content_changed" | "never_consolidated" } {
  if (input.lastConsolidatedHash === null) return { runs: true, reason: "never_consolidated" };
  if (input.lastConsolidatedHash === input.contentHash) return { runs: false, reason: "hash_unchanged" };
  return { runs: true, reason: "content_changed" };
}

// ---------------------------------------------------------------------------
// Media never blocks text (§9.6)
// ---------------------------------------------------------------------------

/** §9.6 rule 6: bounded at `reprocess_max` (default 3) per episode. */
export const REPROCESS_MAX = 3;

export interface EpisodePassPlan {
  /** Pass 1 reads text with placeholders; pass 2 fires when enrichment resolves. */
  passes: number;
  /** True once `reprocess_count` has hit the bound — flagged for nightly reconcile. */
  flaggedForReconcile: boolean;
  reason: string;
}

/**
 * How many passes an episode gets. Exactly two in the normal case (§7.4): text
 * only, then complete. Late media adds a bounded reprocess; past
 * `REPROCESS_MAX` the enrichment is still stored, searchable and attached for
 * provenance — it is the PASS that is bounded, never the data.
 */
export function episodePassPlan(input: {
  hasMedia: boolean;
  pendingEnrichment: number;
  reprocessCount: number;
  lateArrivals?: number;
}): EpisodePassPlan {
  if (!input.hasMedia) {
    return { passes: 1, flaggedForReconcile: false, reason: "text only — nothing to wait for" };
  }
  const late = input.lateArrivals ?? 0;
  if (input.reprocessCount >= REPROCESS_MAX) {
    return {
      passes: REPROCESS_MAX,
      flaggedForReconcile: true,
      reason: `reprocess_max (${REPROCESS_MAX}) reached — enrichment stored and attached, episode flagged for nightly reconcile`,
    };
  }
  const passes = Math.min(REPROCESS_MAX, 2 + late);
  return {
    passes,
    flaggedForReconcile: false,
    reason:
      input.pendingEnrichment > 0
        ? "pass 1 ran on text with placeholders; pass 2 fires when the last enrichment resolves"
        : "pass 1 text-only, pass 2 complete",
  };
}

/**
 * §9.6 rule 1: the media queue is priority-ordered on the SAME key as
 * understanding, so a photo sent an hour ago is captioned before a photo from
 * 2023. Any pair where a lower-priority item was captioned first is an
 * inversion — gate `enrich_media_queue_priority`. "A FIFO media queue is the
 * single easiest way to break the 120 s target."
 */
export function mediaOrderInversions(order: readonly { id: string; priority: number }[]): {
  before: string;
  after: string;
}[] {
  const out: { before: string; after: string }[] = [];
  for (let i = 1; i < order.length; i += 1) {
    const previous = order[i - 1]!;
    const current = order[i]!;
    if (current.priority > previous.priority) out.push({ before: previous.id, after: current.id });
  }
  return out;
}
