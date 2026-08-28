// ===========================================================================
// [CODE] BND executor — the seam between the golden BND cases and the
// scheduler rewrite (build P0.5, concurrent with this harness).
//
// The scheduler is being rewritten while this harness lands, so the coupling
// is an INTERFACE plus a dynamic import, not a compile-time dependency:
//
//   worker/src/scheduler/eval-hooks.ts  (P0.5's side of the seam)
//     export function runBndCase(fixture: BndFixture): BndCaseResult
//
// Until that module exists (or before it exports `runBndCase`), every BND case
// reports PENDING through the runner's no-executor path — never PASS. When it
// lands, `npm run eval -- --cat BND` runs green against the real dispatcher
// with no change here. A verify step later in the phase runs exactly that.
// ===========================================================================

import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

/** What the scheduler's eval hook receives — the fixture, untouched. */
export type BndFixture = Fixture;

/** What the scheduler's eval hook returns. Mirrors ExecutorResult's code side. */
export interface BndCaseResult {
  /** The deterministic verdict: did the dispatcher behave as Expected? */
  ok: boolean;
  /** Bundles / cursor positions / dispatch order — whatever the case is about. */
  output: unknown;
  /** wrong[] modes detected (`time-blender`, `cursor-skip`, …). */
  violations?: Violation[];
  /** containment, bundle_purity, prompt_size_max, … */
  metrics?: Record<string, number>;
  notes?: string[];
}

export type BndHook = (fixture: BndFixture) => BndCaseResult | Promise<BndCaseResult>;

/** Where P0.5 exports its hook. Kept as data so tests can probe the contract. */
export const BND_HOOK_MODULE = "../../scheduler/eval-hooks.js";
export const BND_HOOK_EXPORT = "runBndCase";

async function loadHook(): Promise<BndHook | null> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(BND_HOOK_MODULE)) as Record<string, unknown>;
  } catch {
    return null; // the scheduler rewrite has not landed its hooks yet
  }
  const hook = mod[BND_HOOK_EXPORT];
  return typeof hook === "function" ? (hook as BndHook) : null;
}

let cached: Promise<BndHook | null> | undefined;

/**
 * The executor registered for pass `scheduler.dispatch`. Missing hook =
 * a thrown, clearly-worded failure? No — PENDING is the honest state for a
 * layer that has not landed, so the executor registers itself only when the
 * hook resolves. See `registerBndExecutorIfAvailable` in index.ts.
 */
export const bndExecutor: Executor = async ({ fixture }): Promise<ExecutorResult> => {
  const hook = await (cached ??= loadHook());
  if (!hook) {
    throw new Error(
      `scheduler eval hook missing: ${BND_HOOK_MODULE} must export ${BND_HOOK_EXPORT} (P0.5)`,
    );
  }
  const r = await hook(fixture);
  return {
    ok: r.ok,
    output: r.output,
    violations: r.violations,
    metrics: r.metrics,
    notes: r.notes,
  };
};

/**
 * Registration probe: resolves true (and lets index.ts register the executor)
 * only when the scheduler's hook actually exists — so BND reads PENDING, not
 * FAIL, while P0.5 is still in flight.
 */
export async function bndHookAvailable(): Promise<boolean> {
  return (await (cached ??= loadHook())) !== null;
}

/** Test seam: forget the cached probe. */
export function resetBndHookCache(): void {
  cached = undefined;
}
