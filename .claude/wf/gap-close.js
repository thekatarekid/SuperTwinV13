export const meta = {
  name: 'stw-gap-close',
  description: 'Close the honest gate failures: author M/N/Q fixtures + executors, measure spaces gates, representative episode corpus, wire episode engine into the pipeline',
  phases: [
    { title: 'Fan out', detail: '5 independent gap-closers in parallel' },
    { title: 'Verify', detail: 'suites + full eval, gates re-checked' },
  ],
}

const BRIEF = 'Read /home/user/SuperTwinV11/.claude/BUILD_BRIEF.md FIRST — repo map, rules, and which of the three test suites covers your files. Key context: the eval harness is worker/src/evals/{runner,gates,fixtures}.ts with executors in worker/src/evals/executors/ (registered in executors/index.ts as PRODUCT_EXECUTORS). Fixtures live in evals/fixtures/<CAT>-NNN.json; `node evals/generate-fixtures.mjs --check` validates the set against the doc tables. Executors must drive REAL product code over a real temp SQLite DB — the established patterns are executors/ingest.ts, executors/entity-world.ts, executors/episodes.ts and executors/write.ts; gate measurement via GateObservation[] follows worker/src/entities/audit.ts and worker/src/episodes/audit.ts. Never stub a metric, never lower a threshold, never edit product code to fit a fixture — if product code is genuinely wrong, fix the product and say so.'

const REPORT = {
  type: 'object', additionalProperties: false,
  required: ['task', 'files', 'tests', 'eval_result', 'notes'],
  properties: {
    task: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    eval_result: { type: 'string', description: 'real npm run eval output for your categories/gates' },
    notes: { type: 'string', description: 'max 6 lines: deviations, product bugs found, follow-ups' },
  },
}

phase('Fan out')

const results = await parallel([
  // M CLAIMS — 95 fixtures + claims executor
  () => agent(`${BRIEF}

YOUR TASK: author the 95 category-M CLAIMS fixtures and the \`claims\` executor so evals M is measured for real.

1. Read the M case table: sed -n '723,824p' SuperTwinV11_GoldenEvals_V2.md — every row describes given/expect. Read arch doc §11.3 (lines 1585-1686) and §12.4 P-CL1 (1950-2051) for semantics.
2. The product code already exists and its unit tests pass: worker/src/prompts/p-cl1.ts, worker/src/claims/extract.ts (parser, accounting identity), worker/src/claims/ (write path, supersede). Read them; the executor drives THEM.
3. Author evals/fixtures/M-001..M-095.json with real given/expect payloads and "stub": false, exactly matching the doc rows. Update evals/generate-fixtures.mjs bookkeeping if it tracks authored counts.
4. Write worker/src/evals/executors/claims.ts driving the frozen_response path through the real parser + write path over a temp DB, and register it in executors/index.ts.
5. Feed the claims gates (claims_* in gates.ts) with GateObservations where they currently read no data.
6. \`npm run eval -- --only M\` must pass 95/95; full eval must not regress; \`npm test -w worker\` green for your files.
OWNERSHIP: you own evals/fixtures/M-*.json and executors/claims.ts. Shared files (executors/index.ts, gates.ts, fixture count tests) — make minimal additive edits.`,
    { label: 'M claims 95', phase: 'Fan out', schema: REPORT }),

  // N LOOPS — 75 fixtures + loops executor
  () => agent(`${BRIEF}

YOUR TASK: author the 75 category-N LOOPS fixtures and the \`loops\` executor.

1. Read the N case table: sed -n '825,906p' SuperTwinV11_GoldenEvals_V2.md. Read arch doc §11.4 code facts / loop state (1687-1721) and §12.8 P-TR1 / §12.9 P-DD1 (2202-2307).
2. Product code exists: worker/src/claims/extract.ts parses T lines; worker/src/loops/ or worker/src/claims/ carries loop state derivation, triage (p-tr1) and done-detection (p-dd1) — find them with Glob and read them.
3. Author evals/fixtures/N-001..N-075.json ("stub": false), write worker/src/evals/executors/loops.ts, register it.
4. Feed the unmeasured loop gates — especially \`loops_born_past_due_open\` (must measure 0) and \`loops_non_user_owner_tasks\` (must measure 0) — with real observations from persisted rows.
5. \`npm run eval -- --only N\` 75/75; no regression; worker suite green for your files.
OWNERSHIP: evals/fixtures/N-*.json, executors/loops.ts. Minimal additive edits to shared files.`,
    { label: 'N loops 75', phase: 'Fan out', schema: REPORT }),

  // Q TASKS — 30 fixtures + tasks executor
  () => agent(`${BRIEF}

YOUR TASK: author the 30 category-Q TASKS fixtures and the \`tasks\` executor.

1. Read the Q case table: sed -n '1016,1052p' SuperTwinV11_GoldenEvals_V2.md. Read arch doc §11.3 tasks semantics and §12.8/§12.9.
2. Product code exists: tasksFrom() and pastDueOpenViolations() (grep -rn for them in worker/src). The invariants — zero tasks born past-due as open, zero non-self tasks, possibly_done does not exist — are already test-asserted; your job is to make the EVAL measure them over the Q corpus.
3. Author evals/fixtures/Q-001..Q-030.json ("stub": false), write worker/src/evals/executors/tasks.ts, register it.
4. \`npm run eval -- --only Q\` 30/30; no regression; worker suite green for your files.
OWNERSHIP: evals/fixtures/Q-*.json, executors/tasks.ts. Minimal additive edits to shared files.`,
    { label: 'Q tasks 30', phase: 'Fan out', schema: REPORT }),

  // Spaces gates measurement + reference corpus
  () => agent(`${BRIEF}

YOUR TASK: make the two spaces gates measurable and enforce the spaces cap.

1. \`spaces_count_vs_gold\` (fails outside ±25%) and \`spaces_archetype_accuracy\` (fails < 0.85) read \`no data\`. Read their definitions in arch doc §14.2 (grep -n "14.2" SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2.md) and in worker/src/evals/gates.ts.
2. The Phase 3 gate box says: spaces ≤ 45 on the reference corpus, > 90% holding a live loop or reference anchor. There is currently NO cap in worker/src/arcs/constraints.ts — read the promotion code (worker/src/arcs/, promotion fields on arcs) and the P PROMOTION executor, then implement the cap/justification logic in the PRODUCT code where arch §11.3 says it belongs, not in the eval.
3. Build a reference corpus fixture (the P executor's world may already be close) sized so the ±25% count check and the >90% justification check are real measurements, and feed both gates with observations.
4. Also wire \`labels_anchor_entity\` if it still reads no data and belongs to promotion.
5. Prove falsifiability: mutate promotion to over-promote and confirm spaces_count_vs_gold FAILS; revert. Report the experiment.
6. Full eval: gates measured must rise, 0 breached beyond the known episodes_one_to_one_rate; worker suite green.
OWNERSHIP: worker/src/arcs/constraints.ts, executors/promotion or spaces executor, evals/fixtures/P-* only if a fixture is genuinely wrong. Minimal additive edits to shared files.`,
    { label: 'spaces gates+cap', phase: 'Fan out', schema: REPORT }),

  // Episode corpus representativeness + engine wiring
  () => agent(`${BRIEF}

YOUR TASK: two related episode gaps.

A) \`episodes_one_to_one_rate\` honestly reads 41.2% against a 60% floor. The engine is NOT at fault: it takes the zero-call 1:1 default on 21/21 sessions where the precondition holds and judges 30/30 where it does not. The J corpus is a coverage matrix (12 pivots, 12 resumes, 5 cross-stream, 4 drift), not a traffic sample, so the rate is the corpus's own mix. Read arch doc §11.1 and the gate's intent in §14.2: the 60% floor describes REAL traffic, where most sealed sessions are single-topic. Fix by EXTENDING the J corpus with representative single-topic traffic cases (following the evals doc §J table style — add them as additional authored fixtures beyond J-055 ONLY if the doc's fixture-count checker allows extras; otherwise build the representative corpus inside the episodes executor as a corpus-level measurement world, the way entity-world.ts builds its world). Do NOT lower the threshold, do NOT narrow the denominator back. The measured rate must genuinely clear 60% because the corpus genuinely resembles traffic.
B) The episode engine (runEpisodePass/preflagDrift/ageEpisodes) has NO production caller — worker/src/episodes/ is unreachable from worker/src/server/index.ts, and no scheduled caller runs the 14-day aging clock. Wire it: the cohort scheduler (worker/src/scheduler/) should invoke the episode pass after session sealing per arch §7/§9, and the aging clock needs a scheduled job. Read the scheduler first and follow its existing patterns. The EpisodeJudge seam in engine.ts:377 must be connected to the real P-EP2 adapter (worker/src/prompts/p-ep2.ts) — the unified verdict shape landed already.
Run: worker suite green, \`npm run eval\` with episodes_one_to_one_rate ≥ 60% honestly measured and no other gate regressed.
OWNERSHIP: worker/src/episodes/ wiring, worker/src/scheduler/ (additive), executors/episodes.ts, evals/fixtures/J-* additions if the checker allows. Minimal additive edits elsewhere.`,
    { label: 'episodes rate+wiring', phase: 'Fan out', schema: REPORT }),
])

phase('Verify')

const verify = await agent(`${BRIEF}

You are the FINAL VERIFIER. Five gap-closing agents just landed concurrently: M/N/Q fixtures + executors, spaces gates + cap, episode corpus + engine wiring.

1. \`npx tsc -b\` AND \`npx tsc --noEmit\` inside worker/ — fix every error including collisions (executors/index.ts, gates.ts and the fixture-count tests were edited by up to five agents; merge all their registrations).
2. All three suites green: \`npm test -w worker\`, \`npx vitest run\`, \`npx vitest run --config scripts/vitest.config.mjs\`.
3. \`npm run eval\` — target: 1000/1000 cases pass, 0 pending, 0 gates breached. Report the real totals, per-category rates for M N P Q R, and every gate still reading \`no data\` with one line on why.
4. Re-verify the Phase 2 gate boxes (sed -n '410,417p' on the build doc) and Phase 3 gate boxes (sed -n '537,540p') against real output. State PASS/FAIL per box.
5. rg for cheating: \\.skip\\(|\\.only\\(|threshold changes in gates.ts vs the arch doc §14.2 values — report anything suspicious.
Do NOT git commit or push.
Report: TYPECHECK / SUITES / EVAL (totals + M N P Q R + no-data list) / P2 BOXES / P3 BOXES / CHEAT-SCAN / FIXES (max 10 lines).`,
  { label: 'final verify', phase: 'Verify', effort: 'high' })

return { results: results.filter(Boolean), verify }
