/**
 * A hard ceiling on billable generations so a stuck retry loop or a shared
 * link can't drain the account. Counts are checked BEFORE the provider call,
 * and failed calls still count, so a retry storm is capped too.
 */
export class GenerationBudget {
  private stamps: number[] = [];

  constructor(
    readonly perHour: number,
    readonly perDay: number,
    private now: () => number = Date.now,
  ) {}

  /** Returns null when allowed (and records the call), or a user-facing reason. */
  take(): string | null {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 86_400_000);
    const lastHour = this.stamps.filter((s) => t - s < 3_600_000).length;
    if (lastHour >= this.perHour) return `Hourly limit reached (${this.perHour} generations/hour). Try again later.`;
    if (this.stamps.length >= this.perDay) return `Daily limit reached (${this.perDay} generations/day). Try again tomorrow.`;
    this.stamps.push(t);
    return null;
  }
}
