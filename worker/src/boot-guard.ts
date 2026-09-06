// ===========================================================================
// [CODE] Optional boot steps degrade; they do not brick the app (V6 P1 W1).
//
// The lesson of 13.11.1/13.11.2: `installCliGoldenRunnerIfAvailable()` — a
// step whose own name says "if available" — threw inside the packaged app, and
// because it ran BEFORE `startServer()`, main() rejected, the process exited 1
// and every screen in the app said "worker unreachable". One optional feature
// took the whole worker down.
//
// So the boot is split in two:
//
//   HARD RAILS, before the listener. The home guard (plan §1.3 rules 1 and 6),
//   the stale-worker sweep and pid claim, the migrations, the provider
//   registry, the adapter manifest, and the HTTP listener itself. These MUST
//   still be able to refuse a boot — a worker on the wrong home, a second
//   worker on one database, or a half-migrated schema is worse than no worker.
//   Nothing here goes through this module.
//
//   EVERYTHING ELSE, after it. Jobs, watchers, backfills, the golden gate:
//   each one wrapped, so a throw is a logged line and one dead feature instead
//   of a dead app. What degraded is remembered (`bootDegradations()`) and
//   served on /api/health, so the next failure of this shape is visible from
//   the outside instead of only in a log file nobody opens.
//
// This is a guard, not a retry framework: one attempt, no backoff, no timers
// (plan §1.3 — nothing here spawns, sleeps or spends).
// ===========================================================================

/** One optional subsystem that did not start. */
export interface BootDegradation {
  /** The name the boot step was registered under, e.g. "golden gate". */
  name: string;
  /** The failure, as one line. */
  error: string;
  /** When it failed, ISO-8601. */
  at: string;
}

export interface OptionalStepOptions {
  /** Where the line goes. Defaults to console.error, like the rest of boot. */
  log?: (line: string) => void;
  /** Injected clock, for tests. */
  now?: () => Date;
}

const degradations: BootDegradation[] = [];

/** Every optional subsystem that failed to start, in the order they failed. */
export function bootDegradations(): readonly BootDegradation[] {
  return degradations;
}

/** Names only — what /api/health carries. */
export function degradedSubsystems(): string[] {
  return degradations.map((d) => d.name);
}

/** Tests (and only tests) start from a clean slate. */
export function clearBootDegradations(): void {
  degradations.length = 0;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function record(name: string, err: unknown, opts: OptionalStepOptions): void {
  const error = describe(err);
  const at = (opts.now?.() ?? new Date()).toISOString();
  degradations.push({ name, error, at });
  const log = opts.log ?? ((line: string) => console.error(line));
  log(`[worker] optional subsystem "${name}" did not start — continuing without it: ${error}`);
  // The stack is worth having in the log file for exactly this class of bug,
  // and it is the second line rather than the first so the summary stays
  // greppable.
  if (err instanceof Error && err.stack) log(err.stack);
}

/**
 * Run an optional boot step. A throw is logged, remembered and swallowed; the
 * caller gets null and the boot continues. A step that returns a promise gets
 * a catch attached too, so a rejection cannot reach `unhandledRejection` (which
 * kills the worker by design, process-guard.ts).
 */
export function optionalStep<T>(
  name: string,
  run: () => T,
  opts: OptionalStepOptions = {},
): T | null {
  try {
    const value = run();
    const thenable = value as { then?: unknown; catch?: unknown } | null;
    if (
      thenable !== null &&
      typeof thenable === "object" &&
      typeof thenable.then === "function" &&
      typeof thenable.catch === "function"
    ) {
      (value as unknown as Promise<unknown>).catch((err: unknown) => {
        record(name, err, opts);
      });
    }
    return value;
  } catch (err) {
    record(name, err, opts);
    return null;
  }
}

/**
 * The awaited form: the same contract for a step that has to finish before the
 * next one starts (the source supervisor's consent sweep, for instance).
 */
export async function optionalStepAsync<T>(
  name: string,
  run: () => Promise<T>,
  opts: OptionalStepOptions = {},
): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    record(name, err, opts);
    return null;
  }
}
