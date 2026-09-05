// ===========================================================================
// Golden BND-01/03/05/06 (GoldenEvals V2 — deterministic layer, code-asserted,
// no model calls) + the cursor/mark invariants they hang off (build P0.5,
// spec §6.2). BND-02 (low-signal deferral) and BND-04 (orphan scan) were
// retired with that behaviour in V6 P1 S0.5 (Build §2.3).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import {
  assignSlots,
  collectTick,
  DEFAULT_DISPATCH_CONFIG,
  markDispatched,
  type DispatchConfig,
} from "./dispatch.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-dispatch-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-08-28T12:00:00Z");
const MIN = 60_000;

function at(minsAfterT0: number): string {
  return new Date(T0 + minsAfterT0 * MIN).toISOString();
}

function msg(
  streamKey: string,
  minsAfterT0: number,
  text: string,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    ts: at(minsAfterT0),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey,
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: [], mentions: [] },
    payload: { text },
    ...overrides,
  };
}

function cursorOf(streamId: string): number {
  const row = getDb()
    .prepare(`SELECT cursor_rowid FROM streams WHERE id = ?`)
    .get(streamId) as { cursor_rowid: number } | undefined;
  return row?.cursor_rowid ?? 0;
}

function undispatchedCount(): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM events
          WHERE dispatched_at IS NULL AND stream_key IS NOT NULL`,
      )
      .get() as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------

describe("BND-01 · window cut, one bundle per active stream", () => {
  it("exactly 3 bundles at 12:05, all 18 events covered, cursors move only on dispatch", () => {
    // 12:00–12:05: 7 msgs Goa gang, 2 msgs Ma DM, 9 screen snapshots.
    const envs: EventEnvelope[] = [];
    for (let i = 0; i < 7; i++)
      envs.push(msg("goa-gang@g.us", i * 0.5, `goa planning message ${i} for Baga Beach`));
    for (let i = 0; i < 2; i++)
      envs.push(msg("ma-dm@s.net", 1 + i, `ma message about Sunday lunch plans ${i}`));
    for (let i = 0; i < 9; i++)
      envs.push(
        msg("chrome|goibibo", i * 0.4, `goibibo villa listing snapshot ${i}`, {
          source: "scr",
          kind: "screen.snapshot",
        }),
      );
    expect(appendEvents(envs, T0 + 5 * MIN).inserted).toBe(18);

    const plan = collectTick(T0 + 5 * MIN);

    // Exactly 3 bundles, keyed by stream — not one mega-bundle (time-blender),
    // not 18 per-event bundles (stream-shatter).
    expect(plan.bundles.length).toBe(3);
    const keys = plan.bundles.map((b) => b.streamKey).sort();
    expect(keys).toEqual(["chrome|goibibo", "goa-gang@g.us", "ma-dm@s.net"]);

    // Containment: all 18 events covered, each bundle pure (single stream).
    const total = plan.bundles.reduce((n, b) => n + b.events.length, 0);
    expect(total).toBe(18);
    for (const b of plan.bundles) {
      const ids = new Set(b.events.map(() => b.streamKey));
      expect(ids.size).toBe(1); // bundle_purity
    }

    // Cursor-skip guard: collect alone moves NO cursor.
    for (const b of plan.bundles) expect(cursorOf(b.streamId)).toBe(0);

    // Cursors advance only on successful dispatch.
    for (const b of plan.bundles) markDispatched(b, T0 + 5 * MIN);
    for (const b of plan.bundles) {
      expect(cursorOf(b.streamId)).toBeGreaterThan(0);
    }
    expect(undispatchedCount()).toBe(0);
    expect(collectTick(T0 + 10 * MIN).bundles).toEqual([]);
  });
});

describe("BND-03 · mid-conversation cut is harmless at the dispatch layer", () => {
  it("two windows over one conversation → two pure bundles, same stream, full coverage, no overlap", () => {
    // Villa discussion 12:03–12:08, cut at 12:05 and 12:10.
    const part1 = Array.from({ length: 5 }, (_, i) =>
      msg("goa-gang@g.us", 3 + i * 0.4, `villa shortlist option ${i} near Anjuna Beach`),
    );
    appendEvents(part1, T0 + 4.8 * MIN);

    const w1 = collectTick(T0 + 5 * MIN);
    expect(w1.bundles.length).toBe(1);
    expect(w1.bundles[0].events.length).toBe(5);
    markDispatched(w1.bundles[0], T0 + 5 * MIN);

    const part2 = Array.from({ length: 6 }, (_, i) =>
      msg("goa-gang@g.us", 5.5 + i * 0.4, `villa vote round two message ${i} Casa Menezes`),
    );
    appendEvents(part2, T0 + 8 * MIN);

    const w2 = collectTick(T0 + 10 * MIN);
    expect(w2.bundles.length).toBe(1);
    expect(w2.bundles[0].events.length).toBe(6);

    // cut-fork guard (dispatch layer): the second bundle is the SAME stream
    // lane — no new stream/lane is minted because the cut looked like a
    // boundary. (Episode joining is Orient's job in P1; dispatch guarantees
    // the substrate: same key, cumulative coverage, zero overlap.)
    expect(w2.bundles[0].streamId).toBe(w1.bundles[0].streamId);
    expect(w2.bundles[0].streamKey).toBe("goa-gang@g.us");
    const ids1 = new Set(w1.bundles[0].events.map((e) => e.id));
    for (const e of w2.bundles[0].events) expect(ids1.has(e.id)).toBe(false);
    markDispatched(w2.bundles[0], T0 + 10 * MIN);
    expect(undispatchedCount()).toBe(0);
  });
});

describe("BND-05 · max-size split with predecessor context", () => {
  it("an oversized band-D bundle splits into capped parts, each successor carrying the predecessor's summary", () => {
    const cfg: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG, maxBundleEvents: 100 };
    // Band-D chat-month: 350 events (cap 100 → 4 parts).
    const old = Array.from({ length: 350 }, (_, i) =>
      msg("old-gang@g.us", -60 * 24 * 900 + i, `ancient history message ${i}`, {
        origin: "backfill",
        ageBand: "D",
      }),
    );
    appendEvents(old, T0);

    const plan = collectTick(T0 + 5 * MIN, cfg);
    expect(plan.bundles.length).toBe(4);

    for (const [i, b] of plan.bundles.entries()) {
      // unbounded-prompt guard: every part is capped.
      expect(b.events.length).toBeLessThanOrEqual(cfg.maxBundleEvents);
      expect(b.part).toBe(i + 1);
      expect(b.partCount).toBe(4);
      if (i === 0) {
        expect(b.predecessorSummary).toBeUndefined();
      } else {
        // context-amnesia guard: successors carry the predecessor's summary.
        expect(b.predecessorSummary).toContain(`part ${i}`);
        expect(b.predecessorSummary).toContain("old-gang@g.us");
        expect(b.predecessorSummary).toContain(
          `ancient history message ${i * 100 - 1}`.slice(0, 30),
        );
      }
    }
    // Coverage across the split is exact and ordered.
    const all = plan.bundles.flatMap((b) => b.events.map((e) => e.text));
    expect(all.length).toBe(350);
    expect(all[0]).toBe("ancient history message 0");
    expect(all[349]).toBe("ancient history message 349");
  });
});

describe("BND-06 · live preempts backfill", () => {
  it("a live bundle is planned ahead of every backfill batch, then backfill resumes", () => {
    // Backfill saturating the queue: 6 streams × 50 events.
    const backfill: EventEnvelope[] = [];
    for (let s = 0; s < 6; s++)
      for (let i = 0; i < 50; i++)
        backfill.push(
          msg(`history-${s}@g.us`, -60 * 24 * 10 + i, `backfill message ${s}/${i}`, {
            origin: "backfill",
          }),
        );
    appendEvents(backfill, T0);

    // Live message arrives.
    appendEvents(
      [msg("goa-gang@g.us", 4, "flight prices dropped, book NOW?")],
      T0 + 4 * MIN,
    );

    const plan = collectTick(T0 + 5 * MIN);
    expect(plan.bundles.length).toBe(7);

    // queue-blind guard: the live bundle is FIRST, ahead of all backfill.
    expect(plan.bundles[0].lane).toBe("live");
    expect(plan.bundles[0].streamKey).toBe("goa-gang@g.us");
    for (const b of plan.bundles.slice(1)) expect(b.lane).toBe("backfill");

    // With every CLI slot contended, the live bundle still takes one now.
    const slotted = assignSlots(plan, 2);
    expect(slotted.length).toBe(2);
    expect(slotted[0].lane).toBe("live");

    // Backfill resumes after the live bundle is served.
    markDispatched(plan.bundles[0], T0 + 5 * MIN);
    const next = collectTick(T0 + 10 * MIN);
    expect(next.bundles.length).toBe(6);
    for (const b of next.bundles) expect(b.lane).toBe("backfill");
  });

  it("backfill lanes order A > B > C > D", () => {
    const mk = (key: string, band: "A" | "B" | "C" | "D"): EventEnvelope =>
      msg(key, 0, `band ${band} backfill content`, { origin: "backfill", ageBand: band });
    appendEvents([mk("d@g", "D"), mk("b@g", "B"), mk("a@g", "A"), mk("c@g", "C")], T0);
    const plan = collectTick(T0 + 5 * MIN);
    expect(plan.bundles.map((b) => b.ageBand)).toEqual(["A", "B", "C", "D"]);
  });
});
