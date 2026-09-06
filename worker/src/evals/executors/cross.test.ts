// ===========================================================================
// CROSS-N50 (V6 P1 §7.3 ship-gate item 3): fifty events, six threads, three
// sources in ONE live bundle → one space, two episodes, exactly one nudge
// citing both sources. Real tick, recorded live.v1 output, zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { setConsentGateMode } from "../../db/consent-gate.js";
import { loadFixture } from "../fixtures.js";
import { crossExecutor } from "./cross.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cross-eval-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  setConsentGateMode("open");
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Out {
  tick: { status: string; lane: string };
  space: string;
  episodes: { id: string; thread: string; space: string | null; events: number }[];
  prepared: { kind: string; action: string; grounded_threads: string[]; grounded_sources: string[]; surface: string }[];
  url_bridges: { left: string; right: string }[];
  section_order: string[];
  rejected: number;
}

async function run(id = "CROSS-N50") {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("cross");
  const r = await crossExecutor({ fixture });
  expect(r.metrics!.model_calls).toBe(0);
  // Canned answers never reach the ledger, and the case cleans up after itself.
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n).toBe(0);
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(0);
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM bridges`).get() as { n: number }).n).toBe(0);
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM deferred_outputs`).get() as { n: number }).n).toBe(0);
  return { r, out: r.output as Out };
}

describe("CROSS-N50 — the large-N cross-source batch", () => {
  it("passes with no violations", async () => {
    const { r } = await run();
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("is fifty events over six threads and three sources, in one live bundle", async () => {
    const { r, out } = await run();
    expect(r.metrics).toMatchObject({ events: 50, threads: 6, sources: 3 });
    expect(out.tick).toMatchObject({ status: "committed", lane: "live" });
    // Pack sections follow first-event order: the villa chat leads.
    expect(out.section_order).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
  });

  it("ONE space: the villa cluster attaches to sp_goa_dec and mints no second space", async () => {
    const { r, out } = await run();
    expect(out.space).toBe("sp_goa_dec");
    expect(r.metrics).toMatchObject({ spaces_created: 0 });
  });

  it("TWO episodes in that space — the WhatsApp thread and the browser thread", async () => {
    const { r, out } = await run();
    expect(r.metrics).toMatchObject({ episodes_in_space: 2 });
    const inSpace = out.episodes.filter((e) => e.space === "sp_goa_dec");
    expect(inSpace.map((e) => e.thread).sort()).toEqual(["T1", "T2"]);
  });

  it("no episode cites two threads, and nothing is placed nowhere", async () => {
    const { r } = await run();
    expect(r.metrics).toMatchObject({ multi_stream_episodes: 0, uncovered: 0 });
  });

  it("EXACTLY ONE nudge out of fifty events, and it CITES BOTH SOURCES", async () => {
    const { r, out } = await run();
    expect(r.metrics).toMatchObject({ prepared_persisted: 1, grounded_sources: 2, nudge_without_grounding: 0 });
    expect(out.prepared).toHaveLength(1);
    expect(out.prepared[0]!.grounded_sources.sort()).toEqual(["browser", "wa"]);
    expect(out.prepared[0]!.grounded_threads.sort()).toEqual(["T1", "T2"]);
    expect(out.prepared[0]).toMatchObject({ kind: "help_now", action: "compare", surface: "card" });
  });

  it("the unrelated threads are never cited and never enter the space", async () => {
    const { out } = await run();
    const cited = out.prepared.flatMap((p) => p.grounded_threads);
    for (const unrelated of ["T4", "T5", "T6"]) {
      expect(cited).not.toContain(unrelated);
      expect(out.episodes.filter((e) => e.space === "sp_goa_dec").map((e) => e.thread)).not.toContain(unrelated);
    }
  });

  it("the screen thread joins by the URL bridge, not by an episode in the space", async () => {
    const { r, out } = await run();
    expect(r.metrics!.url_bridges).toBeGreaterThan(0);
    expect(out.url_bridges.some((b) => (b.left === "T2" && b.right === "T3") || (b.left === "T3" && b.right === "T2"))).toBe(true);
    expect(out.episodes.filter((e) => e.space === "sp_goa_dec").map((e) => e.thread)).not.toContain("T3");
    // It is not dropped either — it is committed as an unsorted episode of its own.
    expect(out.episodes.filter((e) => e.thread === "T3" && e.space === null)).toHaveLength(1);
  });

  it("reports the hard gates it observed", async () => {
    const { r } = await run();
    const byId = new Map(r.gateObservations!.map((g) => [g.gateId, g]));
    expect(byId.get("episode_membership_explicit")).toMatchObject({ passed: true, counted: true });
    expect(byId.get("nudge_without_grounding")).toMatchObject({ passed: true, counted: true });
    expect(byId.get("assist_from_history")).toMatchObject({ passed: true, counted: true });
  });
});

// ===========================================================================
// CROSS-DAY (R3): a 120-event HISTORY day over eight threads and three
// sources. N50 asks whether the batch keeps threads apart; the day asks
// whether anything falls out of it.
// ===========================================================================

interface DayOut {
  lane: string;
  coverage: string;
  per_section: { thread: string; source: string; episodes: number; unsorted: number }[];
  episodes: { id: string; thread: string; space: string | null; events: number; filed_as: string }[];
  uncovered: string[];
  duplicated: string[];
}

async function runDay() {
  const fixture = loadFixture(join(FIX, "CROSS-DAY.json"));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("cross");
  const r = await crossExecutor({ fixture });
  expect(r.metrics!.model_calls).toBe(0);
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n).toBe(0);
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(0);
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM deferred_outputs`).get() as { n: number }).n).toBe(0);
  return { r, out: r.output as unknown as DayOut };
}

describe("CROSS-DAY — a full mixed day", () => {
  it("passes with no violations", async () => {
    const { r } = await runDay();
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("is the day the fixture says it is: 120 events, 8 threads, 3 sources, on the history lane", async () => {
    const { r, out } = await runDay();
    expect(r.metrics).toMatchObject({ events: 120, threads: 8, sources: 3 });
    expect(out.lane).toBe("history");
  });

  it("every section yields at least one episode or unsorted entry", async () => {
    const { r, out } = await runDay();
    expect(r.metrics!.sections_with_nothing).toBe(0);
    expect(out.per_section).toHaveLength(8);
    for (const s of out.per_section) expect(s.episodes + s.unsorted).toBeGreaterThan(0);
    expect(r.metrics).toMatchObject({ episodes_committed: 6, unsorted_committed: 4 });
  });

  it("coverage is 100% — nothing placed nowhere, nothing placed twice, nothing held back", async () => {
    const { r, out } = await runDay();
    expect(r.metrics).toMatchObject({ coverage: 1, uncovered: 0, duplicated: 0, held: 0 });
    expect(out.uncovered).toEqual([]);
    expect(out.duplicated).toEqual([]);
    expect(out.coverage).toBe("120/120 placed");
  });

  it("no episode spans two threads, and a history day-bundle nudges nobody", async () => {
    const { r } = await runDay();
    expect(r.metrics).toMatchObject({ multi_stream_episodes: 0, prepared_persisted: 0, assist_from_history: 0 });
    const byId = new Map(r.gateObservations!.map((g) => [g.gateId, g]));
    expect(byId.get("episode_membership_explicit")).toMatchObject({ passed: true, counted: true });
    expect(byId.get("assist_from_history")).toMatchObject({ passed: true, counted: true });
    // Nothing prepared means nothing to measure: the gate is not claimed.
    expect(byId.has("nudge_without_grounding")).toBe(false);
  });
});
