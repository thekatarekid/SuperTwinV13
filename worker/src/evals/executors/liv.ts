// ===========================================================================
// [CODE] LIV — the live-call executor (GoldenEvals V6 P1 §5.11 LIV-01..06;
// Build S4.1). Deterministic, zero model calls.
//
// Each case seeds one world (spaces, open tasks, an open episode with thread
// history already dispatched, the bundle's new events on per-case stream
// keys), then drives the REAL production path — brain/consumer runBrainTick
// → packer → live.v1 (brain/live.ts) → Critic → commit → applyLiveDecide —
// with a stub provider that answers the live call with the fixture's
// recorded live.v1 output and the critic call with silence ({"verdicts":[]}).
// The clock is pinned to the fixture's [NOW]. The database is read back and
// graded by code:
//
//   LIV-01  the villa sentence — needs_you · today · 17:00+05:30 · e1 · t_88;
//           the episode joins sp_goa_dec
//   LIV-02  history never nudges (hard) — the same sentence in a history
//           bundle: episode commits, zero prepared rows (assist_from_history 0)
//   LIV-03  grounding is this flush (hard) — a prepared action grounded only
//           in old context is dropped (nudge_without_grounding 0)
//   LIV-04  bad decide JSON — understanding commits, decide logged + dropped,
//           no repair round spent on it
//   LIV-05  bad understanding JSON — items quarantined per item, the good one
//           commits, the valid decide still runs
//   LIV-06  intent floor — 0.55 against 0.7: prepared and shelved, no card
//   LIV-07  no starvation (= GATE-09, re-homed onto the live PASS in S4.4) —
//           200 history day-bundles queued and every background slot held,
//           and the villa flush still completes on the pool's reserved live
//           lane, BOTH of its §7.3 calls, with the nudge at the end of it
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { appendEvents, type EventEnvelope } from "../../db/eventlog.js";
import { ResourcePool, type LlmLane } from "../../providers/pool.js";
import { addEpisodeEvents, episodeMemberIds } from "../../db/v6core.js";
import { runBrainTick, type TickReport } from "../../brain/consumer.js";
import { listPreparedActions, PREPARED_ACTION_KIND, type PreparedActionRow } from "../../brain/live.js";
import type { JsonPassDeps } from "../../brain/llm.js";
import type { Provider, Usage } from "../../providers/types.js";
import type { BundleEvent, DeltaBundle } from "../../scheduler/v6/bundle.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

const USAGE: Usage = { inputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 };
/** Sat 2026-09-05 16:10 IST — the P-01 / LIV-01 [NOW]. */
export const LIV_NOW_ISO = "2026-09-05T10:40:00.000Z";

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, fallback: string | null = null): string | null {
  return typeof v === "string" && v !== "" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}

/**
 * The stub provider. Every call of a tick is told apart by its user block, so
 * the same canned answer serves the merged live.v1 call and both calls of the
 * Build §7.3 two-call fallback:
 *
 *   critic          carries a "[DECISIONS]" block the pack never has
 *   decide (call 2) carries the "[UNDERSTANDING]" block only live-decide.v1
 *                   is sent (S4.4)
 *   live            everything else — the merged call, or the fallback's
 *                   understanding call
 *
 * `calls.live` therefore means the same thing in both modes (how many times
 * the understanding half was asked), which is what LIV-01 and LIV-04 assert.
 */
export function stubProvider(
  liveAnswer: string,
): Provider & { calls: { live: number; critic: number; decide: number } } {
  const p = {
    id: "eval-live-stub",
    calls: { live: 0, critic: 0, decide: 0 },
    cancel: () => false,
    async send(opts: Parameters<Provider["send"]>[0]) {
      const critic = opts.message.includes("\n[DECISIONS]\n");
      const decide = !critic && opts.message.includes("\n[UNDERSTANDING]\n");
      if (critic) p.calls.critic += 1;
      else if (decide) p.calls.decide += 1;
      else p.calls.live += 1;
      opts.onEvent({ type: "delta", text: critic ? '{"verdicts":[]}' : liveAnswer });
      opts.onEvent({ type: "done", sessionId: "eval", usage: USAGE });
      return { sessionId: "eval", usage: USAGE, freshFallback: false, status: "ok" as const };
    },
  };
  return p;
}

export interface LivSeeded {
  spaceIds: string[];
  taskIds: string[];
  episodeIds: string[];
  eventIds: string[];
  streamIds: string[];
  /** fixture alias (e1.., h1..) → event id */
  alias: Map<string, string>;
  bundle: DeltaBundle;
}

interface EventRow {
  rowid: number;
  id: string;
  source_id: string | null;
  stream_id: string | null;
  stream_key: string;
  ts: string | null;
  kind: string | null;
  text: string | null;
  actor: string | null;
  origin: string;
  age_band: string | null;
  roles_json: string | null;
  payload_json: string | null;
}

/** Seed the fixture's world and build the bundle over its new events. */
export function seedLiv(id: string, setup: Record<string, unknown>, nowMs: number): LivSeeded {
  const db = getDb();
  const lane: DeltaBundle["lane"] = str(setup.lane) === "history" ? "history" : "live";
  // Per-stream shape. A fixture that says nothing keeps the WhatsApp default
  // every LIV case was written against; `setup.streams` lets a cross-source
  // case (CROSS-N50) put a tag on a browser or screen chain key instead, so
  // the packer's S1..Sn sections and the commit path's one-stream-per-episode
  // rule see the real S3.4 key shapes.
  const streamSpec = new Map<string, { key: string; source: string; kind: string }>();
  for (const st of list(setup.streams)) {
    const tag = (str(st.tag) ?? "S1").toUpperCase();
    streamSpec.set(tag, {
      key: str(st.key) ?? `liv-${id.toLowerCase()}-${tag.toLowerCase()}@g.us`,
      source: str(st.source) ?? "wa",
      kind: str(st.kind) ?? "wa.message",
    });
  }
  const specOf = (tag: string): { key: string; source: string; kind: string } =>
    streamSpec.get(tag.toUpperCase()) ?? {
      key: `liv-${id.toLowerCase()}-${tag.toLowerCase()}@g.us`,
      source: "wa",
      kind: "wa.message",
    };

  const spaceIds: string[] = [];
  for (const sp of list(setup.spaces)) {
    const spaceId = str(sp.id) ?? `sp_${id.toLowerCase()}`;
    db.prepare(
      `INSERT INTO spaces (id, label, goal, status, plan_json, summary, latest, created_by, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 'eval', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(spaceId, str(sp.label) ?? `eval ${id}`, str(sp.goal), str(sp.status) ?? "active", str(sp.summary), str(sp.latest));
    spaceIds.push(spaceId);
  }
  const taskIds: string[] = [];
  for (const t of list(setup.tasks)) {
    const taskId = str(t.id) ?? `tsk_${id}_${taskIds.length + 1}`;
    db.prepare(
      `INSERT INTO tasks (id, space_id, title, type, category, risk_class, owner, due, status, evidence_json, created_by, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'eval', ?)`,
    ).run(
      taskId,
      str(t.space) ?? spaceIds[0] ?? null,
      str(t.title) ?? "task",
      str(t.type) ?? "explicit",
      str(t.category),
      str(t.risk_class) ?? "advise-only",
      str(t.owner) ?? "self",
      str(t.due),
      str(t.status) ?? "open",
      num(t.confidence, 0.9),
    );
    taskIds.push(taskId);
  }

  // History rows first (already dispatched), then the bundle's new events.
  const toEnvelope = (e: Record<string, unknown>, i: number, origin: EventEnvelope["origin"]): EventEnvelope => {
    const spec = specOf(str(e.stream) ?? "S1");
    return {
      ts: new Date(nowMs - Math.round(num(e.minutes_ago, 60 - i) * 60_000)).toISOString(),
      source: str(e.source) ?? spec.source,
      kind: str(e.kind) ?? spec.kind,
      origin,
      streamKey: spec.key,
      actor: str(e.actor) ?? "self",
      roles: { sender: str(e.actor) ?? "self", audience: ["self"], receiver: ["self"], mentions: [] },
      payload: { text: str(e.text) ?? `event ${i + 1}`, external_id: `${id}:${str(e.alias) ?? i}` },
    };
  };
  const alias = new Map<string, string>();
  const eventIds: string[] = [];
  const history = list(setup.history);
  const appendedHistory = history.length > 0 ? appendEvents(history.map((e, i) => toEnvelope(e, i, "backfill")), nowMs) : { ids: [] as string[] };
  appendedHistory.ids.forEach((eid, i) => {
    if (eid === "") return;
    alias.set(str(history[i]?.alias) ?? `h${i + 1}`, eid);
    eventIds.push(eid);
    db.prepare(`UPDATE events SET dispatched_at = ? WHERE id = ?`).run(new Date(nowMs - 60_000).toISOString(), eid);
  });
  const episodeIds: string[] = [];
  for (const ep of list(setup.episodes)) {
    const epId = str(ep.id) ?? `ep_${id}_${episodeIds.length + 1}`;
    const members = history
      .filter((h) => str(h.episode) === epId)
      .map((h) => alias.get(str(h.alias) ?? ""))
      .filter((x): x is string => typeof x === "string");
    const streamRow = members.length > 0
      ? (db.prepare(`SELECT stream_id, ts FROM events WHERE id = ?`).get(members[0]) as { stream_id: string | null; ts: string | null })
      : { stream_id: null, ts: null };
    db.prepare(
      `INSERT INTO episodes (id, stream_id, space_id, state, summary, confidence, first_ts, last_ts, created_by)
       VALUES (?, ?, ?, 'open', ?, 0.9, ?, ?, 'eval')`,
    ).run(epId, streamRow.stream_id, str(ep.space), str(ep.summary) ?? "", streamRow.ts, streamRow.ts);
    if (members.length > 0) addEpisodeEvents(epId, members, "eval");
    episodeIds.push(epId);
  }

  const events = list(setup.events);
  const appended = appendEvents(events.map((e, i) => toEnvelope(e, i, lane === "live" ? "live" : "backfill")), nowMs);
  const newIds: string[] = [];
  appended.ids.forEach((eid, i) => {
    if (eid === "") return;
    alias.set(str(events[i]?.alias) ?? `e${i + 1}`, eid);
    eventIds.push(eid);
    newIds.push(eid);
  });
  if (newIds.length === 0) throw new Error(`${id}: no bundle events seeded`);
  const rows = db
    .prepare(
      `SELECT rowid AS rowid, id, source_id, stream_id, stream_key, ts, kind, text, actor, origin, age_band, roles_json, payload_json
         FROM events WHERE id IN (${newIds.map(() => "?").join(",")}) ORDER BY rowid`,
    )
    .all(...newIds) as EventRow[];
  const bundleEvents: BundleEvent[] = rows.map((r) => ({
    rowid: r.rowid,
    id: r.id,
    sourceId: r.source_id,
    streamId: r.stream_id,
    ts: r.ts,
    kind: r.kind,
    text: r.text,
    actor: r.actor,
    origin: (r.origin === "backfill" ? "backfill" : "live") as BundleEvent["origin"],
    ageBand: (r.age_band ?? "A") as BundleEvent["ageBand"],
    rolesJson: r.roles_json,
    payloadJson: r.payload_json,
  }));
  const lead = rows[0]!;
  const bundle: DeltaBundle = {
    streamId: lead.stream_id ?? lead.stream_key,
    streamKey: lead.stream_key,
    lane,
    ageBand: "A",
    events: bundleEvents,
    part: 1,
    partCount: 1,
    ...(lane === "live" ? { trigger: "hot" as const } : {}),
  };
  const streamIds = (
    db
      .prepare(`SELECT DISTINCT stream_id AS id FROM events WHERE stream_id IS NOT NULL AND id IN (${eventIds.map(() => "?").join(",")})`)
      .all(...eventIds) as { id: string }[]
  ).map((r) => r.id);
  return { spaceIds, taskIds, episodeIds, eventIds, streamIds, alias, bundle };
}

/** Remove the case's rows so the harness DB is clean for the next case. */
export function cleanupLiv(
  s: LivSeeded,
  extraEpisodeIds: readonly string[] = [],
  extraEventIds: readonly string[] = [],
): void {
  const db = getDb();
  const epIds = [...new Set([...s.episodeIds, ...extraEpisodeIds])];
  db.transaction(() => {
    if (epIds.length > 0) {
      const ph = epIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM second_look WHERE episode_id IN (${ph})`).run(...epIds);
      db.prepare(`DELETE FROM unsorted WHERE episode_id IN (${ph})`).run(...epIds);
      db.prepare(`DELETE FROM episode_events WHERE episode_id IN (${ph})`).run(...epIds);
      db.prepare(`DELETE FROM episodes WHERE id IN (${ph})`).run(...epIds);
    }
    for (const sp of s.spaceIds) {
      db.prepare(`DELETE FROM deferred_outputs WHERE space_id = ?`).run(sp);
      db.prepare(`DELETE FROM decide_queue WHERE space_id = ?`).run(sp);
      db.prepare(`DELETE FROM tasks WHERE space_id = ?`).run(sp);
      db.prepare(`DELETE FROM episodes WHERE space_id = ?`).run(sp);
      db.prepare(`DELETE FROM space_bridge_keys WHERE space_id = ?`).run(sp);
      db.prepare(`DELETE FROM spaces WHERE id = ?`).run(sp);
    }
    for (const sid of s.streamIds) {
      db.prepare(`DELETE FROM deferred_outputs WHERE kind = ? AND json_extract(payload_json, '$.bundleKey') LIKE ?`).run(PREPARED_ACTION_KIND, `${sid}:%`);
      db.prepare(`DELETE FROM bundle_attempts WHERE stream_id = ?`).run(sid);
    }
    const allEventIds = [...s.eventIds, ...extraEventIds];
    if (allEventIds.length > 0) {
      // Chunked: SQLite's variable limit is 999 and LIV-07 seeds 200+.
      for (let i = 0; i < allEventIds.length; i += 500) {
        const chunk = allEventIds.slice(i, i + 500);
        db.prepare(`DELETE FROM events WHERE id IN (${chunk.map(() => "?").join(",")})`).run(...chunk);
      }
    }
    if (extraEventIds.length > 0) {
      db.prepare(`DELETE FROM streams WHERE id NOT IN (SELECT DISTINCT stream_id FROM events WHERE stream_id IS NOT NULL) AND external_key LIKE ?`).run(
        `liv-%-h%@g.us`,
      );
    }
    for (const sid of s.streamIds) db.prepare(`DELETE FROM streams WHERE id = ?`).run(sid);
  })();
}

export interface LivRun {
  seeded: LivSeeded;
  report: TickReport;
  calls: { live: number; critic: number; decide: number };
  prepared: PreparedActionRow[];
  tasks: { id: string; title: string; status: string; space_id: string | null; schedule_json: string | null }[];
  episodes: { id: string; space_id: string | null; members: string[] }[];
  decisions: { action: string; target_id: string }[];
  /** deferred_outputs rows of kind closure_check for the seeded tasks. */
  closureChecks: number;
  /** Spaces queued for the per-space decide pass — where a closure check is decided. */
  queuedSpaces: string[];
  /** LIV-07 only: what the saturated pool looked like around the live tick. */
  starvation?: StarvationRun;
  /** Event ids seeded outside the bundle (LIV-07's history backlog). */
  extraEventIds?: string[];
}

/** LIV-07: the pool under load, and how the live tick fared inside it. */
export interface StarvationRun {
  historyBundles: number;
  /** Background calls holding a slot when the live flush started. */
  inFlightBefore: number;
  /** Background calls queued behind them when the live flush started. */
  waitingBefore: number;
  /** Wall-clock ms the whole live tick took, parked backlog and all. */
  elapsedMs: number;
  /** Parked background calls that finished before the live tick did. */
  historyCompletedDuringLive: number;
}

/**
 * LIV-07: queue `n` history day-bundles in the log (undispatched backfill rows
 * on their own streams), then hold every background slot the pool allows and
 * fill its waiter queue. Returns the backlog's event ids (for cleanup) and a
 * `release` the caller MUST call — the parked work stays parked until then,
 * which is the whole point: a live call that waited on it could never finish.
 */
function saturate(
  id: string,
  setup: Record<string, unknown>,
  nowMs: number,
): {
  pool: ResourcePool;
  eventIds: string[];
  historyBundles: number;
  release: () => void;
  done: () => number;
  settled: Promise<unknown>;
} {
  const historyBundles = Math.max(0, Math.floor(num(setup.history_bundles, 200)));
  const envs: EventEnvelope[] = [];
  for (let i = 0; i < historyBundles; i++) {
    envs.push({
      ts: new Date(Date.parse("2024-01-01T09:00:00.000Z") + i * 86_400_000).toISOString(),
      source: "wa",
      kind: "wa.message",
      origin: "backfill",
      streamKey: `liv-${id.toLowerCase()}-h${i}@g.us`,
      actor: "contact:someone",
      roles: { sender: "contact:someone", audience: ["self"], receiver: ["self"], mentions: [] },
      payload: { text: `history day ${i}`, external_id: `${id}:h${i}` },
    });
  }
  const eventIds = (envs.length > 0 ? appendEvents(envs, nowMs).ids : []).filter((x) => x !== "");

  const pool = new ResourcePool({ limits: { llm: Math.max(1, Math.floor(num(setup.llm, 4))) }, warmFirst: false });
  let release!: () => void;
  const parked = new Promise<void>((r) => (release = r));
  let done = 0;
  const lanes = (Array.isArray(setup.parked_lanes) ? setup.parked_lanes : ["understanding", "understanding", "enrichment"])
    .filter((l): l is LlmLane => l === "understanding" || l === "enrichment" || l === "live");
  const running: Promise<unknown>[] = [];
  const park = (lane: LlmLane): void => {
    running.push(
      pool
        .run("llm", () => parked, { lane })
        .then(() => {
          done += 1;
        })
        .catch(() => undefined),
    );
  };
  for (const lane of lanes) park(lane);
  for (let i = 0; i < Math.max(0, Math.floor(num(setup.queued_waiters, 12))); i++) park("understanding");
  return { pool, eventIds, historyBundles, release, done: () => done, settled: Promise.all(running) };
}

/** Seed, run the real tick with the stub provider, read back. */
export async function runLivCase(id: string, setup: unknown): Promise<LivRun> {
  const s = rec(setup);
  const nowMs = Date.parse(str(s.now) ?? LIV_NOW_ISO);
  const seeded = seedLiv(id, s, nowMs);
  const provider = stubProvider(JSON.stringify(s.live ?? {}));
  const load = s.history_bundles === undefined ? null : saturate(id, s, nowMs);
  const deps: JsonPassDeps = {
    provider,
    now: () => new Date(nowMs),
    // No ledger rows for a canned answer: the eval DB never counts this as a model call.
    recordRun: () => `eval-${id}`,
    logExtractionRun: () => undefined,
    quarantine: () => undefined,
    ...(load ? { pool: load.pool } : {}),
  };
  // Let the parked background work reach the pool before the flush arrives.
  if (load) for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  const inFlightBefore = load ? load.pool.inFlight("llm") : 0;
  const waitingBefore = load ? load.pool.waiting("llm") : 0;
  const startedAt = Date.now();
  const report = await runBrainTick(seeded.bundle, deps, { packOpts: { nowMs, thinPolicy: "off" } });
  const elapsedMs = Date.now() - startedAt;
  const historyCompletedDuringLive = load ? load.done() : 0;
  if (load) {
    load.release();
    await load.settled;
  }
  const db = getDb();
  const spaces = seeded.spaceIds;
  const ph = spaces.map(() => "?").join(",");
  const epRows = (
    spaces.length > 0
      ? (db.prepare(`SELECT id, space_id FROM episodes WHERE space_id IN (${ph}) OR stream_id IN (${seeded.streamIds.map(() => "?").join(",") || "''"}) ORDER BY rowid`).all(...spaces, ...seeded.streamIds) as { id: string; space_id: string | null }[])
      : []
  );
  const aliasOfId = new Map([...seeded.alias].map(([a, eid]) => [eid, a]));
  const prepared = listPreparedActions({ limit: 500 }).filter((p) => seeded.streamIds.some((sid) => p.payload.bundleKey.startsWith(`${sid}:`)));
  return {
    seeded,
    report,
    calls: provider.calls,
    prepared,
    tasks: spaces.length > 0
      ? (db.prepare(`SELECT id, title, status, space_id, schedule_json FROM tasks WHERE space_id IN (${ph}) ORDER BY created_at, rowid`).all(...spaces) as LivRun["tasks"])
      : [],
    episodes: epRows.map((e) => ({ id: e.id, space_id: e.space_id, members: episodeMemberIds(e.id).map((eid) => aliasOfId.get(eid) ?? eid) })),
    decisions: db
      .prepare(`SELECT action, target_id FROM decisions WHERE pass = 'live' AND (target_id LIKE ? OR target_id IN (SELECT id FROM deferred_outputs WHERE kind = ?)) ORDER BY rowid`)
      .all(`${seeded.bundle.streamId}:%`, PREPARED_ACTION_KIND) as LivRun["decisions"],
    closureChecks: spaces.length > 0
      ? (db.prepare(`SELECT COUNT(*) AS n FROM deferred_outputs WHERE kind = 'closure_check' AND space_id IN (${ph})`).get(...spaces) as { n: number }).n
      : 0,
    queuedSpaces: spaces.length > 0
      ? (db.prepare(`SELECT space_id FROM decide_queue WHERE space_id IN (${ph}) ORDER BY space_id`).all(...spaces) as { space_id: string }[]).map((r) => r.space_id)
      : [],
    ...(load
      ? {
          starvation: {
            historyBundles: load.historyBundles,
            inFlightBefore,
            waitingBefore,
            elapsedMs,
            historyCompletedDuringLive,
          },
          extraEventIds: load.eventIds,
        }
      : {}),
  };
}

const sameInstant = (a: string | null | undefined, b: string): boolean =>
  typeof a === "string" && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);

/** Per-case assertions; each returns the violations it found. */
function assertCase(id: string, run: LivRun, expected: Record<string, unknown>): Violation[] {
  const v: Violation[] = [];
  const first = run.prepared[0];
  switch (id) {
    case "LIV-01": {
      if (!first) {
        v.push({ label: "no-prepared", note: "no prepared action persisted" });
        break;
      }
      const p = first.payload;
      if (p.kind !== (str(expected.kind) ?? "needs_you")) v.push({ label: "no-prepared", note: `kind ${p.kind}` });
      if (p.urgency !== (str(expected.urgency) ?? "today")) v.push({ label: "deadline-misread", note: `urgency ${p.urgency}` });
      const wantDeadline = str(expected.deadline_at) ?? "2026-09-05T17:00:00+05:30";
      if (!sameInstant(p.deadline_at, wantDeadline)) v.push({ label: "deadline-misread", note: `deadline_at ${String(p.deadline_at)} ≠ ${wantDeadline}` });
      const e1 = run.seeded.alias.get("e1");
      if (!e1 || p.groundedEventIds.length !== 1 || p.groundedEventIds[0] !== e1) v.push({ label: "no-prepared", note: `grounded in ${p.groundedEventIds.join(",")}` });
      const task = str(expected.task) ?? "t_88";
      if (first.taskId !== task && p.inputs.task !== task) v.push({ label: "no-prepared", note: `does not reference ${task}` });
      if (p.surface !== "card") v.push({ label: "no-prepared", note: `surface ${p.surface}` });
      const ep = run.episodes.find((e) => e.id === (str(expected.episode) ?? "ep_611"));
      if (!ep || !ep.members.includes("e1")) v.push({ label: "no-prepared", note: "e1 did not join the open episode" });
      else if (ep.space_id !== (str(expected.space) ?? "sp_goa_dec")) v.push({ label: "no-prepared", note: `episode in ${ep.space_id}` });
      const t88 = run.tasks.find((t) => t.id === task);
      if (t88 && (t88.status === "done" || t88.status === "cancelled")) v.push({ label: "history-style-closure", note: `${task} closed as ${t88.status}` });
      // The decide half's non-prepared items apply too: the reminder landed on t_88.
      const wantFire = str(expected.schedule_fire_at);
      if (wantFire) {
        const fire = t88?.schedule_json ? (JSON.parse(t88.schedule_json) as { fire_at?: string }).fire_at : null;
        if (!sameInstant(fire, wantFire)) v.push({ label: "schedule-lost", note: `${task} fire_at ${String(fire)} ≠ ${wantFire}` });
      }
      break;
    }
    case "LIV-02": {
      if (run.prepared.length > 0) v.push({ label: "history-nudge", note: `${run.prepared.length} prepared row(s) from a history bundle` });
      if (run.report.live !== undefined) v.push({ label: "history-nudge", note: "the live decide half ran on a history bundle" });
      if (run.report.status !== "committed") v.push({ label: "episode-lost", note: `tick status ${run.report.status}` });
      // "Episode plus a closure check": on history the closure is decided by the
      // per-space decide pass, so the commit must queue the space for it.
      for (const spaceId of (Array.isArray(expected.decide_queued) ? expected.decide_queued : []).filter((s): s is string => typeof s === "string")) {
        if (!run.queuedSpaces.includes(spaceId)) v.push({ label: "episode-lost", note: `${spaceId} was not queued for the decide pass` });
      }
      break;
    }
    case "LIV-03": {
      if (run.prepared.length > 0) v.push({ label: "old-context-nudge", note: `${run.prepared.length} prepared row(s) grounded outside this flush` });
      if ((run.report.live?.prepared.droppedUngrounded ?? 0) < 1) v.push({ label: "old-context-nudge", note: "the ungrounded action was not counted as dropped" });
      break;
    }
    case "LIV-04": {
      if (run.report.status !== "committed") v.push({ label: "decide-blocked-commit", note: `tick status ${run.report.status}` });
      if (run.calls.live > 1 || run.calls.decide > 1) {
        v.push({
          label: "decide-blocked-commit",
          note: `${run.calls.live} understanding call(s) + ${run.calls.decide} decide call(s) — a repair round was spent on the decide section`,
        });
      }
      if (!run.report.live?.decide || run.report.live.decide.tasksCreated > 0 || run.prepared.length > 0) {
        v.push({ label: "decide-applied", note: `tasks ${run.report.live?.decide.tasksCreated ?? "?"}, prepared ${run.prepared.length}` });
      }
      if (!run.decisions.some((d) => d.action === "drop_decide")) v.push({ label: "decide-applied", note: "the dropped decide section left no decisions row" });
      break;
    }
    case "LIV-05": {
      const good = run.episodes.find((e) => e.members.includes("e2"));
      if (!good) v.push({ label: "good-items-lost", note: "the valid episode did not commit" });
      if (run.report.status !== "committed") v.push({ label: "good-items-lost", note: `tick status ${run.report.status}` });
      if ((run.report.live?.understandingRejected ?? 0) !== num(expected.rejected, 1)) v.push({ label: "good-items-lost", note: `rejected ${run.report.live?.understandingRejected ?? "?"}` });
      if (!run.decisions.some((d) => d.action === "quarantine_item")) v.push({ label: "good-items-lost", note: "no quarantine_item decision row" });
      if (run.prepared.length !== 1) v.push({ label: "decide-lost", note: `${run.prepared.length} prepared row(s), expected 1` });
      break;
    }
    case "LIV-06": {
      if (!first) v.push({ label: "card-shown", note: "nothing prepared — the work below the floor is shelved, not dropped" });
      else if (first.payload.surface !== "shelf") v.push({ label: "card-shown", note: `surface ${first.payload.surface} at intent_confidence ${first.payload.intent_confidence}` });
      if ((run.report.live?.prepared.cards ?? 0) > 0) v.push({ label: "card-shown", note: `${run.report.live?.prepared.cards} card(s)` });
      break;
    }
    case "LIV-07": {
      const st = run.starvation;
      if (!st) {
        v.push({ label: "live-behind-history", note: "the pool was never saturated — the case proves nothing" });
        break;
      }
      // The setup has to be real before the result means anything: background
      // work must actually hold slots AND have a queue behind it.
      if (st.inFlightBefore <= 0) v.push({ label: "live-behind-history", note: "no background call held a slot when the flush arrived" });
      if (st.waitingBefore <= 0) v.push({ label: "live-behind-history", note: "nothing was queued behind the background work" });
      const wantBundles = num(expected.history_bundles, 200);
      if (st.historyBundles < wantBundles) v.push({ label: "live-behind-history", note: `${st.historyBundles} history bundles queued, expected ${wantBundles}` });
      // The assertion itself (GATE-09): the flush completed, and it completed
      // without any parked history call being released first.
      const budgetMs = num(expected.live_call_completes_within_s, 30) * 1000;
      if (st.elapsedMs >= budgetMs) v.push({ label: "live-behind-history", note: `the live tick took ${st.elapsedMs} ms, budget ${budgetMs} ms` });
      if (st.historyCompletedDuringLive > 0) {
        v.push({ label: "live-behind-history", note: `${st.historyCompletedDuringLive} parked history call(s) completed first` });
      }
      if (run.report.status !== "committed") v.push({ label: "live-behind-history", note: `tick status ${run.report.status}` });
      // …and the flush produced the thing a live flush is for.
      const wantCalls = rec(expected.calls);
      if (run.calls.live !== num(wantCalls.understanding, 1) || run.calls.decide !== num(wantCalls.decide, 1)) {
        v.push({
          label: "nudge-starved",
          note: `${run.calls.live} understanding + ${run.calls.decide} decide call(s) — the §7.3 fallback spends one of each`,
        });
      }
      if (run.prepared.length !== num(expected.prepared, 1)) {
        v.push({ label: "nudge-starved", note: `${run.prepared.length} prepared action(s), expected ${num(expected.prepared, 1)}` });
      }
      const ep = run.episodes.find((e) => e.id === (str(expected.episode) ?? "ep_611"));
      if (!ep || !ep.members.includes("e1")) v.push({ label: "nudge-starved", note: "e1 did not join the open episode" });
      break;
    }
    default:
      v.push({ label: "unknown-case", note: `no LIV assertions for ${id}` });
  }
  return v;
}

export const liveExecutor: Executor = async ({ fixture }) => {
  const setup = rec(fixture.setup);
  const run = await runLivCase(fixture.id, setup);
  try {
    const violations = assertCase(fixture.id, run, rec(fixture.expected));
    const historyLane = run.seeded.bundle.lane !== "live";
    const result: ExecutorResult = {
      ok: violations.length === 0,
      output: {
        tick: { status: run.report.status, lane: run.seeded.bundle.lane },
        live: run.report.live ?? null,
        prepared: run.prepared.map((p) => ({
          id: p.id,
          kind: p.payload.kind,
          action: p.payload.action,
          intent: p.payload.intent,
          intent_confidence: p.payload.intent_confidence,
          urgency: p.payload.urgency,
          deadline_at: p.payload.deadline_at,
          surface: p.payload.surface,
          grounded: p.payload.groundedEventIds.map((eid) => [...run.seeded.alias].find(([, id]) => id === eid)?.[0] ?? eid),
          task: p.taskId,
          space: p.spaceId,
        })),
        tasks: run.tasks,
        episodes: run.episodes,
        decisions: run.decisions.map((d) => d.action),
        closure_checks: run.closureChecks,
        decide_queued: run.queuedSpaces,
        ...(run.starvation ? { starvation: run.starvation } : {}),
      },
      violations,
      metrics: {
        model_calls: 0,
        canned_live_answers: run.calls.live,
        canned_decide_answers: run.calls.decide,
        canned_critic_answers: run.calls.critic,
        prepared_persisted: run.prepared.length,
        prepared_cards: run.report.live?.prepared.cards ?? 0,
        prepared_shelved: run.report.live?.prepared.shelved ?? 0,
        prepared_dropped_ungrounded: run.report.live?.prepared.droppedUngrounded ?? 0,
        understanding_rejected: run.report.live?.understandingRejected ?? 0,
        assist_from_history: historyLane ? run.prepared.length : 0,
        nudge_without_grounding: run.prepared.filter((p) => p.payload.groundedEventIds.length === 0).length,
      },
      gateObservations: [
        { gateId: "assist_from_history", passed: !historyLane || run.prepared.length === 0, counted: true },
        { gateId: "nudge_without_grounding", passed: run.prepared.every((p) => p.payload.groundedEventIds.length > 0), counted: true },
      ],
      notes: [
        `recorded live output through the real tick (pack → ${run.calls.decide > 0 ? "orient + live-decide.v1 (§7.3 two-call)" : "live.v1"} → critic → commit → applyLiveDecide); clock pinned to the fixture's [NOW]; critic answered {"verdicts":[]}`,
        ...(run.starvation
          ? [`pool saturated: ${run.starvation.inFlightBefore} in flight, ${run.starvation.waitingBefore} queued, ${run.starvation.historyBundles} history bundles pending; live tick ${run.starvation.elapsedMs} ms`]
          : []),
      ],
    };
    return result;
  } finally {
    cleanupLiv(run.seeded, run.report.commit?.committedEpisodes.map((e) => e.episodeId) ?? [], run.extraEventIds ?? []);
  }
};
