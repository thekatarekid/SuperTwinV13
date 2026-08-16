// ===========================================================================
// The work queue and the coverage ledger, over a real SQLite DB with real
// migrations (arch §9.1 rule 3, §9.2 rule 5, §9.7 rules 3 and 5).
//
// Three defects this file exists to keep out:
//   * dequeue by rowid — backfill has the highest rowids and the oldest data;
//   * a restart re-judging a stage whose verdict is already on disk;
//   * a coverage meter that goes backwards.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { computePriority } from "../tiers/priority.js";
import {
  claimWork,
  completeWork,
  enqueueWork,
  failWork,
  hasVerdict,
  peekWork,
  queueDepth,
  readCoverage,
  resumePaused,
  resumeQueue,
  workId,
  writeCoverage,
} from "./queue.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-sched-q-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

function priority(tier: "T1" | "T2" | "T3" | "T4", ageDays: number): number {
  const ts = NOW - ageDays * DAY;
  const horizon = ageDays <= 1 ? "h24" : ageDays <= 7 ? "d7" : ageDays <= 90 ? "d90" : "older";
  return computePriority({ tier, horizon, ts, now: NOW });
}

describe("dequeue is by priority, never by insertion order (§9.2 rule 5)", () => {
  it("hands back the highest priority first however the rows were inserted", () => {
    // Insertion order is deliberately the WRONG order: oldest history last,
    // exactly as a backfill produces it.
    enqueueWork({ unitKind: "event", unitId: "old", stage: "entity", priority: priority("T1", 400) });
    enqueueWork({ unitKind: "event", unitId: "recent", stage: "entity", priority: priority("T1", 0.5) });
    enqueueWork({ unitKind: "event", unitId: "promo", stage: "entity", priority: priority("T4", 0.5) });

    expect(peekWork({ limit: 3 }).map((w) => w.unitId)).toEqual(["recent", "old", "promo"]);
  });

  it("puts a T4 live blast behind a T1 backfill — tier is primary (§9.3)", () => {
    enqueueWork({ unitKind: "event", unitId: "blast", stage: "entity", priority: priority("T4", 0) });
    enqueueWork({ unitKind: "event", unitId: "history", stage: "entity", priority: priority("T1", 300) });
    expect(peekWork({ limit: 2 }).map((w) => w.unitId)).toEqual(["history", "blast"]);
  });

  it("lets a lane take only its own stages (§9.4)", () => {
    enqueueWork({ unitKind: "event", unitId: "e1", stage: "enrich", priority: 10 });
    enqueueWork({ unitKind: "event", unitId: "e1", stage: "entity", priority: 20 });
    expect(peekWork({ stages: ["enrich"], limit: 5 }).map((w) => w.stage)).toEqual(["enrich"]);
  });

  it("honours not_before_at so a backed-off row is not handed straight back", () => {
    enqueueWork({
      unitKind: "event",
      unitId: "e1",
      stage: "entity",
      priority: 10,
      notBeforeAt: "2026-08-15T12:05:00.000Z",
    });
    expect(peekWork({ nowIso: "2026-08-15T12:00:00.000Z" })).toHaveLength(0);
    expect(peekWork({ nowIso: "2026-08-15T12:06:00.000Z" })).toHaveLength(1);
  });
});

describe("enqueue is an upsert, and finished work stays finished", () => {
  it("reprices an existing row rather than duplicating it", () => {
    expect(enqueueWork({ unitKind: "event", unitId: "e1", stage: "entity", priority: 10 }).action).toBe("inserted");
    expect(enqueueWork({ unitKind: "event", unitId: "e1", stage: "entity", priority: 99 }).action).toBe("repriced");
    const rows = peekWork({ limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.priority).toBe(99);
  });

  it("never resurrects a done row", () => {
    enqueueWork({ unitKind: "event", unitId: "e1", stage: "entity", priority: 10 });
    completeWork(workId("entity", "event", "e1"));
    expect(enqueueWork({ unitKind: "event", unitId: "e1", stage: "entity", priority: 99 }).action).toBe("skipped_done");
    expect(peekWork({ limit: 5 })).toHaveLength(0);
  });
});

describe("failures (§4.6)", () => {
  it("pauses on a refusal WITHOUT spending the retry budget", () => {
    enqueueWork({ unitKind: "event", unitId: "e1", stage: "entity", priority: 10 });
    const [claimed] = claimWork();
    expect(claimed!.attempts).toBe(1);
    failWork(claimed!.id, { action: "pause", notBeforeAt: "2026-08-15T12:10:00.000Z" });

    const row = getDb().prepare(`SELECT attempts, state FROM work_queue WHERE id = ?`).get(claimed!.id) as {
      attempts: number;
      state: string;
    };
    expect(row.state).toBe("paused");
    expect(row.attempts).toBe(0);
  });

  it("resumes a paused row once its wait expires", () => {
    enqueueWork({ unitKind: "event", unitId: "e1", stage: "entity", priority: 10 });
    const [claimed] = claimWork();
    failWork(claimed!.id, { action: "pause", notBeforeAt: "2026-08-15T12:10:00.000Z" });
    expect(resumePaused("2026-08-15T12:05:00.000Z")).toBe(0);
    expect(resumePaused("2026-08-15T12:11:00.000Z")).toBe(1);
    expect(peekWork()).toHaveLength(1);
  });

  it("quarantines a row that exhausted its ladder, leaving the rest moving", () => {
    enqueueWork({ unitKind: "event", unitId: "bad", stage: "entity", priority: 20 });
    enqueueWork({ unitKind: "event", unitId: "good", stage: "entity", priority: 10 });
    const [claimed] = claimWork();
    failWork(claimed!.id, { action: "quarantine" });
    expect(queueDepth().quarantined).toBe(1);
    expect(peekWork().map((w) => w.unitId)).toEqual(["good"]);
  });
});

describe("restart resumes without re-judging (§9.7 rule 5)", () => {
  function seedSessionWithVerdict(sessionId: string): void {
    const db = getDb();
    db.prepare(`INSERT INTO sessions (id, status) VALUES (?, 'sealed')`).run(sessionId);
    db.prepare(
      `INSERT INTO episode_verdicts (id, session_id, decision) VALUES (?, ?, 'attach')`,
    ).run(`ev:${sessionId}`, sessionId);
  }

  it("returns an abandoned running row to ready", () => {
    enqueueWork({ unitKind: "event", unitId: "e1", stage: "entity", priority: 10 });
    claimWork();
    expect(queueDepth().running).toBe(1);

    const report = resumeQueue();
    expect(report.requeued).toBe(1);
    expect(report.rejudged).toEqual([]);
    expect(peekWork()).toHaveLength(1);
  });

  it("marks a row DONE when its verdict already landed — it is not re-run", () => {
    seedSessionWithVerdict("s1");
    getDb()
      .prepare(
        `INSERT INTO work_queue (id, unit_kind, unit_id, stage, priority, state)
         VALUES ('wq:episode:session:s1', 'session', 's1', 'episode', 10, 'running')`,
      )
      .run();

    const report = resumeQueue();
    expect(report.verdictsKept).toBe(1);
    expect(report.requeued).toBe(0);
    expect(queueDepth().done).toBe(1);
    expect(peekWork()).toHaveLength(0);
  });

  it("refuses to enqueue a stage that already holds a verdict", () => {
    seedSessionWithVerdict("s1");
    expect(hasVerdict("episode", "s1")).toBe(true);
    expect(enqueueWork({ unitKind: "session", unitId: "s1", stage: "episode", priority: 10 }).action).toBe(
      "skipped_verdict",
    );
    expect(peekWork()).toHaveLength(0);
  });

  it("has nothing to say about a stage that keeps no verdict", () => {
    expect(hasVerdict("entity", "whatever")).toBe(false);
  });
});

describe("coverage is monotonic (§9.7 rule 3)", () => {
  it("writes a fraction per (scope, horizon)", () => {
    const out = writeCoverage({ scopeKind: "global", scopeId: "all", horizon: "d30", totalUnits: 3_028, doneUnits: 1_204 });
    expect(out.fraction).toBeCloseTo(0.3976, 3);
    expect(readCoverage("global", "all")).toHaveLength(1);
  });

  it("REFUSES a write that would lower done_units", () => {
    writeCoverage({ scopeKind: "global", scopeId: "all", horizon: "d30", totalUnits: 100, doneUnits: 60 });
    const back = writeCoverage({ scopeKind: "global", scopeId: "all", horizon: "d30", totalUnits: 100, doneUnits: 20 });
    expect(back.regressionRefused).toBe(true);
    expect(back.doneUnits).toBe(60);
  });

  it("refuses a shrinking total too — a smaller denominator is a jump backwards", () => {
    writeCoverage({ scopeKind: "source", scopeId: "whatsapp", horizon: "d7", totalUnits: 500, doneUnits: 100 });
    const shrunk = writeCoverage({
      scopeKind: "source",
      scopeId: "whatsapp",
      horizon: "d7",
      totalUnits: 200,
      doneUnits: 150,
    });
    expect(shrunk.totalUnits).toBe(500);
    expect(shrunk.doneUnits).toBe(150);
  });

  it("never lets done exceed total", () => {
    const out = writeCoverage({ scopeKind: "stream", scopeId: "c1", horizon: "live", totalUnits: 10, doneUnits: 40 });
    expect(out.doneUnits).toBe(10);
    expect(out.fraction).toBe(1);
  });

  it("keeps horizons independent", () => {
    writeCoverage({ scopeKind: "global", scopeId: "all", horizon: "live", totalUnits: 10, doneUnits: 10 });
    writeCoverage({ scopeKind: "global", scopeId: "all", horizon: "older", totalUnits: 900, doneUnits: 0 });
    const rows = readCoverage("global", "all").sort((a, b) => (a.horizon < b.horizon ? -1 : 1));
    expect(rows.map((r) => [r.horizon, r.fraction])).toEqual([
      ["live", 1],
      ["older", 0],
    ]);
  });
});
