// ===========================================================================
// The Critic's mechanical layer (V6 P1 S3.5 · T7-2) — code, no model calls.
// Coverage, verbatim quotes, stream tags, bridge-edge confidence, the merge
// with model verdicts, and the critic.v5 input shape through runCritic with a
// stubbed provider.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { collectTick } from "../scheduler/v6/bundle.js";
import { ResourcePool } from "../providers/pool.js";
import type { Provider, Usage } from "../providers/types.js";
import { PROMPT_VERSION_ENV } from "../prompts/versions.js";
import { resetStableSystemPromptsForTests, type JsonPassDeps } from "./llm.js";
import { runOrient, type OrientOutput } from "./orient.js";
import {
  buildCriticInput,
  mechanicalCriticCheck,
  mergeCriticVerdicts,
  parseCriticOutput,
  renderMechanicalBlock,
  runCritic,
} from "./critic.js";

const aliases = new Map([
  ["e1", "id1"],
  ["e2", "id2"],
  ["e3", "id3"],
  ["e4", "id4"],
]);

const texts = new Map([
  ["e1", "guys lets lock goa 18-21 dec"],
  ["e2", "villa sol wale bol rahe advance aaj chahiye"],
  ["e3", "ok"],
  ["e4", "Villa Sol – Anjuna · ₹5,400/night"],
]);
const streams = new Map([
  ["e1", "S1"],
  ["e2", "S1"],
  ["e3", "S1"],
  ["e4", "S2"],
]);

function orient(over: Partial<OrientOutput> = {}): OrientOutput {
  return { episodes: [], proposals: [], unsorted: [], questions: [], ...over };
}

describe("mechanicalCriticCheck", () => {
  it("lists uncovered and doubly-placed aliases, expanding ranges; proposals cover through episode_events", () => {
    const m = mechanicalCriticCheck({
      output: orient({
        episodes: [{ action: "new", events: ["e1-e2"], summary: "s", evidence: [], confidence: 0.9 }],
        proposals: [{ label: "x y z w", episode_events: ["e2"], summary: "s", evidence: [], confidence: 0.8 }],
      }),
      aliases,
    });
    expect(m.uncovered).toEqual(["e3", "e4"]);
    expect(m.duplicated).toEqual(["e2"]);
    expect(m.items).toBe(2);
    expect(m.edgeVerdicts).toEqual([]);
  });

  it("flags a non-verbatim quote and a two-stream item by item number, only when texts/streams are known", () => {
    const out = orient({
      episodes: [
        { action: "new", stream: "S1", events: ["e1"], summary: "s", evidence: [{ event_ids: ["e1"], quote: "lets lock goa 18-21 dec" }], confidence: 0.9 },
        { action: "new", stream: "S1", events: ["e2"], summary: "s", evidence: [{ event_ids: ["e2"], quote: "I have paid the full amount" }], confidence: 0.9 },
        { action: "new", stream: "S1", events: ["e3", "e4"], summary: "s", evidence: [], confidence: 0.9 },
      ],
    });
    const m = mechanicalCriticCheck({ output: out, aliases, eventTexts: texts, eventStreams: streams });
    expect(m.notVerbatim).toEqual([2]);
    expect(m.multiStream).toEqual([3]);
    // Tag naming another section is a mismatch too.
    const tagged = mechanicalCriticCheck({
      output: orient({ episodes: [{ action: "new", stream: "S2", events: ["e1"], summary: "s", evidence: [], confidence: 0.9 }] }),
      aliases,
      eventStreams: streams,
    });
    expect(tagged.multiStream).toEqual([1]);
    // Unknown texts are not fabrications.
    expect(mechanicalCriticCheck({ output: out, aliases }).notVerbatim).toEqual([]);
  });

  it("rejects a bridge edge below 1.0, numbered after episodes and proposals; other edges are the model's", () => {
    const m = mechanicalCriticCheck({
      output: orient({ episodes: [{ action: "new", events: ["e1-e4"], summary: "s", evidence: [], confidence: 0.9 }] }),
      aliases,
      edges: [
        { kind: "bridge:url", src: "e1", dst: "e4", confidence: 1 },
        { kind: "bridge:url", src: "e2", dst: "e4", confidence: 0.6 },
        { kind: "mention", src: "e1", dst: "ent_rohan", confidence: 0.6 },
      ],
    });
    expect(m.items).toBe(4);
    expect(m.edgeVerdicts).toEqual([{ item: 3, verdict: "reject", reason: "bridge:url edge at 0.6 — bridges are exact: 1.0 or nothing" }]);
    const block = renderMechanicalBlock(m);
    expect(block).toContain("uncovered aliases: (none");
    expect(block).toContain("bridge edges below 1.0 (rejected by code): items 3");
  });
});

describe("mergeCriticVerdicts + parseCriticOutput", () => {
  it("a code reject overrides a model commit; the mechanical coverage list is authoritative", () => {
    const m = mechanicalCriticCheck({
      output: orient({ episodes: [{ action: "new", events: ["e1"], summary: "s", evidence: [], confidence: 0.9 }] }),
      aliases,
      edges: [{ kind: "bridge:phone", src: "e1", dst: "e2", confidence: 0.4 }],
    });
    const merged = mergeCriticVerdicts(
      { verdicts: [{ item: 1, verdict: "commit" }, { item: 2, verdict: "commit" }], uncovered: ["e9"] },
      m,
    );
    expect(merged.verdicts).toEqual([
      { item: 1, verdict: "commit" },
      { item: 2, verdict: "reject", reason: "bridge:phone edge at 0.4 — bridges are exact: 1.0 or nothing" },
    ]);
    expect(merged.uncovered).toEqual(["e2", "e3", "e4"]);
  });

  it("parses the v5 uncovered list (lower-cased) and stays v4-compatible without it", () => {
    expect(parseCriticOutput({ verdicts: [{ item: 1, verdict: "commit" }], uncovered: ["E7", " e8 "] }).uncovered).toEqual(["e7", "e8"]);
    expect(parseCriticOutput({ verdicts: [] })).toEqual({ verdicts: [] });
    expect(() => parseCriticOutput({ verdicts: [], uncovered: "e7" })).toThrow(/uncovered must be an array/);
  });
});

// ---- runCritic through the real pack with a stubbed provider -----------------

let tmpDir: string;
const T0 = Date.parse("2026-08-28T19:40:00.000Z");

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-critic-mech-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
  getDb().prepare(`INSERT INTO entities (id, type, canonical, provisional) VALUES ('ent_rohan', 'person', 'Rohan Mehta', 0)`).run();
  getDb().prepare(`INSERT INTO entity_identities (id, entity_id, source_id, kind, value_norm) VALUES ('ei_rohan', 'ent_rohan', 'wa', 'handle', 'contact:rohan')`).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env[PROMPT_VERSION_ENV.orient];
  delete process.env[PROMPT_VERSION_ENV.critic];
  rmSync(tmpDir, { recursive: true, force: true });
});

function waMessage(i: number, text: string, actor = "contact:rohan"): EventEnvelope {
  return {
    ts: new Date(T0 + i * 60_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "goa-gang@g.us",
    actor,
    roles: { sender: actor, audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text, external_id: `x${i}` },
  };
}

function stubDeps(answers: string[]): JsonPassDeps & { users: string[]; passes: string[] } {
  const users: string[] = [];
  const passes: string[] = [];
  const provider: Provider = {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      users.push(opts.message);
      passes.push(opts.systemPromptFile ?? "");
      const text = answers[users.length - 1] ?? "{}";
      opts.onEvent({ type: "delta", text });
      const usage: Usage = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 };
      opts.onEvent({ type: "done", sessionId: "s", usage });
      return { sessionId: "s", usage, freshFallback: false, status: "ok" as const };
    },
  };
  return {
    provider,
    pool: new ResourcePool({ now: () => 0, sleep: async () => {} }),
    recordRun: () => "run_stub",
    quarantine: () => {},
    users,
    passes,
  };
}

const orientAnswer = JSON.stringify({
  episodes: [
    { action: "new", stream: "S1", events: ["e1"], summary: "Dates agreed.", evidence: [{ event_ids: ["e1"], quote: "lets lock goa 18-21 dec" }], confidence: 0.9 },
  ],
  proposals: [],
  unsorted: [],
  questions: [],
});

async function tick(deps: JsonPassDeps) {
  appendEvents([waMessage(1, "guys lets lock goa 18-21 dec"), waMessage(2, "villa sol wale bol rahe advance aaj chahiye"), waMessage(3, "ok")]);
  const bundle = collectTick(T0 + 3_600_000).bundles.find((b) => b.streamKey === "goa-gang@g.us")!;
  const orientRun = await runOrient(bundle, deps);
  return runCritic(orientRun, deps);
}

describe("runCritic", () => {
  it("critic.v4 (baseline): the v4 input is unchanged, the mechanical report still rides on the run", async () => {
    const deps = stubDeps([orientAnswer, JSON.stringify({ verdicts: [{ item: 1, verdict: "commit" }] })]);
    const run = await tick(deps);
    expect(run.result.pass).toBe("critic.v4");
    const user = deps.users[1]!;
    expect(user).not.toContain("[MECHANICAL]");
    expect(user).not.toContain("[PACK]");
    expect(user).toContain("[DECISIONS]");
    expect(run.mechanical.uncovered).toEqual(["e2", "e3"]);
    expect(run.output).toEqual({ verdicts: [{ item: 1, verdict: "commit" }], uncovered: ["e2", "e3"] });
    expect(run.modelUncovered).toBeUndefined();
  });

  it("critic.v5: the input carries the pack, the decisions and the mechanical block; the model's uncovered list is kept beside code's", async () => {
    process.env[PROMPT_VERSION_ENV.orient] = "v7";
    process.env[PROMPT_VERSION_ENV.critic] = "v5";
    const deps = stubDeps([orientAnswer, JSON.stringify({ verdicts: [{ item: 1, verdict: "commit" }], uncovered: ["e2"] })]);
    const run = await tick(deps);
    expect(run.result.pass).toBe("critic.v5");
    const user = deps.users[1]!;
    expect(user.startsWith("[PACK]\n")).toBe(true);
    expect(user).toContain("<untrusted>");
    expect(user).toContain("[MECHANICAL] measured by code");
    expect(user).toContain("uncovered aliases: e2, e3");
    expect(user).toContain("stream S1 · events e1");
    expect(run.output?.uncovered).toEqual(["e2", "e3"]); // code wins
    expect(run.modelUncovered).toEqual(["e2"]);
    expect(run.items).toBe(1);
  });

  it("buildCriticInput without options is byte-identical to the v4 rendering", () => {
    const bundle = { streamKey: "k", events: [{}, {}], lane: "live" } as never;
    const out = orient({ episodes: [{ action: "new", events: ["e1"], summary: "s", evidence: [], confidence: 0.9 }] });
    const a = buildCriticInput({ bundle, output: out, aliases: new Map() });
    expect(a.split("\n")[0]).toBe("[TICK] stream k · 2 new events · mode propose-only");
    expect(a).not.toContain("lane");
    const b = buildCriticInput({ bundle, output: out, aliases: new Map() }, { pack: "P", mechanical: mechanicalCriticCheck({ output: out, aliases: new Map() }) });
    expect(b.startsWith("[PACK]\nP\n")).toBe(true);
    expect(b).toContain("· lane live");
  });
});
