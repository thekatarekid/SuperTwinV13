// ===========================================================================
// [CODE] Eval runner — evals doc §1 and §3, build item 0.6.
//
// The runner is offline by construction. A fixture freezes both the input
// events and the model verdict (`frozen_response`), so `--frozen` needs no
// network: it hands the frozen verdict to an EXECUTOR — the same product code
// that would consume a live model response — and asserts on what comes back.
// `--live` swaps only the source of the verdict; everything downstream is
// identical, which is the whole point (it re-measures the gates against a real
// model without re-writing the expectations).
//
// The executor registry is the seam. A layer with no executor registered yet
// reports PENDING, never PASS: a suite that asserted nothing has proven
// nothing, and green-on-nothing is how a golden set rots.
//
// One executor ships here: `harness` — a tiny deterministic format used only by
// the self-test fixtures in `evals/selftest/`. It exists so the harness can be
// tested without any product layer existing.
//
// The executors that drive PRODUCT code live in `./executors/` and are
// registered by importing `./executors/index.js` (the CLI does). They are kept
// out of this file so the registry stays independent of what is registered in
// it — and so neither file runs past readable length.
// ===========================================================================

import type { Fixture } from "./fixtures.js";
import { measureGates, type GateInput, type GateReading } from "./gates.js";

export type EvalMode = "frozen" | "live";

/**
 * One measurement a run made against a §14.2 gate other than the case's own
 * `assert.gate`.
 *
 * A case asserts ONE thing, but a run of real product code observes several:
 * the identity ladder can be asked, over the same temp DB, how many of the
 * joins the graph owed it actually happened, and how many resolutions
 * committed with nothing justifying them. Those are per-OBSERVATION facts, not
 * per-case ones — five metadata edges in one case are five chances to be
 * wrong — so they are emitted individually and folded into the gate's own
 * denominator rather than being squeezed into the case's pass/fail bit.
 *
 * The rule from `gates.ts` still holds: an observation nobody emitted leaves
 * its gate at `no data`, never at a pass.
 */
export interface GateObservation {
  /** A §14.2 gate id. An unknown id is ignored by `measureGates`. */
  gate: string;
  passed: boolean;
  /** Why, for the failure line. */
  note?: string;
}

/** What a run produced. `output` holds buckets (`claims`, `loops`, …). */
export interface Produced {
  output: Record<string, unknown>;
  state: Record<string, unknown>;
  metrics: Record<string, number>;
  /** Gate measurements this run made beyond the case's own assertion. */
  gates?: GateObservation[];
}

export interface ExecutorContext {
  fixture: Fixture;
  /** The frozen verdict in `--frozen`, the live model's words in `--live`. */
  response: string;
  mode: EvalMode;
}

export type Executor = (ctx: ExecutorContext) => Produced | Promise<Produced>;

/** Supplies a response for `--live`. Never called in `--frozen`. */
export type LiveInvoker = (fixture: Fixture) => Promise<{ response: string; metrics?: Record<string, number> }>;

const EXECUTORS = new Map<string, Executor>();

export function registerExecutor(layer: string, executor: Executor): void {
  EXECUTORS.set(layer, executor);
}

export function getExecutor(layer: string): Executor | undefined {
  return EXECUTORS.get(layer);
}

export function registeredLayers(): string[] {
  return [...EXECUTORS.keys()].sort();
}

// ---- diffs -----------------------------------------------------------------

export type DiffKind = "missing" | "unexpected" | "forbidden" | "mismatch" | "threw" | "bound" | "shape";

export interface Diff {
  kind: DiffKind;
  /** `claims[2].subject`, `state.tier`, `metrics.tokens`. */
  path: string;
  expected?: unknown;
  actual?: unknown;
  note?: string;
}

// ---- canonical comparison --------------------------------------------------

/** Stable stringify: object keys sorted, so equal values have equal bytes. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Projects an item onto `on`, or onto its own keys when `on` is absent. */
function project(item: unknown, on: readonly string[] | undefined): unknown {
  if (!on || on.length === 0) return item;
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  const rec = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of on) out[key] = rec[key];
  return out;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

// ---- assertion modes (evals doc §3) ---------------------------------------

interface AssertOutcome {
  passed: boolean;
  diffs: Diff[];
  /** `contains` extras — allowed, but counted against precision. */
  extras: number;
}

function assertExact(fixture: Fixture, produced: Produced): AssertOutcome {
  const want = canonical(fixture.expect);
  const got = canonical(produced.output);
  if (want === got) return { passed: true, diffs: [], extras: 0 };
  return {
    passed: false,
    diffs: [{ kind: "mismatch", path: "output", expected: fixture.expect, actual: produced.output }],
    extras: 0,
  };
}

function assertSetLike(fixture: Fixture, produced: Produced, contains: boolean): AssertOutcome {
  const diffs: Diff[] = [];
  let extras = 0;
  for (const [bucket, rawExpected] of Object.entries(fixture.expect)) {
    const expected = asArray(rawExpected);
    if (!expected) {
      diffs.push({
        kind: "shape",
        path: `expect.${bucket}`,
        expected: rawExpected,
        note: `${fixture.assert.mode} compares sets; expect.${bucket} is not an array`,
      });
      continue;
    }
    const actual = asArray(produced.output[bucket]) ?? [];
    const remaining = actual.map((item) => canonical(project(item, fixture.assert.on)));
    expected.forEach((item, i) => {
      const key = canonical(project(item, fixture.assert.on));
      const at = remaining.indexOf(key);
      if (at === -1) {
        diffs.push({
          kind: "missing",
          path: `${bucket}[${i}]`,
          expected: project(item, fixture.assert.on),
          actual: actual.map((a) => project(a, fixture.assert.on)),
        });
      } else {
        remaining.splice(at, 1);
      }
    });
    if (remaining.length > 0) {
      extras += remaining.length;
      if (!contains) {
        for (const leftover of remaining) {
          diffs.push({ kind: "unexpected", path: bucket, actual: JSON.parse(leftover) as unknown });
        }
      }
    }
  }
  return { passed: diffs.length === 0, diffs, extras };
}

function assertAbsent(fixture: Fixture, produced: Produced): AssertOutcome {
  const diffs: Diff[] = [];
  for (const [bucket, rawForbidden] of Object.entries(fixture.expect)) {
    const forbidden = asArray(rawForbidden);
    const actual = asArray(produced.output[bucket]) ?? [];
    if (!forbidden) {
      // `{"claims": []}` style: nothing at all may appear in this bucket.
      if (actual.length > 0) {
        diffs.push({ kind: "forbidden", path: bucket, expected: [], actual });
      }
      continue;
    }
    if (forbidden.length === 0) {
      if (actual.length > 0) diffs.push({ kind: "forbidden", path: bucket, expected: [], actual });
      continue;
    }
    const seen = actual.map((item) => canonical(project(item, fixture.assert.on)));
    forbidden.forEach((item, i) => {
      const key = canonical(project(item, fixture.assert.on));
      if (seen.includes(key)) {
        diffs.push({
          kind: "forbidden",
          path: `${bucket}[${i}]`,
          expected: undefined,
          actual: project(item, fixture.assert.on),
          note: "produced, but this case says it must not be",
        });
      }
    });
  }
  return { passed: diffs.length === 0, diffs, extras: 0 };
}

function assertState(fixture: Fixture, produced: Produced): AssertOutcome {
  const wanted = (fixture.expect.state as Record<string, unknown> | undefined) ?? fixture.expect;
  const diffs: Diff[] = [];
  for (const [key, want] of Object.entries(wanted)) {
    const got = produced.state[key];
    if (!(key in produced.state)) {
      diffs.push({ kind: "missing", path: `state.${key}`, expected: want, note: "the run recorded no such field" });
    } else if (!deepEqual(want, got)) {
      diffs.push({ kind: "mismatch", path: `state.${key}`, expected: want, actual: got });
    }
  }
  return { passed: diffs.length === 0, diffs, extras: 0 };
}

function assertBudget(fixture: Fixture, produced: Produced): AssertOutcome {
  const diffs: Diff[] = [];
  for (const [metric, bound] of Object.entries(fixture.assert.bound ?? {})) {
    const got = produced.metrics[metric];
    if (typeof got !== "number" || !Number.isFinite(got)) {
      diffs.push({ kind: "missing", path: `metrics.${metric}`, expected: bound, note: "not measured by the run" });
      continue;
    }
    if (bound.max !== undefined && got > bound.max) {
      diffs.push({ kind: "bound", path: `metrics.${metric}`, expected: `<= ${bound.max}`, actual: got });
    }
    if (bound.min !== undefined && got < bound.min) {
      diffs.push({ kind: "bound", path: `metrics.${metric}`, expected: `>= ${bound.min}`, actual: got });
    }
  }
  return { passed: diffs.length === 0, diffs, extras: 0 };
}

export function evaluate(fixture: Fixture, produced: Produced): AssertOutcome {
  switch (fixture.assert.mode) {
    case "exact":
      return assertExact(fixture, produced);
    case "set_equal":
      return assertSetLike(fixture, produced, false);
    case "contains":
      return assertSetLike(fixture, produced, true);
    case "absent":
      return assertAbsent(fixture, produced);
    case "state":
      return assertState(fixture, produced);
    case "no_throw":
      // Reaching here means the executor returned. That is the assertion.
      return { passed: true, diffs: [], extras: 0 };
    case "budget":
      return assertBudget(fixture, produced);
  }
}

// ---- results ---------------------------------------------------------------

export type CaseStatus = "pass" | "fail" | "pending";

export interface CaseResult {
  id: string;
  category: string;
  layer: string;
  assertMode: string;
  gate: string | null;
  status: CaseStatus;
  /** Why it is pending, or the headline of why it failed. */
  reason?: string;
  diffs: Diff[];
  extras: number;
  metrics: Record<string, number>;
  /** Gates this run measured beyond `gate`. Empty for a pending case. */
  gateObservations: GateObservation[];
  durationMs: number;
}

export interface SuiteOptions {
  mode: EvalMode;
  live?: LiveInvoker;
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
  mode: EvalMode;
  results: CaseResult[];
  categories: CategoryTally[];
  gates: GateReading[];
  totals: { total: number; pass: number; fail: number; pending: number };
  durationMs: number;
}

export async function runCase(fixture: Fixture, options: SuiteOptions): Promise<CaseResult> {
  const started = Date.now();
  const base = {
    id: fixture.id,
    category: fixture.category,
    layer: fixture.layer,
    assertMode: fixture.assert.mode,
    gate: fixture.assert.gate ?? null,
  };
  const pending = (reason: string): CaseResult => ({
    ...base,
    status: "pending",
    reason,
    diffs: [],
    extras: 0,
    metrics: {},
    gateObservations: [],
    durationMs: Date.now() - started,
  });

  if (fixture.stub) return pending("stub — generated from the doc table, no payload yet");
  const executor = getExecutor(fixture.layer);
  if (!executor) return pending(`no executor registered for layer '${fixture.layer}'`);

  let response = fixture.frozen_response;
  let metrics: Record<string, number> = {};
  if (options.mode === "live") {
    if (!options.live) return pending("live mode requested with no invoker");
    try {
      const live = await options.live(fixture);
      response = live.response;
      metrics = { ...live.metrics };
    } catch (err) {
      return {
        ...base,
        status: "fail",
        reason: `live invocation threw: ${(err as Error).message}`,
        diffs: [{ kind: "threw", path: "live", note: (err as Error).message }],
        extras: 0,
        metrics: {},
        gateObservations: [],
        durationMs: Date.now() - started,
      };
    }
  }

  let produced: Produced;
  try {
    produced = await executor({ fixture, response, mode: options.mode });
  } catch (err) {
    const message = (err as Error).message;
    return {
      ...base,
      status: "fail",
      reason: `executor threw: ${message}`,
      diffs: [{ kind: "threw", path: fixture.layer, actual: message, note: (err as Error).stack?.split("\n")[1]?.trim() }],
      extras: 0,
      metrics,
      gateObservations: [],
      durationMs: Date.now() - started,
    };
  }

  const merged = { ...metrics, ...produced.metrics };
  const outcome = evaluate(fixture, { ...produced, metrics: merged });
  return {
    ...base,
    status: outcome.passed ? "pass" : "fail",
    reason: outcome.passed ? undefined : `${outcome.diffs.length} difference(s)`,
    diffs: outcome.diffs,
    extras: outcome.extras,
    metrics: merged,
    gateObservations: produced.gates ?? [],
    durationMs: Date.now() - started,
  };
}

export async function runSuite(fixtures: readonly Fixture[], options: SuiteOptions): Promise<SuiteResult> {
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

  // The case's own assertion feeds its `assert.gate`; every extra observation
  // the run made feeds its own gate on its own terms. A failed case still
  // contributes its observations — they measure different rows of §14.2, and
  // dropping them would let one broken expectation blank a gate to `no data`.
  const gateInputs: GateInput[] = [];
  for (const r of results) {
    gateInputs.push({
      gateId: r.gate,
      passed: r.status === "pass",
      counted: r.status !== "pending",
      metrics: r.metrics,
    });
    for (const observation of r.gateObservations) {
      // No metrics: an observation is a pass/fail fact, and letting the case's
      // metric bag ride along would feed a `value` gate a number nobody
      // measured for it.
      gateInputs.push({
        gateId: observation.gate,
        passed: observation.passed,
        counted: r.status !== "pending",
      });
    }
  }

  return {
    mode: options.mode,
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

// ---- built-in executors ----------------------------------------------------

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "-") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text.includes(";")) return text.split(";").map((part) => parseScalar(part));
  return text;
}

/**
 * The self-test executor. Its wire format exists only so the harness's seven
 * assertion modes can be exercised without any product layer: one record per
 * line, `P` produces, `S` sets state, `B` records a metric, `X` throws.
 */
export const harnessExecutor: Executor = ({ response }) => {
  const produced: Produced = { output: {}, state: {}, metrics: {} };
  for (const line of response.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    const parts = text.split("|");
    const tag = parts[0];
    if (tag === "P") {
      const bucket = parts[1] ?? "";
      const item: Record<string, unknown> = {};
      for (const pair of (parts[2] ?? "").split(",")) {
        if (pair === "") continue;
        const eq = pair.indexOf("=");
        if (eq === -1) throw new Error(`harness fixture: field without '=' in ${JSON.stringify(pair)}`);
        item[pair.slice(0, eq)] = parseScalar(pair.slice(eq + 1));
      }
      const list = (produced.output[bucket] as unknown[] | undefined) ?? [];
      list.push(item);
      produced.output[bucket] = list;
    } else if (tag === "S") {
      produced.state[parts[1] ?? ""] = parseScalar(parts[2] ?? "");
    } else if (tag === "B") {
      produced.metrics[parts[1] ?? ""] = Number(parts[2]);
    } else if (tag === "X") {
      throw new Error(parts[1] ?? "harness fixture: X record");
    } else {
      throw new Error(`harness fixture: unknown record tag ${JSON.stringify(tag)}`);
    }
  }
  return produced;
};

registerExecutor("harness", harnessExecutor);
