// ===========================================================================
// [CODE] Category T executor — the real scheduler (build item 1.8).
//
// T is `[CODE]` end to end: there is no model verdict to freeze, so
// `frozen_response` is a SCENARIO SCRIPT and the executor is the product.
// Nothing below re-implements a budget, an admission rule, a countdown or a
// coverage write — every number comes back out of `worker/src/scheduler/*`,
// which is the only way an eval can fail when the scheduler regresses.
//
// Scenario records, one per line, `tag|field=value|…`:
//
//   paint|ingest_s=10|seal_s=4|ttft_s=2|out=600|tps=50|write_s=4|prewarm=1
//                              the §9.5.4 timeline, and the streamed claims
//   request|call=P-EP1         ask the first-paint path to admit a call
//   slots|limit=8              lane caps during first paint (§9.5.3 rule 1)
//   budget|seq=1               the adaptive ramp
//   size|label=noisy|n=4|events=40|chars=90    cohort fill by output tokens
//   prewarm|spawn_ms=0|ready_ms=1400|clock_ms=1500
//   live|interval_ms=…|quiet_ms=…|new_events=…|passes=…|activity=…|mode=steady
//   live_hour|interval_ms=…|ticks=120          the 20-per-hour cap, counted
//   delta|messages=40                          O(n) vs O(n^2), measured
//   seal_hash|hash=h1|last=h1                  the consolidation hash gate
//   idle|start_ms=0|beats=10000,50000|now_ms=95000|pause=10000-70000
//   pause|to_ms=252000|now_ms=0                the countdown
//   episode|id=e1|media=1|pending=2|reprocess=0|late=0
//   media_order|ids=hour-old:9,from-2023:3     priority order, never FIFO
//   coverage|…                                 a real cohort walked to done
//   late_media|session=s1|pending=1            §9.6 rule 4, through item 1.7
//
// A tag that needs a database gets a real temp SQLite file with real
// migrations, created lazily so the pure cases stay fast.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../../db/ingest.js";
import { resolveEnrichment, setPendingEnrichmentCount } from "../../media/enrich-pass.js";
import { advanceCohort, candidateSessions, sealCohort } from "../../scheduler/cohorts.js";
import { cohortBudget, fillCohort, type SessionSize } from "../../scheduler/horizons.js";
import {
  IdleTracker,
  consolidationAtSeal,
  deltaPassCost,
  episodePassPlan,
  laneSlots,
  liveTrigger,
  mediaOrderInversions,
  pauseState,
  wholeSessionPassCost,
} from "../../scheduler/lanes.js";
import {
  LineStream,
  TimingLog,
  admit,
  paintBudget,
  planFirstPaint,
  prewarm,
  type PaintCall,
} from "../../scheduler/paint.js";
import { readCoverage } from "../../scheduler/queue.js";
import type { Executor, GateObservation, Produced } from "../runner.js";
import { schedImportObservations } from "./sched-import.js";

const SOURCE = "whatsapp";
const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const HOUR = 3_600_000;

interface Line {
  tag: string;
  f: Record<string, string>;
}

function parseScenario(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of (typeof text === "string" ? text : "").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const f: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`scheduler scenario: field without '=' in ${JSON.stringify(part)}`);
      f[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    out.push({ tag, f });
  }
  return out;
}

function num(f: Record<string, string>, key: string, fallback: number): number {
  const raw = f[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`scheduler scenario: ${key}=${raw} is not a number`);
  return n;
}

function flag(f: Record<string, string>, key: string, fallback: boolean): boolean {
  const raw = f[key];
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true";
}

// ---------------------------------------------------------------------------
// The DB world, built only for the tags that need one
// ---------------------------------------------------------------------------

class World {
  private dir: string | null = null;
  private seq = 0;

  open(): void {
    if (this.dir) return;
    this.dir = mkdtempSync(join(tmpdir(), "supertwin-eval-sched-"));
    process.env.SUPERTWIN_DB_PATH = join(this.dir, "st.db");
    closeDb();
    runMigrations();
    upsertSource({ id: SOURCE, type: SOURCE, name: "WhatsApp" });
  }

  close(): void {
    if (!this.dir) return;
    closeDb();
    delete process.env.SUPERTWIN_DB_PATH;
    rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
  }

  stream(ext: string, tier: string): string {
    this.open();
    const id = upsertStream({ sourceId: SOURCE, sourceExtId: ext, name: ext, kind: "dm" });
    getDb().prepare(`UPDATE streams SET tier = ?, tier_source = 'code' WHERE id = ?`).run(tier, id);
    return id;
  }

  /** A sealed session ending `agoMs` ago, with real event rows behind it. */
  session(streamId: string, agoMs: number, events: number, chars: number, id?: string): string {
    this.open();
    this.seq += 1;
    const sessionId = id ?? `s${this.seq}`;
    const endedAt = new Date(NOW - agoMs).toISOString();
    const startedAt = new Date(NOW - agoMs - 600_000).toISOString();
    const actorId = upsertActor({ sourceId: SOURCE, sourceExtId: `a${this.seq}`, displayName: `a${this.seq}` });
    const eventIds: string[] = [];
    for (let i = 0; i < events; i += 1) {
      const res = insertEvent({
        externalId: `${sessionId}/${i}`,
        sourceId: SOURCE,
        sourceType: SOURCE,
        streamId,
        actorId,
        ts: endedAt,
        kind: "message",
        text: "x".repeat(chars),
        mediaPath: null,
        rawJson: null,
        isHistorical: true,
      });
      eventIds.push(res.id);
    }
    getDb()
      .prepare(
        `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, seal_mode)
         VALUES (?, ?, ?, ?, ?, ?, 'sealed', 'immediate')`,
      )
      .run(sessionId, streamId, SOURCE, startedAt, endedAt, JSON.stringify(eventIds));
    return sessionId;
  }

  lastEventOf(sessionId: string): string {
    const row = getDb().prepare(`SELECT event_ids AS ids FROM sessions WHERE id = ?`).get(sessionId) as {
      ids: string | null;
    };
    const ids = JSON.parse(row.ids ?? "[]") as string[];
    return ids[ids.length - 1]!;
  }
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

interface Acc {
  output: Record<string, unknown[]>;
  state: Record<string, unknown>;
  metrics: Record<string, number>;
}

function bucket(acc: Acc, name: string): unknown[] {
  acc.output[name] ??= [];
  return acc.output[name]!;
}

export const schedulerExecutor: Executor = (ctx): Produced => {
  const scenario = parseScenario(ctx.response);
  const acc: Acc = { output: {}, state: {}, metrics: {} };
  const world = new World();
  try {
    for (const line of scenario) run(line, acc, world);
  } finally {
    world.close();
  }

  // The four §14.2 rows only an INTEGRATION run can measure — recency order,
  // bootstrap seal mode, live pre-emption delay and restart-without-re-judge —
  // ride with the first T case that completes (once per suite, see
  // sched-import.ts) over the real scheduler on a real temp DB.
  const gates: GateObservation[] = schedImportObservations();

  return { output: acc.output, state: acc.state, metrics: acc.metrics, gates };
};

function run(line: Line, acc: Acc, world: World): void {
  switch (line.tag) {
    case "paint":
      return doPaint(line, acc);
    case "request":
      return doRequest(line, acc);
    case "slots":
      return doSlots(line, acc);
    case "budget":
      return doBudget(line, acc);
    case "size":
      return doSize(line, acc);
    case "prewarm":
      return doPrewarm(line, acc);
    case "live":
      return doLive(line, acc);
    case "live_hour":
      return doLiveHour(line, acc);
    case "delta":
      return doDelta(line, acc);
    case "seal_hash":
      return doSealHash(line, acc);
    case "idle":
      return doIdle(line, acc);
    case "pause":
      return doPause(line, acc);
    case "episode":
      return doEpisode(line, acc);
    case "media_order":
      return doMediaOrder(line, acc);
    case "coverage":
      return doCoverage(line, acc, world);
    case "late_media":
      return doLateMedia(line, acc, world);
    default:
      throw new Error(`scheduler scenario: unknown tag '${line.tag}'`);
  }
}

// ---- first paint -----------------------------------------------------------

function doPaint(line: Line, acc: Acc): void {
  const budget = paintBudget({
    ingestSeconds: num(line.f, "ingest_s", 10),
    sealSeconds: num(line.f, "seal_s", 4),
    ttftSeconds: num(line.f, "ttft_s", 2),
    outputTokens: num(line.f, "out", 600),
    tokensPerSecond: num(line.f, "tps", 50),
    writePathSeconds: num(line.f, "write_s", 4),
    prewarmed: flag(line.f, "prewarm", true),
  });

  // The claims that render on the way. Each STW-2 line is emitted the instant
  // its newline arrives — never on call completion (§9.5.2).
  const wire = ["CL|a1|wants|goa villa", "CL|a1|sends|villa link tonight", "LP|a1|s|send villa link"];
  const stream = new LineStream();
  const perLineMs = (budget.streamSeconds * 1000) / wire.length;
  let at = budget.firstClaimSeconds * 1000;
  for (const record of wire) {
    stream.push(`${record}\n`, Math.round(at));
    at += perLineMs;
  }
  stream.end(Math.round(budget.firstTripleSeconds * 1000));

  for (const streamed of stream.all) bucket(acc, "claims").push(streamed.text);
  for (const buffered of stream.buffered) bucket(acc, "after_call_complete").push(buffered.text);
  bucket(acc, "after_call_complete");

  // §9.5.3 rule 4 — TTFT and tok/s per model per call type, recorded rather
  // than assumed, so a regression surfaces at the call that caused it.
  const timings = new TimingLog();
  timings.record({
    model: line.f.model ?? "sonnet",
    callType: "P-CL1",
    ttftMs: Math.round(num(line.f, "ttft_s", 2) * 1000),
    outputTokens: num(line.f, "out", 600),
    totalMs: Math.round(budget.streamSeconds * 1000) + Math.round(num(line.f, "ttft_s", 2) * 1000),
  });

  acc.state.phases = budget.phases.map((p) => p.name);
  acc.state.first_claim_streamed = stream.buffered.length === 0;
  acc.state.buffered_lines = stream.buffered.length;
  acc.state.ttft_recorded = timings.complete;
  acc.state.ttft_by_call = timings.worstTtft();
  acc.metrics.first_claim_s = round1((stream.firstLineMs ?? 0) / 1000);
  acc.metrics.time_to_first_triple_s = budget.firstTripleSeconds;
  acc.metrics.first_paint_calls = budget.callsOnPath;
}

function doRequest(line: Line, acc: Acc): void {
  const call = (line.f.call ?? "") as PaintCall;
  const plan = planFirstPaint([call]);
  for (const r of plan.executed) bucket(acc, "executed").push(r);
  for (const r of plan.deferred) bucket(acc, "deferred").push(r.call);
  for (const r of plan.barred) bucket(acc, "barred").push(r.call);
  // `executed` must exist even when empty: `absent` asserts on the bucket, and
  // a missing bucket would pass for the wrong reason.
  bucket(acc, "executed");
  acc.state[`admission_${call}`] = admit(call).admission;
  acc.metrics.first_paint_calls = (acc.output.executed as unknown[]).length;
}

function doSlots(line: Line, acc: Acc): void {
  const limit = num(line.f, "limit", 8);
  const during = laneSlots(limit, false);
  const after = laneSlots(limit, true);
  bucket(acc, "lane_slots").push(`enrichment=${during.enrichment}`, `understanding=${during.understanding}`);
  acc.state.lane_e_slots_first_paint = during.enrichment;
  acc.state.lane_e_slots_after = after.enrichment;
}

function doPrewarm(line: Line, acc: Acc): void {
  const record = prewarm(num(line.f, "spawn_ms", 0), num(line.f, "ready_ms", 1_400), num(line.f, "clock_ms", 1_500));
  bucket(acc, "prewarm").push(record.paidBeforeClock ? "paid_before_clock" : "paid_on_clock");
  acc.state.prewarm_saved_seconds = record.savedSeconds;
}

// ---- cohorts and sizing ----------------------------------------------------

function doBudget(line: Line, acc: Acc): void {
  const seq = num(line.f, "seq", 0);
  const b = cohortBudget(seq);
  bucket(acc, "budget").push({ seq, sessions: b.sessions, tokens: b.tokens, output_tokens: b.outputTokens });
}

function doSize(line: Line, acc: Acc): void {
  const label = line.f.label ?? "fill";
  const n = num(line.f, "n", 4);
  const events = num(line.f, "events", 8);
  const chars = num(line.f, "chars", 55);
  const seq = num(line.f, "seq", 0);
  const sessions: SessionSize[] = Array.from({ length: n }, (_, i) => ({
    id: `${label}-${i}`,
    eventCount: events,
    charCount: events * chars,
  }));
  const budget = cohortBudget(seq);
  const fill = fillCohort(sessions, budget);
  acc.state[label] = fill.taken.length;
  acc.state.sized_by = "output_tokens";
  acc.state.output_budget = budget.outputTokens;
  acc.state.closed_by = fill.closedBy;
  bucket(acc, "fills").push({ label, taken: fill.taken.length, closed_by: fill.closedBy });
}

// ---- steady state ----------------------------------------------------------

function doLive(line: Line, acc: Acc): void {
  const decision = liveTrigger({
    mode: (line.f.mode ?? "steady") as "bootstrap" | "steady" | "reprocess",
    liveIntervalMs: num(line.f, "interval_ms", 30_000),
    quietMs: num(line.f, "quiet_ms", 0),
    newEvents: num(line.f, "new_events", 0),
    passesThisHour: num(line.f, "passes", 0),
    eventsInLastTenMinutes: num(line.f, "activity", 0),
  });
  if (decision.fires) bucket(acc, "live_passes").push(decision.reason);
  bucket(acc, "live_passes");
  if (decision.backpressureLabel) bucket(acc, "backpressure").push(decision.backpressureLabel);
  acc.state.effective_interval_ms = decision.intervalMs;
  acc.state.trigger_reason = decision.reason;

  // Gate `sched_steady_visibility`: seconds OVER live_interval, not the
  // absolute latency. A pass fires at the interval and the claim renders within
  // the streamed first line — the excess is what must stay under 15 s.
  const configured = num(line.f, "interval_ms", 30_000) / 1000;
  const renderS = num(line.f, "render_s", 3);
  acc.metrics.steady_visibility_over_interval_s = round1(decision.intervalMs / 1000 - configured + renderS);
}

function doLiveHour(line: Line, acc: Acc): void {
  const intervalMs = num(line.f, "interval_ms", 30_000);
  const ticks = num(line.f, "ticks", 120);
  let passes = 0;
  for (let i = 0; i < ticks; i += 1) {
    const decision = liveTrigger({
      mode: "steady",
      liveIntervalMs: intervalMs,
      quietMs: intervalMs,
      newEvents: 0,
      passesThisHour: passes,
      eventsInLastTenMinutes: num(line.f, "activity", 0),
    });
    if (decision.fires) passes += 1;
  }
  acc.state.live_passes_in_hour = passes;
  acc.metrics.live_passes_per_hour = passes;
  acc.metrics.value = passes;
}

function doDelta(line: Line, acc: Acc): void {
  const messages = num(line.f, "messages", 40);
  const delta = deltaPassCost(messages);
  const whole = wholeSessionPassCost(messages);
  const deltaRatio = deltaPassCost(messages * 2).inputTokens / delta.inputTokens;
  const wholeRatio = wholeSessionPassCost(messages * 2).inputTokens / whole.inputTokens;
  // Anything above ~2x on a doubled session is super-linear growth.
  if (deltaRatio > 2.1) bucket(acc, "quadratic_growth").push(`delta ${round1(deltaRatio)}x`);
  bucket(acc, "quadratic_growth");
  acc.state.delta_tokens = delta.inputTokens;
  acc.state.whole_session_tokens = whole.inputTokens;
  acc.state.growth = delta.growth;
  acc.state.delta_doubling_ratio = round1(deltaRatio);
  acc.state.whole_doubling_ratio = round1(wholeRatio);
}

function doSealHash(line: Line, acc: Acc): void {
  const last = line.f.last === "none" ? null : (line.f.last ?? null);
  const decision = consolidationAtSeal({ contentHash: line.f.hash ?? "h1", lastConsolidatedHash: last });
  if (decision.runs) bucket(acc, "consolidations").push(decision.reason);
  bucket(acc, "consolidations");
  acc.state.consolidation_reason = decision.reason;
}

// ---- stalls and pauses -----------------------------------------------------

function doIdle(line: Line, acc: Acc): void {
  const start = num(line.f, "start_ms", 0);
  const tracker = new IdleTracker(start);
  for (const beat of (line.f.beats ?? "").split(",").filter((s) => s.trim() !== "")) {
    tracker.beat(Number(beat));
  }
  for (const window of (line.f.pause ?? "").split(",").filter((s) => s.trim() !== "")) {
    const [from, to] = window.split("-").map(Number);
    tracker.pause({ fromMs: from!, toMs: to!, reason: "quota" });
  }
  const report = tracker.report(num(line.f, "now_ms", 0));
  acc.metrics.max_idle_gap_s = report.maxIdleGapSeconds;
  acc.state.paused_seconds = report.pausedSeconds;
}

function doPause(line: Line, acc: Acc): void {
  const state = pauseState(
    { fromMs: num(line.f, "from_ms", 0), toMs: num(line.f, "to_ms", 252_000), reason: "quota" },
    num(line.f, "now_ms", 0),
  );
  acc.state.paused = state.paused;
  acc.state.countdown = state.label;
  acc.state.retry_budget_spent = state.retryBudgetSpent;
  if (state.retryBudgetSpent) bucket(acc, "retry_budget_spent").push("spent");
  bucket(acc, "retry_budget_spent");
}

// ---- media (§9.6) ----------------------------------------------------------

function doEpisode(line: Line, acc: Acc): void {
  const plan = episodePassPlan({
    hasMedia: flag(line.f, "media", true),
    pendingEnrichment: num(line.f, "pending", 0),
    reprocessCount: num(line.f, "reprocess", 0),
    lateArrivals: num(line.f, "late", 0),
  });
  bucket(acc, "passes").push(plan.passes);
  acc.state.flagged_for_reconcile = plan.flaggedForReconcile;
  acc.metrics.passes_per_episode = plan.passes;
  // §9.6 rule 6: bounded at reprocess_max. The bound is on the PASS count; the
  // enrichment itself is always stored, searchable and attached.
  acc.metrics.reprocess_count = plan.passes;
  acc.metrics.value = plan.passes;
}

function doMediaOrder(line: Line, acc: Acc): void {
  const order = (line.f.ids ?? "")
    .split(",")
    .filter((s) => s.trim() !== "")
    .map((pair) => {
      const [id, priority] = pair.split(":");
      return { id: id!, priority: Number(priority) };
    });
  for (const inversion of mediaOrderInversions(order)) {
    bucket(acc, "media_inversions").push(`${inversion.before}<${inversion.after}`);
  }
  bucket(acc, "media_inversions");
  acc.state.media_order = order.map((o) => o.id);
}

function doLateMedia(line: Line, acc: Acc, world: World): void {
  const streamId = world.stream("alice", "T1");
  const sessionId = world.session(streamId, 2 * HOUR, 4, 60, line.f.session ?? "s1");
  setPendingEnrichmentCount(sessionId, num(line.f, "pending", 1));
  const eventId = world.lastEventOf(sessionId);
  const resolution = resolveEnrichment(eventId, { text: "the transcript says the villa is booked", now: NOW });
  bucket(acc, "reprocess_target").push(resolution.sessionId ?? "none");
  acc.state.completion_enqueued = resolution.completionEnqueued;
  acc.state.pending_after = resolution.pending;
}

// ---- coverage (§9.7 rule 3) ------------------------------------------------

function doCoverage(line: Line, acc: Acc, world: World): void {
  const streamId = world.stream("alice", "T1");
  for (let i = 0; i < num(line.f, "sessions", 4); i += 1) world.session(streamId, (i + 1) * HOUR, 8, 55);
  const cohort = sealCohort({
    mode: "bootstrap",
    horizon: "h24",
    seq: 0,
    now: NOW,
    sourceId: SOURCE,
    candidates: candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW }),
  });

  const seen: number[] = [];
  for (const state of ["enriching", "ready", "understanding", "done"] as const) {
    const result = advanceCohort(cohort.id, state);
    seen.push(result.coverage[0]?.fraction ?? 0);
  }
  // The stale transition §9.7 rule 3 forbids acting on: it must not move the
  // meter, and it must be refused rather than silently applied.
  const stale = advanceCohort(cohort.id, "enriching");
  seen.push(readCoverage("global", "all")[0]?.fraction ?? 0);

  for (let i = 1; i < seen.length; i += 1) {
    if (seen[i]! < seen[i - 1]!) bucket(acc, "coverage_regressions").push(`${seen[i - 1]} -> ${seen[i]}`);
  }
  bucket(acc, "coverage_regressions");
  acc.state.coverage_steps = seen.map((f) => Math.round(f * 100) / 100);
  acc.state.stale_transition_refused = stale.refused;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
