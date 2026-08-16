// ===========================================================================
// [CODE] Modes, the horizon ladder and the cohort budget — arch §8.1–§8.3,
// §9.1, §9.2 and §9.7; build item 1.8.
//
// This file holds the scheduler's PARAMETERS and nothing else: no database, no
// queue, no clock of its own. §8.1 is explicit that "both modes run the same
// code path — the differences are parameters on the scheduler and the
// segmenter", so bootstrap and steady are two rows of one table here rather
// than two branches spread through the control plane. There is no separate
// first-run pipeline and no demo mode.
//
// Three numbers in this file are load-bearing and are all one formula each:
//
//   cohort_budget(seq)  = min(MAX, BASE x 2^seq)            §9.1
//   output_budget(seq)  = min(MAX_OUT, 600 x 2^seq)         §9.5.3 rule 2
//   priority            = tier x 10^9 + horizon x 10^6 + recency   §9.3
//
// The first cohort is small BECAUSE THE RAMP STARTS SMALL, not because it is a
// different process (§9.1 rule 2). Special-casing cohort 0 is how the "same
// code path" guarantee quietly stops being true.
//
// THE SIZING AXIS. §9.5.3 rule 2: cohort 0 is sized by expected OUTPUT tokens,
// not by session count. Four sessions of a noisy group produce several times
// the output of four quiet DMs, and latency is roughly proportional to output
// tokens — so counting sessions sizes the wrong thing. The session count in
// `cohort_budget` is a ceiling that stops a cohort growing unboundedly; the
// output estimate is what actually closes cohort 0.
//
// The horizon ladder itself lives in ../tiers/priority.ts, which owns the sort
// key. It is re-exported here so the scheduler has one import surface, and NOT
// re-declared: two ladders is one ladder plus a bug.
// ===========================================================================

import { billableTokens } from "../providers/usage.js";
import {
  HORIZONS,
  computePriority,
  horizonFor,
  horizonWeight,
  isHorizon,
  preempts,
  recencySlot,
  type Horizon,
  type Tier,
} from "../tiers/priority.js";

export {
  HORIZONS,
  computePriority,
  horizonFor,
  horizonWeight,
  isHorizon,
  preempts,
  recencySlot,
  type Horizon,
  type Tier,
};

// ---------------------------------------------------------------------------
// Modes (§8.1)
// ---------------------------------------------------------------------------

/** `reprocess` is the third mode of `cohorts.mode` — a re-read of settled history. */
export const MODES = ["bootstrap", "steady", "reprocess"] as const;
export type SchedulerMode = (typeof MODES)[number];

export function isMode(value: unknown): value is SchedulerMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/** The §8.1 table, as parameters rather than as branches. */
export interface ModeParams {
  mode: SchedulerMode;
  /**
   * §8.2. In bootstrap the next row already decides the boundary, so a session
   * seals the moment the rule fires — waiting for a conversation that ended in
   * 2024 is pure latency for zero information.
   */
  sealImmediate: boolean;
  /** §9.4 rule 3: Lane E runs 2 cohorts ahead in bootstrap, 1 in steady. */
  enrichLookahead: number;
  /** §8.3: the near-realtime delta trigger runs in steady state only. */
  liveTrigger: boolean;
  /** §9.7 rule 4: 200 identity popups during an import is the worse failure. */
  questionsBatched: boolean;
  /** §8.1: bootstrap ramps up, steady stays small and latency-optimised. */
  rampBudget: boolean;
}

const MODE_TABLE: Record<SchedulerMode, ModeParams> = {
  bootstrap: {
    mode: "bootstrap",
    sealImmediate: true,
    enrichLookahead: 2,
    liveTrigger: false,
    questionsBatched: true,
    rampBudget: true,
  },
  steady: {
    mode: "steady",
    sealImmediate: false,
    enrichLookahead: 1,
    liveTrigger: true,
    questionsBatched: false,
    rampBudget: false,
  },
  // A reprocess is a bootstrap over settled data: history is fixed, so sealing
  // is immediate, but nothing about it is live and its questions can wait.
  reprocess: {
    mode: "reprocess",
    sealImmediate: true,
    enrichLookahead: 2,
    liveTrigger: false,
    questionsBatched: true,
    rampBudget: true,
  },
};

export function modeParams(mode: SchedulerMode): ModeParams {
  return { ...MODE_TABLE[mode] };
}

/** §8.1 exit condition: `backfill_complete` on every stream flips the mode. */
export function modeAfterBackfill(streams: readonly { backfillComplete: boolean }[]): SchedulerMode {
  if (streams.length === 0) return "steady";
  return streams.every((s) => s.backfillComplete) ? "steady" : "bootstrap";
}

// ---------------------------------------------------------------------------
// The horizon window (§9.2)
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Age in ms at which each horizon ENDS. `older` has no end. */
const HORIZON_AGE_MS: Record<Horizon, number> = {
  live: HOUR,
  h24: DAY,
  d7: 7 * DAY,
  d30: 30 * DAY,
  d90: 90 * DAY,
  y1: 365 * DAY,
  older: Number.POSITIVE_INFINITY,
};

export interface HorizonWindow {
  horizon: Horizon;
  /** Newest instant in the window (ms). */
  hi: number;
  /** Oldest instant in the window (ms); `-Infinity` for `older`. */
  lo: number;
}

/**
 * The half-open window `(lo, hi]` a horizon covers relative to `now`.
 *
 * The ladder is contiguous by construction — each rung starts where the one
 * above it ended — so every instant belongs to exactly one horizon and
 * `horizonFor` and this function can never disagree about which.
 */
export function horizonWindow(horizon: Horizon, now: number): HorizonWindow {
  const index = HORIZONS.indexOf(horizon);
  const previous = index === 0 ? 0 : HORIZON_AGE_MS[HORIZONS[index - 1]!];
  const end = HORIZON_AGE_MS[horizon];
  return {
    horizon,
    hi: now - previous,
    lo: end === Number.POSITIVE_INFINITY ? Number.NEGATIVE_INFINITY : now - end,
  };
}

/** The ladder in descending recency — the order cohorts are drawn in (§9.2). */
export function horizonLadder(): Horizon[] {
  return [...HORIZONS];
}

/** The next rung down, or null at the bottom. Backfill walks BACKWARDS (§9.2). */
export function nextHorizon(horizon: Horizon): Horizon | null {
  const at = HORIZONS.indexOf(horizon);
  return at === -1 || at === HORIZONS.length - 1 ? null : HORIZONS[at + 1]!;
}

// ---------------------------------------------------------------------------
// The adaptive ramp (§9.1 rule 2)
// ---------------------------------------------------------------------------

export interface Budget {
  /** Ceiling on sessions. A cohort closes at whichever bound it hits first. */
  sessions: number;
  /** Ceiling on estimated INPUT tokens. */
  tokens: number;
  /** Ceiling on expected OUTPUT tokens — the axis latency actually rides on. */
  outputTokens: number;
}

/** §9.1: `BASE_BUDGET = 4 sessions / 6k tokens` at seq 0. */
export const BASE_BUDGET = { sessions: 4, tokens: 6_000 } as const;
/** §9.1: `MAX_BUDGET = 24 sessions / 40k tokens` at seq >= 3. */
export const MAX_BUDGET = { sessions: 24, tokens: 40_000 } as const;

/**
 * §9.5.3 rule 2 — cohort 0 budgets ~600 expected output tokens, which is what
 * §9.5's table says P-CL1 actually emits for four small sessions.
 */
export const BASE_OUTPUT_TOKENS = 600;
/**
 * §9.5: later cohorts are throughput-optimised and DO take 30–60 s at
 * 3,000–4,000 output tokens. That is correct there, so the ramp's ceiling is
 * the top of that range rather than the latency-optimised figure.
 */
export const MAX_OUTPUT_TOKENS = 4_000;

/** `cohort_budget(seq) = min(MAX, BASE x 2^seq)`, §9.1, verbatim. */
export function cohortBudget(seq: number): Budget {
  const n = Math.max(0, Math.floor(seq));
  // 2^n overflows into Infinity long before it matters; min() absorbs it.
  const grow = 2 ** Math.min(n, 32);
  return {
    sessions: Math.min(MAX_BUDGET.sessions, BASE_BUDGET.sessions * grow),
    tokens: Math.min(MAX_BUDGET.tokens, BASE_BUDGET.tokens * grow),
    outputTokens: Math.min(MAX_OUTPUT_TOKENS, BASE_OUTPUT_TOKENS * grow),
  };
}

// ---------------------------------------------------------------------------
// Sizing by expected output tokens (§9.5.3 rule 2)
// ---------------------------------------------------------------------------

/** What the estimator needs to know about a candidate session. */
export interface SessionSize {
  id: string;
  eventCount: number;
  /** Total characters of text across the session's events. */
  charCount: number;
}

/**
 * Output tokens P-CL1 emits per input event at nominal density, calibrated
 * against §9.5: four small sessions -> "summary + ~15 claims + ~5 loops
 * ~= 450–600 tok".
 */
export const OUTPUT_TOKENS_PER_EVENT = 16;
/** Characters per event the figure above is calibrated at. */
export const NOMINAL_CHARS_PER_EVENT = 60;
/** Input tokens per character — the usual ~4 chars/token, applied to the prompt. */
export const INPUT_CHARS_PER_TOKEN = 4;

/** Density factor of a session: how much more it says per event than nominal. */
export function densityFactor(session: SessionSize): number {
  if (session.eventCount <= 0) return 0;
  const chars = session.charCount / session.eventCount;
  // Clamped: a single 4,000-character forward should not convince the estimator
  // that the whole cohort will be sixty times its size.
  return Math.min(4, Math.max(0.25, chars / NOMINAL_CHARS_PER_EVENT));
}

/** Expected P-CL1 output tokens for one session — event count x density. */
export function expectedOutputTokens(session: SessionSize): number {
  return Math.round(session.eventCount * OUTPUT_TOKENS_PER_EVENT * densityFactor(session));
}

/** Estimated INPUT tokens for one session: its own text, plus prompt overhead. */
export function expectedInputTokens(session: SessionSize): number {
  return Math.round(session.charCount / INPUT_CHARS_PER_TOKEN) + session.eventCount * 2;
}

export interface Fill {
  taken: SessionSize[];
  left: SessionSize[];
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  /** Which bound closed the cohort. */
  closedBy: "sessions" | "input_tokens" | "output_tokens" | "exhausted";
}

/**
 * Fill a cohort from candidates already in priority order.
 *
 * §9.1 rule 1: a cohort closes when it hits its budget in sessions OR estimated
 * tokens, whichever comes first. The output-token bound is the one that closes
 * cohort 0 on a noisy group, and the session bound is the one that closes it on
 * quiet DMs — the same formula, two different binding constraints.
 *
 * THE FIRST SESSION IS ALWAYS TAKEN. A single session whose own estimate blows
 * the budget would otherwise close an empty cohort, and an empty cohort is a
 * stalled pipeline dressed up as a scheduling decision.
 */
export function fillCohort(candidates: readonly SessionSize[], budget: Budget): Fill {
  const taken: SessionSize[] = [];
  let events = 0;
  let input = 0;
  let output = 0;
  let closedBy: Fill["closedBy"] = "exhausted";

  for (const session of candidates) {
    const nextOut = output + expectedOutputTokens(session);
    const nextIn = input + expectedInputTokens(session);
    if (taken.length > 0) {
      if (taken.length >= budget.sessions) {
        closedBy = "sessions";
        break;
      }
      if (nextOut > budget.outputTokens) {
        closedBy = "output_tokens";
        break;
      }
      if (nextIn > budget.tokens) {
        closedBy = "input_tokens";
        break;
      }
    }
    taken.push(session);
    events += session.eventCount;
    input = nextIn;
    output = nextOut;
  }

  return {
    taken,
    left: candidates.slice(taken.length),
    eventCount: events,
    inputTokens: input,
    outputTokens: output,
    closedBy,
  };
}

/**
 * §9.5.4 rule 2 — "if a cohort would miss it, the scheduler shrinks the
 * output-token budget. It never skips stages, never downgrades the model, and
 * never emits provisional objects it will retract."
 *
 * `observedTokensPerSecond` is measured (§9.5.3 rule 4), never assumed.
 */
export function shrinkToDeadline(
  budget: Budget,
  deadlineSeconds: number,
  observedTokensPerSecond: number,
): Budget {
  if (!(observedTokensPerSecond > 0) || !(deadlineSeconds > 0)) return { ...budget };
  const affordable = Math.floor(deadlineSeconds * observedTokensPerSecond);
  if (affordable >= budget.outputTokens) return { ...budget };
  // Never below one session's worth: shrinking to nothing is skipping a stage
  // by another name.
  return { ...budget, outputTokens: Math.max(BASE_OUTPUT_TOKENS / 4, affordable) };
}

// ---------------------------------------------------------------------------
// Pacing against the quota window (§9.7 rule 2)
// ---------------------------------------------------------------------------

export interface PacingInput {
  /** Estimated tokens this cohort will spend, by kind. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  /** Billable tokens already spent inside the current quota window. */
  spentInWindow: number;
  /** The window's billable-token allowance. */
  windowLimit: number;
  /** Milliseconds until the window rolls over. */
  windowRemainingMs: number;
}

export interface PacingDecision {
  /** Billable tokens this cohort is expected to cost — never a raw sum (§4.4.4.5). */
  billable: number;
  /** Wait this long before admitting the cohort. */
  delayMs: number;
  /** True when the cohort fits inside what is left of the window. */
  admit: boolean;
  reason: "clear" | "paced" | "window_exhausted";
}

/**
 * §9.7 rule 2: "a large import degrades to SLOWER, never to FAILED."
 *
 * So a cohort that does not fit in the remaining allowance is not dropped and
 * not shrunk to nothing — it waits for the window to roll. Everything that does
 * fit is admitted immediately; there is no artificial drip while headroom
 * exists, because an idle pipeline with work outstanding is §9.7 rule 1's
 * defect.
 */
export function paceCohort(input: PacingInput): PacingDecision {
  const billable = billableTokens({
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheCreationInputTokens: input.cacheCreationTokens ?? 0,
    cacheReadInputTokens: input.cacheReadTokens ?? 0,
  });
  const headroom = Math.max(0, input.windowLimit - input.spentInWindow);
  if (billable <= headroom) return { billable, delayMs: 0, admit: true, reason: "clear" };
  if (billable > input.windowLimit) {
    // Bigger than a whole window: waiting cannot help, so it is admitted and
    // the provider's own pause handles the overrun (§4.6). Refusing it here
    // would be the "degrades to failed" outcome the rule forbids.
    return { billable, delayMs: 0, admit: true, reason: "window_exhausted" };
  }
  return {
    billable,
    delayMs: Math.max(0, input.windowRemainingMs),
    admit: false,
    reason: "paced",
  };
}

/**
 * §9.7 rule 2's visible pacing — "~40 min remaining at current rate". Returns
 * null while nothing has been measured, because a made-up estimate is worse
 * than none.
 */
export function remainingMinutes(doneUnits: number, totalUnits: number, unitsPerMinute: number): number | null {
  if (!(unitsPerMinute > 0)) return null;
  const left = Math.max(0, totalUnits - doneUnits);
  return Math.ceil(left / unitsPerMinute);
}
