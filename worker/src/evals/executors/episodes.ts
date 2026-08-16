// ===========================================================================
// [CODE] Category J executor — the real episode engine (build item 2.1).
//
// J is `[CODE]` everywhere except the P-EP2 answer itself, so `frozen_response`
// carries a SCENARIO — one `tag|key=value|…` record per line — and, beneath a
// `#EP2 <session>` header, the frozen model answer for that session. Both
// halves are read here and nowhere else. Every number below comes back out of
// `worker/src/episodes/*` over a real temp SQLite DB with real migrations:
// nothing here re-implements the hash gate, the drift pre-flag, the 1:1
// default, the partition invariant, the confidence floor or the 14-day clock.
//
// Scenario records:
//
//   calib|floor=0.1                 the frozen `episode_topic` floor. Omit the
//                                   record with `calib|none=1` to pose a case
//                                   on an UNCALIBRATED model.
//   session|id=s1|stream=c1|events=1-4|hash=h1|ended_days=0
//   run|session=s1                  one episode pass
//   rerun|session=s1|times=4        replay — the hash gate should absorb it
//   age                             the 14-day clock, [CODE]
//
// Open episodes come from `given.open.episodes` (that is what the field is
// for): `{alias, stream, label, last_active_days}`.
//
// THE FROZEN [ML] LAYER. `preflagDrift` needs vectors, and an eval must not
// load an embedding model. Each fixture event carries a `topic` tag, and this
// file turns the fixture's distinct topics into orthogonal unit vectors — the
// embedder's answer, frozen exactly like the model's. An event with no `topic`
// is a placeholder and carries no signal, which is §12.3's rule and not a
// convenience. The drift measurement, the calibration gate and the routing are
// then the real ones.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { putCalib } from "../../db/calib.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../../db/ingest.js";
import { ageEpisodes } from "../../episodes/aging.js";
import { auditAttaches } from "../../episodes/audit.js";
import { partitions, runEpisodePass, type EngineSession, type EpisodeJudge } from "../../episodes/engine.js";
import { preflagDrift, type DriftEvent, type PreflagResult } from "../../episodes/preflag.js";
import { MIN_CALIB_PAIRS } from "../../retrieval/calibration-floor.js";
import { createAliasTable } from "../../wire/aliases.js";
import { trafficGateObservations } from "./episodes-traffic.js";
import type { Fixture, FixtureEvent } from "../fixtures.js";
import type { Executor, GateObservation, Produced } from "../runner.js";

const SOURCE = "whatsapp";
const EMBEDDER = "eval-embedder";
/** The instant every case is posed relative to. Frozen, so it is offline. */
const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

interface Line {
  tag: string;
  fields: Record<string, string>;
}

/** Splits the scenario from the frozen P-EP2 answers, keyed by session. */
function parseResponse(text: string): { scenario: Line[]; answers: Map<string, string> } {
  const scenario: Line[] = [];
  const answers = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== null) answers.set(current, buffer.join("\n"));
    current = null;
    buffer = [];
  };
  for (const raw of (typeof text === "string" ? text : "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EP2")) {
      flush();
      current = line.slice(4).trim();
      continue;
    }
    if (current !== null) {
      if (line !== "") buffer.push(line);
      continue;
    }
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`episodes scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    scenario.push({ tag, fields });
  }
  flush();
  return { scenario, answers };
}

/** `1-4`, `1,2,5`, `1-2,7` — the fixture's event ordinals. */
function parseOrdinals(raw: string | undefined): number[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`episodes scenario: ${JSON.stringify(part)} is not an event list`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    for (let n = lo; n <= hi; n += 1) out.push(n);
  }
  return out;
}

function num(fields: Record<string, string>, key: string, fallback: number): number {
  const raw = fields[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`episodes scenario: ${key}=${raw} is not a number`);
  return n;
}

// ---------------------------------------------------------------------------
// The world the fixture describes
// ---------------------------------------------------------------------------

interface OpenEpisodeSpec {
  alias: string;
  stream: string;
  label: string;
  last_active_days?: number;
}

class World {
  private dir: string | null = null;
  /** Stream alias (`c1`) → real stream id. */
  readonly streams = new Map<string, string>();
  /** Fixture event ordinal → real event id. */
  readonly events = new Map<number, string>();
  /** Event ordinal → topic tag, or null for a placeholder. */
  readonly topics = new Map<number, string | null>();
  /** Topic tag → one-hot index. The frozen embedding space. */
  private readonly topicIndex = new Map<string, number>();
  /** Episode id → the alias the fixture speaks in (`e1`, or a minted `n1`). */
  readonly aliases = new Map<string, string>();
  private minted = 0;

  open(): void {
    if (this.dir) return;
    this.dir = mkdtempSync(join(tmpdir(), "supertwin-eval-ep-"));
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

  build(fixture: Fixture): void {
    this.open();
    for (const stream of fixture.given.streams) {
      const id = upsertStream({
        sourceId: SOURCE,
        sourceExtId: stream.alias,
        name: stream.name,
        kind: stream.kind === "group" ? "group" : "dm",
      });
      this.streams.set(stream.alias, id);
    }
    // Topic order follows first appearance, so the frozen space is stable.
    for (const event of fixture.given.events) {
      const topic = typeof event.topic === "string" && event.topic !== "" ? event.topic : null;
      this.topics.set(event.n, topic);
      if (topic !== null && !this.topicIndex.has(topic)) this.topicIndex.set(topic, this.topicIndex.size);
    }
    for (const event of fixture.given.events) this.event(event);
    for (const spec of fixture.given.open.episodes as OpenEpisodeSpec[]) this.episode(spec);
  }

  private event(event: FixtureEvent): void {
    const streamAlias = typeof event.c === "string" ? event.c : (this.streams.keys().next().value as string);
    const streamId = this.streams.get(streamAlias);
    if (streamId === undefined) throw new Error(`episodes: event ${event.n} names unknown stream ${streamAlias}`);
    const actorId = upsertActor({ sourceId: SOURCE, sourceExtId: event.who, displayName: event.who });
    const res = insertEvent({
      externalId: `ev${event.n}`,
      sourceId: SOURCE,
      sourceType: SOURCE,
      streamId,
      actorId,
      ts: new Date(Date.parse(event.ts)).toISOString(),
      kind: "message",
      text: event.text,
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    });
    this.events.set(event.n, res.id);
  }

  private episode(spec: OpenEpisodeSpec): void {
    const streamId = this.streams.get(spec.stream);
    if (streamId === undefined) throw new Error(`episodes: open episode names unknown stream ${spec.stream}`);
    const id = `ep_${spec.alias}`;
    const last = NOW - (spec.last_active_days ?? 0) * DAY;
    getDb()
      .prepare(
        `INSERT INTO episodes (id, stream_id, source_id, topic_label, label_source, session_ids,
                               event_ids, entity_ids, arc_state, started_at, ended_at)
         VALUES (?, ?, ?, ?, 'model', '[]', '[]', '[]', 'open', ?, ?)`,
      )
      .run(id, streamId, SOURCE, spec.label, new Date(last - 3_600_000).toISOString(), new Date(last).toISOString());
    this.aliases.set(id, spec.alias);
  }

  /** The frozen embedding: one orthogonal axis per topic in this fixture. */
  vectorFor(ordinal: number): number[] | null {
    const topic = this.topics.get(ordinal) ?? null;
    if (topic === null) return null;
    const dim = Math.max(2, this.topicIndex.size);
    const vec = new Array<number>(dim).fill(0);
    vec[this.topicIndex.get(topic)!] = 1;
    return vec;
  }

  /** The stream alias (`c1`) behind a real stream id. */
  streamAliasOf(streamId: string): string {
    for (const [alias, id] of this.streams) if (id === streamId) return alias;
    return streamId;
  }

  /** The alias the fixture speaks in. New episodes get `n1`, `n2`, … */
  aliasOf(episodeId: string): string {
    const known = this.aliases.get(episodeId);
    if (known !== undefined) return known;
    this.minted += 1;
    const alias = `n${this.minted}`;
    this.aliases.set(episodeId, alias);
    return alias;
  }
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

interface Acc {
  output: Record<string, unknown[]>;
  state: Record<string, unknown>;
  metrics: Record<string, number>;
  /** §14.2 rows this run measured beyond the case's own assertion. */
  gates: GateObservation[];
}

function bucket(acc: Acc, name: string): unknown[] {
  acc.output[name] ??= [];
  return acc.output[name]!;
}

interface SessionSpec {
  id: string;
  streamAlias: string;
  ordinals: number[];
  hash: string;
  endedDays: number;
}

export const episodesExecutor: Executor = (ctx): Produced => {
  const { scenario, answers } = parseResponse(ctx.response);
  const acc: Acc = { output: {}, state: {}, metrics: {}, gates: [] };
  const world = new World();
  const sessions = new Map<string, SessionSpec>();

  let calls = 0;
  let decided = 0;
  let oneToOne = 0;
  let attaches = 0;
  let wrongAttaches = 0;
  let partitionOk = true;
  const decisions: string[] = [];
  /** What each run landed on, so "identical episodes" is a comparison. */
  const landings: string[] = [];

  try {
    world.build(ctx.fixture);

    // The frozen calibration floor, unless the case deliberately withholds it.
    if (!scenario.some((l) => l.tag === "calib" && l.fields.none === "1")) {
      const floor = scenario.find((l) => l.tag === "calib")?.fields.floor;
      putCalib({
        model: EMBEDDER,
        useCase: "episode_topic",
        floor: floor === undefined ? 0.1 : Number(floor),
        nPairs: MIN_CALIB_PAIRS,
        measuredAt: new Date(NOW - DAY).toISOString(),
      });
    }

    const runOnce = (spec: SessionSpec, replay: boolean): void => {
      const session = sessionOf(spec);
      const drift: DriftEvent[] = spec.ordinals.map((n) => ({
        id: world.events.get(n)!,
        vector: world.vectorFor(n),
        placeholder: world.vectorFor(n) === null,
      }));
      const preflag: PreflagResult = preflagDrift(drift, { model: EMBEDDER, now: NOW });

      const judge: EpisodeJudge = (req) => {
        const frozen = answers.get(spec.id);
        calls += 1;
        bucket(acc, "calls").push({ session: spec.id, frozen: frozen !== undefined });
        if (frozen === undefined) return null;
        const table = createAliasTable();
        for (const candidate of req.candidates) table.mint("episode", candidate.id, candidate.topicLabel ?? "");
        for (const id of req.session.eventIds) table.mintEvent(id);
        return { response: frozen, table, model: "sonnet-5" };
      };

      const result = runEpisodePass(session, { now: NOW, preflag, judge, runId: replay ? "replay" : "first" });
      decisions.push(result.decision);
      if (result.decision !== "hash_reuse") {
        decided += 1;
        if (result.decision === "one_to_one") oneToOne += 1;
        // §14.2's `1:1 default rate`, one observation per session the engine
        // ROUTED. Emitted on every case, not only on the fourteen that name
        // the gate — a rate whose denominator is chosen by the fixtures is a
        // rate about the fixtures. `hash_reuse` never routed, so it is not in
        // the denominator; `one_to_one_fallback` routed to the model and only
        // landed on 1:1 because no judge answered, so it is not in the
        // numerator either.
        acc.gates.push({
          gate: "episodes_one_to_one_rate",
          passed: result.decision === "one_to_one",
          note: `${spec.id}: ${result.decision} — ${result.reason}`,
        });
      }
      // The partition invariant is measured on EVERY run, not only on the
      // cases that spent their one `assert.gate` on it (§11.1 rule 1).
      const partitioned = partitions(session.eventIds, result.segments);
      if (!partitioned) partitionOk = false;
      acc.gates.push({
        gate: "episodes_split_attach_accuracy",
        passed: partitioned,
        note: partitioned ? undefined : `${spec.id}: segments do not partition the session`,
      });

      const ordinalOf = new Map([...world.events].map(([n, id]) => [id, n] as const));
      if (!replay) {
        for (const candidate of result.candidates) {
          bucket(acc, "candidates").push({ session: spec.id, episode: world.aliasOf(candidate.id) });
        }
      }
      for (const segment of result.segments) {
        if (!replay) {
          bucket(acc, "segments").push({
            session: spec.id,
            events: segment.eventIds.map((id) => ordinalOf.get(id) ?? id).join(","),
            decision: segment.decision,
            episode: world.aliasOf(segment.episodeId),
            label: segment.label,
          });
        }
      }
      if (!replay) {
        bucket(acc, "verdicts").push({
          session: spec.id,
          decision: result.decision,
          model_calls: result.modelCalls,
        });
      }
      acc.state.decision = result.decision;
      acc.state.preflag_drift = preflag.drift;
      acc.state.preflag_reason = preflag.reason;
      acc.state.segments = result.segments.length;
      landings.push(result.segments.map((s) => world.aliasOf(s.episodeId)).join(","));
      acc.state.episode_ids = result.segments.map((s) => world.aliasOf(s.episodeId));
    };

    for (const line of scenario) {
      switch (line.tag) {
        case "calib":
          break;
        case "session": {
          const spec: SessionSpec = {
            id: line.fields.id ?? "s1",
            streamAlias: line.fields.stream ?? "c1",
            ordinals: parseOrdinals(line.fields.events),
            hash: line.fields.hash ?? `h_${line.fields.id ?? "s1"}`,
            endedDays: num(line.fields, "ended_days", 0),
          };
          sessions.set(spec.id, spec);
          insertSession(world, spec);
          break;
        }
        case "run": {
          const spec = sessions.get(line.fields.session ?? "");
          if (!spec) throw new Error(`episodes scenario: run names unknown session ${line.fields.session}`);
          runOnce(spec, false);
          break;
        }
        case "rerun": {
          const spec = sessions.get(line.fields.session ?? "");
          if (!spec) throw new Error(`episodes scenario: rerun names unknown session ${line.fields.session}`);
          const times = num(line.fields, "times", 1);
          const before = calls;
          const landedBefore = landings[landings.length - 1];
          for (let i = 0; i < times; i += 1) runOnce(spec, true);
          // "identical episodes; verdicts reused; ZERO new calls" — all three.
          const stable = landings.every((l) => l === landedBefore);
          acc.gates.push({
            gate: "episodes_verdict_replay",
            passed: calls === before && stable,
            note: calls === before && stable ? undefined : `${spec.id}: replay drifted or re-judged`,
          });
          break;
        }
        case "age": {
          for (const faded of ageEpisodes({ now: NOW })) {
            bucket(acc, "faded").push({
              episode: world.aliasOf(faded.episodeId),
              arc_state: faded.arcState,
              outcome: faded.outcome,
              quiet_days: faded.quietDays,
            });
          }
          break;
        }
        default:
          throw new Error(`episodes scenario: unknown record ${JSON.stringify(line.tag)}`);
      }
    }

    // The world as it ended up: one row per episode, in the fixture's own
    // aliases. This is what "TWO separate episodes" is asserted on. Ordered by
    // ALIAS, not by row id: an id is a hash, and a hash is not an order a human
    // can predict, which an `exact` expectation has to be able to do.
    const rows = getDb()
      .prepare(`SELECT id, stream_id, topic_label, arc_state, outcome FROM episodes ORDER BY created_at, id`)
      .all() as { id: string; stream_id: string; topic_label: string | null; arc_state: string; outcome: string | null }[];
    const listed = rows.map((row) => ({
      episode: world.aliasOf(row.id),
      stream: world.streamAliasOf(row.stream_id),
      label: row.topic_label,
      arc_state: row.arc_state,
      outcome: row.outcome,
    }));
    listed.sort((a, b) => byAlias(a.episode, b.episode));
    for (const entry of listed) bucket(acc, "episodes").push(entry);

    if (decisions.length > 0) {
      acc.state.decisions = decisions;
      acc.state.model_calls = calls;
      acc.state.partition_ok = partitionOk;
      acc.state.episodes = (acc.output.episodes ?? []).length;
      acc.state.stable_ids = landings.every((l) => l === landings[0]);
    }
    acc.metrics.model_calls = calls;
    // A run that decided nothing measured nothing. Reporting 1 here would hand
    // `episodes_one_to_one_rate` a perfect score it never earned; gates.ts's
    // rule is that an unmeasured gate reads `no data`, never `pass`.
    if (decided > 0) acc.metrics.one_to_one_rate = oneToOne / decided;

    // §14.2's `wrong-attach rate`, measured off the ROWS by `episodes/audit.ts`
    // — stream scope, the 0.6 floor and attribution — rather than by asking
    // whether the engine's own candidate list contains the target it picked
    // out of that same list. Emitted as an observation so every case that
    // attached anything feeds the gate, not only the twelve that name it.
    const attachAudit = auditAttaches();
    attaches = attachAudit.length;
    wrongAttaches = attachAudit.filter((a) => !a.ok).length;
    if (attaches > 0) {
      acc.metrics.wrong_attach_rate = wrongAttaches / attaches;
      acc.gates.push({
        gate: "episodes_wrong_attach_rate",
        passed: wrongAttaches === 0,
        value: wrongAttaches / attaches,
        note: attachAudit.find((a) => !a.ok)?.reason,
      });
    }
    acc.state.attaches = attaches;
    acc.state.wrong_attaches = wrongAttaches;
  } finally {
    world.close();
  }

  // §14.2's "1:1 default rate" is a rate over TRAFFIC, and the J table is a
  // coverage matrix, not traffic (see episodes-traffic.ts). The representative
  // corpus rides with the first J case that completes — once per suite, so the
  // gate's denominator holds each of its sessions exactly once.
  acc.gates.push(...trafficGateObservations());

  return { output: acc.output, state: acc.state, metrics: acc.metrics, gates: acc.gates };
};

/** `e1` before `e2` before `n1`, and `n2` after `n1` — never lexicographic. */
function byAlias(a: string, b: string): number {
  const split = (t: string) => [t.replace(/[0-9]+$/, ""), Number(/[0-9]+$/.exec(t)?.[0] ?? 0)] as const;
  const [pa, na] = split(a);
  const [pb, nb] = split(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  return na - nb;
}

function insertSession(world: World, spec: SessionSpec): void {
  const streamId = world.streams.get(spec.streamAlias);
  if (streamId === undefined) throw new Error(`episodes: session names unknown stream ${spec.streamAlias}`);
  const eventIds = spec.ordinals.map((n) => {
    const id = world.events.get(n);
    if (id === undefined) throw new Error(`episodes: session names unknown event ${n}`);
    return id;
  });
  const endedAt = new Date(NOW - spec.endedDays * DAY).toISOString();
  const startedAt = new Date(NOW - spec.endedDays * DAY - 3_600_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, seal_mode, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, 'sealed', 'immediate', ?)`,
    )
    .run(spec.id, streamId, SOURCE, startedAt, endedAt, JSON.stringify(eventIds), spec.hash);
}

function sessionOf(spec: SessionSpec): EngineSession {
  const row = getDb()
    .prepare(`SELECT stream_id, started_at, ended_at, event_ids, content_hash FROM sessions WHERE id = ?`)
    .get(spec.id) as {
    stream_id: string;
    started_at: string;
    ended_at: string;
    event_ids: string;
    content_hash: string;
  };
  return {
    id: spec.id,
    streamId: row.stream_id,
    sourceId: SOURCE,
    contentHash: row.content_hash,
    eventIds: JSON.parse(row.event_ids) as string[],
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
