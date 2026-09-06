// ===========================================================================
// Existing-home recovery — the orphaned-episode repair (V6 P1 S6e · E2).
//
// WHAT WAS BROKEN. Until 13.12.x `brain/commit.ts` placed a tick's episodes
// FIRST and then read the space proposals through `fresh()`, which drops
// events an earlier item already committed. The model's natural — and
// correct — output files the founding events as an episode AND proposes the
// space that episode belongs in, so by the time the proposal was read every
// founding event was already placed and the proposal died with
//
//     already_placed: every founding event was committed by an earlier item
//
// One `decisions` row, `target_kind='space'`, `target_id='(unproposed)'`,
// carrying the label and summary of a space that was never born. The commit
// fix makes NEW bundles produce spaces. It does nothing for the homes that
// already paid for that understanding: the user's install holds 451 episodes,
// 441 of them spaceless, beside 5 proposed spaces and 4 dead proposals.
//
// WHAT THIS DOES. Replays the births the old code threw away, and lets the
// EXISTING machinery do everything else:
//
//   * the space-birth path decides the row — the same `spaceCreationStatus()`
//     guard commit uses (a repaired space is 'proposed' under propose-only,
//     never smuggled in as 'active'), and the same `findBirthDuplicate()`
//     dedupe, so a repair can never mint a second copy of a live space;
//   * the S5.1 activation sweep decides MEMBERSHIP. This module attaches no
//     episode itself. The dead proposal names its founding events by PACK
//     ALIAS (`["e45"]`) — an alias table that lived for one call and is not on
//     disk — so guessing which of a run's twelve episodes it meant would be
//     exactly the invented second path this repair is supposed to avoid. The
//     founding episode is spaceless and sitting in `unsorted`, which is the
//     first thing `sweepCandidates()` reads, so the sweep sees it by
//     construction. `sweepCandidatesFor()` prices that at zero calls before
//     anything is written.
//
// COST. The repair itself makes ZERO model calls: reading the ledger, minting
// a row, writing a decision. What it costs AFTER is the ordinary S5.1 price
// of a space being born — one `sweep` call per space at activation, on the
// consolidation lane, capped at `unsweptActiveSpaces()`'s 8 per tick — and
// under propose-only (the default, and what the damaged install is on) not
// even that until the user approves the proposal. The plan states the number
// up front rather than discovering it.
//
// SCOPE — what is NOT replayed. Only `already_placed` rejections. The other
// two reasons on the user's disk are refusals on the merits and stay refused:
// `critic:` (the proposal duplicated a live space — the dedupe below would
// reach the same answer anyway) and `evidence_*` (no verbatim quote resolved;
// the payload does not record the evidence array, so reviving one would mint
// a space this product cannot say WHY it believes). They are counted and
// reported, never acted on.
//
// IDEMPOTENCY. Repairing a rejection REVERSES it — `reversed_at` /
// `reversed_by` on the dead row, pointing at the `repair_birth` decision that
// replaced it. The work list is `reversed_at IS NULL`, so a second run has
// nothing to do, and the ledger reads as what happened: a refusal that was
// itself undone, by this code, at this time.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { spaceCreationStatus } from "../consolidation/graduation.js";
import { sweepCandidatesFor, unsweptActiveSpaces } from "../consolidation/sweep.js";
import { findBirthDuplicate, type BirthDuplicate } from "../brain/space-birth.js";
import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";

/** The pass name every row this module writes is attributed to. */
export const REPAIR_PASS = "code:repair";
/** The decision action a revived (or re-filed) birth leaves behind. */
export const REPAIR_ACTION = "repair_birth";
/** `target_id` commit stamps on a proposal that never became a row. */
export const UNPROPOSED = "(unproposed)";
/**
 * The ONE rejection reason this repair replays: the commit-order defect.
 * Byte-for-byte the prefix `brain/commit.ts` wrote before the fix.
 */
export const REPLAYABLE_REASON_PREFIX = "already_placed:";
/** Never revive more than this in one pass — a repair is not a migration. */
export const DEFAULT_REPAIR_LIMIT = 200;

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

// ---- census ----------------------------------------------------------------

export interface SpaceCounts {
  total: number;
  proposed: number;
  active: number;
  dormant: number;
  archived: number;
  rejected: number;
}

export interface OrphanCensus {
  episodes: number;
  /** Episodes with no space — the population this repair exists for. */
  unspaced: number;
  /** Of those, the ones already sitting in `unsorted` (what the sweep reads first). */
  unspacedInUnsorted: number;
  spaces: SpaceCounts;
  /** Active spaces the S5.1 sweep has never run over. */
  unswept: number;
  /** Dead proposals this repair would replay. */
  replayable: number;
  /** Dead proposals refused on their merits — counted, never replayed. */
  refusedOnMerits: number;
  /** Rejections a previous repair already reversed. */
  alreadyRepaired: number;
}

function one(sql: string, ...params: unknown[]): number {
  const row = getDb().prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function orphanCensus(): OrphanCensus {
  const spaces: SpaceCounts = {
    total: one(`SELECT COUNT(*) AS n FROM spaces`),
    proposed: one(`SELECT COUNT(*) AS n FROM spaces WHERE status = 'proposed'`),
    active: one(`SELECT COUNT(*) AS n FROM spaces WHERE status = 'active'`),
    dormant: one(`SELECT COUNT(*) AS n FROM spaces WHERE status = 'dormant'`),
    archived: one(`SELECT COUNT(*) AS n FROM spaces WHERE status = 'archived'`),
    rejected: one(`SELECT COUNT(*) AS n FROM spaces WHERE status = 'rejected'`),
  };
  return {
    episodes: one(`SELECT COUNT(*) AS n FROM episodes`),
    unspaced: one(`SELECT COUNT(*) AS n FROM episodes WHERE space_id IS NULL`),
    unspacedInUnsorted: one(
      `SELECT COUNT(*) AS n FROM unsorted u JOIN episodes e ON e.id = u.episode_id
        WHERE e.space_id IS NULL AND u.status IN ('open','archived')`,
    ),
    spaces,
    unswept: unsweptActiveSpaces(1_000_000).length,
    replayable: deadProposals().length,
    refusedOnMerits: one(
      `SELECT COUNT(*) AS n FROM decisions
        WHERE target_kind = 'space' AND target_id = ? AND action = 'reject'
          AND reversed_at IS NULL AND COALESCE(reason,'') NOT LIKE ?`,
      UNPROPOSED,
      `${REPLAYABLE_REASON_PREFIX}%`,
    ),
    alreadyRepaired: one(
      `SELECT COUNT(*) AS n FROM decisions WHERE target_kind = 'space' AND action = ?`,
      REPAIR_ACTION,
    ),
  };
}

// ---- the dead proposals ----------------------------------------------------

export interface DeadProposal {
  /** The `reject` decision that stands in for the space that was never born. */
  decisionId: string;
  runId: string | null;
  createdAt: string;
  reason: string;
  label: string;
  summary: string | null;
  /** Present only when a later commit build recorded it; null on the damaged homes. */
  goal: string | null;
  lifeArea: string | null;
  confidence: number | null;
}

interface RejectRow {
  id: string;
  run_id: string | null;
  created_at: string;
  reason: string | null;
  new_json: string | null;
  confidence: number | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function parsePayload(row: RejectRow): DeadProposal | null {
  if (!row.new_json) return null;
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.new_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const label = str(payload.label);
  if (!label) return null; // a proposal with no name is not a space we can restore
  return {
    decisionId: row.id,
    runId: row.run_id,
    createdAt: row.created_at,
    reason: row.reason ?? "",
    label,
    summary: str(payload.summary),
    goal: str(payload.goal),
    lifeArea: str(payload.life_area) ?? str(payload.lifeArea),
    confidence: typeof row.confidence === "number" ? row.confidence : null,
  };
}

/**
 * Replayable dead proposals, oldest first (the order they were refused, so a
 * capped run repairs the earliest damage rather than a random slice).
 */
export function deadProposals(limit = DEFAULT_REPAIR_LIMIT): DeadProposal[] {
  const rows = getDb()
    .prepare(
      `SELECT id, run_id, created_at, reason, new_json, confidence
         FROM decisions
        WHERE target_kind = 'space' AND target_id = ? AND action = 'reject'
          AND reversed_at IS NULL
          AND COALESCE(reason,'') LIKE ?
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
    .all(UNPROPOSED, `${REPLAYABLE_REASON_PREFIX}%`, limit) as RejectRow[];
  return rows.map(parsePayload).filter((p): p is DeadProposal => p !== null);
}

/** Has this rejection already been repaired? Cheap belt beside `reversed_at`. */
function alreadyRepaired(decisionId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT id FROM decisions
        WHERE target_kind = 'space' AND action = ?
          AND new_json LIKE '%' || ? || '%'
        LIMIT 1`,
    )
    .get(REPAIR_ACTION, `"from_decision":"${decisionId}"`) as { id: string } | undefined;
  return row !== undefined;
}

// ---- the plan --------------------------------------------------------------

export interface RepairItem {
  decisionId: string;
  label: string;
  goal: string | null;
  /** `revive` mints a space; `file_into` finds the label already live. */
  action: "revive" | "file_into";
  /** The status the space would be born with — `spaceCreationStatus()`, never the model's. */
  bornStatus: "proposed" | "active";
  intoSpaceId: string | null;
  intoLabel: string | null;
  via: BirthDuplicate["via"] | null;
  /**
   * How many spaceless episodes the S5.1 sweep would offer this space —
   * retrieval only, zero model calls (the same read the review queue's
   * proposal card already shows).
   */
  relatedOrphans: number;
  refusedAt: string;
}

export interface RepairPlan {
  census: OrphanCensus;
  items: RepairItem[];
  /**
   * Distinct spaceless episodes the restored spaces would put in front of the
   * sweep. DISTINCT because the unsorted half of `sweepCandidates()` is the
   * same pile for every space — summing the per-item counts would report the
   * same forty episodes once per proposal.
   */
  orphansOffered: number;
  /** What running the repair costs. Always zero — this is a ledger replay. */
  modelCalls: 0;
  /**
   * What the ACTIVATION sweep costs afterwards, stated before anything is
   * written: one call per space, and only once a space is active.
   */
  sweep: { spacesNow: number; spacesAfter: number; maxCalls: number; when: string };
  /** One line for a log or a card. */
  line: string;
}

/** Zero calls, zero writes: exactly what `applySpaceRepair()` would do. */
export function previewSpaceRepair(opts: { limit?: number } = {}): RepairPlan {
  const census = orphanCensus();
  const items: RepairItem[] = [];
  const bornStatus = spaceCreationStatus();
  // Labels this plan would mint, so two dead proposals of the same space
  // resolve to one revive and one file_into — the same answer applying gives.
  const planned = new Map<string, { id: string | null; label: string }>();
  const offered = new Set<string>();
  for (const p of deadProposals(opts.limit ?? DEFAULT_REPAIR_LIMIT)) {
    const dup = findBirthDuplicate(p.label, p.goal);
    const plannedDup = planned.get(p.label.trim().toLowerCase());
    const candidates = sweepCandidatesFor(p.label, p.goal);
    for (const id of candidates) offered.add(id);
    const related = candidates.length;
    if (dup || plannedDup) {
      items.push({
        decisionId: p.decisionId,
        label: p.label,
        goal: p.goal,
        action: "file_into",
        bornStatus,
        intoSpaceId: dup?.spaceId ?? plannedDup?.id ?? null,
        intoLabel: dup?.label ?? plannedDup?.label ?? p.label,
        via: dup?.via ?? "token_overlap",
        relatedOrphans: related,
        refusedAt: p.createdAt,
      });
      continue;
    }
    planned.set(p.label.trim().toLowerCase(), { id: null, label: p.label });
    items.push({
      decisionId: p.decisionId,
      label: p.label,
      goal: p.goal,
      action: "revive",
      bornStatus,
      intoSpaceId: null,
      intoLabel: null,
      via: null,
      relatedOrphans: related,
      refusedAt: p.createdAt,
    });
  }
  const revives = items.filter((i) => i.action === "revive").length;
  const spacesNow = census.unswept;
  const spacesAfter = spacesNow + (bornStatus === "active" ? revives : 0);
  return {
    census,
    items,
    orphansOffered: offered.size,
    modelCalls: 0,
    sweep: {
      spacesNow,
      spacesAfter,
      maxCalls: spacesAfter,
      when:
        bornStatus === "proposed"
          ? "when you approve each proposal, one call per space on the consolidation lane"
          : "on the consolidation lane, one call per space, at most 8 per minute tick",
    },
    line:
      items.length === 0
        ? `nothing to repair — ${census.unspaced} of ${census.episodes} episode(s) have no space, ` +
          `${census.refusedOnMerits} refusal(s) stand on their merits`
        : `${revives} space(s) to restore` +
          (items.length - revives > 0 ? ` (${items.length - revives} already live)` : "") +
          `, putting ${offered.size} orphaned episode(s) in front of the sweep; ` +
          `0 model calls to repair` +
          (spacesAfter > 0
            ? `, at most ${spacesAfter} to sweep`
            : ", and one call per space when you approve it"),
  };
}

// ---- applying --------------------------------------------------------------

export interface RepairReport {
  scanned: number;
  revived: number;
  filedInto: number;
  skipped: number;
  spaceIds: string[];
  decisionIds: string[];
  /** Always zero. Asserted by the tests, not hoped for. */
  modelCalls: 0;
  census: OrphanCensus;
  line: string;
}

/**
 * Replay the births the pre-fix commit path discarded. ZERO model calls, one
 * transaction, every write a reversible decision row. Running it twice is a
 * no-op: the first run reverses each rejection it repaired.
 */
export function applySpaceRepair(opts: { limit?: number } = {}): RepairReport {
  const db = getDb();
  const bornStatus = spaceCreationStatus();
  const report: RepairReport = {
    scanned: 0,
    revived: 0,
    filedInto: 0,
    skipped: 0,
    spaceIds: [],
    decisionIds: [],
    modelCalls: 0,
    census: orphanCensus(),
    line: "",
  };

  const apply = db.transaction(() => {
    for (const p of deadProposals(opts.limit ?? DEFAULT_REPAIR_LIMIT)) {
      report.scanned += 1;
      if (alreadyRepaired(p.decisionId)) {
        report.skipped += 1;
        continue;
      }
      // The same dedupe every other birth path consults. A repair that mints
      // a second copy of a live space is worse than the damage it repairs.
      const dup = findBirthDuplicate(p.label, p.goal);
      let spaceId: string;
      if (dup) {
        spaceId = dup.spaceId;
        report.filedInto += 1;
      } else {
        spaceId = mintId("sp");
        db.prepare(
          `INSERT INTO spaces (id, label, life_area, goal, status, exemplars_json, created_by,
                               confidence, born_via, birth_evidence_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'repair', ?, 'inferred', '[]',
                   strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        ).run(
          spaceId,
          p.label,
          p.lifeArea,
          p.goal,
          bornStatus,
          JSON.stringify(p.summary === null ? [] : [p.summary]),
          p.confidence,
        );
        report.revived += 1;
        report.spaceIds.push(spaceId);
      }
      // `birth_evidence_json` stays EMPTY on a revived space. The dead payload
      // records the label and the summary, never the evidence array, and this
      // product does not put a quote on a card it cannot prove came from an
      // event. The provenance lives in the decision below instead.
      const decisionId = writeDecision({
        runId: p.runId,
        pass: REPAIR_PASS,
        targetKind: "space",
        targetId: spaceId,
        action: REPAIR_ACTION,
        new: {
          from_decision: p.decisionId,
          from_run: p.runId,
          refused_at: p.createdAt,
          refused_reason: p.reason,
          label: p.label,
          goal: p.goal,
          summary: p.summary,
          status: dup ? null : bornStatus,
          filed_into: dup ? dup.spaceId : null,
          via: dup ? dup.via : null,
        },
        reason: dup
          ? `restored from a proposal refused on ${p.createdAt}; already live as "${dup.label}" (${dup.via})`
          : `restored from a proposal refused on ${p.createdAt} by a commit-order defect since fixed`,
        confidence: p.confidence,
      });
      report.decisionIds.push(decisionId);
      // The refusal is now UNDONE, by this decision, at this time. That row is
      // also the work list's filter, so this repair cannot run twice.
      db.prepare(
        `UPDATE decisions SET reversed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reversed_by = ?
          WHERE id = ? AND reversed_at IS NULL`,
      ).run(decisionId, p.decisionId);
    }
  });
  apply();

  report.census = orphanCensus();
  report.line =
    report.scanned === 0
      ? "space repair: nothing to restore"
      : `space repair: ${report.revived} space(s) restored` +
        (report.filedInto > 0 ? `, ${report.filedInto} already live` : "") +
        (report.skipped > 0 ? `, ${report.skipped} already repaired` : "") +
        `; ${report.census.unspaced} episode(s) still unspaced, ` +
        `${report.census.unswept} space(s) waiting for the activation sweep; 0 model calls`;
  return report;
}

/**
 * The upgrade step. Runs at boot, costs nothing, says what it found and what
 * it did. A home with no `already_placed` rejections — every home installed
 * after the commit fix — logs one census line and writes nothing.
 */
export function repairOnBoot(log: (line: string) => void = (l) => console.error(l)): RepairReport | null {
  const plan = previewSpaceRepair();
  const c = plan.census;
  log(
    `[repair] ${c.episodes} episode(s), ${c.unspaced} without a space ` +
      `(${c.unspacedInUnsorted} in unsorted); spaces ${c.spaces.total} ` +
      `(${c.spaces.proposed} proposed, ${c.spaces.active} active, ${c.unswept} never swept); ` +
      `${c.replayable} restorable proposal(s), ${c.refusedOnMerits} refused on their merits`,
  );
  if (plan.items.length === 0) return null;
  log(`[repair] ${plan.line}`);
  const report = applySpaceRepair();
  log(`[repair] ${report.line}`);
  if (report.revived > 0) {
    log(
      `[repair] the restored space(s) are '${spaceCreationStatus()}' — ${plan.sweep.when}. ` +
        "Nothing was attached here: the S5.1 activation sweep files the episodes.",
    );
  }
  return report;
}
