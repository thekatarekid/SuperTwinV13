// ===========================================================================
// The `deps.extract` seam, wired — bootstrap.ts's last empty socket.
//
// cl1-runner.test.ts proves the stage against an INJECTED transport, and
// prompts/runner.accounting.test.ts proves the dual write against a synthetic
// P-CL1 spec. Neither exercises the thing the driver actually runs: the real
// `cl1ExtractStage()` seam, through the real `cl1RunnerInvoke` transport,
// through the real accounting write, against a real database. Three facts only
// this path can establish:
//
//   1. the seam WRITES. A bootstrap run that produces episodes and zero claims
//      is the defect the whole wiring exists to end;
//   2. one provider call is ONE `runs` row and ONE `extraction_runs` row —
//      joined on the run id, with the money in both, and with no `er:` mirror
//      row, which is what the two accounting directions meeting would leave
//      behind;
//   3. the number the seam hands back to `bootstrap.ts` is BILLED calls, not
//      invocations. The tick charges its whole extraction budget on it, and
//      P-CL1 is the dominant cost of the pipeline.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activeClaims } from "../claims/store.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { ensureMeEntity, setEventActorEntity } from "../entities/binding.js";
import { createEntity } from "../entities/registry.js";
import { ResourcePool } from "../providers/pool.js";
import type { Provider, ProviderErrorCode, Usage } from "../providers/types.js";
import { resetLegendCache } from "../prompts/legend.js";
import { resetPromptFilesForTests, type RunnerDeps } from "../prompts/runner.js";
import type { ExtractOutcome } from "./bootstrap.js";
import { cl1ExtractStage, runCl1ForEpisodes } from "./cl1-runner.js";
import type { Cohort } from "./cohorts.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const COHORT = "coh:bootstrap:d7:0";

let tmpDir: string;
let C1 = "";
let ME = "";
let ROHAN = "";

/** A realistic P-CL1 answer: one summary, one claim, one loop. */
const ANSWER = [
  "Y | e1 | Rohan raised the lease renewal. The user agreed to send the draft this week.",
  "F | 1 | a1 | ao | 0.90 |  | Rents a flat in Koramangala",
  "T | 2 | self | a1 | ex | i2t | m | w | 2026-08-20 | - | 0.80 | Send Rohan the lease draft",
].join("\n");

interface Turn {
  text?: string;
  code?: ProviderErrorCode;
}

/** One `send` per turn, in order — the shape prompts/runner's own tests use. */
function fakeProvider(turns: Turn[]): Provider {
  let n = 0;
  return {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      const turn = turns[n++] ?? { text: "" };
      const usage: Usage = {
        inputTokens: 100,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 300,
        outputTokens: 40,
        costUsd: 0.25,
      };
      if (turn.text !== undefined) opts.onEvent({ type: "delta", text: turn.text });
      if (turn.code) {
        opts.onEvent({ type: "error", code: turn.code, message: "provider said no" });
        opts.onEvent({ type: "done", sessionId: "s", usage });
        return { sessionId: "s", usage, freshFallback: false, status: "error", errorCode: turn.code };
      }
      opts.onEvent({ type: "done", sessionId: "s", usage });
      return { sessionId: "s", usage, freshFallback: false, status: "ok" };
    },
  };
}

/** A real transport with a fake provider and a clock the retry ladder cannot stall. */
function deps(turns: Turn[]): RunnerDeps {
  let t = 0;
  return {
    provider: fakeProvider(turns),
    pool: new ResourcePool({
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    }),
  };
}

/** One stream, one counterpart, one episode, one sealed session carrying it. */
function seed(): void {
  const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "rohan", displayName: "Rohan" });
  const stamp = new Date(NOW).toISOString();
  const eventIds = ["is the lease up for renewal?", "yes — I'll send the draft"].map((text, i) => {
    const eventId = insertEvent({
      externalId: `ep1-ev${i + 1}`,
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: C1,
      actorId: actor,
      ts: new Date(NOW - (2 - i) * 60_000).toISOString(),
      kind: "message",
      text,
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    }).id;
    setEventActorEntity(eventId, i % 2 === 0 ? ROHAN : ME);
    return eventId;
  });
  const db = getDb();
  db.prepare(
    `INSERT INTO episodes (id, stream_id, source_id, topic_label, label_source, session_ids,
                           event_ids, entity_ids, arc_state, started_at, ended_at)
     VALUES ('ep1', ?, 'whatsapp', 'Lease renewal', 'model', '[]', ?, ?, 'open', ?, ?)`,
  ).run(C1, JSON.stringify(eventIds), JSON.stringify([ME, ROHAN]), stamp, stamp);
  db.prepare(
    `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
     VALUES ('s1', ?, 'whatsapp', ?, ?, ?, 'sealed', 'h_s1')`,
  ).run(C1, stamp, stamp, JSON.stringify(eventIds));
  db.prepare(`INSERT INTO episode_sessions (episode_id, session_id, added_by) VALUES ('ep1', 's1', 'new')`).run();
  // A REAL cohort row: `runs.cohort_id` is a foreign key onto it, and a
  // sentinel id is the defect that lost the accounting row entirely.
  db.prepare(
    `INSERT INTO cohorts (id, mode, horizon, session_ids, state) VALUES (?, 'bootstrap', 'd7', '["s1"]', 'planned')`,
  ).run(COHORT);
}

/** Exactly the call `understandCohort` makes on the seam. */
function runSeam(turns: Turn[], budget = 8): Promise<ExtractOutcome> {
  return cl1ExtractStage({ deps: deps(turns) })({
    cohort: { id: COHORT, sessionIds: ["s1"] } as Cohort,
    sessionIds: ["s1"],
    budget,
    now: NOW,
  });
}

function rows<T>(sql: string): T[] {
  return getDb().prepare(sql).all() as T[];
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cl1-seam-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetLegendCache();
  resetPromptFilesForTests();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  C1 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Rohan", kind: "dm" });
  ME = ensureMeEntity();
  ROHAN = createEntity({ type: "person", canonical: "Rohan Mehta", provisional: false }).id;
  getDb()
    .prepare(`UPDATE streams SET participant_entity_ids = ?, tz = 'Asia/Kolkata' WHERE id = ?`)
    .run(JSON.stringify([ME, ROHAN]), C1);
  seed();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("the extract seam the driver fills", () => {
  it("turns a cohort's episodes into claims and evidence", async () => {
    const outcome = await runSeam([{ text: ANSWER }]);

    expect(outcome.calls).toBe(1);
    expect(outcome.errors).toEqual([]);
    // The rows the V2 surfaces read, which a live install shipped ZERO of.
    expect(activeClaims()).toHaveLength(1);
    expect(rows(`SELECT id FROM claim_versions`)).toHaveLength(1);
    expect(rows(`SELECT event_id FROM evidence WHERE episode_id = 'ep1'`).length).toBeGreaterThan(0);
    // Extracted once means extracted: the catch-up query stops offering it.
    expect(rows(`SELECT id FROM work_queue WHERE stage = 'extract' AND state = 'done'`)).toHaveLength(1);
  });

  it("says so loudly when the model never answers — never a silent zero", async () => {
    // The full ladder: every attempt times out, the unit is quarantined and the
    // transport hands back null. A run that wrote nothing because the provider
    // was down must not read like a run that found nothing.
    const outcome = await runSeam([{ code: "TIMEOUT" }, { code: "TIMEOUT" }, { code: "TIMEOUT" }, { code: "TIMEOUT" }]);

    expect(outcome.calls).toBeGreaterThan(0);
    // Handed BACK, not just logged: `understandCohort` puts each of these on
    // the tick's error list, which is what stops a claim-free cohort from
    // reading as a clean run.
    expect(outcome.errors?.join(" ")).toContain("TIMEOUT");
    expect(activeClaims()).toHaveLength(0);
    expect(rows(`SELECT id FROM quarantine`)).toHaveLength(1);
    // Not `done` — the queue keeps the work rather than losing it.
    expect(rows(`SELECT id FROM work_queue WHERE stage = 'extract' AND state = 'done'`)).toHaveLength(0);
  });
});

describe("the run-accounting invariant, on the wired path", () => {
  it("writes exactly one runs row and one extraction_runs row per provider call", async () => {
    await runSeam([{ text: ANSWER }]);

    const runs = rows<{ id: string; cohort_id: string | null; role: string; kind: string; cost_usd: number }>(
      `SELECT id, cohort_id, role, kind, cost_usd FROM runs`,
    );
    const log = rows<{ run_id: string; role: string | null; kind: string; cost_usd: number | null }>(
      `SELECT run_id, role, kind, cost_usd FROM extraction_runs`,
    );

    expect(runs).toHaveLength(1);
    expect(log).toHaveLength(1);
    // Joined on the run id — one call, walkable from either table.
    expect(log[0]!.run_id).toBe(runs[0]!.id);
    expect(runs[0]!.role).toBe("extract");
    expect(runs[0]!.kind).toBe("P-CL1");
    // The cohort is REAL, so the call is attributed to the import that bought it.
    expect(runs[0]!.cohort_id).toBe(COHORT);
    // The money is in both tables. $0 in Settings → Recent runs over a real
    // bill is exactly what the mirror closes.
    expect(runs[0]!.cost_usd).toBeCloseTo(0.25);
    expect(log[0]!.cost_usd).toBeCloseTo(0.25);
    // THE SINGULARITY CHECK. `db/index.ts logRun` mirrors the other way and
    // names its row `er:<rowid>`; one of those here would mean the two
    // directions met and every derivation call is now counted twice.
    expect(rows(`SELECT id FROM runs WHERE id LIKE 'er:%'`)).toHaveLength(0);
  });

  it("charges the driver for BILLED calls, not invocations — the retry is real money", async () => {
    // One logical invocation: round one fails, the ladder retries, round two
    // answers. Two provider calls, two rows in each table, and the seam must
    // report TWO to the wallet — a stage that reports one caps a 400-call run
    // at roughly half of what it pays.
    const outcome = await runSeam([{ code: "TIMEOUT" }, { text: ANSWER }]);

    expect(rows(`SELECT id FROM runs`)).toHaveLength(2);
    expect(rows(`SELECT id FROM extraction_runs`)).toHaveLength(2);
    expect(outcome.calls).toBe(2);
    expect(activeClaims()).toHaveLength(1);
  });

  it("refuses rather than overspends: a budget of one buys one call", async () => {
    const outcome = await runSeam([{ text: ANSWER }], 1);

    expect(outcome.calls).toBeLessThanOrEqual(1);
    expect(rows(`SELECT id FROM runs`).length).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// A wire violation quarantines a LINE, not an answer (G2)
//
// The defect this closes, measured on the user's own data: one paid tick
// returned a `T` line with a shifted field, the runner quarantined the unit
// (`bad_enum: stake=shr`, then `field_count: T expects 11 fields, got 10`
// after the repair round), and the transport read that status as "no answer".
// $0.32 bought a summary, a claim and a loop; the run wrote none of them.
//
// Only this path can prove the fix: cl1-runner.test.ts injects a transport and
// therefore never reaches the quarantine gate at all.
// ===========================================================================

/** Round 1 — a good summary, a good claim, and a `T` whose fields shifted. */
const SHIFTED = [
  "Y | e1 | Rohan raised the lease renewal. The user agreed to send the draft this week.",
  "F | 1 | a1 | ao | 0.90 |  | Rents a flat in Koramangala",
  "T | 2 | self | a1 | ex | i2t | shr | w | 2026-08-20 | - | 0.80 | Send Rohan the lease draft",
].join("\n");

/** The repair round: the model drops a field instead of fixing the enum. */
const STILL_SHORT = "T | 2 | self | a1 | ex | shr | w | 2026-08-20 | - | 0.80 | Send Rohan the lease draft";

describe("one malformed line does not void the answer that carried it", () => {
  it("applies the valid claim, quarantines only the bad loop line, and completes the unit", async () => {
    const outcome = await runSeam([{ text: SHIFTED }, { text: STILL_SHORT }]);

    // TWO provider calls: the answer, then the bounded repair round.
    expect(outcome.calls).toBe(2);
    // THE ROWS THE OLD PATH THREW AWAY.
    expect(activeClaims()).toHaveLength(1);
    expect(rows(`SELECT id FROM claim_versions`)).toHaveLength(1);
    expect(rows(`SELECT event_id FROM evidence WHERE episode_id = 'ep1'`).length).toBeGreaterThan(0);
    // The malformed line is still REJECTED — the fix isolates the blast radius,
    // it does not tolerate a bad line. No loop row was invented from it.
    expect(rows(`SELECT id FROM loops`)).toHaveLength(0);

    // VISIBILITY DOES NOT REGRESS: the quarantine row is exactly what it was,
    // with the model's own bytes named in it, replayable.
    const parked = rows<{ unit_id: string; error_code: string; last_error: string }>(
      `SELECT unit_id, error_code, last_error FROM quarantine`,
    );
    expect(parked).toHaveLength(1);
    expect(parked[0]!.unit_id).toBe("ep1");
    expect(parked[0]!.error_code).toBe("wire_violations");
    expect(parked[0]!.last_error).toContain("field_count");

    // A partial is not a failure: the claim is on disk, so re-buying the batch
    // would be paying twice for a row we already have.
    expect(outcome.errors ?? []).toEqual([]);
    expect(rows(`SELECT id FROM work_queue WHERE stage = 'extract' AND state = 'done'`)).toHaveLength(1);
  });

  it("still fails loudly when the WHOLE answer is unreadable", async () => {
    // Prose in both rounds: nothing was accepted, so there is nothing to
    // salvage and the batch must read as an error, never as "no claims".
    const outcome = await runSeam([
      { text: "I'm sorry, I can't help with that." },
      { text: "Really, I can't." },
    ]);

    expect(activeClaims()).toHaveLength(0);
    expect(outcome.errors?.join(" ")).toContain("no response");
    expect(rows(`SELECT id FROM quarantine`)).toHaveLength(1);
    // Not retired — the queue keeps the work rather than losing it.
    expect(rows(`SELECT id FROM work_queue WHERE stage = 'extract' AND state = 'done'`)).toHaveLength(0);
  });
});

describe("the counters a partially applied answer reports", () => {
  it("counts what was WRITTEN and what was QUARANTINED, and matches the row deltas", async () => {
    // The seam hands `bootstrap.ts` only calls + errors, so the full report is
    // taken here — a partial apply that reported a clean run would understate
    // the corpus exactly as silently as the discard it replaced.
    const report = await runCl1ForEpisodes(["ep1"], {
      now: NOW,
      cohortId: COHORT,
      deps: deps([{ text: SHIFTED }, { text: STILL_SHORT }]),
    });

    expect(report.partialAnswers).toBe(1);
    // One violation survived the repair round into the quarantine table.
    expect(report.quarantinedLines).toBe(1);
    // …and the re-parse sees BOTH rejected lines, round 1 and round 2. Every
    // line the model wrote is still accounted for somewhere.
    expect(report.violations).toBe(2);
    expect(report.errors).toEqual([]);
    // BILLED calls, not invocations: the repair round is real money.
    expect(report.calls).toBe(2);

    // The counters are the rows. Both directions — over- and under-stating
    // what is on disk have each shipped from this stage once already.
    expect(rows(`SELECT id FROM claim_versions`)).toHaveLength(report.claimsWritten);
    expect(rows(`SELECT rowid FROM evidence`)).toHaveLength(report.evidenceRows);
    expect(rows(`SELECT id FROM loops`)).toHaveLength(report.loopsWritten);
    expect(report.claimsWritten).toBe(1);
    expect(report.loopsWritten).toBe(0);
  });
});
