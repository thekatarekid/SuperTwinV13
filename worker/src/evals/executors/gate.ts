// ===========================================================================
// [CODE] GATE — the state-gate executor (GoldenEvals V6 P1 §5.6; V6 P1 S3.3).
//
// Deterministic, zero model calls, against the REAL scheduler/v6 code:
//
//   GATE-01 an open task makes it hot           gate.ts gateEvent
//   GATE-02 same bytes, no state, cold          gate.ts
//   GATE-03 an active episode makes it hot      gate.ts
//   GATE-04 a bridge to an active space         gate.ts (+ bridges/ingest keys)
//   GATE-05 addressed to the twin               gate.ts
//   GATE-06 burst (three variants)              burst.ts BurstTracker
//   GATE-07 burst is per stream                 burst.ts
//   GATE-08 bootstrapping                       cold.ts effectiveParams
//   GATE-09 history never queues a nudge        dispatch.ts + providers/pool.ts
//   GATE-10 replay budget                       dispatch.ts over a synthetic
//                                               63-day corpus (seeded PRNG)
//
// `content_gated_call` is measured on every case: the gate's inputs carry no
// text, and gate.ts is scanned for regex / character-count code.
// ===========================================================================

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getDb } from "../../db/connection.js";
import { ResourcePool } from "../../providers/pool.js";
import { markDispatched, type DeltaBundle } from "../../scheduler/v6/bundle.js";
import { BurstTracker } from "../../scheduler/v6/burst.js";
import { BOOTSTRAP_PARAMS, effectiveParams, FRESHNESS_PRESETS } from "../../scheduler/v6/cold.js";
import { Dispatcher, type SinkResult } from "../../scheduler/v6/dispatch.js";
import { gateEvent } from "../../scheduler/v6/gate.js";
import { append, MIN, msgAt, screenAt, seedPerson, seedSpaceBridge, streamIdOf, visitAt } from "../../scheduler/v6/testutil.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";
import { CaseWorld } from "./bnd.js";

const SEC = 1_000;
const DAY = 86_400_000;
const T0 = Date.parse("2026-08-28T12:00:00.000Z");

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

/** `content_gated_call`: 1 when gate.ts reads content, else 0. Read once. */
let gateSourceViolations: number | null = null;
function contentGatedCalls(): number {
  if (gateSourceViolations !== null) return gateSourceViolations;
  const bundledRoot = process.env.SUPERTWIN_SIGNED_GOLDEN_BROKER === "1" &&
    process.env.SUPERTWIN_GOLDEN_BUNDLE_ROOT?.startsWith("/")
    ? resolve(process.env.SUPERTWIN_GOLDEN_BUNDLE_ROOT, "source/scheduler/v6/gate.ts") : null;
  const src = readFileSync(bundledRoot ?? join(dirname(fileURLToPath(import.meta.url)), "../../scheduler/v6/gate.ts"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
  let n = 0;
  if (/\.text\b/.test(code)) n++;
  if (/\.length\s*[<>]/.test(code)) n++;
  if (/new RegExp|\.test\(|\.match\(/.test(code)) n++;
  gateSourceViolations = n;
  return n;
}

type CaseFn = (fixture: Fixture, w: CaseWorld) => Promise<ExecutorResult> | ExecutorResult;

function gateResult(ok: boolean, output: unknown, violations: Violation[]): ExecutorResult {
  const cg = contentGatedCalls();
  return { ok: ok && cg === 0, output, violations, metrics: { content_gated_call: cg } };
}

const gate01: CaseFn = (_fixture, w) => {
  const goa = w.key("goa-gang@g.us");
  const sp = w.space("sp_goa", "Goa trip");
  const [seed] = append([msgAt(goa, T0 - 30 * MIN, "collect advance from karan by friday", { actor: "self" })]);
  w.episode("ep_goa", streamIdOf("wa", goa), T0 - 30 * MIN, { spaceId: sp, state: "closed", eventIds: [seed] });
  w.task("tsk_adv", "collect advance from Karan", sp);
  const [id] = append([msgAt(goa, T0, "ok")]);
  const d = gateEvent({ id, streamId: streamIdOf("wa", goa), source: "wa", kind: "wa.message", actor: "contact:karan" }, { nowMs: T0 });
  const violations: Violation[] = d.decision === "cold" ? [{ label: "char-count-cold" }] : [];
  return gateResult(d.decision === "hot" && d.reason === "open_task_in_stream" && d.tookMs < 100, { gate: d }, violations);
};

const gate02: CaseFn = (_fixture, w) => {
  const other = w.key("college-friends@g.us");
  const [id] = append([msgAt(other, T0, "ok")]);
  const d = gateEvent({ id, streamId: streamIdOf("wa", other), source: "wa", kind: "wa.message", actor: "contact:karan" }, { nowMs: T0 });
  const violations: Violation[] = d.decision === "hot" ? [{ label: "keyword-hot", note: d.reason ?? "" }] : [];
  return gateResult(d.decision === "cold" && d.reason === null, { gate: d }, violations);
};

const gate03: CaseFn = (_fixture, w) => {
  const rohan = w.key("919800000001@s.whatsapp.net");
  w.episode("ep_villa", streamIdOf("wa", rohan), T0 - 4 * MIN, { state: "open" });
  const [id] = append([msgAt(rohan, T0, "and the villa?", { actor: "contact:rohan" })]);
  const d = gateEvent({ id, streamId: streamIdOf("wa", rohan), source: "wa", actor: "contact:rohan" }, { nowMs: T0 });
  const violations: Violation[] = d.decision === "cold" ? [{ label: "episode-ignored" }] : [];
  return gateResult(d.decision === "hot" && d.reason === "active_episode", { gate: d }, violations);
};

const gate04: CaseFn = (_fixture, w) => {
  const url = "https://www.airbnb.com/rooms/812345";
  const visit = visitAt("airbnb.com", T0, url, "Villa Anjuna · Airbnb");
  visit.streamKey = w.key(visit.streamKey);
  const [id] = append([visit]);
  const key = getDb().prepare(`SELECT kind, value_norm FROM event_bridge_keys WHERE event_id = ? AND kind = 'url'`).get(id) as { kind: string; value_norm: string } | undefined;
  const sp = w.space("sp_goa_dec", "Goa trip with Rohan in December");
  if (key) seedSpaceBridge(sp, key.kind, key.value_norm);
  const d = gateEvent({ id, streamId: streamIdOf("browser", visit.streamKey), source: "browser", actor: "self" }, { nowMs: T0 });
  const violations: Violation[] = d.decision === "cold" ? [{ label: "bridge-ignored" }] : [];
  return gateResult(Boolean(key) && d.decision === "hot" && d.reason === "bridge_to_active_space", { gate: d, bridgeKey: key ?? null }, violations);
};

const gate05: CaseFn = () => {
  const d = gateEvent({ id: null, streamId: "twin:st:bar:thread-1", source: "twin", kind: "bar.message", actor: "self", streamKey: "bar:thread-1" }, { nowMs: T0 });
  const violations: Violation[] = d.decision === "cold" ? [{ label: "twin-ignored" }] : [];
  return gateResult(d.decision === "hot" && d.reason === "addressed_to_twin", { gate: d }, violations);
};

const gate06: CaseFn = () => {
  const stream = "browser:croma.com";
  const a = new BurstTracker();
  a.note(stream, T0, "tv-1");
  a.note(stream, T0 + 50 * SEC, "tv-2");
  a.note(stream, T0 + 100 * SEC, "tv-3");
  const fourDistinct = a.note(stream, T0 + 150 * SEC, "tv-4");
  const b = new BurstTracker();
  b.note(stream, T0, "tv-1");
  b.note(stream, T0 + 50 * SEC, "tv-2");
  const three = b.note(stream, T0 + 100 * SEC, "tv-3");
  const c = new BurstTracker();
  c.note(stream, T0, "tv-1");
  c.note(stream, T0 + 40 * SEC, "tv-1");
  c.note(stream, T0 + 80 * SEC, "tv-2");
  const repeats = c.note(stream, T0 + 120 * SEC, "tv-2");
  const violations: Violation[] = repeats.burst ? [{ label: "burst-on-repeats" }] : [];
  return gateResult(fourDistinct.burst && !three.burst && !repeats.burst && repeats.runLength === 2, { fourDistinct, three, fourWithTwoRepeats: repeats }, violations);
};

const gate07: CaseFn = () => {
  const t = new BurstTracker();
  t.note("browser:croma.com", T0, "c1");
  t.note("browser:amazon.in", T0 + 30 * SEC, "a1");
  t.note("browser:croma.com", T0 + 60 * SEC, "c2");
  const last = t.note("browser:amazon.in", T0 + 90 * SEC, "a2");
  const maxRun = Math.max(t.runLength("browser:croma.com", T0 + 90 * SEC), t.runLength("browser:amazon.in", T0 + 90 * SEC));
  const violations: Violation[] = last.burst ? [{ label: "cross-stream-burst" }] : [];
  return gateResult(!last.burst && maxRun === 2, { decision: last.burst ? "burst" : "cold", maxRunOnOneStream: maxRun }, violations);
};

const gate08: CaseFn = (fixture) => {
  const setup = rec(fixture.setup);
  const preset = typeof setup.preset === "string" ? setup.preset : "balanced";
  const first = T0;
  const windows = [
    effectiveParams(preset, { spaces: 5, firstConsentMs: first, nowMs: first + 30 * DAY }),
    effectiveParams(preset, { spaces: 20, firstConsentMs: first, nowMs: first + 3 * DAY }),
    effectiveParams(preset, { spaces: 20, firstConsentMs: first, nowMs: first + 7 * DAY }),
  ].map((p) => ({ idle_s: p.idleMs / SEC, max_s: p.maxMs / SEC }));
  const expected = (rec(fixture.expected).windows as { idle_s: number; max_s: number }[] | undefined) ?? [
    { idle_s: 60, max_s: 180 },
    { idle_s: 60, max_s: 180 },
    { idle_s: 300, max_s: 540 },
  ];
  const ok = JSON.stringify(windows) === JSON.stringify(expected);
  const violations: Violation[] = ok ? [] : [{ label: "window-stuck", note: JSON.stringify(windows) }];
  return gateResult(ok, { windows, bootstrap: BOOTSTRAP_PARAMS, preset: FRESHNESS_PRESETS[preset as keyof typeof FRESHNESS_PRESETS] }, violations);
};

const gate09: CaseFn = async (fixture, w) => {
  const setup = rec(fixture.setup);
  const n = num(setup.history_bundles, 200);
  const llm = num(setup.llm, 4);
  const rohan = w.key("rohan@s.whatsapp.net");
  w.episode("ep_rohan", streamIdOf("wa", rohan), T0 - 4 * MIN, { state: "open" });
  const envs = [];
  for (let s = 0; s < n; s++) envs.push(msgAt(w.key(`h${s}@g.us`), Date.parse("2024-01-01T09:00:00Z") + s * DAY, `history day ${s}`, { origin: "backfill" }));
  append(envs);

  const pool = new ResourcePool({ limits: { llm }, warmFirst: false });
  let release!: () => void;
  const parked = new Promise<void>((r) => (release = r));
  const liveDone: number[] = [];
  const sink = async (b: DeltaBundle): Promise<SinkResult> => {
    if (b.lane === "live") {
      const started = Date.now();
      await pool.run("llm", () => {}, { lane: "live" });
      liveDone.push(Date.now() - started);
      markDispatched(b);
      return { status: "committed" };
    }
    await pool.run("llm", () => parked, { lane: "understanding" });
    return { status: "empty" };
  };
  const d = new Dispatcher({ cfg: { slots: 4, maxBundleEvents: 500 }, sink, streamKeyPrefix: w.prefix, coldParams: FRESHNESS_PRESETS.balanced, digest: false });
  d.tick(T0);
  d.tick(T0 + 5 * SEC);
  await new Promise((r) => setTimeout(r, 0));
  const inFlightBefore = d.inFlightKeys().length;
  const waitingBefore = pool.waiting("llm");
  append([msgAt(rohan, T0 + 10 * SEC, "and the villa?", { actor: "contact:rohan" })]);
  const r = d.tick(T0 + 10 * SEC);
  for (let i = 0; i < 50 && liveDone.length === 0; i++) await new Promise((res) => setTimeout(res, 0));
  const violations: Violation[] = liveDone.length === 0 ? [{ label: "live-behind-history" }] : [];
  release();
  await d.drain();
  const ok = r.liveFlush?.trigger === "hot" && liveDone.length === 1 && liveDone[0] < 30_000 && inFlightBefore > 0 && waitingBefore > 0;
  return gateResult(ok, { liveFlush: r.liveFlush, liveCompletedMs: liveDone[0] ?? null, historyInFlightBefore: inFlightBefore, poolWaitingBefore: waitingBefore }, violations);
};

// ---- GATE-10 · replay budget over a synthetic corpus -------------------------

/** mulberry32 — a tiny seeded PRNG so the corpus is identical on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["villa", "advance", "friday", "ok", "lunch", "call", "booking", "flight", "photos", "later", "done", "sending", "price", "dropped", "plan"];

const gate10: CaseFn = async (fixture, w) => {
  const setup = rec(fixture.setup);
  const days = num(setup.days, 63);
  const rand = prng(num(setup.seed, 63));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const start = Date.parse("2026-06-01T00:00:00Z");

  // World: 25 WhatsApp streams, 5 of them with an open task (state that makes them hot).
  const waKeys = Array.from({ length: 25 }, (_, i) => w.key(`g${i}@g.us`));
  const sp = w.space("sp_goa", "Goa trip");
  for (let i = 0; i < 5; i++) {
    w.episode(`ep_${i}`, streamIdOf("wa", waKeys[i]), start - DAY, { spaceId: sp, state: "closed" });
  }
  w.task("tsk_adv", "collect advance from Karan", sp);

  // Corpus: per day ~100 WA messages, ~160 screen frames (65 % heartbeats), ~40 browser visits with two 4-page bursts.
  type Ev = { ts: number; env: ReturnType<typeof msgAt> };
  const corpus: Ev[] = [];
  for (let d = 0; d < days; d++) {
    const day0 = start + d * DAY + 7 * 3_600_000; // 07:00
    const dayIso = new Date(day0).toISOString().slice(0, 10);
    for (let i = 0; i < 100; i++) {
      const ts = day0 + Math.floor(rand() * 15 * 3_600_000);
      corpus.push({ ts, env: msgAt(pick(waKeys), ts, `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} ${i}`, { actor: `contact:p${Math.floor(rand() * 40)}` }) });
    }
    let frame = `frame ${d}-0`;
    for (let i = 0; i < 160; i++) {
      const ts = day0 + Math.floor((i / 160) * 15 * 3_600_000);
      if (rand() > 0.65) frame = `frame ${d}-${i} ${pick(WORDS)} ${pick(WORDS)}`;
      const f = screenAt("com.apple.Notes", ts, frame, `s${d}`);
      f.streamKey = w.key(f.streamKey);
      corpus.push({ ts, env: f });
    }
    for (let i = 0; i < 32; i++) {
      const ts = day0 + Math.floor(rand() * 15 * 3_600_000);
      const domain = `shop${Math.floor(rand() * 10)}.example`;
      const v = visitAt(domain, ts, `https://${domain}/p/${Math.floor(rand() * 500)}`, `Page ${i}`, dayIso);
      v.streamKey = w.key(v.streamKey);
      corpus.push({ ts, env: v });
    }
    for (let b = 0; b < 2; b++) {
      const t0 = day0 + Math.floor(rand() * 14 * 3_600_000);
      const domain = `burst${b}.example`;
      for (let i = 0; i < 4; i++) {
        const ts = t0 + i * 30 * SEC;
        const v = visitAt(domain, ts, `https://${domain}/item/${d}-${b}-${i}`, `Item ${i}`, dayIso);
        v.streamKey = w.key(v.streamKey);
        corpus.push({ ts, env: v });
      }
    }
  }
  corpus.sort((a, b) => a.ts - b.ts);

  // Replay: every arrival is a tick; every due window is a tick.
  const callsByDay = new Map<string, number>();
  let now = start;
  const d = new Dispatcher({
    now: () => now,
    sink: (b) => {
      const day = new Date(now).toISOString().slice(0, 10);
      callsByDay.set(day, (callsByDay.get(day) ?? 0) + 1);
      markDispatched(b, now);
      return { status: "committed" };
    },
    streamKeyPrefix: w.prefix,
    coldParams: FRESHNESS_PRESETS.balanced,
    history: false,
    digest: false,
  });
  const startedAt = Date.now();
  for (const ev of corpus) {
    const due = d.cold.dueAt();
    if (due && due.atMs < ev.ts) {
      now = due.atMs;
      d.tick(now);
      await d.drain();
    }
    now = ev.ts;
    append([ev.env], now);
    d.tick(now);
    await d.drain();
  }
  now += 15 * MIN;
  d.tick(now);
  await d.drain();

  const perDay = [...callsByDay.values()];
  const maxPerDay = perDay.length > 0 ? Math.max(...perDay) : 0;
  const lat = [...d.stats().hotLatenciesMs].sort((a, b) => a - b);
  const hotMedianS = lat.length > 0 ? lat[Math.floor(lat.length / 2)] / SEC : 0;
  const expected = rec(fixture.expected);
  const violations: Violation[] = maxPerDay > num(expected.live_calls_per_day_max, 200) ? [{ label: "idle-rule-firing", note: `${maxPerDay} calls on the worst day` }] : [];
  const ok = violations.length === 0 && hotMedianS <= num(expected.hot_median_s_max, 60) && perDay.length === days;
  return gateResult(
    ok,
    {
      days: perDay.length,
      events: corpus.length,
      callsPerDay: { min: Math.min(...perDay), median: perDay.sort((a, b) => a - b)[Math.floor(perDay.length / 2)], max: maxPerDay, total: perDay.reduce((a, b) => a + b, 0) },
      hotMedianS,
      flushes: d.stats().flushes,
      replayMs: Date.now() - startedAt,
      note: "synthetic corpus (seeded); the real 63-day corpus was removed in S0.6",
    },
    violations,
  );
};

const CASES: Record<string, CaseFn> = {
  "GATE-01": gate01,
  "GATE-02": gate02,
  "GATE-03": gate03,
  "GATE-04": gate04,
  "GATE-05": gate05,
  "GATE-06": gate06,
  "GATE-07": gate07,
  "GATE-08": gate08,
  "GATE-09": gate09,
  "GATE-10": gate10,
};

/** The executor registered for pass `gate` (GATE). */
export const gateExecutor: Executor = async ({ fixture }): Promise<ExecutorResult> => {
  const run = CASES[fixture.id];
  if (!run) throw new Error(`GATE executor: no case for ${fixture.id}`);
  const w = new CaseWorld(fixture.id);
  try {
    const result = await run(fixture, w);
    return { ...result, notes: [...(result.notes ?? []), "deterministic; zero model calls (scheduler/v6 code path)"] };
  } finally {
    w.cleanup();
  }
};

export { seedPerson };
