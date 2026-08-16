// ===========================================================================
// The steady-state driver over a real DB (arch §8.1 exit, §8.3, §9.4 Lane E).
//
// Five defects this file exists to keep out:
//   * a flip that runs twice, or one that a restart forgets — `sources.mode`
//     is written once, on the settled edge, and read back from the DB;
//   * an `enrich` lane-entry row that no production code ever claims — the
//     defect the whole drain exists to end — or one that spins on media the
//     media lane has not read yet;
//   * a fired delta pass whose cursor advances with NO consumer wired — a
//     silently unread message dressed up as progress;
//   * a steady tick that spends past its wallet;
//   * a tick that did nothing and does not say why.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateGet, insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import type { Tier } from "../tiers/priority.js";
import { enqueueWork, peekWork, workId } from "./queue.js";
import {
  drainEnrichQueue,
  flipToSteadyIfSettled,
  getSourcesMode,
  runSteadyTick,
  ENRICH_WAIT_MS,
  SOURCES_MODE_KEY,
} from "./steady.js";

const SOURCE = "whatsapp";
const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const MINUTE = 60_000;

let tmpDir: string;
let seq = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-sched-steady-"));
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

/** A tiered stream whose watermark says the backfill finished. */
function settledStream(ext: string, tier: Tier = "T1"): string {
  const id = upsertStream({ sourceId: SOURCE, sourceExtId: ext, name: ext, kind: "dm" });
  const db = getDb();
  db.prepare(`UPDATE streams SET tier = ?, tier_source = 'code' WHERE id = ?`).run(tier, id);
  db.prepare(
    `INSERT INTO watermarks (stream_id, backfill_complete) VALUES (?, 1)
     ON CONFLICT(stream_id) DO UPDATE SET backfill_complete = 1`,
  ).run(id);
  return id;
}

/** An OPEN session on `streamId` — the live trigger's unit. */
function openSession(streamId: string, startedAtMs: number): string {
  seq += 1;
  const id = `steady-s${seq}`;
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
       VALUES (?, ?, ?, ?, ?, '[]', 'open', 'h0')`,
    )
    .run(id, streamId, SOURCE, new Date(startedAtMs).toISOString(), new Date(startedAtMs).toISOString());
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

/** One bare event on the stream, for the enrich-lane tests. */
function bareEvent(streamId: string, atMs: number, kind = "message"): string {
  seq += 1;
  const res = insertEvent({
    externalId: `bare/${seq}`,
    sourceId: SOURCE,
    sourceType: SOURCE,
    streamId,
    actorId: upsertActor({ sourceId: SOURCE, sourceExtId: "peer", displayName: "peer" }),
    ts: new Date(atMs).toISOString(),
    kind: "message",
    text: kind === "message" ? `text ${seq}` : "",
    mediaPath: null,
    rawJson: null,
    isHistorical: false,
  });
  if (kind !== "message") getDb().prepare(`UPDATE events SET kind = ? WHERE id = ?`).run(kind, res.id);
  return res.id;
}

function enqueueEnrich(eventId: string): string {
  enqueueWork({ unitKind: "event", unitId: eventId, stage: "enrich", priority: 1 });
  return workId("enrich", "event", eventId);
}

function workState(id: string): string | undefined {
  const row = getDb().prepare(`SELECT state FROM work_queue WHERE id = ?`).get(id) as
    | { state: string }
    | undefined;
  return row?.state;
}

// ---------------------------------------------------------------------------

describe("the bootstrap -> steady flip (§8.1 exit condition)", () => {
  it("flips exactly once when settled, and the flip survives a restart", async () => {
    settledStream("dm-a");
    expect(getSourcesMode()).toBe("bootstrap");

    const first = await runSteadyTick({ now: NOW });
    expect(first.mode).toBe("steady");
    expect(first.flipped).toBe(true);
    expect(appStateGet(SOURCES_MODE_KEY)).toBe("steady");

    // Second tick: already steady, no second flip — and the settled conditions
    // are not even re-read, so un-settling the watermark cannot regress it.
    getDb().prepare(`UPDATE watermarks SET backfill_complete = 0`).run();
    const second = await runSteadyTick({ now: NOW + MINUTE });
    expect(second.mode).toBe("steady");
    expect(second.flipped).toBe(false);

    // A restart lands on the stored row, not on this process's memory.
    closeDb();
    runMigrations();
    expect(getSourcesMode()).toBe("steady");
    expect(flipToSteadyIfSettled(NOW + 2 * MINUTE)).toEqual({ mode: "steady", flipped: false, checked: null });
  });

  it("stays in bootstrap while any condition holds out, and says why", async () => {
    const streamId = upsertStream({ sourceId: SOURCE, sourceExtId: "dm-b", name: "dm-b", kind: "dm" });
    getDb().prepare(`UPDATE streams SET tier = 'T1', tier_source = 'code' WHERE id = ?`).run(streamId);
    getDb().prepare(`INSERT INTO watermarks (stream_id, backfill_complete) VALUES (?, 0)`).run(streamId);

    const report = await runSteadyTick({ now: NOW });
    expect(report.mode).toBe("bootstrap");
    expect(report.flipped).toBe(false);
    expect(report.live).toBeNull();
    expect(report.stoppedBy).toBe("no_work");
    expect(appStateGet(SOURCES_MODE_KEY)).toBeNull();

    const flip = flipToSteadyIfSettled(NOW);
    expect(flip.checked?.backfillComplete).toBe(false);
  });
});

describe("the enrich lane-entry drain (§9.4 Lane E) — free, unconditional", () => {
  it("retires resolved rows, parks pending media, and never re-claims done rows", async () => {
    const streamId = settledStream("dm-c");
    const textId = enqueueEnrich(bareEvent(streamId, NOW - MINUTE));
    const imageEvent = bareEvent(streamId, NOW - MINUTE, "image");
    const imageId = enqueueEnrich(imageEvent);

    // Runs in bootstrap mode too — the drain is not gated behind the flip.
    getDb().prepare(`UPDATE watermarks SET backfill_complete = 0`).run();
    const first = await runSteadyTick({ now: NOW });
    expect(first.mode).toBe("bootstrap");
    expect(first.enrich?.claimed).toBe(2);
    expect(first.enrich?.completed).toBe(1); // text: none_needed
    expect(first.enrich?.waiting).toBe(1); // image: caption not attempted yet
    expect(first.enrich?.llmCalls).toBe(0);
    expect(workState(textId)).toBe("done");
    expect(workState(imageId)).toBe("paused");

    // Idempotent: the done row stays done, the parked row stays parked until
    // its wait expires — a tick in between claims nothing.
    const second = await runSteadyTick({ now: NOW + MINUTE });
    expect(second.enrich?.claimed).toBe(0);

    // The caption lands; the wait expires; the row resumes and retires.
    getDb().prepare(`UPDATE events SET media_desc_status = 'done', media_description = 'a cat' WHERE id = ?`).run(imageEvent);
    const third = await runSteadyTick({ now: NOW + ENRICH_WAIT_MS + MINUTE });
    expect(third.resumed).toBe(1);
    expect(third.enrich?.completed).toBe(1);
    expect(workState(imageId)).toBe("done");
  });

  it("retires the row of an event that no longer exists", () => {
    const id = enqueueEnrich("no-such-event");
    const report = drainEnrichQueue({ now: NOW });
    expect(report.missing).toBe(1);
    expect(workState(id)).toBe("done");
  });
});

describe("the live path in steady mode (§8.3)", () => {
  it("processes a new event end-to-end through the extraction seam, once", async () => {
    const streamId = settledStream("dm-d");
    const sessionId = openSession(streamId, NOW - 5 * MINUTE);
    const eventIds = say(sessionId, streamId, NOW - 2 * MINUTE, 12);

    const seen: { sessionId: string; eventIds: readonly string[] }[] = [];
    const first = await runSteadyTick({
      now: NOW,
      deps: { extract: (input) => (seen.push(input), { calls: 1, errors: [] }) },
    });
    expect(first.mode).toBe("steady");
    expect(first.live?.fired.map((f) => f.sessionId)).toEqual([sessionId]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.eventIds).toEqual(eventIds);
    expect(first.llmCallsSpent).toBe(1);
    expect(first.stoppedBy).toBeNull();

    // The commit advanced the cursor and enqueued the extract work row.
    const row = getDb().prepare(`SELECT last_delta_at, delta_pass_count FROM sessions WHERE id = ?`).get(sessionId) as {
      last_delta_at: string | null;
      delta_pass_count: number;
    };
    expect(row.delta_pass_count).toBe(1);
    expect(row.last_delta_at).not.toBeNull();
    expect(peekWork({ stages: ["extract"], unitKinds: ["session"], limit: 5 }).map((w) => w.unitId)).toEqual([
      sessionId,
    ]);

    // Nothing new to say: the next tick holds and the seam is not re-bought.
    const second = await runSteadyTick({
      now: NOW + MINUTE,
      deps: { extract: () => ({ calls: 1, errors: [] }) },
    });
    expect(second.live?.fired).toHaveLength(0);
    expect(second.llmCallsSpent).toBe(0);
  });

  it("binds the wallet: past the cap the tick stops and says budget", async () => {
    const streamId = settledStream("dm-e");
    const other = settledStream("dm-f");
    const a = openSession(streamId, NOW - 5 * MINUTE);
    const b = openSession(other, NOW - 5 * MINUTE);
    say(a, streamId, NOW - 2 * MINUTE, 12);
    say(b, other, NOW - 2 * MINUTE, 12);

    let calls = 0;
    const report = await runSteadyTick({
      now: NOW,
      maxLlmCalls: 1,
      deps: { extract: () => (calls += 1, { calls: 1, errors: [] }) },
    });
    expect(report.live?.fired).toHaveLength(2);
    expect(calls).toBe(1);
    expect(report.llmCallsSpent).toBe(1);
    expect(report.stoppedBy).toBe("budget");
  });

  it("refuses to fire with no extraction consumer wired — loud, and no cursor moves", async () => {
    const streamId = settledStream("dm-g");
    const sessionId = openSession(streamId, NOW - 5 * MINUTE);
    say(sessionId, streamId, NOW - 2 * MINUTE, 12);

    const report = await runSteadyTick({ now: NOW });
    expect(report.stoppedBy).toBe("provider_outage");
    expect(report.errors.join(" ")).toMatch(/P-CL1Δ|extraction runner/);
    expect(report.live).toBeNull();

    // Nothing moved: the session is still due, nothing was enqueued, and the
    // delta window was not marked covered.
    const row = getDb().prepare(`SELECT last_delta_at, delta_pass_count FROM sessions WHERE id = ?`).get(sessionId) as {
      last_delta_at: string | null;
      delta_pass_count: number;
    };
    expect(row.last_delta_at).toBeNull();
    expect(row.delta_pass_count).toBe(0);
    expect(peekWork({ stages: ["extract"], limit: 5 })).toHaveLength(0);
  });

  it("reports extraction failures on the tick, not only on the stage's own log", async () => {
    const streamId = settledStream("dm-h");
    const sessionId = openSession(streamId, NOW - 5 * MINUTE);
    say(sessionId, streamId, NOW - 2 * MINUTE, 12);

    const report = await runSteadyTick({
      now: NOW,
      deps: { extract: () => ({ calls: 2, errors: ["TIMEOUT: provider said no"] }) },
    });
    expect(report.llmCallsSpent).toBe(2);
    expect(report.errors.join(" ")).toContain("TIMEOUT: provider said no");
    expect(report.errors.join(" ")).toContain(sessionId);
  });
});
