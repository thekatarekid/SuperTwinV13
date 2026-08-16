// ===========================================================================
// [CODE] CI gate registry — architecture §14.2, transcribed row for row.
//
// §14.2 is a prose table ("fails the build if > 2%"). CI cannot read prose, so
// every row is transcribed here as data: a stable id, the layer it belongs to,
// the metric text verbatim, and a machine-checkable rule. The verbatim text is
// kept so a reader of the report can diff it against the architecture doc
// without trusting this file's paraphrase.
//
// Two rules govern this file:
//
//   * A gate with no measurement is `no data`, never `pass`. A suite that ran
//     zero cases for a gate has not proven anything, and reporting green there
//     is how a gate quietly stops being a gate.
//   * `reported: true` rows (the wire char saving) are printed and NEVER
//     asserted. §14.2 says so explicitly.
//
// The one row that must never move off zero: `all.model_output_discarded`.
// ===========================================================================

/** How a gate's number is obtained from the suite. */
export type GateMeasure =
  /** Fraction of the gate's cases that passed (0–1). */
  | "pass_rate"
  /** Count of cases that failed / violations recorded against the gate. */
  | "violations"
  /** A raw measured value pulled from case metrics (latency, tokens, ratio). */
  | "value";

/** Comparator applied as `cmp(measured, threshold) === true → the build fails`. */
export type GateCmp = "lt" | "lte" | "gt" | "gte" | "ne" | "outside_pct";

export interface Gate {
  /** Stable snake_case id. Fixtures reference this in `assert.gate`. */
  id: string;
  /** §14.2 "Layer" column. */
  layer: string;
  /** §14.2 "Metric" column, verbatim. */
  metric: string;
  /** §14.2 "Fails the build if" column, verbatim. */
  failsIf: string;
  measure: GateMeasure;
  cmp: GateCmp;
  /** null for rows that are reported and never asserted. */
  threshold: number | null;
  /** Bolded in §14.2 — the rows that killed previous builds. */
  critical?: boolean;
  /** Printed, never asserted. */
  reported?: boolean;
  /** Metric key read off case metrics when `measure` is "value". */
  metricKey?: string;
}

type GateSeed = [
  id: string,
  layer: string,
  metric: string,
  failsIf: string,
  measure: GateMeasure,
  cmp: GateCmp,
  threshold: number | null,
  extra?: Partial<Gate>,
];

const SEEDS: readonly GateSeed[] = [
  // -- scheduler ------------------------------------------------------------
  ["sched_time_to_first_triple", "scheduler", "time to first claim + task + space (reference corpus)", "> 120 s", "value", "gt", 120, { critical: true, metricKey: "time_to_first_triple_s" }],
  ["sched_steady_visibility", "scheduler", "new message → its claims/tasks visible (steady state)", "> live_interval + 15 s", "value", "gt", 15, { critical: true, metricKey: "steady_visibility_over_interval_s" }],
  ["sched_live_pass_is_delta", "scheduler", "live pass is DELTA (tokens scale O(n), not O(n²))", "any O(n²) growth", "violations", "gt", 0],
  ["sched_live_passes_per_hour", "scheduler", "live passes per stream per hour", "> 20", "value", "gt", 20, { metricKey: "live_passes_per_hour" }],
  ["sched_seal_hash_skip", "scheduler", "consolidation at seal skipped when hash unchanged", "< 100%", "pass_rate", "lt", 1],
  ["sched_no_stall", "scheduler", "any gap with zero completed work while cohorts remain (excl. quota pause)", "> 90 s", "value", "gt", 90, { metricKey: "max_idle_gap_s" }],
  ["sched_recency_order", "scheduler", "processing order is recency-descending across all streams", "any inversion", "violations", "gt", 0],
  ["sched_coverage_monotonic", "scheduler", "coverage monotonic (never regresses)", "any regression", "violations", "gt", 0],
  ["sched_restart_no_rejudge", "scheduler", "restart mid-import resumes without re-judging verdicts", "any re-judge", "violations", "gt", 0],
  ["sched_bootstrap_seal_immediate", "scheduler", "bootstrap sessions sealed with seal_mode=immediate", "< 100%", "pass_rate", "lt", 1],
  ["sched_live_preempts_backfill", "scheduler", "live event pre-empts backfill at next cohort boundary", "> 1 cohort delay", "value", "gt", 1, { metricKey: "cohort_delay" }],
  // -- latency --------------------------------------------------------------
  ["latency_first_claim_rendered", "latency", "first claim rendered (streamed, not call-complete)", "> 30 s", "value", "gt", 30, { critical: true, metricKey: "first_claim_s" }],
  ["latency_first_paint_calls", "latency", "calls on the first-paint critical path", "> 1", "value", "gt", 1, { critical: true, metricKey: "first_paint_calls" }],
  ["latency_adjudicator_before_paint", "latency", "an adjudicator (P-AG1/2/3) executed before first paint", "> 0", "violations", "gt", 0, { critical: true }],
  ["latency_lane_e_slots", "latency", "Lane E held LLM slots during first paint", "> 0", "violations", "gt", 0],
  ["latency_ttft_recorded", "latency", "per-call TTFT and tok/s recorded per model per call type", "absent", "pass_rate", "lt", 1],
  // -- tiers ----------------------------------------------------------------
  ["tiers_all_assigned", "tiers", "every stream has a tier assigned after boot backfill", "< 100%", "pass_rate", "lt", 1],
  ["tiers_order_respected", "tiers", "tier order respected — a T2 backfill cohort ran before T1 exhausted", "> 0", "violations", "gt", 0],
  ["tiers_no_orphans_on_promotion", "tiers", "events orphaned by a T3→T1 promotion", "> 0", "violations", "gt", 0, { critical: true }],
  ["tiers_t4_obligation_kept", "tiers", "a T4 channel's real obligation dropped rather than deferred", "> 0", "violations", "gt", 0],
  ["tiers_live_preemption", "tiers", "T1/T2 live events pre-empt backfill at the next cohort boundary", "< 100%", "pass_rate", "lt", 1],
  // -- labels ---------------------------------------------------------------
  ["labels_anchor_entity", "labels", "space labels containing no anchor entity where one exists", "> 10%", "value", "gt", 0.1, { metricKey: "anchorless_label_rate" }],
  // -- wire -----------------------------------------------------------------
  ["wire_round_trip", "wire", "byte-identical round trip serialize(parse(serialize(x)))", "any drift", "violations", "gt", 0, { critical: true }],
  ["wire_ab_equality", "wire", "A/B: wire path and JSON path produce equal parsed results on the gold set", "any inequality", "violations", "gt", 0],
  ["wire_accounting_holds", "wire", "accounting accepted + violations + skipped == non_blank_lines", "any mismatch", "violations", "gt", 0],
  ["wire_parser_never_throws", "wire", "parser throws on random bytes / truncation / null", "> 0", "violations", "gt", 0],
  ["wire_no_alias_guessing", "wire", "an out-of-roster alias resolved to a guess instead of null", "> 0", "violations", "gt", 0],
  ["wire_emphasis_recovered", "wire", "emphasis-wrapped lines recovered rather than rejected", "< 100%", "pass_rate", "lt", 1],
  ["wire_char_saving", "wire", "measured char saving vs JSON", "reported, never asserted", "value", "lt", null, { reported: true, metricKey: "char_saving_pct" }],
  // -- party ----------------------------------------------------------------
  ["party_derived_by_code", "party", "party_pair derived by code, never emitted by a model", "any model emission", "violations", "gt", 0],
  ["party_pairs_correct", "party", "all 9 pairs correct vs gold", "< 0.98", "pass_rate", "lt", 0.98],
  ["party_no_s_space", "party", "a thread with no `s` in any loop pair surfaced as a space", "> 0", "violations", "gt", 0, { critical: true }],
  ["party_oo_in_tasks", "party", "`oo` loops appearing in the user's task list", "> 0", "violations", "gt", 0, { critical: true }],
  // -- archetype / promotion ------------------------------------------------
  ["archetype_accuracy", "archetype", "accuracy across all 8 shapes vs gold", "< 0.85", "pass_rate", "lt", 0.85],
  ["promotion_route_accuracy", "promotion", "reference/recurrence-route threads promoted vs gold", "< 0.85", "pass_rate", "lt", 0.85],
  ["promotion_reason_recorded", "promotion", "promotion_reason recorded on every promoted thread", "< 100%", "pass_rate", "lt", 1],
  // -- confluence -----------------------------------------------------------
  ["confluence_order_independence", "confluence", "same corpus ingested in 3 different orders → identical final graph", "any divergence", "violations", "gt", 0, { critical: true }],
  ["confluence_stated_at_precedence", "confluence", "precedence ever decided by ingested_at rather than stated_at", "> 0", "violations", "gt", 0],
  ["confluence_no_late_dislodge", "confluence", "an older claim arriving late dislodges a newer active claim", "> 0", "violations", "gt", 0],
  // -- loops ----------------------------------------------------------------
  ["loops_recurring_live", "loops", "recurring loop from >1y-old evidence with a future next occurrence marked live", "< 100%", "pass_rate", "lt", 1],
  ["loops_past_due_not_task", "loops", "past-due non-recurring loop from backfill surfacing as a task", "> 0", "violations", "gt", 0],
  ["loops_done_retained", "loops", "done/lapsed loops extracted and retained (not skipped)", "< 100%", "pass_rate", "lt", 1],
  ["loops_explicit_precision", "loops", "precision on explicit", "< 0.90", "pass_rate", "lt", 0.9],
  ["loops_explicit_recall", "loops", "recall on explicit", "< 0.90", "pass_rate", "lt", 0.9],
  ["loops_implicit_precision", "loops", "implicit precision", "< 0.70", "pass_rate", "lt", 0.7],
  ["loops_triage_accuracy", "loops", "triage accuracy", "< 0.90", "pass_rate", "lt", 0.9],
  ["loops_done_detection_precision", "loops", "done-detection precision", "< 0.95", "pass_rate", "lt", 0.95],
  ["loops_born_past_due_open", "loops", "born past-due marked open", "> 0", "violations", "gt", 0],
  ["loops_non_user_owner_tasks", "loops", "owned by non-user appearing as tasks", "> 0", "violations", "gt", 0],
  // -- claims ---------------------------------------------------------------
  ["claims_not_age_filtered", "claims", "claims age-filtered out of old history", "> 0", "violations", "gt", 0],
  ["claim_subject_accuracy", "claims", "subject accuracy", "< 0.95", "pass_rate", "lt", 0.95],
  ["claim_attribution_accuracy", "claims", "attribution accuracy", "< 0.95", "pass_rate", "lt", 0.95],
  ["claims_third_person", "claims", "third-person resolution", "< 0.98", "pass_rate", "lt", 0.98],
  ["claims_duplicates", "claims", "duplicates surviving the write path", "> 2%", "value", "gt", 0.02, { metricKey: "duplicate_rate" }],
  ["claims_out_of_order_supersession", "claims", "out-of-order supersession correct (older claim → predecessor)", "< 0.95", "pass_rate", "lt", 0.95],
  // -- enrichment -----------------------------------------------------------
  ["enrich_information_free_caption", "enrichment", "update pass triggered by an information-free caption", "> 5%", "value", "gt", 0.05, { metricKey: "info_free_update_rate" }],
  ["enrich_late_original_session", "enrichment", "late enrichment reprocessed into its original session/episode", "< 100%", "pass_rate", "lt", 1],
  ["enrich_reprocess_no_dupes", "enrichment", "duplicate claims created by reprocess", "> 0", "violations", "gt", 0],
  ["enrich_media_queue_priority", "enrichment", "media queue ordered by cohort priority (not FIFO)", "any inversion", "violations", "gt", 0],
  ["enrich_slow_attachment_blocks_text", "enrichment", "a slow attachment delays understanding of its session's text", "> 0", "violations", "gt", 0],
  ["enrich_passes_per_episode", "enrichment", "passes per episode with media (expect exactly 2)", "≠ 2 without late media", "value", "ne", 2, { metricKey: "passes_per_episode" }],
  ["enrich_batch_size", "enrichment", "image batch size honoured (default 16)", "< 10 without a mismatch retry", "value", "lt", 10, { metricKey: "image_batch_size" }],
  ["enrich_caption_wrong_image", "enrichment", "a caption attached to the wrong image", "> 0", "violations", "gt", 0, { critical: true }],
  ["enrich_mismatch_split_retry", "enrichment", "mismatched batch applied partially instead of split-and-retried", "> 0", "violations", "gt", 0],
  ["enrich_all_media_captioned", "enrichment", "every image and sticker captioned at default settings", "< 100%", "pass_rate", "lt", 1],
  ["enrich_executor_routing", "enrichment", "routed to correct executor", "< 100%", "pass_rate", "lt", 1],
  ["enrich_ambient_prefilter", "enrichment", "ambient prefilter drop ratio", "< 90%", "value", "lt", 0.9, { metricKey: "ambient_drop_ratio" }],
  // -- accounting / caching -------------------------------------------------
  ["acct_total_input_identity", "accounting", "total_input = read + create + input holds on every run row", "any mismatch", "violations", "gt", 0],
  ["acct_no_separate_spend", "accounting", "input and cache columns presented as separate spend", "> 0", "violations", "gt", 0],
  ["acct_same_filter", "accounting", "cost and tokens aggregated over different filters", "> 0", "violations", "gt", 0],
  ["acct_attribution_present", "accounting", "a run lacking role or cohort_id attribution", "> 0", "violations", "gt", 0],
  ["acct_billable_quota", "accounting", "quota gated on a raw token sum instead of billable_tokens", "> 0", "violations", "gt", 0],
  ["caching_hit_rate_reported", "caching", "measured hit rate reported in Settings (not assumed)", "absent", "pass_rate", "lt", 1],
  ["caching_warm_first", "caching", "parallel fan-out issued before the warm call returns", "> 0 when warm_first on", "violations", "gt", 0],
  // -- sessions -------------------------------------------------------------
  ["sessions_boundary_f1", "sessions", "boundary F1 vs gold (all 5 kinds, both seal modes)", "< 0.90", "pass_rate", "lt", 0.9],
  ["sessions_determinism", "sessions", "segmentation determinism", "any drift", "violations", "gt", 0],
  ["sessions_explainable", "sessions", "explainable boundaries", "< 100%", "pass_rate", "lt", 1],
  // -- entities -------------------------------------------------------------
  ["entities_precision", "entities", "resolution precision", "< 0.98", "pass_rate", "lt", 0.98],
  ["entities_recall", "entities", "resolution recall", "< 0.90", "pass_rate", "lt", 0.9],
  ["entities_no_silent_guess", "entities", "identities silently guessed", "> 0", "violations", "gt", 0],
  ["entities_mention_linking", "entities", "mention linking accuracy", "< 0.92", "pass_rate", "lt", 0.92],
  ["entities_edge_precision", "entities", "edge precision", "< 0.90", "pass_rate", "lt", 0.9],
  ["entities_metadata_edges", "entities", "metadata edges captured", "< 100%", "pass_rate", "lt", 1],
  // -- episodes -------------------------------------------------------------
  ["episodes_one_to_one_rate", "episodes", "1:1 default rate", "< 60%", "value", "lt", 0.6, { metricKey: "one_to_one_rate" }],
  ["episodes_split_attach_accuracy", "episodes", "split / attach accuracy", "< 0.85", "pass_rate", "lt", 0.85],
  ["episodes_wrong_attach_rate", "episodes", "wrong-attach rate", "> 2%", "value", "gt", 0.02, { metricKey: "wrong_attach_rate" }],
  ["episodes_verdict_replay", "episodes", "verdict replay determinism", "any drift", "violations", "gt", 0],
  // -- arcs -----------------------------------------------------------------
  ["arcs_bridge_recall", "arcs", "recall on bridge-joinable pairs", "< 0.95", "pass_rate", "lt", 0.95],
  ["arcs_precision", "arcs", "precision", "< 0.90", "pass_rate", "lt", 0.9],
  ["arcs_no_similarity_only_ambient", "arcs", "ambient joined by similarity alone", "> 0", "violations", "gt", 0],
  ["arcs_id_stability", "arcs", "arc-id stability across full re-derivation", "< 100%", "pass_rate", "lt", 1],
  // -- spaces / all / calib -------------------------------------------------
  ["spaces_count_vs_gold", "spaces", "count vs gold", "±25%", "value", "outside_pct", 25, { metricKey: "space_count_delta_pct" }],
  ["spaces_archetype_accuracy", "spaces", "archetype accuracy", "< 0.85", "pass_rate", "lt", 0.85],
  ["all_corrections_survive", "all", "user corrections surviving re-derivation", "< 100%", "pass_rate", "lt", 1],
  ["all_model_output_discarded", "all", "model output discarded by code", "> 0", "violations", "gt", 0, { critical: true }],
  ["calib_stale_or_absent", "calib", "similarity run with stale/absent calibration", "> 0", "violations", "gt", 0],
];

export const GATES: readonly Gate[] = SEEDS.map(([id, layer, metric, failsIf, measure, cmp, threshold, extra]) => ({
  id,
  layer,
  metric,
  failsIf,
  measure,
  cmp,
  threshold,
  ...extra,
}));

const BY_ID = new Map(GATES.map((g) => [g.id, g]));

export function getGate(id: string): Gate | undefined {
  return BY_ID.get(id);
}

export function isGateId(id: string): boolean {
  return BY_ID.has(id);
}

export type GateStatus = "pass" | "fail" | "no_data" | "reported";

export interface GateReading {
  gate: Gate;
  /** null when nothing measured it. */
  value: number | null;
  /** Cases that fed this gate. */
  cases: number;
  passed: number;
  failed: number;
  status: GateStatus;
}

/** Applies the §14.2 comparator. True means "the build fails". */
export function breaches(gate: Gate, value: number): boolean {
  if (gate.reported || gate.threshold === null) return false;
  const t = gate.threshold;
  switch (gate.cmp) {
    case "lt":
      return value < t;
    case "lte":
      return value <= t;
    case "gt":
      return value > t;
    case "gte":
      return value >= t;
    case "ne":
      return value !== t;
    case "outside_pct":
      return Math.abs(value) > t;
  }
}

export interface GateInput {
  gateId: string | null;
  passed: boolean;
  /** Ran at all — a pending/stub case feeds nothing. */
  counted: boolean;
  metrics?: Record<string, number>;
}

/**
 * Folds case results into one reading per gate. A gate nobody measured is
 * `no_data` — never `pass`.
 */
export function measureGates(inputs: readonly GateInput[]): GateReading[] {
  const buckets = new Map<string, { cases: number; passed: number; values: number[] }>();
  for (const g of GATES) buckets.set(g.id, { cases: 0, passed: 0, values: [] });

  for (const input of inputs) {
    if (!input.counted || !input.gateId) continue;
    const gate = BY_ID.get(input.gateId);
    if (!gate) continue;
    const b = buckets.get(gate.id);
    if (!b) continue;
    b.cases += 1;
    if (input.passed) b.passed += 1;
    if (gate.measure === "value" && gate.metricKey) {
      const v = input.metrics?.[gate.metricKey];
      if (typeof v === "number" && Number.isFinite(v)) b.values.push(v);
    }
  }

  return GATES.map((gate) => {
    const b = buckets.get(gate.id)!;
    const failed = b.cases - b.passed;
    let value: number | null = null;
    if (gate.measure === "pass_rate") {
      value = b.cases > 0 ? b.passed / b.cases : null;
    } else if (gate.measure === "violations") {
      value = b.cases > 0 ? failed : null;
    } else if (b.values.length > 0) {
      // Worst case, not the average: one breach is a breach.
      value = worstValue(gate, b.values);
    }
    let status: GateStatus;
    if (gate.reported) status = "reported";
    else if (value === null) status = "no_data";
    else status = breaches(gate, value) ? "fail" : "pass";
    return { gate, value, cases: b.cases, passed: b.passed, failed, status };
  });
}

/**
 * The worst of several measurements of one `value` gate.
 *
 * "Worst" is a direction, not a magnitude. A `lt` gate fails on the SMALLEST
 * value, so folding by `Math.abs` would hand it the largest — the best case —
 * and a run where one case measured 0.2 against a 0.6 bar would report 1.0 and
 * pass. That is the failure mode this file's header warns about: a gate that
 * quietly stops being able to fail.
 */
function worstValue(gate: Gate, values: readonly number[]): number {
  const first = values[0]!;
  switch (gate.cmp) {
    case "gt":
    case "gte":
      return values.reduce((a, c) => (c > a ? c : a), first);
    case "lt":
    case "lte":
      return values.reduce((a, c) => (c < a ? c : a), first);
    case "ne":
      // Any value other than the threshold breaches — surface one if it exists.
      return values.find((v) => v !== gate.threshold) ?? first;
    case "outside_pct":
      // A symmetric band: the furthest from centre in either direction.
      return values.reduce((a, c) => (Math.abs(c) > Math.abs(a) ? c : a), first);
  }
}

/** The gates that failed — CI's exit condition. */
export function breachedGates(readings: readonly GateReading[]): GateReading[] {
  return readings.filter((r) => r.status === "fail");
}
