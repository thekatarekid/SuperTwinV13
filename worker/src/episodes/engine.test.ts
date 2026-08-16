// ===========================================================================
// The episode engine (arch §11.1, build item 2.1) over a real SQLite DB with
// real migrations, a real STW-2 parse and a real alias table.
//
// The judge is a stub because the PROMPT is item 2.2's; everything downstream
// of the answer — the hash gate, the pre-flag gate, the 1:1 default, the
// partition invariant, the confidence floor, stream scoping and replay — is
// the product code under test.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { upsertSource, upsertStream } from "../db/ingest.js";
import { createAliasTable, type AliasTable } from "../wire/aliases.js";
import {
  ATTACH_CONFIDENCE_FLOOR,
  episodeIdFor,
  partitions,
  repairPartition,
  runEpisodePass,
  segmentsFromWire,
  type EngineSession,
  type EpisodeJudge,
} from "./engine.js";
import type { PreflagResult } from "./preflag.js";
import { readEpisode, readOpenEpisodes, readVerdictForSession, countVerdicts } from "./store.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

let tmpDir: string;
let C1 = "";
let C2 = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-episodes-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  C1 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Rohan", kind: "dm" });
  C2 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c2", name: "Family", kind: "group" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- fixtures --------------------------------------------------------------

function session(id: string, streamId: string, events: string[], hash: string, endedAgoMs = 0): EngineSession {
  const startedAt = new Date(NOW - endedAgoMs - 3_600_000).toISOString();
  const endedAt = new Date(NOW - endedAgoMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
       VALUES (?, ?, 'whatsapp', ?, ?, ?, 'sealed', ?)`,
    )
    .run(id, streamId, startedAt, endedAt, JSON.stringify(events), hash);
  return { id, streamId, sourceId: "whatsapp", contentHash: hash, eventIds: events, startedAt, endedAt };
}

function openEpisode(id: string, streamId: string, label: string, agoDays: number): void {
  getDb()
    .prepare(
      `INSERT INTO episodes (id, stream_id, topic_label, label_source, arc_state, started_at, ended_at, session_ids, event_ids, entity_ids)
       VALUES (?, ?, ?, 'model', 'open', ?, ?, '[]', '[]', '[]')`,
    )
    .run(
      id,
      streamId,
      label,
      new Date(NOW - (agoDays + 1) * DAY).toISOString(),
      new Date(NOW - agoDays * DAY).toISOString(),
    );
}

const NO_DRIFT: PreflagResult = {
  drift: false,
  measured: true,
  score: 0.9,
  cosine: 0.9,
  cutAfterEventId: null,
  leftEventIds: [],
  rightEventIds: [],
  signalEvents: 4,
  reason: "single_topic",
  decision: null,
  detail: "measured, one topic",
};

const DRIFT: PreflagResult = { ...NO_DRIFT, drift: true, score: 0.1, cosine: 0.1, reason: "drift" };

/** A judge that returns a frozen answer over a table minted the way P-EP2 will. */
function judgeOf(
  response: string,
  opts: { episodes?: { id: string; label: string }[]; events?: string[]; calls?: number } = {},
): { judge: EpisodeJudge; calls: () => number; table: AliasTable } {
  const table = createAliasTable();
  let calls = 0;
  const judge: EpisodeJudge = (req) => {
    calls += 1;
    for (const ep of opts.episodes ?? req.candidates.map((c) => ({ id: c.id, label: c.topicLabel ?? "" }))) {
      table.mint("episode", ep.id, ep.label);
    }
    for (const id of opts.events ?? req.session.eventIds) table.mintEvent(id);
    return { response, table, model: "sonnet-5", calls: opts.calls };
  };
  return { judge, calls: () => calls, table };
}

// ---- ids -------------------------------------------------------------------

describe("episode ids", () => {
  it("are derived from stream, anchor and label, so re-derivation rebinds", () => {
    const a = episodeIdFor(C1, "e1", "Villa shortlist for Goa");
    expect(episodeIdFor(C1, "e1", "  villa   SHORTLIST for goa ")).toBe(a);
    expect(episodeIdFor(C2, "e1", "Villa shortlist for Goa")).not.toBe(a);
    expect(episodeIdFor(C1, "e2", "Villa shortlist for Goa")).not.toBe(a);
  });
});

// ---- the partition invariant ----------------------------------------------

describe("repairPartition", () => {
  const ids = ["a", "b", "c", "d"];
  const seg = (eventIds: string[], label = "t") => ({
    eventIds,
    decision: "new" as const,
    episodeId: null,
    confidence: 0.9,
    label,
  });

  it("leaves a clean partition alone", () => {
    const out = repairPartition(ids, [seg(["a", "b"]), seg(["c", "d"])]);
    expect(out.repairs).toEqual([]);
    expect(partitions(ids, out.segments)).toBe(true);
  });

  it("gives a doubly-claimed event to the first claim", () => {
    const out = repairPartition(ids, [seg(["a", "b"]), seg(["b", "c", "d"])]);
    expect(out.segments.map((s) => s.eventIds)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(out.repairs.map((r) => r.kind)).toEqual(["duplicate_event"]);
    expect(partitions(ids, out.segments)).toBe(true);
  });

  it("never writes an event that is not a member of the session", () => {
    const out = repairPartition(ids, [seg(["a", "b", "zz"]), seg(["c", "d"])]);
    expect(out.repairs[0]!.kind).toBe("foreign_event");
    expect(out.repairs[0]!.eventIds).toEqual(["zz"]);
    expect(partitions(ids, out.segments)).toBe(true);
  });

  it("places uncovered events with the nearest preceding segment", () => {
    const out = repairPartition(ids, [seg(["a"]), seg(["c"])]);
    expect(out.segments.map((s) => s.eventIds)).toEqual([["a", "b"], ["c", "d"]]);
    expect(out.repairs.map((r) => r.kind)).toEqual(["uncovered_events"]);
    expect(partitions(ids, out.segments)).toBe(true);
  });

  it("collapses to one segment when nothing survives", () => {
    const out = repairPartition(ids, [seg(["zz"])]);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]!.eventIds).toEqual(ids);
    expect(out.repairs.map((r) => r.kind)).toEqual(["foreign_event", "empty_segment", "no_segments"]);
  });

  it("keeps the invariant on every shape thrown at it", () => {
    const shapes = [
      [] as string[][],
      [["d", "a"]],
      [["a", "a", "a"]],
      [["b"], ["b"], ["c"]],
      [["a", "b"], [], ["c", "d"]],
    ];
    for (const shape of shapes) {
      const out = repairPartition(ids, shape.map((s) => seg(s)));
      expect(partitions(ids, out.segments)).toBe(true);
    }
  });
});

// ---- reading the answer ----------------------------------------------------

describe("segmentsFromWire", () => {
  it("reads G lines through the real parser and the prompt's alias table", () => {
    const table = createAliasTable();
    table.mint("episode", "ep_open", "villa shortlist for Goa");
    for (const id of ["ev1", "ev2", "ev3", "ev4"]) table.mintEvent(id);
    const candidates = [
      { id: "ep_open", streamId: C1, topicLabel: "villa shortlist for Goa", lastActiveAt: null, entityIds: [] },
    ];
    const read = segmentsFromWire(
      ["G|s1|1,2|att|e1|0.93|villa shortlist for Goa", "G|s1|3,4|new|-|0.85|mom's medical reports"].join("\n"),
      table,
      candidates,
    );
    expect(read.segments).toHaveLength(2);
    expect(read.segments[0]).toMatchObject({
      eventIds: ["ev1", "ev2"],
      decision: "attach",
      episodeId: "ep_open",
      confidence: 0.93,
      label: "villa shortlist for Goa",
    });
    expect(read.segments[1]).toMatchObject({ eventIds: ["ev3", "ev4"], decision: "new", episodeId: null });
  });

  it("§11.1 rule 6 — an attach under the floor becomes a new episode", () => {
    const table = createAliasTable();
    table.mint("episode", "ep_open", "goa trip");
    table.mintEvent("ev1");
    table.mintEvent("ev2");
    const candidates = [
      { id: "ep_open", streamId: C1, topicLabel: "goa trip", lastActiveAt: null, entityIds: [] },
    ];
    const read = segmentsFromWire("G|s1|1,2|att|e1|0.55|goa trip", table, candidates);
    expect(read.segments[0]!.decision).toBe("new");
    expect(read.segments[0]!.episodeId).toBeNull();
    expect(read.segments[0]!.demotedReason).toContain(String(ATTACH_CONFIDENCE_FLOOR));
    // The model's words survive the demotion.
    expect(read.segments[0]!.label).toBe("goa trip");
  });

  it("refuses an attach to an episode that was never a candidate", () => {
    const table = createAliasTable();
    table.mint("episode", "ep_other_stream", "goa trip");
    table.mintEvent("ev1");
    table.mintEvent("ev2");
    const read = segmentsFromWire("G|s1|1,2|att|e1|0.99|goa trip", table, []);
    expect(read.segments[0]!.decision).toBe("new");
    expect(read.segments[0]!.demotedReason).toContain("not an open episode of this stream");
  });

  it("reports an unresolvable event instead of guessing one", () => {
    const table = createAliasTable();
    table.mintEvent("ev1");
    const read = segmentsFromWire("G|s1|7,8|new|-|0.9|whatever", table, []);
    expect(read.segments).toHaveLength(0);
    expect(read.unresolved.length).toBeGreaterThan(0);
  });
});

// ---- the pass --------------------------------------------------------------

describe("runEpisodePass", () => {
  it("§11.1 default: no drift and no open episodes → 1:1, zero calls", () => {
    const s = session("s1", C1, ["ev1", "ev2", "ev3"], "h1");
    const stub = judgeOf("G|s1|1|new|-|0.9|nope");
    const result = runEpisodePass(s, { now: NOW, preflag: NO_DRIFT, judge: stub.judge });

    expect(result.decision).toBe("one_to_one");
    expect(result.modelCalls).toBe(0);
    expect(stub.calls()).toBe(0);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.eventIds).toEqual(["ev1", "ev2", "ev3"]);
    // No model ran, so no label was invented.
    expect(result.segments[0]!.label).toBeNull();
    expect(result.episodes[0]!.topicLabel).toBeNull();
    expect(result.episodes[0]!.labelSource).toBe("derived");
    expect(result.episodes[0]!.arcState).toBe("open");
  });

  it("buys the call when the pre-flag flags drift, even with no candidates", () => {
    const s = session("s1", C1, ["ev1", "ev2", "ev3", "ev4"], "h1");
    const stub = judgeOf(
      ["G|s1|1,2|new|-|0.9|goa villa shortlist", "G|s1|3,4|new|-|0.88|rabies shots"].join("\n"),
    );
    const result = runEpisodePass(s, { now: NOW, preflag: DRIFT, judge: stub.judge });

    expect(result.decision).toBe("judged");
    expect(result.modelCalls).toBe(1);
    expect(result.segments.map((x) => x.eventIds)).toEqual([
      ["ev1", "ev2"],
      ["ev3", "ev4"],
    ]);
    expect(partitions(s.eventIds, result.segments)).toBe(true);
    expect(result.episodes.map((e) => e.topicLabel)).toEqual(["goa villa shortlist", "rabies shots"]);
  });

  it("buys the call when the stream has an open episode, drift or not", () => {
    openEpisode("ep_goa", C1, "villa shortlist for Goa", 1);
    const s = session("s1", C1, ["ev1", "ev2"], "h1");
    const stub = judgeOf("G|s1|1,2|att|e1|0.93|villa shortlist for Goa");
    const result = runEpisodePass(s, { now: NOW, preflag: NO_DRIFT, judge: stub.judge });

    expect(result.decision).toBe("judged");
    expect(result.candidates.map((c) => c.id)).toEqual(["ep_goa"]);
    expect(result.segments[0]!.decision).toBe("attach");
    expect(result.segments[0]!.episodeId).toBe("ep_goa");
    expect(readEpisode("ep_goa")!.sessionIds).toEqual(["s1"]);
    expect(readEpisode("ep_goa")!.eventIds).toEqual(["ev1", "ev2"]);
  });

  it("falls back to 1:1 — and says so — when the judge answers with prose", () => {
    const s = session("s1", C1, ["ev1", "ev2"], "h1");
    const stub = judgeOf("I think this is all one topic, really.");
    const result = runEpisodePass(s, { now: NOW, preflag: DRIFT, judge: stub.judge });

    expect(result.decision).toBe("one_to_one_fallback");
    expect(result.modelCalls).toBe(1);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.segments[0]!.eventIds).toEqual(["ev1", "ev2"]);
  });

  it("never offers another stream's episode as a candidate", () => {
    openEpisode("ep_goa_c2", C2, "Goa trip", 1);
    const s = session("s1", C1, ["ev1", "ev2"], "h1");
    const result = runEpisodePass(s, { now: NOW, preflag: NO_DRIFT });
    expect(result.candidates).toEqual([]);
    expect(result.decision).toBe("one_to_one");
    expect(readOpenEpisodes(C1, { now: NOW })).toHaveLength(1);
    expect(readOpenEpisodes(C2, { now: NOW }).map((c) => c.id)).toEqual(["ep_goa_c2"]);
  });

  it("the same topic in two streams becomes two episodes", () => {
    const a = session("s1", C1, ["ev1", "ev2"], "h1");
    const b = session("s2", C2, ["ev3", "ev4"], "h2");
    const first = runEpisodePass(a, {
      now: NOW,
      preflag: DRIFT,
      judge: judgeOf("G|s1|1,2|new|-|0.9|Goa trip").judge,
    });
    const second = runEpisodePass(b, {
      now: NOW,
      preflag: DRIFT,
      judge: judgeOf("G|s2|1,2|new|-|0.9|Goa trip").judge,
    });
    expect(first.episodes[0]!.id).not.toBe(second.episodes[0]!.id);
    expect(first.episodes[0]!.streamId).toBe(C1);
    expect(second.episodes[0]!.streamId).toBe(C2);
  });

  it("does not offer an episode the 14-day clock has already retired", () => {
    openEpisode("ep_stale", C1, "old thing", 20);
    const s = session("s1", C1, ["ev1", "ev2"], "h1");
    const result = runEpisodePass(s, { now: NOW, preflag: NO_DRIFT });
    expect(result.candidates).toEqual([]);
    expect(result.decision).toBe("one_to_one");
  });

  it("persists a verdict on every path, 1:1 included", () => {
    const s = session("s1", C1, ["ev1", "ev2"], "h1");
    runEpisodePass(s, { now: NOW, preflag: NO_DRIFT, runId: "run-1" });
    const verdict = readVerdictForSession("s1")!;
    expect(verdict.decision).toBe("one_to_one");
    expect(verdict.runId).toBe("run-1");
    expect((verdict.output as { segments: unknown[] }).segments).toHaveLength(1);
  });

  it("§11.1 hash gate: the same content is judged once and replayed for free", () => {
    const s = session("s1", C1, ["ev1", "ev2", "ev3", "ev4"], "hash-A");
    const stub = judgeOf(
      ["G|s1|1,2|new|-|0.9|goa villa shortlist", "G|s1|3,4|new|-|0.88|rabies shots"].join("\n"),
    );
    const first = runEpisodePass(s, { now: NOW, preflag: DRIFT, judge: stub.judge });
    expect(first.decision).toBe("judged");
    expect(stub.calls()).toBe(1);

    const ids = first.episodes.map((e) => e.id);
    for (const run of [2, 3, 4, 5]) {
      const again = runEpisodePass(s, { now: NOW + run, preflag: DRIFT, judge: stub.judge });
      expect(again.decision).toBe("hash_reuse");
      expect(again.modelCalls).toBe(0);
      expect(again.episodes.map((e) => e.id)).toEqual(ids);
      expect(again.reusedVerdictId).not.toBeNull();
    }
    expect(stub.calls()).toBe(1);
    // Replay writes no twins: the same two episodes, with the same membership.
    const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM episodes`).get() as { n: number };
    expect(rows.n).toBe(2);
    expect(readEpisode(ids[0]!)!.sessionIds).toEqual(["s1"]);
    expect(countVerdicts()).toBe(5);
  });

  it("a re-segmented session with the same content reuses the same answer", () => {
    const s1 = session("s1", C1, ["ev1", "ev2"], "same-hash");
    const first = runEpisodePass(s1, {
      now: NOW,
      preflag: DRIFT,
      judge: judgeOf("G|s1|1,2|new|-|0.9|goa trip").judge,
    });
    // A different session id over identical content — §10.4's whole point.
    const s2 = session("s2", C1, ["ev1", "ev2"], "same-hash");
    const stub = judgeOf("G|s2|1,2|new|-|0.9|something else entirely");
    const second = runEpisodePass(s2, { now: NOW, preflag: DRIFT, judge: stub.judge });
    expect(second.decision).toBe("hash_reuse");
    expect(stub.calls()).toBe(0);
    expect(second.episodes[0]!.id).toBe(first.episodes[0]!.id);
    expect(readEpisode(second.episodes[0]!.id)!.sessionIds).toEqual(["s1", "s2"]);
  });

  it("a moved hash is a new question", () => {
    const s1 = session("s1", C1, ["ev1", "ev2"], "hash-before");
    runEpisodePass(s1, { now: NOW, preflag: DRIFT, judge: judgeOf("G|s1|1,2|new|-|0.9|goa trip").judge });
    const s2 = session("s2", C1, ["ev1", "ev2"], "hash-after");
    const stub = judgeOf("G|s2|1,2|new|-|0.9|goa trip with a caption");
    const result = runEpisodePass(s2, { now: NOW, preflag: DRIFT, judge: stub.judge });
    expect(result.decision).toBe("judged");
    expect(stub.calls()).toBe(1);
  });

  it("an unsealed session (no hash) is judged, never gated", () => {
    const s = session("s1", C1, ["ev1", "ev2"], "h1");
    const open: EngineSession = { ...s, contentHash: null };
    const stub = judgeOf("G|s1|1,2|new|-|0.9|goa trip");
    const result = runEpisodePass(open, { now: NOW, preflag: DRIFT, judge: stub.judge });
    expect(result.decision).toBe("judged");
    expect(stub.calls()).toBe(1);
  });

  it("repairs a broken partition and records what it did", () => {
    const s = session("s1", C1, ["ev1", "ev2", "ev3", "ev4"], "h1");
    // The model forgot ev4 and claimed ev2 twice.
    const stub = judgeOf(["G|s1|1,2|new|-|0.9|goa trip", "G|s1|2,3|new|-|0.9|rabies shots"].join("\n"));
    const result = runEpisodePass(s, { now: NOW, preflag: DRIFT, judge: stub.judge });
    expect(partitions(s.eventIds, result.segments)).toBe(true);
    expect(result.repairs.map((r) => r.kind)).toEqual(["duplicate_event", "uncovered_events"]);
    expect(result.segments.map((x) => x.eventIds)).toEqual([
      ["ev1", "ev2"],
      ["ev3", "ev4"],
    ]);
  });

  it("counts no call when there is no judge, and says why", () => {
    const s = session("s1", C1, ["ev1", "ev2"], "h1");
    const result = runEpisodePass(s, { now: NOW, preflag: DRIFT });
    expect(result.decision).toBe("one_to_one_fallback");
    expect(result.modelCalls).toBe(0);
    expect(result.reason).toContain("no judge");
  });
});
