// ===========================================================================
// [CODE] Library maintenance — V6 P1 S6d L1 (Library latency root-cause).
//
// Two chores that keep the Library's four sub-tabs answering instantly, both
// deliberately OFF the request path:
//
// 1. WARM the Storage snapshot. The per-source bars are a real measurement —
//    a grouped aggregate over the whole event log plus two directory walks —
//    and on a large home it costs on the order of a second. Taken once here,
//    shortly after boot, so the FIRST time the user opens Storage the panel is
//    served from a snapshot instead of paying for it. Afterwards the snapshot
//    refreshes itself, also off the request path (library/storage.ts).
//
// 2. TRUNCATE the WAL when the log is quiet. SQLite's automatic checkpoint
//    keeps the WAL bounded but never shrinks the file, so a home that once
//    imported a large history carries the high-water mark forever: the user's
//    real home had an 801 MB `-wal` beside a 1.05 GB database, and every read
//    consults that WAL index. A TRUNCATE checkpoint gives the disk back. It is
//    only attempted when nothing was written for a while — a checkpoint during
//    an import competes with the importer for exactly the wrong reason, and it
//    quietly does nothing when a reader holds a snapshot anyway.
//
// Zero model calls.
// ===========================================================================

import { checkpointWal, getDb } from "../db/connection.js";
import { warmStorageSnapshot } from "./storage.js";

const SWEEP_MS = 60_000;
/** How long the log must have been still before a checkpoint is worth taking. */
const CHECKPOINT_QUIET_MS = 5 * 60_000;
/** A shorter stillness is enough to slip the one-off warm in. */
const WARM_QUIET_MS = 10_000;
/** ...but the warm happens regardless once this long has passed. */
const WARM_DEADLINE_MS = 10 * 60_000;
const CHECKPOINT_EVERY_SWEEPS = 10;

export interface LibraryMaintenanceHandle {
  stop(): void;
}

/** O(1): the last rowid written to the log. */
function logHead(): number {
  try {
    return ((getDb().prepare(`SELECT MAX(rowid) AS n FROM events`).get() as { n: number | null }).n) ?? 0;
  } catch {
    return 0;
  }
}

export function startLibraryMaintenance(
  opts: {
    log?: (line: string) => void;
    sweepMs?: number;
    warmQuietMs?: number;
    warmDeadlineMs?: number;
    checkpointQuietMs?: number;
  } = {},
): LibraryMaintenanceHandle {
  const log = opts.log ?? ((line: string) => console.error(line));
  const warmQuietMs = opts.warmQuietMs ?? WARM_QUIET_MS;
  const warmDeadlineMs = opts.warmDeadlineMs ?? WARM_DEADLINE_MS;
  const checkpointQuietMs = opts.checkpointQuietMs ?? CHECKPOINT_QUIET_MS;
  const bootedAt = Date.now();

  let lastHead = logHead();
  let lastChangeAt = Date.now();
  let warmed = false;
  let sweeps = 0;

  const sweep = (): void => {
    sweeps += 1;
    const now = Date.now();
    const head = logHead();
    if (head !== lastHead) {
      lastHead = head;
      lastChangeAt = now;
    }
    const still = now - lastChangeAt;

    // The warm is one synchronous measurement of the whole log — on a large
    // home, on the order of a second. Slip it into a lull if there is one, but
    // never let an import that runs for an hour mean the panel is never warm.
    if (!warmed && (still >= warmQuietMs || now - bootedAt >= warmDeadlineMs)) {
      warmed = true;
      try {
        const started = Date.now();
        warmStorageSnapshot();
        log(`[library] storage snapshot warmed in ${Date.now() - started} ms`);
      } catch (err) {
        log(`[library] storage warm failed: ${String(err)}`);
      }
      return; // one chore per sweep
    }

    if (sweeps % CHECKPOINT_EVERY_SWEEPS !== 0) return;
    if (still < checkpointQuietMs) return; // still importing — leave the disk to the writer
    try {
      checkpointWal();
    } catch (err) {
      log(`[library] wal checkpoint failed: ${String(err)}`);
    }
  };

  const timer = setInterval(sweep, opts.sweepMs ?? SWEEP_MS);
  timer.unref?.();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
