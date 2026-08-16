// ===========================================================================
// [CODE] The bootstrap -> steady flip and the steady-state driver — arch §8.1
// (exit condition), §8.3 (near-realtime), §9.4 Lane E; build item 3.4's
// missing caller.
//
// `scheduler/live.ts` shipped complete and had ZERO production callers — it
// was absent from the bundle, so nothing ever flipped `sources.mode` to
// 'steady' and the app stayed a one-shot importer. This file is that caller,
// and the only thing here that is new is wiring:
//
//   1. THE FLIP IS DB-DERIVED AND ONE-SHOT. `bootstrapSettled()` reads its
//      four conditions from the DB; the flip writes `app_state sources.mode`
//      exactly once, on the bootstrap->steady edge. A restart re-reads the
//      row, so the flip survives a kill -9 and can never run twice: "already
//      steady" is a property of the database, not of this process's memory.
//
//   2. FREE WORK IS UNCONDITIONAL. The `enrich` lane-entry drain and the
//      paused-row resume run in BOTH modes, every tick. The drain spends
//      nothing and is structurally unable to: its `llmCalls` is typed as the
//      literal `0`, it imports no transport, and the actual media reading it
//      books-keeps for is `media/queue.ts`'s job, behind that queue's own
//      budget. This drainer only reconciles the `work_queue` rows
//      `tiers/rescan.ts` has been filing since item 1.2 — which no production
//      code ever claimed — against `events.enrichment_state`.
//
//   3. FIRING WITHOUT A CONSUMER IS REFUSED, LOUDLY. `runLiveTick` advances
//      `sessions.last_delta_at` when a pass fires — so a fired pass whose
//      extraction can never run is a SILENTLY UNREAD MESSAGE, the worst
//      failure this path can have. `startSteadyDriver` defaults `deps.extract`
//      to `scheduler/cl1-delta.ts`'s runner (exactly as `startBootstrapDriver`
//      defaults `cl1ExtractStage`), and defaults `deps.extractReady` to the
//      provider-registry check beside it — so a tick that WOULD fire still
//      refuses, BEFORE any cursor moves, when no runner is wired OR the
//      default runner's provider is unregistered (bootstrap's A2 rule), and
//      reports `provider_outage`: progress the model never saw must not look
//      healthy.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import { bootstrapSettled, type BootstrapSettled, type ExtractOutcome } from "./bootstrap.js";
import { cl1DeltaExtractStage, deltaProviderMissing } from "./cl1-delta.js";
import { ATTACHMENT_COLUMNS, stateOf, type AttachmentRow } from "./enrichment-state.js";
import { planLiveTick, runLiveTick, type LiveTickResult } from "./live.js";
import { claimWork, completeWork, failWork, resumePaused } from "./queue.js";

// ---------------------------------------------------------------------------
// sources.mode — the §8.1 exit condition, persisted
// ---------------------------------------------------------------------------

/** Where the operating mode lives. `app_state`, so the flip survives restart. */
export const SOURCES_MODE_KEY = "sources.mode";

export type SourcesMode = "bootstrap" | "steady";

/** The stored mode. Anything unset or unknown is `bootstrap` — the safe start. */
export function getSourcesMode(): SourcesMode {
  return appStateGet(SOURCES_MODE_KEY) === "steady" ? "steady" : "bootstrap";
}

export interface FlipOutcome {
  mode: SourcesMode;
  /** True exactly once per install: the tick that wrote the row. */
  flipped: boolean;
  /** The conditions checked, or null when the mode was already `steady`. */
  checked: BootstrapSettled | null;
}

/**
 * Flip `sources.mode` to `steady` when — and only when — bootstrap has
 * settled. Idempotent by construction: once the row reads `steady` the
 * conditions are not even re-checked, so the flip happens exactly once and a
 * restart lands on the stored answer. There is deliberately no path back to
 * `bootstrap` here — a reprocess is `cohorts.mode = 'reprocess'`, not a mode
 * regression (§8.1).
 */
export function flipToSteadyIfSettled(now: number = Date.now()): FlipOutcome {
  if (getSourcesMode() === "steady") return { mode: "steady", flipped: false, checked: null };
  const checked = bootstrapSettled(now);
  if (!checked.settled) return { mode: "bootstrap", flipped: false, checked };
  appStateSet(SOURCES_MODE_KEY, "steady");
  log(
    `sources.mode bootstrap -> steady (backfill=${checked.backfillComplete} ` +
      `candidates=0 cohorts=0 tier=1.0) — the live trigger now owns new events`,
  );
  return { mode: "steady", flipped: true, checked };
}

// ---------------------------------------------------------------------------
// The `enrich` lane-entry drain — free, unconditional
// ---------------------------------------------------------------------------

/** Rows reconciled per tick. A claim/settle unit, like the entity drain's. */
export const ENRICH_DRAIN_LIMIT = 256;
/** How long a still-pending attachment waits before it is looked at again. */
export const ENRICH_WAIT_MS = 600_000;

export interface EnrichDrainReport {
  claimed: number;
  /** Rows whose event needs nothing (or is already read) — retired. */
  completed: number;
  /** Rows whose media is still being read — parked, re-checked in 10 min. */
  waiting: number;
  /** Rows whose event no longer exists — retired, counted separately. */
  missing: number;
  /** Structurally free: no transport is imported and none can be called. */
  llmCalls: 0;
  errors: string[];
}

/**
 * Reconcile the `enrich` lane-entry rows against `events.enrichment_state`.
 *
 * `tiers/rescan.ts` files one of these per event on every tier change (Lane
 * E's entry, §9.4) and nothing ever claimed them. The actual enrichment — the
 * captions, transcripts and scrapes — is `media/queue.ts`'s lane, with its own
 * budget and its own pass-2 hand-off (`media/enrich-pass.ts`); this drain is
 * the bookkeeping between the two: an event whose enrichment is RESOLVED
 * (none_needed / ready / failed / skipped — §8.4 rule 3) retires its row, and
 * one still `pending` parks it with a wait rather than spinning on it. Parked
 * rows come back through `resumePaused`, which the steady tick calls first.
 */
export function drainEnrichQueue(opts: { limit?: number; now?: number } = {}): EnrichDrainReport {
  const now = opts.now ?? Date.now();
  const report: EnrichDrainReport = { claimed: 0, completed: 0, waiting: 0, missing: 0, llmCalls: 0, errors: [] };
  const items = claimWork({
    stages: ["enrich"],
    unitKinds: ["event"],
    limit: Math.max(1, Math.floor(opts.limit ?? ENRICH_DRAIN_LIMIT)),
    nowIso: new Date(now).toISOString(),
  });
  if (items.length === 0) return report;
  report.claimed = items.length;

  const read = getDb().prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM events WHERE id = ?`);
  const waitUntil = new Date(now + ENRICH_WAIT_MS).toISOString();
  for (const item of items) {
    try {
      const row = read.get(item.unitId) as AttachmentRow | undefined;
      if (row === undefined) {
        // The event is gone; there is nothing left to enrich. Retired rather
        // than quarantined — an absent row is a fact, not a failure.
        completeWork(item.id);
        report.missing += 1;
        continue;
      }
      if (stateOf(row) === "pending") {
        // Still being read. `pause` refunds the attempt — waiting on the media
        // lane is not this row's fault — and `resumePaused` un-parks it.
        failWork(item.id, { action: "pause", notBeforeAt: waitUntil });
        report.waiting += 1;
        continue;
      }
      completeWork(item.id);
      report.completed += 1;
    } catch (err) {
      report.errors.push(`${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      failWork(item.id, { action: "retry", notBeforeAt: waitUntil });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// The steady tick
// ---------------------------------------------------------------------------

/** Ceiling on delta-extraction model calls in one tick — the slice-run figure. */
export const STEADY_MAX_LLM_CALLS = 40;

/** The seams this module deliberately does not own. */
export interface SteadyDeps {
  /**
   * P-CL1Δ over one fired session's delta window. `cl1DeltaExtractStage()`
   * (scheduler/cl1-delta.ts) is the production implementation, defaulted in
   * by `startSteadyDriver` via {@link steadyDepsWithDefaults}; a test passes
   * a fake. When NO runner is wired at all, a tick that would fire REFUSES
   * (see `runSteadyTick`) rather than advance delta cursors nothing will ever
   * extract from.
   */
  extract?: (input: {
    sessionId: string;
    streamId: string;
    eventIds: readonly string[];
    budget: number;
    now: number;
  }) => Promise<number | ExtractOutcome> | number | ExtractOutcome;
  /**
   * Asked BEFORE any cursor moves, on a tick that would fire: a non-null
   * answer is the reason the extraction runner cannot actually run, and the
   * tick refuses with `provider_outage` — bootstrap's A2 rule, at the same
   * point in the tick. Defaulted (alongside the default `extract`) to
   * `deltaProviderMissing`; a caller that injected its own `extract` has
   * supplied its own transport and is deliberately not second-guessed.
   */
  extractReady?: () => string | null;
}

export interface SteadyReport {
  nowMs: number;
  mode: SourcesMode;
  flipped: boolean;
  /** Paused queue rows whose wait expired, returned to `ready` this tick. */
  resumed: number;
  enrich: EnrichDrainReport | null;
  /** The live pass, or null when the tick never reached it. */
  live: LiveTickResult | null;
  /** BILLED provider calls through the extraction seam, retries included. */
  llmCallsSpent: number;
  /** Same vocabulary as `BootstrapReport.stoppedBy`, same obligations. */
  stoppedBy: "budget" | "no_work" | "stopped" | "error" | "provider_outage" | null;
  errors: string[];
}

export interface SteadyTickOptions {
  now?: number;
  maxLlmCalls?: number;
  liveIntervalMs?: number;
  deps?: SteadyDeps;
  /** The driver's stop flag — checked between units, never mid-write. */
  shouldStop?: () => boolean;
}

function emptyReport(nowMs: number): SteadyReport {
  return {
    nowMs,
    mode: "bootstrap",
    flipped: false,
    resumed: 0,
    enrich: null,
    live: null,
    llmCallsSpent: 0,
    stoppedBy: null,
    errors: [],
  };
}

function log(line: string): void {
  console.error(`[steady] ${line}`);
}

function note(report: SteadyReport, stage: string, unit: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  report.errors.push(`${stage}(${unit}): ${message}`);
  log(`ERROR stage=${stage} unit=${unit} — ${message}`);
}

/**
 * One steady tick: free work, the flip, then — in steady mode only — the live
 * trigger and the delta-extraction seam.
 *
 * The free stages run FIRST and in every mode, for the same reason bootstrap's
 * do: the first thing a tick should deliver is the derivation that costs
 * nothing, and gating the enrich reconciliation behind the flip would strand
 * Lane E's rows for exactly as long as bootstrap takes.
 */
export async function runSteadyTick(opts: SteadyTickOptions = {}): Promise<SteadyReport> {
  const now = opts.now ?? Date.now();
  const cap = typeof opts.maxLlmCalls === "number" && opts.maxLlmCalls >= 0 ? opts.maxLlmCalls : STEADY_MAX_LLM_CALLS;
  const deps = opts.deps ?? {};
  const report = emptyReport(now);
  const stopped = (): boolean => opts.shouldStop?.() === true;

  // ---- free, unconditional: un-park expired waits, reconcile Lane E's entry.
  try {
    report.resumed = resumePaused(new Date(now).toISOString());
  } catch (err) {
    note(report, "resume", "-", err);
  }
  try {
    report.enrich = drainEnrichQueue({ now });
  } catch (err) {
    note(report, "enrich", "-", err);
  }
  if (stopped()) {
    report.stoppedBy = "stopped";
    return report;
  }

  // ---- the flip. DB-derived, one-shot, crash-safe.
  try {
    const flip = flipToSteadyIfSettled(now);
    report.mode = flip.mode;
    report.flipped = flip.flipped;
  } catch (err) {
    note(report, "flip", "-", err);
    report.stoppedBy = "error";
    return report;
  }
  if (report.mode !== "steady") {
    report.stoppedBy = quiet(report) ? "no_work" : null;
    return report;
  }

  // ---- the consumer check, BEFORE any cursor moves. A fired pass advances
  // `last_delta_at`; with no runner to spend the enqueued work, those events
  // would be marked covered and never extracted — a silently unread message.
  // Same shape as bootstrap's A2 provider refusal, and just as loud.
  const plan = planLiveTick({
    nowMs: now,
    mode: "steady",
    ...(opts.liveIntervalMs === undefined ? {} : { liveIntervalMs: opts.liveIntervalMs }),
  });
  const wouldFire = plan.plans.some((p) => p.decision.fires && p.eventIds.length > 0);
  if (wouldFire) {
    const blocked =
      deps.extract === undefined
        ? `a delta pass is due and NO P-CL1Δ extraction runner is wired (deps.extract) — refusing to ` +
          `advance delta cursors that nothing can extract from. The session stays due; wire the runner`
        : (deps.extractReady?.() ?? null);
    if (blocked !== null) {
      note(report, "live", "-", new Error(blocked));
      report.stoppedBy = "provider_outage";
      return report;
    }
  }

  // ---- commit: the live trigger's plan-then-fire, then the extraction seam,
  // wallet-capped exactly like bootstrap's understanding rung.
  let live: LiveTickResult;
  try {
    live = runLiveTick({
      nowMs: now,
      mode: "steady",
      ...(opts.liveIntervalMs === undefined ? {} : { liveIntervalMs: opts.liveIntervalMs }),
    });
  } catch (err) {
    note(report, "live", "-", err);
    report.stoppedBy = "error";
    return report;
  }
  report.live = live;

  if (deps.extract !== undefined) {
    for (const pass of live.fired) {
      if (stopped()) {
        report.stoppedBy = "stopped";
        return report;
      }
      const budget = cap - report.llmCallsSpent;
      if (budget <= 0) {
        report.stoppedBy = "budget";
        break;
      }
      try {
        const outcome = await deps.extract({
          sessionId: pass.sessionId,
          streamId: pass.streamId,
          eventIds: pass.eventIds,
          budget,
          now,
        });
        const spent = typeof outcome === "number" ? outcome : outcome.calls;
        report.llmCallsSpent += Math.max(0, Math.floor(spent));
        if (typeof outcome !== "number") {
          for (const err of outcome.errors ?? []) note(report, "extract", pass.sessionId, new Error(err));
        }
      } catch (err) {
        note(report, "extract", pass.sessionId, err);
      }
    }
  }

  if (report.stoppedBy === null && quiet(report)) report.stoppedBy = "no_work";
  if (stopped()) report.stoppedBy = "stopped";
  if (!quiet(report) || report.errors.length > 0) {
    log(
      `tick mode=${report.mode}${report.flipped ? " FLIPPED" : ""} resumed=${report.resumed} ` +
        `enrich=${report.enrich?.completed ?? 0}+${report.enrich?.waiting ?? 0}w ` +
        `fired=${report.live?.fired.length ?? 0} held=${report.live?.held.length ?? 0} ` +
        `llm=${report.llmCallsSpent}/${cap} stopped=${report.stoppedBy ?? "-"} errors=${report.errors.length}`,
    );
  }
  return report;
}

/** Did this tick do anything at all? The `no_work` test, in one place. */
function quiet(report: SteadyReport): boolean {
  return (
    !report.flipped &&
    report.resumed === 0 &&
    (report.enrich?.claimed ?? 0) === 0 &&
    (report.live?.fired.length ?? 0) === 0 &&
    report.llmCallsSpent === 0
  );
}

// ---------------------------------------------------------------------------
// The timer — `startBootstrapDriver`'s idiom, verbatim
// ---------------------------------------------------------------------------

/** The live cadence's floor (§8.3): the trigger re-checks every 30 s. */
export const STEADY_INTERVAL_MS = 30_000;

export interface SteadyDriver {
  stop(): void;
  status(): SteadyReport;
}

export interface StartSteadyOptions {
  intervalMs?: number;
  maxLlmCalls?: number;
  deps?: SteadyDeps;
}

/**
 * The production seams, defaulted — `startBootstrapDriver`'s idiom for
 * `cl1ExtractStage`, applied to the delta runner. A caller that supplied its
 * own `extract` keeps its deps UNTOUCHED, readiness check included: an
 * injected transport does not go through the provider registry, so checking
 * the registry against it would refuse work the caller can actually do
 * (bootstrap A2's stated exception). Exported so a test can exercise the
 * exact deps the driver would run with, without the timer.
 */
export function steadyDepsWithDefaults(deps: SteadyDeps = {}): SteadyDeps {
  if (deps.extract !== undefined) return deps;
  return {
    ...deps,
    extract: cl1DeltaExtractStage(),
    extractReady: deps.extractReady ?? deltaProviderMissing,
  };
}

/**
 * The scheduled caller `scheduler/live.ts` never had.
 *
 * Same shape as `startBootstrapDriver`: an interval, a `ticking` latch so a
 * slow tick never overlaps itself, `unref` so a pending tick cannot hold the
 * process open, a `stop()` that clears the handle, and a failing tick logged
 * rather than swallowed. Runs in BOTH modes from boot — before the flip it is
 * the enrich reconciliation and the flip check, both free; after it, the live
 * trigger.
 */
export function startSteadyDriver(opts: StartSteadyOptions = {}): SteadyDriver {
  const intervalMs = opts.intervalMs ?? STEADY_INTERVAL_MS;
  const deps = steadyDepsWithDefaults(opts.deps);
  let last = emptyReport(Date.now());
  let ticking = false;
  let stopped = false;

  log(`mode=${getSourcesMode()} interval=${intervalMs}ms — flips to steady when bootstrap settles`);

  const handle = setInterval(() => {
    if (ticking || stopped) return;
    ticking = true;
    void (async () => {
      try {
        last = await runSteadyTick({
          ...(opts.maxLlmCalls === undefined ? {} : { maxLlmCalls: opts.maxLlmCalls }),
          deps,
          shouldStop: () => stopped,
        });
      } catch (err) {
        last = { ...last, stoppedBy: "error", errors: [...last.errors, String(err)] };
        log(`tick threw outside a stage: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      } finally {
        ticking = false;
      }
    })();
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();

  return {
    stop(): void {
      stopped = true;
      clearInterval(handle);
    },
    status(): SteadyReport {
      return last;
    },
  };
}
