// ===========================================================================
// Brief rows and the two clocks the lane keeps (V6 P1 S4.6).
//
//   composed_at of the newest brief  the window "what moved" is measured from.
//                                    Only a brief the user actually got moves
//                                    it — a slot that skipped for want of a
//                                    delta leaves the window open, so the next
//                                    brief still says what moved since the
//                                    last one the user READ.
//
//   app_state `brief.last_slot`      the last set time that was ACTED on,
//                                    composed or skipped. Without it a skipped
//                                    08:30 would be re-evaluated every tick
//                                    until 18:30.
// ===========================================================================

import { randomBytes } from "node:crypto";

import { getDb } from "../db/connection.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import { writeDecision } from "../db/decisions.js";
import type { BriefLedger } from "./ledger.js";

/** app_state key: the last slot the brief job acted on (composed OR skipped). */
export const BRIEF_LAST_SLOT_KEY = "brief.last_slot";

export interface BriefRow {
  id: string;
  slot: string;
  tz: string;
  composedAt: string;
  since: string | null;
  deltaRows: number;
  ledger: BriefLedger | null;
  text: string;
  modelCalls: number;
  runId: string | null;
  seenAt: string | null;
  createdAt: string;
}

function hydrate(r: Record<string, unknown>): BriefRow {
  let ledger: BriefLedger | null = null;
  try {
    ledger = JSON.parse(String(r.ledger_json)) as BriefLedger;
  } catch {
    ledger = null;
  }
  return {
    id: String(r.id),
    slot: String(r.slot),
    tz: String(r.tz),
    composedAt: String(r.composed_at),
    since: (r.since as string | null) ?? null,
    deltaRows: Number(r.delta_rows ?? 0),
    ledger,
    text: String(r.text ?? ""),
    modelCalls: Number(r.model_calls ?? 0),
    runId: (r.run_id as string | null) ?? null,
    seenAt: (r.seen_at as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

export function mintBriefId(): string {
  return `brf_${randomBytes(9).toString("hex")}`;
}

/** The instant of the newest brief — the start of the next one's window. */
export function lastBriefAt(): string | null {
  try {
    const row = getDb()
      .prepare(`SELECT composed_at FROM briefs ORDER BY composed_at DESC, rowid DESC LIMIT 1`)
      .get() as { composed_at: string } | undefined;
    return row?.composed_at ?? null;
  } catch {
    return null;
  }
}

export function latestBrief(): BriefRow | null {
  try {
    const row = getDb()
      .prepare(`SELECT * FROM briefs ORDER BY composed_at DESC, rowid DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    return row ? hydrate(row) : null;
  } catch {
    return null;
  }
}

export function getBrief(id: string): BriefRow | null {
  const row = getDb().prepare(`SELECT * FROM briefs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? hydrate(row) : null;
}

export function listBriefs(limit = 20): BriefRow[] {
  const n = Math.max(1, Math.min(200, limit));
  const rows = getDb()
    .prepare(`SELECT * FROM briefs ORDER BY composed_at DESC, rowid DESC LIMIT ?`)
    .all(n) as Record<string, unknown>[];
  return rows.map(hydrate);
}

export interface InsertBriefInput {
  slot: string;
  tz: string;
  composedAt: string;
  since: string | null;
  deltaRows: number;
  ledger: BriefLedger;
  text: string;
  modelCalls: number;
  runId?: string | null;
}

/**
 * Write one brief. The slot is UNIQUE, so a double tick at 08:30 updates the
 * standing row rather than minting a second card for one set time.
 */
export function insertBrief(input: InsertBriefInput): BriefRow {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM briefs WHERE slot = ?`).get(input.slot) as
    | { id: string }
    | undefined;
  const id = existing?.id ?? mintBriefId();
  if (existing) {
    db.prepare(
      `UPDATE briefs SET tz = ?, composed_at = ?, since = ?, delta_rows = ?, ledger_json = ?,
                         text = ?, model_calls = ?, run_id = ? WHERE id = ?`,
    ).run(
      input.tz,
      input.composedAt,
      input.since,
      input.deltaRows,
      JSON.stringify(input.ledger),
      input.text,
      input.modelCalls,
      input.runId ?? null,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO briefs (id, slot, tz, composed_at, since, delta_rows, ledger_json, text,
                           model_calls, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.slot,
      input.tz,
      input.composedAt,
      input.since,
      input.deltaRows,
      JSON.stringify(input.ledger),
      input.text,
      input.modelCalls,
      input.runId ?? null,
      input.composedAt,
    );
  }
  writeDecision({
    runId: input.runId ?? null,
    pass: "brief",
    targetKind: "brief",
    targetId: id,
    action: existing ? "recompose" : "compose",
    new: {
      slot: input.slot,
      since: input.since,
      delta_rows: input.deltaRows,
      items:
        input.ledger.needs_you.length + input.ledger.today.length + input.ledger.moved.length,
      model_calls: input.modelCalls,
    },
  });
  const row = getBrief(id);
  if (!row) throw new Error(`brief ${id} vanished after write`);
  return row;
}

/** Open the card — the ● clears, exactly like an artifact's `seen_at`. */
export function markBriefSeen(id: string, nowMs: number = Date.now()): BriefRow | null {
  getDb()
    .prepare(`UPDATE briefs SET seen_at = ? WHERE id = ? AND seen_at IS NULL`)
    .run(new Date(nowMs).toISOString(), id);
  return getBrief(id);
}

/** The last set time the job acted on (composed OR skipped). */
export function lastSlot(): string | null {
  try {
    return appStateGet(BRIEF_LAST_SLOT_KEY);
  } catch {
    return null;
  }
}

export function setLastSlot(slot: string): void {
  appStateSet(BRIEF_LAST_SLOT_KEY, slot);
}
