// ===========================================================================
// [CODE] BND — the bundling executor (GoldenEvals V6 P1 §5.5; V6 P1 S3.3).
//
// Deterministic, zero model calls, against the REAL scheduler/v6 code:
//
//   BND-01 one history call per day, sectioned        history.ts planHistory
//   BND-02 split at the largest gap                   history.ts
//   BND-03 newest day first, empty days skipped       history.ts
//   BND-04 cold idle flush                            cold.ts ColdWindow
//   BND-05 cold max                                   cold.ts
//   BND-06 floor                                      cold.ts
//   BND-07 novelty                                    cold.ts
//   BND-08 slot cap is absolute (hard)                dispatch.ts Dispatcher
//   BND-09 keyed in-flight (hard)                     dispatch.ts
//   BND-10 revalidate at execution (hard)             dispatch.ts + bundle.ts
//   BND-11 three strikes                              dispatch.ts + attempts.ts
//   BND-12 bounded waiters                            providers/pool.ts
//
// Every DB-touching case seeds on case-prefixed stream keys, scopes the
// dispatcher to that prefix, and removes its rows afterwards so the shared
// harness DB stays clean. The fixture JSON carries the parameters and the
// expected numbers; this file is the seeding and the assertions.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { isPoolOverflow, ResourcePool } from "../../providers/pool.js";
import { collectTick, markDispatched } from "../../scheduler/v6/bundle.js";
import { CHAR_CAP, ColdWindow, FLUSH_FLOOR_MS, FRESHNESS_PRESETS } from "../../scheduler/v6/cold.js";
import { Dispatcher, type SinkResult } from "../../scheduler/v6/dispatch.js";
import { HISTORY_SPLIT_CHARS, pendingHistoryDays, planHistory } from "../../scheduler/v6/history.js";
import { listDeadLetters } from "../../scheduler/v6/attempts.js";
import { append, MIN, msgAt, screenAt, seedEpisode, seedOpenTask, seedSpace, streamIdOf, visitAt } from "../../scheduler/v6/testutil.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

const SEC = 1_000;
const T0 = Date.parse("2026-08-28T12:00:00.000Z");

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

/** Case-prefixed world with cleanup. */
export class CaseWorld {
  readonly prefix: string;
  private readonly spaces: string[] = [];
  private readonly tasks: string[] = [];
  private readonly episodes: string[] = [];
  constructor(caseId: string) {
    this.prefix = `${caseId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_`;
  }
  key(k: string): string {
    return `${this.prefix}${k}`;
  }
  space(id: string, label: string): string {
    const sid = this.key(id);
    seedSpace(sid, label);
    this.spaces.push(sid);
    return sid;
  }
  task(id: string, title: string, spaceId: string | null, evidence: string[] = []): string {
    const tid = this.key(id);
    seedOpenTask(tid, title, spaceId, evidence);
    this.tasks.push(tid);
    return tid;
  }
  episode(id: string, streamId: string, lastMs: number, o: Parameters<typeof seedEpisode>[3] = {}): string {
    const eid = this.key(id);
    seedEpisode(eid, streamId, lastMs, o);
    this.episodes.push(eid);
    return eid;
  }
  cleanup(): void {
    const db = getDb();
    const like = `${this.prefix}%`;
    const tx = db.transaction(() => {
      for (const id of this.episodes) db.prepare(`DELETE FROM episode_events WHERE episode_id = ?`).run(id);
      for (const id of this.episodes) db.prepare(`DELETE FROM episodes WHERE id = ?`).run(id);
      for (const id of this.tasks) db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
      db.prepare(`DELETE FROM bundle_attempts WHERE stream_id IN (SELECT id FROM streams WHERE external_key LIKE ?)`).run(like);
      db.prepare(`DELETE FROM event_bridge_keys WHERE event_id IN (SELECT id FROM events WHERE stream_key LIKE ?)`).run(like);
      db.prepare(`DELETE FROM bridges WHERE left_id IN (SELECT id FROM events WHERE stream_key LIKE ?) OR right_id IN (SELECT id FROM events WHERE stream_key LIKE ?)`).run(like, like);
      db.prepare(`DELETE FROM events WHERE stream_key LIKE ?`).run(like);
      db.prepare(`DELETE FROM streams WHERE external_key LIKE ?`).run(like);
      for (const id of this.spaces) {
        db.prepare(`DELETE FROM space_bridge_keys WHERE space_id = ?`).run(id);
        db.prepare(`DELETE FROM space_entities WHERE space_id = ?`).run(id);
        db.prepare(`DELETE FROM spaces WHERE id = ?`).run(id);
      }
    });
    tx();
  }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

type CaseFn = (fixture: Fixture, w: CaseWorld) => Promise<ExecutorResult> | ExecutorResult;

// ---- BND-01..03 · history ----------------------------------------------------

const bnd01: CaseFn = (fixture, w) => {
  const setup = rec(fixture.setup);
  const day = typeof setup.day === "string" ? setup.day : "2026-08-20";
  const at = (hhmm: string) => Date.parse(`${day}T${hhmm}:00.000Z`);
  const envs = [];
  for (let i = 0; i < 20; i++) envs.push(msgAt(w.key("goa-gang@g.us"), at("09:00") + i * 7 * MIN, `goa msg ${i}`, { origin: "backfill" }));
  for (let i = 0; i < 20; i++) envs.push({ ...screenAt(w.key("com.apple.Notes"), at("10:00") + i * 5 * MIN, `note draft v${i}`), origin: "backfill" as const });
  for (let i = 0; i < 20; i++) envs.push({ ...visitAt(w.key("goibibo.com"), at("11:00") + i * 3 * MIN, `https://goibibo.com/hotels/${i}`, `Hotel ${i}`, day), origin: "backfill" as const });
  // The browser helper builds its own key; re-prefix so the scope catches it.
  for (const e of envs) if (!e.streamKey.startsWith(w.prefix)) e.streamKey = w.key(e.streamKey);
  append(envs);
  const plan = planHistory({ streamKeyPrefix: w.prefix });
  const violations: Violation[] = [];
  if (plan.length !== 1) violations.push({ label: "two-bundles", note: `${plan.length} bundles` });
  const byStream = new Map<string, string[]>();
  for (const e of plan[0]?.events ?? []) {
    const sid = e.streamId ?? "?";
    (byStream.get(sid) ?? byStream.set(sid, []).get(sid)!).push(e.ts ?? "");
  }
  for (const [sid, times] of byStream) {
    if ([...times].sort().join() !== times.join()) violations.push({ label: "mixed-section", note: `${sid} out of time order` });
  }
  const order = [...byStream.keys()];
  const sectioned = order.length === 3 && order[0].startsWith("wa:") && order[1].startsWith("screen:") && order[2].startsWith("browser:");
  if (!sectioned) violations.push({ label: "mixed-section", note: `section order ${order.join(" · ")}` });
  return {
    ok: violations.length === 0 && (plan[0]?.events.length ?? 0) === 60,
    output: { bundles: plan.length, events: plan[0]?.events.length ?? 0, sections: order, lead: plan[0]?.streamId },
    violations,
    metrics: { containment: plan[0]?.events.length === 60 ? 1 : 0, bundle_purity: violations.length === 0 ? 1 : 0 },
  };
};

const bnd02: CaseFn = (_fixture, w) => {
  const day = "2026-08-20";
  const at = (hhmm: string) => Date.parse(`${day}T${hhmm}:00.000Z`);
  const text = "x".repeat(150);
  const envs = [];
  for (let i = 0; i < 150; i++) envs.push(msgAt(w.key("night@g.us"), at("00:00") + i * 48_000, `${text} n${i}`, { origin: "backfill" }));
  for (let i = 0; i < 150; i++) envs.push(msgAt(w.key("night@g.us"), at("08:00") + i * 48_000, `${text} m${i}`, { origin: "backfill" }));
  append(envs);
  const plan = planHistory({ streamKeyPrefix: w.prefix });
  const violations: Violation[] = [];
  for (const part of plan) {
    for (let i = 1; i < part.events.length; i++) {
      if (Date.parse(part.events[i].ts!) - Date.parse(part.events[i - 1].ts!) !== 48_000) {
        violations.push({ label: "split-at-cap-mid-burst", note: `a cut inside part ${part.part}` });
        break;
      }
    }
  }
  const splitOk = plan.length === 2 && plan[0].events.at(-1)!.ts! < `${day}T02:00:00.000Z` && plan[1].events[0]!.ts! >= `${day}T08:00:00.000Z`;
  return {
    ok: violations.length === 0 && splitOk,
    output: { bundles: plan.length, cut: plan.map((p) => [p.events[0]?.ts, p.events.at(-1)?.ts]), partChars: plan.map((p) => p.events.reduce((n, e) => n + (e.text ?? "").length, 0)), cap: HISTORY_SPLIT_CHARS },
    violations,
    metrics: { containment: plan.reduce((n, p) => n + p.events.length, 0) === 300 ? 1 : 0 },
  };
};

const bnd03: CaseFn = (fixture, w) => {
  const setup = rec(fixture.setup);
  const days = Array.isArray(setup.days) ? (setup.days as string[]) : ["2026-08-01", "2026-08-02", "2026-08-04", "2026-08-05"];
  const empty = typeof setup.empty === "string" ? setup.empty : "2026-08-03";
  for (const d of days) {
    append([
      msgAt(w.key("fam@g.us"), Date.parse(`${d}T10:00:00Z`), `hello on ${d}`, { origin: "backfill" }),
      msgAt(w.key("fam@g.us"), Date.parse(`${d}T10:05:00Z`), `again on ${d}`, { origin: "backfill" }),
    ]);
  }
  const order = planHistory({ streamKeyPrefix: w.prefix }).map((b) => b.day);
  const expected = [...days].sort().reverse();
  const violations: Violation[] = [];
  if (order.includes(empty)) violations.push({ label: "clock-only-call", note: `${empty} sent` });
  const emptyBundles = planHistory({ streamKeyPrefix: w.prefix }).filter((b) => b.events.length === 0).length;
  if (emptyBundles > 0) violations.push({ label: "clock-only-call", note: `${emptyBundles} empty bundle(s)` });
  return {
    ok: violations.length === 0 && order.join() === expected.join(),
    output: { order, days: pendingHistoryDays({ streamKeyPrefix: w.prefix }).map((d) => d.day) },
    violations,
    metrics: { clock_only_call: emptyBundles },
  };
};

// ---- BND-04..07 · the cold window ------------------------------------------

function pe(rowid: number, atMs: number, key: string, chars = 40, streamId = "wa:st:a") {
  return { rowid, id: `e${rowid}`, streamId, contentKey: key, chars, atMs };
}

const bnd04: CaseFn = () => {
  const wnd = new ColdWindow(FRESHNESS_PRESETS.balanced);
  wnd.add(pe(1, T0, "a"));
  wnd.add(pe(2, T0 + 10 * SEC, "b"));
  wnd.add(pe(3, T0 + 20 * SEC, "c"));
  const due = wnd.dueAt();
  const flushAtS = due ? (due.atMs - T0) / SEC : null;
  const violations: Violation[] = [];
  if (wnd.due(T0 + 45 * SEC)) violations.push({ label: "flush-at-45s" });
  return { ok: flushAtS === 320 && violations.length === 0, output: { flushAtS, trigger: due?.trigger }, violations, metrics: {} };
};

const bnd05: CaseFn = () => {
  const wnd = new ColdWindow(FRESHNESS_PRESETS.balanced);
  let flushedAtS: number | null = null;
  for (let t = 0; t <= 900 && flushedAtS === null; t += 10) {
    wnd.add(pe(t / 10 + 1, T0 + t * SEC, `k${t}`));
    if (wnd.due(T0 + t * SEC)) flushedAtS = t;
  }
  const violations: Violation[] = flushedAtS === null ? [{ label: "never-flushes" }] : [];
  return { ok: flushedAtS === 540, output: { flushAtS: flushedAtS }, violations, metrics: {} };
};

const bnd06: CaseFn = () => {
  const wnd = new ColdWindow(FRESHNESS_PRESETS.balanced);
  wnd.add(pe(1, T0, "a"));
  wnd.urge("hot");
  const first = wnd.due(T0) ? 0 : null;
  wnd.flush(T0);
  wnd.add(pe(2, T0 + 5 * SEC, "b"));
  wnd.urge("hot");
  const violations: Violation[] = [];
  if (wnd.due(T0 + 5 * SEC)) violations.push({ label: "floor-ignored", note: "second flush at 5 s" });
  const second = wnd.dueAt();
  const secondS = second ? (second.atMs - T0) / SEC : null;
  return {
    ok: first === 0 && secondS === FLUSH_FLOOR_MS / SEC && violations.length === 0,
    output: { firstFlushAtS: first, secondFlushAtS: secondS },
    violations,
    metrics: {},
  };
};

const bnd07: CaseFn = () => {
  const wnd = new ColdWindow(FRESHNESS_PRESETS.balanced);
  const S = "screen:st:x";
  wnd.add(pe(1, T0, "frame-A", 500, S));
  let counted = 0;
  for (let t = 10; t <= 120; t += 10) if (wnd.add(pe(1 + t / 10, T0 + t * SEC, "frame-A", 500, S))) counted++;
  const due = wnd.dueAt();
  const violations: Violation[] = [];
  if (counted > 0) violations.push({ label: "heartbeat-keeps-alive", note: `${counted} repeats counted` });
  if (!due || due.atMs !== T0 + 300 * SEC) violations.push({ label: "heartbeat-keeps-alive", note: `timer moved to ${due ? (due.atMs - T0) / SEC : "never"} s` });
  wnd.flush(T0 + 300 * SEC);
  let flushesAfter = 0;
  for (let t = 310; t <= 1200; t += 10) {
    wnd.add(pe(100 + t / 10, T0 + t * SEC, "frame-A", 500, S));
    if (wnd.due(T0 + t * SEC)) flushesAfter++;
  }
  if (flushesAfter > 0) violations.push({ label: "heartbeat-keeps-alive", note: `${flushesAfter} flush(es) on heartbeats alone` });
  return { ok: violations.length === 0, output: { repeatsCounted: counted, timerAtS: due ? (due.atMs - T0) / SEC : null, flushesAfterHeartbeatsOnly: flushesAfter, charCap: CHAR_CAP }, violations, metrics: {} };
};

// ---- BND-08..11 · the dispatcher --------------------------------------------

const bnd08: CaseFn = async (fixture, w) => {
  const setup = rec(fixture.setup);
  const streams = num(setup.streams, 500);
  const perStream = Math.round(num(setup.events, 3000) / streams);
  const slots = num(setup.slots, 4);
  const envs = [];
  for (let s = 0; s < streams; s++) {
    const dayMs = Date.parse("2024-01-01T09:00:00Z") + s * 86_400_000;
    for (let i = 0; i < perStream; i++) envs.push(msgAt(w.key(`stream-${s}@g.us`), dayMs + i * 5 * MIN, `planning message ${i} for stream ${s}`, { origin: "backfill" }));
  }
  append(envs);
  const violations: Violation[] = [];
  let overCap = 0;
  const perTick: number[] = [];
  // Path 1: a sink that settles without marking — the whole backlog is re-dispatchable every tick.
  const d1 = new Dispatcher({ cfg: { slots, maxBundleEvents: 500 }, sink: () => ({ status: "empty" }), streamKeyPrefix: w.prefix, coldParams: FRESHNESS_PRESETS.balanced });
  for (let t = 0; t < 5; t++) {
    const r = d1.tick(T0 + t * 5 * SEC);
    perTick.push(r.routed.length);
    if (r.routed.length > slots) overCap++;
    await d1.drain();
  }
  // Path 2: a sink that never settles — in-flight work bounds later ticks, never a re-queue.
  const d2 = new Dispatcher({ cfg: { slots, maxBundleEvents: 500 }, sink: () => new Promise<SinkResult>(() => {}), streamKeyPrefix: w.prefix, coldParams: FRESHNESS_PRESETS.balanced });
  const parked: number[] = [];
  for (let t = 0; t < 3; t++) {
    const r = d2.tick(T0 + t * 5 * SEC);
    parked.push(r.routed.length);
    if (r.routed.length > slots) overCap++;
  }
  if (overCap > 0) violations.push({ label: "cap-exceeded", note: `${overCap} tick(s) over ${slots}` });
  const starved = perTick.some((n) => n === 0);
  return {
    ok: violations.length === 0 && !starved && parked[2] === 0,
    output: { perTick, parkedPerTick: parked, slots, inFlightAfterParked: d2.inFlightKeys().length },
    violations,
    metrics: { dispatch_over_cap: overCap },
  };
};

const bnd09: CaseFn = async (_fixture, w) => {
  append([msgAt(w.key("goa-gang@g.us"), T0, "villa advance by 5pm"), msgAt(w.key("goa-gang@g.us"), T0 + SEC, "ok sending")]);
  const bundle = collectTick(T0).bundles.find((b) => b.streamKey === w.key("goa-gang@g.us"))!;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<SinkResult>((r) => (release = () => r({ status: "empty" })));
  const d = new Dispatcher({ streamKeyPrefix: w.prefix, coldParams: FRESHNESS_PRESETS.balanced });
  const sink = () => (calls++, gate);
  const first = d.submit(bundle, sink, T0, "live");
  const second = d.submit({ ...bundle }, sink, T0 + SEC, "live");
  await settle();
  release();
  await d.drain();
  const violations: Violation[] = calls === 1 ? [] : [{ label: "double-call", note: `${calls} sink calls` }];
  return { ok: first === "routed" && second === "duplicate" && calls === 1, output: { first, second, sinkCalls: calls }, violations, metrics: { dispatch_over_cap: calls > 1 ? 1 : 0 } };
};

const bnd10: CaseFn = (_fixture, w) => {
  append([msgAt(w.key("goa-gang@g.us"), T0, "villa advance by 5pm"), msgAt(w.key("goa-gang@g.us"), T0 + SEC, "ok sending")]);
  const bundle = collectTick(T0).bundles.find((b) => b.streamKey === w.key("goa-gang@g.us"))!;
  markDispatched(bundle, T0 + 2 * SEC); // another path stamps the rows meanwhile
  let calls = 0;
  const d = new Dispatcher({ streamKeyPrefix: w.prefix, coldParams: FRESHNESS_PRESETS.balanced });
  const outcome = d.submit(bundle, () => (calls++, { status: "empty" }), T0 + 3 * SEC, "live");
  const violations: Violation[] = calls === 0 ? [] : [{ label: "stale-call" }];
  return { ok: outcome === "stale" && calls === 0, output: { outcome, sinkCalls: calls, stale: d.stats().stale }, violations, metrics: { dispatch_over_cap: calls } };
};

const bnd11: CaseFn = async (_fixture, w) => {
  const sp = w.space("sp_goa", "Goa trip");
  w.episode("ep_goa", streamIdOf("wa", w.key("goa-gang@g.us")), T0 - 30 * MIN, { spaceId: sp, state: "closed" });
  w.task("tsk_adv", "collect advance from Karan", sp);
  const [id] = append([msgAt(w.key("goa-gang@g.us"), T0, "ok")]);
  let now = T0;
  const attempts: number[] = [];
  const d = new Dispatcher({
    now: () => now,
    sink: () => (attempts.push((now - T0) / MIN), { status: "quarantined" }),
    streamKeyPrefix: w.prefix,
    coldParams: FRESHNESS_PRESETS.balanced,
    history: false,
    digest: false,
  });
  for (const m of [0, 1, 4, 5, 7, 10, 11, 15, 30, 120, 24 * 60]) {
    now = T0 + m * MIN;
    d.tick(now);
    await d.drain();
  }
  const stamped = (getDb().prepare(`SELECT dispatched_at FROM events WHERE id = ?`).get(id) as { dispatched_at: string | null }).dispatched_at !== null;
  const dead = listDeadLetters().filter((r) => r.streamId === streamIdOf("wa", w.key("goa-gang@g.us")));
  const violations: Violation[] = attempts.length > 3 ? [{ label: "fourth-attempt", note: `${attempts.length} attempts` }] : [];
  return {
    ok: attempts.join() === "0,5,10" && stamped && dead.length === 1 && violations.length === 0,
    output: { attemptMinutes: attempts, deadLetters: dead.map((r) => ({ key: r.bundleKey, attempts: r.attempts })), stamped },
    violations,
    metrics: { containment: stamped ? 1 : 0 },
  };
};

// ---- BND-12 · bounded waiters -------------------------------------------------

const bnd12: CaseFn = async (fixture) => {
  const setup = rec(fixture.setup);
  const llm = num(setup.llm, 2);
  const submitted = num(setup.submitted, 20);
  const pool = new ResourcePool({ limits: { llm }, warmFirst: false, firstPaint: true });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const settled: string[] = [];
  const subs = Array.from({ length: submitted }, () =>
    pool
      .run("llm", () => gate, { lane: "understanding" })
      .then(() => settled.push("ok"))
      .catch((err: unknown) => settled.push(isPoolOverflow(err) ? "overflow" : "other")),
  );
  await settle();
  const overflow = settled.filter((s) => s === "overflow").length;
  const waiting = pool.waiting("llm");
  const inFlight = pool.inFlight("llm");
  release();
  await Promise.all(subs);
  const violations: Violation[] = [];
  if (overflow === 0 || typeof waiting !== "number") violations.push({ label: "silent-queue" });
  const expected = rec(fixture.expected);
  const ok = violations.length === 0 && overflow === num(expected.overflow_rejected, 10) && waiting === num(expected.waiting, 9) && inFlight === num(expected.in_flight, 1);
  return { ok, output: { overflow, waiting, inFlight, settled: settled.filter((s) => s === "ok").length, waiterCap: pool.waiterCap("llm") }, violations, metrics: {} };
};

const CASES: Record<string, CaseFn> = {
  "BND-01": bnd01,
  "BND-02": bnd02,
  "BND-03": bnd03,
  "BND-04": bnd04,
  "BND-05": bnd05,
  "BND-06": bnd06,
  "BND-07": bnd07,
  "BND-08": bnd08,
  "BND-09": bnd09,
  "BND-10": bnd10,
  "BND-11": bnd11,
  "BND-12": bnd12,
};

/** The executor registered for pass `bundle` (BND). */
export const bundleExecutor: Executor = async ({ fixture }): Promise<ExecutorResult> => {
  const run = CASES[fixture.id];
  if (!run) throw new Error(`BND executor: no case for ${fixture.id}`);
  const w = new CaseWorld(fixture.id);
  try {
    const result = await run(fixture, w);
    return { ...result, notes: [...(result.notes ?? []), "deterministic; zero model calls (scheduler/v6 code path)"] };
  } finally {
    w.cleanup();
  }
};
