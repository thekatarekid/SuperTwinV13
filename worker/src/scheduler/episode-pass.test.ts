// ===========================================================================
// The episode stage — the scheduler wiring that finally CALLS the engine.
//
// What is tested is the wiring, not the engine (episodes/*.test.ts owns that):
// a sealed session read back as the engine's view, the queue path that refuses
// to re-judge, the prefetch that spends a model call only when the engine
// would ask for one, and the aging clock that runs at most once a day.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import {
  drainEpisodeQueue,
  engineSessionOf,
  enqueueEpisodePasses,
  episodeAgingDue,
  episodePassAfterSeal,
  runEpisodeAging,
  runSessionEpisodePass,
  unjudgedSealedSessions,
} from "./episode-pass.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

let tmpDir: string;
let C1 = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-episode-pass-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  C1 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Rohan", kind: "dm" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function seal(id: string, texts: readonly string[], opts: { status?: string; streamId?: string } = {}): string[] {
  const streamId = opts.streamId ?? C1;
  const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "rohan", displayName: "Rohan" });
  const eventIds = texts.map(
    (text, i) =>
      insertEvent({
        externalId: `${id}-ev${i + 1}`,
        sourceId: "whatsapp",
        sourceType: "whatsapp",
        streamId,
        actorId: actor,
        ts: new Date(NOW - (texts.length - i) * 60_000).toISOString(),
        kind: "message",
        text,
        mediaPath: null,
        rawJson: null,
        isHistorical: true,
      }).id,
  );
  const stamp = new Date(NOW).toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
       VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?)`,
    )
    .run(id, streamId, stamp, stamp, JSON.stringify(eventIds), opts.status ?? "sealed", `h_${id}`);
  return eventIds;
}

function openEpisode(id: string, label: string, daysAgo = 1): void {
  const stamp = new Date(NOW - daysAgo * DAY).toISOString();
  getDb()
    .prepare(
      `INSERT INTO episodes (id, stream_id, source_id, topic_label, label_source, session_ids,
                             event_ids, entity_ids, arc_state, started_at, ended_at)
       VALUES (?, ?, 'whatsapp', ?, 'model', '[]', '[]', '[]', 'open', ?, ?)`,
    )
    .run(id, C1, label, stamp, stamp);
}

describe("engineSessionOf", () => {
  it("reads a sealed session back with its events' own timestamps", () => {
    const eventIds = seal("s1", ["deposit is due friday", "sending the villa link"]);
    const session = engineSessionOf("s1");
    expect(session).not.toBeNull();
    expect(session!.eventIds).toEqual(eventIds);
    expect(Object.keys(session!.eventTimes ?? {})).toHaveLength(2);
    expect(session!.contentHash).toBe("h_s1");
  });

  it("refuses an open session — that is the live trigger's business, not a pass's", () => {
    seal("s1", ["still talking"], { status: "open" });
    expect(engineSessionOf("s1")).toBeNull();
    expect(engineSessionOf("nope")).toBeNull();
  });
});

describe("runSessionEpisodePass", () => {
  it("takes the 1:1 default on an ordinary session and the hash gate on the replay", async () => {
    seal("s1", ["goa dates?", "13th to 17th"]);
    const first = await runSessionEpisodePass("s1", { now: NOW });
    expect(first!.decision).toBe("one_to_one");
    expect(first!.modelCalls).toBe(0);
    const again = await runSessionEpisodePass("s1", { now: NOW });
    expect(again!.decision).toBe("hash_reuse");
    expect(again!.modelCalls).toBe(0);
  });

  it("prefetches the real P-EP2 answer when the stream has open episodes, and replays it through the engine", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    const prompts: string[] = [];
    const result = await runSessionEpisodePass("s1", {
      now: NOW,
      invoke: async (prompt) => {
        prompts.push(prompt.user);
        return "G|s1|1,2|att|e1|0.93|villa shortlist for Goa";
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("#S");
    expect(result!.decision).toBe("judged");
    expect(result!.modelCalls).toBe(1);
    expect(result!.segments[0]!.decision).toBe("attach");
    expect(result!.segments[0]!.episodeId).toBe("ep_villa");
  });

  it("spends nothing on the replay — the hash gate is checked before the transport", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      return "G|s1|1,2|att|e1|0.93|villa shortlist for Goa";
    };
    await runSessionEpisodePass("s1", { now: NOW, invoke });
    const again = await runSessionEpisodePass("s1", { now: NOW, invoke });
    expect(again!.decision).toBe("hash_reuse");
    expect(calls).toBe(1);
  });

  it("falls back to 1:1 when the transport fails — the safe direction, and it is logged", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    const result = await runSessionEpisodePass("s1", { now: NOW, invoke: async () => null });
    expect(result!.decision).toBe("one_to_one_fallback");
    expect(result!.modelCalls).toBe(0);
    expect(result!.verdictId).not.toBeNull();
  });
});

describe("the queue path", () => {
  it("enqueues sealed sessions, drains them through the engine, and never re-judges", async () => {
    // Two streams: s1's pass opens an episode, and a same-stream s2 would then
    // (rightly) want the judge — that routing is the engine's business, not
    // this test's.
    const C2 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c2", name: "Family", kind: "group" });
    seal("s1", ["goa dates?", "13th to 17th"]);
    seal("s2", ["vet on saturday", "carry the card"], { streamId: C2 });
    expect(unjudgedSealedSessions()).toEqual(expect.arrayContaining(["s1", "s2"]));

    enqueueEpisodePasses(["s1", "s2"], { now: NOW });
    const report = await drainEpisodeQueue({ now: NOW });
    expect(report.claimed).toBe(2);
    expect(report.ran).toBe(2);
    expect(report.decisions.map((d) => d.decision)).toEqual(["one_to_one", "one_to_one"]);

    // Verdicts persisted → §9.7 rule 5: the sweep finds nothing, the queue
    // refuses the re-enqueue, and nothing is re-judged.
    expect(unjudgedSealedSessions()).toEqual([]);
    // The queue row is already `done` (which wins the check); a fresh queue
    // would refuse on the verdict itself. Both are the same rule: finished
    // work stays finished.
    const again = enqueueEpisodePasses(["s1", "s2"], { now: NOW });
    expect(again.map((o) => o.action)).toEqual(["skipped_done", "skipped_done"]);
    getDb().prepare(`DELETE FROM work_queue`).run();
    const fresh = enqueueEpisodePasses(["s1", "s2"], { now: NOW });
    expect(fresh.map((o) => o.action)).toEqual(["skipped_verdict", "skipped_verdict"]);
    expect((await drainEpisodeQueue({ now: NOW })).claimed).toBe(0);
  });

  it("episodePassAfterSeal is enqueue + drain in one seam", async () => {
    seal("s1", ["goa dates?", "13th to 17th"]);
    const report = await episodePassAfterSeal(["s1"], { now: NOW });
    expect(report.ran).toBe(1);
    expect(report.decisions[0]).toEqual({ sessionId: "s1", decision: "one_to_one" });
  });

  it("puts back a session it cannot read yet instead of losing it", async () => {
    seal("s1", ["still talking"], { status: "open" });
    enqueueEpisodePasses(["s1"], { now: NOW });
    const report = await drainEpisodeQueue({ now: NOW });
    expect(report.skipped).toBe(1);
    const row = getDb().prepare(`SELECT state FROM work_queue WHERE unit_id = 's1'`).get() as { state: string };
    expect(row.state).toBe("ready");
  });
});

describe("the aging clock", () => {
  it("fades the quiet episode, stamps the day, and refuses to run twice", () => {
    openEpisode("ep_old", "goa trip", 15);
    expect(episodeAgingDue(NOW)).toBe(true);
    const faded = runEpisodeAging({ now: NOW });
    expect(faded!.map((f) => f.episodeId)).toEqual(["ep_old"]);
    const row = getDb().prepare(`SELECT arc_state, outcome FROM episodes WHERE id = 'ep_old'`).get() as {
      arc_state: string;
      outcome: string;
    };
    expect(row).toEqual({ arc_state: "closed", outcome: "faded" });

    // Not again within a day — the reconcile convention.
    expect(episodeAgingDue(NOW + 3_600_000)).toBe(false);
    expect(runEpisodeAging({ now: NOW + 3_600_000 })).toBeNull();
    expect(runEpisodeAging({ now: NOW + 3_600_000, force: true })).toEqual([]);
    expect(episodeAgingDue(NOW + 25 * 3_600_000)).toBe(true);
  });
});
