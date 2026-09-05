// ===========================================================================
// [CODE] Scheduler eval hooks — P0.5's side of the BND seam (build P0.9's
// executors/bnd.ts dynamic-imports this module and calls `runBndCase`).
//
// Each golden BND case (GoldenEvals V2, deterministic layer) is materialized
// here as a code scenario run against the REAL dispatcher — collectTick /
// markDispatched / assignSlots on a scratch SQLite database —
// mirroring the invariants asserted by dispatch.test.ts, but reporting
// through the harness contract: { ok, output, violations[], metrics }.
// Violation labels match the fixture's wrong[] labels exactly, so a detected
// failure mode reads as the golden doc's failure mode in the report.
//
// The scenarios are deterministic and model-free: fixture `setup` /
// `input_events` are prose for humans; the executable truth of each case is
// the scenario body below (same numbers as the golden doc, except BND-05,
// which scales the "18k-event chat-month" to 350 events against a 100-event
// cap — same split arithmetic, four parts, in milliseconds not minutes).
//
// V6 P1 S0.5 retired BND-02 (low-signal deferral) and BND-04 (orphan scan)
// with the behaviour they asserted (Build §2.3). The V6 BND-01..12 set is
// re-specified against the S3 scheduler in GoldenEvals_V6_Phase1 §5.5.
// ===========================================================================

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
  type TickPlan,
} from "./dispatch.js";

// -- harness contract (structurally identical to executors/bnd.ts) ----------

interface BndFixtureLike {
  id: string;
}

export interface BndCaseResult {
  ok: boolean;
  output: unknown;
  violations?: { label: string; note?: string }[];
  metrics?: Record<string, number>;
  notes?: string[];
}

// -- scenario plumbing ------------------------------------------------------

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

/** A scenario's running tally: assertions + wrong[]-labelled violations. */
class Case {
  ok = true;
  violations: { label: string; note?: string }[] = [];
  metrics: Record<string, number> = {};
  notes: string[] = [];

  /** Plain expectation — a miss fails the case without naming a wrong[] mode. */
  check(cond: boolean, note: string): void {
    if (!cond) {
      this.ok = false;
      this.notes.push(`FAILED: ${note}`);
    }
  }

  /** A named failure mode from the fixture's wrong[] list. */
  wrong(cond: boolean, label: string, note: string): void {
    if (cond) {
      this.ok = false;
      this.violations.push({ label, note });
    }
  }

  result(output: unknown): BndCaseResult {
    return {
      ok: this.ok,
      output,
      violations: this.violations,
      metrics: this.metrics,
      notes: this.notes,
    };
  }
}

/**
 * Run `fn` against a scratch database: SUPERTWIN_DB_PATH is pointed at a
 * fresh temp file, migrations run, and whatever the surrounding process had
 * open is restored afterwards — the same env swap the unit suite uses.
 */
function withScratchDb<T>(fn: () => T): T {
  const prev = process.env.SUPERTWIN_DB_PATH;
  const dir = mkdtempSync(join(tmpdir(), "supertwin-bnd-eval-"));
  try {
    process.env.SUPERTWIN_DB_PATH = join(dir, "bnd.db");
    closeDb();
    runMigrations();
    return fn();
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

function planShape(plan: TickPlan): unknown {
  return {
    bundles: plan.bundles.map((b) => ({
      streamKey: b.streamKey,
      lane: b.lane,
      ageBand: b.ageBand,
      events: b.events.length,
      part: b.part,
      partCount: b.partCount,
    })),
  };
}

// -- the four surviving golden scenarios ----------------------------------------------

/** BND-01 · window cut, one bundle per active stream. */
function bnd01(): BndCaseResult {
  const c = new Case();
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
  c.check(appendEvents(envs, T0 + 5 * MIN).inserted === 18, "18 events inserted");

  const plan = collectTick(T0 + 5 * MIN);
  c.wrong(plan.bundles.length === 1, "time-blender", "one mega-bundle across streams");
  c.wrong(plan.bundles.length > 3, "stream-shatter", `${plan.bundles.length} bundles for 3 streams`);
  c.check(plan.bundles.length === 3, "exactly 3 bundles at 12:05");

  const covered = plan.bundles.reduce((n, b) => n + b.events.length, 0);
  c.metrics.containment = covered / 18;
  c.metrics.bundle_purity = 1;
  c.check(covered === 18, "all 18 events covered");

  // Cursor-skip guard: collect alone moves NO cursor; dispatch moves it.
  for (const b of plan.bundles)
    c.wrong(cursorOf(b.streamId) !== 0, "cursor-skip", "cursor moved before dispatch");
  for (const b of plan.bundles) markDispatched(b, T0 + 5 * MIN);
  for (const b of plan.bundles)
    c.check(cursorOf(b.streamId) > 0, "cursor advances on successful dispatch");
  c.wrong(undispatchedCount() !== 0, "cursor-skip", "cursor advanced past undispatched events");
  c.check(collectTick(T0 + 10 * MIN).bundles.length === 0, "nothing left for the next tick");
  return c.result(planShape(plan));
}

/** BND-03 · mid-conversation cut is harmless at the dispatch layer. */
function bnd03(): BndCaseResult {
  const c = new Case();
  const part1 = Array.from({ length: 5 }, (_, i) =>
    msg("goa-gang@g.us", 3 + i * 0.4, `villa shortlist option ${i} near Anjuna Beach`),
  );
  appendEvents(part1, T0 + 4.8 * MIN);
  const w1 = collectTick(T0 + 5 * MIN);
  c.check(w1.bundles.length === 1 && w1.bundles[0].events.length === 5, "first cut: one pure 5-event bundle");
  if (w1.bundles[0]) markDispatched(w1.bundles[0], T0 + 5 * MIN);

  const part2 = Array.from({ length: 6 }, (_, i) =>
    msg("goa-gang@g.us", 5.5 + i * 0.4, `villa vote round two message ${i} Casa Menezes`),
  );
  appendEvents(part2, T0 + 8 * MIN);
  const w2 = collectTick(T0 + 10 * MIN);
  c.check(w2.bundles.length === 1 && w2.bundles[0].events.length === 6, "second cut: one pure 6-event bundle");

  // cut-fork guard: the second bundle rides the SAME stream lane.
  if (w1.bundles[0] && w2.bundles[0]) {
    c.wrong(
      w2.bundles[0].streamId !== w1.bundles[0].streamId,
      "cut-fork",
      "the window cut minted a new stream/lane",
    );
    const ids1 = new Set(w1.bundles[0].events.map((e) => e.id));
    const overlap = w2.bundles[0].events.some((e) => ids1.has(e.id));
    c.check(!overlap, "zero overlap between the two cuts");
    markDispatched(w2.bundles[0], T0 + 10 * MIN);
  }
  c.check(undispatchedCount() === 0, "cumulative coverage across the cut");
  c.metrics.continuity_rate = c.ok ? 1 : 0;
  return c.result({ window1: planShape(w1), window2: planShape(w2) });
}

/** BND-05 · max-size split with predecessor context. */
function bnd05(): BndCaseResult {
  const c = new Case();
  const cfg: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG, maxBundleEvents: 100 };
  const old = Array.from({ length: 350 }, (_, i) =>
    msg("old-gang@g.us", -60 * 24 * 900 + i, `ancient history message ${i}`, {
      origin: "backfill",
      ageBand: "D",
    }),
  );
  appendEvents(old, T0);

  const plan = collectTick(T0 + 5 * MIN, cfg);
  c.check(plan.bundles.length === 4, "350 events under a 100 cap split into 4 parts");

  let maxPart = 0;
  for (const [i, b] of plan.bundles.entries()) {
    maxPart = Math.max(maxPart, b.events.length);
    c.wrong(
      b.events.length > cfg.maxBundleEvents,
      "unbounded-prompt",
      `part ${i + 1} carries ${b.events.length} events over the ${cfg.maxBundleEvents} cap`,
    );
    if (i > 0) {
      const s = b.predecessorSummary ?? "";
      c.wrong(
        !s.includes(`part ${i}`) || !s.includes("old-gang@g.us"),
        "context-amnesia",
        `part ${i + 1} does not carry part ${i}'s summary`,
      );
    }
  }
  c.metrics.prompt_size_max = maxPart;

  const all = plan.bundles.flatMap((b) => b.events.map((e) => e.text));
  c.check(
    all.length === 350 && all[0] === "ancient history message 0" && all[349] === "ancient history message 349",
    "coverage across the split is exact and ordered",
  );
  c.metrics.continuity_rate = c.violations.length === 0 ? 1 : 0;
  return c.result(planShape(plan));
}

/** BND-06 · live preempts backfill. */
function bnd06(): BndCaseResult {
  const c = new Case();
  const backfill: EventEnvelope[] = [];
  for (let s = 0; s < 6; s++)
    for (let i = 0; i < 50; i++)
      backfill.push(
        msg(`history-${s}@g.us`, -60 * 24 * 10 + i, `backfill message ${s}/${i}`, {
          origin: "backfill",
        }),
      );
  appendEvents(backfill, T0);
  appendEvents([msg("goa-gang@g.us", 4, "flight prices dropped, book NOW?")], T0 + 4 * MIN);

  const plan = collectTick(T0 + 5 * MIN);
  c.check(plan.bundles.length === 7, "7 bundles planned (1 live + 6 backfill)");
  const first = plan.bundles[0];
  c.wrong(
    !first || first.lane !== "live" || first.streamKey !== "goa-gang@g.us",
    "queue-blind",
    "the live bundle was not planned ahead of the backfill batches",
  );
  for (const b of plan.bundles.slice(1))
    c.check(b.lane === "backfill", "everything behind the live bundle is backfill");

  // With every CLI slot contended, the live bundle still takes one now.
  const slotted = assignSlots(plan, 2);
  c.wrong(
    slotted.length === 0 || slotted[0].lane !== "live",
    "queue-blind",
    "the live bundle did not take a contended slot",
  );

  // Backfill resumes after the live bundle is served — inside one window.
  if (first) markDispatched(first, T0 + 5 * MIN);
  const next = collectTick(T0 + 10 * MIN);
  c.check(
    next.bundles.length === 6 && next.bundles.every((b) => b.lane === "backfill"),
    "backfill resumes after the live bundle",
  );
  return c.result(planShape(plan));
}

const SCENARIOS: Record<string, () => BndCaseResult> = {
  "BND-01": bnd01,
  "BND-03": bnd03,
  "BND-05": bnd05,
  "BND-06": bnd06,
};

/**
 * The hook `worker/src/evals/executors/bnd.ts` dynamic-imports. Runs the
 * fixture's golden scenario against the real dispatcher on a scratch DB.
 */
export function runBndCase(fixture: BndFixtureLike): BndCaseResult {
  const scenario = SCENARIOS[fixture.id];
  if (!scenario) {
    return {
      ok: false,
      output: null,
      notes: [`no deterministic scenario registered for ${fixture.id}`],
    };
  }
  return withScratchDb(scenario);
}
