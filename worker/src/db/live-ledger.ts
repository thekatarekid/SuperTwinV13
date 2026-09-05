// ===========================================================================
// [CODE] The live-pass ledger and the shipped latency budgets — what survives
// of the deleted V13 scheduler's live-budgets.ts (V6 P1 S3.3). The ops
// latency panel (server/system-routes.ts) reads `liveCallsInWindow` and
// `LIVE_BUDGETS`; nothing else in the tree records into this ledger any more,
// so the count is what the panel measures, not what the scheduler promises.
// ===========================================================================

import { getDb } from "./connection.js";
import { appStateGet, appStateSet } from "./ingest.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const LIVE_BUDGETS = {
  /** Cold install → the first claim on screen. */
  firstClaimMs: 30_000,
  /** Cold install → spaces and tasks on screen. */
  spacesTasksMs: 120_000,
  /** Longest silent gap during a full import, quota pauses excluded. */
  silentGapMs: 90_000,
  /** Steady-state model calls on a quiet day, live passes + consolidations. */
  steadyCallsPerDay: 12,
  /** Claims visible within the effective interval plus this. */
  visibilitySlackMs: 15_000,
} as const;

export type LivePassKind = "delta" | "consolidation";

export interface LedgerEntry {
  atMs: number;
  kind: LivePassKind;
}

const LEDGER_PREFIX = "live_ledger:";

/** `1712000000000:d,1712000030000:c` — greppable in a sqlite shell, not JSON. */
function encodeLedger(entries: readonly LedgerEntry[]): string {
  return entries.map((e) => `${e.atMs}:${e.kind === "consolidation" ? "c" : "d"}`).join(",");
}

function decodeLedger(raw: string | null): LedgerEntry[] {
  if (!raw) return [];
  const out: LedgerEntry[] = [];
  for (const part of raw.split(",")) {
    if (part === "") continue;
    const colon = part.indexOf(":");
    const atMs = Number(colon > 0 ? part.slice(0, colon) : part);
    if (!Number.isFinite(atMs)) continue;
    out.push({ atMs, kind: part.slice(colon + 1) === "c" ? "consolidation" : "delta" });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export function readLedger(streamId: string): LedgerEntry[] {
  return decodeLedger(appStateGet(`${LEDGER_PREFIX}${streamId}`));
}

/** Append one pass and prune anything older than 24 h. */
export function recordLivePass(streamId: string, atMs: number, kind: LivePassKind = "delta"): LedgerEntry[] {
  const kept = readLedger(streamId).filter((e) => e.atMs > atMs - DAY_MS);
  kept.push({ atMs, kind });
  kept.sort((a, b) => a.atMs - b.atMs);
  appStateSet(`${LEDGER_PREFIX}${streamId}`, encodeLedger(kept));
  return kept;
}

/** Passes this stream has already spent in the trailing hour. */
export function passesThisHour(streamId: string, nowMs: number): number {
  return readLedger(streamId).filter((e) => e.atMs > nowMs - HOUR_MS && e.kind === "delta").length;
}

interface LedgerRow {
  key: string;
  value: string | null;
}

function allLedgers(): { streamId: string; entries: LedgerEntry[] }[] {
  const rows = getDb()
    .prepare(`SELECT key, value FROM app_state WHERE key LIKE '${LEDGER_PREFIX}%'`)
    .all() as LedgerRow[];
  return rows.map((row) => ({
    streamId: row.key.slice(LEDGER_PREFIX.length),
    entries: decodeLedger(row.value),
  }));
}

/** Model calls attributable to the live path in the trailing window. One pass is one call. */
export function liveCallsInWindow(nowMs: number, windowMs: number = DAY_MS): number {
  let total = 0;
  for (const ledger of allLedgers()) {
    total += ledger.entries.filter((e) => e.atMs > nowMs - windowMs).length;
  }
  return total;
}
