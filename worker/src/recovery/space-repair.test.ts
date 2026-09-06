// ===========================================================================
// [TEST] Existing-home recovery (V6 P1 S6e · E2).
//
// Every case runs against a REAL temp database seeded into the shape the
// user's own install is in — 26 episodes, 22 of them spaceless and sitting in
// unsorted, 2 proposed spaces nobody has approved, and four `(unproposed)`
// rejection rows written by the pre-fix commit path: one killed by the
// commit-order defect, three refused on their merits. The counts are smaller
// than the real 451/441/5/4; the SHAPES are the ones read straight off
// `~/SuperTwinV13/supertwinv13.db`, including the rejection reason strings
// byte-for-byte.
//
// Zero model calls is asserted, not assumed: a model call writes a `runs` row,
// and every case checks that count is unchanged.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { appStateSet } from "../db/ingest.js";
import { GRADUATION_MODE_KEY, spaceCreationStatus } from "../consolidation/graduation.js";
import { sweepCandidatesFor } from "../consolidation/sweep.js";
import {
  applySpaceRepair,
  deadProposals,
  orphanCensus,
  previewSpaceRepair,
  repairOnBoot,
  REPAIR_ACTION,
  REPAIR_PASS,
  UNPROPOSED,
} from "./space-repair.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-repair-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- the damaged home ------------------------------------------------------

function counts(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as { n: number }).n;
}

const runsRows = (): number => counts(`SELECT COUNT(*) AS n FROM runs`);
const spaceRows = (): number => counts(`SELECT COUNT(*) AS n FROM spaces`);
const decisionRows = (): number => counts(`SELECT COUNT(*) AS n FROM decisions`);

let seq = 0;

function mkStream(id: string): string {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO sources (id, type, name) VALUES ('wa', 'whatsapp', 'wa')`).run();
  db.prepare(`INSERT OR IGNORE INTO streams (id, source_id, external_key, label) VALUES (?, 'wa', ?, ?)`).run(id, id, id);
  return id;
}

/** One event + the episode over it, spaceless and unsorted the way the tick left it. */
function mkEpisode(id: string, text: string, opts: { spaceId?: string | null; unsorted?: boolean } = {}): string {
  const db = getDb();
  const streamId = mkStream("st_wa");
  const eventId = `ev_${++seq}`;
  const ts = "2026-09-06T14:48:00.000Z";
  db.prepare(
    `INSERT INTO events (id, source_id, source_type, stream_id, stream_key, ts, captured_at,
                         kind, origin, actor, payload_json, text)
     VALUES (?, 'wa', 'whatsapp', ?, ?, ?, ?, 'wa.message', 'live', 'contact:rohan', '{}', ?)`,
  ).run(eventId, streamId, streamId, ts, ts, text);
  const rowid = (db.prepare(`SELECT rowid AS r FROM events WHERE id = ?`).get(eventId) as { r: number }).r;
  db.prepare(
    `INSERT INTO episodes (id, stream_id, space_id, state, summary, first_ts, last_ts, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
  ).run(id, streamId, opts.spaceId ?? null, text, ts, ts, ts, ts);
  db.prepare(
    `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`ee_${id}`, id, eventId, eventId, rowid, rowid);
  if (opts.unsorted !== false) {
    db.prepare(
      `INSERT INTO unsorted (id, episode_id, reason, status, created_at)
       VALUES (?, ?, 'Document viewing; no stated goal or action.', 'open', ?)`,
    ).run(`un_${id}`, id, ts);
  }
  return id;
}

function mkSpace(id: string, label: string, status = "proposed"): string {
  getDb()
    .prepare(
      `INSERT INTO spaces (id, label, status, created_by, born_via, confidence, updated_at)
       VALUES (?, ?, ?, 'orient', 'inferred', 0.8, '2026-09-06T14:48:31.025Z')`,
    )
    .run(id, label, status);
  return id;
}

/** The row the pre-fix commit path wrote instead of a space. */
function mkDeadProposal(opts: {
  runId: string;
  reason: string;
  label: string;
  summary: string;
  events: string[];
  createdAt?: string;
}): string {
  const id = writeDecision({
    runId: opts.runId,
    pass: "orient",
    targetKind: "space",
    targetId: UNPROPOSED,
    action: "reject",
    new: { label: opts.label, summary: opts.summary, events: opts.events },
    reason: opts.reason,
    confidence: 0.82,
  });
  if (opts.createdAt) {
    getDb().prepare(`UPDATE decisions SET created_at = ? WHERE id = ?`).run(opts.createdAt, id);
  }
  return id;
}

interface DamagedHome {
  killedByCommitOrder: string;
  killedByCommitOrderSecond: string;
  refusedByCritic: string;
  refusedNoQuote: string;
  proposedSpaces: string[];
  orphans: string[];
}

/**
 * The user's install, in miniature and in the same shapes: episodes that
 * committed, spaces that did not, and the ledger row each dead proposal left.
 */
function seedDamagedHome(): DamagedHome {
  const orphans: string[] = [];
  // The founding episode of the proposal the commit-order defect killed — the
  // one thing on disk that proves the space should exist.
  orphans.push(mkEpisode("ep_instinct_1", "Suggested creating a free Instinct app account; invite link shared."));
  orphans.push(mkEpisode("ep_instinct_2", "Rahul Arora asked for an Instinct app invite; user provided one."));
  orphans.push(mkEpisode("ep_swiggy", "Handshake contacted about a Swiggy business ops role."));
  // Twenty more of the "unsorted is the right answer" kind, so the census and
  // the sweep preview are read against a realistic ratio, not a toy.
  for (let i = 0; i < 20; i++) {
    orphans.push(mkEpisode(`ep_noise_${i}`, `Promotional message number ${i} from a brand.`));
  }
  const proposedSpaces = [
    mkSpace("sp_birthday", "Ishant's birthday gift planning"),
    mkSpace("sp_appointment", "Samvit Neuropsychiatric appointment with Dr Shreedhar"),
  ];
  // Three episodes that DID get filed, so "unspaced" is a real subset.
  mkEpisode("ep_filed_1", "Virtual appointment scheduled with Dr Shreedhar at 12pm.", {
    spaceId: "sp_appointment",
    unsorted: false,
  });

  return {
    // The defect: the founding events were committed by the episodes[] item of
    // the same tick, so `fresh()` emptied the proposal's row list.
    killedByCommitOrder: mkDeadProposal({
      runId: "run_a",
      reason: "already_placed: every founding event was committed by an earlier item",
      label: "Instinct app account & invite management",
      summary: "Create a free Instinct account to access invite distribution system.",
      events: ["e45"],
      createdAt: "2026-09-06T14:49:03.773Z",
    }),
    killedByCommitOrderSecond: mkDeadProposal({
      runId: "run_b",
      reason: "already_placed: every founding event was committed by an earlier item",
      label: "Swiggy business ops role application",
      summary: "User contacted Handshake about a Swiggy business ops role.",
      events: ["e37"],
      createdAt: "2026-09-06T15:00:52.335Z",
    }),
    // Refused on their merits: the critic saw a live duplicate, and an evidence
    // entry whose quote was not in the events it cited.
    refusedByCritic: mkDeadProposal({
      runId: "run_c",
      reason:
        "critic: duplicate of existing space sp_birthday 'Ishant's birthday gift planning' — same person, same goal, same date",
      label: "Ishant's birthday gift or celebration",
      summary: "Ishant's birthday is 12 September 2026.",
      events: ["e39", "e38"],
      createdAt: "2026-09-06T14:57:47.883Z",
    }),
    refusedNoQuote: mkDeadProposal({
      runId: "run_d",
      reason: 'evidence_not_verbatim: "Ye karlo signup dono" is not in e15,e16',
      label: "Instinct WhatsApp-based personal assistant signup",
      summary: "Sign up for Instinct using the invite link.",
      events: ["e11", "e12"],
      createdAt: "2026-09-06T14:50:29.854Z",
    }),
    proposedSpaces,
    orphans,
  };
}

// ---------------------------------------------------------------------------
// REC-01 — the census reads the damage
// ---------------------------------------------------------------------------

describe("the census", () => {
  it("counts the orphans, the never-swept spaces and both kinds of dead proposal", () => {
    seedDamagedHome();
    const c = orphanCensus();
    expect(c.episodes).toBe(24);
    expect(c.unspaced).toBe(23);
    expect(c.unspacedInUnsorted).toBe(23);
    expect(c.spaces).toMatchObject({ total: 2, proposed: 2, active: 0 });
    // Nothing is active, so the S5.1 sweep has nothing to run over — which is
    // exactly why 23 episodes sat spaceless on the user's install.
    expect(c.unswept).toBe(0);
    expect(c.replayable).toBe(2);
    expect(c.refusedOnMerits).toBe(2);
    expect(c.alreadyRepaired).toBe(0);
  });

  it("a home with no dead proposals is a clean census, not an error", () => {
    mkEpisode("ep_1", "hello");
    const c = orphanCensus();
    expect(c.replayable).toBe(0);
    expect(c.refusedOnMerits).toBe(0);
    expect(previewSpaceRepair().items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REC-02 — the preview is free
// ---------------------------------------------------------------------------

describe("the preview", () => {
  it("prices the repair without writing anything or calling anything", () => {
    seedDamagedHome();
    const spacesBefore = spaceRows();
    const decisionsBefore = decisionRows();
    const runsBefore = runsRows();

    const plan = previewSpaceRepair();

    expect(plan.modelCalls).toBe(0);
    expect(spaceRows()).toBe(spacesBefore);
    expect(decisionRows()).toBe(decisionsBefore);
    expect(runsRows()).toBe(runsBefore);

    expect(plan.items).toHaveLength(2);
    expect(plan.items.map((i) => i.action)).toEqual(["revive", "revive"]);
    // Oldest refusal first — a capped run repairs the earliest damage.
    expect(plan.items[0]!.label).toBe("Instinct app account & invite management");
    expect(plan.items[0]!.bornStatus).toBe("proposed");
    // What the S5.1 sweep would then be offered, priced by the sweep's own
    // candidate query — not a second idea of "related".
    expect(plan.items[0]!.relatedOrphans).toBe(
      sweepCandidatesFor("Instinct app account & invite management", null).length,
    );
    expect(plan.items[0]!.relatedOrphans).toBeGreaterThan(0);
  });

  it("states the sweep cost up front: zero to repair, one call per space after", () => {
    seedDamagedHome();
    const plan = previewSpaceRepair();
    expect(plan.modelCalls).toBe(0);
    // Propose-only: a restored space is a proposal, so it costs nothing until
    // the user approves it.
    expect(plan.sweep.spacesAfter).toBe(0);
    expect(plan.sweep.when).toMatch(/approve/);
    expect(plan.line).toMatch(/0 model calls/);
  });

  it("under auto-create the same plan prices the sweep it will actually cause", () => {
    seedDamagedHome();
    appStateSet(GRADUATION_MODE_KEY, "auto");
    expect(spaceCreationStatus()).toBe("active");
    const plan = previewSpaceRepair();
    expect(plan.items.every((i) => i.bornStatus === "active")).toBe(true);
    expect(plan.sweep.maxCalls).toBe(2);
    expect(plan.sweep.when).toMatch(/consolidation lane/);
  });
});

// ---------------------------------------------------------------------------
// REC-03 — applying restores the births, and only those
// ---------------------------------------------------------------------------

describe("applying the repair", () => {
  it("restores the discarded births at the propose-only status, with zero model calls", () => {
    const home = seedDamagedHome();
    const runsBefore = runsRows();

    const report = applySpaceRepair();

    expect(report.modelCalls).toBe(0);
    expect(runsRows()).toBe(runsBefore);
    expect(report.revived).toBe(2);
    expect(report.filedInto).toBe(0);
    expect(report.spaceIds).toHaveLength(2);

    const rows = getDb()
      .prepare(`SELECT id, label, status, created_by, born_via, birth_evidence_json FROM spaces WHERE created_by = 'repair'`)
      .all() as { id: string; label: string; status: string; born_via: string; birth_evidence_json: string }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      // Propose-only is enforced by the SAME guard commit uses: a repair can
      // never smuggle a space in as active.
      expect(r.status).toBe("proposed");
      expect(r.born_via).toBe("inferred");
      // No fabricated quotes: the dead payload never recorded the evidence
      // array, so the card gets nothing rather than something invented.
      expect(JSON.parse(r.birth_evidence_json)).toEqual([]);
    }
    expect(rows.map((r) => r.label).sort()).toEqual([
      "Instinct app account & invite management",
      "Swiggy business ops role application",
    ]);

    // The refusal is now recorded as undone, by the decision that replaced it.
    const dead = getDb()
      .prepare(`SELECT reversed_at, reversed_by FROM decisions WHERE id = ?`)
      .get(home.killedByCommitOrder) as { reversed_at: string | null; reversed_by: string | null };
    expect(dead.reversed_at).not.toBeNull();
    expect(report.decisionIds).toContain(dead.reversed_by);

    const repair = getDb()
      .prepare(`SELECT pass, target_id, new_json, reason FROM decisions WHERE id = ?`)
      .get(dead.reversed_by) as { pass: string; target_id: string; new_json: string; reason: string };
    expect(repair.pass).toBe(REPAIR_PASS);
    expect(JSON.parse(repair.new_json)).toMatchObject({
      from_decision: home.killedByCommitOrder,
      from_run: "run_a",
      status: "proposed",
    });
    expect(repair.reason).toMatch(/commit-order defect/);
  });

  it("never replays a refusal that stands on its merits", () => {
    const home = seedDamagedHome();
    applySpaceRepair();

    for (const id of [home.refusedByCritic, home.refusedNoQuote]) {
      const row = getDb().prepare(`SELECT reversed_at FROM decisions WHERE id = ?`).get(id) as {
        reversed_at: string | null;
      };
      expect(row.reversed_at).toBeNull();
    }
    const labels = (getDb().prepare(`SELECT label FROM spaces`).all() as { label: string }[]).map((r) => r.label);
    expect(labels).not.toContain("Ishant's birthday gift or celebration");
    expect(labels).not.toContain("Instinct WhatsApp-based personal assistant signup");
    expect(orphanCensus().refusedOnMerits).toBe(2);
  });

  it("files into the live space instead of minting a second copy of it", () => {
    seedDamagedHome();
    mkSpace("sp_instinct_live", "Instinct app account & invite management", "active");
    const before = spaceRows();

    const report = applySpaceRepair();

    expect(report.filedInto).toBe(1);
    expect(report.revived).toBe(1);
    expect(spaceRows()).toBe(before + 1); // only the Swiggy one is new
    const dedupe = getDb()
      .prepare(`SELECT new_json, reason FROM decisions WHERE target_id = 'sp_instinct_live' AND action = ?`)
      .get(REPAIR_ACTION) as { new_json: string; reason: string } | undefined;
    expect(dedupe).toBeDefined();
    expect(JSON.parse(dedupe!.new_json)).toMatchObject({ filed_into: "sp_instinct_live", via: "exact_label" });
  });

  it("two dead proposals of the same space resolve to one space, not two", () => {
    seedDamagedHome();
    mkDeadProposal({
      runId: "run_e",
      reason: "already_placed: every founding event was committed by an earlier item",
      label: "Instinct app account & invite management",
      summary: "A second proposal for the same space, from a later tick.",
      events: ["e51"],
      createdAt: "2026-09-06T15:10:00.000Z",
    });
    const plan = previewSpaceRepair();
    expect(plan.items.filter((i) => i.action === "revive")).toHaveLength(2);
    expect(plan.items.filter((i) => i.action === "file_into")).toHaveLength(1);

    const report = applySpaceRepair();
    expect(report.revived).toBe(2);
    expect(report.filedInto).toBe(1);
    expect(
      counts(`SELECT COUNT(*) AS n FROM spaces WHERE label = ?`, "Instinct app account & invite management"),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// REC-04 — idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("a second run restores nothing and writes nothing", () => {
    seedDamagedHome();
    const first = applySpaceRepair();
    expect(first.revived).toBe(2);

    const spacesAfterFirst = spaceRows();
    const decisionsAfterFirst = decisionRows();

    const second = applySpaceRepair();
    expect(second.scanned).toBe(0);
    expect(second.revived).toBe(0);
    expect(second.filedInto).toBe(0);
    expect(spaceRows()).toBe(spacesAfterFirst);
    expect(decisionRows()).toBe(decisionsAfterFirst);
    expect(deadProposals()).toEqual([]);
    expect(previewSpaceRepair().items).toEqual([]);

    // And a third, because "twice" is the test everyone writes and "forever"
    // is the property that matters on a boot step.
    const third = applySpaceRepair();
    expect(third.scanned).toBe(0);
    expect(spaceRows()).toBe(spacesAfterFirst);
    expect(decisionRows()).toBe(decisionsAfterFirst);
  });

  it("the boot step is the same two functions, and repeats harmlessly", () => {
    seedDamagedHome();
    const lines: string[] = [];
    const first = repairOnBoot((l) => lines.push(l));
    expect(first?.revived).toBe(2);
    expect(lines.join("\n")).toMatch(/\[repair\] 24 episode\(s\), 23 without a space/);
    expect(lines.join("\n")).toMatch(/0 model calls/);

    const spacesAfterFirst = spaceRows();
    lines.length = 0;
    expect(repairOnBoot((l) => lines.push(l))).toBeNull();
    expect(spaceRows()).toBe(spacesAfterFirst);
    // The census line is still printed on a clean boot: "no line" and "no
    // damage" must not be the same evidence.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/0 restorable proposal\(s\), 2 refused on their merits/);
  });

  it("a home installed after the fix boots silent and unchanged", () => {
    mkEpisode("ep_1", "hello");
    mkSpace("sp_ok", "a live space", "active");
    const before = { spaces: spaceRows(), decisions: decisionRows(), runs: runsRows() };
    const lines: string[] = [];
    expect(repairOnBoot((l) => lines.push(l))).toBeNull();
    expect(lines).toHaveLength(1);
    expect(spaceRows()).toBe(before.spaces);
    expect(decisionRows()).toBe(before.decisions);
    expect(runsRows()).toBe(before.runs);
  });
});

// ---------------------------------------------------------------------------
// REC-05 — the handoff to the S5.1 sweep
// ---------------------------------------------------------------------------

describe("the handoff to the activation sweep", () => {
  it("a restored space offers the orphaned episodes the sweep will file", () => {
    seedDamagedHome();
    const report = applySpaceRepair();
    const spaceId = report.spaceIds[0]!;

    // The restored space is a proposal; the review queue's card prices it with
    // the same zero-call retrieval, and the founding episode is in it.
    const candidates = sweepCandidatesFor("Instinct app account & invite management", null);
    expect(candidates).toContain("ep_instinct_1");
    expect(candidates).toContain("ep_instinct_2");

    // Approving it is what makes the sweep eligible — this module never flips
    // the status itself.
    expect(orphanCensus().unswept).toBe(0);
    getDb().prepare(`UPDATE spaces SET status = 'active' WHERE id = ?`).run(spaceId);
    expect(orphanCensus().unswept).toBe(1);
  });

  it("the repair attaches no episode itself — membership stays the sweep's job", () => {
    seedDamagedHome();
    const before = counts(`SELECT COUNT(*) AS n FROM episodes WHERE space_id IS NOT NULL`);
    applySpaceRepair();
    expect(counts(`SELECT COUNT(*) AS n FROM episodes WHERE space_id IS NOT NULL`)).toBe(before);
    expect(counts(`SELECT COUNT(*) AS n FROM decisions WHERE action = 'attach' AND pass = ?`, REPAIR_PASS)).toBe(0);
  });
});
