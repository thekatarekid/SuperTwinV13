// ===========================================================================
// The Extract work queue (V6 P1 E1, migration 0210_v6_extract_queue) on a
// temp DB. One row per episode, merge-in on re-enqueue, claim = the episode's
// lock, the `extracted_at` watermark, the three-strike ladder and the backlog
// seeder that is the upgrade path for a home Extract never ran on.
//
// ZERO model calls: nothing in this file touches a provider.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { addEpisodeEvents } from "../db/v6core.js";
import {
  EXTRACT_MAX_ATTEMPTS,
  claimExtractBatch,
  deadLetteredExtractCount,
  enqueueExtract,
  episodeEventCounts,
  finishExtract,
  pendingExtractCount,
  releaseExtract,
  seedExtractBacklog,
  unextractedEpisodeCount,
} from "./extract-queue.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-xq-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO sources (id, type, display_name) VALUES ('src_wa', 'whatsapp', 'WhatsApp')`).run();
  db.prepare(`INSERT INTO streams (id, source_id, external_key, label) VALUES ('st_a', 'src_wa', 'wa:a@s.net', 'A')`).run();
  db.prepare(`INSERT INTO streams (id, source_id, external_key, label) VALUES ('st_b', 'src_wa', 'wa:b@s.net', 'B')`).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** An episode with `n` real member events, so the seeder and the sizer see it. */
function episode(id: string, streamId: string | null, n = 1, lastTs = "2026-09-05T09:00:00.000Z"): string {
  const db = getDb();
  db.prepare(`INSERT INTO episodes (id, stream_id, state, summary, last_ts) VALUES (?, ?, 'open', ?, ?)`).run(
    id,
    streamId,
    id,
    lastTs,
  );
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const eid = `${id}_e${i}`;
    db.prepare(
      `INSERT INTO events (id, ts, source_id, source_type, kind, stream_id, stream_key, actor, text, content_hash)
       VALUES (?, ?, 'src_wa', 'whatsapp', 'whatsapp.text', ?, 'wa:a@s.net', 'them', 'hi', ?)`,
    ).run(eid, lastTs, streamId, eid);
    ids.push(eid);
  }
  if (ids.length > 0) addEpisodeEvents(id, ids);
  return id;
}

describe("extract queue — one row per episode", () => {
  it("keeps ONE row per episode and upgrades priority, never downgrades", () => {
    episode("ep_1", "st_a");
    expect(enqueueExtract(["ep_1"], "backfill")).toBe(1);
    expect(enqueueExtract([{ episodeId: "ep_1", streamId: "st_a" }], "live")).toBe(0);
    const row = getDb().prepare(`SELECT COUNT(*) AS n, MAX(priority) AS p FROM extract_queue`).get() as {
      n: number;
      p: string;
    };
    expect(row.n).toBe(1);
    expect(claimExtractBatch(5)[0]!.priority).toBe("live");
  });

  it("queues nothing for an episode that does not exist", () => {
    expect(enqueueExtract(["ep_ghost"])).toBe(0);
    expect(pendingExtractCount()).toBe(0);
  });

  it("claims best priority first and a claimed episode cannot be claimed twice", () => {
    episode("ep_old", "st_a");
    episode("ep_new", "st_b");
    enqueueExtract(["ep_old"], "backfill");
    enqueueExtract(["ep_new"], "urgent");
    expect(claimExtractBatch(10).map((r) => r.episodeId)).toEqual(["ep_new", "ep_old"]);
    expect(claimExtractBatch(10)).toEqual([]); // both running — serial per episode
    expect(pendingExtractCount()).toBe(0);
  });

  it("a finished pass deletes the rows and stamps the watermark", () => {
    episode("ep_1", "st_a");
    episode("ep_2", "st_a");
    enqueueExtract(["ep_1", "ep_2"]);
    const claimed = claimExtractBatch(10).map((r) => r.episodeId);
    finishExtract(claimed, new Date("2026-09-06T10:00:00.000Z"));
    expect(pendingExtractCount()).toBe(0);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM extract_queue`).get()).toEqual({ n: 0 });
    const stamped = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM episodes WHERE extracted_at = '2026-09-06T10:00:00.000Z'`)
      .get() as { n: number };
    expect(stamped.n).toBe(2);
    expect(unextractedEpisodeCount()).toBe(0);
  });

  it("release keeps the work and the THIRD strike dead-letters it", () => {
    episode("ep_1", "st_a");
    enqueueExtract(["ep_1"]);
    for (let attempt = 1; attempt < EXTRACT_MAX_ATTEMPTS; attempt++) {
      const claimed = claimExtractBatch(1).map((r) => r.episodeId);
      expect(claimed).toEqual(["ep_1"]);
      expect(releaseExtract(claimed, `boom ${attempt}`)).toEqual([]);
      expect(pendingExtractCount()).toBe(1); // kept, not lost
    }
    const last = claimExtractBatch(1).map((r) => r.episodeId);
    expect(releaseExtract(last, "boom 3")).toEqual(["ep_1"]);
    expect(pendingExtractCount()).toBe(0);
    expect(deadLetteredExtractCount()).toBe(1);
    expect(claimExtractBatch(10)).toEqual([]); // never claimed again
    // The episode is NOT stamped: it was never understood, only given up on.
    expect(unextractedEpisodeCount()).toBe(1);
  });

  it("a fresh enqueue revives a dead-lettered episode — new events are a new reason", () => {
    episode("ep_1", "st_a");
    enqueueExtract(["ep_1"]);
    for (let i = 0; i < EXTRACT_MAX_ATTEMPTS; i++) releaseExtract(claimExtractBatch(1).map((r) => r.episodeId), "boom");
    expect(deadLetteredExtractCount()).toBe(1);
    expect(enqueueExtract(["ep_1"], "live")).toBe(1);
    expect(pendingExtractCount()).toBe(1);
    expect(deadLetteredExtractCount()).toBe(0);
    expect(claimExtractBatch(1)[0]!.attempts).toBe(0);
  });
});

describe("extract queue — the backlog seeder (the upgrade path)", () => {
  it("queues never-extracted episodes newest first, and is idempotent", () => {
    episode("ep_old", "st_a", 1, "2026-09-01T09:00:00.000Z");
    episode("ep_new", "st_a", 1, "2026-09-05T09:00:00.000Z");
    episode("ep_empty", "st_b", 0); // no member events — nothing to extract
    expect(unextractedEpisodeCount()).toBe(2);
    expect(seedExtractBacklog(50)).toBe(2);
    expect(seedExtractBacklog(50)).toBe(0); // idempotent: already queued
    expect(claimExtractBatch(10).map((r) => r.episodeId)).toEqual(["ep_new", "ep_old"]);
    expect(
      getDb().prepare(`SELECT COUNT(*) AS n FROM extract_queue WHERE episode_id = 'ep_empty'`).get(),
    ).toEqual({ n: 0 });
  });

  it("never re-queues an episode the watermark says is done, and honours its limit", () => {
    episode("ep_1", "st_a", 1, "2026-09-05T09:00:00.000Z");
    episode("ep_2", "st_a", 1, "2026-09-04T09:00:00.000Z");
    expect(seedExtractBacklog(1)).toBe(1); // bounded per call
    finishExtract(claimExtractBatch(1).map((r) => r.episodeId));
    expect(seedExtractBacklog(50)).toBe(1); // only the one left
    finishExtract(claimExtractBatch(1).map((r) => r.episodeId));
    expect(seedExtractBacklog(50)).toBe(0); // nothing left — zero rows, zero calls
    expect(unextractedEpisodeCount()).toBe(0);
  });
});

describe("extract queue — sizing for the batcher", () => {
  it("counts explicit members exactly and defaults an unknown episode to one", () => {
    episode("ep_1", "st_a", 3);
    episode("ep_2", "st_a", 1);
    const sizes = episodeEventCounts(["ep_1", "ep_2", "ep_missing"]);
    expect(sizes.get("ep_1")).toBe(3);
    expect(sizes.get("ep_2")).toBe(1);
    expect(sizes.get("ep_missing")).toBe(1);
    expect(episodeEventCounts([]).size).toBe(0);
  });
});
