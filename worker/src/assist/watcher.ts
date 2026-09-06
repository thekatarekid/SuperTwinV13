// ===========================================================================
// The assist watcher — build P2.2, spec §10.2. Activity trigger + the lane's
// production loop.
//
// Watcher input = THE EVENT-LOG TAIL, not a separate capture: the same AX
// snapshots, browser visits and chat messages every other lane reads, from a
// persisted cursor forward ("one capture, two readers"). Each tick:
//
//   1. read new LIVE events past the cursor (screen switches, new messages,
//      visits — the "activity trigger" IS new tail rows),
//   2. feed each into the per-topic novelty accumulator (gate.ts),
//   3. for every topic that clears the CODE gate: one traced haiku evaluator
//      call; below either confidence threshold -> nothing,
//   4. actionable -> executor-lite (bounded, risk-free tool table) ->
//      durable artifact + nudge mark + per-context cooldown.
//
// Everything is dependency-injected (clock, evaluator deps, fetch) so the
// unit tests drive whole ticks with a stubbed provider and a mocked clock.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { readEnvelope, type EventEnvelope } from "../db/eventlog.js";
import type { JsonPassDeps } from "../brain/llm.js";
import {
  contentKeyFor,
  createArtifact,
  expireMomentBound,
  getArtifact,
  markNudged,
  type ArtifactRow,
} from "./artifacts.js";
import { isActionable, runAssistEvaluator, type AssistEvaluation } from "./evaluator.js";
import {
  gateVerdict,
  noteNudged,
  recordEvent,
  readTopic,
  spendAccumulator,
  type TopicState,
} from "./gate.js";
import { runExecutorLite } from "../executor/lite.js";
import { getAssistEnabled, isCapturePaused } from "./settings.js";

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export function readAssistCursor(): number {
  const r = getDb().prepare(`SELECT last_rowid FROM assist_cursor WHERE id = 1`).get() as
    | { last_rowid: number }
    | undefined;
  return r ? Number(r.last_rowid) : 0;
}

export function writeAssistCursor(rowid: number, nowMs: number = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO assist_cursor (id, last_rowid, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_rowid = excluded.last_rowid, updated_at = excluded.updated_at`,
    )
    .run(rowid, new Date(nowMs).toISOString());
}

// ---------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------

export interface AssistTickDeps {
  /** Passed through to the evaluator + graduation calls (tests stub provider). */
  llm?: JsonPassDeps;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  log?: (line: string) => void;
  /** Tail batch cap per tick. */
  batchLimit?: number;
}

export interface AssistTickReport {
  eventsRead: number;
  topicsTouched: string[];
  gatesPassed: string[];
  evaluations: { topicKey: string; actionable: boolean }[];
  artifacts: ArtifactRow[];
  nudged: string[];
  expired: number;
}

/**
 * One full assist pass over the fresh tail. Idempotent per cursor position;
 * safe to call from a timer or (in tests) directly with a mocked clock.
 */
export async function assistTick(deps: AssistTickDeps = {}): Promise<AssistTickReport> {
  const nowMs = deps.nowMs ?? Date.now();
  const log = deps.log ?? (() => {});
  const report: AssistTickReport = {
    eventsRead: 0,
    topicsTouched: [],
    gatesPassed: [],
    evaluations: [],
    artifacts: [],
    nudged: [],
    expired: expireMomentBound(nowMs),
  };
  if (!getAssistEnabled() || isCapturePaused(nowMs)) return report;

  // ---- 1. the tail: live events past the cursor, oldest first.
  const cursor = readAssistCursor();
  const rows = getDb()
    .prepare(
      `SELECT rowid AS r, id FROM events
        WHERE rowid > ? AND origin = 'live'
        ORDER BY rowid ASC LIMIT ?`,
    )
    .all(cursor, Math.max(1, deps.batchLimit ?? 200)) as { r: number; id: string }[];
  if (rows.length > 0) writeAssistCursor(rows[rows.length - 1]!.r, nowMs);

  // ---- 2. accumulate novelty per topic.
  const touched = new Set<string>();
  for (const row of rows) {
    const env = readEnvelope(row.id);
    if (!env) continue;
    report.eventsRead += 1;
    const outcome = recordEvent(env, { nowMs });
    touched.add(outcome.topicKey);
  }
  report.topicsTouched = [...touched];

  // ---- 3. gate -> evaluator -> executor-lite, per touched topic.
  for (const topicKey of touched) {
    const state = readTopic(topicKey);
    if (!state) continue;
    if (!gateVerdict(state, { nowMs }).ready) continue;
    report.gatesPassed.push(topicKey);

    // S0.10 (T0-14): every exit path below spends the accumulator. The evidence
    // reached the evaluator once; it must not keep the topic "ready" so that the
    // next single event re-buys the same model call, tick after tick.
    const evaluation = await runAssistEvaluator(state, deps.llm ?? {}, { nowMs });
    if (evaluation.status !== "ok" && evaluation.status !== "repaired") {
      log(`[assist] evaluator ${evaluation.status} for ${topicKey}`);
      spendAccumulator(topicKey, { nowMs });
      continue;
    }
    const ev = evaluation.output!;
    const actionable = isActionable(ev);
    report.evaluations.push({ topicKey, actionable });
    if (!actionable) {
      spendAccumulator(topicKey, { nowMs });
      continue;
    }

    const artifact = await prepare(state, ev, evaluation.runIds[0] ?? null, deps, nowMs);
    if (artifact) {
      report.artifacts.push(artifact.row);
      if (artifact.nudged) report.nudged.push(artifact.row.id);
    }
    // Nudged: noteNudged() already spent it (plus cooldown). Duplicate content
    // (or no artifact at all): spend it here so it cannot re-fire on the same
    // evidence.
    if (!artifact?.nudged) spendAccumulator(topicKey, { nowMs });
  }
  return report;
}

/** Executor-lite + artifact row + nudge mark for one actionable evaluation. */
async function prepare(
  state: TopicState,
  ev: AssistEvaluation,
  runId: string | null,
  deps: AssistTickDeps,
  nowMs: number,
): Promise<{ row: ArtifactRow; nudged: boolean } | null> {
  const executed = await runExecutorLite(state, ev, { fetchImpl: deps.fetchImpl, nowMs });
  const envs = state.eventIds
    .map((id) => readEnvelope(id))
    .filter((e): e is EventEnvelope => e != null);
  const contentKey = contentKeyFor({
    topicKey: state.topicKey,
    intent: ev.intent,
    action: ev.action,
    eventHashes: envs.map((e) => e.contentHash ?? e.id ?? ""),
  });
  // A space link only when the id is REAL — a model's space_hint is a hint,
  // never a foreign key.
  const candidate = state.topicKey.startsWith("space:")
    ? state.topicKey.slice("space:".length)
    : ev.space_hint;
  const spaceId =
    candidate &&
    getDb().prepare(`SELECT 1 FROM spaces WHERE id = ?`).get(candidate) !== undefined
      ? candidate
      : null;
  const { artifact, created } = createArtifact({
    kind: ev.artifact_type ?? "brief",
    title: ev.intent || "Prepared for you",
    summary: ev.action,
    body: executed.body,
    intent: ev.intent,
    reasoning: ev.reasoning,
    spaceId,
    topicKey: state.topicKey,
    contentKey,
    producer: "assist",
    runId,
    nowMs,
  });
  if (!created) {
    // Identical re-captured content: the standing artifact answers; NO nudge.
    return { row: artifact, nudged: false };
  }
  markNudged(artifact.id, nowMs);
  noteNudged(state.topicKey, { nowMs });
  return { row: getArtifact(artifact.id) ?? artifact, nudged: true };
}

// ---------------------------------------------------------------------------
// The production loop (worker/src/index.ts calls this)
// ---------------------------------------------------------------------------

export interface AssistLaneHandle {
  stop(): void;
  /** Test/ops hook: run one tick immediately. */
  tick(deps?: AssistTickDeps): Promise<AssistTickReport>;
}

export const ASSIST_TICK_INTERVAL_MS = 20_000;

/** Start the assist lane: one tick every ASSIST_TICK_INTERVAL_MS, fenced. */
export function startAssistLane(opts: { log?: (line: string) => void } = {}): AssistLaneHandle {
  const log = opts.log ?? (() => {});
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    assistTick({ log })
      .then((r) => {
        if (r.nudged.length > 0) log(`[assist] nudged ${r.nudged.join(", ")}`);
      })
      .catch((err) => log(`[assist] tick failed: ${String(err)}`))
      .finally(() => {
        running = false;
      });
  }, ASSIST_TICK_INTERVAL_MS);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    tick: (deps?: AssistTickDeps) => assistTick({ log, ...(deps ?? {}) }),
  };
}
