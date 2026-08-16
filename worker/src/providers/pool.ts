// ===========================================================================
// [CODE] Per-resource-class concurrency (arch §4.4.1 / §4.4.2 / §4.4.3 / §4.6).
//
// A single global "16 parallel" number is wrong. LLM calls are network- and
// subscription-bound (~250–350 MB per CLI child); whisper is Metal-bound and
// sixteen concurrent instances run SLOWER than three; embeddings and ffmpeg are
// CPU-bound. So each resource class carries its own semaphore with its own
// default and its own ceiling.
//
// DB apply is not a class here: SQLite has a single writer and WAL enforces the
// serialization for free (arch §4.4.2 — "compute in parallel, apply through a
// serialized writer").
//
// Three behaviours beyond plain counting, all load-bearing:
//
//  1. LANE SPLIT (§4.4.1.1). Enrichment (media captions) and understanding
//     (extraction) are both LLM calls competing for one rate limit. The pool is
//     split by share — 40 % enrichment / 60 % understanding — so a photo
//     backlog can never starve extraction and extraction can never leave media
//     unread. FIRST PAINT overrides that to enrichment 0: until the user has
//     something on screen, every slot goes to understanding.
//
//  2. WARM-THEN-FAN-OUT (§4.4.3.1). A cache entry only becomes readable once
//     the first response has BEGUN. Firing 8 parallel calls that share a prefix
//     is 8 misses plus 8 write premiums (1.25×) — 25 % worse than not caching.
//     So `caching.warm_first` (default ON) runs the first call of a batch alone
//     and releases the remaining N−1 only after it returns.
//
//  3. ERROR POLICY (§4.6). A refusal (rate limit, auth, quota) is an outage,
//     not the unit's fault: pause the lane, back off 60 s → 900 s, and DO NOT
//     spend the unit's retry budget — punishing good units for an outage is how
//     a whole backlog gets quarantined. Every other failure retries
//     2 s / 10 s / 30 s and is then quarantined so the rest keep moving.
//     The code set is the provider's existing seven; there is no AUTH_REQUIRED.
// ===========================================================================

import type { ProviderErrorCode } from "./types.js";

// ---------------------------------------------------------------------------
// Classes and limits
// ---------------------------------------------------------------------------

export type ResourceClass =
  | "llm"
  | "transcribe"
  | "embed"
  | "ffmpeg"
  | "scrape";

export interface ClassLimit {
  /** Default on an 8 GB M-series machine. */
  default: number;
  /** Ceiling the user's setting is clamped to. */
  max: number;
}

/** arch §4.4.1 table, verbatim. */
export const RESOURCE_LIMITS: Record<ResourceClass, ClassLimit> = {
  llm: { default: 8, max: 16 },
  transcribe: { default: 1, max: 3 },
  embed: { default: 2, max: 8 },
  ffmpeg: { default: 2, max: 4 },
  scrape: { default: 8, max: 16 },
};

/** SQLite is a single writer. Fixed, not a setting. */
export const DB_APPLY_CONCURRENCY = 1;

export type LlmLane = "enrichment" | "understanding";

/** Enrichment's share of the LLM pool when first paint is done (§4.4.1.1). */
export const ENRICHMENT_SHARE = 0.4;

/** How long sustained refusals halve the effective LLM concurrency (§4.4.1.2). */
export const DEGRADE_WINDOW_MS = 600_000;

/** Consecutive refusals on one lane before the whole LLM pool is halved. */
export const DEGRADE_AFTER_REFUSALS = 2;

export function clampLimit(cls: ResourceClass, n: number): number {
  const { max } = RESOURCE_LIMITS[cls];
  if (!Number.isFinite(n)) return RESOURCE_LIMITS[cls].default;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

/**
 * Lane caps for an effective LLM limit. Under first paint enrichment gets 0 —
 * its acquires simply queue until `setFirstPaint(false)`. Otherwise each lane
 * keeps at least one slot; at small limits the caps deliberately sum above the
 * pool limit, and the shared pool semaphore does the real capping.
 */
export function laneCaps(
  limit: number,
  firstPaint: boolean,
): Record<LlmLane, number> {
  if (firstPaint) return { enrichment: 0, understanding: limit };
  const enrichment = Math.max(1, Math.round(limit * ENRICHMENT_SHARE));
  return { enrichment, understanding: Math.max(1, limit - enrichment) };
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

/** Release a held slot. Idempotent — calling it twice never over-credits. */
export type Release = () => void;

export class Semaphore {
  private limit: number;
  private active = 0;
  private peak = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(0, Math.floor(limit));
  }

  get capacity(): number {
    return this.limit;
  }
  get inFlight(): number {
    return this.active;
  }
  get waiting(): number {
    return this.waiters.length;
  }
  /** High-water mark of concurrent holders — what the cap tests assert on. */
  get peakInFlight(): number {
    return this.peak;
  }

  setLimit(n: number): void {
    this.limit = Math.max(0, Math.floor(n));
    this.pump();
  }

  acquire(): Promise<Release> {
    return new Promise<Release>((resolve) => {
      const grant = () => {
        this.active += 1;
        if (this.active > this.peak) this.peak = this.active;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.pump();
        });
      };
      if (this.active < this.limit) grant();
      else this.waiters.push(grant);
    });
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Error policy (§4.6)
// ---------------------------------------------------------------------------

/**
 * What "not now" looks like coming back from the CLI. Auth failures arrive as
 * CLI_ERROR with a refusal-shaped message — there is NO AUTH_REQUIRED code.
 */
export const REFUSAL_RE =
  /rate.limit|too many requests|\b429\b|\b40[13]\b|quota|usage limit|unauthorized|authentication|invalid api key|credit balance|\/login/i;

/** Refusal backoff: first wait, doubling, and its ceiling. */
export const REFUSAL_BACKOFF_BASE_MS = 60_000;
export const REFUSAL_BACKOFF_MAX_MS = 900_000;

/** Ordinary-failure retry ladder. Exhausted → quarantine. */
export const RETRY_DELAYS_MS = [2_000, 10_000, 30_000] as const;

export interface ProviderFailure {
  code?: ProviderErrorCode | string;
  message?: string;
}

export type FailureAction = "pause" | "retry" | "quarantine" | "cancelled";

export interface FailureDecision {
  action: FailureAction;
  /** Wait before the lane (pause) or the unit (retry) may run again. */
  waitMs: number;
  /** A refusal must NEVER consume the unit's retry budget. */
  spendsRetryBudget: boolean;
  reason: "refusal" | "error" | "cancelled";
}

/** True for the outage-shaped failures: rate limit, quota, auth. */
export function isRefusal(err: ProviderFailure): boolean {
  if (err.code === "QUOTA_EXCEEDED") return true;
  return REFUSAL_RE.test(err.message ?? "");
}

/** Refusal backoff for the nth consecutive refusal (n counted from 1). */
export function refusalBackoffMs(consecutive: number): number {
  const n = Math.max(1, Math.floor(consecutive));
  return Math.min(
    REFUSAL_BACKOFF_MAX_MS,
    REFUSAL_BACKOFF_BASE_MS * 2 ** (n - 1),
  );
}

/**
 * Decide what one failure means. `retriesSpent` is how many retries this unit
 * has already burned — refusals never increment it.
 */
export function classifyFailure(
  err: ProviderFailure,
  retriesSpent = 0,
  consecutiveRefusals = 1,
): FailureDecision {
  if (err.code === "CANCELLED") {
    return {
      action: "cancelled",
      waitMs: 0,
      spendsRetryBudget: false,
      reason: "cancelled",
    };
  }
  if (isRefusal(err)) {
    return {
      action: "pause",
      waitMs: refusalBackoffMs(consecutiveRefusals),
      spendsRetryBudget: false,
      reason: "refusal",
    };
  }
  const spent = Math.max(0, Math.floor(retriesSpent));
  if (spent >= RETRY_DELAYS_MS.length) {
    return {
      action: "quarantine",
      waitMs: 0,
      spendsRetryBudget: false,
      reason: "error",
    };
  }
  return {
    action: "retry",
    waitMs: RETRY_DELAYS_MS[spent],
    spendsRetryBudget: true,
    reason: "error",
  };
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

/** A pausable lane: an LLM lane, or a whole non-LLM class. */
export type LaneKey = `llm:${LlmLane}` | ResourceClass;

export interface PoolOptions {
  limits?: Partial<Record<ResourceClass, number>>;
  /** caching.warm_first — default ON (§4.4.3.1). */
  warmFirst?: boolean;
  /** First paint in progress: enrichment gets zero slots. */
  firstPaint?: boolean;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests) — used only when waiting out a lane pause. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions {
  /** Which half of the LLM pool this call belongs to. Default: understanding. */
  lane?: LlmLane;
}

export interface BatchOptions extends RunOptions {
  /** Per-batch override of caching.warm_first. */
  warmFirst?: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

export class ResourcePool {
  private readonly sems: Record<ResourceClass, Semaphore>;
  private readonly laneSems: Record<LlmLane, Semaphore>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** The user's ceiling for the LLM class (before adaptive degradation). */
  private llmCeiling: number;
  private firstPaint: boolean;
  private warmFirst: boolean;
  private degradedUntil = 0;
  private readonly pausedUntilMs = new Map<LaneKey, number>();
  private readonly refusalStreak = new Map<LaneKey, number>();

  constructor(opts: PoolOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.warmFirst = opts.warmFirst ?? true;
    this.firstPaint = opts.firstPaint ?? false;
    this.llmCeiling = clampLimit("llm", opts.limits?.llm ?? RESOURCE_LIMITS.llm.default);

    const sems = {} as Record<ResourceClass, Semaphore>;
    for (const cls of Object.keys(RESOURCE_LIMITS) as ResourceClass[]) {
      const want = cls === "llm" ? this.llmCeiling : opts.limits?.[cls];
      sems[cls] = new Semaphore(
        clampLimit(cls, want ?? RESOURCE_LIMITS[cls].default),
      );
    }
    this.sems = sems;

    const caps = laneCaps(this.llmCeiling, this.firstPaint);
    this.laneSems = {
      enrichment: new Semaphore(caps.enrichment),
      understanding: new Semaphore(caps.understanding),
    };
  }

  // ---- configuration ------------------------------------------------------

  /** Apply user settings (`concurrency.*`). Values are clamped to the table. */
  configure(limits: Partial<Record<ResourceClass, number>>): void {
    for (const [cls, n] of Object.entries(limits) as [
      ResourceClass,
      number | undefined,
    ][]) {
      if (typeof n !== "number") continue;
      if (cls === "llm") this.llmCeiling = clampLimit("llm", n);
      else this.sems[cls].setLimit(clampLimit(cls, n));
    }
    this.refreshLlm();
  }

  setWarmFirst(on: boolean): void {
    this.warmFirst = on;
  }

  get warmFirstEnabled(): boolean {
    return this.warmFirst;
  }

  /** First paint in progress → enrichment gets zero slots (§4.4.1.1). */
  setFirstPaint(on: boolean): void {
    this.firstPaint = on;
    this.refreshLlm();
  }

  limitOf(cls: ResourceClass): number {
    return this.sems[cls].capacity;
  }

  laneLimit(lane: LlmLane): number {
    return this.laneSems[lane].capacity;
  }

  inFlight(cls: ResourceClass): number {
    return this.sems[cls].inFlight;
  }

  peakInFlight(cls: ResourceClass): number {
    return this.sems[cls].peakInFlight;
  }

  lanePeakInFlight(lane: LlmLane): number {
    return this.laneSems[lane].peakInFlight;
  }

  // ---- running work -------------------------------------------------------

  /** Run `fn` holding one slot of `cls` (and of its LLM lane, when llm). */
  async run<T>(
    cls: ResourceClass,
    fn: () => Promise<T> | T,
    opts: RunOptions = {},
  ): Promise<T> {
    if (cls !== "llm") {
      await this.awaitResume(cls);
      return this.sems[cls].run(fn);
    }
    const lane = opts.lane ?? "understanding";
    // A pause on the bare "llm" family (the ops surface's "LLM pool" row)
    // holds BOTH lanes; a composite pause holds just its lane. Re-check both
    // until neither is paused — one can be re-paused while the other waits.
    while (this.isPaused("llm") || this.isPaused(`llm:${lane}`)) {
      await this.awaitResume("llm");
      await this.awaitResume(`llm:${lane}`);
    }
    this.refreshLlm();
    const laneRelease = await this.laneSems[lane].acquire();
    try {
      return await this.sems.llm.run(fn);
    } finally {
      laneRelease();
    }
  }

  /**
   * Warm-then-fan-out (§4.4.3.1). With warm_first on, task[0] runs ALONE and
   * the remaining N−1 are released only once it has returned; with it off the
   * whole batch is dispatched at once and the pool caps do the pacing.
   */
  async runBatch<T>(
    cls: ResourceClass,
    tasks: Array<() => Promise<T> | T>,
    opts: BatchOptions = {},
  ): Promise<T[]> {
    if (tasks.length === 0) return [];
    const warm = opts.warmFirst ?? this.warmFirst;
    if (!warm || tasks.length === 1) {
      return Promise.all(tasks.map((t) => this.run(cls, t, opts)));
    }
    const first = await this.run(cls, tasks[0], opts);
    const rest = await Promise.all(
      tasks.slice(1).map((t) => this.run(cls, t, opts)),
    );
    return [first, ...rest];
  }

  // ---- error policy -------------------------------------------------------

  /**
   * Record one failure against a lane and get the decision. A refusal pauses
   * the lane for a doubling backoff and does NOT spend the unit's retry budget;
   * anything else walks the 2 s / 10 s / 30 s ladder and is then quarantined.
   */
  noteFailure(
    lane: LaneKey,
    err: ProviderFailure,
    retriesSpent = 0,
  ): FailureDecision {
    if (isRefusal(err) && err.code !== "CANCELLED") {
      const streak = (this.refusalStreak.get(lane) ?? 0) + 1;
      this.refusalStreak.set(lane, streak);
      const decision = classifyFailure(err, retriesSpent, streak);
      this.pausedUntilMs.set(lane, this.now() + decision.waitMs);
      // Sustained refusals halve the effective LLM concurrency for a window,
      // then it ramps back on its own (§4.4.1.2).
      if (streak >= DEGRADE_AFTER_REFUSALS && lane.startsWith("llm:")) {
        this.degradedUntil = this.now() + DEGRADE_WINDOW_MS;
        this.refreshLlm();
      }
      return decision;
    }
    return classifyFailure(err, retriesSpent, 0);
  }

  /** A completed call clears the lane's refusal streak. */
  noteSuccess(lane: LaneKey): void {
    this.refusalStreak.delete(lane);
  }

  /** Milliseconds until `lane` may run again; 0 when it is not paused. */
  pausedForMs(lane: LaneKey): number {
    const until = this.pausedUntilMs.get(lane);
    if (until === undefined) return 0;
    return Math.max(0, until - this.now());
  }

  isPaused(lane: LaneKey): boolean {
    return this.pausedForMs(lane) > 0;
  }

  /**
   * Pause a lane by hand (the ops surface's per-lane pause, build item 4.4).
   * Same mechanism as a refusal pause — `awaitResume` holds new work and the
   * coverage meter renders the countdown — but it never touches the refusal
   * streak, so a manual pause cannot degrade the LLM limit.
   */
  pauseLane(lane: LaneKey, ms: number): void {
    this.pausedUntilMs.set(lane, this.now() + Math.max(0, ms));
  }

  /** Clear a pause early (the limit lifted, or the user retried by hand). */
  resumeLane(lane: LaneKey): void {
    this.pausedUntilMs.delete(lane);
    this.refusalStreak.delete(lane);
  }

  /** Effective LLM limit right now — halved while degraded. */
  effectiveLlmLimit(): number {
    const degraded = this.degradedUntil > this.now();
    return degraded
      ? Math.max(1, Math.floor(this.llmCeiling / 2))
      : this.llmCeiling;
  }

  // ---- internals ----------------------------------------------------------

  private refreshLlm(): void {
    const limit = this.effectiveLlmLimit();
    this.sems.llm.setLimit(limit);
    const caps = laneCaps(limit, this.firstPaint);
    this.laneSems.enrichment.setLimit(caps.enrichment);
    this.laneSems.understanding.setLimit(caps.understanding);
  }

  private async awaitResume(lane: LaneKey): Promise<void> {
    // A paused lane is never a silent stall: pausedForMs() is what the coverage
    // meter renders as "paused — resumes in mm:ss" (§4.6.4).
    let wait = this.pausedForMs(lane);
    while (wait > 0) {
      await this.sleep(wait);
      wait = this.pausedForMs(lane);
    }
    this.pausedUntilMs.delete(lane);
  }
}

/** The process-wide pool. Callers should share this rather than build their own. */
export const resourcePool = new ResourcePool();
export default resourcePool;
