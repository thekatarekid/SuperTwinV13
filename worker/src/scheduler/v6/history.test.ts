// ===========================================================================
// BND-01 · one history call per day, sectioned · BND-02 · split at the largest
// gap · BND-03 · newest day first, empty days skipped (GoldenEvals V6 P1 §5.5).
// Deterministic; zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../db/connection.js";
import { HISTORY_SPLIT_CHARS, pendingHistoryDays, planHistory, splitAtLargestGap } from "./history.js";
import { append, MIN, msgAt, openScratchDb, screenAt, setStreamTier, streamIdOf, visitAt, type ScratchDb } from "./testutil.js";

let db: ScratchDb;
beforeEach(() => {
  db = openScratchDb("supertwin-history-");
});
afterEach(() => db.close());

const DAY = (d: string, hhmm = "00:00") => Date.parse(`${d}T${hhmm}:00.000Z`);

describe("BND-01 · one history call per day, sectioned", () => {
  it("3 sources, 60 events, one day → one bundle; sections single-stream; temporal order within sections", () => {
    const day = "2026-08-20";
    const envs = [];
    for (let i = 0; i < 20; i++) envs.push(msgAt("goa-gang@g.us", DAY(day, "09:00") + i * 7 * MIN, `goa msg ${i}`, { origin: "backfill" }));
    for (let i = 0; i < 20; i++) envs.push({ ...screenAt("com.apple.Notes", DAY(day, "10:00") + i * 5 * MIN, `note draft v${i}`), origin: "backfill" as const });
    for (let i = 0; i < 20; i++) envs.push({ ...visitAt("goibibo.com", DAY(day, "11:00") + i * 3 * MIN, `https://goibibo.com/hotels/${i}`, `Hotel ${i}`, day), origin: "backfill" as const });
    expect(append(envs).filter(Boolean)).toHaveLength(60);

    const plan = planHistory();
    expect(plan).toHaveLength(1); // wrong: two-bundles
    const [b] = plan;
    expect(b.lane).toBe("history");
    expect(b.events).toHaveLength(60);
    expect(b.day).toBe(day);
    // Chats lead the day (§11.2: chats → screen → browser).
    expect(b.streamId).toBe(streamIdOf("wa", "goa-gang@g.us"));

    // Every section is one stream and time-ordered (wrong: mixed-section).
    const byStream = new Map<string, string[]>();
    for (const e of b.events) {
      const sid = e.streamId!;
      (byStream.get(sid) ?? byStream.set(sid, []).get(sid)!).push(e.ts!);
    }
    expect(byStream.size).toBe(3);
    for (const times of byStream.values()) expect([...times].sort()).toEqual(times);
    // Section order in the bundle: wa, then screen, then browser.
    const order = [...byStream.keys()];
    expect(order[0]).toMatch(/^wa:/);
    expect(order[1]).toMatch(/^screen:/);
    expect(order[2]).toMatch(/^browser:/);
  });
});

describe("BND-02 · split at the largest gap", () => {
  it("300 events, 45k chars, a 6-hour gap at 02:00 → two bundles, split at the gap", () => {
    const day = "2026-08-20";
    const envs = [];
    const text = "x".repeat(150);
    // 150 events 00:00–01:59 (every 48 s), then silence until 08:00, then 150 more.
    for (let i = 0; i < 150; i++) envs.push(msgAt("night@g.us", DAY(day, "00:00") + i * 48_000, `${text} n${i}`, { origin: "backfill" }));
    for (let i = 0; i < 150; i++) envs.push(msgAt("night@g.us", DAY(day, "08:00") + i * 48_000, `${text} m${i}`, { origin: "backfill" }));
    append(envs);
    const total = (getDb().prepare(`SELECT SUM(LENGTH(text)) AS n FROM events`).get() as { n: number }).n;
    expect(total).toBeGreaterThan(HISTORY_SPLIT_CHARS);

    const plan = planHistory();
    expect(plan).toHaveLength(2);
    expect(plan.map((b) => b.partCount)).toEqual([2, 2]);
    const [a, b] = plan;
    expect(a.events.at(-1)!.ts! < `${day}T02:00:00.000Z`).toBe(true);
    expect(b.events[0]!.ts! >= `${day}T08:00:00.000Z`).toBe(true);
    expect(a.events.length + b.events.length).toBe(300);
    // wrong: split-at-cap-mid-burst — neither part is cut inside a 48 s run.
    for (const part of plan) {
      for (let i = 1; i < part.events.length; i++) {
        expect(Date.parse(part.events[i].ts!) - Date.parse(part.events[i - 1].ts!)).toBe(48_000);
      }
    }
  });

  it("splitAtLargestGap recurses until every part is under the cap and never splits a single event", () => {
    const mk = (i: number, ts: number, chars: number) => ({
      rowid: i,
      id: `e${i}`,
      ts: new Date(ts).toISOString(),
      kind: "wa.message",
      text: "y".repeat(chars),
      actor: "a",
      origin: "backfill" as const,
      ageBand: "A" as const,
      rolesJson: null,
      payloadJson: null,
    });
    const T = Date.parse("2026-08-20T00:00:00Z");
    // Three bursts of 20 events × 1,000 chars, gaps of 1 h and 3 h.
    const events = [
      ...Array.from({ length: 20 }, (_, i) => mk(i, T + i * 1000, 1_000)),
      ...Array.from({ length: 20 }, (_, i) => mk(20 + i, T + 3_600_000 + i * 1000, 1_000)),
      ...Array.from({ length: 20 }, (_, i) => mk(40 + i, T + 4 * 3_600_000 + i * 1000, 1_000)),
    ];
    const parts = splitAtLargestGap(events, 30_000);
    expect(parts.map((p) => p.events.length)).toEqual([20, 20, 20]);
    expect(splitAtLargestGap([mk(0, T, 50_000)], 30_000)).toHaveLength(1);
  });
});

describe("BND-03 · newest day first, empty days skipped", () => {
  it("D1..D5 with D3 empty → D5, D4, D2, D1; D3 never sent", () => {
    for (const d of ["2026-08-01", "2026-08-02", "2026-08-04", "2026-08-05"]) {
      append([msgAt("fam@g.us", DAY(d, "10:00"), `hello on ${d}`, { origin: "backfill" }), msgAt("fam@g.us", DAY(d, "10:05"), `again on ${d}`, { origin: "backfill" })]);
    }
    const days = pendingHistoryDays().map((d) => d.day);
    expect(days).toEqual(["2026-08-05", "2026-08-04", "2026-08-02", "2026-08-01"]);
    expect(planHistory().map((b) => b.day)).toEqual(["2026-08-05", "2026-08-04", "2026-08-02", "2026-08-01"]);
    // A `limit` serves the newest days first — the slot fill is newest-first too.
    expect(planHistory({ limit: 2 }).map((b) => b.day)).toEqual(["2026-08-05", "2026-08-04"]);
  });

  it("live events, tier-3 and tier-4 streams never enter the history plan", () => {
    append([msgAt("fam@g.us", DAY("2026-08-05", "10:00"), "live one")]); // origin live
    append([msgAt("promo@g.us", DAY("2026-08-04", "10:00"), "weekly offers", { origin: "backfill" })]);
    append([msgAt("ads@g.us", DAY("2026-08-03", "10:00"), "sale sale", { origin: "backfill" })]);
    setStreamTier(streamIdOf("wa", "promo@g.us"), "T3");
    setStreamTier(streamIdOf("wa", "ads@g.us"), "T4");
    expect(planHistory()).toHaveLength(0);
  });
});
