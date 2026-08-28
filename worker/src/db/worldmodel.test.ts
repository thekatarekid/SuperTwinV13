// ===========================================================================
// 0101_world_model (build P1.1): schema round-trips for spaces → chapters →
// episodes → episode_events → tasks, unsorted + second_look, the people view,
// the space_index lanes (FTS triggers, embeddings, entities, bridge keys) and
// the drop of the dead V11 derivation tables.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "./connection.js";
import { appendEvent } from "./eventlog.js";
import { writeDecision, decisionsFor, markReversed } from "./decisions.js";
import { createEntity, setCircle, circleOf } from "../entities/registry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-worldmodel-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function insertSpace(id: string, label: string, extra: Record<string, unknown> = {}): void {
  getDb()
    .prepare(
      `INSERT INTO spaces (id, label, life_area, goal, status, exemplars_json, created_by, confidence)
       VALUES (@id, @label, @life_area, @goal, @status, @exemplars, @created_by, @confidence)`,
    )
    .run({
      id,
      label,
      life_area: (extra.life_area as string) ?? "Travel",
      goal: (extra.goal as string) ?? "18-21 Dec trip",
      status: (extra.status as string) ?? "proposed",
      exemplars: JSON.stringify(["dates locked", "flight compare"]),
      created_by: "orient",
      confidence: 0.9,
    });
}

describe("spaces → chapters → episodes → episode_events → tasks", () => {
  it("round-trips the full hierarchy", () => {
    const db = getDb();
    insertSpace("sp_goa", "Goa trip with Rohan in December");

    db.prepare(
      `INSERT INTO chapters (id, space_id, label, status, target_date) VALUES (?, ?, ?, ?, ?)`,
    ).run("ch_flights", "sp_goa", "Flights", "active", "2026-08-29");

    const { id: e1 } = appendEvent({
      ts: "2026-08-25T19:42:10+05:30",
      source: "wa",
      kind: "wa.message",
      origin: "live",
      streamKey: "goa@g.us",
      actor: "contact:rohan",
      roles: { sender: "contact:rohan", audience: ["self"], receiver: ["*audience"], mentions: [] },
      payload: { text: "lets lock goa 18-21 dec" },
    });

    db.prepare(
      `INSERT INTO episodes (id, space_id, chapter_id, state, summary, first_ts, last_ts, confidence, created_by)
       VALUES (?, ?, ?, 'open', ?, ?, ?, 0.93, 'orient')`,
    ).run("ep_412", "sp_goa", "ch_flights", "Dates agreed", "2026-08-25T19:42:10+05:30", "2026-08-25T19:59:00+05:30");

    db.prepare(
      `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id) VALUES (?, ?, ?, ?)`,
    ).run("epe_1", "ep_412", e1, e1);

    db.prepare(
      `INSERT INTO tasks (id, space_id, chapter_id, title, type, category, risk_class, owner, due,
                          schedule_json, evidence_json, confidence, created_by)
       VALUES (?, ?, ?, ?, 'explicit', 'transaction', 'approve-final', 'self', '2026-08-29',
               ?, ?, 0.9, 'decide')`,
    ).run(
      "tsk_flights",
      "sp_goa",
      "ch_flights",
      "Book flights CCU-GOI 18 Dec, return 21 Dec",
      JSON.stringify({ fire_at: "2026-12-16T07:00+05:30", mode: "confirm", source: "inferred" }),
      JSON.stringify([{ event_ids: [e1], quote: "lets lock goa 18-21 dec" }]),
    );

    const task = db.prepare(`SELECT * FROM tasks WHERE id = 'tsk_flights'`).get() as Record<string, unknown>;
    expect(task.space_id).toBe("sp_goa");
    expect(task.status).toBe("open");
    expect(JSON.parse(String(task.schedule_json)).mode).toBe("confirm");

    const range = db
      .prepare(
        `SELECT ee.*, ep.space_id FROM episode_events ee JOIN episodes ep ON ep.id = ee.episode_id
          WHERE ee.episode_id = 'ep_412'`,
      )
      .get() as Record<string, unknown>;
    expect(range.start_event_id).toBe(e1);
    expect(range.space_id).toBe("sp_goa");

    // Cascade: deleting the space clears chapters; episodes detach (SET NULL).
    db.prepare(`DELETE FROM spaces WHERE id = 'sp_goa'`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM chapters`).get()).toEqual({ n: 0 });
    const ep = db.prepare(`SELECT space_id, chapter_id FROM episodes WHERE id = 'ep_412'`).get() as Record<
      string,
      unknown
    >;
    expect(ep.space_id).toBeNull();
    expect(ep.chapter_id).toBeNull();
  });

  it("chains episodes (same topic after a break) and scopes them to a stream", () => {
    const db = getDb();
    db.prepare(`INSERT INTO episodes (id, state, summary) VALUES ('ep_old', 'closed', 'old burst')`).run();
    db.prepare(
      `INSERT INTO episodes (id, state, summary, chain_prev_id) VALUES ('ep_new', 'open', 'new burst', 'ep_old')`,
    ).run();
    const row = db.prepare(`SELECT chain_prev_id FROM episodes WHERE id = 'ep_new'`).get() as {
      chain_prev_id: string;
    };
    expect(row.chain_prev_id).toBe("ep_old");
  });
});

describe("unsorted + second_look", () => {
  it("round-trips and enforces one unsorted row per episode", () => {
    const db = getDb();
    db.prepare(`INSERT INTO episodes (id, state) VALUES ('ep_1', 'open')`).run();
    db.prepare(`INSERT INTO unsorted (id, episode_id, reason, confidence) VALUES ('u1','ep_1','low conf',0.4)`).run();
    expect(() =>
      db.prepare(`INSERT INTO unsorted (id, episode_id) VALUES ('u2','ep_1')`).run(),
    ).toThrow(/UNIQUE/);

    insertSpace("sp_x", "Some specific space label here");
    db.prepare(
      `INSERT INTO second_look (id, episode_id, space_id, attach_confidence) VALUES ('sl1','ep_1','sp_x',0.66)`,
    ).run();
    const sl = db.prepare(`SELECT * FROM second_look WHERE id='sl1'`).get() as Record<string, unknown>;
    expect(sl.status).toBe("pending");
    expect(sl.attach_confidence).toBe(0.66);
  });
});

describe("people view + circles", () => {
  it("lists person entities with circle + provisional; setCircle records a decision", () => {
    const db = getDb();
    const rohan = createEntity({ type: "person", canonical: "Rohan Mehta" });
    createEntity({ type: "org", canonical: "Not A Person" });

    let people = db.prepare(`SELECT * FROM people ORDER BY id`).all() as Record<string, unknown>[];
    expect(people).toHaveLength(1);
    expect(people[0]!.name).toBe("Rohan Mehta");
    expect(people[0]!.provisional).toBe(1);
    expect(people[0]!.circle).toBeNull();

    setCircle(rohan.id, "close_friends", { decidedBy: "user", reason: "goa gang" });
    expect(circleOf(rohan.id)).toBe("close_friends");
    people = db.prepare(`SELECT * FROM people`).all() as Record<string, unknown>[];
    expect(people[0]!.circle).toBe("close_friends");

    const decisions = decisionsFor("entity", rohan.id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe("set_circle");
    expect(JSON.parse(decisions[0]!.newJson!)).toEqual({ circle: "close_friends" });

    // Reversible: the decision row carries the restore payload and can be marked.
    expect(markReversed(decisions[0]!.id, "user")).toBe(true);
    expect(markReversed(decisions[0]!.id, "user")).toBe(false);
  });

  it("rejects a circle outside the closed set", () => {
    const p = createEntity({ type: "person" });
    expect(() => setCircle(p.id, "besties" as never)).toThrow(/not one of the 9 circles/);
  });
});

describe("space_index lanes", () => {
  it("FTS triggers index label/goal/exemplars and follow updates + deletes", () => {
    const db = getDb();
    insertSpace("sp_goa", "Goa trip with Rohan in December");
    const hit = () =>
      db.prepare(`SELECT space_id FROM spaces_fts WHERE spaces_fts MATCH ?`).all("goa") as {
        space_id: string;
      }[];
    expect(hit().map((r) => r.space_id)).toEqual(["sp_goa"]);

    db.prepare(`UPDATE spaces SET label = 'Manali trek with college friends' WHERE id = 'sp_goa'`).run();
    expect(hit()).toHaveLength(0);
    expect(
      db.prepare(`SELECT space_id FROM spaces_fts WHERE spaces_fts MATCH 'manali'`).all(),
    ).toHaveLength(1);

    db.prepare(`DELETE FROM spaces WHERE id = 'sp_goa'`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM spaces_fts`).get()).toEqual({ n: 0 });
  });

  it("stores embedding, entity-overlap and bridge-key lanes per space", () => {
    const db = getDb();
    insertSpace("sp_goa", "Goa trip with Rohan in December");
    const rohan = createEntity({ type: "person", canonical: "Rohan" });

    db.prepare(`INSERT INTO space_embeddings (space_id, vec, model, dim) VALUES (?, ?, ?, ?)`).run(
      "sp_goa",
      Buffer.from(new Float32Array([0.1, 0.2]).buffer),
      "test-embedder",
      2,
    );
    db.prepare(`INSERT INTO space_entities (space_id, entity_id, weight) VALUES (?, ?, 2)`).run("sp_goa", rohan.id);
    db.prepare(`INSERT INTO space_bridge_keys (space_id, kind, value_norm) VALUES (?, 'url', ?)`).run(
      "sp_goa",
      "goibibo.com/goa",
    );

    expect(
      db.prepare(`SELECT space_id FROM space_bridge_keys WHERE kind='url' AND value_norm=?`).get("goibibo.com/goa"),
    ).toEqual({ space_id: "sp_goa" });

    // All three lanes cascade with the space.
    db.prepare(`DELETE FROM spaces WHERE id='sp_goa'`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM space_embeddings`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM space_entities`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM space_bridge_keys`).get()).toEqual({ n: 0 });
  });
});

describe("V11 derivation tables are gone; kept tables survive", () => {
  it("dropped episodes/arcs/loops family; kept sessions, evidence, claim_versions", () => {
    const db = getDb();
    const names = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    for (const gone of [
      "arcs",
      "arc_episodes",
      "arc_verdicts",
      "provisional_arcs",
      "loops",
      "loop_embeddings",
      "episode_sessions",
      "episode_verdicts",
      "episode_embeddings",
      "goal_spaces",
    ]) {
      expect(names.has(gone), `${gone} should be dropped`).toBe(false);
    }
    for (const kept of [
      "sessions",
      "evidence",
      "claim_versions",
      "claims_active",
      "claims",
      "tone_profiles",
      "people",
      "spaces",
      "chapters",
      "episodes",
      "episode_events",
      "tasks",
      "unsorted",
      "second_look",
      "space_claims",
      "event_bridge_keys",
    ]) {
      expect(names.has(kept), `${kept} should exist`).toBe(true);
    }
  });
});

describe("decisions helper", () => {
  it("writes and reads decision rows for any target", () => {
    const id = writeDecision({
      pass: "orient",
      targetKind: "space",
      targetId: "sp_x",
      action: "create",
      new: { label: "x" },
      confidence: 0.8,
    });
    expect(id).toMatch(/^dec_/);
    const rows = decisionsFor("space", "sp_x");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("create");
  });
});
