// ===========================================================================
// Reconcile (§11.2, item 2.5) — the second phase of the two-phase commit.
//
// Four eval families live here:
//   L-028..L-031  aging: live→dormant at 3w, →archived at 12w
//   L-032..L-035  arc-id stability across a full re-derivation
//   L-036..L-039  two provisionals for the same trip, created in parallel
//                 cohorts, merged BEFORE either surfaces
//   L-040         a user split persists; reconcile plans around it
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { logMutation } from "../entities/merge.js";
import { arcKey } from "./key.js";
import {
  ARC_ARCHIVED,
  ARC_DORMANT,
  ARC_LIVE,
  arcEpisodeIds,
  commitArc,
  readArc,
  readArcs,
  readProvisionalArcs,
  writeProvisionalArc,
} from "./provisional.js";
import {
  ARC_ARCHIVE_MS,
  ARC_DORMANT_MS,
  ageDecisions,
  compactAnchors,
  readEpisodeFacts,
  readUserConstraints,
  reconcile,
} from "./reconcile.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const WEEK = 7 * 24 * 60 * 60 * 1000;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-arcrec-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedEntity(id: string, type = "person", mergedInto: string | null = null): string {
  getDb()
    .prepare(`INSERT OR REPLACE INTO entities (id, type, canonical, merged_into) VALUES (?, ?, ?, ?)`)
    .run(id, type, id, mergedInto);
  return id;
}

function seedEpisode(
  id: string,
  opts: { entityIds?: string[]; label?: string; sourceId?: string; started?: string; ended?: string } = {},
): string {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO episodes (id, stream_id, source_id, topic_label, entity_ids, started_at, ended_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts.sourceId ?? "whatsapp",
      opts.label ?? "Goa trip",
      JSON.stringify(opts.entityIds ?? ["a1"]),
      opts.started ?? "2026-08-10T00:00:00Z",
      opts.ended ?? "2026-08-11T00:00:00Z",
    );
  return id;
}

describe("① two provisionals for the same trip merge before either surfaces (L-036..L-039)", () => {
  it("folds parallel-cohort twins into one committed arc", () => {
    seedEntity("a1");
    seedEntity("a2");
    seedEpisode("ep_wa", { entityIds: ["a1", "a2"], sourceId: "whatsapp" });
    seedEpisode("ep_cal", { entityIds: ["a1", "a2"], sourceId: "calendar" });
    // Two cohorts, running at the same instant, neither able to see the other.
    writeProvisionalArc({ batchId: "c1", arcKeyCandidate: "unused", episodeIds: ["ep_wa"], now: NOW });
    writeProvisionalArc({ batchId: "c2", arcKeyCandidate: "unused", episodeIds: ["ep_cal"], now: NOW });
    expect(readArcs()).toHaveLength(0);

    const result = reconcile({ now: NOW });
    expect(result.groups).toHaveLength(1);
    expect(result.merged).toBe(1);
    expect(result.minted).toBe(1);
    expect(readArcs()).toHaveLength(1);
    expect(arcEpisodeIds(result.groups[0]!.arcId).sort()).toEqual(["ep_cal", "ep_wa"]);
    expect(readProvisionalArcs()).toEqual([]);
  });

  it("THE THESIS ROW: the one arc spans both sources (L-041..L-045)", () => {
    seedEntity("a1");
    seedEntity("a2");
    seedEpisode("ep_wa", { entityIds: ["a1", "a2"], sourceId: "whatsapp" });
    seedEpisode("ep_cal", { entityIds: ["a1", "a2"], sourceId: "calendar" });
    writeProvisionalArc({ batchId: "c1", arcKeyCandidate: "x", episodeIds: ["ep_wa", "ep_cal"], now: NOW });

    const result = reconcile({ now: NOW });
    expect(readArc(result.groups[0]!.arcId)?.sourceIds).toEqual(["calendar", "whatsapp"]);
  });

  it("keeps two genuinely different matters apart", () => {
    seedEntity("a1");
    seedEntity("a9");
    seedEpisode("ep_goa", { entityIds: ["a1"], label: "Goa trip" });
    seedEpisode("ep_dentist", { entityIds: ["a9"], label: "dentist appointment" });
    writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_goa"], now: NOW });
    writeProvisionalArc({ arcKeyCandidate: "y", episodeIds: ["ep_dentist"], now: NOW });

    const result = reconcile({ now: NOW });
    expect(result.groups).toHaveLength(2);
    expect(result.merged).toBe(0);
  });

  it("reconciles one cohort boundary at a time when a batch is named", () => {
    seedEntity("a1");
    seedEpisode("ep_1");
    seedEpisode("ep_2");
    writeProvisionalArc({ batchId: "c1", arcKeyCandidate: "x", episodeIds: ["ep_1"], now: NOW });
    writeProvisionalArc({ batchId: "c2", arcKeyCandidate: "x", episodeIds: ["ep_2"], now: NOW });
    reconcile({ now: NOW, batchId: "c1" });
    expect(readProvisionalArcs().map((p) => p.batchId)).toEqual(["c2"]);
  });
});

describe("② arc-id stability across a full re-derivation (L-032..L-035)", () => {
  it("runs 2 through 5 rebind to the id run 1 minted, keeping labels and pins", () => {
    seedEntity("a1");
    seedEntity("a2");
    seedEpisode("ep_1", { entityIds: ["a1", "a2"] });

    writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_1"], now: NOW });
    const first = reconcile({ now: NOW });
    const arcId = first.groups[0]!.arcId;

    getDb().prepare(`UPDATE arcs SET user_label = 'Our Goa week', user_pinned = 1 WHERE id = ?`).run(arcId);

    const ids = [2, 3, 4, 5].map((n) => {
      writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_1"], now: NOW + n });
      return reconcile({ now: NOW + n }).groups[0]!.arcId;
    });

    expect(new Set(ids)).toEqual(new Set([arcId]));
    expect(readArcs()).toHaveLength(1);
    const arc = readArc(arcId);
    expect(arc?.userLabel).toBe("Our Goa week");
    expect(arc?.userPinned).toBe(1);
  });

  it("rebinds a provisional onto an arc that is already committed", () => {
    seedEntity("a1");
    seedEpisode("ep_1", { entityIds: ["a1"] });
    seedEpisode("ep_2", { entityIds: ["a1"] });
    const key = arcKey([{ entityId: "a1", type: "person" }], "Goa trip");
    const existing = commitArc({ arcKey: key, label: "Goa trip", anchorEntityIds: ["a1"], sourceIds: [], now: NOW });

    writeProvisionalArc({ arcKeyCandidate: key, episodeIds: ["ep_2"], now: NOW });
    const result = reconcile({ now: NOW });
    expect(result.rebound).toBe(1);
    expect(result.minted).toBe(0);
    expect(result.groups[0]!.arcId).toBe(existing.id);
  });
});

describe("③ aging (L-028..L-031)", () => {
  const arc = (state: string, quietWeeks: number) => ({
    id: `arc_${state}_${quietWeeks}`,
    state,
    lastEvidenceAt: new Date(NOW - quietWeeks * WEEK).toISOString(),
  });

  it("live → dormant at three weeks quiet, and the boundary day itself fades", () => {
    for (const weeks of [3, 4, 5, 6]) {
      const [change] = ageDecisions([arc(ARC_LIVE, weeks)], NOW);
      expect(change?.to).toBe(ARC_DORMANT);
    }
    expect(ageDecisions([arc(ARC_LIVE, 2)], NOW)).toEqual([]);
  });

  it("→ archived at twelve weeks quiet", () => {
    expect(ageDecisions([arc(ARC_LIVE, 12)], NOW)[0]?.to).toBe(ARC_ARCHIVED);
    expect(ageDecisions([arc(ARC_DORMANT, 20)], NOW)[0]?.to).toBe(ARC_ARCHIVED);
  });

  it("the bars are exactly 3 and 12 weeks", () => {
    expect(ARC_DORMANT_MS).toBe(3 * WEEK);
    expect(ARC_ARCHIVE_MS).toBe(12 * WEEK);
  });

  it("only ever moves forward — silence revives nothing", () => {
    expect(ageDecisions([arc(ARC_DORMANT, 1)], NOW)).toEqual([]);
    expect(ageDecisions([arc(ARC_ARCHIVED, 40)], NOW)).toEqual([]);
  });

  it("never ages an arc whose last evidence cannot be read", () => {
    expect(ageDecisions([{ id: "arc_x", state: ARC_LIVE, lastEvidenceAt: null }], NOW)).toEqual([]);
  });

  it("④ a PINNED arc is exempt from the clock entirely", () => {
    expect(ageDecisions([{ ...arc(ARC_LIVE, 30), userPinned: 1 }], NOW)).toEqual([]);
    expect(ageDecisions([arc(ARC_LIVE, 30)], NOW, new Set([arc(ARC_LIVE, 30).id]))).toEqual([]);
  });

  it("writes the transition and one mutation per change", () => {
    seedEntity("a1");
    const key = arcKey([{ entityId: "a1", type: "person" }], "old thread");
    const row = commitArc({
      arcKey: key,
      label: "old thread",
      anchorEntityIds: ["a1"],
      sourceIds: [],
      lastEvidenceAt: new Date(NOW - 5 * WEEK).toISOString(),
      now: NOW,
    });
    const result = reconcile({ now: NOW });
    expect(result.aged).toEqual([expect.objectContaining({ arcId: row.id, from: ARC_LIVE, to: ARC_DORMANT })]);
    expect(readArc(row.id)?.state).toBe(ARC_DORMANT);
    const muts = getDb()
      .prepare(`SELECT * FROM mutations WHERE target_id = ? AND field = 'state'`)
      .all(row.id) as Record<string, unknown>[];
    expect(muts).toHaveLength(1);
    expect(muts[0]?.run_id).toBe(result.runId);
  });
});

describe("④ user constraints are HARD WALLS (L-040)", () => {
  it("a split PERSISTS: reconcile never re-merges what the user took apart", () => {
    seedEntity("a1");
    seedEpisode("ep_keep", { entityIds: ["a1"] });
    seedEpisode("ep_split", { entityIds: ["a1"] });

    writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_keep", "ep_split"], now: NOW });
    const first = reconcile({ now: NOW });
    const arcId = first.groups[0]!.arcId;
    expect(arcEpisodeIds(arcId).sort()).toEqual(["ep_keep", "ep_split"]);

    // The user pulls one episode out. That is a fact reconcile may not undo.
    logMutation({
      actor: "user",
      targetKind: "arc",
      targetId: arcId,
      field: "split",
      newValue: { episodeIds: ["ep_split"] },
      reason: "not part of that trip",
    });
    getDb().prepare(`DELETE FROM arc_episodes WHERE arc_id = ? AND episode_id = ?`).run(arcId, "ep_split");

    // Re-run: the same evidence would group them again.
    writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_keep", "ep_split"], now: NOW + 1 });
    const second = reconcile({ now: NOW + 1 });

    expect(arcEpisodeIds(arcId)).toEqual(["ep_keep"]);
    expect(second.walls.some((w) => w.kind === "split" && w.episodeId === "ep_split")).toBe(true);
    // The exiled episode is still waiting, under a key of its own.
    expect(readProvisionalArcs()[0]?.episodeIds).toEqual(["ep_split"]);
  });

  it("a user MOVE welds an episode where they put it", () => {
    seedEntity("a1");
    seedEpisode("ep_1", { entityIds: ["a1"] });
    const home = commitArc({
      arcKey: arcKey([{ entityId: "a9", type: "person" }], "elsewhere"),
      label: "elsewhere",
      anchorEntityIds: ["a9"],
      sourceIds: [],
      now: NOW,
    });
    logMutation({
      actor: "user",
      targetKind: "arc",
      targetId: home.id,
      field: "move",
      newValue: { episodeIds: ["ep_1"] },
    });

    writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_1"], now: NOW });
    const result = reconcile({ now: NOW });
    expect(arcEpisodeIds(home.id)).toEqual(["ep_1"]);
    expect(result.walls.some((w) => w.kind === "welded")).toBe(true);
  });

  it("reads pins, moves and splits off the rows a user action leaves behind", () => {
    seedEntity("a1");
    const arc = commitArc({ arcKey: "k", label: "x", anchorEntityIds: [], sourceIds: [], now: NOW });
    getDb().prepare(`UPDATE arcs SET user_pinned = 1 WHERE id = ?`).run(arc.id);
    logMutation({
      actor: "user",
      targetKind: "arc",
      targetId: arc.id,
      field: "split",
      newValue: { episodeIds: ["ep_a"], toArcId: "arc_other" },
    });
    const constraints = readUserConstraints();
    expect(constraints.pinned.has(arc.id)).toBe(true);
    expect(constraints.forbidden.has(`${arc.id} ep_a`)).toBe(true);
    expect(constraints.welded.get("ep_a")).toBe("arc_other");
  });

  it("ignores a mutation nobody can parse rather than throwing", () => {
    getDb()
      .prepare(
        `INSERT INTO mutations (id, actor, target_kind, target_id, field, new_json)
         VALUES ('m1', 'user', 'arc', 'arc_x', 'split', '{not json')`,
      )
      .run();
    expect(() => readUserConstraints()).not.toThrow();
  });
});

describe("⑤ merged-entity redirects are compacted before the key is computed", () => {
  it("follows merged_into, so two arcs anchored on the same person become one", () => {
    seedEntity("a_survivor");
    seedEntity("a_dupe", "person", "a_survivor");
    seedEpisode("ep_1", { entityIds: ["a_survivor"] });
    seedEpisode("ep_2", { entityIds: ["a_dupe"] });

    writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_1"], now: NOW });
    writeProvisionalArc({ arcKeyCandidate: "y", episodeIds: ["ep_2"], now: NOW });

    const result = reconcile({ now: NOW });
    expect(result.groups).toHaveLength(1);
    expect(result.redirects).toContainEqual({ from: "a_dupe", to: "a_survivor" });
  });

  it("keeps an unknown entity as itself — a data gap must not move a key", () => {
    const { anchors, redirects } = compactAnchors([{ entityId: "a_ghost", type: "person" }]);
    expect(anchors[0]?.entityId).toBe("a_ghost");
    expect(redirects).toEqual([]);
  });
});

describe("⑥ every change is one undoable run", () => {
  it("stamps one run id on every mutation the pass wrote", () => {
    seedEntity("a1");
    seedEpisode("ep_1", { entityIds: ["a1"] });
    writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_1"], now: NOW });
    const result = reconcile({ now: NOW });
    const runIds = (getDb().prepare(`SELECT DISTINCT run_id FROM mutations`).all() as { run_id: string }[]).map(
      (r) => r.run_id,
    );
    expect(runIds).toEqual([result.runId]);
    expect(result.mutations).toBeGreaterThan(0);
  });

  it("accepts a caller's run id so several passes undo together", () => {
    seedEntity("a1");
    seedEpisode("ep_1", { entityIds: ["a1"] });
    writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_1"], now: NOW });
    expect(reconcile({ now: NOW, runId: "rec_fixed" }).runId).toBe("rec_fixed");
  });

  it("is a no-op with nothing to reconcile", () => {
    const result = reconcile({ now: NOW });
    expect(result.groups).toEqual([]);
    expect(result.mutations).toBe(0);
  });
});

describe("episode facts", () => {
  it("reads anchors with their entity types, so rung ② can weight them", () => {
    seedEntity("a1", "person");
    seedEntity("t1", "topic");
    seedEpisode("ep_1", { entityIds: ["a1", "t1"] });
    const facts = readEpisodeFacts(["ep_1"]);
    expect(facts[0]?.anchors).toEqual([
      { entityId: "a1", type: "person" },
      { entityId: "t1", type: "topic" },
    ]);
  });

  it("returns nothing for no ids rather than reading the whole table", () => {
    expect(readEpisodeFacts([])).toEqual([]);
  });
});
