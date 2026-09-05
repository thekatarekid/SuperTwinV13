// ===========================================================================
// BND-08 · slot cap is absolute (GoldenEvals V6 P1 §5.5, S0.3 / T0-1, T7-3).
//
// Against the OLD dispatcher's tick (runDispatchTick), deterministic, no model
// calls: 3,000 undispatched events over 500 streams. `route` — the sink the
// tick hands bundles to — must fire ≤ cfg.slots times per tick, on the planned
// path and on re-dispatch (nothing marked, every tick sees the same backlog).
// S0.5 deleted the window clock and the orphan scan (Build §2.3), so the tick
// is now a function with no timer; this code dies in S3. Until then it is
// what keeps the tree from repeating the 2026-08-29 incident.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import {
  DEFAULT_DISPATCH_CONFIG,
  markDispatched,
  runDispatchTick,
  type DeltaBundle,
  type DispatchConfig,
} from "./dispatch.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-disarm-"));
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

/** 3,000 events over 500 streams, 6 per stream. */
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
  it("route fires ≤ cfg.slots per tick — planned path and re-dispatch", () => {
    const cfg: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG };
    seedBacklog();

    const perTick: number[] = [];
    for (let tick = 0; tick < 5; tick++) {
      let routed = 0;
      // Never marks — the sink here is a counter, so the same 3,000 rows are
      // re-dispatchable on every tick: the worst case the cap has to hold.
      const result = runDispatchTick(
        {
          cfg,
          onBundle: () => {
            routed++;
          },
          onDigestBundle: () => {
            routed++;
          },
        },
        T0 + (10 + tick * 5) * MIN,
      );
      expect(result.routed).toHaveLength(routed);
      expect(result.heldBack).toBe(500 - routed);
      perTick.push(routed);
    }

    expect(perTick).toHaveLength(5);
    for (const n of perTick) {
      expect(n).toBeLessThanOrEqual(cfg.slots);
      expect(n).toBeGreaterThan(0); // the cap bounds, it does not starve
    }
  });

  it("a marked bundle leaves the backlog; the rest fill later ticks, still capped", () => {
    const cfg: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG, slots: 4 };
    const envs: EventEnvelope[] = [];
    for (let s = 0; s < 6; s++)
      for (let i = 0; i < 3; i++)
        envs.push(msg(`stream-${s}@g.us`, i, `planning message ${i} for stream ${s}`));
    expect(appendEvents(envs, T0).inserted).toBe(18);

    const routed: DeltaBundle[] = [];
    const opts = {
      cfg,
      onBundle: (b: DeltaBundle) => {
        routed.push(b);
        markDispatched(b, T0 + 5 * MIN);
      },
    };

    // Six streams have undispatched rows → exactly cfg.slots leave, never six.
    runDispatchTick(opts, T0 + 5 * MIN);
    const tick1 = routed.splice(0);
    expect(tick1).toHaveLength(4);

    // The marked four are gone; the remaining two ride the next tick.
    runDispatchTick(opts, T0 + 10 * MIN);
    const tick2 = routed.splice(0);
    expect(tick2).toHaveLength(2);
    const keys = new Set([...tick1, ...tick2].map((b) => b.streamKey));
    expect(keys.size).toBe(6);

    // Nothing left: a third tick routes nothing.
    expect(runDispatchTick(opts, T0 + 15 * MIN).routed).toHaveLength(0);
  });
});
