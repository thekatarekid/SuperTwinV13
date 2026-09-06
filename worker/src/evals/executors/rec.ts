// ===========================================================================
// [CODE] REC — existing-home recovery (V6 P1 S6e · E2).
//
// Deterministic, ZERO model calls by construction: the repair is a replay of
// the decisions ledger. Each case seeds the shape a pre-fix home is actually
// in — spaceless episodes sitting in unsorted beside `(unproposed)` rejection
// rows — runs `previewSpaceRepair()` / `applySpaceRepair()`, and asserts what
// the code did.
//
//   REC-01  the preview is free: it prices the damage and the sweep that
//           follows, and writes nothing.
//   REC-02  a birth the commit-order defect discarded is restored — at the
//           status `spaceCreationStatus()` says, with no invented evidence.
//   REC-03  a refusal on the merits (critic duplicate, unverifiable quote) is
//           NEVER replayed.
//   REC-04  idempotency (hard gate): a second and third run write nothing.
//   REC-05  membership stays the S5.1 sweep's job — the repair attaches no
//           episode, and the restored space's candidate set holds the orphans.
//
// The harness runs every category against ONE home, so each case removes
// exactly what it wrote — including un-reversing any rejection the repair
// reversed — and never asserts a global count it does not own.
// ===========================================================================

import { spaceCreationStatus } from "../../consolidation/graduation.js";
import { sweepCandidatesFor } from "../../consolidation/sweep.js";
import { getDb } from "../../db/connection.js";
import { writeDecision } from "../../db/decisions.js";
import {
  applySpaceRepair,
  orphanCensus,
  previewSpaceRepair,
  REPAIR_ACTION,
  REPAIR_PASS,
  UNPROPOSED,
  type RepairPlan,
  type RepairReport,
} from "../../recovery/space-repair.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

function count(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as { n: number }).n;
}

const runsRows = (): number => count(`SELECT COUNT(*) AS n FROM runs`);

/** Rows one case owns. Cleanup restores the shared home exactly. */
class RecWorld {
  readonly episodes: string[] = [];
  readonly events: string[] = [];
  readonly spaces: string[] = [];
  readonly rejections: string[] = [];
  readonly slug: string;
  private streamId: string | null = null;
  private seq = 0;

  constructor(readonly caseId: string) {
    this.slug = caseId.toLowerCase().replace(/-/g, "");
  }

  /** Labels are per case, so one case's dedupe never sees another's space. */
  label(text: string): string {
    return `${this.slug} ${text}`;
  }

  stream(): string {
    if (this.streamId) return this.streamId;
    const db = getDb();
    const id = `st_${this.slug}`;
    db.prepare(`INSERT OR IGNORE INTO sources (id, type, name) VALUES ('wa', 'whatsapp', 'wa')`).run();
    db.prepare(`INSERT OR IGNORE INTO streams (id, source_id, external_key, label) VALUES (?, 'wa', ?, ?)`).run(id, id, id);
    this.streamId = id;
    return id;
  }

  /** An episode that committed, spaceless and unsorted — the orphan population. */
  orphan(text: string): string {
    const db = getDb();
    const streamId = this.stream();
    const epId = `ep_${this.slug}_${++this.seq}`;
    const evId = `ev_${this.slug}_${this.seq}`;
    const ts = "2026-09-06T14:48:00.000Z";
    db.prepare(
      `INSERT INTO events (id, source_id, source_type, stream_id, stream_key, ts, captured_at,
                           kind, origin, actor, payload_json, text)
       VALUES (?, 'wa', 'whatsapp', ?, ?, ?, ?, 'wa.message', 'eval', 'contact:x', '{}', ?)`,
    ).run(evId, streamId, streamId, ts, ts, text);
    const rowid = (db.prepare(`SELECT rowid AS r FROM events WHERE id = ?`).get(evId) as { r: number }).r;
    db.prepare(
      `INSERT INTO episodes (id, stream_id, state, summary, first_ts, last_ts) VALUES (?, ?, 'open', ?, ?, ?)`,
    ).run(epId, streamId, text, ts, ts);
    db.prepare(
      `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`ee_${epId}`, epId, evId, evId, rowid, rowid);
    db.prepare(
      `INSERT INTO unsorted (id, episode_id, reason, status) VALUES (?, ?, 'no goal evidence', 'open')`,
    ).run(`un_${epId}`, epId);
    this.episodes.push(epId);
    this.events.push(evId);
    return epId;
  }

  space(suffix: string, label: string, status = "active"): string {
    const id = `sp_${this.slug}_${suffix}`;
    getDb()
      .prepare(`INSERT INTO spaces (id, label, status, created_by) VALUES (?, ?, ?, 'orient')`)
      .run(id, this.label(label), status);
    this.spaces.push(id);
    return id;
  }

  /** The row the pre-fix commit path wrote instead of a space. */
  deadProposal(reason: string, label: string, summary: string): string {
    const id = writeDecision({
      runId: `run_${this.slug}`,
      pass: "orient",
      targetKind: "space",
      targetId: UNPROPOSED,
      action: "reject",
      new: { label: this.label(label), summary, events: ["e45"] },
      reason,
      confidence: 0.82,
    });
    this.rejections.push(id);
    return id;
  }

  /** Only the plan items this case owns — the home is shared. */
  mine(plan: RepairPlan): RepairPlan["items"] {
    return plan.items.filter((i) => this.rejections.includes(i.decisionId));
  }

  cleanup(): void {
    const db = getDb();
    const ph = (xs: readonly string[]): string => xs.map(() => "?").join(",");
    const tx = db.transaction(() => {
      // Undo the repair itself: every repair_birth that points at one of this
      // case's rejections, plus the space it minted and the reversal it wrote.
      for (const rejId of this.rejections) {
        const repairs = db
          .prepare(
            `SELECT id, target_id FROM decisions
              WHERE target_kind = 'space' AND action = ? AND new_json LIKE '%' || ? || '%'`,
          )
          .all(REPAIR_ACTION, `"from_decision":"${rejId}"`) as { id: string; target_id: string }[];
        for (const r of repairs) {
          db.prepare(`DELETE FROM spaces WHERE id = ? AND created_by = 'repair'`).run(r.target_id);
          db.prepare(`DELETE FROM decisions WHERE id = ?`).run(r.id);
        }
        db.prepare(`DELETE FROM decisions WHERE id = ?`).run(rejId);
      }
      if (this.episodes.length > 0) {
        db.prepare(`DELETE FROM unsorted WHERE episode_id IN (${ph(this.episodes)})`).run(...this.episodes);
        db.prepare(`DELETE FROM episode_events WHERE episode_id IN (${ph(this.episodes)})`).run(...this.episodes);
        db.prepare(`DELETE FROM episodes WHERE id IN (${ph(this.episodes)})`).run(...this.episodes);
      }
      if (this.events.length > 0) db.prepare(`DELETE FROM events WHERE id IN (${ph(this.events)})`).run(...this.events);
      for (const sp of this.spaces) {
        db.prepare(`DELETE FROM decisions WHERE target_kind = 'space' AND target_id = ?`).run(sp);
        db.prepare(`DELETE FROM spaces WHERE id = ?`).run(sp);
      }
      if (this.streamId) db.prepare(`DELETE FROM streams WHERE id = ?`).run(this.streamId);
    });
    try {
      tx();
    } catch {
      /* a leftover row never fails the case */
    }
  }
}

type CaseFn = (fixture: Fixture, w: RecWorld) => ExecutorResult;

const ALREADY_PLACED = "already_placed: every founding event was committed by an earlier item";
const CRITIC_DUP = "critic: duplicate of an existing space — same person, same goal, same date";
const NO_QUOTE = 'evidence_not_verbatim: "not in the text" is not in e15,e16';

// ---- REC-01 · the preview is free ------------------------------------------

const rec01: CaseFn = (_fixture, w) => {
  w.orphan("Suggested creating a free instinct app account; invite link shared.");
  w.orphan("Rahul asked for an instinct app invite.");
  const dead = w.deadProposal(ALREADY_PLACED, "instinct app account and invite management", "Create an account.");

  const spacesBefore = count(`SELECT COUNT(*) AS n FROM spaces`);
  const decisionsBefore = count(`SELECT COUNT(*) AS n FROM decisions`);
  const runsBefore = runsRows();

  const plan = previewSpaceRepair();
  const mine = w.mine(plan);
  const wrote =
    count(`SELECT COUNT(*) AS n FROM spaces`) - spacesBefore +
    (count(`SELECT COUNT(*) AS n FROM decisions`) - decisionsBefore);

  const output = {
    modelCalls: plan.modelCalls,
    rowsWritten: wrote,
    runsWritten: runsRows() - runsBefore,
    items: mine.map((i) => ({ action: i.action, bornStatus: i.bornStatus, relatedOrphans: i.relatedOrphans })),
    sweepWhen: plan.sweep.when,
    censusHasOrphans: orphanCensus().unspaced >= 2,
  };
  const ok =
    output.modelCalls === 0 &&
    output.rowsWritten === 0 &&
    output.runsWritten === 0 &&
    mine.length === 1 &&
    mine[0]!.action === "revive" &&
    mine[0]!.relatedOrphans >= 2 &&
    output.censusHasOrphans;
  const violations: Violation[] = [];
  if (output.rowsWritten !== 0) violations.push({ label: "preview-writes", note: `${output.rowsWritten} row(s)` });
  return {
    ok,
    output,
    violations,
    metrics: { model_calls: 0, preview_writes: output.rowsWritten },
    notes: [
      `preview: 1 restorable birth, ${mine[0]?.relatedOrphans ?? 0} orphan(s) offered to the sweep, ` +
        `${output.rowsWritten} row(s) written, ${output.modelCalls} model call(s)`,
      `dead proposal ${dead} priced without being touched`,
    ],
  };
};

// ---- REC-02 · the discarded birth is restored ------------------------------

const rec02: CaseFn = (_fixture, w) => {
  w.orphan("Handshake contacted about a swiggy business ops role.");
  const dead = w.deadProposal(ALREADY_PLACED, "swiggy business ops role application", "Applied via Handshake.");
  const runsBefore = runsRows();

  const report: RepairReport = applySpaceRepair();
  const mine = getDb()
    .prepare(
      `SELECT id, target_id, new_json FROM decisions
        WHERE target_kind = 'space' AND action = ? AND new_json LIKE '%' || ? || '%'`,
    )
    .get(REPAIR_ACTION, `"from_decision":"${dead}"`) as { id: string; target_id: string; new_json: string } | undefined;
  const space = mine
    ? (getDb()
        .prepare(`SELECT label, status, created_by, born_via, birth_evidence_json FROM spaces WHERE id = ?`)
        .get(mine.target_id) as
        | { label: string; status: string; created_by: string; born_via: string; birth_evidence_json: string }
        | undefined)
    : undefined;
  const rejection = getDb().prepare(`SELECT reversed_at, reversed_by FROM decisions WHERE id = ?`).get(dead) as {
    reversed_at: string | null;
    reversed_by: string | null;
  };

  const output = {
    modelCalls: report.modelCalls,
    runsWritten: runsRows() - runsBefore,
    space: space
      ? {
          label: space.label,
          status: space.status,
          createdBy: space.created_by,
          bornVia: space.born_via,
          birthEvidence: JSON.parse(space.birth_evidence_json) as unknown[],
        }
      : null,
    rejectionReversedByRepair: rejection.reversed_by === mine?.id,
    expectedStatus: spaceCreationStatus(),
  };
  const ok =
    output.modelCalls === 0 &&
    output.runsWritten === 0 &&
    output.space !== null &&
    output.space.label === w.label("swiggy business ops role application") &&
    output.space.status === output.expectedStatus &&
    output.space.createdBy === "repair" &&
    output.space.bornVia === "inferred" &&
    // No fabricated quotes: the dead payload never carried the evidence array.
    Array.isArray(output.space.birthEvidence) &&
    output.space.birthEvidence.length === 0 &&
    output.rejectionReversedByRepair;
  return {
    ok,
    output,
    metrics: { model_calls: 0 },
    notes: [
      `restored "${output.space?.label ?? "—"}" as '${output.space?.status ?? "—"}' ` +
        `(the guard commit uses, not the model's), 0 model calls`,
      `the refusal is recorded as undone by ${mine?.id ?? "—"}`,
    ],
  };
};

// ---- REC-03 · refusals on the merits stay refused --------------------------

const rec03: CaseFn = (_fixture, w) => {
  w.orphan("Ishant's birthday is 12 September.");
  const live = w.space("live", "ishant birthday gift planning", "active");
  const critic = w.deadProposal(CRITIC_DUP, "ishant birthday gift planning", "Gift planning.");
  const noQuote = w.deadProposal(NO_QUOTE, "instinct whatsapp assistant signup", "Signed up.");

  const plan = previewSpaceRepair();
  const offered = w.mine(plan);
  applySpaceRepair();

  const reversed = (id: string): boolean =>
    (getDb().prepare(`SELECT reversed_at FROM decisions WHERE id = ?`).get(id) as { reversed_at: string | null })
      .reversed_at !== null;
  const born = (label: string): number => count(`SELECT COUNT(*) AS n FROM spaces WHERE label = ?`, w.label(label));

  const output = {
    offeredForRepair: offered.length,
    criticReplayed: reversed(critic),
    noQuoteReplayed: reversed(noQuote),
    duplicateSpaces: born("ishant birthday gift planning"),
    unverifiableSpaces: born("instinct whatsapp assistant signup"),
    liveSpaceUntouched: count(`SELECT COUNT(*) AS n FROM spaces WHERE id = ?`, live) === 1,
  };
  const ok =
    output.offeredForRepair === 0 &&
    !output.criticReplayed &&
    !output.noQuoteReplayed &&
    output.duplicateSpaces === 1 &&
    output.unverifiableSpaces === 0 &&
    output.liveSpaceUntouched;
  const violations: Violation[] = [];
  if (output.noQuoteReplayed) {
    violations.push({ label: "revived-without-evidence", note: "a proposal with no verbatim quote became a space" });
  }
  return {
    ok,
    output,
    violations,
    metrics: { model_calls: 0, replayed_on_merits: Number(output.criticReplayed) + Number(output.noQuoteReplayed) },
    notes: [
      "a critic duplicate and an unverifiable quote are refusals, not damage — neither is replayed",
      `the live space it duplicated is untouched (${output.duplicateSpaces} row)`,
    ],
  };
};

// ---- REC-04 · idempotency (hard gate) --------------------------------------

const rec04: CaseFn = (_fixture, w) => {
  w.orphan("A water purifier payment to Hrishikesh every month.");
  w.deadProposal(ALREADY_PLACED, "water purifier monthly payment", "Monthly payment.");

  const first = applySpaceRepair();
  const spacesAfterFirst = count(`SELECT COUNT(*) AS n FROM spaces`);
  const decisionsAfterFirst = count(`SELECT COUNT(*) AS n FROM decisions`);

  const second = applySpaceRepair();
  const third = applySpaceRepair();
  const writesAfter =
    count(`SELECT COUNT(*) AS n FROM spaces`) - spacesAfterFirst +
    (count(`SELECT COUNT(*) AS n FROM decisions`) - decisionsAfterFirst);

  const output = {
    firstRevived: first.revived,
    secondScanned: second.scanned,
    thirdScanned: third.scanned,
    writesAfterFirst: writesAfter,
    modelCalls: first.modelCalls + second.modelCalls + third.modelCalls,
  };
  const ok =
    output.firstRevived >= 1 &&
    output.secondScanned === 0 &&
    output.thirdScanned === 0 &&
    output.writesAfterFirst === 0 &&
    output.modelCalls === 0;
  const violations: Violation[] = [];
  if (output.writesAfterFirst !== 0) {
    violations.push({ label: "double-apply", note: `${output.writesAfterFirst} row(s) on a repeat run` });
  }
  return {
    ok,
    output,
    violations,
    // The gate itself is declared on the fixture (`gates: ["idempotency"]`),
    // which scores it from this case's verdict — the CON-01 shape. Emitting a
    // second observation here would count one case twice.
    metrics: { model_calls: 0, repeat_writes: output.writesAfterFirst },
    notes: [
      `run 1 restored ${output.firstRevived}; runs 2 and 3 scanned ${output.secondScanned}/${output.thirdScanned} ` +
        `and wrote ${output.writesAfterFirst} row(s)`,
    ],
  };
};

// ---- REC-05 · membership stays the sweep's job -----------------------------

const rec05: CaseFn = (_fixture, w) => {
  const orphanA = w.orphan("Meeting vatul next weekend when he is back from the US.");
  w.orphan("Vatul asked whether we are joining on Sunday.");
  w.deadProposal(ALREADY_PLACED, "meet vatul next weekend", "Plan to meet.");

  const filedBefore = count(`SELECT COUNT(*) AS n FROM episodes WHERE space_id IS NOT NULL`);
  const report = applySpaceRepair();
  const spaceId = report.spaceIds[report.spaceIds.length - 1] ?? null;
  const filedAfter = count(`SELECT COUNT(*) AS n FROM episodes WHERE space_id IS NOT NULL`);

  // What the S5.1 sweep will be offered, priced by the sweep's own query.
  const candidates = sweepCandidatesFor(w.label("meet vatul next weekend"), null);
  const unsweptBefore = orphanCensus().unswept;
  if (spaceId) getDb().prepare(`UPDATE spaces SET status = 'active' WHERE id = ?`).run(spaceId);
  const unsweptAfter = orphanCensus().unswept;
  if (spaceId) {
    getDb().prepare(`UPDATE spaces SET status = ? WHERE id = ?`).run(spaceCreationStatus(), spaceId);
  }

  const output = {
    episodesAttachedByRepair: filedAfter - filedBefore,
    attachDecisionsByRepair: count(
      `SELECT COUNT(*) AS n FROM decisions WHERE action = 'attach' AND pass = ?`,
      REPAIR_PASS,
    ),
    sweepOffersTheOrphan: candidates.includes(orphanA),
    sweepEligibleOnceActive: unsweptAfter - unsweptBefore,
    modelCalls: report.modelCalls,
  };
  const ok =
    output.episodesAttachedByRepair === 0 &&
    output.attachDecisionsByRepair === 0 &&
    output.sweepOffersTheOrphan &&
    output.sweepEligibleOnceActive === 1 &&
    output.modelCalls === 0;
  return {
    ok,
    output,
    metrics: { model_calls: 0, episodes_attached_by_repair: output.episodesAttachedByRepair },
    notes: [
      "the repair files no episode: it restores the space and hands membership to the S5.1 activation sweep",
      `the sweep's own candidate query offers the orphan; approving the proposal makes it eligible`,
    ],
  };
};

const CASES: Record<string, CaseFn> = {
  "REC-01": rec01,
  "REC-02": rec02,
  "REC-03": rec03,
  "REC-04": rec04,
  "REC-05": rec05,
};

export const recoveryExecutor: Executor = ({ fixture }) => {
  const fn = CASES[fixture.id];
  if (!fn) return { output: null, pending: `${fixture.id}: no REC code case registered` };
  const w = new RecWorld(fixture.id);
  try {
    return fn(fixture, w);
  } finally {
    w.cleanup();
  }
};
