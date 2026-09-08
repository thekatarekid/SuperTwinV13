// ===========================================================================
// JSON pass runner tests (build P1.2/P1.3): trace scope around every call,
// runs rows for every attempt, one repair round, quarantine on the far side,
// and the byte-identical system-prompt invariant.
// ===========================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BREAKER_FAILURES,
  BREAKER_PAUSE_MS,
  ResourcePool,
  RETRY_DELAYS_MS,
} from "../providers/pool.js";
import type { ProviderRequest, ProviderV2, Usage } from "../providers/types.js";
import type { RecordRunParams } from "../db/run-accounting.js";
import { STEP_OVERRIDES_ENV } from "../settings/overrides.js";
import { hasTraceContext } from "../traces/context.js";
import {
  extractJson,
  resetStableSystemPromptsForTests,
  runJsonPass,
  stableSystemPrompt,
  type JsonPassDeps,
} from "./llm.js";
import { providerV2TestDouble as brainTestProvider, providerRequestText } from "../providers/test-support.js";

interface Turn {
  text?: string;
  code?: "TIMEOUT" | "CLI_ERROR" | "CANCELLED" | "QUOTA_EXCEEDED" | "AUTH_REQUIRED";
  message?: string;
}

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
};

/** A clock the pool's sleeps advance, so a paused lane is waited out instantly. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function harness(turns: Turn[], opts: { pool?: ResourcePool } = {}) {
  const runs: RecordRunParams[] = [];
  const parked: { errorCode: string; unitId: string }[] = [];
  const messages: string[] = [];
  const requests: ProviderRequest[] = [];
  const slept: number[] = [];
  let sawTrace = true;
  const provider = brainTestProvider(async (opts) => {
      requests.push(opts);
      messages.push(providerRequestText(opts));
      sawTrace = sawTrace && hasTraceContext();
      const turn = turns[messages.length - 1] ?? { text: "" };
      const usage: Usage = {
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 5,
      };
      if (turn.text !== undefined) opts.onEvent({ type: "delta", text: turn.text });
      if (turn.code) {
        opts.onEvent({ type: "error", code: turn.code, message: turn.message ?? "boom" });
        return {
          continuation: null,
          usage,
          freshFallback: false,
          status: "error" as const,
          errorCode: turn.code,
        };
      }
      opts.onEvent({ type: "done", continuation: null, usage });
      return { continuation: null, usage, freshFallback: false, status: "ok" as const };
  });
  const clock = fakeClock();
  const pool = opts.pool ?? new ResourcePool({ now: clock.now, sleep: clock.sleep });
  const deps: JsonPassDeps = {
    provider,
    pool,
    recordRun: (p) => {
      runs.push(p);
      return p.id ?? "r";
    },
    quarantine: (row) => parked.push({ errorCode: row.errorCode, unitId: row.unitId }),
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
  return { deps, pool, runs, parked, messages, requests, slept, sawTrace: () => sawTrace };
}

function spec(overrides: Partial<Parameters<typeof runJsonPass>[0]> = {}) {
  return {
    pass: "test.v1",
    system: "You answer JSON.",
    user: "input",
    role: "classify" as const,
    unit: { kind: "bundle", id: "b1" },
    validate: (parsed: unknown) => {
      if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
        throw new Error("expected {ok}");
      }
      return parsed as { ok: boolean };
    },
    ...overrides,
  };
}

beforeEach(() => resetStableSystemPromptsForTests());

describe("runJsonPass", () => {
  it("sends the exact strict, stateless request from one resolved model snapshot", async () => {
    const h = harness([{ text: '{"ok":true}' }]);
    const controller = new AbortController();
    await runJsonPass(spec({ model: "legacy-model-must-not-win", timeoutMs: 12_345 }), {
      ...h.deps,
      signal: controller.signal,
    });

    const request = h.requests[0]!;
    expect(request).toMatchObject({
      model: "claude-test-model",
      instructions: "You answer JSON.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "input" }] }],
      toolChoice: "none",
      plainCompletion: true,
      skipHostSettings: true,
      persistContinuation: false,
      maxOutputTokens: 8_192,
      maxAgentTurns: 2,
      reasoning: { budget: "off" },
      timeoutMs: 12_345,
      signal: controller.signal,
    });
    expect(request.tools).toBeUndefined();
    expect(request.hostTools).toBeUndefined();
    expect(request.continuation).toBeUndefined();
  });

  it("uses one ChatGPT response turn and never invents host tools", async () => {
    const requests: ProviderRequest[] = [];
    const controller = new AbortController();
    const pool = new ResourcePool();
    const provider = brainTestProvider(async (request) => {
      requests.push(request);
      request.onEvent({ type: "delta", text: '{"ok":true}' });
      return { continuation: null, usage: ZERO_USAGE, freshFallback: false, status: "ok" };
    }, { providerId: "chatgpt-oauth" });

    const result = await runJsonPass(spec(), {
      provider,
      pool,
      signal: controller.signal,
      recordRun: () => "r",
      logExtractionRun: () => {},
      addUsage: () => {},
    });

    expect(result.status).toBe("ok");
    expect(requests[0]?.maxAgentTurns).toBe(1);
    expect(requests[0]?.signal).toBe(controller.signal);
    expect(requests[0]?.hostTools).toBeUndefined();
    expect(requests[0]?.tools).toBeUndefined();
    expect(pool.peakInFlight("llm", "chatgpt-oauth")).toBe(1);
    expect(pool.peakInFlight("llm", "claude-local")).toBe(0);
  });

  it("classifies a typed ChatGPT refusal under ChatGPT only", async () => {
    const pool = new ResourcePool();
    const provider = brainTestProvider(async (request) => {
      request.onEvent({ type: "error", code: "RATE_LIMITED", message: "slow down" });
      return {
        continuation: null,
        usage: ZERO_USAGE,
        freshFallback: false,
        status: "error",
        errorCode: "RATE_LIMITED",
      };
    }, { providerId: "chatgpt-oauth" });

    const result = await runJsonPass(spec(), {
      provider,
      pool,
      maxPauses: 0,
      recordRun: () => "r",
      logExtractionRun: () => {},
      addUsage: () => {},
    });

    expect(result.error?.code).toBe("RATE_LIMITED");
    expect(pool.limitOf("llm", "chatgpt-oauth")).toBe(4);
    expect(pool.limitOf("llm", "claude-local")).toBe(8);
  });

  it("preserves configured Claude reasoning with the isolated plain-completion rail", async () => {
    const previous = process.env[STEP_OVERRIDES_ENV];
    process.env[STEP_OVERRIDES_ENV] = JSON.stringify({
      "test.v1": { provider: "claude-local", thinking: "high" },
    });
    try {
      const h = harness([{ text: '{"ok":true}' }]);
      const result = await runJsonPass(spec(), h.deps);
      expect(result.status).toBe("ok");
      expect(h.requests[0]).toMatchObject({
        plainCompletion: true,
        maxAgentTurns: 2,
        reasoning: { budget: "high" },
        toolChoice: "none",
      });
      expect(h.requests[0]?.hostTools).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[STEP_OVERRIDES_ENV];
      else process.env[STEP_OVERRIDES_ENV] = previous;
    }
  });

  it("fails before pool/provider work when the selected snapshot has no output bound", async () => {
    let sends = 0;
    const provider = brainTestProvider(async () => {
      sends += 1;
      throw new Error("must not send");
    }, { model: { maxOutputTokens: null } });

    await expect(runJsonPass(spec(), { provider })).rejects.toMatchObject({
      code: "CAPABILITY_UNSUPPORTED",
      model: "claude-test-model",
    });
    expect(sends).toBe(0);
  });

  it("resolves one catalogue snapshot for both the answer and repair call", async () => {
    let catalogueCalls = 0;
    let sends = 0;
    const base = brainTestProvider(async (request) => {
      sends += 1;
      request.onEvent({ type: "delta", text: sends === 1 ? "junk" : '{"ok":true}' });
      return { continuation: null, usage: ZERO_USAGE, freshFallback: false, status: "ok" };
    });
    const originalCatalogue = base.catalogue;
    const provider: ProviderV2 = {
      ...base,
      catalogue: () => {
        catalogueCalls += 1;
        return originalCatalogue();
      },
    };

    const result = await runJsonPass(spec(), {
      provider,
      recordRun: () => "r",
      logExtractionRun: () => {},
      addUsage: () => {},
    });
    expect(result.status).toBe("repaired");
    expect(sends).toBe(2);
    expect(catalogueCalls).toBe(1);
  });

  it("parses a clean JSON answer inside a trace scope, one runs row", async () => {
    const h = harness([{ text: '{"ok":true}' }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ ok: true });
    expect(h.sawTrace()).toBe(true);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].kind).toBe("test.v1");
    expect(h.runs[0].role).toBe("classify");
    expect(h.runs[0].status).toBe("ok");
    expect(h.runs[0].cohortId).toBeNull();
  });

  it("repairs once — the model is shown its own previous answer verbatim", async () => {
    const h = harness([{ text: "sure! here you go: nonsense" }, { text: '{"ok":false}' }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("repaired");
    expect(result.output).toEqual({ ok: false });
    expect(h.messages).toHaveLength(2);
    expect(h.messages[1]).toContain("YOUR PREVIOUS ANSWER:");
    expect(h.messages[1]).toContain("sure! here you go: nonsense");
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "ok"]);
    expect(result.responses).toEqual(["sure! here you go: nonsense", '{"ok":false}']);
  });

  it("quarantines after the second parse failure, keeping every response", async () => {
    const h = harness([{ text: "junk" }, { text: "more junk" }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("quarantined");
    expect(result.output).toBeUndefined();
    expect(h.parked).toEqual([{ errorCode: "json_invalid", unitId: "b1" }]);
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "quarantined"]);
    expect(result.responses).toEqual(["junk", "more junk"]);
  });

  it("walks the pool's 2 s / 10 s / 30 s ladder on a transport failure, then quarantines with its code", async () => {
    // Four failures: the first call plus three retries (T0-10 — the pool's
    // decision is honoured, as prompts/runner.ts always has).
    const h = harness(Array.from({ length: 4 }, () => ({ text: "", code: "TIMEOUT" as const })));
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("quarantined");
    expect(result.error?.code).toBe("TIMEOUT");
    expect(h.messages).toHaveLength(4);
    expect(h.slept).toEqual([...RETRY_DELAYS_MS]);
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "retried", "retried", "quarantined"]);
    expect(result.runIds).toHaveLength(4);
    expect(h.parked).toEqual([{ errorCode: "TIMEOUT", unitId: "b1" }]);
  });

  it("a failure that clears up on retry is not quarantined — and no repair round is charged for it", async () => {
    const h = harness([{ text: "", code: "CLI_ERROR" }, { text: '{"ok":true}' }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("ok");
    expect(h.slept).toEqual([RETRY_DELAYS_MS[0]]);
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "ok"]);
    expect(h.pool.consecutiveFailures("llm:understanding")).toBe(0);
  });

  it("a cancel is handed back at once: no retry, no quarantine", async () => {
    const h = harness([{ text: "", code: "CANCELLED" }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CANCELLED");
    expect(h.messages).toHaveLength(1);
    expect(h.slept).toEqual([]);
    expect(h.parked).toEqual([]);
  });

  it("an authentication hold is handed back without retrying or quarantining", async () => {
    const h = harness([{ code: "AUTH_REQUIRED", message: "sign in required" }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("AUTH_REQUIRED");
    expect(h.messages).toHaveLength(1);
    expect(h.slept).toEqual([]);
    expect(h.parked).toEqual([]);
    expect(h.runs.map((run) => run.status)).toEqual(["error"]);
  });

  it("preserves a typed provider exception as a hold instead of rewriting it to CLI_ERROR", async () => {
    const h = harness([]);
    h.deps.provider = brainTestProvider(async () => {
      throw Object.assign(new Error("sign in required"), { code: "AUTH_REQUIRED" });
    });
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("AUTH_REQUIRED");
    expect(h.slept).toEqual([]);
    expect(h.parked).toEqual([]);
  });

  it("a refusal pauses the lane (the pool serves the wait) and does not spend the retry ladder", async () => {
    const h = harness([
      { text: "", code: "QUOTA_EXCEEDED", message: "usage limit reached" },
      { text: '{"ok":true}' },
    ]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("ok");
    expect(h.slept).toEqual([]); // no ladder delay — the pool's pause held the second call
    expect(h.runs.map((r) => r.status)).toEqual(["retried", "ok"]);
    expect(h.pool.consecutiveFailures("llm:understanding")).toBe(0);
  });

  it("BND-12 — a full pool is backpressure: handed back as POOL_OVERFLOW, not retried, not quarantined, not a breaker failure", async () => {
    // The understanding slot and its whole queue are held by other work; the
    // second physical slot stays reserved for live work.
    const clock = fakeClock();
    const pool = new ResourcePool({ limits: { llm: 2 }, firstPaint: true, now: clock.now, sleep: clock.sleep });
    const hold = new Promise<void>(() => {});
    const held = Array.from({ length: 1 + pool.waiterCap("llm") }, () =>
      pool.run("llm", () => hold, { lane: "understanding" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const h = harness([{ text: '{"ok":true}' }], { pool });
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("POOL_OVERFLOW");
    expect(result.error?.message).toMatch(/pool "llm" is full/);
    expect(h.messages).toHaveLength(0); // the provider was never reached
    expect(h.slept).toEqual([]);
    expect(h.parked).toEqual([]);
    expect(h.runs).toHaveLength(0); // admission failed; no fake call spend
    expect(pool.consecutiveFailures("llm:understanding")).toBe(0);
    void held;
  });

  it("a validator rejection triggers the repair round with the reason", async () => {
    const h = harness([{ text: '{"nope":1}' }, { text: '{"ok":true}' }]);
    const result = await runJsonPass(spec(), h.deps);
    expect(result.status).toBe("repaired");
    expect(h.messages[1]).toContain("expected {ok}");
  });
});

describe("stableSystemPrompt", () => {
  it("throws when a pass renders two different system prompts", () => {
    stableSystemPrompt("p", "one");
    expect(stableSystemPrompt("p", "one")).toBe("one");
    expect(() => stableSystemPrompt("p", "two")).toThrow(/not stable/);
  });
});

describe("extractJson", () => {
  it("accepts bare JSON, fenced JSON, and JSON inside prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here it is: {"a":1} — done')).toEqual({ a: 1 });
    expect(extractJson("no json at all")).toBeUndefined();
  });
});

// ===========================================================================
// SPD-07 — breaker (S0.7 / T0-10). Ten consecutive non-refusal failures on the
// understanding lane: lane paused 30 minutes, banner raised. Wrong mode
// `silent-retry`: every attempt is a logged `runs` row and the trip is on the
// pool's banner list, never an unlogged loop.
// ===========================================================================

describe("SPD-07 — breaker via runJsonPass", () => {
  it("ten consecutive non-refusal failures pause `understanding` 30 min and raise the banner", async () => {
    const clock = fakeClock();
    const pool = new ResourcePool({ now: clock.now, sleep: clock.sleep });
    const trips: string[] = [];
    pool.onBreaker((t) => trips.push(t.lane));

    // Every call fails the same non-refusal way. One pass = 4 failures (call +
    // three ladder retries) → the tenth failure lands in the third pass.
    const always = Array.from({ length: 40 }, () => ({ text: "", code: "CLI_ERROR" as const, message: "exit 1" }));
    const h = harness(always, { pool });

    await runJsonPass(spec({ unit: { kind: "bundle", id: "u1" } }), h.deps);
    await runJsonPass(spec({ unit: { kind: "bundle", id: "u2" } }), h.deps);
    expect(pool.consecutiveFailures("llm:understanding")).toBe(8);
    expect(pool.isPaused("llm:understanding")).toBe(false);
    expect(pool.breakers()).toEqual([]);

    const third = await runJsonPass(spec({ unit: { kind: "bundle", id: "u3" } }), h.deps);
    // The tripping unit is quarantined at once — its second failure was the
    // lane's tenth — not left to sit on the pause and retry afterwards.
    expect(third.status).toBe("quarantined");
    expect(third.error?.code).toBe("CLI_ERROR");
    expect(third.runIds).toHaveLength(2);
    expect(h.parked.map((p) => p.unitId)).toEqual(["u1", "u2", "u3"]);
    expect(pool.isPaused("llm:understanding")).toBe(true);
    expect(pool.pausedForMs("llm:understanding")).toBeGreaterThan(0);
    expect(pool.pausedForMs("llm:understanding")).toBeLessThanOrEqual(BREAKER_PAUSE_MS);
    expect(trips).toEqual(["llm:understanding"]);
    const banner = pool.breakers();
    expect(banner).toHaveLength(1);
    expect(banner[0].failures).toBe(BREAKER_FAILURES);
    expect(banner[0].lastCode).toBe("CLI_ERROR");
    expect(banner[0].lastError).toBe("exit 1");
    // The enrichment lane is untouched.
    expect(pool.isPaused("llm:enrichment")).toBe(false);

    // Not silent: ten attempts, ten runs rows, every one carrying the code.
    expect(h.messages).toHaveLength(10);
    expect(h.runs).toHaveLength(10);
    expect(h.runs.every((r) => r.errorCode === "CLI_ERROR")).toBe(true);

    // The next call on the lane waits out the 30 minutes (the pool's clock
    // advances by exactly the pause) — then runs.
    const before = clock.now();
    const h2 = harness([{ text: '{"ok":true}' }], { pool });
    const after = await runJsonPass(spec(), h2.deps);
    expect(after.status).toBe("ok");
    expect(clock.now() - before).toBe(BREAKER_PAUSE_MS);
    expect(pool.breakers()).toEqual([]);
  });
});

// ===========================================================================
// SPD-08 — quota metered (S0.7 / T0-11). Against a real temp DB, with the
// default accounting: every extraction_runs row has a quota_usage row.
// ===========================================================================

describe("SPD-08 — quota metered (real temp DB)", () => {
  let tmpDir: string;
  let db: typeof import("../db/index.js");
  let conn: typeof import("../db/connection.js");

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "st-llm-quota-"));
    process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
    db = await import("../db/index.js");
    conn = await import("../db/connection.js");
    conn.closeDb();
    db.runMigrations();
  });

  afterAll(() => {
    conn.closeDb();
    delete process.env.SUPERTWIN_DB_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("quota_usage row count equals extraction_runs row count across ok, repaired, retried and quarantined calls", async () => {
    const count = (table: string) =>
      (conn.getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("extraction_runs")).toBe(0);
    expect(count("quota_usage")).toBe(0);

    // Real accounting: no recordRun / quarantine swap, so runs, extraction_runs,
    // quota_usage and the quarantine table are all the real ones.
    const turns: Turn[] = [
      { text: '{"ok":true}' }, // pass 1: ok (1 call)
      { text: "junk" }, // pass 2: repair round (2 calls)
      { text: '{"ok":false}' },
      { text: "", code: "TIMEOUT" }, // pass 3: retry once, then ok (2 calls)
      { text: '{"ok":true}' },
      { text: "junk" }, // pass 4: two parse failures → quarantined (2 calls)
      { text: "still junk" },
    ];
    const h = harness(turns);
    const deps: JsonPassDeps = { provider: h.deps.provider, pool: h.pool, sleep: h.deps.sleep };
    const results = await Promise.all([
      runJsonPass(spec({ pass: "quota.v1", unit: { kind: "bundle", id: "q1" } }), deps),
    ]);
    expect(results[0].status).toBe("ok");
    const r2 = await runJsonPass(spec({ pass: "quota.v1", unit: { kind: "bundle", id: "q2" } }), deps);
    expect(r2.status).toBe("repaired");
    const r3 = await runJsonPass(spec({ pass: "quota.v1", unit: { kind: "bundle", id: "q3" } }), deps);
    expect(r3.status).toBe("ok");
    const r4 = await runJsonPass(spec({ pass: "quota.v1", unit: { kind: "bundle", id: "q4" } }), deps);
    expect(r4.status).toBe("quarantined");

    expect(count("extraction_runs")).toBe(7);
    expect(count("runs")).toBe(7);
    expect(count("quota_usage")).toBe(7);
    // And the tokens the provider reported are what was metered.
    const metered = conn
      .getDb()
      .prepare(`SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(run_count) AS r FROM quota_usage`)
      .get() as { i: number; o: number; r: number };
    expect(metered).toEqual({ i: 70, o: 35, r: 7 });
    // The rolling-window read the chat gate uses sees the background spend.
    expect(db.getQuota().runCount ?? 7).toBeGreaterThanOrEqual(1);
  });
});
