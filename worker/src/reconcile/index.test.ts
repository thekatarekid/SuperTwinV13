// ===========================================================================
// The reconcile JOB (item 2.6) — one entry point, three cadences.
//
// What is under test here is the control plane, not the pass: item 2.5's
// `arcs/reconcile.test.ts` owns dedupe, rebind, aging and the walls.
//
//   ① one entry point, one run id, callable from all three callers
//   ② IDEMPOTENT — running twice changes nothing the second time (acceptance)
//   ③ monotonic output — a retracting run is rolled back, not shown
//   ④ the ≤ 12 calls/quiet-day budget gates steps, and the pass costs zero
//   ⑤ scheduling — cohort boundary (bootstrap), change (coalesced), nightly
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitArc, readArcs, writeProvisionalArc } from "../arcs/provisional.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { advanceCohort } from "../scheduler/cohorts.js";
import { writeCoverage } from "../scheduler/queue.js";
import {
  CHANGE_COALESCE_MS,
  NIGHTLY_INTERVAL_MS,
  STEADY_CALL_BUDGET,
  arcReconcileStep,
  lastNightlyAt,
  lastReconcileRun,
  modelCallsToday,
  mutationsForRun,
  nightlyDue,
  onArcChange,
  onCohortBoundary,
  pendingProvisionalCount,
  reconcileAfterTransition,
  reconcileSteps,
  registerReconcileStep,
  resetReconcileSchedule,
  resetReconcileSteps,
  retractions,
  runNightly,
  runReconcile,
  startOfUtcDay,
} from "./index.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-recjob-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetReconcileSteps();
  resetReconcileSchedule();
});

afterEach(() => {
  resetReconcileSteps();
  resetReconcileSchedule();
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedEntity(id: string): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO entities (id, type, canonical, merged_into) VALUES (?, 'person', ?, NULL)`)
    .run(id, id);
}

function seedEpisode(id: string, opts: { entityIds?: string[]; label?: string; sourceId?: string } = {}): string {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO episodes (id, stream_id, source_id, topic_label, entity_ids, started_at, ended_at)
       VALUES (?, NULL, ?, ?, ?, '2026-08-10T00:00:00Z', '2026-08-11T00:00:00Z')`,
    )
    .run(id, opts.sourceId ?? "whatsapp", opts.label ?? "Goa trip", JSON.stringify(opts.entityIds ?? ["a1"]));
  return id;
}

/** Two parallel cohorts that each produced a provisional for the same trip. */
function seedTwins(): void {
  seedEntity("a1");
  seedEntity("a2");
  seedEpisode("ep_wa", { entityIds: ["a1", "a2"], sourceId: "whatsapp" });
  seedEpisode("ep_cal", { entityIds: ["a1", "a2"], sourceId: "calendar" });
  writeProvisionalArc({ batchId: "c1", arcKeyCandidate: "x", episodeIds: ["ep_wa"], now: NOW });
  writeProvisionalArc({ batchId: "c2", arcKeyCandidate: "y", episodeIds: ["ep_cal"], now: NOW });
}

function seedRun(id: string, startedAt: string): void {
  getDb().prepare(`INSERT INTO runs (id, kind, started_at, status) VALUES (?, 'llm', ?, 'ok')`).run(id, startedAt);
}

// ---------------------------------------------------------------------------

describe("① one entry point, one run id", () => {
  it("runs the arc pass and stamps every mutation with the job's run id", () => {
    seedTwins();
    const report = runReconcile({ now: NOW, trigger: "manual", mode: "bootstrap" });

    expect(report.runId).toMatch(/^rec_/);
    expect(report.changes).toBeGreaterThan(0);
    expect(report.noop).toBe(false);
    expect(readArcs()).toHaveLength(1);
    expect(mutationsForRun(report.runId)).toBe(report.changes);

    // ⑥ "undoable as one run": every row this job wrote shares the one id.
    const ids = getDb()
      .prepare(`SELECT DISTINCT run_id AS id FROM mutations`)
      .all() as { id: string | null }[];
    expect(ids).toEqual([{ id: report.runId }]);
  });

  it("honours a caller-supplied run id so several passes undo as one", () => {
    seedTwins();
    const a = runReconcile({ now: NOW, runId: "rec_shared", batchId: "c1", mode: "bootstrap" });
    const b = runReconcile({ now: NOW, runId: "rec_shared", batchId: "c2", mode: "bootstrap" });
    expect(a.runId).toBe("rec_shared");
    expect(b.runId).toBe("rec_shared");
    expect(mutationsForRun("rec_shared")).toBeGreaterThan(1);
  });

  it("reconciles only the named cohort boundary's provisionals", () => {
    seedTwins();
    runReconcile({ now: NOW, batchId: "c1", trigger: "cohort_boundary", mode: "bootstrap" });
    expect(pendingProvisionalCount()).toBe(1);
  });

  it("persists the last run so the surface can render it after a restart", () => {
    seedTwins();
    const report = runReconcile({ now: NOW });
    expect(lastReconcileRun()?.runId).toBe(report.runId);
  });
});

describe("② ACCEPTANCE — running reconcile twice changes nothing the second time", () => {
  it("writes zero mutations on the second run", () => {
    seedTwins();
    const first = runReconcile({ now: NOW, mode: "bootstrap" });
    expect(first.changes).toBeGreaterThan(0);

    const second = runReconcile({ now: NOW, mode: "bootstrap" });
    expect(second.changes).toBe(0);
    expect(second.noop).toBe(true);
    expect(mutationsForRun(second.runId)).toBe(0);
  });

  it("leaves arc ids, membership and provisionals byte-identical", () => {
    seedTwins();
    runReconcile({ now: NOW, mode: "bootstrap" });
    const snapshot = () => ({
      arcs: getDb().prepare(`SELECT id, arc_key, state, label FROM arcs ORDER BY id`).all(),
      members: getDb().prepare(`SELECT arc_id, episode_id FROM arc_episodes ORDER BY arc_id, episode_id`).all(),
      provisionals: getDb().prepare(`SELECT arc_key_candidate, episode_ids FROM provisional_arcs`).all(),
    });
    const before = snapshot();
    runReconcile({ now: NOW, mode: "bootstrap" });
    expect(snapshot()).toEqual(before);
  });

  it("stays a no-op even when a user wall exiled episodes on the first run", () => {
    seedEntity("a1");
    seedEpisode("ep_1", { entityIds: ["a1"] });
    seedEpisode("ep_2", { entityIds: ["a1"] });
    writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_1", "ep_2"], now: NOW });
    const first = runReconcile({ now: NOW, mode: "bootstrap" });
    const arcId = readArcs()[0]!.id;

    // The user splits ep_2 back out, with nowhere to put it.
    getDb()
      .prepare(
        `INSERT INTO mutations (id, actor, target_kind, target_id, field, new_json)
         VALUES ('m_split', 'user', 'arc', ?, 'split', ?)`,
      )
      .run(arcId, JSON.stringify({ episodeIds: ["ep_2"] }));
    getDb().prepare(`DELETE FROM arc_episodes WHERE episode_id = 'ep_2'`).run();
    writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_2"], now: NOW });

    const second = runReconcile({ now: NOW, mode: "bootstrap" });
    expect(second.retracted).toEqual([]);
    const after = getDb().prepare(`SELECT id, episode_ids FROM provisional_arcs`).all();
    const third = runReconcile({ now: NOW, mode: "bootstrap" });
    expect(third.changes).toBe(0);
    expect(getDb().prepare(`SELECT id, episode_ids FROM provisional_arcs`).all()).toEqual(after);
    expect(first.changes).toBeGreaterThan(0);
  });
});

describe("③ output grows monotonically", () => {
  it("reports no retraction on a healthy run", () => {
    seedTwins();
    expect(runReconcile({ now: NOW, mode: "bootstrap" }).retracted).toEqual([]);
  });

  it("rolls the whole run back when a step would drop a surfaced arc", () => {
    seedEntity("a1");
    seedEpisode("ep_1", { entityIds: ["a1"] });
    writeProvisionalArc({ arcKeyCandidate: "x", episodeIds: ["ep_1"], now: NOW });
    runReconcile({ now: NOW, mode: "bootstrap" });
    const arcId = readArcs()[0]!.id;

    registerReconcileStep({
      name: "rogue",
      modelCalls: 0,
      run() {
        getDb().prepare(`DELETE FROM arcs WHERE id = ?`).run(arcId);
        return {};
      },
    });

    const report = runReconcile({ now: NOW + 1000, mode: "bootstrap" });
    expect(report.rolledBack).toBe(true);
    expect(report.retracted.map((r) => r.kind)).toContain("arc_vanished");
    expect(report.changes).toBe(0);
    // The arc the user could already see is still there.
    expect(readArcs().map((a) => a.id)).toEqual([arcId]);
    expect(report.steps.every((s) => !s.ran)).toBe(true);
  });

  it("names a coverage meter that moved backwards as a retraction", () => {
    const before = {
      arcs: new Map<string, number>(),
      coverage: new Map([["global/all/d7", { total: 100, done: 60 }]]),
    };
    const after = {
      arcs: new Map<string, number>(),
      coverage: new Map([["global/all/d7", { total: 100, done: 40 }]]),
    };
    expect(retractions(before, after)).toEqual([
      { kind: "coverage_regressed", targetId: "global/all/d7", detail: "a coverage meter moved backwards" },
    ]);
  });

  it("does not count losing episodes as fine — a shrunken arc is a retraction", () => {
    const before = { arcs: new Map([["arc_1", 3]]), coverage: new Map() };
    const after = { arcs: new Map([["arc_1", 1]]), coverage: new Map() };
    expect(retractions(before, after)[0]).toMatchObject({ kind: "episodes_lost", targetId: "arc_1" });
  });

  it("aging is not a retraction — the arc keeps its id and its episodes", () => {
    seedEntity("a1");
    seedEpisode("ep_old", { entityIds: ["a1"] });
    commitArc({
      arcKey: "k_old",
      label: "old",
      labelSource: "derived",
      anchorEntityIds: ["a1"],
      sourceIds: ["whatsapp"],
      startedAt: "2026-01-01T00:00:00Z",
      lastEvidenceAt: "2026-01-02T00:00:00Z",
      now: NOW,
    });
    const report = runReconcile({ now: NOW, mode: "steady" });
    expect(report.rolledBack).toBe(false);
    expect(report.retracted).toEqual([]);
    expect(readArcs()[0]!.state).toBe("archived");
  });

  it("a coverage row written before the run is preserved across it", () => {
    writeCoverage({ scopeKind: "global", scopeId: "all", horizon: "d7", totalUnits: 10, doneUnits: 4 });
    seedTwins();
    const report = runReconcile({ now: NOW, mode: "bootstrap" });
    expect(report.retracted).toEqual([]);
  });
});

describe("④ the ≤ 12 model calls/quiet-day budget", () => {
  it("the arc pass is [CODE] and costs nothing", () => {
    seedTwins();
    expect(arcReconcileStep.modelCalls).toBe(0);
    const report = runReconcile({ now: NOW, mode: "bootstrap" });
    expect(report.modelCalls).toBe(0);
    expect(report.budget.limit).toBe(STEADY_CALL_BUDGET);
  });

  it("counts today's spend off the runs table, not an in-memory counter", () => {
    seedRun("r_today", "2026-08-15T01:00:00.000Z");
    seedRun("r_also_today", "2026-08-15T23:59:00.000Z");
    seedRun("r_yesterday", "2026-08-14T23:00:00.000Z");
    expect(startOfUtcDay(NOW)).toBe("2026-08-15T00:00:00.000Z");
    expect(modelCallsToday(NOW)).toBe(2);
  });

  it("skips a step it cannot afford rather than overrunning the budget", () => {
    for (let i = 0; i < STEADY_CALL_BUDGET; i += 1) seedRun(`r_${i}`, "2026-08-15T01:00:00.000Z");
    let ran = false;
    registerReconcileStep({
      name: "expensive",
      modelCalls: 3,
      run() {
        ran = true;
        return {};
      },
    });
    const report = runReconcile({ now: NOW, mode: "steady" });
    const step = report.steps.find((s) => s.name === "expensive")!;
    expect(ran).toBe(false);
    expect(step.ran).toBe(false);
    expect(step.skipReason).toContain("budget");
    // The zero-cost pass still ran — the budget defers, it does not stop work.
    expect(report.steps.find((s) => s.name === "arcs")!.ran).toBe(true);
  });

  it("runs an affordable step and charges the budget for it", () => {
    registerReconcileStep({ name: "cheap", modelCalls: 2, run: () => ({ detail: { ok: true } }) });
    const report = runReconcile({ now: NOW, mode: "steady" });
    expect(report.modelCalls).toBe(2);
    expect(report.budget.remaining).toBe(STEADY_CALL_BUDGET - 2);
    expect(report.steps.find((s) => s.name === "cheap")!.detail).toEqual({ ok: true });
  });

  it("keeps the built-in registry to the one [CODE] step", () => {
    expect(reconcileSteps().map((s) => s.name)).toEqual(["arcs"]);
  });
});

describe("⑤ scheduling — the three cadences of §8.1", () => {
  it("bootstrap reconciles at every cohort boundary", () => {
    seedTwins();
    const report = onCohortBoundary("c1", { now: NOW, mode: "bootstrap" })!;
    expect(report.trigger).toBe("cohort_boundary");
    expect(report.batchId).toBe("c1");
    expect(pendingProvisionalCount()).toBe(1);
  });

  it("takes item 1.8's TransitionResult straight from advanceCohort", () => {
    seedTwins();
    getDb()
      .prepare(
        `INSERT INTO cohorts (id, seq, mode, horizon, state, session_ids, event_count)
         VALUES ('c1', 0, 'bootstrap', 'd7', 'understanding', '[]', 0)`,
      )
      .run();
    const transition = advanceCohort("c1", "done");
    expect(transition.refused).toBe(false);

    const report = reconcileAfterTransition(transition, { now: NOW, mode: "bootstrap" })!;
    expect(report.trigger).toBe("cohort_boundary");
    expect(report.batchId).toBe("c1");
  });

  it("ignores a mid-ladder rung and a refused transition", () => {
    seedTwins();
    getDb()
      .prepare(
        `INSERT INTO cohorts (id, seq, mode, horizon, state, session_ids, event_count)
         VALUES ('c2', 0, 'bootstrap', 'd7', 'planned', '[]', 0)`,
      )
      .run();
    expect(reconcileAfterTransition(advanceCohort("c2", "ready"), { mode: "bootstrap" })).toBeNull();
    advanceCohort("c2", "done");
    // Walking backwards is refused, not thrown — and never reconciles.
    expect(reconcileAfterTransition(advanceCohort("c2", "ready"), { mode: "bootstrap" })).toBeNull();
    expect(readArcs()).toHaveLength(0);
  });

  it("steady routes a boundary through the coalesced change path", () => {
    seedTwins();
    const report = onCohortBoundary("c1", { now: NOW, mode: "steady" })!;
    expect(report.trigger).toBe("change");
    // The change path is whole-table, not per-cohort.
    expect(report.batchId).toBeNull();
  });

  it("coalesces a burst of change triggers into one run", () => {
    seedTwins();
    expect(onArcChange({ now: NOW, mode: "steady" })).not.toBeNull();
    expect(onArcChange({ now: NOW + 1_000, mode: "steady" })).toBeNull();
    expect(onArcChange({ now: NOW + CHANGE_COALESCE_MS - 1, mode: "steady" })).toBeNull();
  });

  it("does nothing on change when no provisional arc is waiting", () => {
    expect(onArcChange({ now: NOW, mode: "steady" })).toBeNull();
  });

  it("nightly is due when it has never run, and not again for a day", () => {
    expect(lastNightlyAt()).toBeNull();
    expect(nightlyDue(NOW)).toBe(true);

    seedTwins();
    const report = runNightly({ now: NOW, mode: "steady" })!;
    expect(report.trigger).toBe("nightly");
    expect(lastNightlyAt()).toBe(new Date(NOW).toISOString());

    expect(nightlyDue(NOW + 1_000)).toBe(false);
    expect(runNightly({ now: NOW + 1_000 })).toBeNull();
    expect(nightlyDue(NOW + NIGHTLY_INTERVAL_MS)).toBe(true);
  });

  it("stamps the nightly clock even when the pass found nothing", () => {
    expect(runNightly({ now: NOW })!.noop).toBe(true);
    expect(nightlyDue(NOW + 1_000)).toBe(false);
  });
});
