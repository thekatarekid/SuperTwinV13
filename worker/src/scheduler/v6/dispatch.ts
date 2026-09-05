// ===========================================================================
// [CODE] The V6 dispatcher (Product_V6 §11.3, §23.2, §23.7.15; P1 §6–§9;
// Build V6 P1 S3.3). Replaces the V13 window dispatcher deleted in this
// commit (S0.3's temporary disarm dies here, its invariants live on).
//
//   tick ─► ingest new rows ─► per live event: state gate (gate.ts) · burst
//           (burst.ts) · cold window (cold.ts)
//        ─► live flush when due: ONE bundle, all streams, ≤ 20k chars
//        ─► background fill: history day bundles (history.ts) newest first,
//           then tier-3 weekly digests (digest.ts)
//
// Three invariants, asserted by BND-08/09/10 and never optional:
//
//   SLOT CAP     at most cfg.slots bundles leave one tick, on every path —
//                live, history, digest, re-dispatch. There is no path around
//                `routed.length < cfg.slots`.
//   KEYED        in-flight work is keyed `<stream>:<min>-<max>`; the same key
//                submitted while live is a no-op, never a second model call.
//   REVALIDATE   a bundle is re-read at execution: any row already stamped
//                makes it stale and it returns with zero model calls.
//
// Three strikes (attempts.ts, BND-11): a bundle that fails or quarantines is
// re-tried at +5 and +10 minutes, then dead-lettered — stamped, listed on
// /api/ops/quarantine, never a fourth.
//
// The live lane runs on the pool's reserved `live` lane (providers/pool.ts):
// two hundred queued history bundles cannot delay a live flush (GATE-09).
//
// EVAL ISOLATION HOOK (S3.9): rows whose `origin` is in `ignoreOrigins` are
// never gated, bundled or stamped by this dispatcher. S3.9 adds the 'eval'
// origin and sets DEFAULT_IGNORED_ORIGINS = ["eval"]; nothing else changes.
// ===========================================================================

import { createHash } from "node:crypto";
import { getDb } from "../../db/connection.js";
import { runBrainTick } from "../../brain/consumer.js";
import { runDigestPass } from "../../brain/digest-pass.js";
import {
  bundleKey,
  bundleRef,
  bestBand,
  dayOf,
  DEFAULT_DISPATCH_CONFIG,
  isBundleStale,
  markDispatched,
  pendingRows,
  tierOf,
  toBundleEvent,
  type BundleEvent,
  type DeltaBundle,
  type DispatchConfig,
  type PendingRow,
} from "./bundle.js";
import { gateEvent, type GateDecision } from "./gate.js";
import { BurstTracker } from "./burst.js";
import { ColdWindow, effectiveParams, type ColdParams, type FlushTrigger, type FreshnessPreset, type PendingEvent } from "./cold.js";
import { planHistory } from "./history.js";
import { planDigest } from "./digest.js";
import { attemptEligibility, recordFailedAttempt, recordSuccess, RETRY_DELAY_MS } from "./attempts.js";

// ---- Hooks and options -------------------------------------------------------

/**
 * Origins this dispatcher never touches. Empty today; S3.9 (eval isolation)
 * sets it to ["eval"] so fixture events written by the harness are never
 * bundled by a running worker.
 */
export const DEFAULT_IGNORED_ORIGINS: readonly string[] = [];

/** app_state key holding the Settings › Assist freshness preset. */
export const FRESHNESS_KEY = "assist.freshness";

/** How often the production dispatcher ticks. */
export const TICK_MS = 5_000;

export type SinkStatus = "committed" | "empty" | "quarantined" | "stale" | "failed";

export interface SinkResult {
  status: SinkStatus;
  error?: string;
}

/** Where a bundle goes. The sink marks dispatched events itself on success. */
export type BundleSink = (bundle: DeltaBundle) => Promise<SinkResult> | SinkResult;

export interface DispatcherOptions {
  cfg?: DispatchConfig;
  /** Live and history bundles. Default: brain/consumer runBrainTick. */
  sink?: BundleSink;
  /** Digest bundles. Default: brain/digest-pass runDigestPass, marking on success. */
  digestSink?: BundleSink;
  now?: () => number;
  log?: (line: string) => void;
  /** Freshness preset; default reads app_state FRESHNESS_KEY. */
  preset?: () => FreshnessPreset | string | null;
  /** S3.9 hook — see DEFAULT_IGNORED_ORIGINS. */
  ignoreOrigins?: readonly string[];
  /** Serve history bundles (default true). */
  history?: boolean;
  /** Serve digest bundles (default true). */
  digest?: boolean;
  /** Novelty seed per stream on first sight (default 64 rows). */
  noveltySeed?: number;
  /**
   * Only streams whose key starts with this. For tests and the eval executors,
   * which share one DB with other cases' rows; production leaves it unset.
   */
  streamKeyPrefix?: string;
  /** Force the cold window (tests / eval executors); default: preset + bootstrapping from the DB. */
  coldParams?: ColdParams;
}

export interface TickResult {
  /** Bundles handed to a sink this tick — never more than cfg.slots. */
  routed: DeltaBundle[];
  /** Background bundles the plan held that no slot admitted. */
  heldBack: number;
  /** Live events gated this tick. */
  gated: { hot: number; cold: number; burst: number; repeats: number };
  /** Tier-4 rows stamped without a call. */
  indexOnly: number;
  /** The live flush this tick, if any. */
  liveFlush: { trigger: FlushTrigger; events: number } | null;
}

export interface DispatcherStats {
  flushes: Record<FlushTrigger, number>;
  /** Hot event arrival → flush, ms (last 1,000). */
  hotLatenciesMs: number[];
  routed: { live: number; history: number; digest: number };
  stale: number;
  duplicates: number;
  deadLetters: number;
  indexOnly: number;
}

// ---- Defaults ----------------------------------------------------------------

function defaultSink(): BundleSink {
  return async (bundle) => {
    const report = await runBrainTick(bundle);
    return { status: report.status };
  };
}

function defaultDigestSink(): BundleSink {
  return async (bundle) => {
    const report = await runDigestPass(bundle);
    if (report.status === "ok") {
      markDispatched(bundle);
      return { status: "committed" };
    }
    return { status: "failed", error: report.error };
  };
}

function readPreset(): string | null {
  try {
    const row = getDb().prepare(`SELECT value FROM app_state WHERE key = ?`).get(FRESHNESS_KEY) as
      | { value: string | null }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function bootstrapInput(nowMs: number): { spaces: number; firstConsentMs: number | null; nowMs: number } {
  const db = getDb();
  const spaces = (db.prepare(`SELECT COUNT(*) AS n FROM spaces WHERE status != 'rejected'`).get() as { n: number }).n;
  const first = db.prepare(`SELECT MIN(granted_at) AS at FROM consents`).get() as { at: string | null } | undefined;
  const ms = first?.at ? Date.parse(first.at) : NaN;
  return { spaces, firstConsentMs: Number.isFinite(ms) ? ms : null, nowMs };
}

/** Novelty key: the content, not the row — a repeated screen frame is a repeat. */
export function contentKey(kind: string | null, text: string | null): string {
  return createHash("sha1").update(`${kind ?? ""}\n${(text ?? "").trim()}`).digest("hex");
}

function tsMs(ts: string | null, fallback: number): number {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

// ---- The dispatcher ----------------------------------------------------------

export class Dispatcher {
  readonly cfg: DispatchConfig;
  private readonly sink: BundleSink;
  private readonly digestSink: BundleSink;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly preset: () => FreshnessPreset | string | null;
  private readonly ignoreOrigins: ReadonlySet<string>;
  private readonly serveHistory: boolean;
  private readonly serveDigest: boolean;
  private readonly noveltySeed: number;
  private readonly scope: string | undefined;
  private readonly forcedCold: ColdParams | undefined;

  private cursorRowid = 0;
  readonly cold = new ColdWindow();
  readonly burst = new BurstTracker();
  private readonly rows = new Map<number, PendingRow>();
  private readonly seeded = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();
  private hotStreamId: string | null = null;
  private hotSinceMs: number | null = null;
  private liveHoldUntilMs = 0;
  private readonly deadLettered = new Set<string>();
  private readonly statsState: DispatcherStats = {
    flushes: { hot: 0, burst: 0, cold: 0, cap: 0 },
    hotLatenciesMs: [],
    routed: { live: 0, history: 0, digest: 0 },
    stale: 0,
    duplicates: 0,
    deadLetters: 0,
    indexOnly: 0,
  };

  constructor(opts: DispatcherOptions = {}) {
    this.cfg = opts.cfg ?? DEFAULT_DISPATCH_CONFIG;
    this.sink = opts.sink ?? defaultSink();
    this.digestSink = opts.digestSink ?? defaultDigestSink();
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.preset = opts.preset ?? readPreset;
    this.ignoreOrigins = new Set(opts.ignoreOrigins ?? DEFAULT_IGNORED_ORIGINS);
    this.serveHistory = opts.history ?? true;
    this.serveDigest = opts.digest ?? true;
    this.noveltySeed = opts.noveltySeed ?? 64;
    this.scope = opts.streamKeyPrefix;
    this.forcedCold = opts.coldParams;
  }

  stats(): DispatcherStats {
    return {
      ...this.statsState,
      flushes: { ...this.statsState.flushes },
      hotLatenciesMs: [...this.statsState.hotLatenciesMs],
      routed: { ...this.statsState.routed },
    };
  }

  /** Keys currently in flight (tests, /api/ops). */
  inFlightKeys(): string[] {
    return [...this.inflight.keys()];
  }

  /** Settle every in-flight bundle. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight.values()]);
  }

  // ---- one tick -----------------------------------------------------------

  tick(nowMs: number = this.now()): TickResult {
    const result: TickResult = {
      routed: [],
      heldBack: 0,
      gated: { hot: 0, cold: 0, burst: 0, repeats: 0 },
      indexOnly: 0,
      liveFlush: null,
    };
    this.cold.setParams(this.forcedCold ?? effectiveParams(this.preset(), bootstrapInput(nowMs)));
    this.ingest(nowMs, result);
    this.flushLive(nowMs, result);
    this.fillBackground(nowMs, result);
    return result;
  }

  /** Read every pending row past the cursor and gate the live ones. */
  private ingest(nowMs: number, result: TickResult): void {
    const fresh = pendingRows(this.cursorRowid, this.scope);
    const indexOnly: PendingRow[] = [];
    for (const r of fresh) {
      this.cursorRowid = Math.max(this.cursorRowid, r.rowid);
      if (r.origin && this.ignoreOrigins.has(r.origin)) continue;
      const tier = tierOf(r);
      if (tier === 4) {
        indexOnly.push(r);
        continue;
      }
      if (tier === 3) continue; // digest lane
      if (r.origin !== "live") continue; // history lane reads the log itself
      this.gateLive(r, nowMs, result);
    }
    if (indexOnly.length > 0) {
      // Tier 4 is index-only: stamped so it never piles up, never understood.
      const byStream = new Map<string, PendingRow[]>();
      for (const r of indexOnly) {
        const sid = r.stream_id ?? r.stream_key;
        (byStream.get(sid) ?? byStream.set(sid, []).get(sid)!).push(r);
      }
      for (const [sid, rows] of byStream) {
        markDispatched(
          {
            streamId: sid,
            streamKey: rows[0].stream_key,
            lane: "history",
            ageBand: "A",
            events: rows.map(toBundleEvent),
            part: 1,
            partCount: 1,
          },
          nowMs,
        );
      }
      result.indexOnly += indexOnly.length;
      this.statsState.indexOnly += indexOnly.length;
    }
  }

  private gateLive(r: PendingRow, nowMs: number, result: TickResult): void {
    const streamId = r.stream_id ?? r.stream_key;
    this.seedNovelty(streamId, r.rowid);
    this.rows.set(r.rowid, r);
    const key = contentKey(r.kind, r.text);
    const atMs = tsMs(r.ts, nowMs);
    const isNew = this.cold.isNew(streamId, key);
    let roles: { sender?: string; receiver?: string[]; audience?: string[] } | null = null;
    if (r.roles_json) {
      try {
        roles = JSON.parse(r.roles_json) as typeof roles;
      } catch {
        roles = null;
      }
    }
    const gate: GateDecision = gateEvent(
      { id: r.id, streamId, source: r.source_id ?? "", kind: r.kind, actor: r.actor, roles, streamKey: r.stream_key },
      { nowMs },
    );
    const pending: Omit<PendingEvent, "contentNew"> = {
      rowid: r.rowid,
      id: r.id,
      streamId,
      contentKey: key,
      chars: (r.text ?? "").length,
      atMs,
    };
    this.cold.add(pending);
    if (!isNew) result.gated.repeats += 1;
    if (gate.decision === "hot") {
      result.gated.hot += 1;
      this.cold.urge("hot");
      this.hotStreamId ??= streamId;
      this.hotSinceMs ??= nowMs;
      return;
    }
    // Burst counts content-new events only; a repeat is neither hot nor a run.
    const b = isNew ? this.burst.note(streamId, atMs, key) : { burst: false, runLength: 0, counted: false };
    if (b.burst) {
      result.gated.burst += 1;
      this.cold.urge("burst");
      this.hotStreamId ??= streamId;
      this.hotSinceMs ??= nowMs;
      return;
    }
    result.gated.cold += 1;
  }

  /** On first sight of a stream, remember its recent content so a restart never mistakes a heartbeat for news. */
  private seedNovelty(streamId: string, beforeRowid: number): void {
    if (this.seeded.has(streamId) || this.noveltySeed <= 0) return;
    this.seeded.add(streamId);
    const rows = getDb()
      .prepare(`SELECT kind, text FROM events WHERE stream_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`)
      .all(streamId, beforeRowid, this.noveltySeed) as { kind: string | null; text: string | null }[];
    for (const r of rows) this.cold.markSeen(streamId, contentKey(r.kind, r.text));
  }

  // ---- live flush ---------------------------------------------------------

  private flushLive(nowMs: number, result: TickResult): void {
    if (result.routed.length >= this.cfg.slots) return;
    if (nowMs < this.liveHoldUntilMs) return;
    const due = this.cold.due(nowMs);
    if (!due) return;
    const flushed = this.cold.flush(nowMs);
    if (flushed.events.length === 0) return;
    const events: BundleEvent[] = flushed.events
      .map((p) => this.rows.get(p.rowid))
      .filter((r): r is PendingRow => r !== undefined)
      .map(toBundleEvent);
    if (events.length === 0) return;
    const leadStream = this.hotStreamId ?? flushed.events[0].streamId;
    const leadRow = flushed.events.find((p) => p.streamId === leadStream) ?? flushed.events[0];
    const lead = this.rows.get(leadRow.rowid)!;
    const bundle: DeltaBundle = {
      streamId: leadStream,
      streamKey: lead.stream_key,
      lane: "live",
      ageBand: bestBand(events),
      events,
      part: 1,
      partCount: 1,
      day: dayOf(events),
      trigger: flushed.trigger,
    };
    this.burst.reset();
    this.statsState.flushes[flushed.trigger] += 1;
    if (this.hotSinceMs !== null) {
      const lat = this.statsState.hotLatenciesMs;
      lat.push(Math.max(0, nowMs - this.hotSinceMs));
      if (lat.length > 1_000) lat.splice(0, lat.length - 1_000);
    }
    this.hotStreamId = null;
    this.hotSinceMs = null;
    const outcome = this.submit(bundle, this.sink, nowMs, "live");
    if (outcome === "routed") {
      result.routed.push(bundle);
      result.liveFlush = { trigger: flushed.trigger, events: events.length };
      this.log(
        `[dispatch] live flush (${flushed.trigger}): ${events.length} event(s)` +
          (flushed.remaining > 0 ? `, ${flushed.remaining} held past the cap` : ""),
      );
    }
  }

  // ---- background fill ----------------------------------------------------

  private fillBackground(nowMs: number, result: TickResult): void {
    // Waiters stay bounded: no new background work while the pool already
    // holds a full complement of ours (the live flush above never waits on this).
    if (this.inflight.size >= this.cfg.slots * 2) return;
    let free = this.cfg.slots - result.routed.length;
    if (free <= 0) return;
    const skip = new Set(this.inflight.keys());
    for (const k of this.deadLettered) skip.add(k);

    if (this.serveHistory) {
      const plan = planHistory({ limit: free * 4, skipKeys: skip, streamKeyPrefix: this.scope });
      let taken = 0;
      for (const bundle of plan) {
        if (free <= 0) break;
        const outcome = this.submit(bundle, this.sink, nowMs, "history");
        if (outcome === "routed") {
          result.routed.push(bundle);
          free -= 1;
          taken += 1;
        }
      }
      result.heldBack += Math.max(0, plan.length - taken);
    }
    if (free > 0 && this.serveDigest) {
      const plan = planDigest({ nowMs, limit: free * 2, skipKeys: skip, streamKeyPrefix: this.scope });
      let taken = 0;
      for (const bundle of plan) {
        if (free <= 0) break;
        const outcome = this.submit(bundle, this.digestSink, nowMs, "digest");
        if (outcome === "routed") {
          result.routed.push(bundle);
          free -= 1;
          taken += 1;
        }
      }
      result.heldBack += Math.max(0, plan.length - taken);
    }
  }

  // ---- submission: keyed, revalidated, three strikes -----------------------

  /**
   * Hand one bundle to a sink under the three invariants. Public so the bar
   * (S4) and the tests can submit a bundle they built; the tick uses it for
   * every lane. Never more than one model call per key, never a call on a
   * stale bundle, never a fourth attempt.
   */
  submit(
    bundle: DeltaBundle,
    sink: BundleSink,
    nowMs: number,
    lane: "live" | "history" | "digest",
  ): "routed" | "duplicate" | "stale" | "held" | "dead" {
    const key = bundleKey(bundle);
    if (this.inflight.has(key)) {
      this.statsState.duplicates += 1;
      return "duplicate";
    }
    if (isBundleStale(bundle)) {
      this.afterSettle(bundle, { status: "stale" }, nowMs, lane);
      return "stale";
    }
    const ref = bundleRef(bundle);
    const elig = attemptEligibility(ref, nowMs);
    if (elig.deadLettered) {
      this.deadLetter(bundle, lane, nowMs);
      return "dead";
    }
    if (!elig.eligible) {
      if (lane === "live") this.requeueLive(bundle, elig.nextAttemptAtMs ?? nowMs + RETRY_DELAY_MS);
      return "held";
    }
    const p = Promise.resolve()
      .then(() => sink(bundle))
      .then(
        (res) => this.afterSettle(bundle, res, this.now(), lane),
        (err) =>
          this.afterSettle(
            bundle,
            { status: "failed", error: err instanceof Error ? err.message : String(err) },
            this.now(),
            lane,
          ),
      )
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    this.statsState.routed[lane] += 1;
    return "routed";
  }

  private afterSettle(bundle: DeltaBundle, res: SinkResult, nowMs: number, lane: "live" | "history" | "digest"): void {
    const ref = bundleRef(bundle);
    switch (res.status) {
      case "committed":
      case "empty":
        recordSuccess(ref);
        this.forgetStamped(bundle);
        return;
      case "stale":
        this.statsState.stale += 1;
        this.forgetStamped(bundle);
        return;
      case "quarantined":
      case "failed": {
        const attempt = recordFailedAttempt(ref, res.error ?? res.status, nowMs);
        if (attempt.deadLettered) {
          this.deadLetter(bundle, lane, nowMs);
          return;
        }
        this.log(
          `[dispatch] ${lane} bundle ${bundleKey(bundle)} ${res.status} (attempt ${attempt.row.attempts}/3)` +
            (res.error ? `: ${res.error}` : ""),
        );
        if (lane === "live") this.requeueLive(bundle, nowMs + RETRY_DELAY_MS);
        return;
      }
    }
  }

  /** Drop accumulated live events that are now stamped; keep the rest for the next flush. */
  private forgetStamped(bundle: DeltaBundle): void {
    const stmt = getDb().prepare(`SELECT dispatched_at FROM events WHERE rowid = ?`);
    const stamped: string[] = [];
    const unstamped: BundleEvent[] = [];
    for (const e of bundle.events) {
      const row = stmt.get(e.rowid) as { dispatched_at: string | null } | undefined;
      if (!row || row.dispatched_at !== null) stamped.push(e.id);
      else unstamped.push(e);
    }
    for (const id of stamped) {
      const e = bundle.events.find((x) => x.id === id);
      if (e) this.rows.delete(e.rowid);
    }
    this.cold.forget(stamped);
    if (bundle.lane === "live" && unstamped.length > 0) this.requeueLive({ ...bundle, events: unstamped }, 0);
  }

  /** Put a live bundle's events back in the accumulator; hold the lane until `untilMs`. */
  private requeueLive(bundle: DeltaBundle, untilMs: number): void {
    for (const e of bundle.events) {
      const streamId = e.streamId ?? bundle.streamId;
      this.cold.readd({
        rowid: e.rowid,
        id: e.id,
        streamId,
        contentKey: contentKey(e.kind, e.text),
        chars: (e.text ?? "").length,
        atMs: tsMs(e.ts, untilMs),
      });
    }
    // Due the moment the hold lifts — the retry is not a fresh cold window.
    this.cold.urge(bundle.trigger ?? "cold");
    this.liveHoldUntilMs = Math.max(this.liveHoldUntilMs, untilMs);
  }

  private deadLetter(bundle: DeltaBundle, lane: "live" | "history" | "digest", nowMs: number): void {
    const key = bundleKey(bundle);
    if (!this.deadLettered.has(key)) {
      this.deadLettered.add(key);
      this.statsState.deadLetters += 1;
      this.log(`[dispatch] ${lane} bundle ${key} dead-lettered after 3 attempts — on /api/ops/quarantine`);
    }
    // Stamped so it stops cycling; the bundle_attempts row is the record.
    markDispatched(bundle, nowMs);
    this.cold.forget(bundle.events.map((e) => e.id));
    for (const e of bundle.events) this.rows.delete(e.rowid);
  }
}

// ---- Production wiring -------------------------------------------------------

export interface DispatcherHandle {
  dispatcher: Dispatcher;
  /** One tick on demand. */
  tick(): TickResult;
  /** Settle in-flight work (shutdown). */
  drain(): Promise<void>;
  stop(): void;
}

/**
 * Start the production dispatcher: a 5 s tick, guarded so a slow tick never
 * stacks a second one. No tick, no new event, no due window → no model call.
 */
export function startDispatcher(opts: DispatcherOptions & { tickMs?: number } = {}): DispatcherHandle {
  const log = opts.log ?? (() => {});
  const dispatcher = new Dispatcher(opts);
  let ticking = false;
  const tick = (): TickResult => {
    if (ticking) return { routed: [], heldBack: 0, gated: { hot: 0, cold: 0, burst: 0, repeats: 0 }, indexOnly: 0, liveFlush: null };
    ticking = true;
    try {
      return dispatcher.tick();
    } catch (err) {
      log(`[dispatch] tick failed: ${err instanceof Error ? err.message : String(err)}`);
      return { routed: [], heldBack: 0, gated: { hot: 0, cold: 0, burst: 0, repeats: 0 }, indexOnly: 0, liveFlush: null };
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(tick, opts.tickMs ?? TICK_MS);
  timer.unref?.();
  return {
    dispatcher,
    tick,
    drain: () => dispatcher.drain(),
    stop() {
      clearInterval(timer);
    },
  };
}
