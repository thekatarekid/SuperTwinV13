// ===========================================================================
// §5.2 processing order + CAT-05 slot-leak — deterministic, code-asserted.
//
// CAT-05: backfill running, Cat-1 data 60% done, Cat-1 media queue 300, Cat-2
// media queue 900. Over a simulated hour the CLI slots serve ONLY Cat-1
// (data + media) until Cat-1 fully completes; then Cat-2 data (Digest); Cat-2
// media last; whisper (local) runs throughout; a live event preempts all.
// Wrong: `slot-leak` — ANY Cat-2 call while Cat-1 pending.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { assignSlots, collectTick, markDispatched } from "./dispatch.js";
import {
  admitWork,
  applyFirstExperienceSlice,
  compareBundles,
  isFirstExperience,
  planCliSlots,
  sourceRank,
  type OrderableBundle,
  type SlotWork,
} from "./priority.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");

// ---------------------------------------------------------------------------
// CAT-05 · the slot policy, simulated over an hour
// ---------------------------------------------------------------------------

describe("CAT-05 · enrichment ordering policy (code-asserted)", () => {
  interface SimState {
    cat1Data: number;
    cat1Media: number;
    cat2Data: number;
    cat2Media: number;
    whisper: number;
  }

  function candidates(s: SimState, live: number): SlotWork[] {
    const out: SlotWork[] = [];
    for (let i = 0; i < live; i++) out.push({ id: `live-${i}`, lane: "live", kind: "data", category: "cat1" });
    if (s.cat1Data > 0) out.push({ id: "c1-data", lane: "backfill", kind: "data", category: "cat1" });
    if (s.cat1Media > 0) out.push({ id: "c1-media", lane: "backfill", kind: "media", category: "cat1" });
    if (s.cat2Data > 0) out.push({ id: "c2-data", lane: "backfill", kind: "data", category: "cat2" });
    if (s.cat2Media > 0) out.push({ id: "c2-media", lane: "backfill", kind: "media", category: "cat2" });
    if (s.whisper > 0) out.push({ id: "whisper", lane: "backfill", kind: "media", category: "cat2", local: true });
    return out;
  }

  it("no Cat-2 slot while Cat-1 pending; then Digest; Cat-2 media last; whisper throughout; live preempts", () => {
    // Cat-1 data 60% done (200 of 500 left), media queues 300 / 900.
    const s: SimState = { cat1Data: 200, cat1Media: 300, cat2Data: 120, cat2Media: 900, whisper: 50 };
    const SLOTS = 4;
    let leaks = 0;
    let whisperWindows = 0;
    const servedOrder: string[] = [];

    for (let minute = 0; minute < 60; minute += 5) {
      const liveArrivals = minute === 30 ? 1 : 0; // one live event mid-hour
      const { slots, local } = planCliSlots(
        candidates(s, liveArrivals),
        { cat1DataPending: s.cat1Data, cat1MediaPending: s.cat1Media },
        SLOTS,
      );
      if (local.length > 0) whisperWindows += 1; // whisper is exempt, every window
      if (liveArrivals > 0) expect(slots[0].lane).toBe("live"); // live preempts all
      for (const w of slots) {
        if (w.category === "cat2" && (s.cat1Data > 0 || s.cat1Media > 0)) leaks += 1;
        servedOrder.push(w.id);
      }
      // Drain: each slotted lane clears a chunk this window.
      for (const w of slots) {
        if (w.id === "c1-data") s.cat1Data = Math.max(0, s.cat1Data - 100);
        if (w.id === "c1-media") s.cat1Media = Math.max(0, s.cat1Media - 150);
        if (w.id === "c2-data") s.cat2Data = Math.max(0, s.cat2Data - 60);
        if (w.id === "c2-media") s.cat2Media = Math.max(0, s.cat2Media - 300);
      }
      s.whisper = Math.max(0, s.whisper - 10);
    }

    expect(leaks).toBe(0); // the CAT-05 hard gate: zero slot-leak
    expect(whisperWindows).toBeGreaterThan(0);
    // Cat-1 completed, then Cat-2 data (Digest) came BEFORE Cat-2 media.
    expect(servedOrder).toContain("c2-data");
    expect(servedOrder.indexOf("c2-data")).toBeLessThan(servedOrder.indexOf("c2-media"));
    // While Cat-1 ran, data + media shared the slots in parallel.
    const firstWindowServed = servedOrder.slice(0, 2);
    expect(firstWindowServed).toEqual(["c1-data", "c1-media"]);
  });

  it("admitWork: live and local always pass; cat2 only when ALL cat1 done", () => {
    const pending = { cat1DataPending: 1, cat1MediaPending: 0 };
    const clear = { cat1DataPending: 0, cat1MediaPending: 0 };
    const cat2: SlotWork = { id: "d", lane: "backfill", kind: "data", category: "cat2" };
    expect(admitWork(cat2, pending)).toBe(false);
    expect(admitWork(cat2, { cat1DataPending: 0, cat1MediaPending: 5 })).toBe(false);
    expect(admitWork(cat2, clear)).toBe(true);
    expect(admitWork({ ...cat2, lane: "live" }, pending)).toBe(true);
    expect(admitWork({ ...cat2, local: true }, pending)).toBe(true);
    expect(admitWork({ ...cat2, category: "cat1" }, pending)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The §5.2 comparator
// ---------------------------------------------------------------------------

function bundle(over: Partial<OrderableBundle>): OrderableBundle {
  return {
    streamId: "wa:st:a@g.us",
    streamKey: "a@g.us",
    lane: "backfill",
    ageBand: "A",
    day: "2026-08-27",
    category: "cat1",
    part: 1,
    ...over,
  };
}

const noEngagement = { engagement: new Map<string, number>() };

describe("§5.2 order: day-major, source order, Cat 1 first, engagement", () => {
  it("live preempts everything, always", () => {
    const a = bundle({ lane: "live", ageBand: "D", category: "cat2" });
    const b = bundle({ lane: "backfill", ageBand: "A" });
    expect(compareBundles(a, b, noEngagement)).toBeLessThan(0);
  });

  it("day-major, newest day first", () => {
    const newer = bundle({ day: "2026-08-27" });
    const older = bundle({ streamId: "wa:st:b@g.us", streamKey: "b@g.us", day: "2026-08-20" });
    expect(compareBundles(newer, older, noEngagement)).toBeLessThan(0);
    expect(compareBundles(older, newer, noEngagement)).toBeGreaterThan(0);
  });

  it("within a day, source order: WhatsApp -> Screen -> Browser", () => {
    expect(sourceRank("wa")).toBeLessThan(sourceRank("screen"));
    expect(sourceRank("screen")).toBeLessThan(sourceRank("browser"));
    expect(sourceRank("browser")).toBeLessThan(sourceRank("mail"));
    const wa = bundle({});
    const screen = bundle({ streamId: "screen:st:main", streamKey: "main" });
    const browser = bundle({ streamId: "browser:st:goibibo.com", streamKey: "goibibo.com" });
    expect(compareBundles(wa, screen, noEngagement)).toBeLessThan(0);
    expect(compareBundles(screen, browser, noEngagement)).toBeLessThan(0);
  });

  it("within a source, Cat 1 before Cat 2; unknown orders as Cat 1", () => {
    const c1 = bundle({});
    const c2 = bundle({ streamId: "wa:st:promo@s", streamKey: "promo@s", category: "cat2" });
    const unknown = bundle({ streamId: "wa:st:new@s", streamKey: "new@s", category: null });
    expect(compareBundles(c1, c2, noEngagement)).toBeLessThan(0);
    expect(compareBundles(unknown, c2, noEngagement)).toBeLessThan(0);
  });

  it("within Cat 1, engagement descending (ordering signal only)", () => {
    const hot = bundle({ streamId: "wa:st:hot@g.us", streamKey: "hot@g.us" });
    const cold = bundle({ streamId: "wa:st:cold@g.us", streamKey: "cold@g.us" });
    const ctx = { engagement: new Map([["wa:st:hot@g.us", 12], ["wa:st:cold@g.us", 1]]) };
    expect(compareBundles(hot, cold, ctx)).toBeLessThan(0);
  });

  it("band stays the coarse backfill key (the BND contract)", () => {
    const bandA = bundle({ day: "2026-08-01" });
    const bandD = bundle({ streamId: "wa:st:old@g.us", streamKey: "old@g.us", ageBand: "D", day: "2023-01-01" });
    expect(compareBundles(bandA, bandD, noEngagement)).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// First-experience slice
// ---------------------------------------------------------------------------

type SliceBundle = OrderableBundle & { events: { ts: string | null }[] };

function sliceBundle(over: Partial<SliceBundle>, daysAgo: number): SliceBundle {
  return {
    ...bundle({}),
    events: [{ ts: new Date(NOW - daysAgo * 86_400_000).toISOString() }],
    ...over,
  } as SliceBundle;
}

describe("first-experience slice (spec §5.2.4)", () => {
  it("recent top-engagement chats jump the backfill queue, never live", () => {
    const live = sliceBundle({ lane: "live", streamId: "wa:st:live@s", streamKey: "live@s" }, 0);
    const oldChat = sliceBundle({ streamId: "wa:st:old@g.us", streamKey: "old@g.us", ageBand: "B", day: "2026-05-01" }, 100);
    const hotRecent = sliceBundle({ streamId: "wa:st:hot@g.us", streamKey: "hot@g.us" }, 2);
    const coldRecent = sliceBundle({ streamId: "wa:st:cold@g.us", streamKey: "cold@g.us" }, 2);
    const browserRecent = sliceBundle({ streamId: "browser:st:x.com", streamKey: "x.com" }, 1);
    const ctx = { engagement: new Map([["wa:st:hot@g.us", 40], ["wa:st:cold@g.us", 4]]) };

    const ordered = applyFirstExperienceSlice(
      [live, oldChat, coldRecent, hotRecent, browserRecent],
      ctx,
      { nowMs: NOW },
    );
    expect(ordered[0]).toBe(live); // live is never displaced
    expect(ordered[1]).toBe(hotRecent); // top engagement first
    expect(ordered[2]).toBe(coldRecent);
    // Browser and old history keep their relative order behind the slice.
    expect(ordered.indexOf(browserRecent)).toBeGreaterThan(2);
    expect(ordered.indexOf(oldChat)).toBeGreaterThan(2);
  });

  it("the recency window clamps to the spec's 3–7 days", () => {
    const nineDays = sliceBundle({ streamId: "wa:st:hot@g.us", streamKey: "hot@g.us" }, 9);
    const ctx = { engagement: new Map([["wa:st:hot@g.us", 40]]) };
    const ordered = applyFirstExperienceSlice([nineDays], ctx, { nowMs: NOW, days: 30 });
    // days=30 clamps to 7 -> a 9-day-old chat is NOT in the slice (order unchanged).
    expect(ordered).toEqual([nineDays]);
  });
});

// ---------------------------------------------------------------------------
// Dispatch integration: the gate + first experience against a real DB
// ---------------------------------------------------------------------------

describe("dispatch integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "supertwin-priority-"));
    process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
    closeDb();
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    delete process.env.SUPERTWIN_DB_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function backfillMsg(streamKey: string, daysAgo: number, text: string): EventEnvelope {
    return {
      ts: new Date(NOW - daysAgo * 86_400_000).toISOString(),
      source: "wa",
      kind: "wa.message",
      origin: "backfill",
      streamKey,
      actor: "contact:x",
      roles: { sender: "contact:x", audience: ["self"], receiver: [], mentions: [] },
      payload: { text },
    };
  }

  it("assignSlots never hands a Cat-2 bundle a slot while Cat-1 data is pending (slot-leak)", () => {
    appendEvents(
      [backfillMsg("family@g.us", 2, "dinner sunday?"), backfillMsg("promo@s", 2, "SALE 60% off")],
      NOW,
    );
    const db = getDb();
    db.prepare(`UPDATE streams SET category = 'cat1' WHERE id = 'wa:st:family@g.us'`).run();
    db.prepare(`UPDATE streams SET category = 'cat2' WHERE id = 'wa:st:promo@s'`).run();

    const plan = collectTick(NOW);
    expect(plan.bundles).toHaveLength(2);
    // 4 free slots, but the cat2 bundle must NOT ride along while cat1 pends.
    const slotted = assignSlots(plan, 4);
    expect(slotted.map((b) => b.streamId)).toEqual(["wa:st:family@g.us"]);

    // Cat-1 completes -> the next window admits the Digest bundle.
    markDispatched(slotted[0], NOW);
    const next = assignSlots(collectTick(NOW + 1), 4);
    expect(next.map((b) => b.streamId)).toEqual(["wa:st:promo@s"]);
    expect(next[0].category).toBe("cat2");
  });

  it("first experience holds until the first dispatch, then normal order stands", () => {
    appendEvents([backfillMsg("family@g.us", 2, "dinner sunday?")], NOW);
    expect(isFirstExperience()).toBe(true);
    const plan = collectTick(NOW);
    markDispatched(plan.bundles[0], NOW);
    expect(isFirstExperience()).toBe(false);
  });
});
