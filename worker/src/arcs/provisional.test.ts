// ===========================================================================
// Arc persistence and the two-phase commit (§11.2, item 2.5).
//
// The property under test throughout: a NEW arc does not exist. It is a row in
// `provisional_arcs` with no arc id and no surface until reconcile commits it
// (evals L-036..L-039), and a JOIN lands in `arc_episodes` immediately because
// the arc it joins already exists and already surfaces.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { arcKey } from "./key.js";
import type { LadderResult } from "./ladder.js";
import {
  ARC_ARCHIVED,
  ARC_LIVE,
  applyLadderResult,
  arcEpisodeIds,
  askArcQuestion,
  attachEpisode,
  commitArc,
  deleteProvisionalArcs,
  persistArcVerdict,
  readArc,
  readArcByKey,
  readArcCandidates,
  readProvisionalArcs,
  writeProvisionalArc,
} from "./provisional.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-arcstore-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const KEY = arcKey([{ entityId: "a1", type: "person" }], "Goa trip");

/**
 * `arc_episodes` and `arc_verdicts` both hold a foreign key into `episodes`, so
 * an arc can only ever be built over episodes that exist. These tests seed the
 * row directly rather than running the episode engine: what is under test here
 * is arc persistence, not episode persistence.
 */
function seedEpisode(id: string, entityIds: readonly string[] = ["a1"]): string {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO episodes (id, stream_id, source_id, topic_label, entity_ids, started_at, ended_at)
       VALUES (?, NULL, 'whatsapp', 'Goa trip', ?, '2026-08-10T00:00:00Z', '2026-08-11T00:00:00Z')`,
    )
    .run(id, JSON.stringify([...entityIds]));
  return id;
}

const ladderResult = (over: Partial<LadderResult> = {}): LadderResult => ({
  episodeId: "ep_1",
  decision: "new",
  rung: null,
  arcId: null,
  confidence: 0,
  modelCalls: 0,
  ambient: false,
  bridge: null,
  overlaps: [],
  similarities: [],
  nominated: [],
  verdict: null,
  demotedReason: null,
  violations: [],
  question: null,
  reason: "test",
  ...over,
});

describe("commitArc — rebind or mint (L-032..L-035)", () => {
  it("mints a derived id, so a clean database reproduces it", () => {
    const arc = commitArc({ arcKey: KEY, label: "Goa trip", anchorEntityIds: ["a1"], sourceIds: ["wa"], now: NOW });
    expect(arc.id).toBe(`arc_${KEY.slice(0, 16)}`);
    expect(arc.state).toBe(ARC_LIVE);
    expect(arc.promoted).toBe(0);
  });

  it("rebinds to the same id on a second derivation and widens the sets", () => {
    const first = commitArc({
      arcKey: KEY,
      label: "Goa trip",
      anchorEntityIds: ["a1"],
      sourceIds: ["wa"],
      startedAt: "2026-08-10T00:00:00Z",
      lastEvidenceAt: "2026-08-11T00:00:00Z",
      now: NOW,
    });
    const second = commitArc({
      arcKey: KEY,
      label: "Goa trip",
      anchorEntityIds: ["a2"],
      sourceIds: ["calendar"],
      startedAt: "2026-08-08T00:00:00Z",
      lastEvidenceAt: "2026-08-14T00:00:00Z",
      now: NOW,
    });
    expect(second.id).toBe(first.id);
    expect(second.anchorEntityIds).toEqual(["a1", "a2"]);
    expect(second.sourceIds).toEqual(["calendar", "wa"]);
    expect(second.startedAt).toBe("2026-08-08T00:00:00Z");
    expect(second.lastEvidenceAt).toBe("2026-08-14T00:00:00Z");
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM arcs`).get()).toEqual({ n: 1 });
  });

  it("keeps the id when the KEY moves — the user's label survives the import", () => {
    const first = commitArc({ arcKey: KEY, label: "Goa trip", anchorEntityIds: ["a1"], sourceIds: [], now: NOW });
    getDb().prepare(`UPDATE arcs SET user_label = 'Our Goa week', user_pinned = 1 WHERE id = ?`).run(first.id);

    const moved = arcKey([{ entityId: "a1", type: "person" }, { entityId: "a2", type: "person" }], "Goa trip");
    const again = commitArc({
      id: first.id,
      arcKey: moved,
      label: "Goa trip",
      anchorEntityIds: ["a1", "a2"],
      sourceIds: [],
      now: NOW,
    });
    expect(again.id).toBe(first.id);
    expect(again.arcKey).toBe(moved);
    expect(again.userLabel).toBe("Our Goa week");
    expect(again.userPinned).toBe(1);
    expect(readArcByKey(moved)?.id).toBe(first.id);
  });

  it("never writes a promotion field — item 3.6 owns every one of them", () => {
    const arc = commitArc({ arcKey: KEY, label: "x", anchorEntityIds: [], sourceIds: [], now: NOW });
    const row = getDb().prepare(`SELECT * FROM arcs WHERE id = ?`).get(arc.id) as Record<string, unknown>;
    expect(row.promoted).toBe(0);
    expect(row.promotion_reason).toBeNull();
    expect(row.archetype).toBeNull();
    expect(row.archetype_source).toBeNull();
    expect(row.status).toBeNull();
    expect(row.ends_at).toBeNull();
    expect(row.cadence).toBeNull();
    expect(row.user_label).toBeNull();
  });
});

describe("provisional arcs have no id and no surface", () => {
  it("writes nothing to `arcs`", () => {
    writeProvisionalArc({ batchId: "cohort_1", arcKeyCandidate: KEY, episodeIds: ["ep_1"], now: NOW });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM arcs`).get()).toEqual({ n: 0 });
    expect(readArcCandidates()).toEqual([]);
  });

  it("is readable by batch, which is what a cohort boundary reconciles", () => {
    writeProvisionalArc({ batchId: "c1", arcKeyCandidate: KEY, episodeIds: ["ep_1"], now: NOW });
    writeProvisionalArc({ batchId: "c2", arcKeyCandidate: KEY, episodeIds: ["ep_2"], now: NOW });
    expect(readProvisionalArcs("c1")).toHaveLength(1);
    expect(readProvisionalArcs()).toHaveLength(2);
  });

  it("is deleted the moment reconcile is done with it", () => {
    const row = writeProvisionalArc({ arcKeyCandidate: KEY, episodeIds: ["ep_1"], now: NOW });
    expect(deleteProvisionalArcs([row.id])).toBe(1);
    expect(readProvisionalArcs()).toEqual([]);
  });
});

describe("membership and verdicts", () => {
  it("attaches idempotently — a replay lands on the same row", () => {
    const arc = commitArc({ arcKey: KEY, label: "x", anchorEntityIds: [], sourceIds: [], now: NOW });
    seedEpisode("ep_1");
    attachEpisode({ arcId: arc.id, episodeId: "ep_1", addedBy: "bridge", signal: "bridge" });
    attachEpisode({ arcId: arc.id, episodeId: "ep_1", addedBy: "bridge", signal: "bridge" });
    expect(arcEpisodeIds(arc.id)).toEqual(["ep_1"]);
  });

  it("persists a verdict row per episode with the whole pass in output_json", () => {
    seedEpisode("ep_1");
    const id = persistArcVerdict({
      arcId: null,
      episodeId: "ep_1",
      decision: "defer",
      candidates: { nominated: ["arc_a"] },
      output: { rung: "adjudication" },
      now: NOW,
    });
    const row = getDb().prepare(`SELECT * FROM arc_verdicts WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row.episode_id).toBe("ep_1");
    expect(row.decision).toBe("defer");
    expect(JSON.parse(String(row.output_json))).toEqual({ rung: "adjudication" });
  });

  it("opens a question rather than retrying", () => {
    const id = askArcQuestion({ episodeId: "ep_1", question: "Same thread?", now: NOW });
    const row = getDb().prepare(`SELECT * FROM questions WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row.status).toBe("open");
    expect(row.target_kind).toBe("episode");
    expect(row.kind).toBe("arc_binding");
  });
});

describe("readArcCandidates", () => {
  it("offers live arcs and never an archived one", () => {
    const live = commitArc({ arcKey: KEY, label: "live one", anchorEntityIds: ["a1"], sourceIds: [], now: NOW });
    const dead = commitArc({
      arcKey: arcKey([{ entityId: "a9", type: "person" }], "old"),
      label: "old one",
      anchorEntityIds: ["a9"],
      sourceIds: [],
      now: NOW,
    });
    getDb().prepare(`UPDATE arcs SET state = ? WHERE id = ?`).run(ARC_ARCHIVED, dead.id);
    expect(readArcCandidates().map((c) => c.arcId)).toEqual([live.id]);
  });

  it("prefers the user's label over the derived one", () => {
    const arc = commitArc({ arcKey: KEY, label: "derived", anchorEntityIds: ["a1"], sourceIds: [], now: NOW });
    getDb().prepare(`UPDATE arcs SET user_label = 'mine' WHERE id = ?`).run(arc.id);
    expect(readArcCandidates()[0]?.label).toBe("mine");
  });
});

describe("applyLadderResult — the two-phase commit in one function", () => {
  const params = {
    anchors: [{ entityId: "a1", type: "person" }],
    label: "Goa trip",
    sourceId: "whatsapp",
    startedAt: "2026-08-10T00:00:00Z",
    endedAt: "2026-08-11T00:00:00Z",
    batchId: "cohort_1",
    now: NOW,
  };

  it("a JOIN binds membership now and widens the arc", () => {
    seedEpisode("ep_1");
    const arc = commitArc({ arcKey: KEY, label: "Goa trip", anchorEntityIds: [], sourceIds: [], now: NOW });
    const applied = applyLadderResult(
      ladderResult({ decision: "join", rung: "bridge", arcId: arc.id, confidence: 1 }),
      params,
    );
    expect(applied.arcId).toBe(arc.id);
    expect(applied.provisionalId).toBeNull();
    expect(arcEpisodeIds(arc.id)).toEqual(["ep_1"]);
    expect(readArc(arc.id)?.sourceIds).toEqual(["whatsapp"]);
    expect(readArc(arc.id)?.lastEvidenceAt).toBe("2026-08-11T00:00:00Z");
  });

  it("a NEW arc surfaces nowhere until reconcile", () => {
    seedEpisode("ep_1");
    const applied = applyLadderResult(ladderResult({ decision: "new" }), params);
    expect(applied.arcId).toBeNull();
    expect(applied.provisionalId).not.toBeNull();
    expect(readProvisionalArcs("cohort_1")[0]?.episodeIds).toEqual(["ep_1"]);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM arcs`).get()).toEqual({ n: 0 });
  });

  it("a DEFER is a provisional arc too — first paint is never blocked", () => {
    seedEpisode("ep_1");
    const applied = applyLadderResult(ladderResult({ decision: "defer", rung: "adjudication" }), params);
    expect(applied.provisionalId).not.toBeNull();
    expect(applied.questionId).toBeNull();
  });

  it("an ASK_USER opens a question AND parks the episode, binding nothing", () => {
    seedEpisode("ep_1");
    const applied = applyLadderResult(
      ladderResult({ decision: "ask_user", rung: "adjudication", question: "Same thread?" }),
      params,
    );
    expect(applied.questionId).not.toBeNull();
    expect(applied.provisionalId).not.toBeNull();
    expect(applied.arcId).toBeNull();
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM arc_episodes`).get()).toEqual({ n: 0 });
  });

  it("always persists a verdict, whatever the decision was", () => {
    seedEpisode("ep_1");
    applyLadderResult(ladderResult({ decision: "new" }), params);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM arc_verdicts`).get()).toEqual({ n: 1 });
  });
});
