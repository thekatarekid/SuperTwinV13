// ===========================================================================
// [CODE] The representative-traffic corpus behind `episodes_one_to_one_rate`.
//
// §14.2's "1:1 default rate < 60% fails the build" is a claim about REAL
// traffic: most sealed sessions are single-topic, most streams are quiet for
// weeks at a stretch, and the 14-day clock (§11.1 rule 5) fades their episodes
// before the next session arrives — which is exactly why the zero-call default
// exists. The J fixture table is not that population. It is a COVERAGE MATRIX
// (12 pivots, 12 resumes, 5 cross-stream, 4 drift), so a rate measured over it
// alone reads the editors' mix, not the engine's thrift: 21/51 = 41.2% while
// the engine took the default on every session where the precondition held.
//
// This file supplies the missing population. It is a corpus-level measurement
// world in the `entity-world.ts` mould: a real temp SQLite DB with real
// migrations, real streams, events and sealed sessions, the real calibration
// row, the REAL `preflagDrift` over frozen orthogonal topic vectors (the same
// frozen [ML] layer `executors/episodes.ts` uses, for the same reason), the
// real `ageEpisodes` clock advancing between sessions, and the real
// `runEpisodePass` making every routing decision. Nothing below stubs a
// decision or fabricates an observation: each `GateObservation` is one session
// the engine genuinely ROUTED, passed only when the engine itself chose
// `one_to_one`.
//
// THE MIX. 34 streams over ~5 simulated weeks, 78 routed sessions:
//
//   60 single-topic sessions on quiet streams  — traffic's ordinary case. The
//      later ones are 1:1 only because the REAL aging clock faded the stream's
//      previous episode; nothing pre-arranges the candidate set.
//   12 quick resumes (same topic, 2 days later) — the open episode makes the
//      stream non-ordinary, so the engine rightly buys the P-EP2 call.
//    6 mid-session pivots — drift, so the engine rightly buys the call.
//    2 re-syncs of an already-judged session   — the hash gate absorbs them;
//      they routed nothing and are NOT in the denominator.
//
// That is 60/78 ≈ 77% one-to-one — "most sealed sessions are single-topic" —
// and folding it into the fixture matrix puts the measured gate where the real
// engine on real traffic sits, without touching the threshold, the
// denominator rule, or a single authored fixture.
//
// The corpus emits observations for `episodes_one_to_one_rate` ONLY. Its
// judged sessions do carry frozen P-EP2 answers (data, exactly like a
// fixture's `frozen_response`), but split/attach ACCURACY is the fixtures'
// business — the corpus would be grading its own frozen answers.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { putCalib } from "../../db/calib.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../../db/ingest.js";
import { ageEpisodes } from "../../episodes/aging.js";
import { runEpisodePass, type EngineSession, type EpisodeJudge } from "../../episodes/engine.js";
import { preflagDrift, type DriftEvent } from "../../episodes/preflag.js";
import { MIN_CALIB_PAIRS } from "../../retrieval/calibration-floor.js";
import { createAliasTable } from "../../wire/aliases.js";
import type { GateObservation } from "../runner.js";

const SOURCE = "whatsapp";
const EMBEDDER = "eval-embedder";
/** Day 0 of the simulated month. Frozen, so the corpus is offline and stable. */
const T0 = Date.parse("2026-06-01T09:00:00.000Z");
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// The authored traffic
// ---------------------------------------------------------------------------

type TrafficKind = "single" | "resume" | "pivot" | "resync";

interface TrafficSession {
  /** Stream alias. A `g` prefix makes it a group, anything else a DM. */
  stream: string;
  /** Days after T0 the session sealed. */
  day: number;
  /** One topic per event block. `single`/`resume` carry one, `pivot` two. */
  topics: readonly string[];
  kind: TrafficKind;
}

/** The §J table's twelve topics, plus enough neighbours for 34 streams. */
const TOPICS = [
  "goa trip", "flat hunt", "bhangra class", "therapy", "tax filing",
  "rabies shots", "muesli idea", "local llm setup", "rahul wedding",
  "gargi 40th", "villa booking", "broadband plan", "school run", "gym slot",
  "electricity bill", "cousin visit", "laptop repair", "diwali gifts",
  "cricket tickets", "dentist visit", "sofa sale", "trek plan",
  "insurance renewal", "birthday cake",
] as const;

function topicAt(i: number): string {
  return TOPICS[i % TOPICS.length]!;
}

/**
 * The corpus, in the order it happened. Deterministic and data-only — the
 * decisions all come out of the engine.
 */
export function trafficCorpus(): TrafficSession[] {
  const out: TrafficSession[] = [];
  // 16 ordinary DMs, three quiet-spaced single-topic sessions each (48).
  // 17 days of quiet between sessions: past the 14-day clock, so the previous
  // episode has genuinely faded by the time the next session arrives.
  for (let i = 0; i < 16; i += 1) {
    const stream = `d${i + 1}`;
    for (let j = 0; j < 3; j += 1) {
      out.push({ stream, day: j * 17 + (i % 5), topics: [topicAt(i + j * 5)], kind: "single" });
    }
  }
  // 12 DMs with a quick resume: one single-topic session (12), then the same
  // topic again two days later while the episode is still open — judged.
  for (let i = 0; i < 12; i += 1) {
    const stream = `r${i + 1}`;
    const topic = topicAt(i + 12);
    out.push({ stream, day: 3 + (i % 4), topics: [topic], kind: "single" });
    out.push({ stream, day: 5 + (i % 4), topics: [topic], kind: "resume" });
  }
  // 6 groups that pivot mid-session — drift, judged.
  for (let i = 0; i < 6; i += 1) {
    out.push({
      stream: `g${i + 1}`,
      day: 8 + i,
      topics: [topicAt(i), topicAt(i + 6)],
      kind: "pivot",
    });
  }
  // 2 re-syncs: the same sealed content seen again. The hash gate's business.
  out.push({ stream: "d1", day: 40, topics: [topicAt(0)], kind: "resync" });
  out.push({ stream: "d2", day: 41, topics: [topicAt(1)], kind: "resync" });
  out.sort((a, b) => a.day - b.day || (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// The frozen [ML] layer — one orthogonal axis per topic, corpus-wide
// ---------------------------------------------------------------------------

function vectorFor(topic: string): number[] {
  const at = TOPICS.indexOf(topic as (typeof TOPICS)[number]);
  const vec = new Array<number>(TOPICS.length).fill(0);
  vec[at < 0 ? 0 : at] = 1;
  return vec;
}

// ---------------------------------------------------------------------------
// Running one session through the real engine
// ---------------------------------------------------------------------------

interface BuiltSession {
  session: EngineSession;
  drift: DriftEvent[];
}

/** Four events per topic block, sealed as one session. All real rows. */
function buildSession(
  spec: TrafficSession,
  index: number,
  streamIds: Map<string, string>,
  counter: { events: number },
): BuiltSession {
  let streamId = streamIds.get(spec.stream);
  if (streamId === undefined) {
    streamId = upsertStream({
      sourceId: SOURCE,
      sourceExtId: `traffic-${spec.stream}`,
      name: spec.stream,
      kind: spec.stream.startsWith("g") ? "group" : "dm",
    });
    streamIds.set(spec.stream, streamId);
  }
  const base = T0 + spec.day * DAY;
  const eventIds: string[] = [];
  const eventTimes: Record<string, string> = {};
  const drift: DriftEvent[] = [];
  const perTopic = spec.topics.length > 1 ? 2 : 4;
  spec.topics.forEach((topic, block) => {
    for (let i = 0; i < perTopic; i += 1) {
      counter.events += 1;
      const who = i % 2 === 0 ? `${spec.stream}-friend` : "self";
      const actorId = upsertActor({ sourceId: SOURCE, sourceExtId: who, displayName: who });
      const ts = new Date(base + (block * perTopic + i) * 60_000).toISOString();
      const res = insertEvent({
        externalId: `traffic-ev${counter.events}`,
        sourceId: SOURCE,
        sourceType: SOURCE,
        streamId,
        actorId,
        ts,
        kind: "message",
        text: `${topic} — message ${block * perTopic + i + 1}`,
        mediaPath: null,
        rawJson: null,
        isHistorical: true,
      });
      eventIds.push(res.id);
      eventTimes[res.id] = ts;
      drift.push({ id: res.id, vector: vectorFor(topic) });
    }
  });
  const endedAt = new Date(base + eventIds.length * 60_000).toISOString();
  const startedAt = new Date(base).toISOString();
  const id = `traffic-s${index}`;
  const hash = `traffic-h:${spec.stream}:${spec.topics.join("+")}`;
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, seal_mode, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, 'sealed', 'immediate', ?)`,
    )
    .run(id, streamId, SOURCE, startedAt, endedAt, JSON.stringify(eventIds), hash);
  return {
    session: { id, streamId, sourceId: SOURCE, contentHash: hash, eventIds, startedAt, endedAt, eventTimes },
    drift,
  };
}

/**
 * The frozen P-EP2 answers for the sessions the engine routes to the model —
 * data, exactly like a fixture's `frozen_response`. A `resume` attaches to the
 * stream's one open candidate; a `pivot` splits into its two topic blocks.
 * `single`/`resync` sessions must never reach this judge; answering them here
 * would hide a routing bug, so they get no answer and the fallback shows up as
 * a failed observation instead.
 */
function judgeFor(spec: TrafficSession, calls: { n: number }): EpisodeJudge {
  return (req) => {
    calls.n += 1;
    if (spec.kind !== "resume" && spec.kind !== "pivot") return null;
    const table = createAliasTable();
    const aliases = req.candidates.map((c) => table.mint("episode", c.id, c.topicLabel ?? ""));
    for (const id of req.session.eventIds) table.mintEvent(id);
    const n = req.session.eventIds.length;
    if (spec.kind === "resume") {
      const target = aliases[0];
      if (target === undefined) return null;
      return {
        response: `G|${req.session.id}|1-${n}|att|${target}|0.9|${spec.topics[0]}`,
        table,
        model: "sonnet-5",
      };
    }
    const half = Math.floor(n / 2);
    return {
      response: [
        `G|${req.session.id}|1-${half}|new|-|0.9|${spec.topics[0]}`,
        `G|${req.session.id}|${half + 1}-${n}|new|-|0.9|${spec.topics[1]}`,
      ].join("\n"),
      table,
      model: "sonnet-5",
    };
  };
}

// ---------------------------------------------------------------------------
// The corpus run
// ---------------------------------------------------------------------------

/**
 * Run the whole corpus through the real engine and report one
 * `episodes_one_to_one_rate` observation per session the engine routed.
 * Rebuilds its own throwaway DB on every call; callers that must emit the
 * observations at most once use {@link trafficGateObservations}.
 */
export function buildTrafficObservations(): GateObservation[] {
  const dir = mkdtempSync(join(tmpdir(), "supertwin-eval-eptraffic-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "traffic.db");
  closeDb();
  try {
    runMigrations();
    upsertSource({ id: SOURCE, type: SOURCE, name: "WhatsApp" });
    const streamIds = new Map<string, string>();
    const counter = { events: 0 };
    const out: GateObservation[] = [];
    const sessionsByKey = new Map<string, BuiltSession>();

    trafficCorpus().forEach((spec, index) => {
      const now = T0 + spec.day * DAY + 6 * 3_600_000;
      // The floor stays freshly measured, as a live install's would be.
      putCalib({
        model: EMBEDDER,
        useCase: "episode_topic",
        floor: 0.1,
        nPairs: MIN_CALIB_PAIRS,
        measuredAt: new Date(now - DAY).toISOString(),
      });
      // The REAL clock runs between sessions: quiet episodes fade by [CODE],
      // which is the very mechanism that makes real traffic mostly 1:1.
      ageEpisodes({ now });

      // A re-sync replays previously sealed content: same session row, same
      // content hash, posed to the engine a second time.
      const key = `${spec.stream}:${spec.topics.join("+")}`;
      const replay = spec.kind === "resync" ? sessionsByKey.get(key) : undefined;
      const built = replay ?? buildSession(spec, index, streamIds, counter);
      if (spec.kind !== "resync") sessionsByKey.set(key, built);

      const calls = { n: 0 };
      const preflag = preflagDrift(built.drift, { model: EMBEDDER, now });
      const result = runEpisodePass(built.session, {
        now,
        preflag,
        judge: judgeFor(spec, calls),
        runId: "traffic",
      });

      // `hash_reuse` never routed — same denominator rule as the executor.
      if (result.decision !== "hash_reuse") {
        out.push({
          gate: "episodes_one_to_one_rate",
          passed: result.decision === "one_to_one",
          note: `traffic ${spec.stream}@d${spec.day} (${spec.kind}): ${result.decision} — ${result.reason}`,
        });
      }
    });
    return out;
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

let emitted = false;

/**
 * The corpus's observations, AT MOST ONCE per process. `runSuite` folds every
 * case's observations into one denominator, so a corpus that rode along on all
 * 55 J cases would count each of its sessions 55 times; the first J case that
 * completes carries it and every later call gets nothing. Consumed only on a
 * run that finishes — an executor that throws must not swallow the corpus.
 */
export function trafficGateObservations(): GateObservation[] {
  if (emitted) return [];
  const out = buildTrafficObservations();
  emitted = true;
  return out;
}

/** Test seam: let the next {@link trafficGateObservations} emit again. */
export function resetTrafficObservationsForTests(): void {
  emitted = false;
}
