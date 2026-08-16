// ===========================================================================
// Episode persistence (migration 0020 tables, build item 2.1): candidate
// reads that are stream-scoped and clock-aware, and writes that a replay can
// repeat without producing a twin.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import {
  MAX_EPISODE_CANDIDATES,
  persistVerdict,
  readEpisode,
  readEpisodesOfSession,
  readEpisodesOfStream,
  readOpenEpisodes,
  readVerdictForHash,
  retractVerdict,
  setVerdictEpisode,
  writeEpisode,
} from "./store.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

let tmpDir: string;
let C1 = "";
let C2 = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-epstore-"));
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

function session(id: string, hash: string): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
       VALUES (?, ?, 'whatsapp', ?, ?, '[]', 'sealed', ?)`,
    )
    .run(id, C1, new Date(NOW).toISOString(), new Date(NOW).toISOString(), hash);
}

function write(id: string, sessionId: string, eventIds: string[], label: string | null, agoDays = 0) {
  return writeEpisode(
    {
      id,
      streamId: C1,
      topicLabel: label,
      labelSource: label === null ? "derived" : "model",
      sessionId,
      eventIds,
      startedAt: new Date(NOW - agoDays * DAY - 3_600_000).toISOString(),
      endedAt: new Date(NOW - agoDays * DAY).toISOString(),
      addedBy: "new",
    },
    { now: NOW },
  );
}

describe("candidates", () => {
  it("are stream-scoped, newest first, and capped at ten", () => {
    session("s1", "h1");
    for (let i = 0; i < 14; i += 1) write(`ep${i}`, "s1", [`ev${i}`], `topic ${i}`, i * 0.5);
    writeEpisode(
      {
        id: "other",
        streamId: C2,
        topicLabel: "elsewhere",
        labelSource: "model",
        sessionId: "s1",
        eventIds: ["evX"],
        startedAt: new Date(NOW).toISOString(),
        endedAt: new Date(NOW).toISOString(),
        addedBy: "new",
      },
      { now: NOW },
    );

    const candidates = readOpenEpisodes(C1, { now: NOW });
    expect(candidates).toHaveLength(MAX_EPISODE_CANDIDATES);
    expect(candidates[0]!.id).toBe("ep0");
    expect(candidates.every((c) => c.streamId === C1)).toBe(true);
    expect(readOpenEpisodes(C2, { now: NOW }).map((c) => c.id)).toEqual(["other"]);
  });

  it("drop a 14-day silence even before the aging pass has run", () => {
    session("s1", "h1");
    write("fresh", "s1", ["ev1"], "fresh", 3);
    write("stale", "s1", ["ev2"], "stale", 14);
    expect(readOpenEpisodes(C1, { now: NOW }).map((c) => c.id)).toEqual(["fresh"]);
  });

  it("drop a closed episode", () => {
    session("s1", "h1");
    write("done", "s1", ["ev1"], "done", 1);
    getDb().prepare(`UPDATE episodes SET arc_state = 'closed' WHERE id = 'done'`).run();
    expect(readOpenEpisodes(C1, { now: NOW })).toEqual([]);
  });
});

describe("writes", () => {
  it("merge membership instead of replacing it, and never duplicate", () => {
    session("s1", "h1");
    session("s2", "h2");
    write("ep", "s1", ["ev1", "ev2"], "goa trip", 2);
    const merged = write("ep", "s2", ["ev2", "ev3"], "goa trip", 0);
    expect(merged.sessionIds).toEqual(["s1", "s2"]);
    expect(merged.eventIds).toEqual(["ev1", "ev2", "ev3"]);
    expect(merged.startedAt).toBe(new Date(NOW - 2 * DAY - 3_600_000).toISOString());
    expect(merged.endedAt).toBe(new Date(NOW).toISOString());
    expect(readEpisodesOfSession("s2")).toEqual(["ep"]);
    expect(readEpisodesOfStream(C1).map((e) => e.id)).toEqual(["ep"]);
  });

  it("are idempotent: the same write twice lands the same row", () => {
    session("s1", "h1");
    const once = write("ep", "s1", ["ev1", "ev2"], "goa trip");
    const twice = write("ep", "s1", ["ev1", "ev2"], "goa trip");
    expect(twice).toEqual(once);
    const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM episode_sessions`).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("never overwrite a label the user set", () => {
    session("s1", "h1");
    write("ep", "s1", ["ev1"], "model words");
    getDb()
      .prepare(`UPDATE episodes SET topic_label = 'my words', label_source = 'user' WHERE id = 'ep'`)
      .run();
    write("ep", "s1", ["ev2"], "different model words");
    const row = readEpisode("ep")!;
    expect(row.topicLabel).toBe("my words");
    expect(row.labelSource).toBe("user");
    expect(row.eventIds).toEqual(["ev1", "ev2"]);
  });
});

describe("the hash gate lookup", () => {
  it("finds a verdict through any session carrying that content hash", () => {
    session("s1", "shared-hash");
    session("s2", "shared-hash");
    const id = persistVerdict({
      episodeId: null,
      sessionId: "s1",
      decision: "judged",
      candidates: [],
      output: { segments: [] },
      createdAt: new Date(NOW).toISOString(),
    });
    write("ep", "s1", ["ev1"], "goa trip");
    setVerdictEpisode(id, "ep");

    const hit = readVerdictForHash("shared-hash");
    expect(hit?.id).toBe(id);
    expect(hit?.episodeId).toBe("ep");
    expect(readVerdictForHash("other-hash")).toBeNull();
    expect(readVerdictForHash("")).toBeNull();
  });

  it("returns the newest verdict when a session has been re-judged", () => {
    session("s1", "h1");
    persistVerdict({
      episodeId: null,
      sessionId: "s1",
      decision: "one_to_one",
      candidates: [],
      output: { segments: [] },
      createdAt: new Date(NOW - DAY).toISOString(),
    });
    const second = persistVerdict({
      episodeId: null,
      sessionId: "s1",
      decision: "judged",
      candidates: [],
      output: { segments: [] },
      createdAt: new Date(NOW).toISOString(),
    });
    expect(readVerdictForHash("h1")?.id).toBe(second);
  });
});

describe("retraction", () => {
  /** A sealed session with REAL event rows, so the span recompute has instants. */
  function sessionWithEvents(id: string, texts: readonly string[], baseOffsetMin: number): string[] {
    const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "rohan", displayName: "Rohan" });
    const eventIds = texts.map(
      (text, i) =>
        insertEvent({
          externalId: `${id}-ev${i + 1}`,
          sourceId: "whatsapp",
          sourceType: "whatsapp",
          streamId: C1,
          actorId: actor,
          ts: new Date(NOW - (baseOffsetMin - i) * 60_000).toISOString(),
          kind: "message",
          text,
          mediaPath: null,
          rawJson: null,
          isHistorical: true,
        }).id,
    );
    getDb()
      .prepare(
        `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
         VALUES (?, ?, 'whatsapp', ?, ?, ?, 'sealed', ?)`,
      )
      .run(id, C1, new Date(NOW).toISOString(), new Date(NOW).toISOString(), JSON.stringify(eventIds), `h_${id}`);
    return eventIds;
  }

  function verdictFor(sessionId: string, decision: string, at: number): string {
    return persistVerdict({
      episodeId: null,
      sessionId,
      decision,
      candidates: [],
      output: { segments: [] },
      createdAt: new Date(at).toISOString(),
    });
  }

  it("takes back exactly what the verdict wrote: empty episodes die, shared ones are rebuilt", () => {
    const ev1 = sessionWithEvents("s1", ["goa dates?", "13th to 17th"], 120);
    const ev2 = sessionWithEvents("s2", ["deposit due friday"], 30);
    const v1 = verdictFor("s1", "judged", NOW - DAY);
    const v2 = verdictFor("s2", "one_to_one_fallback", NOW);
    // v1 lands s1 on the shared episode; v2 attaches s2 there AND mints its own.
    writeEpisode(
      { id: "ep_shared", streamId: C1, topicLabel: "goa trip", labelSource: "model",
        sessionId: "s1", eventIds: ev1, startedAt: null, endedAt: null, addedBy: "new", verdictId: v1 },
      { now: NOW },
    );
    writeEpisode(
      { id: "ep_shared", streamId: C1, topicLabel: "goa trip", labelSource: "model",
        sessionId: "s2", eventIds: ev2, startedAt: null, endedAt: null, addedBy: "attach", verdictId: v2 },
      { now: NOW },
    );
    writeEpisode(
      { id: "ep_solo", streamId: C1, topicLabel: null, labelSource: "derived",
        sessionId: "s2", eventIds: ev2, startedAt: null, endedAt: null, addedBy: "new", verdictId: v2 },
      { now: NOW },
    );

    const undone = retractVerdict(v2);
    expect(undone).not.toBeNull();
    expect(undone!.sessionId).toBe("s2");
    expect(undone!.episodesDeleted).toEqual(["ep_solo"]);
    expect(undone!.episodesUpdated).toEqual(["ep_shared"]);

    // The solo episode and the verdict are gone; the other verdict stands.
    expect(readEpisode("ep_solo")).toBeNull();
    const verdicts = getDb().prepare(`SELECT id FROM episode_verdicts ORDER BY id`).all() as { id: string }[];
    expect(verdicts.map((v) => v.id)).toEqual([v1]);

    // The shared episode is s1's alone again — members, events, and span.
    const shared = readEpisode("ep_shared");
    expect(shared!.sessionIds).toEqual(["s1"]);
    expect(shared!.eventIds).toEqual(ev1);
    expect(shared!.startedAt).toBe(new Date(NOW - 120 * 60_000).toISOString());
    expect(shared!.endedAt).toBe(new Date(NOW - 119 * 60_000).toISOString());
    expect(readEpisodesOfSession("s2")).toEqual([]);
  });

  it("retracting a missing or already-retracted verdict is a null, not an error", () => {
    expect(retractVerdict("ev_nope")).toBeNull();
    sessionWithEvents("s1", ["hi"], 10);
    const v = verdictFor("s1", "one_to_one_fallback", NOW);
    writeEpisode(
      { id: "ep1", streamId: C1, topicLabel: null, labelSource: "derived",
        sessionId: "s1", eventIds: ["whatever"], startedAt: null, endedAt: null, addedBy: "new", verdictId: v },
      { now: NOW },
    );
    expect(retractVerdict(v)).not.toBeNull();
    expect(retractVerdict(v)).toBeNull();
  });
});
