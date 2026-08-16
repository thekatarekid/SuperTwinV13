// ===========================================================================
// The episode stage — the scheduler wiring that finally CALLS the engine.
//
// What is tested is the wiring, not the engine (episodes/*.test.ts owns that):
// a sealed session read back as the engine's view, the queue path that refuses
// to re-judge, the prefetch that spends a model call only when the engine
// would ask for one, and the aging clock that runs at most once a day.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { getSelectedModel, setSelectedModel } from "../db/settings.js";
import { ResourcePool } from "../providers/pool.js";
import type { Provider, ProviderErrorCode, Usage } from "../providers/types.js";
import type { RunnerDeps } from "../prompts/runner.js";
import {
  drainEpisodeQueue,
  engineSessionOf,
  enqueueEpisodePasses,
  ep2RunnerInvoke,
  episodeAgingDue,
  episodePassAfterSeal,
  rejudgeFallbackSessions,
  runEpisodeAging,
  runSessionEpisodePass,
  unjudgedSealedSessions,
  type Ep2CallOutcome,
} from "./episode-pass.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

let tmpDir: string;
let C1 = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-episode-pass-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  C1 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Rohan", kind: "dm" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function seal(id: string, texts: readonly string[], opts: { status?: string; streamId?: string } = {}): string[] {
  const streamId = opts.streamId ?? C1;
  const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "rohan", displayName: "Rohan" });
  const eventIds = texts.map(
    (text, i) =>
      insertEvent({
        externalId: `${id}-ev${i + 1}`,
        sourceId: "whatsapp",
        sourceType: "whatsapp",
        streamId,
        actorId: actor,
        ts: new Date(NOW - (texts.length - i) * 60_000).toISOString(),
        kind: "message",
        text,
        mediaPath: null,
        rawJson: null,
        isHistorical: true,
      }).id,
  );
  const stamp = new Date(NOW).toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, content_hash)
       VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?)`,
    )
    .run(id, streamId, stamp, stamp, JSON.stringify(eventIds), opts.status ?? "sealed", `h_${id}`);
  return eventIds;
}

function openEpisode(id: string, label: string, daysAgo = 1): void {
  const stamp = new Date(NOW - daysAgo * DAY).toISOString();
  getDb()
    .prepare(
      `INSERT INTO episodes (id, stream_id, source_id, topic_label, label_source, session_ids,
                             event_ids, entity_ids, arc_state, started_at, ended_at)
       VALUES (?, ?, 'whatsapp', ?, 'model', '[]', '[]', '[]', 'open', ?, ?)`,
    )
    .run(id, C1, label, stamp, stamp);
}

describe("engineSessionOf", () => {
  it("reads a sealed session back with its events' own timestamps", () => {
    const eventIds = seal("s1", ["deposit is due friday", "sending the villa link"]);
    const session = engineSessionOf("s1");
    expect(session).not.toBeNull();
    expect(session!.eventIds).toEqual(eventIds);
    expect(Object.keys(session!.eventTimes ?? {})).toHaveLength(2);
    expect(session!.contentHash).toBe("h_s1");
  });

  it("refuses an open session — that is the live trigger's business, not a pass's", () => {
    seal("s1", ["still talking"], { status: "open" });
    expect(engineSessionOf("s1")).toBeNull();
    expect(engineSessionOf("nope")).toBeNull();
  });
});

describe("runSessionEpisodePass", () => {
  it("takes the 1:1 default on an ordinary session and the hash gate on the replay", async () => {
    seal("s1", ["goa dates?", "13th to 17th"]);
    const first = await runSessionEpisodePass("s1", { now: NOW });
    expect(first!.decision).toBe("one_to_one");
    expect(first!.modelCalls).toBe(0);
    const again = await runSessionEpisodePass("s1", { now: NOW });
    expect(again!.decision).toBe("hash_reuse");
    expect(again!.modelCalls).toBe(0);
  });

  it("prefetches the real P-EP2 answer when the stream has open episodes, and replays it through the engine", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    const prompts: string[] = [];
    const result = await runSessionEpisodePass("s1", {
      now: NOW,
      invoke: async (prompt) => {
        prompts.push(prompt.user);
        return "G|s1|1,2|att|e1|0.93|villa shortlist for Goa";
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("#S");
    expect(result!.decision).toBe("judged");
    expect(result!.modelCalls).toBe(1);
    expect(result!.segments[0]!.decision).toBe("attach");
    expect(result!.segments[0]!.episodeId).toBe("ep_villa");
  });

  it("spends nothing on the replay — the hash gate is checked before the transport", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      return "G|s1|1,2|att|e1|0.93|villa shortlist for Goa";
    };
    await runSessionEpisodePass("s1", { now: NOW, invoke });
    const again = await runSessionEpisodePass("s1", { now: NOW, invoke });
    expect(again!.decision).toBe("hash_reuse");
    expect(calls).toBe(1);
  });

  it("falls back to 1:1 when the transport fails — the safe direction, and it is logged", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    const result = await runSessionEpisodePass("s1", { now: NOW, invoke: async () => null });
    expect(result!.decision).toBe("one_to_one_fallback");
    expect(result!.modelCalls).toBe(0);
    expect(result!.verdictId).not.toBeNull();
  });
});

describe("the queue path", () => {
  it("enqueues sealed sessions, drains them through the engine, and never re-judges", async () => {
    // Two streams: s1's pass opens an episode, and a same-stream s2 would then
    // (rightly) want the judge — that routing is the engine's business, not
    // this test's.
    const C2 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c2", name: "Family", kind: "group" });
    seal("s1", ["goa dates?", "13th to 17th"]);
    seal("s2", ["vet on saturday", "carry the card"], { streamId: C2 });
    expect(unjudgedSealedSessions()).toEqual(expect.arrayContaining(["s1", "s2"]));

    enqueueEpisodePasses(["s1", "s2"], { now: NOW });
    const report = await drainEpisodeQueue({ now: NOW });
    expect(report.claimed).toBe(2);
    expect(report.ran).toBe(2);
    expect(report.decisions.map((d) => d.decision)).toEqual(["one_to_one", "one_to_one"]);

    // Verdicts persisted → §9.7 rule 5: the sweep finds nothing, the queue
    // refuses the re-enqueue, and nothing is re-judged.
    expect(unjudgedSealedSessions()).toEqual([]);
    // The queue row is already `done` (which wins the check); a fresh queue
    // would refuse on the verdict itself. Both are the same rule: finished
    // work stays finished.
    const again = enqueueEpisodePasses(["s1", "s2"], { now: NOW });
    expect(again.map((o) => o.action)).toEqual(["skipped_done", "skipped_done"]);
    getDb().prepare(`DELETE FROM work_queue`).run();
    const fresh = enqueueEpisodePasses(["s1", "s2"], { now: NOW });
    expect(fresh.map((o) => o.action)).toEqual(["skipped_verdict", "skipped_verdict"]);
    expect((await drainEpisodeQueue({ now: NOW })).claimed).toBe(0);
  });

  it("episodePassAfterSeal is enqueue + drain in one seam", async () => {
    seal("s1", ["goa dates?", "13th to 17th"]);
    const report = await episodePassAfterSeal(["s1"], { now: NOW });
    expect(report.ran).toBe(1);
    expect(report.decisions[0]).toEqual({ sessionId: "s1", decision: "one_to_one" });
  });

  it("puts back a session it cannot read yet instead of losing it", async () => {
    seal("s1", ["still talking"], { status: "open" });
    enqueueEpisodePasses(["s1"], { now: NOW });
    const report = await drainEpisodeQueue({ now: NOW });
    expect(report.skipped).toBe(1);
    const row = getDb().prepare(`SELECT state FROM work_queue WHERE unit_id = 's1'`).get() as { state: string };
    expect(row.state).toBe("ready");
  });

  it("counts every fallback, and the verdict row keeps the distinction", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    enqueueEpisodePasses(["s1"], { now: NOW });
    const report = await drainEpisodeQueue({ now: NOW, invoke: async () => null });
    expect(report.fallbacks).toBe(1);
    expect(report.decisions).toEqual([{ sessionId: "s1", decision: "one_to_one_fallback" }]);
    // `episode_verdicts.decision` is what a later re-judge pass finds them by.
    const row = getDb().prepare(`SELECT decision FROM episode_verdicts WHERE session_id = 's1'`).get() as {
      decision: string;
    };
    expect(row.decision).toBe("one_to_one_fallback");
  });
});

// ===========================================================================
// The second hearing — a fallback verdict is temporary, not a downgrade.
// ===========================================================================
describe("rejudgeFallbackSessions", () => {
  it("retracts the fallback verdict, its 1:1 episode, and re-enqueues for the real judge", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    enqueueEpisodePasses(["s1"], { now: NOW });
    await drainEpisodeQueue({ now: NOW, invoke: async () => null });

    const report = rejudgeFallbackSessions({ now: NOW });
    expect(report.sessions).toEqual(["s1"]);
    expect(report.retracted).toBe(1);
    expect(report.enqueued.map((o) => o.action)).toEqual(["inserted"]);

    // Both gates are open again: no verdict, no 1:1 episode, and the fresh
    // drain buys the real call this time.
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM episode_verdicts`).get()).toEqual({ n: 0 });
    const episodes = getDb().prepare(`SELECT id FROM episodes ORDER BY id`).all() as { id: string }[];
    expect(episodes.map((e) => e.id)).toEqual(["ep_villa"]);
    const drained = await drainEpisodeQueue({
      now: NOW,
      invoke: async () => "G|s1|1,2|att|e1|0.93|villa shortlist for Goa",
    });
    expect(drained.decisions).toEqual([{ sessionId: "s1", decision: "judged" }]);
    expect(drained.fallbacks).toBe(0);
  });

  it("leaves a session alone once a later verdict stands, and retracting twice is a no-op", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    await runSessionEpisodePass("s1", { now: NOW, invoke: async () => null });
    rejudgeFallbackSessions({ now: NOW });
    await drainEpisodeQueue({ now: NOW, invoke: async () => "G|s1|1,2|att|e1|0.93|villa shortlist for Goa" });
    // The latest verdict is `judged` now — there is nothing left to re-judge.
    const again = rejudgeFallbackSessions({ now: NOW });
    expect(again.retracted).toBe(0);
    expect(again.sessions).toEqual([]);
  });
});

// ===========================================================================
// What `ep2RunnerInvoke` tells the SCHEDULER — the two facts a null answer
// destroys on its way to the engine.
//
// The engine may only be told `null` (its 1:1 fallback is the safe direction),
// which is precisely why the caller cannot otherwise tell a cheap pass from a
// total outage, or one billed call from a call that retried and billed twice.
// ===========================================================================
/** One `send` per turn, in order. */
function fakeProvider(turns: { text?: string; code?: ProviderErrorCode }[]): Provider {
  let n = 0;
  return {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      const turn = turns[n++] ?? { text: "" };
      const usage: Usage = {
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 5,
        costUsd: 0.1,
      };
      if (turn.text !== undefined) opts.onEvent({ type: "delta", text: turn.text });
      if (turn.code) {
        opts.onEvent({ type: "error", code: turn.code, message: "boom" });
        opts.onEvent({ type: "done", sessionId: "s", usage });
        return { sessionId: "s", usage, freshFallback: false, status: "error", errorCode: turn.code };
      }
      opts.onEvent({ type: "done", sessionId: "s", usage });
      return { sessionId: "s", usage, freshFallback: false, status: "ok" };
    },
  };
}

function runnerDeps(turns: { text?: string; code?: ProviderErrorCode }[]): RunnerDeps {
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

const PROMPT = { system: "sys", user: "#S s1 | c1 | 1 events", model: "sonnet-5" };

describe("ep2RunnerInvoke's outcome channel", () => {

  it("counts the RETRY: one invocation, two billed provider calls, two runs rows", async () => {
    const seen: Ep2CallOutcome[] = [];
    const invoke = ep2RunnerInvoke({
      cohortId: null,
      observe: (o) => seen.push(o),
      deps: runnerDeps([{ code: "TIMEOUT" }, { text: "G|s1|1|new|-|0.9|a topic" }]),
    });

    const answer = await invoke(PROMPT);

    expect(answer).not.toBeNull();
    expect(seen).toHaveLength(1);
    // A wallet that charges 1 here caps at half of what it pays.
    expect(seen[0]!.providerCalls).toBe(2);
    expect(seen[0]!.error).toBeNull();
    // And the billed count is exactly what `runs` recorded, per call.
    const rows = getDb().prepare(`SELECT status FROM runs`).all() as { status: string }[];
    expect(rows).toHaveLength(2);
  });

  it("surfaces the failure a null answer hides, and writes the run under a NULL cohort", async () => {
    const seen: Ep2CallOutcome[] = [];
    const invoke = ep2RunnerInvoke({
      cohortId: null,
      observe: (o) => seen.push(o),
      // Four failures walks the ladder out and quarantines.
      deps: runnerDeps(Array.from({ length: 4 }, () => ({ code: "TIMEOUT" as ProviderErrorCode }))),
    });

    const answer = await invoke(PROMPT);

    // The ENGINE still only hears null — that part is deliberate.
    expect(answer).toBeNull();
    // The SCHEDULER hears what actually happened.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.error?.code).toBe("TIMEOUT");
    expect(seen[0]!.status).toBe("quarantined");
    expect(seen[0]!.providerCalls).toBeGreaterThan(1);
    // `runs.cohort_id` is a FK: the old "steady" sentinel threw here and the
    // rows were never written at all.
    const rows = getDb().prepare(`SELECT cohort_id FROM runs`).all() as { cohort_id: string | null }[];
    expect(rows.length).toBe(seen[0]!.providerCalls);
    for (const r of rows) expect(r.cohort_id).toBeNull();
  });

  it("salvages a quarantined answer whose G line parsed — one prose sentence no longer voids the pass", async () => {
    const seen: Ep2CallOutcome[] = [];
    const invoke = ep2RunnerInvoke({
      cohortId: null,
      sessionId: "s1",
      observe: (o) => seen.push(o),
      // Round 1: one valid G line, one conversational line (the proof-run
      // failure mode, verbatim). The repair round answers in prose again, so
      // the unit still quarantines — but the G line was ACCEPTED in round 1.
      deps: runnerDeps([
        { text: "G|s1|1|new|-|0.9|a topic\nOnce you clarify | which episode you mean | I can decide" },
        { text: "Once you clarify | which episode you mean | I can decide" },
      ]),
    });

    const answer = await invoke(PROMPT);

    // The engine gets the raw rounds back and re-parses them itself — the
    // prose line fails the same parser a second time, only the G line lands.
    expect(answer).not.toBeNull();
    expect(answer).toContain("G|s1|1|new|-|0.9|a topic");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe("quarantined");
    // Applied, so not an error — but not silent either.
    expect(seen[0]!.error).toBeNull();
    expect(seen[0]!.partial).not.toBeNull();
    expect(seen[0]!.partial!.records).toBeGreaterThanOrEqual(1);
    expect(seen[0]!.partial!.lines).toBeGreaterThanOrEqual(1);
    // Retry accounting is unchanged: both rounds billed, both on `runs`.
    expect(seen[0]!.providerCalls).toBe(2);
    const rows = getDb().prepare(`SELECT id FROM runs`).all();
    expect(rows).toHaveLength(2);
  });

  it("a genuinely empty quarantine still fails loudly — salvage never invents an answer", async () => {
    const seen: Ep2CallOutcome[] = [];
    const invoke = ep2RunnerInvoke({
      cohortId: null,
      sessionId: "s1",
      observe: (o) => seen.push(o),
      deps: runnerDeps([
        { text: "Once you clarify | which episode" },
        { text: "I'm sorry | I can't help with that." },
      ]),
    });
    expect(await invoke(PROMPT)).toBeNull();
    expect(seen[0]!.status).toBe("quarantined");
    expect(seen[0]!.partial).toBeNull();
    expect(seen[0]!.error?.code).toBe("EMPTY_RESPONSE");
  });
});

// ===========================================================================
// Salvage end-to-end: the quarantined-but-readable answer reaches the ENGINE
// and becomes a real judged verdict, not a fallback.
// ===========================================================================
describe("the salvage path through the engine", () => {
  it("turns a prose-contaminated quarantine into a judged verdict", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    const result = await runSessionEpisodePass("s1", {
      now: NOW,
      invoke: ep2RunnerInvoke({
        cohortId: null,
        sessionId: "s1",
        deps: runnerDeps([
          { text: "G|s1|1,2|att|e1|0.93|villa shortlist for Goa\nOnce you clarify | the episode" },
          { text: "Once you clarify | the episode" },
        ]),
      }),
    });
    expect(result!.decision).toBe("judged");
    expect(result!.segments[0]!.episodeId).toBe("ep_villa");
    // The prose line is still rejected — it shows up as a violation, exactly
    // as it would have before salvage existed. Only the blast radius changed.
    expect(result!.violations.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// Proof-run replay — the quarantined failure modes from proof4, reconstructed
// from their quarantine rows (raw answers are never persisted; the violation
// summaries are what survived) and driven through the FIXED path. Zero model
// spend: every answer below is a fake transport's.
// ===========================================================================
describe("proof4 replay", () => {
  // proof4 quarantine 7f6cb78f: "line 1 — bad_alias: episode / line 2 —
  // bad_alias: episode" — EVERY G line put words where the e-alias belongs.
  it("an all-bad_alias answer still fails loudly, invents no episode, and stays rejudgeable", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    const seen: Ep2CallOutcome[] = [];
    const badBothLines =
      "G|s1|1|att|villa shortlist for Goa|0.9|villa shortlist\nG|s1|2|att|the villa episode|0.8|villa shortlist";
    enqueueEpisodePasses(["s1"], { now: NOW });
    const report = await drainEpisodeQueue({
      now: NOW,
      invoke: ep2RunnerInvoke({
        cohortId: null,
        sessionId: "s1",
        observe: (o) => seen.push(o),
        deps: runnerDeps([{ text: badBothLines }, { text: badBothLines }]),
      }),
    });

    // Zero accepted records: salvage refuses, the failure is loud, and the
    // engine takes its safe fallback. NO validation was weakened.
    expect(seen[0]!.status).toBe("quarantined");
    expect(seen[0]!.partial).toBeNull();
    expect(seen[0]!.error?.code).toBe("EMPTY_RESPONSE");
    expect(report.fallbacks).toBe(1);
    // The prose alias never became an episode — only the pre-existing one and
    // the fallback's own 1:1 episode exist.
    const episodes = getDb().prepare(`SELECT topic_label FROM episodes`).all() as { topic_label: string | null }[];
    expect(episodes).toHaveLength(2);
    // And the fallback is not a life sentence any more: the second hearing
    // finds it.
    expect(rejudgeFallbackSessions({ now: NOW }).sessions).toEqual(["s1"]);
  });

  // proof4 quarantine 40adccd3: "line 1 — bad_alias: episode" — one line put
  // the episode's LABEL in the alias field while its neighbours were valid.
  it("a bad_alias line no longer voids its valid neighbours — salvaged, parked, repaired", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link", "mom's scan is back", "call the doctor"]);
    const seen: Ep2CallOutcome[] = [];
    const mixed =
      "G|s1|1,2|att|e1|0.93|villa shortlist for Goa\nG|s1|3,4|att|villa shortlist for Goa|0.9|scan results";
    const result = await runSessionEpisodePass("s1", {
      now: NOW,
      invoke: ep2RunnerInvoke({
        cohortId: null,
        sessionId: "s1",
        observe: (o) => seen.push(o),
        // The repair round repeats the bad line, so the unit still quarantines
        // — exactly the proof-run shape — but the valid line was accepted.
        deps: runnerDeps([{ text: mixed }, { text: "G|s1|3,4|att|villa shortlist for Goa|0.9|scan results" }]),
      }),
    });

    expect(seen[0]!.status).toBe("quarantined");
    expect(seen[0]!.partial).not.toBeNull();
    // Applied as a real judgment: the valid attach lands on the real episode.
    expect(result!.decision).toBe("judged");
    const attach = result!.segments.find((s) => s.episodeId === "ep_villa");
    expect(attach).toBeDefined();
    // The parked line's events are folded into the nearest preceding segment —
    // `repairPartition`'s documented policy, recorded as a repair, never lost.
    expect(attach!.eventIds).toHaveLength(4);
    // The bad line is STILL rejected — same parser, same verdict on it — and
    // its events come back through the partition repair, never silently lost.
    expect(JSON.stringify(result!.violations)).toContain("bad_alias");
    const covered = result!.segments.flatMap((s) => s.eventIds).sort();
    expect(covered).toEqual([...engineSessionOf("s1")!.eventIds].sort());
    // No episode named by prose: nothing was created FROM the bad alias field.
    const labels = getDb().prepare(`SELECT topic_label FROM episodes WHERE id != 'ep_villa'`).all() as {
      topic_label: string | null;
    }[];
    for (const l of labels) expect(l.topic_label).not.toBe("villa shortlist for Goa");
  });

  it("genuine garbage is still garbage — a well-shaped nonsense G line is rejected whole", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    const seen: Ep2CallOutcome[] = [];
    const garbage = "G|s9|zz|maybe|whichever episode fits|very confident|";
    const result = await runSessionEpisodePass("s1", {
      now: NOW,
      invoke: ep2RunnerInvoke({
        cohortId: null,
        sessionId: "s1",
        observe: (o) => seen.push(o),
        deps: runnerDeps([{ text: garbage }, { text: garbage }]),
      }),
    });
    expect(seen[0]!.error?.code).toBe("EMPTY_RESPONSE");
    expect(seen[0]!.partial).toBeNull();
    expect(result!.decision).toBe("one_to_one_fallback");
  });
});

// ===========================================================================
// Model routing — §12.3 assigns the episode role to Sonnet, and the proof-run
// deviation was DB data (all five roles overridden to haiku), not resolution
// code. Verify the resolution end-to-end: the model the runner BILLS under is
// the role's resolved model.
// ===========================================================================
describe("the episode role's model", () => {
  it("resolves to the spec's Sonnet default and stamps it on the runs row", async () => {
    expect(getSelectedModel("episode")).toBe("claude-sonnet-5");
    await ep2RunnerInvoke({
      cohortId: null,
      sessionId: "s1",
      deps: runnerDeps([{ text: "G|s1|1|new|-|0.9|a topic" }]),
    })(PROMPT);
    const row = getDb().prepare(`SELECT model FROM runs`).get() as { model: string };
    expect(row.model).toBe("claude-sonnet-5");
  });

  it("honors an app_state override — which is why the proof runs billed haiku", async () => {
    setSelectedModel("episode", "claude-haiku-4-5-20251001");
    await ep2RunnerInvoke({
      cohortId: null,
      sessionId: "s1",
      deps: runnerDeps([{ text: "G|s1|1|new|-|0.9|a topic" }]),
    })(PROMPT);
    const row = getDb().prepare(`SELECT model FROM runs`).get() as { model: string };
    expect(row.model).toBe("claude-haiku-4-5-20251001");
    setSelectedModel("episode", "");
    expect(getSelectedModel("episode")).toBe("claude-sonnet-5");
  });
});

// ===========================================================================
// The hash gate must not launder a fallback: a model-free verdict reused by a
// content-identical sibling would become a permanent `hash_reuse` row that
// `rejudgeFallbackSessions` (which matches on decision) can never see.
// ===========================================================================
describe("the hash gate and fallback verdicts", () => {
  it("a sibling session with identical content gets a real judgment, not the fallback's copy", async () => {
    openEpisode("ep_villa", "villa shortlist for Goa");
    seal("s1", ["deposit is due friday", "sending the villa link"]);
    const first = await runSessionEpisodePass("s1", { now: NOW, invoke: async () => null });
    expect(first!.decision).toBe("one_to_one_fallback");

    seal("s2", ["deposit is due friday", "sending the villa link"]);
    getDb().prepare(`UPDATE sessions SET content_hash = 'h_s1' WHERE id = 's2'`).run();
    const sibling = await runSessionEpisodePass("s2", {
      now: NOW,
      invoke: async () => "G|s1|1,2|att|e1|0.93|villa shortlist for Goa",
    });
    // Not `hash_reuse` of the fallback, and not another fallback: the gate
    // missed on purpose and a real model call was spent.
    expect(sibling!.decision).toBe("judged");
    expect(sibling!.modelCalls).toBe(1);
    const row = getDb().prepare(`SELECT decision FROM episode_verdicts WHERE session_id = 's2'`).get() as {
      decision: string;
    };
    expect(row.decision).toBe("judged");
  });
});

describe("the aging clock", () => {
  it("fades the quiet episode, stamps the day, and refuses to run twice", () => {
    openEpisode("ep_old", "goa trip", 15);
    expect(episodeAgingDue(NOW)).toBe(true);
    const faded = runEpisodeAging({ now: NOW });
    expect(faded!.map((f) => f.episodeId)).toEqual(["ep_old"]);
    const row = getDb().prepare(`SELECT arc_state, outcome FROM episodes WHERE id = 'ep_old'`).get() as {
      arc_state: string;
      outcome: string;
    };
    expect(row).toEqual({ arc_state: "closed", outcome: "faded" });

    // Not again within a day — the reconcile convention.
    expect(episodeAgingDue(NOW + 3_600_000)).toBe(false);
    expect(runEpisodeAging({ now: NOW + 3_600_000 })).toBeNull();
    expect(runEpisodeAging({ now: NOW + 3_600_000, force: true })).toEqual([]);
    expect(episodeAgingDue(NOW + 25 * 3_600_000)).toBe(true);
  });
});
