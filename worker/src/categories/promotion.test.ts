// ===========================================================================
// CAT-03 · Engagement instantly promotes Cat 2 -> Cat 1 — deterministic layer.
//
// "Sunrise Apartments 402" is Cat 2, digested only. The user replies for the
// first time. Expected: immediate promotion, retroactive full processing
// queued for its history, promotion logged. Wrong: `caste-system` (stream
// stuck in Cat 2 despite engagement).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { collectTick } from "../scheduler/dispatch.js";
import { engagementScore, noteUserReply } from "./promotion.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cat03-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const STREAM_KEY = "sunrise-402@g.us";
const STREAM_ID = `wa:st:${STREAM_KEY}`;
const NOW = Date.parse("2026-08-28T12:00:00Z");

function historyMsg(daysAgo: number, text: string): EventEnvelope {
  return {
    ts: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "backfill",
    streamKey: STREAM_KEY,
    actor: "contact:secretary",
    roles: { sender: "contact:secretary", audience: ["self"], receiver: [], mentions: [] },
    payload: { text },
  };
}

function seedDigestedCat2Stream(): void {
  appendEvents(
    [
      historyMsg(40, "plumber contact: 98200-11111, verified by the society"),
      historyMsg(35, "water shutdown tomorrow 10am-1pm"),
      historyMsg(33, "diwali maintenance collection starts next week"),
    ],
    NOW,
  );
  const db = getDb();
  db.prepare(`UPDATE streams SET category = 'cat2' WHERE id = ?`).run(STREAM_ID);
  // Digested only: every history event already carries a processed mark.
  db.prepare(`UPDATE events SET dispatched_at = ? WHERE stream_id = ?`).run(
    new Date(NOW).toISOString(),
    STREAM_ID,
  );
  db.prepare(`UPDATE streams SET cursor_rowid = (SELECT MAX(rowid) FROM events) WHERE id = ?`).run(
    STREAM_ID,
  );
}

describe("CAT-03 · engagement promotes instantly with retroactive full processing", () => {
  it("first user reply: cat2 -> cat1, history re-queued, promotion logged", () => {
    seedDigestedCat2Stream();

    const report = noteUserReply(STREAM_ID, new Date(NOW).toISOString(), NOW);
    expect(report.promoted).toBe(true);
    expect(report.requeued).toBe(3);

    const db = getDb();
    const stream = db
      .prepare(`SELECT category, cursor_rowid, reply_count FROM streams WHERE id = ?`)
      .get(STREAM_ID) as { category: string; cursor_rowid: number; reply_count: number };
    expect(stream.category).toBe("cat1"); // no caste-system
    expect(stream.cursor_rowid).toBe(0);
    expect(stream.reply_count).toBe(1);

    // Retroactive full processing is QUEUED: the next window re-bundles the
    // whole history through the full passes (not Digest — category is cat1 now).
    const plan = collectTick(NOW);
    const bundle = plan.bundles.find((b) => b.streamId === STREAM_ID);
    expect(bundle).toBeDefined();
    expect(bundle?.events).toHaveLength(3);
    expect(bundle?.category).toBe("cat1");

    // The promotion is logged, reversible.
    const decision = db
      .prepare(`SELECT action, old_json, new_json FROM decisions WHERE target_id = ? AND action = 'promote'`)
      .get(STREAM_ID) as { action: string; old_json: string; new_json: string };
    expect(decision).toBeDefined();
    expect(JSON.parse(decision.old_json).category).toBe("cat2");
    expect(JSON.parse(decision.new_json)).toMatchObject({ category: "cat1", requeued: 3 });
  });

  it("a second reply on an already-cat1 stream only bumps engagement", () => {
    seedDigestedCat2Stream();
    noteUserReply(STREAM_ID, new Date(NOW).toISOString(), NOW);
    const again = noteUserReply(STREAM_ID, new Date(NOW + 60_000).toISOString(), NOW + 60_000);
    expect(again.promoted).toBe(false);
    expect(again.replyCount).toBe(2);
    const promotions = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM decisions WHERE target_id = ? AND action = 'promote'`)
      .get(STREAM_ID) as { n: number };
    expect(promotions.n).toBe(1);
  });

  it("a self-authored live envelope through the single-writer promotes on its own", () => {
    seedDigestedCat2Stream();
    appendEvents(
      [
        {
          ts: new Date(NOW).toISOString(),
          source: "wa",
          kind: "wa.message",
          origin: "live",
          streamKey: STREAM_KEY,
          actor: "self",
          roles: { sender: "self", audience: [], receiver: [], mentions: [] },
          payload: { text: "is the plumber contact still valid? my kitchen sink is leaking" },
        },
      ],
      NOW,
    );
    const stream = getDb()
      .prepare(`SELECT category, reply_count FROM streams WHERE id = ?`)
      .get(STREAM_ID) as { category: string; reply_count: number };
    expect(stream.category).toBe("cat1");
    expect(stream.reply_count).toBe(1);
  });

  it("engagement score is recency-weighted reply frequency (ordering signal only)", () => {
    const now = NOW;
    const freshTs = new Date(now).toISOString();
    const staleTs = new Date(now - 60 * 86_400_000).toISOString();
    expect(engagementScore(10, freshTs, now)).toBeCloseTo(10, 5);
    expect(engagementScore(10, staleTs, now)).toBeCloseTo(2.5, 5); // two half-lives
    expect(engagementScore(0, freshTs, now)).toBe(0);
  });
});
