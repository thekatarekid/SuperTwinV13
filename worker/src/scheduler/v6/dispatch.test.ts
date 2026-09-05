// ===========================================================================
// The V6 dispatcher: BND-08 · slot cap is absolute (hard) · BND-09 · keyed
// in-flight (hard) · BND-10 · revalidate at execution (hard) · BND-11 · three
// strikes · GATE-09 · history never queues a nudge, plus the gate → flush
// path end to end. Stubbed sinks, injected clock, ZERO model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../db/connection.js";
import { ResourcePool } from "../../providers/pool.js";
import { collectTick, markDispatched, type DeltaBundle } from "./bundle.js";
import { Dispatcher, type SinkResult } from "./dispatch.js";
import { listDeadLetters } from "./attempts.js";
import {
  append,
  dispatchedIds,
  MIN,
  msgAt,
  openScratchDb,
  screenAt,
  SEC,
  seedEpisode,
  seedOpenTask,
  seedSpace,
  streamIdOf,
  T0,
  undispatchedCount,
  visitAt,
  type ScratchDb,
} from "./testutil.js";

let db: ScratchDb;
beforeEach(() => {
  db = openScratchDb("supertwin-dispatch-");
});
afterEach(() => db.close());

/** A clock the tests move by hand. */
function clock(start = T0) {
  let now = start;
  return { now: () => now, set: (t: number) => (now = t), advance: (ms: number) => (now += ms) };
}

const noBootstrap = { preset: () => "balanced" as const };

/** Twenty spaces + a consent 30 days old: the preset window (300/540), not bootstrapping. */
function matureWorld(): void {
  for (let i = 0; i < 20; i++) seedSpace(`sp_${i}`, `space ${i}`);
  getDb().prepare(`INSERT INTO consents (id, source, state, granted_at) VALUES ('c1', 'wa', 'connected', ?)`).run(new Date(T0 - 30 * 86_400_000).toISOString());
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("BND-08 · slot cap is absolute", () => {
  it("3,000 undispatched history events over 500 streams: ≤ cfg.slots bundles per tick, planned path and re-dispatch", async () => {
    matureWorld();
    const envs = [];
    // Six events per stream, one stream per day across 500 days → 500 day bundles.
    for (let s = 0; s < 500; s++) {
      const dayMs = Date.parse("2024-01-01T09:00:00Z") + s * 86_400_000;
      for (let i = 0; i < 6; i++) envs.push(msgAt(`stream-${s}@g.us`, dayMs + i * 5 * MIN, `planning message ${i} for stream ${s} about the trip`, { origin: "backfill" }));
    }
    expect(append(envs).filter(Boolean)).toHaveLength(3000);

    // A sink that settles but never marks: the same backlog is re-dispatchable every tick.
    let routed = 0;
    const d = new Dispatcher({ cfg: { slots: 4, maxBundleEvents: 500 }, sink: () => ({ status: "empty" }), ...noBootstrap });
    const perTick: number[] = [];
    for (let t = 0; t < 5; t++) {
      const r = d.tick(T0 + t * 5 * SEC);
      routed += r.routed.length;
      perTick.push(r.routed.length);
      await d.drain();
    }
    for (const n of perTick) {
      expect(n).toBeLessThanOrEqual(4);
      expect(n).toBeGreaterThan(0); // the cap bounds, it does not starve
    }
    expect(routed).toBe(20);
    expect(undispatchedCount()).toBe(3000); // nothing marked — the sink is a counter
  });

  it("with the sink never settling, later ticks route nothing new: in-flight work is bounded, never re-queued", () => {
    matureWorld();
    const envs = [];
    for (let s = 0; s < 20; s++) envs.push(msgAt(`s${s}@g.us`, Date.parse("2024-01-01T09:00:00Z") + s * 86_400_000, `day ${s}`, { origin: "backfill" }));
    append(envs);
    const d = new Dispatcher({ cfg: { slots: 4, maxBundleEvents: 500 }, sink: () => new Promise<SinkResult>(() => {}), ...noBootstrap });
    expect(d.tick(T0).routed).toHaveLength(4);
    expect(d.tick(T0 + 5 * SEC).routed).toHaveLength(4); // up to 2× slots in flight
    expect(d.tick(T0 + 10 * SEC).routed).toHaveLength(0);
    expect(d.inFlightKeys()).toHaveLength(8);
  });

  it("a marked bundle leaves the backlog; the rest fill later ticks, still capped", async () => {
    matureWorld();
    const envs = [];
    for (let s = 0; s < 6; s++) envs.push(msgAt(`s${s}@g.us`, Date.parse("2024-01-01T09:00:00Z") + s * 86_400_000, `day ${s}`, { origin: "backfill" }));
    append(envs);
    const seen: string[] = [];
    const d = new Dispatcher({
      cfg: { slots: 4, maxBundleEvents: 500 },
      sink: (b) => {
        seen.push(b.streamKey);
        markDispatched(b);
        return { status: "committed" };
      },
      ...noBootstrap,
    });
    expect(d.tick(T0).routed).toHaveLength(4);
    await d.drain();
    expect(d.tick(T0 + 5 * SEC).routed).toHaveLength(2);
    await d.drain();
    expect(d.tick(T0 + 10 * SEC).routed).toHaveLength(0);
    expect(new Set(seen).size).toBe(6);
    expect(undispatchedCount()).toBe(0);
  });

  it("a live backlog of 3,000 events flushes as ONE bundle per tick, capped at 20k chars", async () => {
    matureWorld();
    const envs = [];
    for (let s = 0; s < 500; s++) for (let i = 0; i < 6; i++) envs.push(msgAt(`live-${s}@g.us`, T0 - 10 * MIN + i * SEC, `planning message ${i} for stream ${s} about the trip`));
    expect(append(envs).filter(Boolean)).toHaveLength(3000);
    let routed: DeltaBundle[] = [];
    const d = new Dispatcher({ cfg: { slots: 4, maxBundleEvents: 500 }, sink: () => ({ status: "empty" }), ...noBootstrap, history: false, digest: false });
    const r1 = d.tick(T0 + 301 * SEC); // cold window expired for everything accumulated
    routed = r1.routed;
    expect(routed).toHaveLength(1);
    expect(routed[0].lane).toBe("live");
    expect(routed[0].events.reduce((n, e) => n + (e.text ?? "").length, 0)).toBeLessThanOrEqual(20_000);
    // Six events per stream in seconds is a burst on every stream; the cap still bounds the flush.
    expect(["burst", "cap"]).toContain(r1.liveFlush?.trigger);
    expect(d.cold.accumulated().length).toBeGreaterThan(0); // the overflow waits
    await d.drain();
    // The remainder comes out one flush at a time, never under the 30 s floor.
    expect(d.tick(T0 + 310 * SEC).routed).toHaveLength(0);
    expect(d.tick(T0 + 331 * SEC).routed).toHaveLength(1);
  });
});

describe("BND-09 · keyed in-flight", () => {
  it("the same bundle key submitted twice before the first settles → exactly one sink call", async () => {
    append([msgAt("goa-gang@g.us", T0, "villa advance by 5pm"), msgAt("goa-gang@g.us", T0 + SEC, "ok sending")]);
    const bundle = collectTick(T0).bundles[0];
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<SinkResult>((r) => (release = () => r({ status: "empty" })));
    const d = new Dispatcher({ ...noBootstrap });
    const sink = () => (calls++, gate);
    expect(d.submit(bundle, sink, T0, "live")).toBe("routed");
    expect(d.submit({ ...bundle }, sink, T0 + SEC, "live")).toBe("duplicate");
    await settle();
    expect(calls).toBe(1);
    expect(d.stats().duplicates).toBe(1);
    release();
    await d.drain();
    // Settled → the key is free again; a distinct range is a distinct key.
    expect(d.inFlightKeys()).toHaveLength(0);
  });

  it("a history bundle in flight is not planned again on the next tick", async () => {
    matureWorld();
    append([msgAt("fam@g.us", Date.parse("2024-01-01T09:00:00Z"), "old day", { origin: "backfill" })]);
    let calls = 0;
    const d = new Dispatcher({ sink: () => (calls++, new Promise<SinkResult>(() => {})), ...noBootstrap });
    expect(d.tick(T0).routed).toHaveLength(1);
    expect(d.tick(T0 + 5 * SEC).routed).toHaveLength(0);
    expect(d.tick(T0 + 10 * SEC).routed).toHaveLength(0);
    await settle();
    expect(calls).toBe(1);
  });
});

describe("BND-10 · revalidate at execution", () => {
  it("rows marked dispatched between enqueue and run → zero sink calls; status stale", () => {
    append([msgAt("goa-gang@g.us", T0, "villa advance by 5pm"), msgAt("goa-gang@g.us", T0 + SEC, "ok sending")]);
    const bundle = collectTick(T0).bundles[0];
    // Another path stamps the rows meanwhile.
    markDispatched(bundle, T0 + 2 * SEC);
    let calls = 0;
    const d = new Dispatcher({ sink: () => (calls++, { status: "empty" }), ...noBootstrap });
    expect(d.submit(bundle, () => (calls++, { status: "empty" }), T0 + 3 * SEC, "live")).toBe("stale");
    expect(calls).toBe(0);
    expect(d.stats().stale).toBe(1);
  });

  it("a partial mark is stale too; the unmarked remainder is re-collected as a fresh bundle", () => {
    const ids = append([msgAt("goa-gang@g.us", T0, "one"), msgAt("goa-gang@g.us", T0 + SEC, "two"), msgAt("goa-gang@g.us", T0 + 2 * SEC, "three")]);
    const bundle = collectTick(T0).bundles[0];
    markDispatched({ ...bundle, events: bundle.events.filter((e) => e.id === ids[0]) }, T0 + SEC);
    const d = new Dispatcher({ ...noBootstrap });
    let calls = 0;
    expect(d.submit(bundle, () => (calls++, { status: "empty" }), T0 + 3 * SEC, "history")).toBe("stale");
    expect(calls).toBe(0);
    const again = collectTick(T0 + 4 * SEC).bundles[0];
    expect(again.events.map((e) => e.id)).toEqual(ids.slice(1));
  });
});

describe("BND-11 · three strikes", () => {
  it("a bundle whose output always quarantines: attempts at 0, 5 and 10 minutes, then dead-lettered — never a fourth", async () => {
    matureWorld();
    seedSpace("sp_goa", "Goa trip");
    seedEpisode("ep_goa", streamIdOf("wa", "goa-gang@g.us"), T0 - 30 * MIN, { spaceId: "sp_goa", state: "closed" });
    seedOpenTask("tsk_adv", "collect advance from Karan", "sp_goa");
    const ids = append([msgAt("goa-gang@g.us", T0, "ok")]);

    const attempts: number[] = [];
    const c = clock(T0);
    const d = new Dispatcher({
      now: c.now,
      sink: () => {
        attempts.push(c.now());
        return { status: "quarantined" };
      },
      ...noBootstrap,
      history: false,
      digest: false,
    });

    // Attempt 1 at 0 (hot → flush now).
    const r1 = d.tick(c.now());
    expect(r1.gated.hot).toBe(1);
    expect(r1.liveFlush?.trigger).toBe("hot");
    await d.drain();
    // Held: nothing at +1 and +4 minutes.
    for (const m of [1, 4]) {
      c.set(T0 + m * MIN);
      expect(d.tick(c.now()).routed).toHaveLength(0);
    }
    // Attempt 2 at +5.
    c.set(T0 + 5 * MIN);
    expect(d.tick(c.now()).routed).toHaveLength(1);
    await d.drain();
    c.set(T0 + 7 * MIN);
    expect(d.tick(c.now()).routed).toHaveLength(0);
    // Attempt 3 at +10 → dead letter.
    c.set(T0 + 10 * MIN);
    expect(d.tick(c.now()).routed).toHaveLength(1);
    await d.drain();
    expect(attempts).toEqual([T0, T0 + 5 * MIN, T0 + 10 * MIN]);

    // Dead-lettered: stamped, listed, never a fourth.
    expect(dispatchedIds().has(ids[0])).toBe(true);
    const dead = listDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0].attempts).toBe(3);
    expect(d.stats().deadLetters).toBe(1);
    for (const m of [15, 30, 120, 24 * 60]) {
      c.set(T0 + m * MIN);
      expect(d.tick(c.now()).routed).toHaveLength(0);
    }
    expect(attempts).toHaveLength(3);
  });

  it("a history bundle walks the same ladder and its events are stamped on the third strike", async () => {
    matureWorld();
    const ids = append([msgAt("fam@g.us", Date.parse("2024-01-01T09:00:00Z"), "old day", { origin: "backfill" })]);
    const c = clock(T0);
    let calls = 0;
    const d = new Dispatcher({ now: c.now, sink: () => (calls++, { status: "failed", error: "boom" }), ...noBootstrap });
    for (const m of [0, 1, 5, 6, 10, 11, 60]) {
      c.set(T0 + m * MIN);
      d.tick(c.now());
      await d.drain();
    }
    expect(calls).toBe(3);
    expect(dispatchedIds().has(ids[0])).toBe(true);
    expect(listDeadLetters()).toHaveLength(1);
  });
});

describe("the gate → flush path", () => {
  it("a cold event alone waits for the idle window; a hot event flushes at once with whatever accumulated", async () => {
    matureWorld();
    seedEpisode("ep_rohan", streamIdOf("wa", "rohan@s.whatsapp.net"), T0 - 4 * MIN, { state: "open" });
    const routed: DeltaBundle[] = [];
    const d = new Dispatcher({ sink: (b) => (routed.push(b), markDispatched(b), { status: "committed" }), ...noBootstrap, history: false, digest: false });

    append([msgAt("college@g.us", T0, "anyone up for lunch")]); // cold
    expect(d.tick(T0).routed).toHaveLength(0);
    expect(d.tick(T0 + 200 * SEC).routed).toHaveLength(0);

    append([msgAt("rohan@s.whatsapp.net", T0 + 240 * SEC, "and the villa?", { actor: "contact:rohan" })]); // hot: active episode
    const r = d.tick(T0 + 240 * SEC);
    expect(r.gated.hot).toBe(1);
    expect(r.routed).toHaveLength(1);
    expect(r.liveFlush).toEqual({ trigger: "hot", events: 2 }); // the cold one rides along
    expect(r.routed[0].streamKey).toBe("rohan@s.whatsapp.net"); // S1 is the hot stream
    await d.drain();
    expect(undispatchedCount()).toBe(0);
    expect(d.stats().hotLatenciesMs).toEqual([0]);
  });

  it("a burst flushes on the 4th content-new page; repeats do not count", () => {
    matureWorld();
    const routed: DeltaBundle[] = [];
    const d = new Dispatcher({ sink: (b) => (routed.push(b), { status: "empty" }), ...noBootstrap, history: false, digest: false });
    const day = "2026-08-28";
    append([visitAt("croma.com", T0, "https://croma.com/tv/1", "TV 1", day), visitAt("croma.com", T0 + 40 * SEC, "https://croma.com/tv/2", "TV 2", day)]);
    expect(d.tick(T0 + 40 * SEC).routed).toHaveLength(0);
    // A reload of page 2 is a repeat.
    append([visitAt("croma.com", T0 + 60 * SEC, "https://croma.com/tv/2", "TV 2", day)]);
    let r = d.tick(T0 + 60 * SEC);
    expect(r.gated.repeats).toBe(1);
    expect(r.routed).toHaveLength(0);
    append([visitAt("croma.com", T0 + 90 * SEC, "https://croma.com/tv/3", "TV 3", day)]);
    expect(d.tick(T0 + 90 * SEC).routed).toHaveLength(0);
    append([visitAt("croma.com", T0 + 120 * SEC, "https://croma.com/tv/4", "TV 4", day)]);
    r = d.tick(T0 + 120 * SEC);
    expect(r.gated.burst).toBe(1);
    expect(r.liveFlush?.trigger).toBe("burst");
    expect(r.routed[0].events).toHaveLength(5);
  });

  it("heartbeats alone never flush; tier-4 rows are stamped without a call; tier-3 rows wait for the digest lane", async () => {
    matureWorld();
    let calls = 0;
    // The sink marks what it was given (as the consumer does) — an "empty" verdict still stamps the rows.
    const d = new Dispatcher({ sink: (b) => (calls++, markDispatched(b), { status: "empty" }), ...noBootstrap, history: false, digest: false });
    append([screenAt("com.apple.Notes", T0, "the same frame")]);
    d.tick(T0);
    for (let t = 10; t <= 900; t += 10) {
      append([screenAt("com.apple.Notes", T0 + t * SEC, "the same frame")]);
      d.tick(T0 + t * SEC);
    }
    // The first frame was new: one cold flush at 300 s carries every repeat so far; afterwards, nothing.
    await d.drain();
    expect(calls).toBe(1);
    expect(d.stats().flushes.cold).toBe(1);

    append([msgAt("promo@g.us", T0 + 1000 * SEC, "weekly offers"), msgAt("ads@g.us", T0 + 1000 * SEC, "sale")]);
    getDb().prepare(`UPDATE streams SET tier = 'T3' WHERE id = ?`).run(streamIdOf("wa", "promo@g.us"));
    getDb().prepare(`UPDATE streams SET tier = 'T4' WHERE id = ?`).run(streamIdOf("wa", "ads@g.us"));
    const r = d.tick(T0 + 1000 * SEC);
    expect(r.indexOnly).toBe(1);
    expect(r.gated).toEqual({ hot: 0, cold: 0, burst: 0, repeats: 0 });
    expect(d.tick(T0 + 2000 * SEC).routed).toHaveLength(0);
    await d.drain();
    expect(calls).toBe(1);
  });

  it("ignoreOrigins (the S3.9 eval-isolation hook) leaves those rows untouched", () => {
    matureWorld();
    append([msgAt("goa-gang@g.us", T0, "hello")]);
    getDb().prepare(`UPDATE events SET origin = 'eval'`).run();
    let calls = 0;
    const d = new Dispatcher({ sink: () => (calls++, { status: "empty" }), ignoreOrigins: ["eval"], ...noBootstrap });
    d.tick(T0);
    d.tick(T0 + 600 * SEC);
    expect(calls).toBe(0);
    expect(undispatchedCount()).toBe(1);
  });
});

describe("GATE-09 · history never queues a nudge", () => {
  it("200 history bundles queued, then a live flush: the live call runs at once on its reserved lane", async () => {
    matureWorld();
    seedEpisode("ep_rohan", streamIdOf("wa", "rohan@s.whatsapp.net"), T0 - 4 * MIN, { state: "open" });
    const envs = [];
    for (let s = 0; s < 200; s++) envs.push(msgAt(`h${s}@g.us`, Date.parse("2024-01-01T09:00:00Z") + s * 86_400_000, `history day ${s}`, { origin: "backfill" }));
    append(envs);

    const pool = new ResourcePool({ limits: { llm: 4 }, warmFirst: false });
    let release!: () => void;
    const parked = new Promise<void>((r) => (release = r));
    const liveDone: number[] = [];
    const sink = async (b: DeltaBundle): Promise<SinkResult> => {
      if (b.lane === "live") {
        const started = Date.now();
        await pool.run("llm", () => {}, { lane: "live" });
        liveDone.push(Date.now() - started);
        markDispatched(b);
        return { status: "committed" };
      }
      await pool.run("llm", () => parked, { lane: "understanding" });
      return { status: "empty" };
    };
    const d = new Dispatcher({ cfg: { slots: 4, maxBundleEvents: 500 }, sink, ...noBootstrap, digest: false });
    // Fill the background: 8 in flight (2× slots), the understanding lane saturated, the rest waiting.
    d.tick(T0);
    d.tick(T0 + 5 * SEC);
    await settle();
    expect(d.inFlightKeys()).toHaveLength(8);
    expect(pool.inFlight("llm")).toBe(2); // the understanding lane's cap on a 4-slot pool
    expect(pool.waiting("llm")).toBe(6);

    append([msgAt("rohan@s.whatsapp.net", T0 + 10 * SEC, "and the villa?", { actor: "contact:rohan" })]);
    const r = d.tick(T0 + 10 * SEC);
    expect(r.liveFlush?.trigger).toBe("hot");
    // The live call completes while every history call is still parked.
    for (let i = 0; i < 20 && liveDone.length === 0; i++) await settle();
    expect(liveDone).toHaveLength(1);
    expect(liveDone[0]).toBeLessThan(30_000);
    expect(pool.waiting("llm")).toBe(6);

    release();
    await d.drain();
  });
});
