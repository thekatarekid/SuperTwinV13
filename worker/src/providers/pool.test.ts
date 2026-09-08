// ===========================================================================
// Per-resource-class concurrency (arch §4.4.1–§4.4.3, §4.6).
//
// Three things are worth testing here and they are all observable without a
// real model call: the caps actually hold under concurrent load, warm-first
// serialises the first call of a batch (evals U-013 / U-014), and a refusal
// pauses the lane WITHOUT spending the unit's retry budget (§4.6).
// ===========================================================================

import { describe, it, expect } from "vitest";

import {
  classifyFailure,
  clampLimit,
  isRefusal,
  laneCaps,
  refusalBackoffMs,
  ResourcePool,
  RESOURCE_LIMITS,
  RETRY_DELAYS_MS,
  Semaphore,
  REFUSAL_BACKOFF_BASE_MS,
  REFUSAL_BACKOFF_MAX_MS,
  DB_APPLY_CONCURRENCY,
  CHATGPT_ADAPTIVE_MIN,
  CHATGPT_MEMORY_PRESSURE_RATIO,
  CHATGPT_RAMP_INTERVAL_MS,
  DEGRADE_WINDOW_MS,
  PoolCancelledError,
  PROVIDER_LLM_LIMITS,
} from "./pool.js";

/** A task that records overlap: returns after `ms`, tracking peak concurrency. */
function tracker() {
  let live = 0;
  let peak = 0;
  const order: string[] = [];
  const task = (name: string, ms = 5) => async () => {
    live += 1;
    if (live > peak) peak = live;
    order.push(`start:${name}`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`end:${name}`);
    live -= 1;
    return name;
  };
  return {
    task,
    get peak() {
      return peak;
    },
    order,
  };
}

describe("the limit table (§4.4.1)", () => {
  it("carries the documented default and max per class", () => {
    expect(RESOURCE_LIMITS).toEqual({
      llm: { default: 8, max: 16 },
      transcribe: { default: 1, max: 3 },
      embed: { default: 2, max: 8 },
      ffmpeg: { default: 2, max: 4 },
      scrape: { default: 8, max: 16 },
    });
    // SQLite is a single writer — not a setting.
    expect(DB_APPLY_CONCURRENCY).toBe(1);
    expect(PROVIDER_LLM_LIMITS).toEqual({
      "claude-local": { default: 8, max: 16 },
      "chatgpt-oauth": { default: 8, max: 16 },
    });
  });

  it("clamps a user setting into [1, max] rather than trusting it", () => {
    expect(clampLimit("llm", 99)).toBe(16);
    expect(clampLimit("llm", 0)).toBe(1);
    expect(clampLimit("transcribe", 16)).toBe(3); // sixteen whispers thrash
    expect(clampLimit("ffmpeg", 3)).toBe(3);
    expect(clampLimit("embed", Number.NaN)).toBe(2);
  });
});

describe("Semaphore", () => {
  it("never lets more than `limit` holders in at once", async () => {
    const sem = new Semaphore(3);
    const t = tracker();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => sem.run(t.task(`t${i}`))),
    );
    expect(t.peak).toBe(3);
    expect(sem.inFlight).toBe(0);
  });

  it("releases a queued waiter when a limit is raised", async () => {
    const sem = new Semaphore(0);
    let ran = false;
    const p = sem.run(() => {
      ran = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toBe(false);
    sem.setLimit(1);
    await p;
    expect(ran).toBe(true);
  });

  it("a double release never over-credits the pool", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.inFlight).toBe(0);
  });
});

describe("caps hold under concurrent load", () => {
  it("caps each class independently", async () => {
    const pool = new ResourcePool();
    const llm = tracker();
    const whisper = tracker();
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => pool.run("llm", llm.task(`l${i}`))),
      // 5 = one slot plus the 4× waiter cap (BND-12); a sixth would be rejected.
      ...Array.from({ length: 5 }, (_, i) =>
        pool.run("transcribe", whisper.task(`w${i}`)),
      ),
    ]);
    expect(llm.peak).toBeLessThanOrEqual(8);
    expect(whisper.peak).toBe(1);
  });

  it("honours a configured ceiling, clamped to the table max", async () => {
    const pool = new ResourcePool({ warmFirst: false });
    pool.configure({ llm: 99, embed: 4 });
    expect(pool.limitOf("llm")).toBe(16);
    expect(pool.limitOf("embed")).toBe(4);
    const t = tracker();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => pool.run("embed", t.task(`e${i}`))),
    );
    expect(t.peak).toBe(4);
  });
});

describe("Phase 5 provider-keyed adaptive LLM pool", () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("keeps independent provider ceilings and clamps each to 16", () => {
    const pool = new ResourcePool({
      providerLimits: { "claude-local": 3, "chatgpt-oauth": 99 },
    });
    expect(pool.limitOf("llm", "claude-local")).toBe(3);
    expect(pool.limitOf("llm", "chatgpt-oauth")).toBe(16);
    pool.configureProviderLlm("chatgpt-oauth", 6);
    expect(pool.limitOf("llm", "chatgpt-oauth")).toBe(6);
    expect(pool.limitOf("llm", "claude-local")).toBe(3);
  });

  it("clamps every ChatGPT configuration path to one runnable slot per lane", async () => {
    const constructed = new ResourcePool({
      providerLimits: { "claude-local": 1, "chatgpt-oauth": 1 },
      warmFirst: false,
    });
    expect(constructed.limitOf("llm", "claude-local")).toBe(1);
    expect(constructed.limitOf("llm", "chatgpt-oauth")).toBe(CHATGPT_ADAPTIVE_MIN);

    constructed.configureProviderLlm("chatgpt-oauth", 2);
    expect(constructed.limitOf("llm", "chatgpt-oauth")).toBe(CHATGPT_ADAPTIVE_MIN);
    constructed.configure({ llm: 1 });
    expect(constructed.limitOf("llm", "claude-local")).toBe(1);
    expect(constructed.limitOf("llm", "chatgpt-oauth")).toBe(CHATGPT_ADAPTIVE_MIN);

    await expect(Promise.all([
      constructed.run("llm", () => "live", { providerId: "chatgpt-oauth", lane: "live" }),
      constructed.run("llm", () => "understanding", { providerId: "chatgpt-oauth", lane: "understanding" }),
      constructed.run("llm", () => "enrichment", { providerId: "chatgpt-oauth", lane: "enrichment" }),
    ])).resolves.toEqual(["live", "understanding", "enrichment"]);
  });

  it("sustains eight ChatGPT streams with a reserved live slot and bounded background", async () => {
    const pool = new ResourcePool({ warmFirst: false });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = [
      pool.run("llm", () => gate, { providerId: "chatgpt-oauth", lane: "live" }),
      ...Array.from({ length: 3 }, () =>
        pool.run("llm", () => gate, { providerId: "chatgpt-oauth", lane: "enrichment" })),
      ...Array.from({ length: 4 }, () =>
        pool.run("llm", () => gate, { providerId: "chatgpt-oauth", lane: "understanding" })),
    ];
    await tick();
    expect(pool.inFlight("llm", "chatgpt-oauth")).toBe(8);
    expect(pool.laneLimit("live", "chatgpt-oauth")).toBe(1);
    expect(pool.lanePeakInFlight("enrichment", "chatgpt-oauth")).toBe(3);
    expect(pool.lanePeakInFlight("understanding", "chatgpt-oauth")).toBe(4);
    expect(pool.inFlight("llm", "claude-local")).toBe(0);
    release();
    await Promise.all(running);
    expect(pool.inFlight("llm", "chatgpt-oauth")).toBe(0);
  });

  it("does not let one provider's saturated queue consume the other's waiters", async () => {
    const pool = new ResourcePool({ providerLimits: { "claude-local": 3, "chatgpt-oauth": 1 } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const claude = Array.from({ length: 5 }, () =>
      pool.run("llm", () => gate, { providerId: "claude-local", lane: "understanding" }));
    await tick();
    await expect(pool.run("llm", () => "gpt", {
      providerId: "chatgpt-oauth", lane: "live",
    })).resolves.toBe("gpt");
    expect(pool.waiting("llm")).toBeGreaterThan(0);
    expect(pool.providerMetrics("chatgpt-oauth").waiting).toBe(0);
    release();
    await Promise.all(claude);
  });

  it("reduces only ChatGPT on quota and repeated transport failures", () => {
    const pool = new ResourcePool();
    pool.noteFailure("llm:understanding", { code: "TRANSPORT_ERROR" }, 0, "chatgpt-oauth");
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(8);
    pool.noteFailure("llm:understanding", { code: "TRANSPORT_ERROR" }, 1, "chatgpt-oauth");
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(4);
    pool.noteFailure("llm:enrichment", { code: "QUOTA_EXCEEDED" }, 0, "chatgpt-oauth");
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(3);
    expect(pool.effectiveLlmLimit("claude-local")).toBe(8);
  });

  it("keeps one runnable slot per lane at the adaptive floor", async () => {
    const pool = new ResourcePool();
    pool.noteFailure("llm:understanding", { code: "RATE_LIMITED" }, 0, "chatgpt-oauth");
    pool.noteFailure("llm:enrichment", { code: "QUOTA_EXCEEDED" }, 0, "chatgpt-oauth");
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(3);
    expect(laneCaps(3, false)).toEqual({ live: 1, enrichment: 1, understanding: 1 });
    pool.resumeLane("llm:understanding", "chatgpt-oauth");
    pool.resumeLane("llm:enrichment", "chatgpt-oauth");

    await expect(Promise.all([
      pool.run("llm", () => "live", { providerId: "chatgpt-oauth", lane: "live" }),
      pool.run("llm", () => "understanding", { providerId: "chatgpt-oauth", lane: "understanding" }),
      pool.run("llm", () => "enrichment", { providerId: "chatgpt-oauth", lane: "enrichment" }),
    ])).resolves.toEqual(["live", "understanding", "enrichment"]);
  });

  it("uses measured memory pressure and waits for a fresh slow-ramp window after relief", () => {
    let now = 0;
    const limit = 1_000;
    const pool = new ResourcePool({ now: () => now, memoryLimitBytes: limit, rssBytes: () => 100 });
    const pressured = pool.observeProvider({
      providerId: "chatgpt-oauth",
      rssBytes: Math.ceil(limit * CHATGPT_MEMORY_PRESSURE_RATIO),
      queueDepth: 12,
      latencyMs: 345,
    });
    expect(pressured).toMatchObject({ effectiveLimit: 4, memoryPressure: true, lastQueueDepth: 12, lastLatencyMs: 345 });
    now += DEGRADE_WINDOW_MS * 3;
    pool.observeProvider({ providerId: "chatgpt-oauth", rssBytes: 100 });
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(4);
    now += DEGRADE_WINDOW_MS;
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(5);
  });

  it("samples production RSS at pool boundaries and rate-limits repeated pressure reductions", async () => {
    let now = 0;
    let rss = 900;
    const pool = new ResourcePool({
      now: () => now,
      rssBytes: () => rss,
      memoryLimitBytes: 1_000,
    });

    await pool.run("llm", () => undefined, {
      providerId: "chatgpt-oauth",
      lane: "live",
    });
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(4);
    await pool.run("llm", () => undefined, {
      providerId: "chatgpt-oauth",
      lane: "live",
    });
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(4);

    now += DEGRADE_WINDOW_MS;
    await pool.run("llm", () => undefined, {
      providerId: "chatgpt-oauth",
      lane: "live",
    });
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(3);
    rss = 100;
    expect(pool.observeProvider({ providerId: "chatgpt-oauth" })).toMatchObject({
      memoryPressure: false,
      lastQueueDepth: 0,
    });
  });

  it("ramps only one slot after a long idle period instead of treating time as health", () => {
    let now = 0;
    const pool = new ResourcePool({ now: () => now });
    pool.noteFailure("llm:understanding", { code: "RATE_LIMITED" }, 0, "chatgpt-oauth");
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(4);

    now += DEGRADE_WINDOW_MS + 24 * 60 * 60_000;
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(5);
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(5);
    now += CHATGPT_RAMP_INTERVAL_MS;
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(6);
  });

  it("honours a bounded Retry-After without spending retry budget", () => {
    let now = 0;
    const pool = new ResourcePool({ now: () => now });
    const decision = pool.noteFailure("llm:understanding", {
      code: "RATE_LIMITED", retryAfterMs: 123_000,
    }, 0, "chatgpt-oauth");
    expect(decision).toMatchObject({ action: "pause", waitMs: 123_000, spendsRetryBudget: false });
    expect(pool.pausedForMs("llm:understanding", "chatgpt-oauth")).toBe(123_000);
    expect(pool.isPaused("llm:understanding", "claude-local")).toBe(false);
    now += 123_000;
    expect(pool.isPaused("llm:understanding", "chatgpt-oauth")).toBe(false);
  });

  it("removes an aborted queued caller and releases a cooperatively aborted active slot", async () => {
    const pool = new ResourcePool({ providerLimits: { "chatgpt-oauth": 1 } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = pool.run("llm", () => gate, { providerId: "chatgpt-oauth", lane: "live" });
    await tick();
    const queuedAbort = new AbortController();
    const queued = pool.run("llm", () => "never", {
      providerId: "chatgpt-oauth", lane: "live", signal: queuedAbort.signal,
    });
    await tick();
    expect(pool.providerMetrics("chatgpt-oauth").waiting).toBe(1);
    queuedAbort.abort();
    await expect(queued).rejects.toBeInstanceOf(PoolCancelledError);
    expect(pool.providerMetrics("chatgpt-oauth").waiting).toBe(0);
    release();
    await active;
    expect(pool.inFlight("llm", "chatgpt-oauth")).toBe(0);

    const activeAbort = new AbortController();
    const cooperative = pool.run("llm", () => new Promise<void>((_resolve, reject) => {
      activeAbort.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), { providerId: "chatgpt-oauth", lane: "live", signal: activeAbort.signal });
    await tick();
    expect(pool.inFlight("llm", "chatgpt-oauth")).toBe(1);
    activeAbort.abort();
    await expect(cooperative).rejects.toThrow("aborted");
    expect(pool.inFlight("llm", "chatgpt-oauth")).toBe(0);
  });
});

describe("the LLM pool is split by lane (§4.4.1.1)", () => {
  it("splits 40 % enrichment / 60 % understanding", () => {
    // V6 S3.3: one slot is reserved for the live lane; the 40/60 split is over the rest.
    expect(laneCaps(8, false)).toEqual({ live: 1, enrichment: 3, understanding: 4 });
    expect(laneCaps(16, false)).toEqual({ live: 1, enrichment: 6, understanding: 9 });
    // At low limits the live reservation still wins. Background work remains
    // queued instead of occupying the only interactive slot.
    expect(laneCaps(2, false)).toEqual({ live: 1, enrichment: 0, understanding: 1 });
    expect(laneCaps(1, false)).toEqual({ live: 1, enrichment: 0, understanding: 0 });
  });

  it("a photo backlog cannot starve extraction", async () => {
    const pool = new ResourcePool({ warmFirst: false });
    const enrich = tracker();
    const understand = tracker();
    await Promise.all([
      ...Array.from({ length: 30 }, (_, i) =>
        pool.run("llm", enrich.task(`c${i}`), { lane: "enrichment" }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        pool.run("llm", understand.task(`x${i}`), { lane: "understanding" }),
      ),
    ]);
    expect(enrich.peak).toBeLessThanOrEqual(3);
    expect(understand.peak).toBeGreaterThan(0);
  });

  it("first paint gives enrichment zero and hands it back afterwards", async () => {
    const pool = new ResourcePool({ firstPaint: true, warmFirst: false });
    expect(pool.laneLimit("enrichment")).toBe(0);
    expect(pool.laneLimit("understanding")).toBe(7); // 8 minus the live lane's reserved slot

    let captioned = false;
    const caption = pool.run(
      "llm",
      () => {
        captioned = true;
      },
      { lane: "enrichment" },
    );
    await pool.run("llm", () => {}, { lane: "understanding" });
    await new Promise((r) => setTimeout(r, 5));
    expect(captioned).toBe(false); // held until there is something on screen

    pool.setFirstPaint(false);
    await caption;
    expect(captioned).toBe(true);
    expect(pool.laneLimit("enrichment")).toBe(3);
  });
});

describe("warm-then-fan-out (§4.4.3.1, evals U-013/U-014)", () => {
  it("runs the first call ALONE, then releases the rest", async () => {
    const pool = new ResourcePool(); // warm_first defaults ON
    expect(pool.warmFirstEnabled).toBe(true);
    const t = tracker();
    const tasks = Array.from({ length: 8 }, (_, i) => t.task(`c${i}`, 5));
    const out = await pool.runBatch("llm", tasks);

    expect(out).toEqual(tasks.map((_, i) => `c${i}`));
    // The warm call must have finished before ANY other call started.
    expect(t.order[0]).toBe("start:c0");
    expect(t.order[1]).toBe("end:c0");
    // ...and the remaining seven then fanned out, up to the lane's cap.
    expect(t.peak).toBe(pool.laneLimit("understanding"));
    expect(t.peak).toBeGreaterThan(1);
  });

  it("with warm_first off the batch is dispatched at once — all misses", async () => {
    const pool = new ResourcePool({ warmFirst: false });
    const t = tracker();
    await pool.runBatch(
      "llm",
      Array.from({ length: 8 }, (_, i) => t.task(`c${i}`, 5)),
    );
    // The first call never got the prefix to itself: the fan-out overlapped it.
    expect(t.order[1]).not.toBe("end:c0");
    expect(t.peak).toBe(pool.laneLimit("understanding"));
  });

  it("a per-batch override beats the global setting either way", async () => {
    const pool = new ResourcePool({ warmFirst: false });
    const t = tracker();
    await pool.runBatch(
      "llm",
      Array.from({ length: 4 }, (_, i) => t.task(`c${i}`, 5)),
      { warmFirst: true },
    );
    expect(t.order[1]).toBe("end:c0");
    expect(t.peak).toBe(3); // the three that fanned out after the warm call
  });

  it("an empty or single-task batch is not a special case", async () => {
    const pool = new ResourcePool();
    expect(await pool.runBatch("llm", [])).toEqual([]);
    expect(await pool.runBatch("llm", [() => "only"])).toEqual(["only"]);
  });
});

describe("error policy (§4.6)", () => {
  const refusals = [
    "Claude AI usage limit reached",
    "HTTP 429 Too Many Requests",
    "rate limit exceeded",
    "401 unauthorized",
    "invalid api key",
    "credit balance is too low",
    "please run /login",
    "authentication_error",
  ];

  it("uses refusal text only as a legacy CLI_ERROR fallback", () => {
    for (const m of refusals) {
      expect(isRefusal({ code: "CLI_ERROR", message: m })).toBe(true);
      expect(isRefusal({ message: m })).toBe(false);
      expect(isRefusal({ code: "TIMEOUT", message: m })).toBe(false);
    }
    expect(isRefusal({ code: "QUOTA_EXCEEDED" })).toBe(true);
    expect(isRefusal({ code: "RATE_LIMITED", message: "benign" })).toBe(true);
    expect(isRefusal({ code: "TIMEOUT", message: "run exceeded 120000ms" })).toBe(false);
    expect(isRefusal({ message: "malformed row at line 4" })).toBe(false);
  });

  it.each([
    ["AUTH_REQUIRED", "hold", false],
    ["AUTH_EXPIRED", "hold", false],
    ["PROVIDER_UNAVAILABLE", "hold", false],
    ["BACKEND_UNSUPPORTED", "hold", false],
    ["MODEL_UNAVAILABLE", "quarantine", false],
    ["CAPABILITY_UNSUPPORTED", "quarantine", false],
    ["RATE_LIMITED", "pause", false],
    ["QUOTA_EXCEEDED", "pause", false],
    ["TRANSPORT_ERROR", "retry", true],
    ["BUDGET_EXCEEDED", "hold", false],
    ["MODEL_ACTIVITY_PAUSED", "hold", false],
    ["MAX_TURNS", "quarantine", false],
    ["CANCELLED", "cancelled", false],
  ] as const)(
    "%s maps to %s without an accidental retry-budget charge",
    (code, action, spendsRetryBudget) => {
      expect(classifyFailure({ code }, 0)).toMatchObject({
        action,
        spendsRetryBudget,
      });
    },
  );

  it("typed hold/quarantine codes cannot be overridden by refusal-shaped text", () => {
    expect(
      classifyFailure({ code: "AUTH_REQUIRED", message: "HTTP 429" }).action,
    ).toBe("hold");
    expect(
      classifyFailure({ code: "MODEL_UNAVAILABLE", message: "usage limit" })
        .action,
    ).toBe("quarantine");
  });

  it("a refusal pauses the lane and does NOT spend the retry budget", () => {
    const d = classifyFailure({ code: "CLI_ERROR", message: "usage limit" }, 0);
    expect(d.action).toBe("pause");
    expect(d.spendsRetryBudget).toBe(false);
    expect(d.waitMs).toBe(REFUSAL_BACKOFF_BASE_MS);
  });

  it("backs off 60 s doubling to a 900 s ceiling", () => {
    expect(refusalBackoffMs(1)).toBe(60_000);
    expect(refusalBackoffMs(2)).toBe(120_000);
    expect(refusalBackoffMs(4)).toBe(480_000);
    expect(refusalBackoffMs(5)).toBe(REFUSAL_BACKOFF_MAX_MS);
    expect(refusalBackoffMs(50)).toBe(REFUSAL_BACKOFF_MAX_MS);
  });

  it("every other failure walks 2 s / 10 s / 30 s and is then quarantined", () => {
    expect(RETRY_DELAYS_MS).toEqual([2_000, 10_000, 30_000]);
    const err = { code: "TIMEOUT" as const, message: "run exceeded 120000ms" };
    expect(classifyFailure(err, 0)).toMatchObject({ action: "retry", waitMs: 2_000, spendsRetryBudget: true });
    expect(classifyFailure(err, 1)).toMatchObject({ action: "retry", waitMs: 10_000 });
    expect(classifyFailure(err, 2)).toMatchObject({ action: "retry", waitMs: 30_000 });
    expect(classifyFailure(err, 3).action).toBe("quarantine");
  });

  it("a cancel is neither a retry nor a quarantine", () => {
    expect(classifyFailure({ code: "CANCELLED", message: "run cancelled" }).action).toBe("cancelled");
  });

  it("the pool pauses just the failing lane, and the pause is visible", () => {
    let now = 1_000_000;
    const pool = new ResourcePool({ now: () => now });
    const d = pool.noteFailure("llm:understanding", {
      code: "CLI_ERROR",
      message: "429 too many requests",
    });
    expect(d.action).toBe("pause");
    expect(pool.isPaused("llm:understanding")).toBe(true);
    expect(pool.pausedForMs("llm:understanding")).toBe(60_000);
    // The other lane keeps working — a paused lane is not a stopped pipeline.
    expect(pool.isPaused("llm:enrichment")).toBe(false);

    now += 60_000;
    expect(pool.isPaused("llm:understanding")).toBe(false);
  });

  it("consecutive refusals lengthen the pause; a success clears the streak", () => {
    let now = 0;
    const pool = new ResourcePool({ now: () => now });
    const lane = "llm:enrichment" as const;
    expect(pool.noteFailure(lane, { code: "CLI_ERROR", message: "usage limit" }).waitMs).toBe(60_000);
    expect(pool.noteFailure(lane, { code: "CLI_ERROR", message: "usage limit" }).waitMs).toBe(120_000);
    pool.noteSuccess(lane);
    expect(pool.noteFailure(lane, { code: "CLI_ERROR", message: "usage limit" }).waitMs).toBe(60_000);
  });

  it("a typed ChatGPT refusal halves concurrency and ramps one slot at a time", () => {
    let now = 0;
    const pool = new ResourcePool({ now: () => now });
    pool.noteFailure("llm:understanding", { code: "RATE_LIMITED" }, 0, "chatgpt-oauth");
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(4);
    expect(pool.limitOf("llm", "chatgpt-oauth")).toBe(4);
    expect(pool.effectiveLlmLimit("claude-local")).toBe(8);
    now += DEGRADE_WINDOW_MS;
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(5);
    now += CHATGPT_RAMP_INTERVAL_MS;
    expect(pool.effectiveLlmLimit("chatgpt-oauth")).toBe(6);
  });

  it("preserves Claude's two-refusal degradation and timed recovery", () => {
    let now = 0;
    const pool = new ResourcePool({ now: () => now });
    pool.noteFailure("llm:understanding", { code: "CLI_ERROR", message: "rate limit" });
    expect(pool.effectiveLlmLimit()).toBe(8);
    pool.noteFailure("llm:understanding", { code: "CLI_ERROR", message: "rate limit" });
    expect(pool.effectiveLlmLimit()).toBe(4);
    now += DEGRADE_WINDOW_MS;
    expect(pool.effectiveLlmLimit()).toBe(8);
  });

  it("a paused lane holds work until the backoff expires", async () => {
    let now = 0;
    const slept: number[] = [];
    const pool = new ResourcePool({
      now: () => now,
      // The sleep is what the real pool blocks on; here it just advances time.
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    pool.noteFailure("llm:understanding", { code: "CLI_ERROR", message: "usage limit" });
    let ran = false;
    await pool.run("llm", () => {
      ran = true;
    });
    expect(slept).toEqual([60_000]);
    expect(ran).toBe(true);
    expect(pool.isPaused("llm:understanding")).toBe(false);
  });

  // A controllable pool: sleeps park until we wake them, so a manual pause
  // genuinely HOLDS work instead of fast-forwarding past it.
  function heldPool() {
    const wakes: Array<() => void> = [];
    const pool = new ResourcePool({
      sleep: () => new Promise<void>((r) => wakes.push(r)),
    });
    const wake = async () => {
      for (const w of wakes.splice(0)) w();
      // Let the awaitResume loop re-check the pause state.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };
    return { pool, wake };
  }

  it("pausing the bare llm family holds a lane's work until resume", async () => {
    const { pool, wake } = heldPool();
    pool.pauseLane("llm", 60 * 60_000);
    let ran = false;
    const p = pool.run("llm", () => {
      ran = true;
    }, { lane: "understanding" });
    await wake();
    expect(ran).toBe(false);
    pool.resumeLane("llm");
    await wake();
    await p;
    expect(ran).toBe(true);
  });

  it("a manual composite-lane pause still holds its lane's work", async () => {
    const { pool, wake } = heldPool();
    pool.pauseLane("llm:understanding", 60 * 60_000);
    let ran = false;
    const p = pool.run("llm", () => {
      ran = true;
    }, { lane: "understanding" });
    await wake();
    expect(ran).toBe(false);
    pool.resumeLane("llm:understanding");
    await wake();
    await p;
    expect(ran).toBe(true);
  });

  it("with family AND lane both paused, resuming one is not enough", async () => {
    const { pool, wake } = heldPool();
    pool.pauseLane("llm", 60 * 60_000);
    pool.pauseLane("llm:understanding", 60 * 60_000);
    let ran = false;
    const p = pool.run("llm", () => {
      ran = true;
    }, { lane: "understanding" });
    await wake();
    expect(ran).toBe(false);
    pool.resumeLane("llm");
    await wake();
    expect(ran).toBe(false); // the composite pause still holds it
    pool.resumeLane("llm:understanding");
    await wake();
    await p;
    expect(ran).toBe(true);
  });
});

// ===========================================================================
// V6 P1 S0.7 — breaker (T0-10, SPD-07) and bounded waiters (T0-12, BND-12).
// ===========================================================================

import {
  BREAKER_FAILURES,
  BREAKER_PAUSE_MS,
  PoolOverflowError,
  WAITER_CAP_MULTIPLIER,
  isPoolOverflow,
  waiterCapFor,
} from "./pool.js";

/** Let admitted callers reach their semaphores (a macrotask, not one microtask). */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A clock the pool's own sleeps advance — a paused lane can be waited out. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("SPD-07 — breaker: ten consecutive non-refusal failures pause the lane", () => {
  const boom = { code: "CLI_ERROR", message: "exit 1" };

  it("counts non-refusal failures, trips at 10, pauses 30 min and raises the banner", () => {
    const clock = fakeClock();
    const pool = new ResourcePool({ now: clock.now, sleep: clock.sleep });
    const seen: string[] = [];
    pool.onBreaker((trip) => seen.push(trip.lane));

    for (let i = 1; i < BREAKER_FAILURES; i++) {
      const d = pool.noteFailure("llm:understanding", boom, 3);
      expect(d.breakerTripped).toBeUndefined();
      expect(pool.consecutiveFailures("llm:understanding")).toBe(i);
      expect(pool.isPaused("llm:understanding")).toBe(false);
    }
    expect(pool.breakers()).toEqual([]);

    const tenth = pool.noteFailure("llm:understanding", boom, 3);
    expect(tenth.breakerTripped).toBe(true);
    // The unit's own decision is the ladder's — a tripped breaker is not a
    // reason to retry the unit that tripped it.
    expect(tenth.action).toBe("quarantine");
    expect(pool.isPaused("llm:understanding")).toBe(true);
    expect(pool.pausedForMs("llm:understanding")).toBe(BREAKER_PAUSE_MS);
    expect(BREAKER_PAUSE_MS).toBe(30 * 60_000);
    // The other lane keeps working.
    expect(pool.isPaused("llm:enrichment")).toBe(false);
    expect(pool.isPaused("llm")).toBe(false);

    const banners = pool.breakers();
    expect(banners).toHaveLength(1);
    expect(banners[0].lane).toBe("llm:understanding");
    expect(banners[0].failures).toBe(BREAKER_FAILURES);
    expect(banners[0].lastCode).toBe("CLI_ERROR");
    expect(banners[0].lastError).toBe("exit 1");
    expect(banners[0].untilMs).toBe(BREAKER_PAUSE_MS);
    expect(pool.breakerFor("llm:understanding")?.lane).toBe("llm:understanding");
    expect(seen).toEqual(["llm:understanding"]);
    // The counter restarts after a trip.
    expect(pool.consecutiveFailures("llm:understanding")).toBe(0);
  });

  it("a success in between resets the count — ten failures must be consecutive", () => {
    const clock = fakeClock();
    const pool = new ResourcePool({ now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < BREAKER_FAILURES - 1; i++) pool.noteFailure("llm:understanding", boom, 0);
    pool.noteSuccess("llm:understanding");
    expect(pool.consecutiveFailures("llm:understanding")).toBe(0);
    for (let i = 0; i < BREAKER_FAILURES - 1; i++) pool.noteFailure("llm:understanding", boom, 0);
    expect(pool.isPaused("llm:understanding")).toBe(false);
    expect(pool.breakers()).toEqual([]);
  });

  it("refusals and cancels are not breaker failures", () => {
    const clock = fakeClock();
    const pool = new ResourcePool({ now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < BREAKER_FAILURES + 2; i++) {
      pool.noteFailure("llm:understanding", { code: "CANCELLED" });
    }
    expect(pool.consecutiveFailures("llm:understanding")).toBe(0);
    expect(pool.breakers()).toEqual([]);
    // A refusal pauses with its own backoff and leaves the breaker count alone.
    pool.resumeLane("llm:understanding");
    for (let i = 0; i < BREAKER_FAILURES + 2; i++) {
      pool.noteFailure("llm:understanding", { code: "QUOTA_EXCEEDED", message: "usage limit" });
    }
    expect(pool.consecutiveFailures("llm:understanding")).toBe(0);
    expect(pool.breakers()).toEqual([]);
    expect(pool.isPaused("llm:understanding")).toBe(true); // the refusal pause, not the breaker
  });

  it("the banner comes down when the pause ends or an operator resumes the lane", () => {
    const clock = fakeClock();
    const pool = new ResourcePool({ now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < BREAKER_FAILURES; i++) pool.noteFailure("llm:enrichment", boom, 0);
    expect(pool.breakers()).toHaveLength(1);
    clock.advance(BREAKER_PAUSE_MS);
    expect(pool.isPaused("llm:enrichment")).toBe(false);
    expect(pool.breakers()).toEqual([]);

    for (let i = 0; i < BREAKER_FAILURES; i++) pool.noteFailure("llm:enrichment", boom, 0);
    expect(pool.breakers()).toHaveLength(1);
    pool.resumeLane("llm:enrichment");
    expect(pool.isPaused("llm:enrichment")).toBe(false);
    expect(pool.breakers()).toEqual([]);
  });

  it("a tripped lane holds new work until the 30 minutes are up (no silent retry)", async () => {
    const clock = fakeClock();
    const pool = new ResourcePool({ now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < BREAKER_FAILURES; i++) pool.noteFailure("llm:understanding", boom, 0);
    const startedAt: number[] = [];
    await pool.run("llm", () => startedAt.push(clock.now()), { lane: "understanding" });
    expect(startedAt).toEqual([BREAKER_PAUSE_MS]);
  });
});

describe("BND-12 — bounded waiters: 4× capacity queue, the rest rejected", () => {
  it("caps waiters at 4× the class capacity", () => {
    expect(WAITER_CAP_MULTIPLIER).toBe(4);
    expect(waiterCapFor(8)).toBe(32);
    expect(waiterCapFor(2)).toBe(8);
    // A zero-slot lane (enrichment under first paint) still admits a queue.
    expect(waiterCapFor(0)).toBe(4);
    const pool = new ResourcePool({ limits: { llm: 4, embed: 2 } });
    expect(pool.waiterCap("llm")).toBe(16);
    expect(pool.waiterCap("embed")).toBe(8);
  });

  it("10× capacity submitted: capacity runs, 4× waits, the overflow is rejected — and `waiting` is readable", async () => {
    // First paint on a 2-slot pool: one slot is the live lane's reserve (V6
    // S3.3), so the understanding lane holds exactly one. Its one runnable
    // claim plus the provider's eight waiters are admitted; the other eleven
    // are rejected without borrowing the live reservation.
    const pool = new ResourcePool({ limits: { llm: 2 }, warmFirst: false, firstPaint: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const settled: Array<"ok" | "overflow" | "other"> = [];
    const submissions = Array.from({ length: 20 }, () =>
      pool
        .run("llm", () => gate, { lane: "understanding" })
        .then(() => settled.push("ok"))
        .catch((err: unknown) => settled.push(isPoolOverflow(err) ? "overflow" : "other")),
    );
    // Rejections are synchronous with the submission: nothing was queued.
    await tick();
    expect(settled.filter((s) => s === "overflow")).toHaveLength(11);
    expect(settled).not.toContain("other");
    expect(pool.inFlight("llm")).toBe(1); // the understanding lane's one slot; the other is reserved for live
    expect(pool.waiting("llm")).toBe(8);
    expect(pool.laneWaiting("understanding")).toBe(8);
    expect(pool.laneWaiting("enrichment")).toBe(0);
    expect(pool.laneWaiting("live")).toBe(0);

    release();
    await Promise.all(submissions);
    expect(settled.filter((s) => s === "ok")).toHaveLength(9);
    expect(pool.waiting("llm")).toBe(0);
    expect(pool.inFlight("llm")).toBe(0);
    expect(pool.peakInFlight("llm")).toBe(1);
  });

  it("the rejection names the class, the queue and the cap, and carries POOL_OVERFLOW", async () => {
    const pool = new ResourcePool({ limits: { embed: 1 } });
    const hold = new Promise<void>(() => {});
    // One runs, four wait: the queue is full.
    const held = Array.from({ length: 5 }, () => pool.run("embed", () => hold));
    await tick();
    expect(pool.inFlight("embed")).toBe(1);
    expect(pool.waiting("embed")).toBe(4);
    let caught: unknown;
    try {
      await pool.run("embed", () => "never");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PoolOverflowError);
    const e = caught as PoolOverflowError;
    expect(e.code).toBe("POOL_OVERFLOW");
    expect(e.cls).toBe("embed");
    expect(e.waiting).toBe(4);
    expect(e.cap).toBe(4);
    expect(e.message).toMatch(/embed.*4 callers already waiting/);
    void held;
  });

  it("a paused lane's held callers count as waiting, and are capped like any other", async () => {
    const clock = fakeClock();
    // Never advance: the pause is permanent for this test.
    const pool = new ResourcePool({ limits: { llm: 1 }, now: clock.now, sleep: () => new Promise(() => {}) });
    pool.pauseLane("llm:understanding", 60_000);
    // The live reservation leaves this lane at zero capacity, so exactly the
    // four bounded waiters are held by the pause and the fifth is rejected.
    const held = Array.from({ length: 4 }, () => pool.run("llm", () => "x", { lane: "understanding" }));
    await tick();
    expect(pool.waiting("llm")).toBe(4);
    expect(pool.inFlight("llm")).toBe(0);
    await expect(pool.run("llm", () => "x", { lane: "understanding" })).rejects.toBeInstanceOf(
      PoolOverflowError,
    );
    void held;
  });

  it("classes are bounded independently", async () => {
    const pool = new ResourcePool({ limits: { embed: 1, ffmpeg: 1 } });
    const hold = new Promise<void>(() => {});
    const held = Array.from({ length: 5 }, () => pool.run("embed", () => hold));
    await tick();
    await expect(pool.run("embed", () => "x")).rejects.toBeInstanceOf(PoolOverflowError);
    // ffmpeg is untouched by embed's queue.
    expect(pool.waiting("ffmpeg")).toBe(0);
    await expect(pool.run("ffmpeg", () => "ok")).resolves.toBe("ok");
    void held;
  });
});
