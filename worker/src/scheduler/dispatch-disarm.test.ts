// ===========================================================================
// BND-08 · slot cap is absolute (GoldenEvals V6 P1 §5.5, S0.3 / T0-1, T7-3).
//
// Against the OLD dispatcher (startDispatcher's window clock), deterministic,
// no model calls: 3,000 undispatched events over 500 streams. `route` — the
// sink the tick hands bundles to — must fire ≤ cfg.slots times per tick, on
// the planned path, the orphan path, and re-dispatch (nothing marked, every
// tick sees the same backlog). This code dies in S3; until then it is what
// keeps the tree from repeating the 2026-08-29 incident.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import {
  DEFAULT_DISPATCH_CONFIG,
  markDispatched,
  orphanScan,
  startDispatcher,
  type DeltaBundle,
  type DispatchConfig,
} from "./dispatch.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-disarm-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-08-28T12:00:00Z");
const MIN = 60_000;

function msg(streamKey: string, minsAfterT0: number, text: string): EventEnvelope {
  return {
    ts: new Date(T0 + minsAfterT0 * MIN).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey,
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: [], mentions: [] },
    payload: { text },
  };
}

/** 3,000 events over 500 streams, 6 per stream, all above the signal floor. */
function seedBacklog(): void {
  const envs: EventEnvelope[] = [];
  for (let s = 0; s < 500; s++) {
    for (let i = 0; i < 6; i++) {
      envs.push(
        msg(`stream-${s}@g.us`, i * 0.5, `planning message ${i} for stream ${s} about the trip`),
      );
    }
  }
  expect(appendEvents(envs, T0).inserted).toBe(3000);
}

describe("BND-08 · slot cap is absolute", () => {
  it("route fires ≤ cfg.slots per tick — planned path, orphan path, re-dispatch", () => {
    const cfg: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG };
    seedBacklog();

    // Every event is already older than the orphan window, so BOTH paths see
    // the whole backlog on every tick — the worst case the cap has to hold.
    vi.setSystemTime(T0 + cfg.orphanWindows * cfg.windowMs + 5 * MIN);
    expect(orphanScan(Date.now(), cfg).orphanCount).toBe(3000);

    const perTick: number[] = [];
    let routed = 0;
    const handle = startDispatcher({
      cfg,
      // Never marks — the sink here is a counter, so the same 3,000 rows are
      // re-dispatchable on every window.
      onBundle: () => {
        routed++;
      },
      onDigestBundle: () => {
        routed++;
      },
    });
    try {
      for (let tick = 0; tick < 5; tick++) {
        routed = 0;
        vi.advanceTimersByTime(cfg.windowMs);
        perTick.push(routed);
      }
    } finally {
      handle.stop();
    }

    expect(perTick).toHaveLength(5);
    for (const n of perTick) {
      expect(n).toBeLessThanOrEqual(cfg.slots);
      expect(n).toBeGreaterThan(0); // the cap bounds, it does not starve
    }
  });

  it("orphans fill only the slots the planned path left free, oldest first", () => {
    const cfg: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG, slots: 4 };
    // Two young streams (planned path only) + six old streams (orphan path).
    const young: EventEnvelope[] = [];
    for (let s = 0; s < 2; s++)
      for (let i = 0; i < 3; i++)
        young.push(msg(`young-${s}@g.us`, 60 + i, `fresh planning message ${i} for young ${s}`));
    const old: EventEnvelope[] = [];
    for (let s = 0; s < 6; s++)
      for (let i = 0; i < 3; i++)
        old.push(msg(`old-${s}@g.us`, i, `stale planning message ${i} for old ${s}`));
    expect(appendEvents(old, T0).inserted).toBe(18);
    expect(appendEvents(young, T0 + 60 * MIN).inserted).toBe(6);

    // now = T0+61min: old rows (captured T0) are past the 15-min orphan
    // window; young rows (captured T0+60) are not.
    vi.setSystemTime(T0 + 61 * MIN);

    const routed: DeltaBundle[] = [];
    const handle = startDispatcher({
      cfg,
      onBundle: (b) => {
        routed.push(b);
        // Mark the planned young bundles so the SECOND tick is orphan-only.
        if (b.streamKey.startsWith("young-")) markDispatched(b, Date.now());
      },
    });
    try {
      vi.advanceTimersByTime(cfg.windowMs);
      const tick1 = routed.splice(0);
      // Planned path: 8 streams have undispatched rows → 4 slotted, no room
      // for orphans. Exactly cfg.slots, never planned + orphans.
      expect(tick1).toHaveLength(4);

      vi.advanceTimersByTime(cfg.windowMs);
      const tick2 = routed.splice(0);
      expect(tick2).toHaveLength(4);
      expect(tick2.every((b) => b.streamKey.startsWith("old-"))).toBe(true);
    } finally {
      handle.stop();
    }
  });
});
