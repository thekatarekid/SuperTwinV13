// ===========================================================================
// Graduation switch — build P4.3 (spec §9.1: "Propose-only mode for the first
// months … Graduation to auto-create after 2+ clean weeks on the gates").
//
// Everything here is CODE over the decisions ledger — no model call decides
// whether the twin has earned auto-create:
//
//   * recordGraduationMetrics(day) measures ONE day's gates from decisions:
//       over_creation   user rejections / proposals (< 10% passes, spec §18.2)
//       false_auto_merge  auto-applied merges later reversed (must be 0)
//     and stores the row in graduation_metrics — the tracked metric table the
//     Settings pane renders as a streak.
//   * checkGraduation(now) flips `spaces.graduation_mode` to "auto" only when
//     `gates_ok` has held GRADUATION_REQUIRED_DAYS consecutive days AND the
//     window saw real proposal traffic (a dead install must not graduate on
//     vacuous truth). The flip is a decisions row (reversible, like every
//     derived change) plus an ANNOUNCEMENT ARTIFACT so the user hears about
//     it in the Prepared shelf rather than discovering it by surprise.
//   * The user can revert (Settings toggle → setGraduationMode("propose",
//     "user")). A user revert sets a sticky override: the auto-flip never
//     re-fires on its own after the user has said no.
//   * spaceCreationStatus() is what the commit path asks: "proposed" until
//     graduated, "active" after — the ONE reader that changes behavior.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import { createArtifact } from "../assist/artifacts.js";

// ---- keys and constants ----------------------------------------------------

/** app_state: "propose" (default) | "auto". */
export const GRADUATION_MODE_KEY = "spaces.graduation_mode";
/** app_state: "1" once the user reverted — the auto-flip never re-fires. */
export const GRADUATION_REVERTED_KEY = "spaces.graduation_reverted";
/** Consecutive green days the gates must hold before auto-create. */
export const GRADUATION_REQUIRED_DAYS = 14;
/**
 * Minimum proposals across the window: 14 silent days prove nothing about
 * over-creation, so an idle install stays in propose-only.
 */
export const GRADUATION_MIN_PROPOSALS = 5;
/** The over-creation hard gate (spec §18.2): rejections/proposals < 10%. */
export const OVER_CREATION_MAX_PCT = 10;

export type GraduationMode = "propose" | "auto";

// ---- mode ------------------------------------------------------------------

export function graduationMode(): GraduationMode {
  return appStateGet(GRADUATION_MODE_KEY) === "auto" ? "auto" : "propose";
}

/**
 * Flip the mode. `by` names who flipped it: "user" (Settings) or "code"
 * (the auto-flip). A USER revert to propose sets the sticky override.
 */
export function setGraduationMode(mode: GraduationMode, by: "user" | "code"): void {
  const before = graduationMode();
  if (before === mode) return;
  appStateSet(GRADUATION_MODE_KEY, mode);
  if (by === "user" && mode === "propose") appStateSet(GRADUATION_REVERTED_KEY, "1");
  writeDecision({
    pass: by === "user" ? "user" : "code:graduation",
    targetKind: "setting",
    targetId: GRADUATION_MODE_KEY,
    action: "update",
    old: { mode: before },
    new: { mode },
    reason:
      by === "user"
        ? `user set space creation to ${mode === "auto" ? "auto-create" : "propose-only"}`
        : `gates held ${GRADUATION_REQUIRED_DAYS} consecutive days — auto-create graduated`,
  });
}

/** True once the user has reverted auto-create; the auto-flip respects it. */
export function graduationUserReverted(): boolean {
  return appStateGet(GRADUATION_REVERTED_KEY) === "1";
}

/**
 * The status a PASS-created space is born with. "proposed" is the propose-only
 * default; after graduation the pass may birth active spaces directly.
 */
export function spaceCreationStatus(): "proposed" | "active" {
  return graduationMode() === "auto" ? "active" : "proposed";
}

// ---- the metric table ------------------------------------------------------

export interface GraduationDayRow {
  day: string;
  proposals: number;
  userRejections: number;
  overCreationPct: number | null;
  falseAutoMerge: number;
  gatesOk: boolean;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Measure one day's gates from the decisions ledger and upsert its row.
 * Idempotent: recomputing a day replaces its row with the same facts.
 */
export function recordGraduationMetrics(day: string): GraduationDayRow {
  const db = getDb();
  const dayStart = `${day}T00:00:00`;
  const dayEnd = `${day}T23:59:59.999Z`;

  const proposals = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM decisions
          WHERE target_kind = 'space' AND action IN ('propose','create')
            AND pass IS NOT 'user' AND created_at BETWEEN ? AND ?`,
      )
      .get(dayStart, dayEnd) as { n: number }
  ).n;

  const userRejections = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM decisions
          WHERE target_kind = 'space' AND action = 'reject' AND pass = 'user'
            AND created_at BETWEEN ? AND ?`,
      )
      .get(dayStart, dayEnd) as { n: number }
  ).n;

  // An auto-applied merge REVERSED (by the user or the reversal path) is the
  // false_auto_merge hard gate firing — counted on the day it was merged.
  const falseAutoMerge = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM decisions
          WHERE target_kind = 'space' AND action = 'merge'
            AND reversed_at IS NOT NULL AND created_at BETWEEN ? AND ?`,
      )
      .get(dayStart, dayEnd) as { n: number }
  ).n;

  const overCreationPct = proposals > 0 ? (userRejections / proposals) * 100 : null;
  const gatesOk =
    falseAutoMerge === 0 && (overCreationPct === null || overCreationPct < OVER_CREATION_MAX_PCT);

  db.prepare(
    `INSERT INTO graduation_metrics
       (day, proposals, user_rejections, over_creation_pct, false_auto_merge, gates_ok,
        computed_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(day) DO UPDATE SET
       proposals = excluded.proposals,
       user_rejections = excluded.user_rejections,
       over_creation_pct = excluded.over_creation_pct,
       false_auto_merge = excluded.false_auto_merge,
       gates_ok = excluded.gates_ok,
       computed_at = excluded.computed_at`,
  ).run(day, proposals, userRejections, overCreationPct, falseAutoMerge, gatesOk ? 1 : 0);

  return {
    day,
    proposals,
    userRejections,
    overCreationPct,
    falseAutoMerge,
    gatesOk,
  };
}

/** The stored window, newest first, for the Settings pane. */
export function graduationWindow(limit = GRADUATION_REQUIRED_DAYS): GraduationDayRow[] {
  const rows = getDb()
    .prepare(
      `SELECT day, proposals, user_rejections, over_creation_pct, false_auto_merge, gates_ok
         FROM graduation_metrics ORDER BY day DESC LIMIT ?`,
    )
    .all(Math.max(1, limit)) as {
    day: string;
    proposals: number;
    user_rejections: number;
    over_creation_pct: number | null;
    false_auto_merge: number;
    gates_ok: number;
  }[];
  return rows.map((r) => ({
    day: r.day,
    proposals: r.proposals,
    userRejections: r.user_rejections,
    overCreationPct: r.over_creation_pct,
    falseAutoMerge: r.false_auto_merge,
    gatesOk: r.gates_ok === 1,
  }));
}

/**
 * How many consecutive days ending YESTERDAY (relative to `now`) have a green
 * row. A missing day breaks the streak — absence of measurement is not
 * evidence the gates held.
 */
export function consecutiveGreenDays(now: Date): number {
  const db = getDb();
  const stmt = db.prepare(`SELECT gates_ok FROM graduation_metrics WHERE day = ?`);
  let streak = 0;
  for (let back = 1; back <= 3650; back++) {
    const d = dayOf(new Date(now.getTime() - back * 86_400_000).toISOString());
    const row = stmt.get(d) as { gates_ok: number } | undefined;
    if (!row || row.gates_ok !== 1) break;
    streak++;
  }
  return streak;
}

// ---- the auto-flip ---------------------------------------------------------

export interface GraduationCheck {
  flipped: boolean;
  mode: GraduationMode;
  consecutiveGreen: number;
  windowProposals: number;
  reverted: boolean;
}

/**
 * Record yesterday's metrics (if not yet measured) and flip to auto-create
 * when earned. Safe to call every tick: idempotent, and a no-op once
 * graduated or once the user has reverted.
 */
export function checkGraduation(now: Date = new Date()): GraduationCheck {
  const yesterday = dayOf(new Date(now.getTime() - 86_400_000).toISOString());
  const db = getDb();
  const has = db
    .prepare(`SELECT 1 FROM graduation_metrics WHERE day = ?`)
    .get(yesterday);
  if (!has) recordGraduationMetrics(yesterday);

  const consecutiveGreen = consecutiveGreenDays(now);
  const reverted = graduationUserReverted();
  const windowProposals = (
    db
      .prepare(
        `SELECT COALESCE(SUM(proposals), 0) AS n FROM (
           SELECT proposals FROM graduation_metrics WHERE gates_ok = 1
            ORDER BY day DESC LIMIT ?)`,
      )
      .get(GRADUATION_REQUIRED_DAYS) as { n: number }
  ).n;

  const mode = graduationMode();
  if (
    mode === "propose" &&
    !reverted &&
    consecutiveGreen >= GRADUATION_REQUIRED_DAYS &&
    windowProposals >= GRADUATION_MIN_PROPOSALS
  ) {
    setGraduationMode("auto", "code");
    // The announcement: durable, dismissible, in the Prepared shelf — dedup'd
    // on a content key so a re-run never mints a second one.
    createArtifact({
      kind: "announcement",
      title: "Spaces now auto-create",
      summary:
        `The twin's proposals held every gate for ${GRADUATION_REQUIRED_DAYS} straight days, ` +
        `so new spaces now activate on their own. You can switch back to ` +
        `propose-only any time in Settings › General.`,
      intent: "announce graduation to auto-create",
      reasoning: `${consecutiveGreen} consecutive green days, ${windowProposals} proposals in window`,
      topicKey: "graduation:auto-create",
      contentKey: `graduation:auto-create:${GRADUATION_REQUIRED_DAYS}`,
      producer: "assist",
      nowMs: now.getTime(),
    });
    return {
      flipped: true,
      mode: "auto",
      consecutiveGreen,
      windowProposals,
      reverted,
    };
  }
  return { flipped: false, mode, consecutiveGreen, windowProposals, reverted };
}

/** Test/dev helper: mint an id in the space_links shape. */
export function mintLinkId(): string {
  return `sl_${randomBytes(9).toString("hex")}`;
}
