// ===========================================================================
// The arc stage — the caller `runArcLadder` / `applyLadderResult` never had,
// and the loop→arc bind nothing outside the confluence harness ever wrote.
//
// What is tested is the WIRING and the chain it unblocks, not the ladder
// (`arcs/ladder.test.ts` owns the rungs): that an unplaced episode reaches
// `arc_verdicts` and either `arc_episodes` or `provisional_arcs`; that rung ②
// joins a second episode about the same people to the first episode's arc once
// reconcile has committed it; that a re-run is a no-op because a verdict is
// never re-judged; that loops inherit the arc their own evidence sits in; that
// reconcile's three shipped steps carry that all the way to `promoted = 1`, so
// `readSpaces()` is no longer empty — and that the whole thing bills nothing,
// asserted against the `runs` ledger rather than against the report's own claim
// about itself.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSpaces } from "../arcs/promote-store.js";
import { arcEpisodeIds, readArcs } from "../arcs/provisional.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { upsertSource } from "../db/ingest.js";
import { ensureMeEntity } from "../entities/binding.js";
import { runReconcile } from "../reconcile/index.js";
import { arcPass, bindLoopArcs, pendingArcEpisodes } from "./arc-pass.js";
import { runBootstrapTick } from "./bootstrap.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-arc-pass-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- fixtures --------------------------------------------------------------

function entity(id: string, canonical: string, type = "person"): string {
  getDb()
    .prepare(`INSERT INTO entities (id, type, canonical) VALUES (?, ?, ?)`)
    .run(id, type, canonical);
  return id;
}

function stream(id: string, kind: string): string {
  getDb()
    .prepare(`INSERT INTO streams (id, source_id, external_key, stream_kind) VALUES (?, 'whatsapp', ?, ?)`)
    .run(id, id, kind);
  return id;
}

function episode(
  id: string,
  entityIds: readonly string[],
  opts: { streamId?: string; label?: string; startedAt?: string } = {},
): string {
  getDb()
    .prepare(
      `INSERT INTO episodes (id, stream_id, source_id, topic_label, session_ids, event_ids,
                             entity_ids, started_at, ended_at)
       VALUES (?, ?, 'whatsapp', ?, '[]', '[]', ?, ?, ?)`,
    )
    .run(
      id,
      opts.streamId ?? "s_dm",
      opts.label ?? `episode ${id}`,
      JSON.stringify([...entityIds]),
      opts.startedAt ?? "2026-08-10T09:00:00.000Z",
      opts.startedAt ?? "2026-08-10T10:00:00.000Z",
    );
  return id;
}

/** One open loop, its evidence pinned to `episodeId` the way `cl1-apply` writes it. */
function loop(id: string, episodeId: string, owner: string, counterparty: string): string {
  const db = getDb();
  db.prepare(
    `INSERT INTO events (id, source_id, source_type, stream_id, ts, kind, text)
     VALUES (?, 'whatsapp', 'whatsapp', 's_dm', ?, 'message', ?)`,
  ).run(`ev_${id}`, "2026-08-10T09:30:00.000Z", `quote for ${id}`);
  db.prepare(
    `INSERT INTO loops (id, loop_key, intent, origin, owner_id, counterparty_id, party_pair,
                        state, horizon, stated_at)
     VALUES (?, ?, ?, 'commitment', ?, ?, 'me_to_them', 'open', 'weeks', '2026-08-10T09:30:00.000Z')`,
  ).run(id, `key_${id}`, `intent ${id}`, owner, counterparty);
  db.prepare(
    `INSERT INTO evidence (subject_kind, subject_id, event_id, episode_id, quote)
     VALUES ('loop', ?, ?, ?, ?)`,
  ).run(id, `ev_${id}`, episodeId, `quote for ${id}`);
  return id;
}

function runsCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n;
}

function verdictCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM arc_verdicts`).get() as { n: number }).n;
}

function provisionalCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM provisional_arcs`).get() as { n: number }).n;
}

function arcOfLoop(id: string): string | null {
  const row = getDb().prepare(`SELECT arc_id AS a FROM loops WHERE id = ?`).get(id) as
    | { a: string | null }
    | undefined;
  return row?.a ?? null;
}

// ---------------------------------------------------------------------------

describe("pendingArcEpisodes", () => {
  it("offers an episode with neither a membership nor a verdict, and stops offering it after one pass", () => {
    entity("e_amit", "Amit");
    stream("s_dm", "dm");
    episode("ep1", ["e_amit"]);

    expect(pendingArcEpisodes()).toEqual(["ep1"]);
    arcPass({ now: NOW });
    // A verdict IS the settlement. §11.2: replay reuses a verdict, it never
    // re-decides one, so a second pass has nothing to offer.
    expect(pendingArcEpisodes()).toEqual([]);
  });

  it("is a property of the rows, so an episode written before this stage existed is swept", () => {
    entity("e_amit", "Amit");
    stream("s_dm", "dm");
    // No queue row, no watermark, nothing enqueued — exactly the live install.
    episode("old", ["e_amit"]);
    expect(pendingArcEpisodes()).toEqual(["old"]);
  });
});

describe("arcPass", () => {
  it("parks the first episode as a provisional arc and spends nothing", () => {
    entity("e_amit", "Amit");
    stream("s_dm", "dm");
    episode("ep1", ["e_amit"]);

    const report = arcPass({ now: NOW, batchId: "coh1", runId: "coh1" });

    expect(report.episodes).toBe(1);
    expect(report.joined).toBe(0);
    expect(report.provisional).toBe(1);
    expect(report.errors).toEqual([]);
    expect(report.llmCalls).toBe(0);
    // The guarantee, read off the ledger and not off the report.
    expect(runsCount()).toBe(0);
    expect(verdictCount()).toBe(1);
    expect(provisionalCount()).toBe(1);
    // Nothing surfaces yet: a provisional arc has no id anything can join to.
    expect(readArcs()).toEqual([]);
  });

  it("joins a second episode about the same people to the committed arc — rung ②", () => {
    entity("e_amit", "Amit");
    entity("e_neha", "Neha");
    stream("s_dm", "dm");
    episode("ep1", ["e_amit", "e_neha"]);

    arcPass({ now: NOW, batchId: "coh1", runId: "coh1" });
    runReconcile({ now: NOW, trigger: "cohort_boundary", batchId: "coh1", mode: "bootstrap" });
    const arcs = readArcs();
    expect(arcs).toHaveLength(1);

    episode("ep2", ["e_amit", "e_neha"], { startedAt: "2026-08-12T09:00:00.000Z" });
    const second = arcPass({ now: NOW, batchId: "coh2", runId: "coh2" });

    expect(second.joined).toBe(1);
    expect(second.provisional).toBe(0);
    expect(second.llmCalls).toBe(0);
    expect(arcEpisodeIds(arcs[0]!.id).sort()).toEqual(["ep1", "ep2"]);
    expect(runsCount()).toBe(0);
  });

  it("never re-judges: a second pass over the same corpus writes no new verdict", () => {
    entity("e_amit", "Amit");
    stream("s_dm", "dm");
    episode("ep1", ["e_amit"]);

    arcPass({ now: NOW });
    const after = arcPass({ now: NOW });

    expect(after.episodes).toBe(0);
    expect(verdictCount()).toBe(1);
    expect(provisionalCount()).toBe(1);
  });

  it("records the episode it could not read and keeps going", () => {
    entity("e_amit", "Amit");
    stream("s_dm", "dm");
    episode("ep1", ["e_amit"]);
    // `entity_ids` that is not JSON: `jsonArray` absorbs it, so the episode
    // still gets a verdict rather than stalling the other one behind it.
    getDb().prepare(`UPDATE episodes SET entity_ids = 'not json' WHERE id = 'ep1'`).run();
    episode("ep2", ["e_amit"], { startedAt: "2026-08-11T09:00:00.000Z" });

    const report = arcPass({ now: NOW });
    expect(report.episodes).toBe(2);
    expect(report.errors).toEqual([]);
  });
});

describe("bindLoopArcs", () => {
  it("gives a loop the arc its own evidence sits in, and logs the mutation", () => {
    const me = ensureMeEntity();
    entity("e_amit", "Amit");
    stream("s_dm", "dm");
    episode("ep1", ["e_amit"]);
    loop("lp1", "ep1", me, "e_amit");

    arcPass({ now: NOW, batchId: "coh1", runId: "coh1" });
    runReconcile({ now: NOW, trigger: "cohort_boundary", batchId: "coh1", mode: "bootstrap" });
    const arcId = readArcs()[0]!.id;

    // `runReconcile`'s promotion step already bound it — this asserts the
    // second call is a no-op, which is the idempotence the job measures.
    expect(arcOfLoop("lp1")).toBe(arcId);
    expect(bindLoopArcs()).toBe(0);

    const mutations = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM mutations WHERE target_kind = 'loop' AND field = 'arc_id'`)
      .get() as { n: number };
    expect(mutations.n).toBe(1);
  });

  it("leaves a loop whose evidence names no arc alone", () => {
    const me = ensureMeEntity();
    entity("e_amit", "Amit");
    stream("s_dm", "dm");
    episode("ep1", ["e_amit"]);
    loop("lp1", "ep1", me, "e_amit");

    // No arc pass, so no `arc_episodes` row — nothing to inherit.
    expect(bindLoopArcs()).toBe(0);
    expect(arcOfLoop("lp1")).toBeNull();
  });
});

describe("the chain end to end — episodes → arcs → spaces", () => {
  it("turns an unplaced episode with a live loop into a promoted space in one reconcile", () => {
    const me = ensureMeEntity();
    entity("e_amit", "Amit");
    stream("s_dm", "dm");
    episode("ep1", ["e_amit"], { label: "the flat deposit" });
    loop("lp1", "ep1", me, "e_amit");

    // Before: every surface the user looks at is empty.
    expect(readArcs()).toEqual([]);
    expect(readSpaces()).toEqual([]);

    arcPass({ now: NOW, batchId: "coh1", runId: "coh1" });
    const report = runReconcile({
      now: NOW,
      trigger: "cohort_boundary",
      batchId: "coh1",
      mode: "bootstrap",
    });

    expect(report.rolledBack).toBe(false);
    expect(report.retracted).toEqual([]);
    expect(report.steps.map((s) => s.name)).toEqual(["arcs", "promotion", "goals"]);
    // §11.3 — a space is an arc with ≥1 live loop, and now there is one.
    expect(readArcs()).toHaveLength(1);
    expect(readSpaces()).toHaveLength(1);
    expect(report.steps.find((s) => s.name === "promotion")!.detail.promoted).toBe(1);
    // The whole chain is `[CODE]`: nothing reached the ledger.
    expect(report.modelCalls).toBe(0);
    expect(runsCount()).toBe(0);
  });

  it("stage C2 sweeps the backlog even when the tick is out of budget", async () => {
    // The live install: episodes and loops already on disk, every cohort long
    // since `done`, so neither `resumeCohorts` nor `planNextCohort` fires. If
    // placement only happened inside `understandCohort`, this database would
    // stay on two empty tabs forever — which is the defect, not a fixture.
    const me = ensureMeEntity();
    entity("e_amit", "Amit");
    stream("s_dm", "dm");
    episode("ep1", ["e_amit"], { label: "the flat deposit" });
    loop("lp1", "ep1", me, "e_amit");

    const report = await runBootstrapTick({ mode: "slice", now: NOW, limits: { maxLlmCalls: 0 } });

    // Out of budget, so the paid ladder parks — and the FREE derivation still
    // lands. A free stage the user only gets once they can afford the paid ones
    // is precisely backwards.
    expect(report.stoppedBy).toBe("budget");
    expect(report.cohortsDone).toEqual([]);
    expect(report.arcs?.episodes).toBe(1);
    // The plan told the user this was coming, and carries no cost for it.
    expect(report.episodesWithoutArc).toBe(1);
    expect(report.llmCallsSpent).toBe(0);
    expect(readArcs()).toHaveLength(1);
    expect(readSpaces()).toHaveLength(1);
    expect(runsCount()).toBe(0);
  });

  it("is idempotent — a second reconcile promotes nothing new and writes nothing", () => {
    const me = ensureMeEntity();
    entity("e_amit", "Amit");
    stream("s_dm", "dm");
    episode("ep1", ["e_amit"]);
    loop("lp1", "ep1", me, "e_amit");

    arcPass({ now: NOW, batchId: "coh1", runId: "coh1" });
    runReconcile({ now: NOW, trigger: "cohort_boundary", batchId: "coh1", mode: "bootstrap" });
    const again = runReconcile({ now: NOW + 1000, trigger: "nightly", mode: "bootstrap" });

    expect(again.changes).toBe(0);
    expect(again.noop).toBe(true);
    expect(readSpaces()).toHaveLength(1);
  });
});
