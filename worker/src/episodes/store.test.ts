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
import { upsertSource, upsertStream } from "../db/ingest.js";
import {
  MAX_EPISODE_CANDIDATES,
  persistVerdict,
  readEpisode,
  readEpisodesOfSession,
  readEpisodesOfStream,
  readOpenEpisodes,
  readVerdictForHash,
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
