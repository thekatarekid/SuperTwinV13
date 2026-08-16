// ===========================================================================
// The quiet-day call budget, PROVED over the real scheduler — build item 4.2,
// global acceptance "steady-state model calls ≤ 12 on a quiet day".
//
// live.test.ts checks the arithmetic (`quietDayEstimate`) and single ticks.
// This file runs the whole day: a real DB, real open sessions, real events,
// and `runLiveTick` invoked at the full 30-second cadence — 2,880 ticks — with
// the ledger counting what actually fired. No estimate, no shortcut tick
// schedule that happens to skip the ticks that would breach.
//
// The defect this simulation caught (and the guard in runLiveTick now stops):
// once a session's tail is drained, `quietMs >= interval` stays true on every
// later tick, so an open-but-idle session re-fired an EMPTY delta every 30 s
// until the hourly cap — ~480 calls on a day budgeted at 12. A gate that
// cannot fail is not a gate; this one failed first and then got the fix.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { latencySnapshot, recordMilestoneMark } from "../db/latency-marks.js";
import {
  consolidationVerdict,
  liveCallsInWindow,
  LIVE_BUDGETS,
  quietDayEstimate,
  recordConsolidation,
  runLiveTick,
} from "./live.js";

const SOURCE = "whatsapp";
const DAY_START = Date.parse("2026-08-15T00:00:00.000Z");
const TICK_MS = 30_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

let tmpDir: string;
let seq = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-quiet-day-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  seq = 0;
  upsertSource({ id: SOURCE, type: SOURCE, name: "WhatsApp" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function stream(ext: string): string {
  const id = upsertStream({ sourceId: SOURCE, sourceExtId: ext, name: ext, kind: "dm" });
  getDb().prepare(`UPDATE streams SET tier = 'T1', tier_source = 'code' WHERE id = ?`).run(id);
  return id;
}

function openSession(streamId: string, startedAtMs: number): string {
  seq += 1;
  const id = `qd-s${seq}`;
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
       VALUES (?, ?, ?, ?, ?, '[]', 'open', ?)`,
    )
    .run(id, streamId, SOURCE, new Date(startedAtMs).toISOString(), new Date(startedAtMs).toISOString(), id);
  return id;
}

/** `n` messages at `atMs`, 20 s apart; content hash moves — content changed. */
function burst(sessionId: string, streamId: string, atMs: number, n: number): void {
  const db = getDb();
  const actorId = upsertActor({ sourceId: SOURCE, sourceExtId: "peer", displayName: "peer" });
  const row = db.prepare(`SELECT event_ids FROM sessions WHERE id = ?`).get(sessionId) as { event_ids: string };
  const ids = JSON.parse(row.event_ids ?? "[]") as string[];
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    const res = insertEvent({
      externalId: `${sessionId}/${seq}`,
      sourceId: SOURCE,
      sourceType: SOURCE,
      streamId,
      actorId,
      ts: new Date(atMs + i * 20_000).toISOString(),
      kind: "message",
      text: `message ${seq}`,
      mediaPath: null,
      rawJson: null,
      isHistorical: false,
    });
    ids.push(res.id);
  }
  db.prepare(`UPDATE sessions SET ended_at = ?, event_ids = ?, content_hash = ? WHERE id = ?`).run(
    new Date(atMs + (n - 1) * 20_000).toISOString(),
    JSON.stringify(ids),
    `${sessionId}-h${ids.length}`,
    sessionId,
  );
}

function seal(sessionId: string): void {
  getDb().prepare(`UPDATE sessions SET status = 'sealed' WHERE id = ?`).run(sessionId);
}

describe("a quiet day over the REAL scheduler, ticked at the full 30 s cadence", () => {
  it("holds §8.3's reference quiet day (3 sessions × 3 bursts) at or under 12 calls", () => {
    // The same day quietDayEstimate prices: three friends, three short
    // conversational bursts each, six messages per burst. Sessions open when
    // their first burst lands and seal 45 minutes after their last one.
    const shape = [
      { ext: "alice", opensAt: DAY_START + 9 * HOUR, burstGapMin: 25 },
      { ext: "bina", opensAt: DAY_START + 13 * HOUR + 10 * MINUTE, burstGapMin: 30 },
      { ext: "chetan", opensAt: DAY_START + 20 * HOUR + 5 * MINUTE, burstGapMin: 20 },
    ].map((p) => {
      const streamId = stream(p.ext);
      const burstsAt = [0, 1, 2].map((i) => p.opensAt + i * p.burstGapMin * MINUTE);
      return { ...p, streamId, sessionId: null as string | null, burstsAt, sealed: false };
    });

    const dayEnd = DAY_START + 24 * HOUR;
    let emptyRefiresHeld = 0;

    for (let now = DAY_START; now < dayEnd; now += TICK_MS) {
      // Deliver any burst due in this tick's window, opening the session lazily.
      for (const p of shape) {
        for (const at of p.burstsAt) {
          if (at >= now && at < now + TICK_MS) {
            p.sessionId ??= openSession(p.streamId, at);
            burst(p.sessionId, p.streamId, at, 6);
          }
        }
        // Seal 45 min after the final burst — the conversation gap has passed.
        const lastBurst = p.burstsAt[2]!;
        if (!p.sealed && p.sessionId && now >= lastBurst + 45 * MINUTE) {
          const verdict = consolidationVerdict(p.sessionId);
          if (verdict.run) recordConsolidation(p.sessionId, p.streamId, now);
          seal(p.sessionId);
          p.sealed = true;
        }
      }

      const tick = runLiveTick({ nowMs: now, mode: "steady" });
      // The regression this proof exists for: a fires-decision with an empty
      // delta window must be HELD, or idle sessions burn the day's budget.
      emptyRefiresHeld += tick.held.filter((h) => h.decision.fires && h.eventIds.length === 0).length;
      for (const pass of tick.fired) expect(pass.eventIds.length).toBeGreaterThan(0);
    }

    for (const p of shape) expect(p.sealed).toBe(true);

    // The ledger — real recorded passes + consolidations — versus the budget.
    const calls = liveCallsInWindow(dayEnd);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(LIVE_BUDGETS.steadyCallsPerDay);
    // And versus the arithmetic: the measured day must not exceed the estimate
    // for the same shape, or the estimate is flattering the product.
    const estimate = quietDayEstimate({ sessions: 3, burstsPerSession: 3, messagesPerBurst: 6 });
    expect(calls).toBeLessThanOrEqual(estimate.calls);

    // The idle refire really was attempted all day long — the guard held it.
    expect(emptyRefiresHeld).toBeGreaterThan(100);

    // The measurement is persisted as a milestone mark and served back (4.2).
    recordMilestoneMark({
      name: "steady_calls",
      value: calls,
      budget: LIVE_BUDGETS.steadyCallsPerDay,
      unit: "calls",
      createdAt: new Date(dayEnd).toISOString(),
    });
    const milestone = latencySnapshot().milestones.find((m) => m.name === "steady_calls");
    expect(milestone).toMatchObject({ value: calls, budget: 12, unit: "calls", met: true });
  });

  it("an open session left idle for hours fires nothing after its tail drains", () => {
    const st = stream("dora");
    const s = openSession(st, DAY_START);
    burst(s, st, DAY_START, 4);

    let fired = 0;
    for (let now = DAY_START; now < DAY_START + 6 * HOUR; now += TICK_MS) {
      fired += runLiveTick({ nowMs: now, mode: "steady" }).fired.length;
    }
    // One drain pass for the burst; six idle hours add zero.
    expect(fired).toBe(1);
    expect(liveCallsInWindow(DAY_START + 6 * HOUR)).toBe(1);
  });
});
