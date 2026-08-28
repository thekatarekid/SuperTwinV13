// ===========================================================================
// T3 deep consolidation — build P4.3 (spec §15.3). Opportunistic: runs only
// when the machine is IDLE and ON POWER, at most once per day, and every step
// is code — deterministic, idempotent, reversible via decisions rows:
//
//   1. Cross-space linking     active spaces sharing ≥2 claim subjects get a
//                              space_links row (0107) + a `link` decision.
//   2. Claim compression       per claim_key, non-active versions beyond the
//                              newest COMPRESS_KEEP are collapsed into ONE
//                              decision row (old_json carries the full rows —
//                              evidence preserved, restorable) and deleted.
//   3. Summary refresh         active spaces whose last episode landed after
//                              the space was last updated are re-queued for
//                              Decide (the pass that owns space summaries).
//   4. Embedding refresh       the semantic indexer is woken to fill any gap
//                              in the vector index (new/changed rows).
//   5. Ephemeral expiry        `permanence='ephemeral'` spaces idle past
//                              EPHEMERAL_EXPIRY_DAYS are archived.
//   6. Eval regression hook    the run marks the golden set due (or calls the
//                              injected hook) — live evals never run from a
//                              unit-tested code path (build convention).
//
// Graduation bookkeeping (daily metric + flip check) lives in the minute job,
// not here: gates must be measured whether or not the machine ever idles.
// ===========================================================================

import { execFile } from "node:child_process";

import { getDb } from "../db/connection.js";
import { writeDecision } from "../db/decisions.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import { enqueueDecide } from "../brain/decide-queue.js";
import { wakeSemanticIndexer } from "../retrieval/indexer.js";
import { mintLinkId } from "./graduation.js";

// ---- constants -------------------------------------------------------------

/** app_state: ISO instant of the last completed T3 run. */
export const T3_LAST_RUN_KEY = "consolidation.t3_last_run_at";
/** app_state: JSON of the last run's report (Settings › General shows it). */
export const T3_LAST_REPORT_KEY = "consolidation.t3_last_report";
/** app_state: ISO instant marking a golden-set regression run as due. */
export const T3_EVAL_DUE_KEY = "consolidation.t3_eval_regression_due";
/** Shared claim SUBJECTS two active spaces need before T3 links them. */
export const CROSS_LINK_MIN_SHARED = 2;
/** Non-active versions kept verbatim per claim_key; older ones compress. */
export const COMPRESS_KEEP = 3;
/** Days without activity before an ephemeral space is archived. */
export const EPHEMERAL_EXPIRY_DAYS = 45;
/** At most one T3 per this window — deep work, not a treadmill. */
export const T3_MIN_INTERVAL_MS = 24 * 3_600_000;
/** Seconds of no input that count as "the machine is idle". */
export const IDLE_MIN_SEC = 300;

export interface T3Report {
  ranAt: string;
  crossLinks: number;
  claimVersionsCompressed: number;
  summariesQueued: number;
  embedderWoken: boolean;
  ephemeralArchived: number;
  evalHookFired: boolean;
}

export interface T3Options {
  now?: Date;
  /** Called instead of marking the golden set due (production wires the harness). */
  evalHook?: () => void | Promise<void>;
}

// ---- idle + power detection ------------------------------------------------

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000 }, (err, stdout) => {
      resolve(err ? "" : String(stdout));
    });
  });
}

/**
 * True when the Mac is on AC power AND has seen no input for IDLE_MIN_SEC.
 * Any probe failure reads as "not idle" — T3 errs toward staying out of the
 * user's way. Injectable in the job for tests and other platforms.
 */
export async function machineIdleAndOnPower(): Promise<boolean> {
  const batt = await exec("pmset", ["-g", "batt"]);
  if (!/AC Power/.test(batt)) return false;
  const hid = await exec("ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
  const m = hid.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!m) return false;
  const idleSec = Number(m[1]) / 1e9; // HIDIdleTime is nanoseconds
  return idleSec >= IDLE_MIN_SEC;
}

// ---- the pass --------------------------------------------------------------

/** 1. Cross-space linking: shared claim subjects between active spaces. */
function crossLink(db: ReturnType<typeof getDb>): number {
  const pairs = db
    .prepare(
      `SELECT a.space_id AS a_id, b.space_id AS b_id,
              COUNT(DISTINCT va.subject_id) AS shared,
              GROUP_CONCAT(DISTINCT va.subject_id) AS subjects
         FROM space_claims a
         JOIN claim_versions va ON va.claim_key = a.claim_key
                               AND va.subject_id IS NOT NULL
         JOIN claim_versions vb ON vb.subject_id = va.subject_id
         JOIN space_claims b ON b.claim_key = vb.claim_key
                            AND b.space_id > a.space_id
         JOIN spaces sa ON sa.id = a.space_id AND sa.status = 'active'
         JOIN spaces sb ON sb.id = b.space_id AND sb.status = 'active'
        GROUP BY a.space_id, b.space_id
       HAVING shared >= ?`,
    )
    .all(CROSS_LINK_MIN_SHARED) as { a_id: string; b_id: string; shared: number; subjects: string }[];

  let created = 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO space_links (id, a_space_id, b_space_id, shared_json, created_by)
     VALUES (?, ?, ?, ?, 't3')`,
  );
  for (const p of pairs) {
    const id = mintLinkId();
    const res = insert.run(id, p.a_id, p.b_id, JSON.stringify(p.subjects.split(",")));
    if (res.changes === 0) continue; // already linked — idempotent
    created++;
    writeDecision({
      pass: "code:t3",
      targetKind: "space_link",
      targetId: id,
      action: "link",
      new: { a: p.a_id, b: p.b_id, sharedSubjects: p.subjects.split(",") },
      reason: `spaces share ${p.shared} claim subject(s)`,
    });
  }
  return created;
}

/** 2. Claim compression: old superseded versions → one restorable decision. */
function compressClaims(db: ReturnType<typeof getDb>): number {
  const keys = db
    .prepare(
      `SELECT claim_key, active_version_id FROM claims WHERE version_count > ?`,
    )
    .all(COMPRESS_KEEP + 1) as { claim_key: string; active_version_id: string | null }[];

  let compressed = 0;
  for (const k of keys) {
    // Everything that is neither the active version nor among the newest
    // COMPRESS_KEEP non-active versions.
    const old = db
      .prepare(
        `SELECT * FROM claim_versions
          WHERE claim_key = ? AND id IS NOT ?
          ORDER BY stated_at DESC, id DESC LIMIT -1 OFFSET ?`,
      )
      .all(k.claim_key, k.active_version_id, COMPRESS_KEEP) as Record<string, unknown>[];
    if (old.length === 0) continue;

    // ONE decision row per claim_key holds the full deleted rows (evidence
    // included) — the undo payload, and the archive.
    writeDecision({
      pass: "code:t3",
      targetKind: "claim",
      targetId: k.claim_key,
      action: "compress",
      old: { versions: old },
      new: { archivedVersions: old.length },
      reason: `compressed ${old.length} old version(s); evidence preserved in this row`,
    });
    const del = db.prepare(`DELETE FROM claim_versions WHERE id = ?`);
    for (const row of old) del.run(String(row.id));
    // Keep the header honest.
    db.prepare(
      `UPDATE claims SET version_count = version_count - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE claim_key = ?`,
    ).run(old.length, k.claim_key);
    compressed += old.length;
  }
  return compressed;
}

/** 3. Summary refresh: spaces whose episodes outran their summary. */
function queueSummaryRefresh(db: ReturnType<typeof getDb>): number {
  const stale = db
    .prepare(
      `SELECT s.id, e.id AS episode_id
         FROM spaces s
         JOIN episodes e ON e.space_id = s.id
        WHERE s.status = 'active'
          AND e.created_at > COALESCE(s.updated_at, s.created_at)
        GROUP BY s.id`,
    )
    .all() as { id: string; episode_id: string }[];
  for (const row of stale) enqueueDecide(row.id, [row.episode_id], "backfill");
  return stale.length;
}

/** 5. Ephemeral expiry: idle ephemeral spaces archive (reversibly). */
function expireEphemeral(db: ReturnType<typeof getDb>, now: Date): number {
  const cutoff = new Date(now.getTime() - EPHEMERAL_EXPIRY_DAYS * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM spaces
        WHERE permanence = 'ephemeral' AND status IN ('active','dormant')
          AND COALESCE(updated_at, created_at) < ?`,
    )
    .all(cutoff) as Record<string, unknown>[];
  const update = db.prepare(
    `UPDATE spaces SET status = 'archived',
            archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
  );
  for (const row of rows) {
    update.run(String(row.id));
    writeDecision({
      pass: "code:t3",
      targetKind: "space",
      targetId: String(row.id),
      action: "archive",
      old: row,
      new: { status: "archived" },
      reason: `ephemeral space idle > ${EPHEMERAL_EXPIRY_DAYS} days`,
    });
  }
  return rows.length;
}

/**
 * One full T3 pass. The CALLER gates on idle+power and the daily interval
 * (job.ts); calling this directly always runs — that is what tests and the
 * "run deep pass now" affordance want.
 */
export async function runT3(opts: T3Options = {}): Promise<T3Report> {
  const now = opts.now ?? new Date();
  const db = getDb();

  const crossLinks = crossLink(db);
  const claimVersionsCompressed = compressClaims(db);
  const summariesQueued = queueSummaryRefresh(db);

  let embedderWoken = false;
  try {
    wakeSemanticIndexer();
    embedderWoken = true;
  } catch {
    embedderWoken = false;
  }

  const ephemeralArchived = expireEphemeral(db, now);

  let evalHookFired = false;
  if (opts.evalHook) {
    await opts.evalHook();
    evalHookFired = true;
  } else {
    appStateSet(T3_EVAL_DUE_KEY, now.toISOString());
  }

  const report: T3Report = {
    ranAt: now.toISOString(),
    crossLinks,
    claimVersionsCompressed,
    summariesQueued,
    embedderWoken,
    ephemeralArchived,
    evalHookFired,
  };
  appStateSet(T3_LAST_RUN_KEY, report.ranAt);
  appStateSet(T3_LAST_REPORT_KEY, JSON.stringify(report));
  return report;
}

/** When the last completed T3 ran, or null. */
export function lastT3RunAt(): string | null {
  return appStateGet(T3_LAST_RUN_KEY) ?? null;
}

/** The last run's stored report, for Settings. */
export function lastT3Report(): T3Report | null {
  const raw = appStateGet(T3_LAST_REPORT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T3Report;
  } catch {
    return null;
  }
}

/** True when a T3 is due (interval elapsed) at `now`. */
export function t3Due(now: Date = new Date()): boolean {
  const last = lastT3RunAt();
  if (!last) return true;
  return now.getTime() - Date.parse(last) >= T3_MIN_INTERVAL_MS;
}
