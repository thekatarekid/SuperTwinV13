// ===========================================================================
// Assist lane tests (build P2.2, spec §10) — stubbed provider, mocked clock,
// NO live model calls.
//
//   * AST-04 as a CODE assertion: executor-lite's tool table contains no
//     risky tool at all — nothing that sends, pays, books or mutates.
//   * evaluator: packed input shape, JSON validation, actionability
//     thresholds (intent_confidence + helpfulness).
//   * executor-lite: bounded loop, capped web fetch (stubbed), best-partial.
//   * artifacts: dedup by content_key (identical re-captured content never
//     mints a second artifact / nudge), status lifecycle + decisions rows,
//     graded signals, graduation THROUGH the Critic gate (stubbed).
//   * watcher: a full clock-mocked tick — tail -> gate -> evaluator ->
//     executor -> artifact + nudge; and the never-renudge dedup.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvent, type EventEnvelope } from "../db/eventlog.js";
import type { Provider, Usage } from "../providers/types.js";
import type { JsonPassDeps } from "../brain/llm.js";
import { resetStableSystemPromptsForTests } from "../brain/llm.js";
import {
  ASSIST_TOOL_TABLE,
  MAX_STEPS,
  RISKY_TOOL_NAME_PATTERNS,
  runExecutorLite,
  urlsInAction,
} from "../executor/lite.js";
import {
  isActionable,
  packAssistInput,
  parseAssistEvaluation,
  runAssistEvaluator,
  type AssistEvaluation,
} from "./evaluator.js";
import {
  contentKeyFor,
  createArtifact,
  expireMomentBound,
  getArtifact,
  graduateArtifact,
  latestUnseen,
  listArtifacts,
  recordSignal,
  setArtifactStatus,
  signalScore,
} from "./artifacts.js";
import { readTopic, type TopicState } from "./gate.js";
import { assistTick, readAssistCursor } from "./watcher.js";
import { setAssistQuietHours, setAssistThreshold } from "./settings.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-assist-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
  setAssistQuietHours("03:00", "03:30");
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = new Date(2026, 7, 28, 14, 0, 0).getTime();
const MIN = 60_000;

/** A provider that answers every call with `text` and records the prompts. */
function stubProvider(text: string | ((message: string) => string)) {
  const messages: string[] = [];
  const provider: Provider = {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      messages.push(opts.message);
      const usage: Usage = {
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 5,
      };
      const answer = typeof text === "function" ? text(opts.message) : text;
      opts.onEvent({ type: "delta", text: answer });
      opts.onEvent({ type: "done", sessionId: "s", usage });
      return { sessionId: "s", usage, freshFallback: false, status: "ok" as const };
    },
  };
  const deps: JsonPassDeps = { provider, recordRun: () => "run-1", quarantine: () => {} };
  return { deps, messages };
}

function topicState(over: Partial<TopicState> = {}): TopicState {
  return {
    topicKey: "stream:s",
    category: "default",
    weightedCount: 5,
    newContentCount: 3,
    sources: ["wa", "browser"],
    seenHashes: [],
    seenRefs: [],
    eventIds: [],
    lastEventTs: null,
    cooldownUntil: null,
    dismissCount: 0,
    suppressedUntil: null,
    ...over,
  };
}

const GOOD_EVAL = JSON.stringify({
  intent: "Compare Anjuna villas for the Goa trip",
  intent_confidence_0_1: 0.9,
  helpfulness_0_1: 0.8,
  action: "Compare villas across sites",
  artifact_type: "comparison",
  space_hint: "sp_goa",
  reasoning: "5 cross-source events about villas",
});

// ---------------------------------------------------------------------------
// AST-04 — risky-leak, asserted in code
// ---------------------------------------------------------------------------

describe("AST-04: executor-lite tool table has NO risky tools (code assertion)", () => {
  it("contains exactly the read/prepare tools and nothing else", () => {
    expect(Object.keys(ASSIST_TOOL_TABLE).sort()).toEqual(["draft", "packer_read", "web_fetch"]);
  });

  it("no tool name matches any risky pattern (send/pay/book/…)", () => {
    for (const name of Object.keys(ASSIST_TOOL_TABLE)) {
      for (const pattern of RISKY_TOOL_NAME_PATTERNS) {
        expect(pattern.test(name), `tool "${name}" matches risky ${pattern}`).toBe(false);
      }
    }
  });

  it("the table is frozen — nothing can be wired in at runtime", () => {
    expect(Object.isFrozen(ASSIST_TOOL_TABLE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

describe("assist evaluator (stubbed provider)", () => {
  it("packs the tail + world model + suppression state and parses the output", async () => {
    getDb()
      .prepare(
        `INSERT INTO spaces (id, label, status, created_at) VALUES ('sp_goa', 'Goa trip', 'active', '2026-08-01')`,
      )
      .run();
    const { id } = appendEvent(
      {
        ts: new Date(NOW - MIN).toISOString(),
        source: "wa",
        kind: "wa.message",
        origin: "live",
        streamKey: "chat",
        actor: "self",
        roles: { sender: "self", audience: [], receiver: [], mentions: [] },
        payload: { text: "look at these villas" },
      },
      NOW,
    );
    const topic = topicState({ eventIds: [id] });
    const packed = packAssistInput(topic, { nowMs: NOW });
    expect(packed).toContain("[ACTIVITY TAIL] 1 events");
    expect(packed).toContain("look at these villas");
    expect(packed).toContain('sp_goa "Goa trip"');
    expect(packed).toContain("[SUPPRESSION STATE] topic stream:s · dismissals 0");

    const { deps } = stubProvider(GOOD_EVAL);
    const result = await runAssistEvaluator(topic, deps, { nowMs: NOW });
    expect(result.status).toBe("ok");
    expect(result.output!.intent_confidence).toBe(0.9);
    expect(isActionable(result.output!)).toBe(true);
  });

  it("rejects out-of-range confidences with a repairable message", () => {
    expect(() =>
      parseAssistEvaluation({ intent_confidence_0_1: 3, helpfulness_0_1: 0.5 }),
    ).toThrow(/intent_confidence_0_1/);
  });

  it("below either threshold, or with a null action, is NOT actionable", () => {
    const base: AssistEvaluation = {
      intent: "x",
      intent_confidence: 0.9,
      helpfulness: 0.8,
      action: "prepare",
      artifact_type: "brief",
      space_hint: null,
      reasoning: "",
    };
    expect(isActionable(base)).toBe(true);
    expect(isActionable({ ...base, intent_confidence: 0.5 })).toBe(false); // < 0.7 default
    expect(isActionable({ ...base, helpfulness: 0.3 })).toBe(false); // < 0.6 default
    expect(isActionable({ ...base, action: null })).toBe(false);
    expect(isActionable({ ...base, action: "  " })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Executor-lite
// ---------------------------------------------------------------------------

describe("executor-lite (bounded, stubbed fetch)", () => {
  const evaluation: AssistEvaluation = {
    intent: "compare",
    intent_confidence: 0.9,
    helpfulness: 0.8,
    action: "Compare https://a.example/1 and https://b.example/2",
    artifact_type: "comparison",
    space_hint: null,
    reasoning: "",
  };

  it("runs packer_read, fetches each url, drafts — and stays bounded", async () => {
    const fetched: string[] = [];
    const fetchImpl = (async (url: Parameters<typeof fetch>[0]) => {
      fetched.push(String(url));
      return new Response("page body", { status: 200 });
    }) as typeof fetch;
    const result = await runExecutorLite(topicState(), evaluation, { fetchImpl });
    expect(result.steps.map((s) => s.tool)).toEqual([
      "packer_read",
      "web_fetch",
      "web_fetch",
      "draft",
    ]);
    expect(result.steps.length).toBeLessThanOrEqual(MAX_STEPS);
    expect(fetched).toEqual(["https://a.example/1", "https://b.example/2"]);
    expect(result.body.sections.find((s) => s.tool === "draft")!.content).toContain(
      "Compare https://a.example/1",
    );
    expect(result.body.partial).toBe(false);
  });

  it("a failing fetch is best-partial, never a throw", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await runExecutorLite(topicState(), evaluation, { fetchImpl });
    const failures = result.steps.filter((s) => !s.ok);
    expect(failures.length).toBe(2);
    expect(result.body.partial).toBe(true);
    // The draft still happened.
    expect(result.steps.at(-1)!.tool).toBe("draft");
    expect(result.steps.at(-1)!.ok).toBe(true);
  });

  it("only http(s) urls are extracted from the action", () => {
    expect(urlsInAction("see https://x.example/p and file:///etc/passwd")).toEqual([
      "https://x.example/p",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

describe("artifact store (spec §10.5/§10.6)", () => {
  function mint(contentKey = "ck-1") {
    return createArtifact({
      kind: "comparison",
      title: "Villa comparison",
      summary: "compared 6 across 3 sites",
      body: { rows: 6 },
      intent: "Goa villas",
      topicKey: "stream:s",
      contentKey,
      nowMs: NOW,
    });
  }

  it("creates a durable row + decisions row; latestUnseen pins it", () => {
    const { artifact, created } = mint();
    expect(created).toBe(true);
    expect(artifact.status).toBe("new");
    expect(latestUnseen()!.id).toBe(artifact.id);
    const dec = getDb()
      .prepare(`SELECT action FROM decisions WHERE target_kind = 'artifact' AND target_id = ?`)
      .all(artifact.id) as { action: string }[];
    expect(dec.map((d) => d.action)).toContain("create");
  });

  it("dedups by content_key: identical content returns the standing artifact", () => {
    const first = mint();
    const second = mint();
    expect(second.created).toBe(false);
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(listArtifacts().length).toBe(1);
  });

  it("contentKeyFor is order-independent over event hashes", () => {
    const a = contentKeyFor({ topicKey: "t", intent: "i", action: "a", eventHashes: ["h1", "h2"] });
    const b = contentKeyFor({ topicKey: "t", intent: "i", action: "a", eventHashes: ["h2", "h1"] });
    expect(a).toBe(b);
  });

  it("walks the status lifecycle with decisions rows and topic feedback", () => {
    const { artifact } = mint();
    setArtifactStatus(artifact.id, "seen", { nowMs: NOW });
    expect(getArtifact(artifact.id)!.seenAt).not.toBeNull();
    setArtifactStatus(artifact.id, "dismissed", { nowMs: NOW });
    expect(readTopic("stream:s")!.dismissCount).toBe(1);
    // Re-open from dismissed: restarts positive signal, clears the strike.
    setArtifactStatus(artifact.id, "seen", { nowMs: NOW });
    expect(readTopic("stream:s")!.dismissCount).toBe(0);
  });

  it("moment-bound artifacts expire past their window", () => {
    createArtifact({
      kind: "brief",
      title: "check-in window",
      expiresAt: new Date(NOW - MIN).toISOString(),
      nowMs: NOW - 60 * MIN,
    });
    expect(expireMomentBound(NOW)).toBe(1);
    expect(listArtifacts({ status: "expired" }).length).toBe(1);
  });

  it("records graded reconcile signals, not binary", () => {
    const { artifact } = mint();
    expect(recordSignal(artifact.id, "edited").weight).toBe(1.0);
    expect(recordSignal(artifact.id, "glanced").weight).toBe(0.2);
    expect(recordSignal(artifact.id, "dismissed").weight).toBe(-0.6);
    expect(signalScore(artifact.id)).toBeCloseTo(0.6);
    expect(() => recordSignal(artifact.id, "clicked")).toThrow(/unknown reconcile signal/);
  });

  it("graduates through the Critic gate: commit verdict writes a task", async () => {
    const { artifact } = mint();
    const { deps } = stubProvider(JSON.stringify({ verdicts: [{ item: 1, verdict: "commit" }] }));
    const result = await graduateArtifact(artifact.id, deps, { nowMs: NOW });
    expect(result.status).toBe("graduated");
    const task = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(result.taskId!) as {
      title: string;
      created_by: string;
    };
    expect(task.title).toBe("Villa comparison");
    expect(task.created_by).toBe("assist:graduation");
    expect(getArtifact(artifact.id)!.status).toBe("graduated");
    expect(getArtifact(artifact.id)!.taskId).toBe(result.taskId);
  });

  it("a Critic reject blocks graduation — no task, status unchanged", async () => {
    const { artifact } = mint();
    const { deps } = stubProvider(
      JSON.stringify({ verdicts: [{ item: 1, verdict: "reject", reason: "no evidence" }] }),
    );
    const result = await graduateArtifact(artifact.id, deps, { nowMs: NOW });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("no evidence");
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get()).toEqual({ n: 0 });
    expect(getArtifact(artifact.id)!.status).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// Watcher — full clock-mocked ticks
// ---------------------------------------------------------------------------

describe("assist watcher (tail -> gate -> evaluator -> artifact)", () => {
  let seq = 0;
  function liveEnv(text: string, over: Partial<EventEnvelope> = {}): EventEnvelope {
    seq += 1;
    return {
      ts: new Date(NOW - 10 * MIN + seq * 1000).toISOString(),
      source: over.source ?? "wa",
      kind: over.kind ?? "wa.message",
      origin: "live",
      streamKey: over.streamKey ?? "chat-1",
      actor: "self",
      roles: { sender: "self", audience: [], receiver: [], mentions: [] },
      payload: { text, ...(over.payload ?? {}) },
    };
  }
  function live(text: string, over: Partial<EventEnvelope> = {}): string {
    return appendEvent(liveEnv(text, over), NOW).id;
  }

  it("nudges once the gate + evaluator clear, and never re-nudges identical content", async () => {
    setAssistThreshold("default", 3);
    live("villa one details");
    live("villa two details");
    live("villa three details");

    const { deps, messages } = stubProvider(GOOD_EVAL);
    const report = await assistTick({ llm: deps, nowMs: NOW });
    expect(report.eventsRead).toBe(3);
    expect(report.gatesPassed).toEqual(["stream:chat-1"]);
    expect(report.artifacts.length).toBe(1);
    expect(report.nudged.length).toBe(1);
    expect(messages.length).toBe(1);
    const artifact = report.artifacts[0]!;
    expect(artifact.status).toBe("new");
    expect(artifact.nudgedAt).not.toBeNull();
    expect(artifact.topicKey).toBe("stream:chat-1");

    // The cursor advanced; the same tail is never re-read.
    expect(readAssistCursor()).toBeGreaterThan(0);
    const again = await assistTick({ llm: deps, nowMs: NOW + MIN });
    expect(again.eventsRead).toBe(0);
    expect(again.nudged.length).toBe(0);
  });

  it("below the intent-confidence threshold: log, don't nudge", async () => {
    setAssistThreshold("default", 2);
    live("a");
    live("b");
    const { deps } = stubProvider(
      JSON.stringify({
        intent: "browsing travel sites",
        intent_confidence_0_1: 0.3,
        helpfulness_0_1: 0.8,
        action: "something",
        artifact_type: "brief",
        space_hint: null,
        reasoning: "generic",
      }),
    );
    const report = await assistTick({ llm: deps, nowMs: NOW });
    expect(report.gatesPassed.length).toBe(1);
    expect(report.evaluations).toEqual([{ topicKey: "stream:chat-1", actionable: false }]);
    expect(report.artifacts.length).toBe(0);
    expect(listArtifacts().length).toBe(0);
  });

  it("backfill events never reach the assist tail", async () => {
    appendEvent(
      {
        ts: new Date(NOW - 90 * 24 * 60 * MIN).toISOString(),
        source: "wa",
        kind: "wa.message",
        origin: "backfill",
        streamKey: "old-chat",
        actor: "self",
        roles: { sender: "self", audience: [], receiver: [], mentions: [] },
        payload: { text: "ancient history" },
      },
      NOW,
    );
    const { deps } = stubProvider(GOOD_EVAL);
    const report = await assistTick({ llm: deps, nowMs: NOW });
    expect(report.eventsRead).toBe(0);
    expect(report.topicsTouched).toEqual([]);
  });

  it("identical re-captured content across ticks: accumulator unmoved, no second artifact", async () => {
    setAssistThreshold("default", 2);
    const envA = liveEnv("compare villas A");
    const envB = liveEnv("compare villas B");
    appendEvent(envA, NOW);
    appendEvent(envB, NOW);
    const { deps } = stubProvider(GOOD_EVAL);
    const first = await assistTick({ llm: deps, nowMs: NOW });
    expect(first.nudged.length).toBe(1);

    // The same two envelopes captured again (screen re-read): the append
    // path's content-hash dedup keeps the SAME rows -> no new tail at all.
    expect(appendEvent(envA, NOW + 45 * MIN).inserted).toBe(false);
    expect(appendEvent(envB, NOW + 45 * MIN).inserted).toBe(false);
    const second = await assistTick({ llm: deps, nowMs: NOW + 46 * MIN });
    expect(second.eventsRead).toBe(0);
    expect(second.nudged.length).toBe(0);
    expect(listArtifacts().length).toBe(1);
  });

  // ---- S0.10 / T0-14: the accumulator is spent on EVERY evaluator exit path,
  // so a ready topic cannot re-buy the same model call on each later event.

  it("S0.10: a NOT-actionable verdict spends the accumulator — the next single event does not re-evaluate", async () => {
    setAssistThreshold("default", 2);
    live("a");
    live("b");
    const { deps, messages } = stubProvider(
      JSON.stringify({
        intent: "browsing travel sites",
        intent_confidence_0_1: 0.3,
        helpfulness_0_1: 0.8,
        action: "something",
        artifact_type: "brief",
        space_hint: null,
        reasoning: "generic",
      }),
    );
    const first = await assistTick({ llm: deps, nowMs: NOW });
    expect(first.gatesPassed).toEqual(["stream:chat-1"]);
    expect(first.evaluations).toEqual([{ topicKey: "stream:chat-1", actionable: false }]);
    const callsAfterFirst = messages.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const spent = readTopic("stream:chat-1")!;
    expect(spent.eventIds).toEqual([]);
    expect(spent.weightedCount).toBe(0);
    expect(spent.newContentCount).toBe(0);
    // No cooldown for a non-nudge: a genuinely new burst may fire again.
    expect(spent.cooldownUntil).toBeNull();
    // Dedup memory survives the spend.
    expect(spent.seenHashes.length).toBe(2);

    // One more event: the topic is touched but the gate is below threshold again.
    live("c");
    const second = await assistTick({ llm: deps, nowMs: NOW + MIN });
    expect(second.eventsRead).toBe(1);
    expect(second.topicsTouched).toEqual(["stream:chat-1"]);
    expect(second.gatesPassed).toEqual([]);
    expect(messages.length).toBe(callsAfterFirst);
  });

  it("S0.10: an evaluator ERROR spends the accumulator — no re-evaluation loop on later events", async () => {
    setAssistThreshold("default", 3);
    live("x");
    live("y");
    live("w");
    // Never valid JSON -> the evaluator ends in a non-ok status.
    const { deps, messages } = stubProvider("this is not json, and never will be");
    const first = await assistTick({ llm: deps, nowMs: NOW });
    expect(first.gatesPassed).toEqual(["stream:chat-1"]);
    expect(first.evaluations).toEqual([]);
    expect(first.artifacts.length).toBe(0);
    const callsAfterFirst = messages.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const spent = readTopic("stream:chat-1")!;
    expect(spent.eventIds).toEqual([]);
    expect(spent.newContentCount).toBe(0);

    // Two more ticks with one new event each (below the threshold of 3 for a
    // NEW burst): the spent topic never re-clears the gate, zero further calls.
    for (let i = 0; i < 2; i++) {
      live(`z${i}`);
      const r = await assistTick({ llm: deps, nowMs: NOW + (i + 1) * MIN });
      expect(r.eventsRead).toBe(1);
      expect(r.gatesPassed).toEqual([]);
    }
    expect(messages.length).toBe(callsAfterFirst);
  });
});
