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
// Five behaviours beyond plain counting, all load-bearing:
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
//
//  4. BREAKER (V6 P1 S0.7 / T0-10, Product §23.4, SPD-07). Ten consecutive
//     NON-refusal failures on one lane pause that lane for 30 minutes and raise
//     a banner (`breakers()`, surfaced on /api/ops). A refusal is an outage and
//     already has its own backoff; the breaker is for the other shape — a
//     model, prompt or transport that is failing every call and would otherwise
//     quarantine the whole backlog one unit at a time while spending on each.
//
//  5. BOUNDED WAITERS (S0.7 / T0-12, BND-12). A class admits at most 4× its
//     capacity of queued callers; the next `run()` is rejected with
//     PoolOverflowError instead of joining a queue nobody can see. That turns a
//     silent eight-hour wait into a visible rejection the dispatcher can act
//     on, and `waiting()` is readable on /api/ops.
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

/** Consecutive NON-refusal failures on one lane that trip its breaker (SPD-07). */
export const BREAKER_FAILURES = 10;

/** How long a tripped breaker holds the lane (Product §23.4: 30 minutes). */
export const BREAKER_PAUSE_MS = 30 * 60_000;

/** Queued callers a class admits, as a multiple of its capacity (BND-12). */
export const WAITER_CAP_MULTIPLIER = 4;

/** Waiters a class of `capacity` slots may hold before `run()` rejects. */
export function waiterCapFor(capacity: number): number {
  return Math.max(WAITER_CAP_MULTIPLIER, WAITER_CAP_MULTIPLIER * Math.max(0, Math.floor(capacity)));
}

/**
 * Thrown by `run()` when the class already holds its full complement of
 * waiters. Nothing was started: the caller still owns the unit, and the right
 * response is backpressure (dispatch less), never a retry loop.
 */
export class PoolOverflowError extends Error {
  readonly code = "POOL_OVERFLOW" as const;
  constructor(
    readonly cls: ResourceClass,
    readonly waiting: number,
    readonly cap: number,
  ) {
    super(`pool "${cls}" is full: ${waiting} callers already waiting (cap ${cap})`);
    this.name = "PoolOverflowError";
  }
}

export function isPoolOverflow(err: unknown): err is PoolOverflowError {
  return err instanceof PoolOverflowError || (
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === "POOL_OVERFLOW"
  );
}

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
  /**
   * Set on the failure that tripped the lane's breaker (SPD-07): the lane is
   * now paused for BREAKER_PAUSE_MS and a banner is up. The unit's own
   * decision (retry / quarantine) is unchanged — the pause is served by the
   * pool on its next `run()`, not by this unit waiting in place.
   */
  breakerTripped?: boolean;
}

/** One tripped breaker — the banner's payload (SPD-07). */
export interface BreakerTrip {
  lane: LaneKey;
  /** ISO time of the trip. */
  trippedAt: string;
  /** Epoch ms the lane resumes on its own. */
  untilMs: number;
  /** Consecutive failures that tripped it (== BREAKER_FAILURES). */
  failures: number;
  /** The last failure's code and message — what the banner explains. */
  lastCode: string | null;
  lastError: string | null;
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
  /** Consecutive NON-refusal failures per lane — the breaker's counter. */
  private readonly errorStreak = new Map<LaneKey, number>();
  private readonly trips = new Map<LaneKey, BreakerTrip>();
  private readonly breakerListeners = new Set<(trip: BreakerTrip) => void>();
  /** Callers admitted to `run()` for a class that do not hold a slot yet. */
  private readonly waitingByClass = new Map<ResourceClass, number>();
  private readonly waitingByLane = new Map<LlmLane, number>();

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

  /** Callers queued for a class — admitted to `run()`, not yet holding a slot. */
  waiting(cls: ResourceClass): number {
    return this.waitingByClass.get(cls) ?? 0;
  }

  /** Queued callers on one LLM lane (a subset of `waiting("llm")`). */
  laneWaiting(lane: LlmLane): number {
    return this.waitingByLane.get(lane) ?? 0;
  }

  /** Most waiters a class admits before `run()` rejects (4× its ceiling). */
  waiterCap(cls: ResourceClass): number {
    // The LLM cap follows the user's ceiling, not the degraded limit: an
    // outage halving concurrency must not also start rejecting the backlog.
    return waiterCapFor(cls === "llm" ? this.llmCeiling : this.sems[cls].capacity);
  }

  // ---- running work -------------------------------------------------------

  /**
   * Run `fn` holding one slot of `cls` (and of its LLM lane, when llm).
   *
   * Rejects with PoolOverflowError — before anything is queued — when the
   * class already holds 4× its capacity in waiters (BND-12). Everything from
   * admission to slot grant counts as waiting: a paused lane's hold, the lane
   * cap and the class cap alike, so `waiting()` is the whole invisible queue.
   */
  async run<T>(
    cls: ResourceClass,
    fn: () => Promise<T> | T,
    opts: RunOptions = {},
  ): Promise<T> {
    // Admission is counted, not observed: a caller is "waiting" from the
    // moment it is admitted until it holds a slot, so a burst submitted in one
    // tick is judged as the queue it WILL form — capacity runs, 4× capacity
    // waits, the rest is rejected before it queues at all.
    const queued = this.waiting(cls);
    const cap = this.waiterCap(cls);
    const free = Math.max(0, this.sems[cls].capacity - this.sems[cls].inFlight);
    if (queued >= cap + free) throw new PoolOverflowError(cls, queued - free, cap);

    if (cls !== "llm") {
      this.bumpWaiting(cls, undefined, +1);
      let release: Release | undefined;
      try {
        await this.awaitResume(cls);
        release = await this.sems[cls].acquire();
      } finally {
        this.bumpWaiting(cls, undefined, -1);
      }
      try {
        return await fn();
      } finally {
        release!();
      }
    }

    const lane = opts.lane ?? "understanding";
    this.bumpWaiting("llm", lane, +1);
    let laneRelease: Release | undefined;
    let slotRelease: Release | undefined;
    try {
      // A pause on the bare "llm" family (the ops surface's "LLM pool" row)
      // holds BOTH lanes; a composite pause holds just its lane. Re-check both
      // until neither is paused — one can be re-paused while the other waits.
      while (this.isPaused("llm") || this.isPaused(`llm:${lane}`)) {
        await this.awaitResume("llm");
        await this.awaitResume(`llm:${lane}`);
      }
      this.refreshLlm();
      laneRelease = await this.laneSems[lane].acquire();
      slotRelease = await this.sems.llm.acquire();
    } finally {
      this.bumpWaiting("llm", lane, -1);
    }
    try {
      return await fn();
    } finally {
      slotRelease!();
      laneRelease!();
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
    if (err.code === "CANCELLED") {
      // A cancel is nobody's failure: neither streak moves.
      return classifyFailure(err, retriesSpent, 0);
    }
    if (isRefusal(err)) {
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
    // A non-refusal failure: the unit walks its ladder as before, and the lane
    // counts towards its breaker (SPD-07). Ten in a row with no success between
    // them is not ten unlucky units — it is a lane that cannot currently work.
    const decision = classifyFailure(err, retriesSpent, 0);
    const streak = (this.errorStreak.get(lane) ?? 0) + 1;
    if (streak >= BREAKER_FAILURES) {
      this.errorStreak.delete(lane);
      this.tripBreaker(lane, streak, err);
      return { ...decision, breakerTripped: true };
    }
    this.errorStreak.set(lane, streak);
    return decision;
  }

  /** A completed call clears the lane's refusal streak and its breaker count. */
  noteSuccess(lane: LaneKey): void {
    this.refusalStreak.delete(lane);
    this.errorStreak.delete(lane);
  }

  /** Consecutive non-refusal failures on `lane` since its last success. */
  consecutiveFailures(lane: LaneKey): number {
    return this.errorStreak.get(lane) ?? 0;
  }

  /** Every breaker currently holding a lane — the banners (SPD-07). */
  breakers(): BreakerTrip[] {
    const now = this.now();
    const live: BreakerTrip[] = [];
    for (const [lane, trip] of this.trips) {
      if (trip.untilMs > now && this.isPaused(lane)) live.push(trip);
      else this.trips.delete(lane);
    }
    return live;
  }

  /** The breaker holding `lane`, or null when it is not tripped. */
  breakerFor(lane: LaneKey): BreakerTrip | null {
    return this.breakers().find((t) => t.lane === lane) ?? null;
  }

  /** Be told when a breaker trips (the operator log, a notification). */
  onBreaker(listener: (trip: BreakerTrip) => void): () => void {
    this.breakerListeners.add(listener);
    return () => {
      this.breakerListeners.delete(listener);
    };
  }

  private tripBreaker(lane: LaneKey, failures: number, err: ProviderFailure): void {
    const now = this.now();
    this.pauseLane(lane, BREAKER_PAUSE_MS);
    const trip: BreakerTrip = {
      lane,
      trippedAt: new Date(now).toISOString(),
      untilMs: now + BREAKER_PAUSE_MS,
      failures,
      lastCode: err.code === undefined ? null : String(err.code),
      lastError: err.message ?? null,
    };
    this.trips.set(lane, trip);
    // Never a silent retry (SPD-07 wrong mode): the trip is in the operator
    // log the moment it happens, and on /api/ops until the lane resumes.
    console.error(
      `[breaker] ${lane} paused ${Math.round(BREAKER_PAUSE_MS / 60_000)}m after ` +
        `${failures} consecutive failures — last: ${trip.lastCode ?? "?"} ${trip.lastError ?? ""}`.trimEnd(),
    );
    for (const listener of this.breakerListeners) {
      try {
        listener(trip);
      } catch {
        // A listener's failure must not take the pool with it.
      }
    }
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
    this.errorStreak.delete(lane);
    this.trips.delete(lane);
  }

  /** Effective LLM limit right now — halved while degraded. */
  effectiveLlmLimit(): number {
    const degraded = this.degradedUntil > this.now();
    return degraded
      ? Math.max(1, Math.floor(this.llmCeiling / 2))
      : this.llmCeiling;
  }

  // ---- internals ----------------------------------------------------------

  private bumpWaiting(cls: ResourceClass, lane: LlmLane | undefined, delta: 1 | -1): void {
    this.waitingByClass.set(cls, Math.max(0, this.waiting(cls) + delta));
    if (lane) this.waitingByLane.set(lane, Math.max(0, this.laneWaiting(lane) + delta));
  }

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
