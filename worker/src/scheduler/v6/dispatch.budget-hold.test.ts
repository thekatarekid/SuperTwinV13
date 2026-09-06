// ===========================================================================
// FIX-C1 — a hard stop HOLDS the dispatcher, it does not burn it.
//
// The user's 13.11.5 install tripped the $3/hour ceiling 41 minutes into its
// first run. `budget_tripped_at` latches and never clears on its own (SPD-02),
// so every background call after that was refused BEFORE spawn. The dispatcher
// did not know that: it kept building bundles and handing them to sinks that
// threw, and an ordinary failure walks the three-strikes ladder — at the third
// the bundle is dead-lettered AND `markDispatched` stamps its rows. A latch
// nobody noticed would therefore quietly EAT the backlog it was refusing to
// read: the events end `dispatched_at IS NOT NULL` and no lane ever offers
// them again, even after an operator clears the latch.
//
// So the contract asserted here is the SET-01 contract, for the other switch:
// held means nothing dispatched, nothing stamped, nothing attempted, nothing
// dead-lettered — and the first tick after the reset does exactly the work
// that was waiting.
//
// Stubbed sinks, injected clock, ZERO model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../db/connection.js";
import {
  resetBudgetForTests,
  resetBudgetLatch,
  setModelActivityPaused,
  tripBudget,
} from "../../providers/budget.js";
import { listDeadLetters } from "./attempts.js";
import { Dispatcher } from "./dispatch.js";
import {
  append,
  dispatchedIds,
  MIN,
  msgAt,
  openScratchDb,
  seedSpace,
  T0,
  undispatchedCount,
  type ScratchDb,
} from "./testutil.js";

let db: ScratchDb;

beforeEach(() => {
  db = openScratchDb("supertwin-c1-hold-");
  resetBudgetForTests();
});

afterEach(() => {
  resetBudgetForTests();
  db.close();
});

function clock(start = T0) {
  let now = start;
  return { now: () => now, set: (t: number) => (now = t) };
}

const noBootstrap = { preset: () => "balanced" as const };

/** Twenty spaces + an old consent: the preset window, not the bootstrap one. */
function matureWorld(): void {
  for (let i = 0; i < 20; i++) seedSpace(`sp_${i}`, `space ${i}`);
  getDb()
    .prepare(`INSERT INTO consents (id, source, state, granted_at) VALUES ('c1', 'wa', 'connected', ?)`)
    .run(new Date(T0 - 30 * 86_400_000).toISOString());
}

function attemptRows(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM bundle_attempts`).get() as { n: number };
  return row.n;
}

describe("FIX-C1 — the budget latch holds the live lane, it does not consume it", () => {
  it("latched: no sink call, no attempt row, nothing stamped — and the reset tick does the waiting work", async () => {
    matureWorld();
    const ids = append([msgAt("goa-gang@g.us", T0, "ok")]);
    const c = clock(T0);
    const calls: number[] = [];
    const d = new Dispatcher({
      now: c.now,
      sink: () => {
        calls.push(c.now());
        return { status: "committed" };
      },
      ...noBootstrap,
      history: false,
      digest: false,
    });

    // The ceiling is reached: exactly what happened at 15:12:59.534Z.
    tripBudget("$3.05 spent in the last hour (ceiling $3)", T0);

    // Three offers, spread past the 30 s live re-offer window and past the
    // 0 / +5 / +10 attempt ladder that would otherwise dead-letter the bundle.
    for (const m of [0, 1, 5, 10, 20]) {
      c.set(T0 + m * MIN);
      expect(d.tick(c.now()).routed).toHaveLength(0);
    }

    expect(calls).toEqual([]); // no model work was even offered
    expect(d.stats().heldForBudget).toBeGreaterThan(0);
    expect(attemptRows()).toBe(0); // wrong shape: a strike per refusal
    expect(listDeadLetters()).toHaveLength(0); // wrong shape: dead-lettered
    expect(d.stats().deadLetters).toBe(0);
    expect(dispatchedIds().has(ids[0])).toBe(false); // wrong shape: stamped
    expect(undispatchedCount()).toBe(1); // the event is still waiting

    // The operator resumes. The very next tick dispatches what was held.
    resetBudgetLatch();
    c.set(T0 + 21 * MIN);
    expect(d.tick(c.now()).routed).toHaveLength(1);
    await d.drain();
    expect(calls).toEqual([T0 + 21 * MIN]);
  });

  it("the kill switch holds the same way, and releasing it releases the work", async () => {
    matureWorld();
    append([msgAt("rohan", T0, "hi")]);
    const c = clock(T0);
    let calls = 0;
    const d = new Dispatcher({
      now: c.now,
      sink: () => (calls++, { status: "committed" }),
      ...noBootstrap,
      history: false,
      digest: false,
    });

    setModelActivityPaused(true, T0);
    for (const m of [0, 1, 5, 10]) {
      c.set(T0 + m * MIN);
      d.tick(c.now());
    }
    expect(calls).toBe(0);
    expect(attemptRows()).toBe(0);
    expect(undispatchedCount()).toBe(1);

    setModelActivityPaused(false, T0 + 11 * MIN);
    c.set(T0 + 11 * MIN);
    expect(d.tick(c.now()).routed).toHaveLength(1);
    await d.drain();
    expect(calls).toBe(1);
  });
});

describe("FIX-C1 — the history lane is not dead-lettered by a latch", () => {
  it("a latched hour does not eat the backfill: no strikes, no stamps, and it dispatches after the reset", async () => {
    matureWorld();
    const ids = append([
      msgAt("fam@g.us", Date.parse("2024-01-01T09:00:00Z"), "old day", { origin: "backfill" }),
    ]);
    const c = clock(T0);
    let calls = 0;
    const d = new Dispatcher({
      now: c.now,
      sink: () => (calls++, { status: "committed" }),
      ...noBootstrap,
      digest: false,
    });

    tripBudget("$3.05 spent in the last hour (ceiling $3)", T0);
    // The ladder that would have consumed it: 0, +5, +10 is three strikes.
    for (const m of [0, 5, 10, 15, 60, 180]) {
      c.set(T0 + m * MIN);
      d.tick(c.now());
    }
    expect(calls).toBe(0);
    expect(attemptRows()).toBe(0);
    expect(listDeadLetters()).toHaveLength(0);
    expect(dispatchedIds().has(ids[0])).toBe(false);
    expect(undispatchedCount()).toBe(1);

    resetBudgetLatch();
    c.set(T0 + 181 * MIN);
    expect(d.tick(c.now()).routed).toHaveLength(1);
    await d.drain();
    expect(calls).toBe(1);
  });
});
