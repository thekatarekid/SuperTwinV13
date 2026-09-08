// ===========================================================================
// S4.2 — executor-lite unit tests (stubbed provider + stubbed fetch, ZERO
// live model calls).
//
// The four properties EXE-01..05 gate, asserted here at the module level:
// the capability surface, the two ceilings as refusals plus their trace row,
// the thin stop that spends nothing, the retry rule, the login wall, and the
// citation check that drops a page the run never opened.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetStableSystemPromptsForTests } from "../brain/llm.js";
import type { PreparedActionPayload, PreparedActionRow } from "../brain/live.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { clampLiteBudget, LITE_MAX_TURNS, LITE_MIN_TURNS } from "../prompts/lite.v1.js";
import type { NeutralProviderResult, ProviderRequest, ProviderStreamEvent, ProviderV2, Usage } from "../providers/types.js";
import { TEST_PROVIDER_MAX_OUTPUT_TOKENS, providerRequestText } from "../providers/test-support.js";
import { recordProviderInvocation } from "../traces/context.js";
import type { TraceRecord } from "../traces/store.js";
import {
  LITE_TOOL_NAMES,
  groundArtifact,
  liteGaps,
  liteToolRegistry,
  normaliseUrl,
  questionLine,
  runPreparedAction,
  type LiteRunResult,
} from "./lite.js";
import { ToolRegistry } from "./tools.js";

const USAGE: Usage = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 };
const NOW_MS = Date.parse("2026-09-05T10:40:00.000Z");

/** Replays scripted events and records a provider invocation, like the adapter. */
class StubProvider implements ProviderV2 {
  readonly id: "claude-local" = "claude-local";
  readonly displayName = "Executor-lite test provider";
  readonly capabilities = { functionTools: false, hostTools: true, continuation: true, requiresAuthentication: false };
  sent: ProviderRequest[] = [];
  constructor(
    private events: ProviderStreamEvent[],
    private costUsd = 0.001,
  ) {}
  authState() { return { status: "ready" as const, error: null }; }
  catalogue() {
    return {
      providerId: this.id,
      mode: "discovered" as const,
      source: "offline-test",
      discoveredAt: "2026-09-08T00:00:00.000Z",
      revision: "lite-test-r1",
      error: null,
      models: [{
        id: "lite-test-model", displayName: "Lite Test", isDefault: true, hidden: false,
        inputModalities: ["text" as const], reasoningValues: ["off"], defaultReasoning: "off",
        supportsTools: false, supportsHostTools: true, supportsParallelToolCalls: false,
        supportsStructuredOutput: false, supportsStrictTools: false, supportsVerbosity: false,
        supportsPromptCacheKey: false, supportsPromptCacheOptions: false,
        contextWindow: 200_000, maxOutputTokens: TEST_PROVIDER_MAX_OUTPUT_TOKENS, billingLabel: null,
      }],
    };
  }
  async send(opts: ProviderRequest): Promise<NeutralProviderResult> {
    this.sent.push(opts);
    recordProviderInvocation({
      runId: opts.runId,
      attempt: 1,
      model: opts.model ?? null,
      systemPrompt: "lite.v1",
      packedContext: providerRequestText(opts),
      rawOutput: "",
      usage: { ...USAGE, costUsd: this.costUsd },
      latencyMs: 1,
      status: "ok",
      ts: new Date(NOW_MS).toISOString(),
    });
    for (const e of this.events) opts.onEvent(e);
    return { continuation: "s1", usage: { ...USAGE, costUsd: this.costUsd }, freshFallback: false, status: "ok" };
  }
  cancel(): boolean {
    return false;
  }
  killAll(): void {}
}

const done = (usage: Partial<Usage> = {}): ProviderStreamEvent => ({
  type: "done",
  continuation: "s1",
  usage: { ...USAGE, ...usage },
});
const toolUse = (name: string, input: unknown): ProviderStreamEvent => ({ type: "tool_use", name, input });
const finalText = (o: Record<string, unknown>): ProviderStreamEvent => ({ type: "delta", text: JSON.stringify(o) });

/** A canned page-server: url → [status, body] (a list replays in order). */
function stubFetch(pages: Record<string, [number, string][] | [number, string]>): typeof fetch {
  const cursor = new Map<string, number>();
  return (async (input: unknown) => {
    const url = String(input);
    const entry = pages[url];
    if (!entry) return new Response("not found", { status: 404 });
    const list = Array.isArray(entry[0]) ? (entry as [number, string][]) : [entry as [number, string]];
    const i = Math.min(cursor.get(url) ?? 0, list.length - 1);
    cursor.set(url, i + 1);
    const [status, body] = list[i]!;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

function prepared(over: Partial<PreparedActionPayload> = {}, id = "prep_1"): PreparedActionRow {
  const payload: PreparedActionPayload = {
    kind: "help_now",
    intent: "comparing villas in Anjuna",
    intent_confidence: 0.9,
    action: "compare",
    space: "sp1",
    urgency: "now",
    deadline_at: null,
    inputs: {
      candidates: ["https://villas.example/sol", "https://villas.example/casa"],
      dates: "18-21 Dec",
      budget: "6000/night",
    },
    grounded_in: ["e1"],
    reasoning: "they are on Airbnb right now",
    groundedEventIds: ["ev_1"],
    surface: "card",
    intentFloor: 0.7,
    bundleKey: "st_1:1-3",
    lane: "live",
    runId: "run_1",
    contentKey: "ck1",
    preparedAt: new Date(NOW_MS).toISOString(),
    ...over,
  } as PreparedActionPayload;
  return { id, spaceId: "sp1", taskId: null, status: "deferred", createdAt: new Date(NOW_MS).toISOString(), payload };
}

/** Insert the prepared row so the run can resolve it. */
function seedPrepared(row: PreparedActionRow): PreparedActionRow {
  getDb()
    .prepare(
      `INSERT INTO deferred_outputs (id, space_id, task_id, kind, payload_json, status, created_by, created_at)
       VALUES (?, ?, ?, 'prepared_action', ?, 'deferred', 'live', ?)`,
    )
    .run(row.id, row.spaceId, row.taskId, JSON.stringify(row.payload), row.createdAt);
  return row;
}

let tmpDir: string;
let traces: TraceRecord[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-lite-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
  traces = [];
  getDb().prepare(`INSERT INTO spaces (id, label, goal, status) VALUES ('sp1','Goa trip','villa under 6k','active')`).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

const artifactsOf = (): Record<string, unknown>[] =>
  getDb().prepare(`SELECT * FROM artifacts ORDER BY created_at, rowid`).all() as Record<string, unknown>[];
const questionsOf = (): Record<string, unknown>[] =>
  getDb().prepare(`SELECT * FROM questions ORDER BY asked_at, rowid`).all() as Record<string, unknown>[];

// ---------------------------------------------------------------------------

describe("the capability surface is the whole safety story", () => {
  it("is exactly web_fetch, world_read, world_write_draft — all safe, none gated", () => {
    const registry = liteToolRegistry();
    expect(registry.allowedToolNames().sort()).toEqual([...LITE_TOOL_NAMES].sort());
    for (const tool of registry.list()) expect(tool.risk).toBe("safe");
  });

  it("a send/pay/login tool cannot even be registered as safe", () => {
    const registry = new ToolRegistry();
    for (const name of ["send_whatsapp", "pay_invoice", "submit_form", "post_order"]) {
      expect(() => registry.register({ name, description: "x", risk: "safe", handler: async () => "" })).toThrow(/risky pattern/);
    }
  });
});

describe("the ceilings are refusals, and both are in the trace (EXE-01)", () => {
  it("clamps any requested budget into the doc's 3–8 turns", () => {
    expect(clampLiteBudget({ maxTurns: 99, costUsd: 1 }).maxTurns).toBe(LITE_MAX_TURNS);
    expect(clampLiteBudget({ maxTurns: 1, costUsd: 1 }).maxTurns).toBe(LITE_MIN_TURNS);
    expect(clampLiteBudget(undefined).maxTurns).toBeLessThanOrEqual(LITE_MAX_TURNS);
  });

  it("a provider that ignores --max-turns still stops at the ceiling", async () => {
    const row = seedPrepared(prepared());
    const spam = Array.from({ length: 12 }, () => toolUse("world_read", "villa"));
    const provider = new StubProvider([...spam, finalText({ status: "partial", criteria: ["c"], questions: [] }), done()]);
    const res = await runPreparedAction(row, {
      provider,
      nowMs: NOW_MS,
      budget: { maxTurns: 4, costUsd: 1 },
      traceSink: (r) => traces.push(r),
      fetchImpl: stubFetch({}),
    });

    expect(provider.sent[0]!.maxAgentTurns).toBe(4);
    expect(provider.sent[0]!.hostTools?.sort()).toEqual([...LITE_TOOL_NAMES].sort());
    expect(provider.sent[0]!.toolChoice).toBe("auto");
    expect(provider.sent[0]!.maxOutputTokens).toBe(TEST_PROVIDER_MAX_OUTPUT_TOKENS);
    expect(provider.sent[0]).not.toHaveProperty("continuation");
    expect(res.turns.ceiling).toBe(4);
    expect(res.turns.used).toBeLessThanOrEqual(4);
    expect(res.turns.used).toBeLessThanOrEqual(LITE_MAX_TURNS);
    expect(res.invocations.filter((i) => i.status === "ok")).toHaveLength(3); // ceiling − the final turn
    expect(res.refusals.filter((r) => r.reason === "cycle_ceiling")).toHaveLength(9);

    const parsed = traces[0]?.parsed_result as Record<string, unknown>;
    expect(traces).toHaveLength(1);
    expect(parsed.ceilings).toEqual({ max_turns: 4, cost_usd: 1, doc_max_turns: LITE_MAX_TURNS });
    expect(parsed.money).toEqual({ usd: expect.any(Number), ceiling: 1 });
    expect((parsed.turns as Record<string, number>).ceiling).toBe(4);
  });

  it("refuses the next tool once the money ceiling is reached", async () => {
    const row = seedPrepared(prepared());
    const provider = new StubProvider(
      [
        toolUse("world_read", "villa"),
        { type: "usage", usage: { ...USAGE, costUsd: 0.09 } },
        toolUse("world_read", "budget"),
        finalText({ status: "partial", questions: [] }),
        done({ costUsd: 0.09 }),
      ],
      0.09,
    );
    const res = await runPreparedAction(row, {
      provider,
      nowMs: NOW_MS,
      budget: { maxTurns: 8, costUsd: 0.05 },
      traceSink: (r) => traces.push(r),
    });
    expect(res.refusals.map((r) => r.reason)).toEqual(["money_ceiling"]);
    expect(res.money).toEqual({ usd: 0.09, ceiling: 0.05 });
    expect(res.gaps.join(" ")).toContain("money ceiling");
  });
});

describe("thin context stops before it spends (EXE-02)", () => {
  it("names every gap in ONE card, prefills the doubted value, fetches nothing", async () => {
    const row = seedPrepared(
      prepared({
        inputs: {
          candidates: ["https://villas.example/sol"],
          budget: { value: "6000/night", confidence: 0.4 },
        },
      }),
    );
    const provider = new StubProvider([finalText({ status: "done" }), done()]);
    const res = await runPreparedAction(row, { provider, nowMs: NOW_MS, fetchImpl: stubFetch({}) });

    expect(res.status).toBe("question");
    expect(res.modelCalls).toBe(0);
    expect(provider.sent).toHaveLength(0);
    expect(res.fetches).toHaveLength(0);
    expect(res.questions.map((q) => q.field)).toEqual(["dates", "budget"]);
    expect(questionLine(res.questions)).toBe("dates? budget?");

    const budgetGap = res.questions.find((q) => q.field === "budget")!;
    expect(budgetGap.prefill).toBe("6000/night"); // the guess, marked confirm — never written
    expect(budgetGap.confirm).toBe(true);

    const cards = artifactsOf();
    expect(cards).toHaveLength(1); // ONE combined card, not one per gap
    expect(cards[0].kind).toBe("question");
    expect(cards[0].title).toBe("dates? budget?");
    expect(cards[0].producer).toBe("executor");
    const questions = questionsOf();
    expect(questions).toHaveLength(1);
    expect(JSON.parse(String(questions[0].options_json))).toHaveLength(2);

    const row2 = getDb().prepare(`SELECT status FROM deferred_outputs WHERE id = 'prep_1'`).get() as { status: string };
    expect(row2.status).toBe("activated");
  });

  it("a confident action with everything it needs has no gaps", () => {
    expect(liteGaps(prepared().payload)).toEqual([]);
  });

  it("an explicit needs[] slot the live pass left empty is a gap too", () => {
    const gaps = liteGaps({ action: "brief", inputs: { needs: ["recipient"], recipient: "unknown" } });
    expect(gaps.map((g) => g.field)).toEqual(["recipient"]);
  });
});

describe("provider-neutral admission", () => {
  it("keeps a hard provider refusal typed and leaves the prepared row deferred", async () => {
    const row = seedPrepared(prepared());
    const provider = new StubProvider(
      [{ type: "error", code: "AUTH_EXPIRED", message: "sign in again" }],
    );
    const originalSend = provider.send.bind(provider);
    provider.send = async (request) => ({
      ...(await originalSend(request)),
      status: "error",
      errorCode: "AUTH_EXPIRED",
    });

    await expect(runPreparedAction(row, {
      provider,
      nowMs: NOW_MS,
      fetchImpl: stubFetch({}),
    })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    const stored = getDb()
      .prepare(`SELECT status FROM deferred_outputs WHERE id = ?`)
      .get(row.id) as { status: string };
    expect(stored.status).toBe("deferred");
  });
});

describe("fetching: retry the transient, replan the permanent, stop at a wall (EXE-04, EXE-05)", () => {
  const sol = "https://villas.example/sol";

  it("retries a 429 exactly once and replans a 404 without a retry", async () => {
    const row = seedPrepared(prepared());
    const provider = new StubProvider([
      toolUse("web_fetch", sol),
      toolUse("web_fetch", "https://villas.example/gone"),
      finalText({ status: "partial", questions: [] }),
      done(),
    ]);
    const res = await runPreparedAction(row, {
      provider,
      nowMs: NOW_MS,
      fetchImpl: stubFetch({
        [sol]: [
          [429, "slow down"],
          [200, "Villa Sol 5400 per night"],
        ],
        "https://villas.example/gone": [404, "no such villa"],
      }),
    });

    const ok = res.fetches.find((f) => f.url === sol)!;
    expect(ok.outcome).toBe("retried_ok");
    expect(ok.attempts).toBe(2);
    const gone = res.fetches.find((f) => f.url.endsWith("/gone"))!;
    expect(gone.outcome).toBe("permanent");
    expect(gone.attempts).toBe(1); // NOT retried
  });

  it("a login wall stops the run, refuses every later fetch and asks", async () => {
    const row = seedPrepared(prepared());
    const provider = new StubProvider([
      toolUse("web_fetch", sol),
      toolUse("web_fetch", "https://villas.example/casa"),
      finalText({ status: "done", artifact: { type: "comparison", title: "Villas", body: "x", rows: [], citations: [] } }),
      done(),
    ]);
    const res = await runPreparedAction(row, {
      provider,
      nowMs: NOW_MS,
      fetchImpl: stubFetch({
        [sol]: [200, `<form><input type="password" name="password"></form> please log in to continue`],
        "https://villas.example/casa": [200, "Casa Anjuna 6100"],
      }),
    });

    expect(res.fetches[0]!.outcome).toBe("login_wall");
    expect(res.fetches.filter((f) => f.outcome === "ok")).toHaveLength(0);
    expect(res.refusals.map((r) => r.reason)).toContain("login_wall");
    expect(res.status).toBe("blocked");
    expect(res.questions.some((q) => q.field.includes("villas.example"))).toBe(true);
    expect(questionsOf()).toHaveLength(1);
  });

  it("refuses a private host outright", async () => {
    const row = seedPrepared(prepared());
    const provider = new StubProvider([toolUse("web_fetch", "http://127.0.0.1:8013/api"), finalText({ status: "partial" }), done()]);
    const res = await runPreparedAction(row, { provider, nowMs: NOW_MS, fetchImpl: stubFetch({}) });
    expect(res.invocations[0]!.status).toBe("error");
    expect(res.invocations[0]!.detail).toMatch(/private host/);
  });
});

describe("artifacts carry evidence (EXE-03)", () => {
  const sol = "https://villas.example/sol";

  it("keeps a citation the run fetched and drops one it never opened", () => {
    const grounded = groundArtifact(
      {
        type: "comparison",
        title: "Villas",
        body: "",
        rows: [],
        citations: [
          { url: sol, event_ids: ["ev_1"] },
          { url: "https://invented.example/never", event_ids: [] },
          { url: null, event_ids: ["ev_ghost"] },
        ],
      },
      { fetchedUrls: new Set([normaliseUrl(sol)]), eventIds: new Set(["ev_1"]) },
    );
    expect(grounded.dropped).toBe(2);
    expect(grounded.artifact.citations).toEqual([{ url: sol, event_ids: ["ev_1"] }]);
    expect(grounded.ok).toBe(true);
  });

  it("writes the artifact with its surviving citations and drops the fabricated one", async () => {
    const row = seedPrepared(prepared());
    const provider = new StubProvider([
      toolUse("web_fetch", sol),
      finalText({
        status: "done",
        criteria: ["2 villas on price and pool"],
        artifact: {
          type: "comparison",
          title: "Anjuna villas, 18-21 Dec",
          body: "| villa | price |\n|---|---|\n| Sol | 5400 |",
          rows: [{ name: "Villa Sol", price_night: 5400 }],
          citations: [
            { url: sol, event_ids: ["ev_1"] },
            { url: "https://invented.example/casa", event_ids: ["ev_nope"] },
          ],
        },
      }),
      done(),
    ]);
    const res = await runPreparedAction(row, {
      provider,
      nowMs: NOW_MS,
      fetchImpl: stubFetch({ [sol]: [200, "Villa Sol 5400 per night"] }),
    });

    expect(res.status).toBe("done");
    expect(res.droppedCitations).toBe(1);
    expect(res.artifact?.citations).toEqual([{ url: sol, event_ids: ["ev_1"] }]);
    const cards = artifactsOf();
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("comparison");
    const body = JSON.parse(String(cards[0].body_json)) as { citations: unknown[]; gaps: string[] };
    expect(body.citations).toHaveLength(1);
    expect(body.gaps.join(" ")).toContain("never opened");
  });

  it("an artifact whose every citation is invented is a partial, not a done", async () => {
    const row = seedPrepared(prepared());
    const provider = new StubProvider([
      finalText({
        status: "done",
        artifact: { type: "comparison", title: "Villas", body: "trust me", rows: [], citations: [{ url: "https://invented.example/x", event_ids: [] }] },
      }),
      done(),
    ]);
    const res: LiteRunResult = await runPreparedAction(row, { provider, nowMs: NOW_MS, fetchImpl: stubFetch({}) });
    expect(res.status).toBe("partial");
    expect(res.artifact?.citations).toEqual([]);
    expect(res.gaps.join(" ")).toContain("no evidence");
  });
});
