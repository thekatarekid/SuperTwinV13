// ===========================================================================
// The P-EP2 judge adapter (build item 2.2) driving the real episode engine
// (build item 2.1).
//
// Before this file existed, `grep -rn p-ep2` found exactly one importer of
// `p-ep2.ts` — its own test — and the engine's `EpisodeJudge` seam was filled
// only by the eval harness's frozen-answer stub. These tests assert the two
// halves actually meet: a `JudgeRequest` becomes a real P-EP2 prompt, the
// answer to that prompt becomes episodes in the tables, and the second pass
// over the same content makes no call at all.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { runEpisodePass, type EngineSession } from "../episodes/engine.js";
import { readOpenEpisodes } from "../episodes/store.js";
import { ep2InputFor, ep2Judge } from "./p-ep2-judge.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

let tmpDir: string;
let C1 = "";
let eventIds: string[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-ep2judge-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  C1 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Rohan", kind: "dm" });
  const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "rohan", displayName: "Rohan" });
  eventIds = ["deposit is due friday", "sending the villa link", "mom's scan came back", "reports are fine"].map(
    (text, i) =>
      insertEvent({
        externalId: `ev${i + 1}`,
        sourceId: "whatsapp",
        sourceType: "whatsapp",
        streamId: C1,
        actorId: actor,
        ts: new Date(NOW - (4 - i) * 60_000).toISOString(),
        kind: "message",
        text,
        mediaPath: null,
        rawJson: null,
        isHistorical: true,
      }).id,
  );
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function session(id = "s1"): EngineSession {
  const stamp = new Date(NOW).toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
       VALUES (?, ?, 'whatsapp', ?, ?, ?, 'sealed', ?)`,
    )
    .run(id, C1, stamp, stamp, JSON.stringify(eventIds), `h_${id}`);
  return { id, streamId: C1, sourceId: "whatsapp", contentHash: `h_${id}`, eventIds, startedAt: stamp, endedAt: stamp };
}

function openEpisode(id: string, label: string): void {
  const stamp = new Date(NOW - 86_400_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO episodes (id, stream_id, source_id, topic_label, label_source, session_ids,
                             event_ids, entity_ids, arc_state, started_at, ended_at)
       VALUES (?, ?, 'whatsapp', ?, 'model', '[]', '[]', '[]', 'open', ?, ?)`,
    )
    .run(id, C1, label, stamp, stamp);
}

describe("ep2InputFor", () => {
  it("packs the session's own events, in the order the seal froze", () => {
    const s = session();
    const input = ep2InputFor({ session: s, candidates: [], preflag: null });
    expect(input).not.toBeNull();
    expect(input!.sessions).toHaveLength(1);
    expect(input!.sessions[0].events.map((e) => e.id)).toEqual(eventIds);
    expect(input!.sessions[0].events[0].text).toBe("deposit is due friday");
  });

  it("offers only THIS stream's open episodes — episodes never cross streams", () => {
    const other = upsertStream({ sourceId: "whatsapp", sourceExtId: "c2", name: "Family", kind: "group" });
    const s = session();
    const input = ep2InputFor({
      session: s,
      candidates: [
        { id: "ep_mine", streamId: C1, topicLabel: "villa shortlist", lastActiveAt: null, entityIds: [] },
        { id: "ep_theirs", streamId: other, topicLabel: "villa shortlist", lastActiveAt: null, entityIds: [] },
      ],
      preflag: null,
    });
    expect(input!.episodes!.map((e) => e.id)).toEqual(["ep_mine"]);
  });
});

describe("ep2Judge drives the engine", () => {
  it("builds a real P-EP2 prompt and turns its answer into episodes", () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    const s = session();
    const candidates = readOpenEpisodes(C1, { now: NOW });
    expect(candidates).toHaveLength(1);

    const seen: { system: string; user: string; model: string }[] = [];
    const judge = ep2Judge((prompt) => {
      seen.push(prompt);
      // Two segments: the villa half attaches, the medical half is new.
      return ["G|s1|1,2|att|e1|0.93|villa shortlist for Goa", "G|s1|3,4|new|-|0.85|mom's medical reports"].join("\n");
    });

    const result = runEpisodePass(s, { now: NOW, candidates, judge });

    // The call really happened, against the real §12.3 SYSTEM text.
    expect(seen).toHaveLength(1);
    expect(seen[0].system).toContain("You segment sealed sessions into topical episodes.");
    expect(seen[0].user).toContain("#S s1");
    expect(seen[0].model).toBe("sonnet-5");

    expect(result.decision).toBe("judged");
    expect(result.modelCalls).toBe(1);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].decision).toBe("attach");
    expect(result.segments[0].episodeId).toBe("ep_villa");
    expect(result.segments[0].eventIds).toEqual(eventIds.slice(0, 2));
    expect(result.segments[1].decision).toBe("new");
    expect(result.segments[1].eventIds).toEqual(eventIds.slice(2));
  });

  it("re-running the same sealed session makes ZERO further calls (the hash gate)", () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    const s = session();
    let calls = 0;
    const judge = ep2Judge(() => {
      calls += 1;
      return ["G|s1|1,2|att|e1|0.93|villa shortlist for Goa", "G|s1|3,4|new|-|0.85|mom's medical reports"].join("\n");
    });

    const first = runEpisodePass(s, { now: NOW, candidates: readOpenEpisodes(C1, { now: NOW }), judge });
    const second = runEpisodePass(s, { now: NOW, candidates: readOpenEpisodes(C1, { now: NOW }), judge });

    expect(calls).toBe(1);
    expect(second.decision).toBe("hash_reuse");
    expect(second.modelCalls).toBe(0);
    expect(second.segments.map((x) => x.episodeId)).toEqual(first.segments.map((x) => x.episodeId));
  });

  it("falls back to 1:1 rather than guessing when the call cannot be made", () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    const s = session();
    const result = runEpisodePass(s, {
      now: NOW,
      candidates: readOpenEpisodes(C1, { now: NOW }),
      judge: ep2Judge(() => null),
    });
    expect(result.decision).toBe("one_to_one_fallback");
    expect(result.modelCalls).toBe(0);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].decision).toBe("new");
  });
});
