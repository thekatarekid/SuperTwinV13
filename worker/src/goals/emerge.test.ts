// ===========================================================================
// Goal emergence — build item 3.9, arch §11.6 ⑧.
//
// The acceptance box is one line: "zero goals created without evidence". Half
// this file is that box from every angle — a loop with no evidence row, a
// hand-made proposal with an empty event list, a whole graph of loops in
// unpromoted arcs. The other half is the rule itself: 2–3 loops, ≥2 spaces,
// ≥2 shared anchors, one shared horizon, and `none` is not a horizon.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { mutationsFor } from "../entities/merge.js";
import {
  EMERGENCE_ACTOR,
  LIFE_PROJECT_KIND,
  confirmGoalProposal,
  emergeGoals,
  goalIdForKey,
  proposalKeyFor,
  proposeGoals,
  readEmergenceInput,
  readGoals,
  sweepGoalEmergence,
  type EmergenceLoop,
  type GoalProposal,
} from "./emerge.js";

// ---- pure rule -------------------------------------------------------------

function loop(over: Partial<EmergenceLoop> & { loopId: string }): EmergenceLoop {
  return {
    spaceId: "arc_a",
    spacePromoted: true,
    horizon: "month",
    anchorEntityIds: ["ent_ana", "ent_me"],
    evidenceEventIds: [`ev_${over.loopId}`],
    ...over,
  };
}

describe("emergeGoals — §11.6 ⑧", () => {
  it("proposes a life project for 2 loops across 2 spaces sharing 2 anchors and a horizon", () => {
    const out = emergeGoals({
      loops: [loop({ loopId: "l1", spaceId: "arc_a" }), loop({ loopId: "l2", spaceId: "arc_b" })],
      entityNames: { ent_ana: "Ana", ent_me: "Me" },
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe(LIFE_PROJECT_KIND);
    expect(out[0].spaceIds).toEqual(["arc_a", "arc_b"]);
    expect(out[0].loopIds).toEqual(["l1", "l2"]);
    expect(out[0].sharedAnchorIds).toEqual(["ent_ana", "ent_me"]);
    expect(out[0].evidenceEventIds).toEqual(["ev_l1", "ev_l2"]);
    expect(out[0].name).toContain("Ana");
  });

  it("refuses a single loop — the floor is 2", () => {
    expect(emergeGoals({ loops: [loop({ loopId: "l1" })] })).toEqual([]);
  });

  it("refuses 4 loops as one proposal — the ceiling is 3", () => {
    const loops = ["l1", "l2", "l3", "l4"].map((id, i) =>
      loop({ loopId: id, spaceId: i % 2 === 0 ? "arc_a" : "arc_b" }),
    );
    for (const p of emergeGoals({ loops })) expect(p.loopIds.length).toBeLessThanOrEqual(3);
  });

  it("refuses loops that all sit in one space", () => {
    expect(
      emergeGoals({ loops: [loop({ loopId: "l1" }), loop({ loopId: "l2" })] }),
    ).toEqual([]);
  });

  it("refuses a single shared anchor", () => {
    const out = emergeGoals({
      loops: [
        loop({ loopId: "l1", spaceId: "arc_a", anchorEntityIds: ["ent_me", "ent_ana"] }),
        loop({ loopId: "l2", spaceId: "arc_b", anchorEntityIds: ["ent_me", "ent_bo"] }),
      ],
    });
    expect(out).toEqual([]);
  });

  it("refuses loops on different horizons", () => {
    const out = emergeGoals({
      loops: [
        loop({ loopId: "l1", spaceId: "arc_a", horizon: "week" }),
        loop({ loopId: "l2", spaceId: "arc_b", horizon: "year" }),
      ],
    });
    expect(out).toEqual([]);
  });

  it("`none` is the absence of a horizon and never groups", () => {
    const out = emergeGoals({
      loops: [
        loop({ loopId: "l1", spaceId: "arc_a", horizon: "none" }),
        loop({ loopId: "l2", spaceId: "arc_b", horizon: "none" }),
      ],
    });
    expect(out).toEqual([]);
  });

  it("refuses loops whose arcs are not promoted — spaces are promoted arcs", () => {
    const out = emergeGoals({
      loops: [
        loop({ loopId: "l1", spaceId: "arc_a", spacePromoted: false }),
        loop({ loopId: "l2", spaceId: "arc_b", spacePromoted: false }),
      ],
    });
    expect(out).toEqual([]);
  });

  it("ACCEPTANCE — a loop with no evidence row cannot contribute to a goal", () => {
    const out = emergeGoals({
      loops: [
        loop({ loopId: "l1", spaceId: "arc_a", evidenceEventIds: [] }),
        loop({ loopId: "l2", spaceId: "arc_b", evidenceEventIds: [] }),
      ],
    });
    expect(out).toEqual([]);
  });

  it("every proposal carries at least one evidence event", () => {
    const loops = ["l1", "l2", "l3"].map((id, i) =>
      loop({ loopId: id, spaceId: ["arc_a", "arc_b", "arc_c"][i] }),
    );
    const out = emergeGoals({ loops });
    expect(out.length).toBeGreaterThan(0);
    for (const p of out) expect(p.evidenceEventIds.length).toBeGreaterThan(0);
  });

  it("the proposal key is stable across ordering", () => {
    const a = emergeGoals({
      loops: [loop({ loopId: "l1", spaceId: "arc_a" }), loop({ loopId: "l2", spaceId: "arc_b" })],
    });
    const b = emergeGoals({
      loops: [loop({ loopId: "l2", spaceId: "arc_b" }), loop({ loopId: "l1", spaceId: "arc_a" })],
    });
    expect(a[0].proposalKey).toBe(b[0].proposalKey);
    expect(a[0].proposalKey).toBe(proposalKeyFor("month", ["ent_me", "ent_ana"], ["arc_b", "arc_a"]));
  });

  it("does not re-emit a 3-loop superset that adds no space and no anchor change", () => {
    const loops = [
      loop({ loopId: "l1", spaceId: "arc_a" }),
      loop({ loopId: "l2", spaceId: "arc_b" }),
      loop({ loopId: "l3", spaceId: "arc_b" }),
    ];
    const keys = new Set(emergeGoals({ loops }).map((p) => p.proposalKey));
    expect(keys.size).toBe(emergeGoals({ loops }).length);
  });
});

// ---- against the schema ----------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-goals-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function entity(id: string, canonical = id): string {
  getDb()
    .prepare(`INSERT OR REPLACE INTO entities (id, type, canonical, provisional) VALUES (?, ?, ?, 0)`)
    .run(id, "person", canonical);
  return id;
}

function arc(id: string, anchors: string[], promoted = true): string {
  getDb()
    .prepare(
      `INSERT INTO arcs (id, arc_key, anchor_entity_ids, promoted, status) VALUES (?, ?, ?, ?, 'active')`,
    )
    .run(id, `key_${id}`, JSON.stringify(anchors), promoted ? 1 : 0);
  return id;
}

function event(id: string): string {
  getDb().prepare(`INSERT INTO events (id, ts, kind, text) VALUES (?, ?, 'message', ?)`).run(
    id,
    "2026-08-16T09:00:00.000Z",
    `text of ${id}`,
  );
  return id;
}

function dbLoop(
  id: string,
  arcId: string,
  opts: { horizon?: string; owner?: string; cpty?: string; evidence?: string[] } = {},
): string {
  getDb()
    .prepare(
      `INSERT INTO loops (id, loop_key, intent, horizon, owner_id, counterparty_id, arc_id, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
    )
    .run(
      id,
      `lk_${id}`,
      `intent ${id}`,
      opts.horizon ?? "month",
      opts.owner ?? null,
      opts.cpty ?? null,
      arcId,
    );
  for (const ev of opts.evidence ?? []) {
    event(ev);
    getDb()
      .prepare(
        `INSERT INTO evidence (subject_kind, subject_id, event_id, quote) VALUES ('loop', ?, ?, ?)`,
      )
      .run(id, ev, `quote from ${ev}`);
  }
  return id;
}

describe("goal emergence against the real schema", () => {
  it("goal_spaces.space_id is an ARC id — the promoted arc IS the space", () => {
    const me = entity("ent_me", "Me");
    const ana = entity("ent_ana", "Ana");
    arc("arc_a", [me, ana]);
    arc("arc_b", [me, ana]);
    dbLoop("l1", "arc_a", { owner: me, cpty: ana, evidence: ["ev1"] });
    dbLoop("l2", "arc_b", { owner: me, cpty: ana, evidence: ["ev2"] });

    const proposals = proposeGoals();
    expect(proposals).toHaveLength(1);
    const result = confirmGoalProposal(proposals[0]);
    expect(result.created).toBe(true);

    const goals = readGoals();
    expect(goals).toHaveLength(1);
    expect(goals[0].spaceIds).toEqual(["arc_a", "arc_b"]);
    expect(goals[0].kind).toBe(LIFE_PROJECT_KIND);
    // The FK holds because the space id is an arc id.
    expect(
      getDb().prepare(`SELECT COUNT(*) AS n FROM arcs WHERE id IN ('arc_a','arc_b')`).get(),
    ).toEqual({ n: 2 });
  });

  it("ACCEPTANCE — loops without evidence rows produce no goal at all", () => {
    const me = entity("ent_me", "Me");
    const ana = entity("ent_ana", "Ana");
    arc("arc_a", [me, ana]);
    arc("arc_b", [me, ana]);
    dbLoop("l1", "arc_a", { owner: me, cpty: ana });
    dbLoop("l2", "arc_b", { owner: me, cpty: ana });

    expect(proposeGoals()).toEqual([]);
    sweepGoalEmergence({ confirm: true });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM goals`).get()).toEqual({ n: 0 });
  });

  it("ACCEPTANCE — confirming a hand-made evidence-free proposal throws", () => {
    const forged: GoalProposal = {
      proposalKey: proposalKeyFor("month", ["e1", "e2"], ["arc_a", "arc_b"]),
      name: "scaffolded",
      kind: LIFE_PROJECT_KIND,
      horizon: "month",
      spaceIds: ["arc_a", "arc_b"],
      loopIds: ["l1", "l2"],
      sharedAnchorIds: ["e1", "e2"],
      evidenceEventIds: [],
    };
    expect(() => confirmGoalProposal(forged)).toThrow(/no evidence/);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM goals`).get()).toEqual({ n: 0 });
  });

  it("refuses a proposal that links fewer than two spaces", () => {
    const forged: GoalProposal = {
      proposalKey: "k",
      name: "one space",
      kind: LIFE_PROJECT_KIND,
      horizon: "month",
      spaceIds: ["arc_a"],
      loopIds: ["l1", "l2"],
      sharedAnchorIds: ["e1", "e2"],
      evidenceEventIds: ["ev1"],
    };
    expect(() => confirmGoalProposal(forged)).toThrow(/spaces/);
  });

  it("loops in unpromoted arcs are invisible to emergence", () => {
    const me = entity("ent_me", "Me");
    const ana = entity("ent_ana", "Ana");
    arc("arc_a", [me, ana], false);
    arc("arc_b", [me, ana], false);
    dbLoop("l1", "arc_a", { owner: me, cpty: ana, evidence: ["ev1"] });
    dbLoop("l2", "arc_b", { owner: me, cpty: ana, evidence: ["ev2"] });
    expect(readEmergenceInput().loops).toEqual([]);
    expect(proposeGoals()).toEqual([]);
  });

  it("confirmation is idempotent — re-running rebinds to the same goal id", () => {
    const me = entity("ent_me", "Me");
    const ana = entity("ent_ana", "Ana");
    arc("arc_a", [me, ana]);
    arc("arc_b", [me, ana]);
    dbLoop("l1", "arc_a", { owner: me, cpty: ana, evidence: ["ev1"] });
    dbLoop("l2", "arc_b", { owner: me, cpty: ana, evidence: ["ev2"] });

    const first = sweepGoalEmergence({ confirm: true });
    const second = sweepGoalEmergence({ confirm: true });
    expect(second.confirmed[0].goalId).toBe(first.confirmed[0].goalId);
    expect(second.confirmed[0].created).toBe(false);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM goals`).get()).toEqual({ n: 1 });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM goal_spaces`).get()).toEqual({ n: 2 });
    expect(first.confirmed[0].goalId).toBe(goalIdForKey(first.proposals[0].proposalKey));
  });

  it("proposing writes nothing — confirmation is a separate act", () => {
    const me = entity("ent_me", "Me");
    const ana = entity("ent_ana", "Ana");
    arc("arc_a", [me, ana]);
    arc("arc_b", [me, ana]);
    dbLoop("l1", "arc_a", { owner: me, cpty: ana, evidence: ["ev1"] });
    dbLoop("l2", "arc_b", { owner: me, cpty: ana, evidence: ["ev2"] });

    const sweep = sweepGoalEmergence();
    expect(sweep.proposals).toHaveLength(1);
    expect(sweep.confirmed).toEqual([]);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM goals`).get()).toEqual({ n: 0 });
  });

  it("every emergence write leaves a mutations row (§11.6 ⑨)", () => {
    const me = entity("ent_me", "Me");
    const ana = entity("ent_ana", "Ana");
    arc("arc_a", [me, ana]);
    arc("arc_b", [me, ana]);
    dbLoop("l1", "arc_a", { owner: me, cpty: ana, evidence: ["ev1"] });
    dbLoop("l2", "arc_b", { owner: me, cpty: ana, evidence: ["ev2"] });

    const sweep = sweepGoalEmergence({ confirm: true, runId: "run_1" });
    const goalId = sweep.confirmed[0].goalId;
    const muts = mutationsFor("goal", goalId);
    expect(muts.length).toBeGreaterThanOrEqual(3); // emerged_from_json + two space links
    expect(muts.every((m) => m.actor === EMERGENCE_ACTOR)).toBe(true);
    expect(muts.some((m) => m.field === "emerged_from_json")).toBe(true);
  });

  it("emerged_from_json records the loops, spaces, anchors and evidence behind the goal", () => {
    const me = entity("ent_me", "Me");
    const ana = entity("ent_ana", "Ana");
    arc("arc_a", [me, ana]);
    arc("arc_b", [me, ana]);
    dbLoop("l1", "arc_a", { owner: me, cpty: ana, evidence: ["ev1"] });
    dbLoop("l2", "arc_b", { owner: me, cpty: ana, evidence: ["ev2"] });

    const sweep = sweepGoalEmergence({ confirm: true });
    const row = getDb()
      .prepare(`SELECT emerged_from_json FROM goals WHERE id = ?`)
      .get(sweep.confirmed[0].goalId) as { emerged_from_json: string };
    const provenance = JSON.parse(row.emerged_from_json) as Record<string, string[]>;
    expect(provenance.loopIds).toEqual(["l1", "l2"]);
    expect(provenance.spaceIds).toEqual(["arc_a", "arc_b"]);
    expect(provenance.sharedAnchorIds).toEqual(["ent_ana", "ent_me"]);
    expect(provenance.evidenceEventIds).toEqual(["ev1", "ev2"]);
  });

  it("the derived name uses canonical entity names", () => {
    const me = entity("ent_me", "Me");
    const ana = entity("ent_ana", "Ana Ruiz");
    arc("arc_a", [me, ana]);
    arc("arc_b", [me, ana]);
    dbLoop("l1", "arc_a", { owner: me, cpty: ana, horizon: "quarter", evidence: ["ev1"] });
    dbLoop("l2", "arc_b", { owner: me, cpty: ana, horizon: "quarter", evidence: ["ev2"] });
    const p = proposeGoals();
    expect(p[0].name).toContain("Ana Ruiz");
    expect(p[0].name).toContain("this quarter");
  });
});
