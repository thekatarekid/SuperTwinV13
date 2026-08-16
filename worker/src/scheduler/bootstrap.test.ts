// ===========================================================================
// The bootstrap derivation driver — the caller the pipeline never had.
//
// What is tested here is the DRIVING, not the stages (tiers/, sessions/,
// cohorts and reconcile own their own suites): that a dry run reports real
// outstanding work and writes nothing, that a bounded run is idempotent when
// it is repeated, that an interruption mid-cohort leaves resumable state, and
// that the hard call cap is what stops a run rather than good intentions.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateSet, importDoneKey, insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { noteBackfillEvent, readWatermark } from "../db/watermarks.js";
import {
  bootstrapSettled,
  planBootstrap,
  resolveBootstrapMode,
  resolveBootstrapModeDetailed,
  runBootstrapTick,
  startBootstrapDriver,
  BOOTSTRAP_MODE_KEY,
} from "./bootstrap.js";
import { pendingCohorts, readCohort, resumeCohorts } from "./cohorts.js";
import { meEntityId } from "../entities/binding.js";
import type { AsyncEp2Invoke } from "./episode-pass.js";

const SOURCE = "whatsapp";
const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-bootstrap-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  delete process.env.SUPERTWIN_BOOTSTRAP;
  closeDb();
  runMigrations();
  upsertSource({ id: SOURCE, type: SOURCE, name: "WhatsApp" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_BOOTSTRAP;
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * One stream with `clusters` bursts of four messages, each burst separated by
 * more than the 6h conversation gap — so the walk cuts a session per burst and
 * every one of them is old enough for the seal.
 */
function stream(ext: string, clusters = 2): string {
  const id = upsertStream({ sourceId: SOURCE, sourceExtId: ext, name: ext, kind: "dm" });
  const actor = upsertActor({ sourceId: SOURCE, sourceExtId: `${ext}-them`, displayName: ext });
  for (let c = 0; c < clusters; c += 1) {
    const base = NOW - 3 * DAY + c * 12 * HOUR;
    for (let i = 0; i < 4; i += 1) {
      const ts = new Date(base + i * 60_000).toISOString();
      insertEvent({
        externalId: `${ext}-${c}-${i}`,
        sourceId: SOURCE,
        sourceType: SOURCE,
        streamId: id,
        actorId: actor,
        ts,
        kind: "message",
        text: `message ${c}.${i} in ${ext}`,
        mediaPath: null,
        rawJson: null,
        isHistorical: true,
      });
      noteBackfillEvent(id, ts);
    }
  }
  return id;
}

function count(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * A P-EP2 transport that ANSWERS: one `G` line per `#S` block, every event of
 * the block in one new episode.
 *
 * `async () => null` is NOT a stand-in for this. Null is what a total provider
 * outage looks like, the engine turns it into a `one_to_one_fallback` verdict
 * no model ever saw, and the driver now (rightly) refuses to mark a cohort
 * `done` on the back of one — so a test that wants a healthy run has to
 * produce a healthy answer.
 */
function answeringInvoke(counter?: { calls: number }): AsyncEp2Invoke {
  return async (prompt) => {
    if (counter) counter.calls += 1;
    const lines: string[] = [];
    for (const [, token, n] of prompt.user.matchAll(/^#S (\S+) \| \S+ \| (\d+) events$/gm)) {
      const events = Array.from({ length: Number(n) }, (_, i) => i + 1).join(",");
      lines.push(`G|${token}|${events}|new|-|0.9|bootstrap test episode`);
    }
    return lines.join("\n");
  };
}

function tiers(): (string | null)[] {
  return (getDb().prepare(`SELECT tier FROM streams ORDER BY id`).all() as { tier: string | null }[]).map(
    (r) => r.tier,
  );
}

describe("planBootstrap", () => {
  it("reports the work that is outstanding and writes nothing", () => {
    stream("alpha");
    stream("bravo");

    const plan = planBootstrap({}, { now: NOW });

    expect(plan.streamsWithoutTier).toBe(2);
    expect(plan.sessionsProjected).toBeGreaterThanOrEqual(4);
    expect(plan.cohortsProjected).toBeGreaterThanOrEqual(1);
    // Nothing here is a business channel, so the P-TI1 batch is empty.
    expect(plan.llmCallsProjected.ti1).toBe(0);
    expect(plan.billableTokensProjected).toBeGreaterThan(0);

    expect(count("sessions")).toBe(0);
    expect(count("cohorts")).toBe(0);
    expect(tiers()).toEqual([null, null]);
  });

  it("projects the SLICE it would run, not the whole corpus", () => {
    for (const ext of ["a", "b", "c", "d", "e", "f"]) stream(ext);

    const all = planBootstrap({}, { now: NOW });
    const slice = planBootstrap({ maxStreams: 2, maxSessions: 3 }, { now: NOW });

    expect(slice.sessionsProjected).toBe(3);
    expect(slice.sessionsProjected).toBeLessThan(all.sessionsProjected);
  });
});

describe("runBootstrapTick — dry", () => {
  it("buys nothing and writes nothing", async () => {
    stream("alpha");
    let calls = 0;

    const report = await runBootstrapTick({
      mode: "dry",
      now: NOW,
      deps: {
        invoke: async () => {
          calls += 1;
          return null;
        },
      },
    });

    expect(calls).toBe(0);
    expect(report.llmCallsSpent).toBe(0);
    expect(report.sessionsProjected).toBeGreaterThan(0);
    expect(report.sessionsSealed).toBe(0);
    expect(report.errors).toEqual([]);
    expect(count("sessions")).toBe(0);
    expect(count("cohorts")).toBe(0);
    expect(tiers()).toEqual([null]);
  });
});

describe("runBootstrapTick — off", () => {
  it("does every free stage — repair, tiers — and spends nothing, writes no session", async () => {
    stream("alpha");
    appStateSet(importDoneKey(SOURCE), "true");
    const streamId = (getDb().prepare(`SELECT id FROM streams`).get() as { id: string }).id;
    expect(readWatermark(streamId)?.backfill_complete).toBe(false);

    const report = await runBootstrapTick({ mode: "off", now: NOW });

    expect(report.backfillFlagsRepaired).toBe(1);
    expect(readWatermark(streamId)?.backfill_complete).toBe(true);
    // R2: tiering is free and no longer gated behind the mode — a stream must
    // never sit at tier NULL just because nobody opted into spending.
    expect(tiers()).not.toContain(null);
    // The paid ladder stays firmly off: no sessions, no cohorts, no calls.
    expect(count("sessions")).toBe(0);
    expect(count("cohorts")).toBe(0);
    expect(report.llmCallsSpent).toBe(0);
    // Sticky and idempotent: a second pass finds nothing left to repair.
    expect((await runBootstrapTick({ mode: "off", now: NOW })).backfillFlagsRepaired).toBe(0);
  });
});

describe("runBootstrapTick — slice", () => {
  it("tiers, seals, cohorts and reconciles in one pass", async () => {
    stream("alpha");
    stream("bravo");

    const report = await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });

    expect(report.errors).toEqual([]);
    expect(report.tier?.coverage).toBe(1);
    expect(tiers()).toEqual(["T1", "T1"]);
    expect(report.sessionsSealed).toBeGreaterThanOrEqual(4);
    expect(count("sessions")).toBe(report.sessionsSealed);
    expect(report.cohortsDone.length).toBeGreaterThanOrEqual(1);
    expect(readCohort(report.cohortsDone[0]!)?.state).toBe("done");
    // Coverage is written on EVERY transition, so a finished cohort has rows.
    expect(count("coverage")).toBeGreaterThan(0);
  });

  it("is idempotent when it is repeated", async () => {
    stream("alpha");
    stream("bravo");

    const first = await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });
    const sessions = count("sessions");
    const cohorts = count("cohorts");
    const episodes = count("episodes");

    const second = await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });

    expect(second.errors).toEqual([]);
    expect(second.sessionsSealed).toBe(0);
    expect(second.stoppedBy).toBe("no_work");
    expect(count("sessions")).toBe(sessions);
    expect(count("cohorts")).toBe(cohorts);
    expect(count("episodes")).toBe(episodes);
    expect(first.cohortsDone.length).toBeGreaterThan(0);
    expect(second.cohortsDone).toEqual([]);
  });

  it("respects the stream and session slice limits", async () => {
    for (const ext of ["a", "b", "c", "d", "e", "f"]) stream(ext);

    const report = await runBootstrapTick({
      mode: "slice",
      now: NOW,
      limits: { maxStreams: 2, maxSessions: 3, maxCohorts: 1 },
      deps: { invoke: answeringInvoke() },
    });

    expect(report.sessionsSealed).toBe(3);
    expect(count("sessions")).toBe(3);
    expect(report.cohortsDone.length).toBeLessThanOrEqual(1);
  });
});

describe("the call budget", () => {
  it("pauses the cohort instead of overspending, and resumes it later", async () => {
    stream("alpha");
    stream("bravo");

    // Zero model calls allowed: the sessions still seal (no model is involved
    // in the walk), and the cohort parks at the understanding rung.
    const broke = await runBootstrapTick({ mode: "slice", now: NOW, limits: { maxLlmCalls: 0 } });

    expect(broke.stoppedBy).toBe("budget");
    expect(broke.llmCallsSpent).toBe(0);
    expect(broke.sessionsSealed).toBeGreaterThan(0);
    expect(broke.cohortsDone).toEqual([]);

    const parked = pendingCohorts();
    expect(parked).toHaveLength(1);
    expect(parked[0]!.state).toBe("paused");
    expect(resumeCohorts().map((r) => r.id)).toEqual([parked[0]!.id]);

    // The opt-in run picks the SAME cohort up off the DB — no in-memory
    // position survived, and none was needed.
    const resumed = await runBootstrapTick({
      mode: "slice",
      now: NOW,
      limits: { maxLlmCalls: 10 },
      deps: { invoke: answeringInvoke() },
    });

    expect(resumed.errors).toEqual([]);
    expect(resumed.cohortsDone).toEqual([parked[0]!.id]);
    expect(readCohort(parked[0]!.id)?.state).toBe("done");
  });

  it("charges an injected extraction runner to the same wallet", async () => {
    stream("alpha");
    stream("bravo");

    let extractCalls = 0;
    const report = await runBootstrapTick({
      mode: "slice",
      now: NOW,
      limits: { maxLlmCalls: 2, maxCohorts: 4 },
      deps: {
        invoke: answeringInvoke(),
        extract: ({ budget }) => {
          extractCalls += 1;
          expect(budget).toBeGreaterThan(0);
          return 2; // spends the whole cap on the first cohort
        },
      },
    });

    expect(extractCalls).toBe(1);
    expect(report.llmCallsSpent).toBe(2);
    // Whatever came after it is parked, not silently skipped.
    for (const cohort of pendingCohorts()) expect(cohort.state).toBe("paused");
  });

  it("puts the extraction runner's failures on the TICK's error list", async () => {
    stream("alpha");

    // The production stage (`cl1ExtractStage`) reports an `ExtractOutcome`, not
    // a bare number, for exactly this reason: a cohort whose every P-CL1 call
    // died spends money, writes no claims and — if the failures stay on the
    // stage's own log line — reports a perfectly clean tick.
    const report = await runBootstrapTick({
      mode: "slice",
      now: NOW,
      limits: { maxLlmCalls: 6, maxCohorts: 1 },
      deps: {
        invoke: answeringInvoke(),
        extract: () => ({ calls: 2, errors: ["TIMEOUT: provider said no", "no response for ep1"] }),
      },
    });

    // The money it burned is still charged — a failed call is a paid call.
    expect(report.llmCallsSpent).toBeGreaterThanOrEqual(2);
    expect(report.errors.join(" ")).toContain("TIMEOUT: provider said no");
    expect(report.errors.join(" ")).toContain("no response for ep1");
    // Named by stage, like every other failure the tick reports.
    expect(report.errors.some((e) => e.includes("extract"))).toBe(true);
  });
});

// ===========================================================================
// A provider outage must be IMPOSSIBLE TO MISS.
//
// This is the failure that shipped: `register(claudeLocalProvider)` lives in
// index.ts's main(), a driver started any other way had an empty registry,
// all four P-EP2 calls failed with SPAWN_FAILED, the engine absorbed each null
// as its safe 1:1 fallback — and the tick returned `errors: []`,
// `stoppedBy: null`, `llmCallsSpent: 1`, with the cohort marked `done` and
// coverage written over verdicts no model had ever seen.
// ===========================================================================
describe("a provider outage", () => {
  it("refuses to start when the provider is not registered, before spending anything", async () => {
    stream("alpha");

    // No `deps.invoke`: this run would go through the registry, and the
    // registry is empty (main() is what fills it).
    const report = await runBootstrapTick({ mode: "slice", now: NOW });

    expect(report.stoppedBy).toBe("provider_outage");
    expect(report.errors.join("\n")).toContain("is not registered");
    // It stopped BEFORE the first stage: nothing derived, nothing spent.
    expect(report.llmCallsSpent).toBe(0);
    expect(report.sessionsSealed).toBe(0);
    expect(report.cohortsDone).toEqual([]);
    expect(count("cohorts")).toBe(0);
  });

  it("reports model-free verdicts and refuses to mark the cohort done", async () => {
    stream("alpha");
    stream("bravo");

    // `null` on every call is exactly what a total outage looks like from the
    // driver's side, whatever caused it.
    const report = await runBootstrapTick({
      mode: "slice",
      now: NOW,
      deps: { invoke: async () => null },
    });

    expect(report.stoppedBy).toBe("provider_outage");
    expect(report.fallbackVerdicts).toBeGreaterThan(0);
    expect(report.errors.join("\n")).toContain("MODEL-FREE");
    // The cohort is parked, NOT done. Coverage moves on every transition by
    // design, so what matters is that the `done` transition never happened:
    // nothing downstream gets to read these verdicts as finished work.
    expect(report.cohortsDone).toEqual([]);
    const parked = pendingCohorts();
    expect(parked).toHaveLength(1);
    expect(parked[0]!.state).toBe("paused");
    expect(count("cohorts")).toBe(1);
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM cohorts WHERE state = 'done'`).get() as { n: number }).n,
    ).toBe(0);

    // And the DB tells the two kinds of verdict apart, so the fallbacks can be
    // found and re-judged later rather than passing as ordinary answers.
    const decisions = getDb()
      .prepare(`SELECT decision, COUNT(*) AS n FROM episode_verdicts GROUP BY decision`)
      .all() as { decision: string; n: number }[];
    expect(decisions.some((d) => d.decision === "one_to_one_fallback" && d.n > 0)).toBe(true);
  });

  it("a healthy answer on the same corpus completes normally — the outage is what stops it", async () => {
    stream("alpha");
    stream("bravo");

    const report = await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });

    expect(report.fallbackVerdicts).toBe(0);
    expect(report.stoppedBy).not.toBe("provider_outage");
    expect(report.cohortsDone.length).toBeGreaterThanOrEqual(1);
  });

  it("the next healthy tick RE-JUDGES the outage's fallback verdicts (stage C3)", async () => {
    stream("alpha");

    // Tick 1: total outage — every verdict is the engine's model-free 1:1.
    const outage = await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: async () => null } });
    expect(outage.fallbackVerdicts).toBeGreaterThan(0);
    const fallbacks = (): number =>
      (
        getDb()
          .prepare(`SELECT COUNT(*) AS n FROM episode_verdicts v
                     WHERE v.decision = 'one_to_one_fallback'
                       AND NOT EXISTS (SELECT 1 FROM episode_verdicts w
                                        WHERE w.session_id = v.session_id AND w.rowid > v.rowid)`)
          .get() as { n: number }
      ).n;
    expect(fallbacks()).toBeGreaterThan(0);

    // Tick 2: the provider is back. C3 retracts the fallbacks and buys the
    // real judgement — a paused cohort's `unjudged` check alone would never
    // have revisited them, because a fallback IS a persisted verdict.
    const healthy = await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });
    expect(healthy.fallbackVerdicts).toBe(0);
    expect(fallbacks()).toBe(0);
    expect(healthy.llmCallsSpent).toBeGreaterThan(0);

    // And the hearing is not a loop: a third tick finds nothing to retract.
    const third = await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });
    expect(third.fallbackVerdicts).toBe(0);
  });
});

// ===========================================================================
// THE IDENTITY STAGE, AND THE ORDER IT RUNS IN.
//
// The bug this closes was not a crash. `tiers/rescan.ts` filed 3,141 rows at
// stage `entity`, nothing drained them, `entities` stayed empty — and P-CL1
// was handed an EMPTY participant roster, which does not fail: it makes the
// model guess, and it guessed the counterparty's words onto the user as
// first-person claims. So what is asserted here is ORDERING, not just that the
// stage ran: bound BEFORE the walk (participants are entity ids, and a sealed
// session's membership is immutable) and bound BEFORE extract (the roster).
// ===========================================================================
const SELF_JID = "919000000001@s.whatsapp.net";

/** The self jid the daemon persists at pairing — what `bindSelfIdentities` reads. */
function pairSelf(): void {
  appStateSet(`source.${SOURCE}.self_identity`, SELF_JID);
}

/** One stream where BOTH sides speak: `me` and one counterparty, alternating. */
function twoSidedStream(ext: string): string {
  const id = upsertStream({ sourceId: SOURCE, sourceExtId: ext, name: ext, kind: "dm" });
  const them = upsertActor({ sourceId: SOURCE, sourceExtId: `9199${ext}@s.whatsapp.net`, displayName: ext });
  const me = upsertActor({ sourceId: SOURCE, sourceExtId: SELF_JID, displayName: "Me" });
  for (let i = 0; i < 8; i += 1) {
    const ts = new Date(NOW - 3 * DAY + i * 60_000).toISOString();
    insertEvent({
      externalId: `${ext}-two-${i}`,
      sourceId: SOURCE,
      sourceType: SOURCE,
      streamId: id,
      actorId: i % 2 === 0 ? me : them,
      ts,
      kind: "message",
      text: `turn ${i} in ${ext}`,
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    });
    noteBackfillEvent(id, ts);
  }
  return id;
}

function unboundEvents(): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE actor_entity_id IS NULL AND kind IS NOT 'reaction'`)
      .get() as { n: number }
  ).n;
}

function participantSets(): string[][] {
  return (getDb().prepare(`SELECT participant_entity_ids AS p FROM sessions`).all() as { p: string }[]).map(
    (r) => JSON.parse(r.p) as string[],
  );
}

describe("the identity stage", () => {
  it("binds every event before the walk, so a session's participants are ENTITY ids", async () => {
    pairSelf();
    twoSidedStream("alpha");

    const report = await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });

    expect(report.errors).toEqual([]);
    expect(report.identity?.bound).toBe(8);
    expect(report.identity?.actorsResolved).toBe(2);
    expect(unboundEvents()).toBe(0);
    expect(count("entities")).toBeGreaterThanOrEqual(2);

    // The proof of ORDER: `participant_entity_ids` is written by the walk, and
    // it can only hold entity ids if binding happened first. A sealed session
    // is immutable (§10.4), so getting this wrong is not repairable later.
    const me = meEntityId();
    expect(me).not.toBeNull();
    const sets = participantSets();
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      expect(set.length).toBeGreaterThan(0);
      for (const id of set) expect(id).toMatch(/^ent_[0-9a-f]{24}$/);
    }
    expect(sets.some((set) => set.includes(me!))).toBe(true);
  });

  it("binds the self identity into `me` and derives is_self on both sides", async () => {
    pairSelf();
    twoSidedStream("alpha");

    const report = await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });

    expect(report.identity?.selfSources).toBe(1);
    expect(report.identity?.selfBound).toBe(4);
    const split = getDb().prepare(`SELECT is_self, COUNT(*) AS n FROM events GROUP BY is_self`).all() as {
      is_self: number;
      n: number;
    }[];
    expect(split.sort((a, b) => a.is_self - b.is_self)).toEqual([
      { is_self: 0, n: 4 },
      { is_self: 1, n: 4 },
    ]);
  });

  it("costs nothing — it binds the whole backlog with the wallet set to zero", async () => {
    pairSelf();
    twoSidedStream("alpha");
    let calls = 0;

    // `maxLlmCalls: 0` stops the cohort at the understanding rung, which is the
    // point: the stage below it still finishes. If identity ever reaches for a
    // model this assertion is what says so.
    const report = await runBootstrapTick({
      mode: "slice",
      now: NOW,
      limits: { maxLlmCalls: 0 },
      deps: {
        invoke: async () => {
          calls += 1;
          return null;
        },
      },
    });

    expect(calls).toBe(0);
    expect(report.llmCallsSpent).toBe(0);
    expect(report.identity?.llmCalls).toBe(0);
    expect(report.identity?.bound).toBe(8);
    expect(unboundEvents()).toBe(0);
    // Rung ④ is PARKED, never called (§10.3 rule 6): no decision row claims an
    // agent decided anything.
    expect(
      (
        getDb()
          .prepare(`SELECT COUNT(*) AS n FROM resolution_decisions WHERE decided_by LIKE 'agent%'`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("does not double-drain: the second tick claims nothing and binds nothing", async () => {
    pairSelf();
    twoSidedStream("alpha");

    const first = await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });
    const entities = count("entities");

    const second = await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });

    expect(first.identity?.claimed).toBe(8);
    expect(second.identity?.claimed).toBe(0);
    expect(second.identity?.bound).toBe(0);
    expect(second.identity?.minted).toBe(0);
    expect(count("entities")).toBe(entities);
    // And an idle tick still says WHY it was idle — binding nothing is not
    // "work done", so the `no_work` verdict survives the new stage.
    expect(second.stoppedBy).toBe("no_work");
    expect(second.errors).toEqual([]);
  });

  it("is honest in a dry run: projected, not performed", async () => {
    pairSelf();
    twoSidedStream("alpha");

    const plan = planBootstrap({}, { now: NOW });
    expect(plan.eventsWithoutIdentity).toBe(8);

    const dry = await runBootstrapTick({ mode: "dry", now: NOW });

    expect(dry.eventsWithoutIdentity).toBe(8);
    // A projection is a read. Nothing bound, nothing minted, no `me`.
    expect(dry.identity).toBeNull();
    expect(count("entities")).toBe(0);
    expect(unboundEvents()).toBe(8);

    await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });
    expect(planBootstrap({}, { now: NOW }).eventsWithoutIdentity).toBe(0);
  });

  it("runs in `off` too — the stage is free, and free means unconditional", async () => {
    pairSelf();
    twoSidedStream("alpha");

    const report = await runBootstrapTick({ mode: "off", now: NOW });

    expect(report.identity).not.toBeNull();
    expect(report.identity?.bound).toBe(8);
    expect(unboundEvents()).toBe(0);
    expect(report.llmCallsSpent).toBe(0);
  });

  it("honours maxEntityEvents and leaves the rest ready for the next tick", async () => {
    pairSelf();
    twoSidedStream("alpha");

    const capped = await runBootstrapTick({
      mode: "slice",
      now: NOW,
      limits: { maxEntityEvents: 4, maxLlmCalls: 0 },
    });

    expect(capped.identity?.claimed).toBe(4);
    expect(unboundEvents()).toBe(4);

    const rest = await runBootstrapTick({ mode: "slice", now: NOW, limits: { maxLlmCalls: 0 } });
    expect(rest.identity?.bound).toBe(4);
    expect(unboundEvents()).toBe(0);
  });
});

describe("mode resolution", () => {
  it("defaults to full for an installed app, and app_state wins over the environment", () => {
    // R3: nobody said anything -> the installed default is `full` (capped).
    // Silent-off was the bug: a fresh install imported and then derived nothing.
    expect(resolveBootstrapModeDetailed()).toEqual({ mode: "full", source: "default" });
    process.env.SUPERTWIN_BOOTSTRAP = "slice";
    expect(resolveBootstrapModeDetailed()).toEqual({ mode: "slice", source: "env" });
    appStateSet(BOOTSTRAP_MODE_KEY, "dry");
    expect(resolveBootstrapModeDetailed()).toEqual({ mode: "dry", source: "app_state" });
    // An unknown stored value falls through to the next link, never a guess.
    appStateSet(BOOTSTRAP_MODE_KEY, "everything");
    delete process.env.SUPERTWIN_BOOTSTRAP;
    expect(resolveBootstrapMode()).toBe("full");
    expect(resolveBootstrapModeDetailed("full")).toEqual({ mode: "full", source: "explicit" });
  });

  it("an explicit off override still works, from both app_state and env", () => {
    appStateSet(BOOTSTRAP_MODE_KEY, "off");
    expect(resolveBootstrapModeDetailed()).toEqual({ mode: "off", source: "app_state" });
    appStateSet(BOOTSTRAP_MODE_KEY, "");
    process.env.SUPERTWIN_BOOTSTRAP = "off";
    expect(resolveBootstrapModeDetailed()).toEqual({ mode: "off", source: "env" });
  });
});

describe("fresh install derives unattended (R1+R2+R3)", () => {
  it("empty DB, boot, THEN data arrives — tiers and derivation happen with no mode ever set", async () => {
    // Nobody sets app_state 'bootstrap.mode' and no env is exported: this is
    // the resolved mode an installed app boots with.
    const mode = resolveBootstrapMode();
    expect(mode).toBe("full");

    // Boot tick over the empty database: nothing to do, nothing spent.
    const empty = await runBootstrapTick({ mode, now: NOW, deps: { invoke: answeringInvoke() } });
    expect(empty.stoppedBy).toBe("no_work");
    expect(empty.llmCallsSpent).toBe(0);

    // THEN the import lands (streams + events + the import-done flag) — the
    // exact order the dead-air frame produces on a real install.
    stream("alpha");
    appStateSet(importDoneKey(SOURCE), "true");

    const report = await runBootstrapTick({ mode, now: NOW, deps: { invoke: answeringInvoke() } });

    expect(tiers()).not.toContain(null);
    expect(report.sessionsSealed).toBeGreaterThan(0);
    expect(report.cohortsDone.length).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);
  });
});

describe("bootstrapSettled", () => {
  it("is false while work is outstanding and true once it is not", async () => {
    stream("alpha");
    appStateSet(importDoneKey(SOURCE), "true");

    expect(bootstrapSettled(NOW).settled).toBe(false);

    await runBootstrapTick({ mode: "slice", now: NOW, deps: { invoke: answeringInvoke() } });
    const settled = bootstrapSettled(NOW);

    expect(settled.tierComplete).toBe(true);
    expect(settled.backfillComplete).toBe(true);
    expect(settled.noCandidates).toBe(true);
    expect(settled.noPendingCohorts).toBe(true);
    expect(settled.settled).toBe(true);
  });
});

describe("startBootstrapDriver", () => {
  it("starts stopped-safe, reports a projection, and never runs on its own", () => {
    stream("alpha");
    const driver = startBootstrapDriver({ mode: "off", intervalMs: 60_000 });
    try {
      const status = driver.status();
      expect(status.mode).toBe("off");
      expect(status.sessionsProjected).toBeGreaterThan(0);
      // The projection is a read: nothing was derived by constructing it.
      expect(count("sessions")).toBe(0);
    } finally {
      driver.stop();
    }
    expect(count("sessions")).toBe(0);
  });
});
