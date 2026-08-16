// ===========================================================================
// [CODE] The scheduler's primary sort key — arch §9.3 ("How tier composes with
// the recency horizon"), build item 1.2.
//
//   priority = (tier_rank x 10^9) + (horizon_rank x 10^6) + recency
//
//   T1 live -> T1 h24 -> T1 d7 -> ... -> T1 older
//   -> T2 live -> T2 h24 -> ... -> T3 ... -> T4 ...
//
// RANKS COUNT DOWNWARD IN URGENCY, VALUES COUNT UPWARD. `work_queue` and
// `cohorts` are both dequeued `ORDER BY priority DESC` (arch §6, and the index
// comment on `work_queue` says so in capitals), so T1 has to produce the
// LARGEST number. T1 therefore weighs 4 and T4 weighs 1; `live` weighs 7 and
// `older` weighs 1. The doc's "rank" is that weight read the other way up, and
// mixing the two up is how a queue quietly runs backwards.
//
// THE LIVE EXCEPTION (§9.3): a live cohort pre-empts, but only for T1 and T2,
// and only AT THE NEXT COHORT BOUNDARY — never mid-cohort, so no partial work
// is ever discarded. A T3/T4 live blast takes its ordinary place in tier order:
// "a promotional blast must never interrupt a history import."
//
// Nothing here reads the database, and nothing here decides WHETHER work
// happens — only when. Tiering delays scheduling, it never filters (§9.3 rule
// 1).
// ===========================================================================

/** §9.3. T1 ENGAGED · T2 TRANSACTIONAL · T3 PASSIVE · T4 PROMOTIONAL. */
export const TIERS = ["T1", "T2", "T3", "T4"] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/** The recency horizons a cohort can sit in (arch §6, `cohorts.horizon`). */
export const HORIZONS = ["live", "h24", "d7", "d30", "d90", "y1", "older"] as const;
export type Horizon = (typeof HORIZONS)[number];

export function isHorizon(value: unknown): value is Horizon {
  return typeof value === "string" && (HORIZONS as readonly string[]).includes(value);
}

/** Bigger is more urgent, because the queue is `ORDER BY priority DESC`. */
export function tierWeight(tier: Tier): number {
  return TIERS.length - TIERS.indexOf(tier);
}

/** Same direction as `tierWeight`: `live` is the largest, `older` the smallest. */
export function horizonWeight(horizon: Horizon): number {
  return HORIZONS.length - HORIZONS.indexOf(horizon);
}

const TIER_SCALE = 1_000_000_000;
const HORIZON_SCALE = 1_000_000;

/**
 * The recency term, 0…999_999, so it can never carry into the horizon term.
 *
 * One slot per 10 minutes gives ~19 years of strictly ordered range, which
 * covers any corpus this ships against; anything older than that saturates at
 * 0 and is separated by its horizon anyway. A finer grain would overflow into
 * the horizon field, and overflowing this field is how a d90 cohort would
 * outrank a live one.
 */
export const RECENCY_GRAIN_MS = 10 * 60_000;
const MAX_RECENCY = HORIZON_SCALE - 1;

export function recencySlot(ts: string | number, now: number): number {
  const ms = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return 0;
  const slots = Math.floor(Math.max(0, now - ms) / RECENCY_GRAIN_MS);
  return Math.max(0, Math.min(MAX_RECENCY, MAX_RECENCY - slots));
}

const DAY = 86_400_000;

/** Which horizon an instant falls in, relative to `now`. */
export function horizonFor(ts: string | number, now: number): Horizon {
  const ms = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(ms)) return "older";
  const age = now - ms;
  // A timestamp from the near future is the live tail, not a paradox: clock
  // skew is clamped at the adapter (§2.2) and what is left is simply now.
  if (age <= DAY / 24) return "live";
  if (age <= DAY) return "h24";
  if (age <= 7 * DAY) return "d7";
  if (age <= 30 * DAY) return "d30";
  if (age <= 90 * DAY) return "d90";
  if (age <= 365 * DAY) return "y1";
  return "older";
}

export interface PriorityInput {
  tier: Tier;
  horizon: Horizon;
  /** The unit's own instant — an event ts, or a cohort's newest ts. */
  ts?: string | number;
  now?: number;
}

/** `(tier_rank x 10^9) + (horizon_rank x 10^6) + recency`, §9.3, verbatim. */
export function computePriority(input: PriorityInput): number {
  const now = input.now ?? Date.now();
  const recency = input.ts === undefined ? 0 : recencySlot(input.ts, now);
  return tierWeight(input.tier) * TIER_SCALE + horizonWeight(input.horizon) * HORIZON_SCALE + recency;
}

/** The tier a priority was built from — the inverse of the top term. */
export function tierOfPriority(priority: number): Tier | null {
  const weight = Math.floor(priority / TIER_SCALE);
  const tier = TIERS[TIERS.length - weight];
  return tier ?? null;
}

/**
 * §9.3's EXCEPTION. `live` pre-empts for T1 and T2 only; T3 and T4 live events
 * join the normal tier order.
 */
export function preempts(tier: Tier, horizon: Horizon): boolean {
  return horizon === "live" && (tier === "T1" || tier === "T2");
}

// ---- the tier-ordered cohort queue ----------------------------------------

export interface Cohort {
  id: string;
  tier: Tier;
  horizon: Horizon;
  /** Newest instant in the cohort. Absent means "no recency term". */
  ts?: string | number;
}

export interface RunRecord {
  id: string;
  tier: Tier;
  horizon: Horizon;
  priority: number;
  /** Arrived mid-run AND went ahead of cohorts that were already waiting. */
  preempted: boolean;
  /**
   * Cohort boundaries crossed between arriving mid-run and starting. 1 means
   * "the cohort that was in flight finished, then this ran" — the pre-emption
   * §9.3 grants. 0 for a cohort that was planned before the run began.
   */
  delay: number;
}

interface QueueEntry {
  cohort: Cohort;
  priority: number;
  /** Enqueue order, so "was it already waiting?" has an answer. */
  seq: number;
  /** Index of the cohort in flight when it arrived; null when planned. */
  arrivedDuring: number | null;
}

/**
 * Cohort ordering, exactly as §9.3 describes it and no more: tier first,
 * horizon second, recency last, with the live exception applied at cohort
 * boundaries only.
 *
 * `arrive()` is how a live cohort shows up MID-cohort. The queue never
 * interrupts the cohort in flight — `next()` is only ever called at a boundary
 * — so a pre-empting cohort's `delay` is 1: the one cohort that was already
 * running when it landed. Nothing here can discard partial work, because
 * nothing here can stop a cohort.
 */
export class CohortQueue {
  private readonly pending: QueueEntry[] = [];
  private readonly ran: RunRecord[] = [];
  private seq = 0;
  private readonly now: number;

  constructor(now: number = Date.now()) {
    this.now = now;
  }

  /** Queue a cohort that was planned before the run started. */
  push(cohort: Cohort): void {
    this.enqueue(cohort, null);
  }

  /**
   * Queue a cohort that arrived while the last-started cohort is still in
   * flight — a live event, or a tier-change re-scan.
   */
  arrive(cohort: Cohort): void {
    this.enqueue(cohort, this.ran.length - 1);
  }

  private enqueue(cohort: Cohort, arrivedDuring: number | null): void {
    this.seq += 1;
    this.pending.push({
      cohort,
      priority: computePriority({ ...cohort, now: this.now }),
      seq: this.seq,
      arrivedDuring,
    });
  }

  get remaining(): number {
    return this.pending.length;
  }

  /** Did this entry earn §9.3's live exception? */
  private exceptional(entry: QueueEntry): boolean {
    return entry.arrivedDuring !== null && preempts(entry.cohort.tier, entry.cohort.horizon);
  }

  /**
   * Highest priority wins — EXCEPT that a T1/T2 cohort which arrived mid-run on
   * the live horizon goes first (§9.3). The exception has to live here rather
   * than in the formula: by the numbers alone a T1 `older` cohort outranks a T2
   * `live` one, and §9.3 says the bank alert that just landed goes first anyway.
   * Ties break on id so a replay is deterministic.
   */
  private pick(): number {
    const exceptional = this.pending.some((entry) => this.exceptional(entry));
    let best = -1;
    for (let i = 0; i < this.pending.length; i += 1) {
      const entry = this.pending[i]!;
      if (exceptional && !this.exceptional(entry)) continue;
      if (best === -1) {
        best = i;
        continue;
      }
      const b = this.pending[best]!;
      if (entry.priority > b.priority || (entry.priority === b.priority && entry.cohort.id < b.cohort.id)) {
        best = i;
      }
    }
    return best === -1 ? 0 : best;
  }

  /** Run the next cohort. Called only at a boundary — there is no other call. */
  next(): RunRecord | null {
    if (this.pending.length === 0) return null;
    const at = this.pick();
    const entry = this.pending[at]!;
    this.pending.splice(at, 1);
    const { cohort } = entry;
    // Did it take the exception, and did that put it ahead of something that
    // was already waiting for its turn?
    const jumped = this.exceptional(entry) && this.pending.some((other) => other.seq < entry.seq);
    const runIndex = this.ran.length;
    this.ran.push({
      id: cohort.id,
      tier: cohort.tier,
      horizon: cohort.horizon,
      priority: entry.priority,
      preempted: jumped,
      delay: entry.arrivedDuring === null ? 0 : runIndex - entry.arrivedDuring,
    });
    return this.ran[runIndex]!;
  }

  /** Run to exhaustion. Returns the order, which is the thing under test. */
  drain(): RunRecord[] {
    while (this.next() !== null) {
      // next() records; nothing else to do at a boundary.
    }
    return this.ran;
  }

  history(): RunRecord[] {
    return [...this.ran];
  }
}

/**
 * Tier-order violations in a completed run: a cohort that ran while a
 * strictly-more-urgent tier still had cohorts waiting. This is gate
 * `tiers_order_respected` ("a T2 backfill cohort ran before T1 exhausted"),
 * counted rather than assumed.
 *
 * The live exception is not a violation: §9.3 grants it in the same breath as
 * the ordering rule.
 */
export function tierOrderViolations(
  order: readonly RunRecord[],
  planned: readonly Cohort[],
): { ran: string; whileWaiting: string }[] {
  const remaining = new Map<string, Cohort>(planned.map((c) => [c.id, c]));
  const out: { ran: string; whileWaiting: string }[] = [];
  for (const record of order) {
    remaining.delete(record.id);
    if (record.preempted) continue;
    for (const waiting of remaining.values()) {
      if (tierWeight(waiting.tier) > tierWeight(record.tier)) {
        out.push({ ran: record.id, whileWaiting: waiting.id });
      }
    }
  }
  return out;
}
