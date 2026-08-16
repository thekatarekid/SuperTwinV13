// ===========================================================================
// The P-CL1Δ session-delta runner — the consumer `SteadyDeps.extract` waited
// for. What is tested is the RUNNER and its wiring into the steady tick, not
// the prompt (prompts/p-cl1d.test.ts owns that) and not the write path
// (claims/write.test.ts owns that): that a fired pass reaches the disk end to
// end, that the wallet binds, that the A2-shaped provider refusal still
// happens BEFORE any cursor moves, that a re-run reinforces rather than
// forks, that an unusable answer is an error plus a retry ticket — never a
// quiet zero — and that the session-unit queue rows this runner consumes are
// invisible to the episode drain.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { activeClaims } from "../claims/store.js";
import { ensureMeEntity, setEventActorEntity } from "../entities/binding.js";
import { createEntity } from "../entities/registry.js";
import { buildCl1DeltaCall, cl1DeltaExtractStage, runCl1DeltaForSession } from "./cl1-delta.js";
import { drainExtractQueue, type AsyncPromptInvoke } from "./cl1-runner.js";
import { enqueueWork, peekWork, workId } from "./queue.js";
import { runSteadyTick, steadyDepsWithDefaults } from "./steady.js";

const SOURCE = "whatsapp";
const NOW = Date.parse("2026-08-16T12:00:00.000Z");
const MINUTE = 60_000;

let tmpDir: string;
let C1 = "";
let ME = "";
let ROHAN = "";
let seq = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cl1-delta-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  seq = 0;
  upsertSource({ id: SOURCE, type: SOURCE, name: "WhatsApp" });
  C1 = upsertStream({ sourceId: SOURCE, sourceExtId: "c1", name: "Rohan", kind: "dm" });
  ME = ensureMeEntity();
  ROHAN = createEntity({ type: "person", canonical: "Rohan Mehta", provisional: false }).id;
  const db = getDb();
  db.prepare(`UPDATE streams SET participant_entity_ids = ?, tz = 'Asia/Kolkata', tier = 'T1', tier_source = 'code' WHERE id = ?`).run(
    JSON.stringify([ME, ROHAN]),
    C1,
  );
  db.prepare(
    `INSERT INTO watermarks (stream_id, backfill_complete) VALUES (?, 1)
     ON CONFLICT(stream_id) DO UPDATE SET backfill_complete = 1`,
  ).run(C1);
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** An OPEN session on `streamId` — the live trigger's unit. */
function openSession(streamId: string = C1): string {
  seq += 1;
  const id = `delta-s${seq}`;
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
       VALUES (?, ?, ?, ?, ?, '[]', 'open', 'h0')`,
    )
    .run(id, streamId, SOURCE, new Date(NOW - 10 * MINUTE).toISOString(), new Date(NOW - 10 * MINUTE).toISOString());
  return id;
}

/** Append `n` bound messages to an open session, one second apart. */
function say(sessionId: string, atMs: number, n = 1, streamId: string = C1): string[] {
  const db = getDb();
  const actorId = upsertActor({ sourceId: SOURCE, sourceExtId: "rohan", displayName: "Rohan" });
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
    // Alternate the speaker so the window has both `self` and a roster alias.
    setEventActorEntity(res.id, i % 2 === 0 ? ROHAN : ME);
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

/** A realistic P-CL1Δ answer: one claim off the window's first ► event. */
function answerCiting(token: string): string {
  return `F | ${token} | a1 | ao | 0.90 |  | Rents a flat in Koramangala`;
}

function replay(text: string | null, seen: string[] = []): AsyncPromptInvoke {
  return async (prompt) => {
    seen.push(prompt.user);
    return text;
  };
}

function workState(sessionId: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT state FROM work_queue WHERE id = ?`)
    .get(workId("extract", "session", sessionId)) as { state: string } | undefined;
  return row?.state;
}

function deltaCursor(sessionId: string): { last_delta_at: string | null; delta_pass_count: number } {
  return getDb().prepare(`SELECT last_delta_at, delta_pass_count FROM sessions WHERE id = ?`).get(sessionId) as {
    last_delta_at: string | null;
    delta_pass_count: number;
  };
}

// ---------------------------------------------------------------------------

describe("buildCl1DeltaCall", () => {
  it("marks exactly the window's events ► and continues numbering past the prior ones", () => {
    const sessionId = openSession();
    say(sessionId, NOW - 8 * MINUTE, 2); // prior — already covered by a pass
    const fresh = say(sessionId, NOW - MINUTE, 1); // the delta window

    const call = buildCl1DeltaCall(sessionId, fresh);
    expect(call).not.toBeNull();
    // Summary mode (the default): the prior events spend tokens 1 and 2
    // without being printed, so the one ► line carries token 3.
    const marked = call!.prompt.user.split("\n").filter((l) => l.startsWith("► "));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("3 ");
    expect(call!.prompt.user).toContain("#R a1=Rohan Mehta");
  });

  it("lists what earlier passes already extracted, and maps the aliases to real ids", async () => {
    const sessionId = openSession();
    const first = say(sessionId, NOW - 8 * MINUTE, 2);
    await runCl1DeltaForSession(
      { sessionId, streamId: C1, eventIds: first, budget: 5, now: NOW },
      { invoke: replay(answerCiting("1")) },
    );
    const claim = activeClaims()[0]!;

    const fresh = say(sessionId, NOW - MINUTE, 1);
    const call = buildCl1DeltaCall(sessionId, fresh);
    expect(call!.prompt.user).toContain("EXTRACTED  H1 Rents a flat in Koramangala");
    expect(call!.prompt.itemIds["H1"]).toBe(claim.id);
  });

  it("refuses an empty window rather than build a pass with nothing to read", () => {
    const sessionId = openSession();
    say(sessionId, NOW - MINUTE, 2);
    expect(buildCl1DeltaCall(sessionId, [])).toBeNull();
    expect(buildCl1DeltaCall("no-such-session", ["ev1"])).toBeNull();
  });
});

describe("the fired pass, end to end through the steady tick", () => {
  it("extracts a claim from new session content and consumes the queue row", async () => {
    const sessionId = openSession();
    say(sessionId, NOW - 2 * MINUTE, 12);

    const seen: string[] = [];
    const report = await runSteadyTick({
      now: NOW,
      deps: { extract: cl1DeltaExtractStage({ invoke: replay(answerCiting("1"), seen) }) },
    });

    expect(report.mode).toBe("steady");
    expect(report.errors).toEqual([]);
    expect(report.live?.fired.map((f) => f.sessionId)).toEqual([sessionId]);
    expect(report.llmCallsSpent).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("► ");

    const claims = activeClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]!.text).toBe("Rents a flat in Koramangala");
    expect(claims[0]!.subjectId).toBe(ROHAN);
    // The row `runLiveTick` filed for this pass was claimed and retired HERE —
    // not left for the episode drain, which can no longer see session units.
    expect(workState(sessionId)).toBe("done");
    expect(deltaCursor(sessionId).delta_pass_count).toBe(1);
  });

  it("binds the wallet: the second fired pass is never bought past the cap", async () => {
    const other = upsertStream({ sourceId: SOURCE, sourceExtId: "c2", name: "Other", kind: "dm" });
    getDb()
      .prepare(`UPDATE streams SET participant_entity_ids = ?, tier = 'T1', tier_source = 'code' WHERE id = ?`)
      .run(JSON.stringify([ME, ROHAN]), other);
    getDb().prepare(`INSERT INTO watermarks (stream_id, backfill_complete) VALUES (?, 1)`).run(other);
    const a = openSession();
    const b = openSession(other);
    say(a, NOW - 2 * MINUTE, 12);
    say(b, NOW - 2 * MINUTE, 12, other);

    const seen: string[] = [];
    const report = await runSteadyTick({
      now: NOW,
      maxLlmCalls: 1,
      deps: { extract: cl1DeltaExtractStage({ invoke: replay(answerCiting("1"), seen) }) },
    });
    expect(report.live?.fired).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(report.llmCallsSpent).toBe(1);
    expect(report.stoppedBy).toBe("budget");
  });

  it("a zero budget buys nothing and leaves the pass resumable", async () => {
    const sessionId = openSession();
    const window = say(sessionId, NOW - 2 * MINUTE, 3);
    enqueueWork({ unitKind: "session", unitId: sessionId, stage: "extract", priority: 1 });
    let calls = 0;
    const report = await runCl1DeltaForSession(
      { sessionId, streamId: C1, eventIds: window, budget: 0, now: NOW },
      { invoke: async () => ((calls += 1), answerCiting("1")) },
    );
    expect(calls).toBe(0);
    expect(report.calls).toBe(0);
    expect(workState(sessionId)).toBe("ready");
  });
});

describe("the A2-shaped refusal — before any cursor moves", () => {
  it("refuses a due pass when the default runner's provider is unregistered", async () => {
    const sessionId = openSession();
    say(sessionId, NOW - 2 * MINUTE, 12);

    // The exact deps `startSteadyDriver` would run with: the real runner-backed
    // stage, and the provider-registry readiness check beside it. No provider
    // is registered in this process, so the tick must refuse — loudly, and
    // without advancing the delta cursor it could never extract behind.
    const report = await runSteadyTick({ now: NOW, deps: steadyDepsWithDefaults() });
    expect(report.stoppedBy).toBe("provider_outage");
    expect(report.errors.join(" ")).toContain("is not registered");
    expect(report.live).toBeNull();
    expect(deltaCursor(sessionId)).toEqual({ last_delta_at: null, delta_pass_count: 0 });
    expect(peekWork({ stages: ["extract"], limit: 5 })).toHaveLength(0);
  });

  it("does not second-guess an injected runner with the registry check", () => {
    const deps = steadyDepsWithDefaults({ extract: () => ({ calls: 0, errors: [] }) });
    expect(deps.extractReady).toBeUndefined();
  });
});

describe("idempotence and failure", () => {
  it("re-running the same window reinforces and never forks", async () => {
    const sessionId = openSession();
    const window = say(sessionId, NOW - 2 * MINUTE, 3);
    const input = { sessionId, streamId: C1, eventIds: window, budget: 5, now: NOW };

    const first = await runCl1DeltaForSession(input, { invoke: replay(answerCiting("1")) });
    expect(first.claimsWritten).toBe(1);
    const second = await runCl1DeltaForSession(input, { invoke: replay(answerCiting("1")) });
    expect(second.claimsWritten).toBe(0);
    expect(second.claimsReinforced).toBe(1);
    expect(second.errors).toEqual([]);
    expect(activeClaims()).toHaveLength(1);
  });

  it("reports an unusable answer as an error and puts the queue row back", async () => {
    const sessionId = openSession();
    const window = say(sessionId, NOW - 2 * MINUTE, 3);
    enqueueWork({ unitKind: "session", unitId: sessionId, stage: "extract", priority: 1 });

    const report = await runCl1DeltaForSession(
      { sessionId, streamId: C1, eventIds: window, budget: 5, now: NOW },
      { invoke: replay("I'm sorry, I can't help with that.") },
    );
    expect(report.claimsWritten).toBe(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("unparseable");
    // A retry ticket, not done and not lost: the answer was paid for and
    // unusable, so the pass goes back on a backoff.
    expect(workState(sessionId)).toBe("ready");
  });

  it("counts Z update lines rather than dropping them silently", async () => {
    const sessionId = openSession();
    const first = say(sessionId, NOW - 8 * MINUTE, 2);
    await runCl1DeltaForSession(
      { sessionId, streamId: C1, eventIds: first, budget: 5, now: NOW },
      { invoke: replay(answerCiting("1")) },
    );

    const fresh = say(sessionId, NOW - MINUTE, 1);
    const report = await runCl1DeltaForSession(
      { sessionId, streamId: C1, eventIds: fresh, budget: 5, now: NOW },
      {
        invoke: replay(
          ["Z | H1 | ctr | 3 | moved to Indiranagar", "F | 3 | a1 | ao | 0.90 |  | Rents a flat in Indiranagar"].join(
            "\n",
          ),
        ),
      },
    );
    expect(report.errors).toEqual([]);
    expect(report.updates).toBe(1);
    // The corrected fact arrives as a fresh H line and is written through the
    // ordinary path — which is why an unapplied Z is a gap, not a loss.
    expect(report.claimsWritten).toBe(1);
  });
});

describe("the queue boundary", () => {
  it("session extract rows wait for this runner — the episode drain cannot see them", async () => {
    const sessionId = openSession();
    const window = say(sessionId, NOW - 2 * MINUTE, 3);
    enqueueWork({ unitKind: "session", unitId: sessionId, stage: "extract", priority: 99 });

    // The episode drain claims nothing: the session unit is not its kind, so
    // its id can never be retried forever as a phantom episode.
    const drained = await drainExtractQueue({
      now: NOW,
      invoke: async () => {
        throw new Error("the episode drain must not buy a call for a session unit");
      },
    });
    expect(drained.episodes).toBe(0);
    expect(workState(sessionId)).toBe("ready");

    // …and this runner is the consumer that retires it.
    await runCl1DeltaForSession(
      { sessionId, streamId: C1, eventIds: window, budget: 5, now: NOW },
      { invoke: replay(answerCiting("1")) },
    );
    expect(workState(sessionId)).toBe("done");
  });
});
