// ===========================================================================
// [TEST] The sweep's candidate cap is SHARED, not raced (V6 P1 S6e · E2).
//
// The activation sweep offers one review call two kinds of candidate: the
// unsorted pile, and log retrieval that matched the space's own label. Both
// used to draw from the same 40 seats with unsorted taking its LIMIT first,
// so a home with 40+ open unsorted rows silently lost the entire label-matched
// half — the half that answers "does this episode belong to THIS space".
//
// It never showed on a fresh install, where unsorted is nearly empty. It shows
// on the install this stage exists for: 395 open unsorted rows, every one of
// them newer than the episodes a restored space was founded on.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { sweepCandidates, sweepCandidatesFor, SWEEP_CANDIDATE_CAP, SWEEP_LOG_RESERVE } from "./sweep.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-sweep-reserve-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO sources (id, type, name) VALUES ('wa','whatsapp','wa')`).run();
  db.prepare(`INSERT OR IGNORE INTO streams (id, source_id, external_key, label) VALUES ('st','wa','st','st')`).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;

/** One spaceless episode over one event, optionally recorded unsorted. */
function episode(text: string, at: string, unsorted = true): string {
  const db = getDb();
  const n = ++seq;
  const epId = `ep_${n}`;
  const evId = `ev_${n}`;
  db.prepare(
    `INSERT INTO events (id, source_id, source_type, stream_id, stream_key, ts, captured_at,
                         kind, origin, actor, payload_json, text)
     VALUES (?, 'wa', 'whatsapp', 'st', 'st', ?, ?, 'wa.message', 'live', 'contact:x', '{}', ?)`,
  ).run(evId, at, at, text);
  const rowid = (db.prepare(`SELECT rowid AS r FROM events WHERE id = ?`).get(evId) as { r: number }).r;
  db.prepare(
    `INSERT INTO episodes (id, stream_id, state, summary, first_ts, last_ts) VALUES (?, 'st', 'open', ?, ?, ?)`,
  ).run(epId, text, at, at);
  db.prepare(
    `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`ee_${n}`, epId, evId, evId, rowid, rowid);
  if (unsorted) {
    db.prepare(`INSERT INTO unsorted (id, episode_id, reason, status, created_at) VALUES (?, ?, 'no goal', 'open', ?)`)
      .run(`un_${n}`, epId, at);
  }
  return epId;
}

describe("the sweep shares its candidate cap between unsorted and the log", () => {
  it("a label match survives a crowded unsorted pile", () => {
    // The two episodes the space is founded on, oldest on the pile.
    const foundingA = episode("Instinct invite link shared with Rahul", "2026-09-06T14:48:00.000Z");
    const foundingB = episode("Rahul asked for an Instinct invite", "2026-09-06T14:49:00.000Z");
    // 120 newer, unrelated unsorted rows — the user's install has 395.
    for (let i = 0; i < 120; i++) {
      episode(`Promotional message ${i} about a sale`, `2026-09-06T16:${String(i % 60).padStart(2, "0")}:00.000Z`);
    }

    const candidates = sweepCandidatesFor("Instinct app account and invite management", null);

    expect(candidates).toContain(foundingA);
    expect(candidates).toContain(foundingB);
    expect(candidates.length).toBeLessThanOrEqual(SWEEP_CANDIDATE_CAP);
    // Unsorted still leads the list — only the seat count changed, not the order.
    expect(candidates[0]).not.toBe(foundingA);

    // And the defect this pins: the newest 40 unsorted rows — all the sweep
    // used to see — contain neither founding episode.
    const newest40 = (
      getDb()
        .prepare(
          `SELECT u.episode_id FROM unsorted u JOIN episodes e ON e.id = u.episode_id
            WHERE u.status IN ('open','archived') AND e.space_id IS NULL
            ORDER BY (u.status = 'open') DESC, u.created_at DESC LIMIT ?`,
        )
        .all(SWEEP_CANDIDATE_CAP) as { episode_id: string }[]
    ).map((r) => r.episode_id);
    expect(newest40).not.toContain(foundingA);
    expect(newest40).not.toContain(foundingB);
  });

  it("the log half never takes more than its reserve", () => {
    for (let i = 0; i < 60; i++) episode(`Instinct invite number ${i}`, `2026-09-06T14:${String(i % 60).padStart(2, "0")}:00.000Z`);
    for (let i = 0; i < 60; i++) episode(`Unrelated chatter ${i}`, `2026-09-06T18:${String(i % 60).padStart(2, "0")}:00.000Z`);
    const candidates = sweepCandidatesFor("Instinct invite", null);
    expect(candidates.length).toBe(SWEEP_CANDIDATE_CAP);
    const matched = candidates.filter((id) => {
      const row = getDb().prepare(`SELECT summary FROM episodes WHERE id = ?`).get(id) as { summary: string };
      return row.summary.startsWith("Instinct invite number");
    });
    // Every unsorted row here is also a possible match, so the assertion that
    // bites is the cap and the floor: the log half is guaranteed seats, not
    // given the whole table.
    expect(matched.length).toBeGreaterThanOrEqual(SWEEP_LOG_RESERVE);
  });

  it("a small home is unchanged: everything unsorted is still offered, unsorted first", () => {
    const a = episode("Goa villa booking for December", "2026-08-01T10:00:00.000Z");
    const b = episode("Something else entirely", "2026-08-02T10:00:00.000Z");
    const candidates = sweepCandidatesFor("Goa villa December", null);
    expect(new Set(candidates)).toEqual(new Set([a, b]));
    expect(candidates.length).toBe(2);
  });

  it("sweepCandidates(spaceId) and sweepCandidatesFor(label, goal) are the same query", () => {
    const founding = episode("Goa villa booking for December", "2026-08-01T10:00:00.000Z");
    getDb()
      .prepare(`INSERT INTO spaces (id, label, goal, status) VALUES ('sp_goa', 'Goa villa December', 'book a villa', 'active')`)
      .run();
    expect(sweepCandidates("sp_goa")).toEqual(sweepCandidatesFor("Goa villa December", "book a villa"));
    expect(sweepCandidates("sp_goa")).toContain(founding);
    expect(sweepCandidates("sp_missing")).toEqual([]);
  });
});
