// ===========================================================================
// Build item 4.3 — THE CONFLUENCE TEST.
//
// Global acceptance: "Same corpus in 3 ingest orders → identical graph."
// §14.2 gate: `confluence_order_independence` (critical). The fixture-level
// half of that gate (R-028..R-031) replays claim writes; THIS file is the
// full-pipeline half: ingest → identities → sessions → episodes → claims →
// loops → edges → arcs → promotion, each order over its own fresh database,
// then a deep content-keyed comparison of every graph table.
//
// The three orders (corpus.ts):
//   chronological  — full backfill, oldest first
//   reverse        — live-then-backfill (newest lands first)
//   delayed-stream — one chat's history syncs after everything else
//
// A divergence FAILS with a named-table diff, never a bare boolean.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { closeDb } from "../db/connection.js";
import {
  CONFLUENCE_NOW,
  EVENTS,
  ORDER_NAMES,
  chronologicalOrder,
  delayedStreamOrder,
  orderByName,
  reverseOrder,
  type OrderName,
} from "./corpus.js";
import { runConfluencePipeline, type PipelineReport } from "./pipeline.js";
import { compareSnapshots, formatDiff, takeSnapshot, type GraphSnapshot } from "./snapshot.js";

const dirs: string[] = [];

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One full pipeline run over its own fresh database. */
function runOrder(name: OrderName): { report: PipelineReport; snapshot: GraphSnapshot } {
  const dir = mkdtempSync(join(tmpdir(), `st-confluence-${name}-`));
  dirs.push(dir);
  closeDb();
  process.env.SUPERTWIN_DB_PATH = join(dir, "graph.db");
  const report = runConfluencePipeline(orderByName(name));
  const snapshot = takeSnapshot();
  closeDb();
  return { report, snapshot };
}

function findRows(snapshot: GraphSnapshot, table: string, needle: string): string[] {
  return (snapshot.tables[table] ?? []).filter((r) => r.includes(needle));
}

describe("4.3 confluence — the three orders really differ", () => {
  it("chronological, reverse and delayed-stream are three distinct permutations of ONE corpus", () => {
    const a = chronologicalOrder().map((e) => e.externalId);
    const b = reverseOrder().map((e) => e.externalId);
    const c = delayedStreamOrder().map((e) => e.externalId);
    expect(new Set(a)).toEqual(new Set(EVENTS.map((e) => e.externalId)));
    expect(new Set(b)).toEqual(new Set(a));
    expect(new Set(c)).toEqual(new Set(a));
    expect(b).not.toEqual(a);
    expect(c).not.toEqual(a);
    expect(c).not.toEqual(b);
  });

  it("the corpus contains the order-sensitive shapes (supersession pair, reinforcement, late resolution)", () => {
    // If someone trims the corpus these go first, and the whole proof with them.
    const texts = EVENTS.map((e) => e.text).join("\n");
    expect(texts).toContain("Koramangala");
    expect(texts).toContain("Indiranagar");
    expect(texts.match(/filter coffee/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(texts).toContain("return your book");
  });
});

describe("4.3 confluence — same corpus, three ingest orders, identical graph", () => {
  // ONE run of the three pipelines, shared by the assertions below. The runs
  // are the expensive part; the assertions are reads.
  const runs = new Map<OrderName, { report: PipelineReport; snapshot: GraphSnapshot }>();
  const ensureRuns = (): void => {
    if (runs.size > 0) return;
    for (const name of ORDER_NAMES) runs.set(name, runOrder(name));
  };

  it("every order ingests the whole corpus and runs the whole pipeline", () => {
    ensureRuns();
    for (const [name, { report }] of runs) {
      expect(report.eventsInserted, `${name}: events`).toBe(EVENTS.length);
      expect(report.eventsDeduped, `${name}: dedupe`).toBe(0);
      expect(report.sessionsSealed, `${name}: sessions`).toBeGreaterThanOrEqual(6);
      expect(report.episodePasses, `${name}: episode passes`).toBe(report.sessionsSealed);
      expect(report.claimWrites, `${name}: claims`).toBe(5);
      expect(report.loopWrites, `${name}: loops`).toBe(3);
      expect(report.edgeWrites, `${name}: edges`).toBe(1);
      expect(report.arcsCommitted, `${name}: arcs`).toBe(3);
    }
  });

  it("ACCEPTANCE: the three final graphs are IDENTICAL, table by table", () => {
    ensureRuns();
    const base = runs.get("chronological")!.snapshot;
    for (const name of ORDER_NAMES) {
      if (name === "chronological") continue;
      const comparison = compareSnapshots(base, runs.get(name)!.snapshot);
      expect(formatDiff(comparison, "chronological", name)).toBe("");
      expect(comparison.identical).toBe(true);
    }
  });

  it("the comparison COVERS the graph — no table compared empty", () => {
    ensureRuns();
    const base = runs.get("chronological")!.snapshot;
    const comparison = compareSnapshots(base, runs.get("reverse")!.snapshot);
    // Reported coverage: which tables, how many rows. A harness whose corpus
    // stopped producing rows for a layer would pass vacuously — this fails it.
    expect(comparison.coverage.events).toBe(EVENTS.length);
    expect(comparison.coverage.entities).toBeGreaterThanOrEqual(5); // me, 3 people, 1 place
    expect(comparison.coverage.entity_edges).toBeGreaterThanOrEqual(1);
    expect(comparison.coverage.sessions).toBeGreaterThanOrEqual(6);
    expect(comparison.coverage.episodes).toBeGreaterThanOrEqual(6);
    expect(comparison.coverage.episode_sessions).toBeGreaterThanOrEqual(6);
    expect(comparison.coverage.episode_verdict_shapes).toBeGreaterThanOrEqual(6);
    expect(comparison.coverage.claim_versions).toBe(4); // 5 writes, 1 reinforced
    expect(comparison.coverage.claims_active).toBe(3); // Koramangala closed
    expect(comparison.coverage.evidence).toBeGreaterThanOrEqual(5);
    expect(comparison.coverage.loops).toBe(3);
    expect(comparison.coverage.arcs).toBe(3);
  });

  it("precedence came from stated_at, never ingested_at: the LATER statement is active in every order", () => {
    ensureRuns();
    for (const [name, { snapshot }] of runs) {
      // Under `reverse` the Indiranagar statement is INGESTED FIRST and the
      // Koramangala one arrives behind it; under `chronological` the opposite.
      // If anything anywhere read ingested_at, these two runs would disagree.
      expect(findRows(snapshot, "claims_active", "Koramangala"), `${name}: old residence not active`).toHaveLength(0);
      const active = findRows(snapshot, "claims_active", "Indiranagar");
      expect(active, `${name}: active residence`).toHaveLength(1);
      const closed = findRows(snapshot, "claim_versions", "Koramangala");
      expect(closed, `${name}: superseded residence`).toHaveLength(1);
      expect(closed[0], `${name}: closed_by the newer statement`).toContain("Indiranagar");
      expect(closed[0], `${name}: closed as contradiction`).toContain("contradiction");
    }
  });

  it("the reinforced preference folded to ONE version with the max stated_at in every order", () => {
    ensureRuns();
    for (const [name, { snapshot }] of runs) {
      const rows = findRows(snapshot, "claim_versions", "filter coffee");
      expect(rows, `${name}`).toHaveLength(1);
      expect(rows[0], `${name}: stated_at folds to the max`).toContain("2026-08-03T09:00:00");
    }
  });

  it("the loop resolved by late-arriving evidence is done in every order, the future-due loop open, the recurring loop projected", () => {
    ensureRuns();
    for (const [name, { snapshot }] of runs) {
      const book = findRows(snapshot, "loops", "return priya");
      expect(book, `${name}`).toHaveLength(1);
      expect(book[0]).toContain('"state":"done"');
      expect(book[0]).toContain("resolution_evidence");
      const rent = findRows(snapshot, "loops", "send the rent receipt");
      expect(rent, `${name}`).toHaveLength(1);
      expect(rent[0]).toContain('"state":"open"');
      const insurance = findRows(snapshot, "loops", "renew the car insurance");
      expect(insurance, `${name}`).toHaveLength(1);
      expect(insurance[0]).toContain('"recurrence":"yearly"');
      expect(insurance[0]).toContain('"next_occurrence_utc":"2027-');
    }
  });

  it("NEGATIVE CONTROL: the comparator detects a genuinely different graph, with a named diff", () => {
    ensureRuns();
    const base = runs.get("chronological")!.snapshot;
    const mutated: GraphSnapshot = {
      tables: {
        ...base.tables,
        claims_active: base.tables.claims_active.map((r) => r.replace("Indiranagar", "Koramangala")),
      },
    };
    const comparison = compareSnapshots(base, mutated);
    expect(comparison.identical).toBe(false);
    const diff = formatDiff(comparison, "real", "mutated");
    expect(diff).toContain("claims_active");
    expect(diff).toContain("only in real");
  });

  it("the frozen clock is after the last corpus event — nothing was judged about the future", () => {
    const lastTs = Math.max(...EVENTS.map((e) => Date.parse(e.ts)));
    expect(CONFLUENCE_NOW).toBeGreaterThan(lastTs);
  });
});
