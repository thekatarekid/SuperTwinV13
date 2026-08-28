// ===========================================================================
// Pacing — build P3.4, spec §12.6, eval BRW-02. Human-hours cadence enforced
// in code: daily fire times jitter ±30 min, whole days are randomly skipped,
// inter-action delays are human-scale and NON-uniform, requests to one site
// are strictly serial, and nothing fires outside active hours. `metronome`
// and `burst` are the named wrongs — both are structurally impossible here.
//
// Everything takes an injectable rng/clock/sleep so BRW-02 runs 14 simulated
// days in milliseconds.
// ===========================================================================

export interface PacerDeps {
  /** Uniform [0,1). Injectable so tests are deterministic-but-seeded. */
  rng?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Spec §12.6: ±30 min around the scheduled time. */
export const JITTER_MS = 30 * 60 * 1000;
/** Chance a scheduled daily run simply does not happen (humans miss days). */
export const SKIP_PROBABILITY = 0.15;
/** Active hours (local): agents act when the human plausibly would. */
export const ACTIVE_HOUR_START = 8;
export const ACTIVE_HOUR_END = 23;
/** Inter-action delay bounds (ms) — log-uniform between them, so the
 * distribution is skewed like real reading pauses, never a fixed beat. */
export const MIN_ACTION_DELAY_MS = 900;
export const MAX_ACTION_DELAY_MS = 6_500;

export interface ScheduledRun {
  day: number;
  /** ms offset from that day's midnight; null = skipped day. */
  fireAtMs: number | null;
}

export class Pacer {
  private readonly rng: () => number;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  /** Per-site promise chains — the serialization primitive. */
  private readonly siteQueues = new Map<string, Promise<void>>();
  /** Observability for tests + replay: every delay actually applied. */
  readonly appliedDelays: { site: string; ms: number }[] = [];

  constructor(deps: PacerDeps = {}) {
    this.rng = deps.rng ?? Math.random;
    this.nowFn = deps.now ?? Date.now;
    this.sleepFn = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One inter-action human delay: log-uniform in [min,max]. */
  nextActionDelayMs(): number {
    const lo = Math.log(MIN_ACTION_DELAY_MS);
    const hi = Math.log(MAX_ACTION_DELAY_MS);
    return Math.round(Math.exp(lo + (hi - lo) * this.rng()));
  }

  withinActiveHours(atMs: number = this.nowFn()): boolean {
    const hour = new Date(atMs).getHours();
    return hour >= ACTIVE_HOUR_START && hour < ACTIVE_HOUR_END;
  }

  /**
   * Plan `days` daily runs around `baseHour`: jittered ±30 min, some days
   * skipped, always inside active hours. Pure — the scheduler (dispatch lane)
   * consumes the offsets; BRW-02 asserts on their shape.
   */
  scheduleDailyRuns(baseHour: number, days: number): ScheduledRun[] {
    const runs: ScheduledRun[] = [];
    for (let day = 0; day < days; day++) {
      if (this.rng() < SKIP_PROBABILITY) {
        runs.push({ day, fireAtMs: null });
        continue;
      }
      const jitter = Math.round((this.rng() * 2 - 1) * JITTER_MS);
      let fireAtMs = baseHour * 3_600_000 + jitter;
      // Clamp into active hours rather than fire at 07:40 for an 08:00 base.
      const lo = ACTIVE_HOUR_START * 3_600_000;
      const hi = ACTIVE_HOUR_END * 3_600_000 - 1;
      fireAtMs = Math.min(Math.max(fireAtMs, lo), hi);
      runs.push({ day, fireAtMs });
    }
    return runs;
  }

  /**
   * Run `fn` against `site`: strictly serial per site (queued behind whatever
   * is in flight there), preceded by one human-scale delay. This is the ONE
   * doorway harness actions pass through, so parallel same-site requests
   * cannot be expressed at all.
   */
  async run<T>(site: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.siteQueues.get(site) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.siteQueues.set(
      site,
      prev.then(() => gate),
    );
    await prev;
    try {
      const delay = this.nextActionDelayMs();
      this.appliedDelays.push({ site, ms: delay });
      await this.sleepFn(delay);
      return await fn();
    } finally {
      release();
    }
  }
}

/** Site key for pacing/pause purposes: the registrable-ish hostname. */
export function siteOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "invalid";
  }
}
