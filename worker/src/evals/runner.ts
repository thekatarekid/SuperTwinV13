// ===========================================================================
// [CODE] V13 eval runner — live-call by construction (build P0.9).
//
// A fixture names a PASS (`orient`, `scheduler.dispatch`, …). The registry maps
// pass → executor; the executor drives the REAL product code for that pass —
// which, for a `mode: "live"` case, drives the real `claude` CLI. There is no
// frozen-response path.
//
// Scoring is two-layered:
//   * code assertions — the executor reports `violations` (wrong[] modes it
//     detected by code) and, for `mode: "code"` cases, its own `ok` verdict.
//     Any violation is a hard fail.
//   * the LLM judge (haiku) — for `mode: "live"` cases the judge grades the
//     executor's produced output against the case's `expected` rubric and
//     asserts the `wrong[]` modes absent. `satisfied` with zero wrong hits
//     passes; `partial` and `missed` fail.
//
// A pass with no registered executor reports PENDING, never PASS: a suite that
// asserted nothing has proven nothing. That is how BND ships before the
// scheduler rewrite lands — the executor interface exists (executors/bnd.ts),
// and until the scheduler exports its eval hooks the category reads pending.
// ===========================================================================

import type { Fixture, WrongMode } from "./fixtures.js";
import { measureGates, type GateInput, type GateReading } from "./gates.js";
import type { Judge } from "./judge.js";

/** A wrong[] mode the executor detected by code. */
export interface Violation {
  /** Must match a `wrong[].label` of the fixture (unknown labels still fail). */
  label: string;
  note?: string;
}

/** What an executor produced by running the real pass. */
export interface ExecutorResult {
  /**
   * The code-mode verdict. `mode: "code"` cases pass iff `ok !== false` and no
   * violations. Live cases treat `ok: false` as a code-detected failure too.
   * Default: true.
   */
  ok?: boolean;
  /** What the pass produced — structured facts and/or transcript, judge food. */
  output: unknown;
  /**
   * The deterministic seed block (executors/seeds.ts) the pass was shown as
   * the concrete rendering of the fixture's one-line setup. Surfaced to the
   * judge so pass and judge grade the same world.
   */
  seededContext?: string;
  /** Wrong[] modes detected by code. Any entry is a hard fail. */
  violations?: Violation[];
  /** Numbers the run measured (latency, tokens, containment, …). */
  metrics?: Record<string, number>;
  /** Extra gate measurements beyond the case's own `gates[]`. */
  gateObservations?: GateInput[];
  /** Human-facing notes for the report. */
  notes?: string[];
  /**
   * Set when the registered pass CAN run some of its category's cases but the
   * product surface THIS case measures has not been built yet. The case
   * reports as pending with this reason — exactly what an unregistered pass
   * reports — instead of a fake pass or a fake fail.
   */
  pending?: string;
}

export interface ExecutorContext {
  fixture: Fixture;
}

export type Executor = (ctx: ExecutorContext) => ExecutorResult | Promise<ExecutorResult>;

const EXECUTORS = new Map<string, Executor>();

export function registerExecutor(pass: string, executor: Executor): void {
  EXECUTORS.set(pass, executor);
}

export function getExecutor(pass: string): Executor | undefined {
  return EXECUTORS.get(pass);
}

export function registeredPasses(): string[] {
  return [...EXECUTORS.keys()].sort();
}

/** Test seam: forget a registration (never used in production). */
export function unregisterExecutor(pass: string): void {
  EXECUTORS.delete(pass);
}

// ---- results ---------------------------------------------------------------

export type CaseStatus = "pass" | "fail" | "pending";

export interface WrongHit {
  label: string;
  by: "code" | "judge";
  note?: string;
}

export interface CaseResult {
  id: string;
  category: string;
  pass: string;
  mode: Fixture["mode"];
  status: CaseStatus;
  /** Why it is pending, or the headline of why it failed. */
  reason?: string;
  /** satisfied/partial/missed from the judge; null for code cases / pending. */
  judgeVerdict: string | null;
  wrongHits: WrongHit[];
  metrics: Record<string, number>;
  gates: string[];
  gateObservations: GateInput[];
  notes: string[];
  durationMs: number;
}

export interface SuiteOptions {
  /** Grades live cases. A live case with no judge is PENDING. */
  judge?: Judge;
}

export interface CategoryTally {
  category: string;
  total: number;
  pass: number;
  fail: number;
  pending: number;
  /** Passed / (passed + failed). null when nothing ran. */
  passRate: number | null;
}

export interface SuiteResult {
  results: CaseResult[];
  categories: CategoryTally[];
  gates: GateReading[];
  totals: { total: number; pass: number; fail: number; pending: number };
  durationMs: number;
}

function knownLabels(wrong: readonly WrongMode[]): Set<string> {
  return new Set(wrong.map((w) => w.label));
}

export async function runCase(fixture: Fixture, options: SuiteOptions): Promise<CaseResult> {
  const started = Date.now();
  const base = {
    id: fixture.id,
    category: fixture.category,
    pass: fixture.pass,
    mode: fixture.mode,
    gates: fixture.gates,
  };
  const done = (partial: Omit<CaseResult, keyof typeof base | "durationMs">): CaseResult => ({
    ...base,
    ...partial,
    durationMs: Date.now() - started,
  });
  const pending = (reason: string): CaseResult =>
    done({
      status: "pending",
      reason,
      judgeVerdict: null,
      wrongHits: [],
      metrics: {},
      gateObservations: [],
      notes: [],
    });

  const executor = getExecutor(fixture.pass);
  if (!executor) return pending(`no executor registered for pass '${fixture.pass}'`);
  if (fixture.mode === "live" && !options.judge) return pending("live case with no judge configured");

  let produced: ExecutorResult;
  try {
    produced = await executor({ fixture });
  } catch (err) {
    return done({
      status: "fail",
      reason: `executor threw: ${(err as Error).message}`,
      judgeVerdict: null,
      wrongHits: [],
      metrics: {},
      gateObservations: [],
      notes: [(err as Error).stack?.split("\n")[1]?.trim() ?? ""].filter(Boolean),
    });
  }

  if (produced.pending) return pending(produced.pending);

  const labels = knownLabels(fixture.wrong);
  const wrongHits: WrongHit[] = [];
  const notes = [...(produced.notes ?? [])];
  for (const v of produced.violations ?? []) {
    wrongHits.push({ label: v.label, by: "code", note: v.note });
    if (!labels.has(v.label)) {
      notes.push(`violation '${v.label}' is not a wrong[] label of ${fixture.id} — counted as a fail anyway`);
    }
  }

  let judgeVerdict: string | null = null;
  if (fixture.mode === "live") {
    // options.judge checked above.
    const verdict = await options.judge!(fixture, produced);
    judgeVerdict = verdict.expected;
    for (const label of verdict.wrongHits) {
      wrongHits.push({ label, by: "judge", note: verdict.reasoning });
    }
    if (verdict.reasoning) notes.push(`judge: ${verdict.reasoning}`);
  }

  const codeOk = produced.ok !== false;
  const judged = fixture.mode === "code" ? true : judgeVerdict === "satisfied";
  const passed = codeOk && judged && wrongHits.length === 0;

  const reasons: string[] = [];
  if (!codeOk) reasons.push("code assertions failed");
  if (fixture.mode === "live" && judgeVerdict !== "satisfied") reasons.push(`judge: expected ${judgeVerdict}`);
  if (wrongHits.length > 0) reasons.push(`wrong[] hit: ${wrongHits.map((w) => w.label).join(", ")}`);

  return done({
    status: passed ? "pass" : "fail",
    reason: passed ? undefined : reasons.join(" · "),
    judgeVerdict,
    wrongHits,
    metrics: produced.metrics ?? {},
    gateObservations: produced.gateObservations ?? [],
    notes,
  });
}

export async function runSuite(fixtures: readonly Fixture[], options: SuiteOptions = {}): Promise<SuiteResult> {
  const started = Date.now();
  const results: CaseResult[] = [];
  for (const fixture of fixtures) results.push(await runCase(fixture, options));

  const byCategory = new Map<string, CategoryTally>();
  for (const r of results) {
    const tally = byCategory.get(r.category) ?? {
      category: r.category,
      total: 0,
      pass: 0,
      fail: 0,
      pending: 0,
      passRate: null,
    };
    tally.total += 1;
    if (r.status === "pass") tally.pass += 1;
    else if (r.status === "fail") tally.fail += 1;
    else tally.pending += 1;
    byCategory.set(r.category, tally);
  }
  const categories = [...byCategory.values()]
    .map((t) => ({ ...t, passRate: t.pass + t.fail > 0 ? t.pass / (t.pass + t.fail) : null }))
    .sort((a, b) => (a.category < b.category ? -1 : 1));

  const gateInputs: GateInput[] = [];
  for (const r of results) {
    const counted = r.status !== "pending";
    for (const gateId of r.gates) {
      gateInputs.push({ gateId, passed: r.status === "pass", counted });
    }
    for (const obs of r.gateObservations) {
      gateInputs.push({ ...obs, counted: counted && obs.counted });
    }
  }

  return {
    results,
    categories,
    gates: measureGates(gateInputs),
    totals: {
      total: results.length,
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      pending: results.filter((r) => r.status === "pending").length,
    },
    durationMs: Date.now() - started,
  };
}
