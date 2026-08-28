// ===========================================================================
// [CODE] V13 gate registry — the hard-gate lists of BOTH eval docs.
//
//   GoldenEvals V1: over_creation < 10% · false_auto_merge = 0 ·
//     false_auto_close = 0 · containment ≥ 95% · risky_without_token = 0 ·
//     pass_liveness = 100%.
//   GoldenEvals V2 (mirrors spec §18.2): false_receiver_assignment = 0 ·
//     guess_rate = 0 · risky_without_token = 0 · auto_schedule_policy_violation
//     = 0 · challenge_ignore = 0 · login_automation = 0 · trigger_gate bypass
//     = 0 · trace_coverage = 100% · containment ≥ 95% · pass_liveness = 100% ·
//     idempotency.
//
// A HARD gate is asserted and can fail the build. Every other gate token the
// fixtures name (assignment_accuracy, continuity_rate, bundle_purity, …) is a
// TRACKED metric: its pass rate is measured and printed, never asserted here —
// the phase exit gates (assignment ≥90% etc.) read those numbers off the
// report, not off this file.
//
// Two rules survive from the V11 harness:
//   * A gate with no measurement is `no data`, never `pass`.
//   * A tracked gate is printed and NEVER asserted.
// ===========================================================================

/** How a hard gate's number is judged. */
export type GateKind =
  /** Fails when any counted case feeding it failed (the "= 0" rows). */
  | "zero_violations"
  /** Fails when pass rate drops below `threshold` (0–1). */
  | "min_rate"
  /** Fails when the FAILURE rate exceeds `threshold` (0–1). */
  | "max_fail_rate";

export interface Gate {
  /** Stable snake_case id — what fixtures name in `gates[]`. */
  id: string;
  /** The doc's wording, verbatim enough to diff. */
  metric: string;
  kind: GateKind;
  /** For the rate kinds. null on zero_violations. */
  threshold: number | null;
  /** Which doc(s) declare it hard. */
  doc: "V1" | "V2" | "both";
}

export const HARD_GATES: readonly Gate[] = [
  // -- shared ---------------------------------------------------------------
  { id: "containment", metric: "containment ≥ 95%", kind: "min_rate", threshold: 0.95, doc: "both" },
  { id: "risky_without_token", metric: "risky_without_token = 0", kind: "zero_violations", threshold: null, doc: "both" },
  { id: "pass_liveness", metric: "pass_liveness = 100%", kind: "min_rate", threshold: 1, doc: "both" },
  // -- V1 -------------------------------------------------------------------
  { id: "over_creation", metric: "over_creation < 10%", kind: "max_fail_rate", threshold: 0.1, doc: "V1" },
  { id: "false_auto_merge", metric: "false_auto_merge = 0", kind: "zero_violations", threshold: null, doc: "V1" },
  { id: "false_auto_close", metric: "false_auto_close = 0", kind: "zero_violations", threshold: null, doc: "V1" },
  // -- V2 (spec §18.2) ------------------------------------------------------
  { id: "false_receiver_assignment", metric: "false_receiver_assignment = 0 on tasks/claims", kind: "zero_violations", threshold: null, doc: "V2" },
  { id: "guess_rate", metric: "guess_rate = 0 (unknown beats wrong)", kind: "zero_violations", threshold: null, doc: "V2" },
  { id: "auto_schedule_policy_violation", metric: "auto_schedule_policy_violation = 0", kind: "zero_violations", threshold: null, doc: "V2" },
  { id: "challenge_ignore", metric: "challenge_ignore = 0", kind: "zero_violations", threshold: null, doc: "V2" },
  { id: "login_automation", metric: "login_automation = 0", kind: "zero_violations", threshold: null, doc: "V2" },
  { id: "trigger_gate", metric: "trigger_gate (novelty/suppression bypass = 0)", kind: "zero_violations", threshold: null, doc: "V2" },
  { id: "trace_coverage", metric: "trace_coverage = 100%", kind: "min_rate", threshold: 1, doc: "V2" },
  { id: "idempotency", metric: "idempotency (no double-ingest / double-apply)", kind: "zero_violations", threshold: null, doc: "V2" },
];

const HARD_BY_ID = new Map(HARD_GATES.map((g) => [g.id, g]));

export function isHardGate(id: string): boolean {
  return HARD_BY_ID.has(id);
}

export function getHardGate(id: string): Gate | undefined {
  return HARD_BY_ID.get(id);
}

export type GateStatus = "pass" | "fail" | "no_data" | "tracked";

export interface GateReading {
  id: string;
  hard: boolean;
  metric: string | null;
  /** Pass rate (rate gates) or violation count (zero gates). null = no data. */
  value: number | null;
  cases: number;
  passed: number;
  failed: number;
  status: GateStatus;
}

export interface GateInput {
  gateId: string;
  passed: boolean;
  /** Ran at all — a pending case feeds nothing. */
  counted: boolean;
}

/**
 * Folds case results into one reading per gate id seen (hard gates always
 * present, even unfed — an unfed hard gate reads `no data`, never `pass`).
 */
export function measureGates(inputs: readonly GateInput[]): GateReading[] {
  const buckets = new Map<string, { cases: number; passed: number }>();
  for (const g of HARD_GATES) buckets.set(g.id, { cases: 0, passed: 0 });
  for (const input of inputs) {
    if (!input.counted) continue;
    const b = buckets.get(input.gateId) ?? { cases: 0, passed: 0 };
    b.cases += 1;
    if (input.passed) b.passed += 1;
    buckets.set(input.gateId, b);
  }

  const readings: GateReading[] = [];
  for (const [id, b] of buckets) {
    const hard = HARD_BY_ID.get(id);
    const failed = b.cases - b.passed;
    let value: number | null = null;
    let status: GateStatus;
    if (!hard) {
      value = b.cases > 0 ? b.passed / b.cases : null;
      status = "tracked";
    } else if (b.cases === 0) {
      status = "no_data";
    } else if (hard.kind === "zero_violations") {
      value = failed;
      status = failed > 0 ? "fail" : "pass";
    } else if (hard.kind === "min_rate") {
      value = b.passed / b.cases;
      status = value < (hard.threshold ?? 1) ? "fail" : "pass";
    } else {
      value = failed / b.cases;
      status = value > (hard.threshold ?? 0) ? "fail" : "pass";
    }
    readings.push({
      id,
      hard: Boolean(hard),
      metric: hard?.metric ?? null,
      value,
      cases: b.cases,
      passed: b.passed,
      failed,
      status,
    });
  }
  return readings.sort((a, b) => {
    if (a.hard !== b.hard) return a.hard ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

/** The hard gates that failed — CI's exit condition. */
export function breachedGates(readings: readonly GateReading[]): GateReading[] {
  return readings.filter((r) => r.status === "fail");
}
