// ===========================================================================
// Space-creation mode + graduation — build P4.3, re-set by V6 P1 S5.1
// (Build §8 lane A; Product_V6_Phase1 §13.3; Product_V6 §11.10 "Space birth").
//
// PROPOSE-ONLY is the default for the first weeks: an INFERRED space goes to
// the review queue and the user approves it. The install graduates to
// AUTO-CREATE after two clean weeks on the gates — no false merges, no
// over-creation — and a false merge afterwards resets the clock: the mode
// drops back to propose-only and the fourteen days start over (SPC-06).
//
//   * DEFAULT_GRADUATION_MODE is "propose"; spaceCreationStatus() answers
//     "proposed" on a fresh install. Asked-for spaces (the bar) never consult
//     this — they are born active whatever the mode (spaces/birth.ts).
//   * recordGraduationMetrics(day) measures ONE day's gates from the
//     decisions ledger:
//       over_creation     user rejections / proposals (< 10% passes, §18.2)
//       false_auto_merge  auto-applied merges later reversed (must be 0)
//   * checkGraduation(now) — on the consolidation job's minute tick —
//     records yesterday, then:
//       propose → auto   when the streak reaches GRADUATION_REQUIRED_DAYS with
//                        at least GRADUATION_MIN_PROPOSALS seen (14 silent days
//                        prove nothing), unless the user chose propose-only by
//                        hand (sticky — code never overrides a user's choice).
//       auto → propose   when a false merge lands while auto was reached BY
//                        CODE: the clock resets. A user who set auto by hand
//                        keeps it (their call, their risk; Settings shows the
//                        red day).
//     Every flip is a decisions row (pass "code:graduation").
//   * Spaces ALREADY 'proposed' stay proposed across a flip — the review
//     queue keeps working for them; nothing is retro-activated.
//   * spaceCreationStatus() is the ONE reader that changes behavior: the
//     commit path asks it for the status a pass-created space is born with.
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
/** app_state: who last set the mode — "user" | "code". Code only undoes its own flips. */
export const GRADUATION_BY_KEY = "spaces.graduation_by";
/**
 * What a FRESH INSTALL does: PROPOSE. Inferred spaces queue for review until
 * two clean weeks graduate the install to auto-create.
 */
export const DEFAULT_GRADUATION_MODE: GraduationMode = "propose";
/** Two clean weeks on the gates graduate propose-only to auto-create. */
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
  // The user's choice is recorded even when it matches the current mode: a
  // hand-set propose-only on a fresh install is still a sticky choice.
  if (by === "user") {
    appStateSet(GRADUATION_BY_KEY, by);
    appStateSet(GRADUATION_REVERTED_KEY, mode === "propose" ? "1" : "0");
  }
  if (before === mode) return;
  appStateSet(GRADUATION_MODE_KEY, mode);
  appStateSet(GRADUATION_BY_KEY, by);
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
        : mode === "auto"
          ? `graduated to auto-create: ${GRADUATION_REQUIRED_DAYS} clean days on the gates`
          : "reset to propose-only: a false auto-merge landed — the clock starts over",
  });
}

/** True once the user has deliberately chosen propose-only. */
export function graduationUserReverted(): boolean {
  return appStateGet(GRADUATION_REVERTED_KEY) === "1";
}

/** Who last set the mode; null on a fresh install (nobody — the default). */
export function graduationSetBy(): "user" | "code" | null {
  const v = appStateGet(GRADUATION_BY_KEY);
  return v === "user" || v === "code" ? v : null;
}

/**
 * The status a PASS-created space is born with. "proposed" by default (the
 * review queue); "active" once the install graduated or the user switched
 * auto-create on. The bar never asks — asked-for spaces are always active.
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

// ---- the tick: measure, then graduate or reset -----------------------------

export interface GraduationCheck {
  mode: GraduationMode;
  consecutiveGreen: number;
  windowProposals: number;
  /** True when the user chose propose-only by hand. */
  reverted: boolean;
  /** What this tick did: nothing, graduated to auto, or reset to propose. */
  flipped: null | "graduated" | "reset";
}

/**
 * Record yesterday's metrics (if not yet measured), then apply the two
 * graduation rules. Safe to call every tick: idempotent, and a flip writes
 * exactly one decisions row.
 *
 *   propose → auto   streak ≥ GRADUATION_REQUIRED_DAYS and ≥ GRADUATION_MIN_
 *                    PROPOSALS across the green window; never while the user's
 *                    sticky propose-only override is set.
 *   auto → propose   yesterday carried a false auto-merge and auto was reached
 *                    by code (not chosen by the user): the clock resets.
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

  let flipped: GraduationCheck["flipped"] = null;
  const mode = graduationMode();
  if (
    mode === "propose" &&
    !reverted &&
    consecutiveGreen >= GRADUATION_REQUIRED_DAYS &&
    windowProposals >= GRADUATION_MIN_PROPOSALS
  ) {
    setGraduationMode("auto", "code");
    flipped = "graduated";
  } else if (mode === "auto" && graduationSetBy() === "code") {
    const y = db
      .prepare(`SELECT false_auto_merge FROM graduation_metrics WHERE day = ?`)
      .get(yesterday) as { false_auto_merge: number } | undefined;
    if (y && y.false_auto_merge > 0) {
      setGraduationMode("propose", "code");
      flipped = "reset";
    }
  }

  return { mode: graduationMode(), consecutiveGreen, windowProposals, reverted, flipped };
}

/** Test/dev helper: mint an id in the space_links shape. */
export function mintLinkId(): string {
  return `sl_${randomBytes(9).toString("hex")}`;
}
