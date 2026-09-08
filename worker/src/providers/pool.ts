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
//  3. ERROR POLICY (§4.6). A refusal (rate limit or quota) is an outage,
//     not the unit's fault: pause the lane, back off 60 s → 900 s, and DO NOT
//     spend the unit's retry budget — punishing good units for an outage is how
//     a whole backlog gets quarantined. Transient failures retry 2 s / 10 s /
//     30 s and are then quarantined so the rest keep moving; stale model and
//     unsupported-capability failures quarantine immediately.
//     Authentication and unavailable-provider states are explicit holds: only
//     a human or compatibility change clears them, so retrying wastes work.
//
//  4. BREAKER (V6 P1 S0.7 / T0-10, Product §23.4, SPD-07). Ten consecutive
//     NON-refusal failures on one lane pause that lane for 30 minutes and raise
//     a banner (`breakers()`, surfaced on /api/ops). A refusal is an outage and
//     already has its own backoff; the breaker is for the other shape — a
//     model, prompt or transport that is failing every call and would otherwise
//     quarantine the whole backlog one unit at a time while spending on each.
//
//     4b. HARD STOP (13.11.6, FIX-C1). A fourth shape sits beside the refusal
//     and the soft stop: the budget latch and the "stop all model activity"
//     switch refuse BEFORE the process is spawned, and by construction neither
//     clears on its own — only a human clears them. Fed to the breaker as
//     ordinary errors (what the 13.11.5 install did) ten of them in a row
//     paused the lane for 30 minutes, it auto-resumed, was refused again and
//     re-tripped: an unbounded spin against a permanent condition, spending a
//     `runs` row and a retry ladder on every turn. So a hard stop is its own
//     decision — `action: "hold"` — and it feeds NEITHER streak: the lane is
//     not broken, the unit is not at fault, and there is nothing to retry
//     until someone resumes. A hold is NOT a quarantine: the work is still
//     good and is offered again after the reset, which is why the lane entry
//     gates (scheduler/v6/dispatch, media/queue, executor/queue-job) ask
//     providers/budget's `backgroundModelHold()` before building any work at
//     all, and this decision only ever catches the race.
//
//  5. BOUNDED WAITERS (S0.7 / T0-12, BND-12). A class admits at most 4× its
//     capacity of queued callers; the next `run()` is rejected with
//     PoolOverflowError instead of joining a queue nobody can see. That turns a
//     silent eight-hour wait into a visible rejection the dispatcher can act
//     on, and `waiting()` is readable on /api/ops.
// ===========================================================================

import { totalmem } from "node:os";

import type { ProviderErrorCode, ProviderId } from "./types.js";

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

/** Both providers ship at the deliberately conservative §10 limit. */
export const PROVIDER_LLM_LIMITS: Readonly<Record<ProviderId, ClassLimit>> =
  Object.freeze({
    "claude-local": Object.freeze({ ...RESOURCE_LIMITS.llm }),
    "chatgpt-oauth": Object.freeze({ ...RESOURCE_LIMITS.llm }),
  });

/** SQLite is a single writer. Fixed, not a setting. */
export const DB_APPLY_CONCURRENCY = 1;

/**
 * `live` is the state-gate flush lane (V6 P1 S3.3, Product_V6 §14.2.4 /
 * §23.2): it holds RESERVED slots the background lanes can never fill, so a
 * live flush never queues behind history. `understanding` is history + digest;
 * `enrichment` is media captions.
 */
export type LlmLane = "enrichment" | "understanding" | "live";

/** Slots of the LLM pool held back for the live lane (GATE-09). */
export const LIVE_RESERVED_SLOTS = 1;

/** Enrichment's share of the LLM pool when first paint is done (§4.4.1.1). */
export const ENRICHMENT_SHARE = 0.4;

/** How long sustained refusals halve the effective LLM concurrency (§4.4.1.2). */
export const DEGRADE_WINDOW_MS = 600_000;

/** Legacy Claude refusal streak before that provider's pool is halved. */
export const DEGRADE_AFTER_REFUSALS = 2;

/** Repeated transport failures are pressure; one isolated socket failure is not. */
export const CHATGPT_TRANSPORT_FAILURES_BEFORE_REDUCE = 2;

/** Recovery is deliberately additive: never jump straight back to the ceiling. */
export const CHATGPT_RAMP_INTERVAL_MS = 5 * 60_000;

/** Above this measured RSS share the HTTP provider sheds concurrency. */
export const CHATGPT_MEMORY_PRESSURE_RATIO = 0.85;

/** One slot for each lane: adaptive shedding never strands preserved work. */
export const CHATGPT_ADAPTIVE_MIN = 3;

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

/** ChatGPT must retain one runnable slot for every LLM lane. */
function clampProviderLlmLimit(providerId: ProviderId, n: number): number {
  const bounded = clampLimit("llm", n);
  return providerId === "chatgpt-oauth"
    ? Math.max(CHATGPT_ADAPTIVE_MIN, bounded)
    : bounded;
}

/**
 * Lane caps for an effective LLM limit. The live lane takes its reserved slots
 * first; the background lanes split the REST, so their caps sum to at most
 * `limit - LIVE_RESERVED_SLOTS` and a live flush always finds a free pool slot
 * (GATE-09). Under first paint enrichment gets 0 — its acquires simply queue
 * until `setFirstPaint(false)`. At limits 1–2 the live reservation remains
 * load-bearing: background work stays queued rather than borrowing that slot.
 */
export function laneCaps(
  limit: number,
  firstPaint: boolean,
): Record<LlmLane, number> {
  const live = Math.max(0, Math.min(LIVE_RESERVED_SLOTS, limit));
  const rest = Math.max(0, limit - live);
  if (rest === 0) return { live, enrichment: 0, understanding: 0 };
  if (firstPaint) return { live, enrichment: 0, understanding: rest };
  if (rest === 1) return { live, enrichment: 0, understanding: 1 };
  const enrichment = Math.max(1, Math.round(rest * ENRICHMENT_SHARE));
  return { live, enrichment, understanding: Math.max(1, rest - enrichment) };
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

/** Release a held slot. Idempotent — calling it twice never over-credits. */
export type Release = () => void;

export class PoolCancelledError extends Error {
  readonly code = "CANCELLED" as const;
  constructor() {
    super("pool wait cancelled");
    this.name = "PoolCancelledError";
  }
}

interface SemaphoreWaiter {
  grant: () => void;
  reject: (error: PoolCancelledError) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class Semaphore {
  private limit: number;
  private active = 0;
  private peak = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

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

  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(new PoolCancelledError());
    return new Promise<Release>((resolve, reject) => {
      let waiter: SemaphoreWaiter;
      const grant = () => {
        signal?.removeEventListener("abort", waiter.onAbort!);
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
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new PoolCancelledError());
      };
      waiter = { grant, reject, signal, onAbort };
      if (this.active < this.limit) grant();
      else {
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(waiter);
      }
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
      next?.grant();
    }
  }
}

// ---------------------------------------------------------------------------
// Error policy (§4.6)
// ---------------------------------------------------------------------------

/**
 * Legacy Claude CLI refusal text. Only a CLI_ERROR may use this fallback;
 * providers with typed errors are classified exclusively by code.
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
  /** Parsed, bounded backend Retry-After hint. */
  retryAfterMs?: number;
}

export type FailureAction = "pause" | "retry" | "quarantine" | "cancelled" | "hold";

export interface FailureDecision {
  action: FailureAction;
  /** Wait before the lane (pause) or the unit (retry) may run again. */
  waitMs: number;
  /** A refusal must NEVER consume the unit's retry budget. */
  spendsRetryBudget: boolean;
  reason: "refusal" | "error" | "cancelled" | "hard-stop";
  /**
   * Set on the failure that tripped the lane's breaker (SPD-07): the lane is
   * now paused for BREAKER_PAUSE_MS and a banner is up. The unit's own
   * decision (retry / quarantine) is unchanged — the pause is served by the
   * pool on its next `run()`, not by this unit waiting in place.
   */
  breakerTripped?: boolean;
  /**
   * Set when the provider stopped SOFTLY — today only MAX_TURNS (FIX-C2). The
   * call did not break: it ran out of turns with the model's own words already
   * streamed. `action` is "quarantine" so no caller loops by accident, but a
   * caller that knows how to salvage or re-ask narrowly should do that instead
   * of parking the unit. Never counted towards the lane's breaker.
   */
  softStop?: boolean;
  /**
   * Set when a permanent pre-send condition refuses work — a budget/kill
   * switch, auth state, unavailable provider, or incompatible backend.
   * `action` is "hold": nothing ran and waiting alone cannot fix it. The
   * caller must not retry, quarantine, or dead-letter the unit.
   */
  hardStop?: boolean;
}

/** One tripped breaker — the banner's payload (SPD-07). */
export interface BreakerTrip {
  /** Added in Phase 5; absent only on one-release legacy/test fixtures. */
  providerId?: ProviderId;
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

/**
 * True for a SOFT provider stop (FIX-C2): the CLI ended the run on its own
 * turn cap rather than failing. It is not an outage and it is not a defect, so
 * it must neither pause the lane (a refusal) nor count towards the S0.7
 * consecutive-failure breaker (an error) — the caller salvages the partial
 * answer or re-asks narrowly.
 */
export function isSoftStop(err: ProviderFailure): boolean {
  if (err.code === "MAX_TURNS") return true;
  return (
    err.code === "CLI_ERROR" &&
    /reached maximum number of turns/i.test(err.message ?? "")
  );
}

/**
 * True for a permanent pre-send hold (FIX-C1 / V2 §7.2). Nothing ran, the unit
 * did nothing wrong, and retrying cannot clear a latch, missing login/provider,
 * or incompatible backend.
 */
export function isHardStop(err: ProviderFailure): boolean {
  return (
    err.code === "BUDGET_EXCEEDED" ||
    err.code === "MODEL_ACTIVITY_PAUSED" ||
    err.code === "AUTH_REQUIRED" ||
    err.code === "AUTH_EXPIRED" ||
    err.code === "PROVIDER_UNAVAILABLE" ||
    err.code === "BACKEND_UNSUPPORTED"
  );
}

/** True for outage-shaped failures. Typed codes win over legacy CLI text. */
export function isRefusal(err: ProviderFailure): boolean {
  if (err.code === "QUOTA_EXCEEDED" || err.code === "RATE_LIMITED") return true;
  return err.code === "CLI_ERROR" && REFUSAL_RE.test(err.message ?? "");
}

const PROVIDER_ERROR_CODES = {
  TIMEOUT: true,
  SPAWN_FAILED: true,
  CLI_ERROR: true,
  POISONED_SESSION: true,
  CANCELLED: true,
  QUOTA_EXCEEDED: true,
  BUDGET_EXCEEDED: true,
  MODEL_ACTIVITY_PAUSED: true,
  MAX_TURNS: true,
  BAD_REQUEST: true,
  AUTH_REQUIRED: true,
  AUTH_EXPIRED: true,
  PROVIDER_UNAVAILABLE: true,
  MODEL_UNAVAILABLE: true,
  CAPABILITY_UNSUPPORTED: true,
  BACKEND_UNSUPPORTED: true,
  RATE_LIMITED: true,
  TRANSPORT_ERROR: true,
} as const satisfies Record<ProviderErrorCode, true>;

function isProviderErrorCode(code: string | undefined): code is ProviderErrorCode {
  return code !== undefined && Object.hasOwn(PROVIDER_ERROR_CODES, code);
}

function assertNeverProviderCode(code: never): never {
  throw new Error(`unclassified provider error code: ${String(code)}`);
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
  const code = err.code;
  if (isProviderErrorCode(code)) {
    switch (code) {
      case "CANCELLED":
        return {
          action: "cancelled",
          waitMs: 0,
          spendsRetryBudget: false,
          reason: "cancelled",
        };
      case "BUDGET_EXCEEDED":
      case "MODEL_ACTIVITY_PAUSED":
      case "AUTH_REQUIRED":
      case "AUTH_EXPIRED":
      case "PROVIDER_UNAVAILABLE":
      case "BACKEND_UNSUPPORTED":
        return {
          action: "hold",
          waitMs: 0,
          spendsRetryBudget: false,
          reason: "hard-stop",
          hardStop: true,
        };
      case "MAX_TURNS":
        return {
          action: "quarantine",
          waitMs: 0,
          spendsRetryBudget: false,
          reason: "error",
          softStop: true,
        };
      case "QUOTA_EXCEEDED":
      case "RATE_LIMITED":
        return {
          action: "pause",
          waitMs: refusalBackoffMs(consecutiveRefusals),
          spendsRetryBudget: false,
          reason: "refusal",
        };
      case "MODEL_UNAVAILABLE":
      case "CAPABILITY_UNSUPPORTED":
        return {
          action: "quarantine",
          waitMs: 0,
          spendsRetryBudget: false,
          reason: "error",
        };
      case "CLI_ERROR":
        if (isSoftStop(err)) {
          return {
            action: "quarantine",
            waitMs: 0,
            spendsRetryBudget: false,
            reason: "error",
            softStop: true,
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
        break;
      case "TIMEOUT":
      case "SPAWN_FAILED":
      case "POISONED_SESSION":
      case "BAD_REQUEST":
      case "TRANSPORT_ERROR":
        break;
      default:
        return assertNeverProviderCode(code);
    }
  }

  // Unknown/absent legacy codes and typed transient/CLI failures all use the
  // bounded ordinary retry ladder. Message heuristics never run here.
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
  /** Optional provider-specific LLM setting; each value is clamped to §10. */
  providerLimits?: Partial<Record<ProviderId, number>>;
  /** caching.warm_first — default ON (§4.4.3.1). */
  warmFirst?: boolean;
  /** First paint in progress: enrichment gets zero slots. */
  firstPaint?: boolean;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests) — used only when waiting out a lane pause. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable process RSS sampler for deterministic pressure tests. */
  rssBytes?: () => number;
  /** Optional known process memory budget; absent means no inferred pressure. */
  memoryLimitBytes?: number;
}

export interface ProviderPoolMetrics {
  providerId: ProviderId;
  configuredLimit: number;
  effectiveLimit: number;
  inFlight: number;
  waiting: number;
  transportFailureStreak: number;
  lastLatencyMs: number | null;
  lastQueueDepth: number;
  rssBytes: number;
  memoryLimitBytes: number | null;
  memoryPressure: boolean;
  nextRampAtMs: number | null;
}

export interface ProviderObservation {
  providerId: ProviderId;
  latencyMs?: number;
  queueDepth?: number;
  rssBytes?: number;
  memoryLimitBytes?: number;
}

interface AdaptiveProviderState {
  effectiveLimit: number;
  transportFailureStreak: number;
  nextRampAtMs: number;
  lastLatencyMs: number | null;
  lastQueueDepth: number;
  rssBytes: number;
  memoryLimitBytes: number | null;
  memoryPressureActive: boolean;
  lastMemoryReductionAtMs: number | null;
}

export interface RunOptions {
  /** Which half of the LLM pool this call belongs to. Default: understanding. */
  lane?: LlmLane;
  /** Required by new LLM callers; omitted retains the one-release Claude seam. */
  providerId?: ProviderId;
  /** Cancels a queued acquire without consuming or leaking a slot. */
  signal?: AbortSignal;
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
  private readonly llmSems: Record<ProviderId, Semaphore>;
  private readonly laneSems: Record<ProviderId, Record<LlmLane, Semaphore>>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rssBytes: () => number;

  /** The user's ceiling for the LLM class (before adaptive degradation). */
  private readonly llmCeilings: Record<ProviderId, number>;
  private readonly adaptive: Record<ProviderId, AdaptiveProviderState>;
  private firstPaint: boolean;
  private warmFirst: boolean;
  private readonly pausedUntilMs = new Map<string, number>();
  private readonly refusalStreak = new Map<string, number>();
  /** Consecutive NON-refusal failures per lane — the breaker's counter. */
  private readonly errorStreak = new Map<string, number>();
  private readonly trips = new Map<string, BreakerTrip>();
  private readonly breakerListeners = new Set<(trip: BreakerTrip) => void>();
  /** Callers admitted to `run()` for a class that do not hold a slot yet. */
  private readonly waitingByClass = new Map<ResourceClass, number>();
  private readonly waitingByProvider = new Map<ProviderId, number>();
  private readonly waitingByLane = new Map<string, number>();

  constructor(opts: PoolOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.rssBytes = opts.rssBytes ?? (() => process.memoryUsage().rss);
    this.warmFirst = opts.warmFirst ?? true;
    this.firstPaint = opts.firstPaint ?? false;
    const llmCeiling = clampLimit("llm", opts.limits?.llm ?? RESOURCE_LIMITS.llm.default);
    this.llmCeilings = {
      "claude-local": clampProviderLlmLimit("claude-local", opts.providerLimits?.["claude-local"] ?? llmCeiling),
      "chatgpt-oauth": clampProviderLlmLimit("chatgpt-oauth", opts.providerLimits?.["chatgpt-oauth"] ?? llmCeiling),
    };

    const sems = {} as Record<ResourceClass, Semaphore>;
    for (const cls of Object.keys(RESOURCE_LIMITS) as ResourceClass[]) {
      const want = cls === "llm" ? this.llmCeilings["claude-local"] : opts.limits?.[cls];
      sems[cls] = new Semaphore(
        clampLimit(cls, want ?? RESOURCE_LIMITS[cls].default),
      );
    }
    this.sems = sems;
    this.llmSems = {
      "claude-local": sems.llm,
      "chatgpt-oauth": new Semaphore(this.llmCeilings["chatgpt-oauth"]),
    };
    const memoryLimitBytes = opts.memoryLimitBytes ?? totalmem();
    this.adaptive = {
      "claude-local": this.newAdaptiveState(this.llmCeilings["claude-local"], memoryLimitBytes),
      "chatgpt-oauth": this.newAdaptiveState(this.llmCeilings["chatgpt-oauth"], memoryLimitBytes),
    };
    this.laneSems = {
      "claude-local": this.newLaneSemaphores(this.llmCeilings["claude-local"]),
      "chatgpt-oauth": this.newLaneSemaphores(this.llmCeilings["chatgpt-oauth"]),
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
      if (cls === "llm") {
        for (const providerId of ["claude-local", "chatgpt-oauth"] as const) {
          const ceiling = clampProviderLlmLimit(providerId, n);
          const wasAtCeiling = this.adaptive[providerId].effectiveLimit >= this.llmCeilings[providerId];
          this.llmCeilings[providerId] = ceiling;
          this.adaptive[providerId].effectiveLimit = wasAtCeiling
            ? ceiling
            : Math.min(this.adaptive[providerId].effectiveLimit, ceiling);
        }
      }
      else this.sems[cls].setLimit(clampLimit(cls, n));
    }
    this.refreshAllLlm();
  }

  configureProviderLlm(providerId: ProviderId, requested: number): void {
    const ceiling = clampProviderLlmLimit(providerId, requested);
    const wasAtCeiling = this.adaptive[providerId].effectiveLimit >= this.llmCeilings[providerId];
    this.llmCeilings[providerId] = ceiling;
    this.adaptive[providerId].effectiveLimit = wasAtCeiling
      ? ceiling
      : Math.min(this.adaptive[providerId].effectiveLimit, ceiling);
    this.refreshLlm(providerId);
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
    this.refreshAllLlm();
  }

  limitOf(cls: ResourceClass, providerId: ProviderId = "claude-local"): number {
    return cls === "llm" ? this.llmSemaphore(providerId).capacity : this.sems[cls].capacity;
  }

  laneLimit(lane: LlmLane, providerId: ProviderId = "claude-local"): number {
    return this.laneSems[providerId][lane].capacity;
  }

  inFlight(cls: ResourceClass, providerId: ProviderId = "claude-local"): number {
    return cls === "llm" ? this.llmSemaphore(providerId).inFlight : this.sems[cls].inFlight;
  }

  peakInFlight(cls: ResourceClass, providerId: ProviderId = "claude-local"): number {
    return cls === "llm" ? this.llmSemaphore(providerId).peakInFlight : this.sems[cls].peakInFlight;
  }

  lanePeakInFlight(lane: LlmLane, providerId: ProviderId = "claude-local"): number {
    return this.laneSems[providerId][lane].peakInFlight;
  }

  /** Callers queued for a class — admitted to `run()`, not yet holding a slot. */
  waiting(cls: ResourceClass): number {
    return this.waitingByClass.get(cls) ?? 0;
  }

  /** Queued callers on one LLM lane (a subset of `waiting("llm")`). */
  laneWaiting(lane: LlmLane, providerId: ProviderId = "claude-local"): number {
    return this.waitingByLane.get(this.providerLaneKey(providerId, lane)) ?? 0;
  }

  /** Most waiters a class admits before `run()` rejects (4× its ceiling). */
  waiterCap(cls: ResourceClass, providerId: ProviderId = "claude-local"): number {
    // The LLM cap follows the user's ceiling, not the degraded limit: an
    // outage halving concurrency must not also start rejecting the backlog.
    return waiterCapFor(cls === "llm" ? this.llmCeilings[providerId] : this.sems[cls].capacity);
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
    const providerId = opts.providerId ?? "claude-local";
    const lane = opts.lane ?? "understanding";
    if (cls === "llm") {
      this.sampleRuntimePressure(providerId);
      this.refreshLlm(providerId);
    }
    const classSemaphore = cls === "llm" ? this.llmSemaphore(providerId) : this.sems[cls];
    // Admission is counted, not observed: a caller is "waiting" from the
    // moment it is admitted until it holds a slot, so a burst submitted in one
    // tick is judged as the queue it WILL form — capacity runs, 4× capacity
    // waits, the rest is rejected before it queues at all.
    const admitted = cls === "llm"
      ? this.waitingByProvider.get(providerId) ?? 0
      : this.waiting(cls);
    const cap = this.waiterCap(cls, providerId);
    const classFree = Math.max(0, classSemaphore.capacity - classSemaphore.inFlight);
    let queued = admitted;
    let free = classFree;
    if (cls === "llm") {
      const lanes = this.laneSems[providerId];
      // A lane grant happens synchronously before the provider-wide grant's
      // promise resumes. During that small window the claimant is still in
      // `waitingByProvider`, so subtract those reservations or burst admission
      // would count a capacity claimant as a queued waiter. The paired lane
      // caps never exceed the provider cap, making the delta exact.
      const laneInFlight = lanes.live.inFlight + lanes.understanding.inFlight + lanes.enrichment.inFlight;
      const pendingProviderGrant = Math.max(0, laneInFlight - classSemaphore.inFlight);
      queued = Math.max(0, admitted - pendingProviderGrant);
      free = Math.min(
        Math.max(0, classFree - pendingProviderGrant),
        Math.max(0, lanes[lane].capacity - lanes[lane].inFlight),
      );
    }
    if (queued >= cap + free) throw new PoolOverflowError(cls, queued, cap);

    if (cls !== "llm") {
      this.bumpWaiting(cls, undefined, +1);
      let release: Release | undefined;
      try {
        await this.awaitResume(cls, providerId, opts.signal);
        release = await this.sems[cls].acquire(opts.signal);
      } finally {
        this.bumpWaiting(cls, undefined, -1);
      }
      try {
        return await fn();
      } finally {
        release!();
      }
    }

    this.bumpWaiting("llm", lane, +1, providerId);
    let laneRelease: Release | undefined;
    let slotRelease: Release | undefined;
    try {
      // A pause on the bare "llm" family (the ops surface's "LLM pool" row)
      // holds BOTH lanes; a composite pause holds just its lane. Re-check both
      // until neither is paused — one can be re-paused while the other waits.
      while (this.isPaused("llm", providerId) || this.isPaused(`llm:${lane}`, providerId)) {
        if (opts.signal?.aborted) throw new PoolCancelledError();
        await this.awaitResume("llm", providerId, opts.signal);
        await this.awaitResume(`llm:${lane}`, providerId, opts.signal);
      }
      this.refreshLlm(providerId);
      laneRelease = await this.laneSems[providerId][lane].acquire(opts.signal);
      slotRelease = await this.llmSemaphore(providerId).acquire(opts.signal);
    } finally {
      this.bumpWaiting("llm", lane, -1, providerId);
      // If the lane grant succeeded but the provider-wide grant was cancelled,
      // return the lane credit immediately.
      if (laneRelease && !slotRelease) laneRelease();
    }
    try {
      return await fn();
    } finally {
      slotRelease!();
      laneRelease!();
      this.sampleRuntimePressure(providerId);
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
   * Record one failure against a lane and get the decision. Refusals pause the
   * lane without spending retry budget; transient failures walk the bounded
   * ladder; permanent and non-retryable codes follow their typed disposition.
   */
  noteFailure(
    lane: LaneKey,
    err: ProviderFailure,
    retriesSpent = 0,
    providerId: ProviderId = "claude-local",
  ): FailureDecision {
    const key = this.providerKey(providerId, lane);
    if (err.code === "CANCELLED") {
      // A cancel is nobody's failure: neither streak moves.
      return classifyFailure(err, retriesSpent, 0);
    }
    if (isHardStop(err)) {
      // Nor is a hard stop (FIX-C1). Neither streak moves and the lane is NOT
      // paused: a pause carries a deadline, and a deadline against a latch
      // only a human clears is a timer that re-arms forever. The lane holds at
      // its own entry gate instead, which is where the work is kept.
      return classifyFailure(err, retriesSpent, 0);
    }
    if (isSoftStop(err)) {
      // Neither is a turn cap (FIX-C2). Ten preambles in a row are not a lane
      // that cannot work — they are ten answers that needed a second turn, and
      // tripping the breaker on them stops a lane that is perfectly healthy.
      return classifyFailure(err, retriesSpent, 0);
    }
    if (isRefusal(err)) {
      const streak = (this.refusalStreak.get(key) ?? 0) + 1;
      this.refusalStreak.set(key, streak);
      let decision = classifyFailure(err, retriesSpent, streak);
      if (Number.isFinite(err.retryAfterMs) && err.retryAfterMs! > decision.waitMs) {
        decision = {
          ...decision,
          waitMs: Math.min(REFUSAL_BACKOFF_MAX_MS, Math.floor(err.retryAfterMs!)),
        };
      }
      this.pausedUntilMs.set(key, this.now() + decision.waitMs);
      // Refusals adapt only the failing provider. ChatGPT sheds immediately;
      // the legacy Claude rail retains its existing two-refusal threshold.
      if (lane.startsWith("llm:")) {
        this.observeAdaptiveFailure(providerId, err, streak);
      }
      return decision;
    }
    // A non-refusal failure: the unit walks its ladder as before, and the lane
    // counts towards its breaker (SPD-07). Ten in a row with no success between
    // them is not ten unlucky units — it is a lane that cannot currently work.
    const decision = classifyFailure(err, retriesSpent, 0);
    if (lane.startsWith("llm:")) this.observeAdaptiveFailure(providerId, err);
    const streak = (this.errorStreak.get(key) ?? 0) + 1;
    if (streak >= BREAKER_FAILURES) {
      this.errorStreak.delete(key);
      this.tripBreaker(lane, streak, err, providerId);
      return { ...decision, breakerTripped: true };
    }
    this.errorStreak.set(key, streak);
    return decision;
  }

  /** A completed call clears the lane's refusal streak and its breaker count. */
  noteSuccess(lane: LaneKey, providerId: ProviderId = "claude-local", latencyMs?: number): void {
    const key = this.providerKey(providerId, lane);
    this.refusalStreak.delete(key);
    this.errorStreak.delete(key);
    const adaptive = this.adaptive[providerId];
    adaptive.transportFailureStreak = 0;
    if (Number.isFinite(latencyMs) && latencyMs! >= 0) adaptive.lastLatencyMs = Math.floor(latencyMs!);
    this.refreshLlm(providerId);
  }

  /** Consecutive non-refusal failures on `lane` since its last success. */
  consecutiveFailures(lane: LaneKey, providerId: ProviderId = "claude-local"): number {
    return this.errorStreak.get(this.providerKey(providerId, lane)) ?? 0;
  }

  /** Every breaker currently holding a lane — the banners (SPD-07). */
  breakers(providerId?: ProviderId): BreakerTrip[] {
    const now = this.now();
    const live: BreakerTrip[] = [];
    for (const [key, trip] of this.trips) {
      const tripProvider = trip.providerId ?? "claude-local";
      if (providerId && tripProvider !== providerId) continue;
      if (trip.untilMs > now && this.isPaused(trip.lane, tripProvider)) live.push(trip);
      else this.trips.delete(key);
    }
    return live;
  }

  /** The breaker holding `lane`, or null when it is not tripped. */
  breakerFor(lane: LaneKey, providerId: ProviderId = "claude-local"): BreakerTrip | null {
    return this.breakers(providerId).find((t) => t.lane === lane) ?? null;
  }

  /** Be told when a breaker trips (the operator log, a notification). */
  onBreaker(listener: (trip: BreakerTrip) => void): () => void {
    this.breakerListeners.add(listener);
    return () => {
      this.breakerListeners.delete(listener);
    };
  }

  private tripBreaker(
    lane: LaneKey,
    failures: number,
    err: ProviderFailure,
    providerId: ProviderId,
  ): void {
    const now = this.now();
    this.pauseLane(lane, BREAKER_PAUSE_MS, providerId);
    const trip: BreakerTrip = {
      providerId,
      lane,
      trippedAt: new Date(now).toISOString(),
      untilMs: now + BREAKER_PAUSE_MS,
      failures,
      lastCode: err.code === undefined ? null : String(err.code),
      lastError: err.message ?? null,
    };
    this.trips.set(this.providerKey(providerId, lane), trip);
    // Never a silent retry (SPD-07 wrong mode): the trip is in the operator
    // log the moment it happens, and on /api/ops until the lane resumes.
    console.error(
      `[breaker] ${providerId}:${lane} paused ${Math.round(BREAKER_PAUSE_MS / 60_000)}m after ` +
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
  pausedForMs(lane: LaneKey, providerId: ProviderId = "claude-local"): number {
    const until = this.pausedUntilMs.get(this.providerKey(providerId, lane));
    if (until === undefined) return 0;
    return Math.max(0, until - this.now());
  }

  isPaused(lane: LaneKey, providerId: ProviderId = "claude-local"): boolean {
    return this.pausedForMs(lane, providerId) > 0;
  }

  /**
   * Pause a lane by hand (the ops surface's per-lane pause, build item 4.4).
   * Same mechanism as a refusal pause — `awaitResume` holds new work and the
   * coverage meter renders the countdown — but it never touches the refusal
   * streak, so a manual pause cannot degrade the LLM limit.
   */
  pauseLane(lane: LaneKey, ms: number, providerId: ProviderId = "claude-local"): void {
    this.pausedUntilMs.set(this.providerKey(providerId, lane), this.now() + Math.max(0, ms));
  }

  /** Clear a pause early (the limit lifted, or the user retried by hand). */
  resumeLane(lane: LaneKey, providerId: ProviderId = "claude-local"): void {
    const key = this.providerKey(providerId, lane);
    this.pausedUntilMs.delete(key);
    this.refusalStreak.delete(key);
    this.errorStreak.delete(key);
    this.trips.delete(key);
  }

  /** Effective LLM limit right now — halved while degraded. */
  effectiveLlmLimit(providerId: ProviderId = "claude-local"): number {
    this.maybeRamp(providerId);
    return this.adaptive[providerId].effectiveLimit;
  }

  /** Feed bounded runtime telemetry without coupling the pool to one scheduler. */
  observeProvider(sample: ProviderObservation): ProviderPoolMetrics {
    const state = this.adaptive[sample.providerId];
    if (Number.isFinite(sample.latencyMs) && sample.latencyMs! >= 0) {
      state.lastLatencyMs = Math.floor(sample.latencyMs!);
    }
    if (Number.isFinite(sample.queueDepth) && sample.queueDepth! >= 0) {
      state.lastQueueDepth = Math.floor(sample.queueDepth!);
    }
    if (Number.isFinite(sample.rssBytes) && sample.rssBytes! >= 0) state.rssBytes = Math.floor(sample.rssBytes!);
    else state.rssBytes = this.rssBytes();
    if (Number.isFinite(sample.memoryLimitBytes) && sample.memoryLimitBytes! > 0) {
      state.memoryLimitBytes = Math.floor(sample.memoryLimitBytes!);
    }
    this.applyMemoryPressure(sample.providerId);
    this.refreshLlm(sample.providerId);
    return this.providerMetrics(sample.providerId);
  }

  providerMetrics(providerId: ProviderId): ProviderPoolMetrics {
    this.refreshLlm(providerId);
    const state = this.adaptive[providerId];
    return Object.freeze({
      providerId,
      configuredLimit: this.llmCeilings[providerId],
      effectiveLimit: state.effectiveLimit,
      inFlight: this.llmSemaphore(providerId).inFlight,
      waiting: this.waitingByProvider.get(providerId) ?? 0,
      transportFailureStreak: state.transportFailureStreak,
      lastLatencyMs: state.lastLatencyMs,
      lastQueueDepth: state.lastQueueDepth,
      rssBytes: state.rssBytes,
      memoryLimitBytes: state.memoryLimitBytes,
      memoryPressure: this.hasMemoryPressure(state),
      nextRampAtMs: state.effectiveLimit < this.llmCeilings[providerId] ? state.nextRampAtMs : null,
    });
  }

  // ---- internals ----------------------------------------------------------

  private newAdaptiveState(limit: number, memoryLimitBytes?: number): AdaptiveProviderState {
    return {
      effectiveLimit: limit,
      transportFailureStreak: 0,
      nextRampAtMs: 0,
      lastLatencyMs: null,
      lastQueueDepth: 0,
      rssBytes: this.rssBytes(),
      memoryLimitBytes: Number.isFinite(memoryLimitBytes) && memoryLimitBytes! > 0
        ? Math.floor(memoryLimitBytes!)
        : null,
      memoryPressureActive: false,
      lastMemoryReductionAtMs: null,
    };
  }

  private newLaneSemaphores(limit: number): Record<LlmLane, Semaphore> {
    const caps = laneCaps(limit, this.firstPaint);
    return {
      enrichment: new Semaphore(caps.enrichment),
      understanding: new Semaphore(caps.understanding),
      live: new Semaphore(caps.live),
    };
  }

  private providerKey(providerId: ProviderId, lane: LaneKey): string {
    return `${providerId}:${lane}`;
  }

  private providerLaneKey(providerId: ProviderId, lane: LlmLane): string {
    return `${providerId}:llm:${lane}`;
  }

  private llmSemaphore(providerId: ProviderId): Semaphore {
    return this.llmSems[providerId];
  }

  private refreshAllLlm(): void {
    this.refreshLlm("claude-local");
    this.refreshLlm("chatgpt-oauth");
  }

  private observeAdaptiveFailure(
    providerId: ProviderId,
    err: ProviderFailure,
    providerRefusalStreak = 0,
  ): void {
    const state = this.adaptive[providerId];
    if (providerId === "claude-local") {
      if (isRefusal(err) && providerRefusalStreak >= DEGRADE_AFTER_REFUSALS) {
        state.effectiveLimit = Math.max(1, Math.floor(this.llmCeilings[providerId] / 2));
        state.nextRampAtMs = this.now() + DEGRADE_WINDOW_MS;
        this.refreshLlm(providerId);
      }
      return;
    }
    if (err.code === "TRANSPORT_ERROR") {
      state.transportFailureStreak += 1;
      if (state.transportFailureStreak >= CHATGPT_TRANSPORT_FAILURES_BEFORE_REDUCE) {
        state.transportFailureStreak = 0;
        this.reduceProvider(providerId);
      }
      return;
    }
    state.transportFailureStreak = 0;
    if (err.code === "RATE_LIMITED" || err.code === "QUOTA_EXCEEDED") {
      this.reduceProvider(providerId);
    }
  }

  private reduceProvider(providerId: ProviderId): void {
    const state = this.adaptive[providerId];
    const floor = providerId === "chatgpt-oauth"
      ? Math.min(CHATGPT_ADAPTIVE_MIN, this.llmCeilings[providerId])
      : 1;
    state.effectiveLimit = Math.max(floor, Math.floor(state.effectiveLimit / 2));
    state.nextRampAtMs = this.now() + DEGRADE_WINDOW_MS;
    this.refreshLlm(providerId);
  }

  private maybeRamp(providerId: ProviderId): void {
    const state = this.adaptive[providerId];
    const ceiling = this.llmCeilings[providerId];
    if (state.effectiveLimit >= ceiling) {
      state.effectiveLimit = Math.min(state.effectiveLimit, ceiling);
      return;
    }
    const now = this.now();
    if (now < state.nextRampAtMs || this.hasMemoryPressure(state)) return;
    if (providerId === "claude-local") {
      state.effectiveLimit = ceiling;
      state.nextRampAtMs = 0;
      return;
    }
    // One observation earns one slot. Do not "catch up" several unobserved
    // intervals after an idle period: elapsed wall time is not evidence that
    // the provider or this process is healthy at a higher concurrency.
    state.effectiveLimit = Math.min(ceiling, state.effectiveLimit + 1);
    state.nextRampAtMs = state.effectiveLimit < ceiling
      ? now + CHATGPT_RAMP_INTERVAL_MS
      : 0;
  }

  private hasMemoryPressure(state: AdaptiveProviderState): boolean {
    return state.memoryLimitBytes !== null && state.memoryLimitBytes > 0 &&
      state.rssBytes / state.memoryLimitBytes >= CHATGPT_MEMORY_PRESSURE_RATIO;
  }

  private sampleRuntimePressure(providerId: ProviderId): void {
    const state = this.adaptive[providerId];
    state.rssBytes = this.rssBytes();
    state.lastQueueDepth = this.waitingByProvider.get(providerId) ?? 0;
    this.applyMemoryPressure(providerId);
  }

  private applyMemoryPressure(providerId: ProviderId): void {
    const state = this.adaptive[providerId];
    const pressured = this.hasMemoryPressure(state);
    const wasPressured = state.memoryPressureActive;
    state.memoryPressureActive = pressured;
    if (providerId !== "chatgpt-oauth") return;
    const now = this.now();
    if (pressured) {
      if (
        !wasPressured ||
        state.lastMemoryReductionAtMs === null ||
        now - state.lastMemoryReductionAtMs >= DEGRADE_WINDOW_MS
      ) {
        state.lastMemoryReductionAtMs = now;
        this.reduceProvider(providerId);
      }
      return;
    }
    if (wasPressured) {
      state.lastMemoryReductionAtMs = null;
      state.nextRampAtMs = now + DEGRADE_WINDOW_MS;
    }
  }

  private bumpWaiting(
    cls: ResourceClass,
    lane: LlmLane | undefined,
    delta: 1 | -1,
    providerId: ProviderId = "claude-local",
  ): void {
    this.waitingByClass.set(cls, Math.max(0, this.waiting(cls) + delta));
    if (cls === "llm") {
      this.waitingByProvider.set(
        providerId,
        Math.max(0, (this.waitingByProvider.get(providerId) ?? 0) + delta),
      );
      this.adaptive[providerId].lastQueueDepth = this.waitingByProvider.get(providerId) ?? 0;
    }
    if (lane) {
      const key = this.providerLaneKey(providerId, lane);
      this.waitingByLane.set(key, Math.max(0, this.laneWaiting(lane, providerId) + delta));
    }
  }

  private refreshLlm(providerId: ProviderId): void {
    const limit = this.effectiveLlmLimit(providerId);
    this.llmSemaphore(providerId).setLimit(limit);
    const caps = laneCaps(limit, this.firstPaint);
    this.laneSems[providerId].enrichment.setLimit(caps.enrichment);
    this.laneSems[providerId].understanding.setLimit(caps.understanding);
    this.laneSems[providerId].live.setLimit(caps.live);
  }

  private async awaitResume(lane: LaneKey, providerId: ProviderId, signal?: AbortSignal): Promise<void> {
    // A paused lane is never a silent stall: pausedForMs() is what the coverage
    // meter renders as "paused — resumes in mm:ss" (§4.6.4).
    let wait = this.pausedForMs(lane, providerId);
    while (wait > 0) {
      await this.abortableSleep(wait, signal);
      wait = this.pausedForMs(lane, providerId);
    }
    this.pausedUntilMs.delete(this.providerKey(providerId, lane));
  }

  private async abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return this.sleep(ms);
    if (signal.aborted) throw new PoolCancelledError();
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        this.sleep(ms),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new PoolCancelledError());
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
}

/** The process-wide pool. Callers should share this rather than build their own. */
export const resourcePool = new ResourcePool();
export default resourcePool;
