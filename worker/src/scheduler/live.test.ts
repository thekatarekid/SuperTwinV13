// ===========================================================================
// The live trigger over a real DB (arch §8.3, §9.7; build item 3.4).
//
// Five defects this file exists to keep out:
//   * a delta pass that re-sends events an earlier pass already sent (O(n^2));
//   * an event that lands between the query and the cursor write and is never
//     read at all — the cursor moving to `now` instead of to the newest event;
//   * a stream firing more than 20 passes an hour, or forgetting the count
//     across a restart because the ledger lived in memory;
//   * a seal paying for a full consolidation when the deltas already covered
//     the content and the hash has not moved;
//   * a live pass claiming a session the cohort scheduler is also working.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import type { Tier } from "../tiers/priority.js";
import { candidateSessions } from "./cohorts.js";
import { LIVE_INTERVAL_MAX_MS } from "./lanes.js";
import {
  budgetReport,
  consolidationVerdict,
  deltaEventIds,
  getLiveEventTrigger,
  getLiveIntervalMs,
  intervalNote,
  IN_PROGRESS_MARKER,
  liveCallsInWindow,
  liveCandidates,
  LIVE_BUDGETS,
  LIVE_PASSES_PER_HOUR,
  passesThisHour,
  planLiveTick,
  quietDayEstimate,
  recordConsolidation,
  runLiveTick,
  setLiveEventTrigger,
  setLiveIntervalMs,
  silentGapMs,
} from "./live.js";
import { peekWork } from "./queue.js";

const SOURCE = "whatsapp";
const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const MINUTE = 60_000;

let tmpDir: string;
let seq = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-sched-live-"));
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

function stream(ext: string, tier: Tier = "T1"): string {
  const id = upsertStream({ sourceId: SOURCE, sourceExtId: ext, name: ext, kind: "dm" });
  getDb().prepare(`UPDATE streams SET tier = ?, tier_source = 'code' WHERE id = ?`).run(tier, id);
  return id;
}

/** An OPEN session on `streamId` with no events yet. */
function openSession(streamId: string, startedAtMs: number, hash = "h0"): string {
  seq += 1;
  const id = `live-s${seq}`;
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
       VALUES (?, ?, ?, ?, ?, '[]', 'open', ?)`,
    )
    .run(id, streamId, SOURCE, new Date(startedAtMs).toISOString(), new Date(startedAtMs).toISOString(), hash);
  return id;
}

/** Append `n` messages to an open session at `atMs`, one second apart. */
function say(sessionId: string, streamId: string, atMs: number, n = 1): string[] {
  const db = getDb();
  const actorId = upsertActor({ sourceId: SOURCE, sourceExtId: "peer", displayName: "peer" });
  const row = db.prepare(`SELECT event_ids FROM sessions WHERE id = ?`).get(sessionId) as { event_ids: string };
  const ids = JSON.parse(row.event_ids ?? "[]") as string[];
  const added: string[] = [];
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    const res = insertEvent({
      externalId: `${sessionId}/${seq}`,
      sourceId: SOURCE,
      sourceType: SOURCE,
      streamId,
      actorId,
      ts: new Date(atMs + i * 1000).toISOString(),
      kind: "message",
      text: `message ${seq}`,
      mediaPath: null,
      rawJson: null,
      isHistorical: false,
    });
    ids.push(res.id);
    added.push(res.id);
  }
  db.prepare(`UPDATE sessions SET ended_at = ?, event_ids = ? WHERE id = ?`).run(
    new Date(atMs + (n - 1) * 1000).toISOString(),
    JSON.stringify(ids),
    sessionId,
  );
  return added;
}

// ---------------------------------------------------------------------------

describe("the setting is a preference; the 30 s – 6 h range is a guard (§8.3)", () => {
  it("defaults to 30 s and clamps both ends on write and on read", () => {
    expect(getLiveIntervalMs()).toBe(30_000);
    expect(setLiveIntervalMs(1_000)).toBe(30_000);
    expect(setLiveIntervalMs(24 * 3_600_000)).toBe(LIVE_INTERVAL_MAX_MS);
    expect(setLiveIntervalMs(5 * MINUTE)).toBe(5 * MINUTE);
    expect(getLiveIntervalMs()).toBe(5 * MINUTE);

    // A row written out of range by anything other than the setter is still
    // clamped when read — the range is not a write-time-only courtesy.
    getDb().prepare(`UPDATE app_state SET value = '1000' WHERE key = 'live_interval_ms'`).run();
    expect(getLiveIntervalMs()).toBe(30_000);
  });

  it("carries the 6-hour note the Settings pane shows", () => {
    expect(intervalNote(30_000)).toMatch(/near-realtime/);
    expect(intervalNote(6 * 3_600_000)).toBe("at 6 hours, extraction happens only when a conversation ends");
  });

  it("takes a configurable K, floored at 1", () => {
    expect(getLiveEventTrigger()).toBe(10);
    expect(setLiveEventTrigger(4)).toBe(4);
    expect(getLiveEventTrigger()).toBe(4);
    expect(setLiveEventTrigger(0)).toBe(1);
  });
});

describe("the trigger fires on quiet OR on K events, steady state only", () => {
  it("fires after live_interval of quiet and marks the session in progress", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 5 * MINUTE);
    say(s, st, NOW - 40_000, 2);

    const plan = planLiveTick({ nowMs: NOW, mode: "steady" });
    expect(plan.plans).toHaveLength(1);
    expect(plan.plans[0]!.decision.fires).toBe(true);
    expect(plan.plans[0]!.decision.reason).toBe("quiet");
    expect(plan.plans[0]!.marker).toBe(IN_PROGRESS_MARKER);
  });

  it("fires on K new events even while the conversation is still hot", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 5 * MINUTE);
    // 10 messages, the newest 2 s ago — nowhere near 30 s of quiet.
    say(s, st, NOW - 12_000, 10);

    const plan = planLiveTick({ nowMs: NOW, mode: "steady" });
    expect(plan.plans[0]!.decision.reason).toBe("event_count");
    expect(plan.plans[0]!.decision.fires).toBe(true);
  });

  it("never fires during bootstrap — guard 3 keeps the import at full speed", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 5 * MINUTE);
    say(s, st, NOW - 5 * MINUTE, 20);

    const boot = runLiveTick({ nowMs: NOW, mode: "bootstrap" });
    expect(boot.fired).toHaveLength(0);
    expect(boot.held[0]!.decision.reason).toBe("not_steady");
    expect(peekWork({ limit: 10 })).toHaveLength(0);
  });

  it("at 6 h the interval meets the conversation gap and the trigger stops firing", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 5 * MINUTE);
    say(s, st, NOW - 5 * MINUTE, 20);
    setLiveIntervalMs(LIVE_INTERVAL_MAX_MS);

    const plan = planLiveTick({ nowMs: NOW, mode: "steady" });
    expect(plan.plans[0]!.decision.fires).toBe(false);
  });
});

describe("delta extraction is mandatory — O(n), never O(n^2) (§8.3)", () => {
  it("sends each event exactly once across the life of a session", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 60 * MINUTE);
    let now = NOW - 60 * MINUTE;
    const sent: string[] = [];
    const all: string[] = [];

    // 40 messages in bursts of 4, a minute apart — the §8.3 worked example.
    for (let burst = 0; burst < 10; burst += 1) {
      now += MINUTE;
      all.push(...say(s, st, now - 45_000, 4));
      const tick = runLiveTick({ nowMs: now, mode: "steady" });
      for (const pass of tick.fired) sent.push(...pass.eventIds);
    }

    // Backpressure holds the tail back mid-burst (guard 1), so the drain pass
    // after the conversation goes quiet is what closes the session out. Every
    // event is still sent, and still sent exactly once.
    now += 5 * MINUTE;
    for (const pass of runLiveTick({ nowMs: now, mode: "steady" }).fired) sent.push(...pass.eventIds);

    expect(all).toHaveLength(40);
    expect(sent).toHaveLength(40);
    expect(new Set(sent).size).toBe(40);
    expect([...sent].sort()).toEqual([...all].sort());
  });

  it("moves the cursor to the newest event covered, not to now", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 10 * MINUTE);
    say(s, st, NOW - 40_000, 2);
    runLiveTick({ nowMs: NOW, mode: "steady" });

    const row = getDb().prepare(`SELECT last_delta_at, delta_pass_count FROM sessions WHERE id = ?`).get(s) as {
      last_delta_at: string;
      delta_pass_count: number;
    };
    expect(Date.parse(row.last_delta_at)).toBe(NOW - 39_000);
    expect(row.delta_pass_count).toBe(1);
    // A message that landed one second before the pass but after the read is
    // still in the delta window — nothing is silently skipped.
    const late = say(s, st, NOW - 20_000, 1);
    expect(deltaEventIds(s, row.last_delta_at)).toEqual(late);
  });

  it("prices one pass at the new events plus a running summary", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 10 * MINUTE);
    say(s, st, NOW - 40_000, 4);
    const plan = planLiveTick({ nowMs: NOW, mode: "steady" });
    expect(plan.plans[0]!.inputTokens).toBe(120 + 4 * 25);
  });
});

describe("the four guards", () => {
  it("guard 1: backpressure stretches the interval VISIBLY", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 10 * MINUTE);
    say(s, st, NOW - 9 * MINUTE, 50);

    const plan = planLiveTick({ nowMs: NOW, mode: "steady" });
    expect(plan.plans[0]!.decision.intervalMs).toBeGreaterThan(30_000);
    expect(plan.labels[0]!.label).toMatch(/high activity — batching every/);
    expect(plan.labels[0]!.streamId).toBe(st);
  });

  it("guard 2: caps a stream at 20 passes an hour, across a restart", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 60 * MINUTE);
    let now = NOW - 60 * MINUTE;
    let fired = 0;
    for (let i = 0; i < 60; i += 1) {
      now += MINUTE;
      say(s, st, now - 45_000, 1);
      fired += runLiveTick({ nowMs: now, mode: "steady" }).fired.length;
    }
    expect(fired).toBe(LIVE_PASSES_PER_HOUR);

    // The ledger is in the DB, so a reopen does not hand the stream a fresh 20.
    closeDb();
    runMigrations();
    expect(passesThisHour(st, now)).toBe(LIVE_PASSES_PER_HOUR);
    expect(runLiveTick({ nowMs: now, mode: "steady" }).fired).toHaveLength(0);
  });

  it("guard 4: a seal whose hash never moved costs nothing", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 10 * MINUTE, "hash-a");
    say(s, st, NOW - 40_000, 3);
    runLiveTick({ nowMs: NOW, mode: "steady" });

    expect(consolidationVerdict(s)).toMatchObject({ run: false, reason: "hash_unchanged" });

    // A late caption moves the hash — that IS material, and consolidation runs.
    getDb().prepare(`UPDATE sessions SET content_hash = 'hash-b' WHERE id = ?`).run(s);
    expect(consolidationVerdict(s)).toMatchObject({ run: true, reason: "material_change" });

    recordConsolidation(s, st, NOW + MINUTE);
    expect(consolidationVerdict(s).run).toBe(false);
  });

  it("consolidates unconditionally when no delta ever ran", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 10 * MINUTE, "hash-a");
    say(s, st, NOW - 40_000, 3);
    expect(consolidationVerdict(s)).toMatchObject({ run: true, reason: "never_extracted" });
  });
});

describe("the hook into the cohort scheduler", () => {
  it("enqueues extract at live priority and never collides with a cohort", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 10 * MINUTE);
    say(s, st, NOW - 40_000, 3);

    const tick = runLiveTick({ nowMs: NOW, mode: "steady" });
    expect(tick.fired[0]!.work).toMatchObject({ action: "inserted" });
    const work = peekWork({ limit: 5 });
    expect(work.map((w) => [w.stage, w.unitKind, w.unitId])).toEqual([["extract", "session", s]]);

    // The open session is invisible to the cohort planner — it draws sealed
    // sessions only, so the two schedulers cannot claim the same unit.
    expect(candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW }).map((c) => c.id)).not.toContain(s);
    expect(liveCandidates(NOW).map((c) => c.sessionId)).toEqual([s]);
  });

  it("re-enqueue on a later pass reprices rather than duplicating", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 10 * MINUTE);
    say(s, st, NOW - 40_000, 3);
    runLiveTick({ nowMs: NOW, mode: "steady" });
    say(s, st, NOW + MINUTE, 3);
    const second = runLiveTick({ nowMs: NOW + 2 * MINUTE, mode: "steady" });
    expect(second.fired[0]!.work!.action).toBe("repriced");
    expect(peekWork({ limit: 10 })).toHaveLength(1);
  });
});

describe("the shipped budgets, instrumented (global acceptance)", () => {
  it("keeps a new message visible within live_interval + 15 s", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 10 * MINUTE);
    say(s, st, NOW - 31_000, 1);

    const plan = planLiveTick({ nowMs: NOW, mode: "steady" });
    const pass = plan.plans[0]!;
    expect(pass.decision.fires).toBe(true);
    // The pass fires at NOW; the deadline is the event + interval + 15 s.
    expect(pass.visibilityDeadlineMs!).toBe(NOW - 31_000 + 30_000 + 15_000);
    expect(NOW).toBeLessThanOrEqual(pass.visibilityDeadlineMs!);

    const report = budgetReport({
      nowMs: NOW,
      visibility: { latencyMs: NOW - (NOW - 31_000) + 3_000, intervalMs: 30_000 },
    });
    expect(report.checks.find((c) => c.name === "live_visibility")).toMatchObject({ met: true, budget: 45_000 });
  });

  it("holds a quiet day to 12 model calls", () => {
    const estimate = quietDayEstimate({ sessions: 3, burstsPerSession: 3, messagesPerBurst: 6 });
    expect(estimate.calls).toBe(12);
    expect(estimate.calls).toBeLessThanOrEqual(LIVE_BUDGETS.steadyCallsPerDay);
    expect(estimate.withinBudget).toBe(true);
    // The reason deltas are mandatory: whole-session re-reads cost strictly more.
    expect(estimate.wholeSessionTokens).toBeGreaterThan(estimate.deltaTokens);
  });

  it("counts real passes against the daily budget, not an estimate", () => {
    const st = stream("alice");
    const s = openSession(st, NOW - 60 * MINUTE);
    let now = NOW - 60 * MINUTE;
    for (let i = 0; i < 6; i += 1) {
      now += 5 * MINUTE;
      say(s, st, now - 45_000, 1);
      runLiveTick({ nowMs: now, mode: "steady" });
    }
    recordConsolidation(s, st, now);
    expect(liveCallsInWindow(now)).toBe(7);
    expect(budgetReport({ nowMs: now }).checks.find((c) => c.name === "steady_calls")).toMatchObject({
      actual: 7,
      budget: 12,
      met: true,
    });
  });

  it("fails the daily budget out loud when the ledger says it was blown", () => {
    const report = budgetReport({ nowMs: NOW, callsLast24h: 40 });
    expect(report.met).toBe(false);
    expect(report.checks.find((c) => c.name === "steady_calls")!.met).toBe(false);
  });

  it("scores first claim, spaces/tasks and the silent gap against their numbers", () => {
    const ok = budgetReport({
      nowMs: NOW,
      firstClaimMs: 22_000,
      spacesTasksMs: 96_000,
      silentGapMs: 61_000,
      callsLast24h: 8,
    });
    expect(ok.met).toBe(true);
    expect(ok.checks.map((c) => c.budget)).toEqual([30_000, 120_000, 90_000, 12]);

    const bad = budgetReport({ nowMs: NOW, firstClaimMs: 41_000, callsLast24h: 0 });
    expect(bad.checks[0]).toMatchObject({ name: "first_claim", met: false });
    expect(bad.met).toBe(false);
  });

  it("measures the silent gap with pauses removed — a countdown is not a stall", () => {
    const beats = [NOW + 30_000, NOW + 60_000, NOW + 200_000];
    expect(silentGapMs({ startedAtMs: NOW, nowMs: NOW + 200_000, beats })).toBe(140_000);
    expect(
      silentGapMs({
        startedAtMs: NOW,
        nowMs: NOW + 200_000,
        beats,
        pauses: [{ fromMs: NOW + 70_000, toMs: NOW + 170_000, reason: "quota" }],
      }),
    ).toBeLessThanOrEqual(LIVE_BUDGETS.silentGapMs);
  });
});
