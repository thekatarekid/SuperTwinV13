// ===========================================================================
// Space-creation mode + the over-creation metric — build P4.3, revised.
//
// SPEC DELTA (deliberate, from real use of the 13.4.1 build): the shipped
// default was PROPOSE-ONLY, graduating to auto-create only after 14 clean days
// (spec §9.1 / build §P4.3). That made a fresh install a review queue: every
// space the twin understood sat waiting for a click before it existed. The
// default is now AUTO-CREATE — a new space is born active — and propose-only
// is the setting a user turns ON when they want to vet each one.
//
// What that changes, and what it deliberately does not:
//
//   * DEFAULT_GRADUATION_MODE is "auto", so a fresh install (no app_state row)
//     reads back "auto" and spaceCreationStatus() answers "active".
//   * The Settings switch still flips both ways and is still a decisions row,
//     so the choice is recorded and reversible like every other change.
//   * Spaces ALREADY 'proposed' stay proposed — the review queue keeps working
//     for them; nothing is retro-activated behind the user's back.
//   * recordGraduationMetrics(day) still measures ONE day's gates from the
//     decisions ledger:
//       over_creation     user rejections / proposals (< 10% passes, §18.2)
//       false_auto_merge  auto-applied merges later reversed (must be 0)
//     and still stores the row in graduation_metrics. It is now INFORMATIONAL
//     — a health read the Settings pane shows — not a gate anything waits on.
//   * The old auto-flip (propose → auto after the streak, announced in the
//     Prepared shelf) is GONE with the default it existed to reach. Turning
//     auto-create off is now a deliberate user choice, and code silently
//     turning it back on would be exactly the surprise the sticky-revert
//     override was written to prevent.
//   * spaceCreationStatus() is still the ONE reader that changes behavior:
//     the commit path asks it for the status a pass-created space is born with.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { appStateGet, appStateSet } from "../db/ingest.js";

// ---- keys and constants ----------------------------------------------------

/** app_state: "auto" | "propose". Unset means DEFAULT_GRADUATION_MODE. */
export const GRADUATION_MODE_KEY = "spaces.graduation_mode";
/** app_state: "1" once the user chose propose-only — code never overrides it. */
export const GRADUATION_REVERTED_KEY = "spaces.graduation_reverted";
/**
 * What a FRESH INSTALL does: create spaces active. Propose-only is opt-in.
 */
export const DEFAULT_GRADUATION_MODE: GraduationMode = "auto";
/** The window the over-creation metric is reported over (informational). */
export const GRADUATION_REQUIRED_DAYS = 14;
/**
 * Below this many proposals across the window the over-creation percentage is
 * noise, not a signal — 14 silent days prove nothing. Surfaces use it to say
 * "not enough traffic to judge" instead of printing a flattering 0%.
 */
export const GRADUATION_MIN_PROPOSALS = 5;
/** The over-creation hard gate (spec §18.2): rejections/proposals < 10%. */
export const OVER_CREATION_MAX_PCT = 10;

export type GraduationMode = "propose" | "auto";

// ---- mode ------------------------------------------------------------------

export function graduationMode(): GraduationMode {
  const stored = appStateGet(GRADUATION_MODE_KEY);
  if (stored === "auto") return "auto";
  if (stored === "propose") return "propose";
  return DEFAULT_GRADUATION_MODE;
}

/**
 * Flip the mode. `by` names who flipped it: "user" (Settings) or "code".
 * Choosing propose-only sets the sticky override so no code path can quietly
 * hand auto-create back.
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
        : `space creation set to ${mode} by code`,
  });
}

/** True once the user has deliberately chosen propose-only. */
export function graduationUserReverted(): boolean {
  return appStateGet(GRADUATION_REVERTED_KEY) === "1";
}

/**
 * The status a PASS-created space is born with. "active" by default (the twin
 * files it and you can undo); "proposed" when the user has turned propose-only
 * on, which routes it to the review queue instead.
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

// ---- the tick: measure, never flip -----------------------------------------

export interface GraduationCheck {
  mode: GraduationMode;
  consecutiveGreen: number;
  windowProposals: number;
  /** True when the user chose propose-only by hand. */
  reverted: boolean;
}

/**
 * Record yesterday's metrics (if not yet measured) and report the streak.
 * Safe to call every tick: idempotent and read-only apart from the day's
 * metric row.
 *
 * It does NOT change the mode. Auto-create is the default now, so there is
 * nothing left to graduate TO; and a user who turned propose-only on should
 * never find it turned back off by a background job.
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

  return { mode: graduationMode(), consecutiveGreen, windowProposals, reverted };
}

/** Test/dev helper: mint an id in the space_links shape. */
export function mintLinkId(): string {
  return `sl_${randomBytes(9).toString("hex")}`;
}
