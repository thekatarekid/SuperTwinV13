// ===========================================================================
// GATE-09 · history never queues a nudge — the pool half (V6 P1 S3.3).
// The `live` lane holds a reserved slot the background lanes can never fill:
// with understanding and enrichment saturated and a queue behind them, a live
// call still runs at once. Zero model calls.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { laneCaps, LIVE_RESERVED_SLOTS, ResourcePool } from "./pool.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("the live lane's reserved slot", () => {
  it("laneCaps reserves LIVE_RESERVED_SLOTS and splits the rest 40/60", () => {
    expect(LIVE_RESERVED_SLOTS).toBe(1);
    for (const limit of [3, 4, 8, 16]) {
      const caps = laneCaps(limit, false);
      expect(caps.live).toBe(1);
      expect(caps.enrichment + caps.understanding).toBeLessThanOrEqual(limit - caps.live);
    }
    expect(laneCaps(4, false)).toEqual({ live: 1, enrichment: 1, understanding: 2 });
    expect(laneCaps(4, true)).toEqual({ live: 1, enrichment: 0, understanding: 3 });
  });

  it("GATE-09 · with every background slot held and 200 more waiting, a live call runs immediately", async () => {
    const pool = new ResourcePool({ limits: { llm: 4 }, warmFirst: false });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    // Background: saturate understanding (2) + enrichment (1) and queue the rest.
    const background: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) background.push(pool.run("llm", () => gate, { lane: "understanding" }).catch(() => {}));
    for (let i = 0; i < 4; i++) background.push(pool.run("llm", () => gate, { lane: "enrichment" }).catch(() => {}));
    await tick();
    expect(pool.inFlight("llm")).toBe(3); // 4 slots, one reserved for live
    expect(pool.waiting("llm")).toBeGreaterThan(0);

    // The live flush: resolves without waiting on anything above.
    let ran = false;
    const started = Date.now();
    await pool.run(
      "llm",
      () => {
        ran = true;
      },
      { lane: "live" },
    );
    expect(ran).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pool.lanePeakInFlight("live")).toBe(1);
    expect(pool.laneLimit("live")).toBe(1);

    release();
    await Promise.all(background);
    expect(pool.inFlight("llm")).toBe(0);
  });

  it("keeps the live slot reserved at ChatGPT's three-lane configuration floor", async () => {
    const pool = new ResourcePool({
      providerLimits: { "chatgpt-oauth": 2 },
      warmFirst: false,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const understanding = pool.run("llm", () => gate, {
      providerId: "chatgpt-oauth",
      lane: "understanding",
    });
    const enrichment = pool.run("llm", () => gate, {
      providerId: "chatgpt-oauth",
      lane: "enrichment",
    });
    await tick();
    expect(pool.limitOf("llm", "chatgpt-oauth")).toBe(3);
    expect(pool.inFlight("llm", "chatgpt-oauth")).toBe(2);
    await expect(pool.run("llm", () => "live", {
      providerId: "chatgpt-oauth",
      lane: "live",
    })).resolves.toBe("live");
    release();
    await Promise.all([understanding, enrichment]);
  });

  it("the live lane is pausable and breaker-guarded like any other (llm:live)", () => {
    const pool = new ResourcePool({ limits: { llm: 4 }, now: () => 1_000 });
    pool.pauseLane("llm:live", 60_000);
    expect(pool.isPaused("llm:live")).toBe(true);
    expect(pool.isPaused("llm:understanding")).toBe(false);
    pool.resumeLane("llm:live");
    expect(pool.isPaused("llm:live")).toBe(false);
  });
});
