export const meta = {
  name: 'stw-phase-4',
  description: 'SuperTwinV13 Phase 4 — hardening: full eval + gate enforcement, latency instrumentation, confluence test, ops surfaces; close the 15 no-data gates',
  phases: [{ title: 'Group M' }, { title: 'Gate' }],
}

const BRIEF = 'Read /home/user/SuperTwinV13/.claude/BUILD_BRIEF.md FIRST — repo map, rules, and which of the three suites covers your files. Current state: all 1000 eval cases pass, 0 gates breached, 80/96 gates measured. Phases 0-3 are done. Your phase is HARDENING: make the remaining gates measurable, prove the runtime invariants, and finish the ops surfaces. Never stub a metric, never lower a threshold; a gate that cannot fail is not a gate.'

const REPORT = {
  type: 'object', additionalProperties: false,
  required: ['item', 'files', 'tests', 'eval_result', 'acceptance', 'notes'],
  properties: {
    item: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' }, eval_result: { type: 'string' },
    acceptance: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
  },
}

phase('Group M')

const gM = await parallel([
  () => agent(`${BRIEF}

YOUR ITEM: **4.1 Full eval run and gate enforcement** — build doc: sed -n '546,552p' SuperTwinV13_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md (item starts at the "### ⇉M 4.1" heading — grep -n "4.1 Full eval" to locate exactly; offsets may have drifted from doc edits).

Beyond the item text, your job includes closing the measurable subset of the 15 no-data gates:
- sched_recency_order, sched_restart_no_rejudge, sched_bootstrap_seal_immediate, sched_live_preempts_backfill — these need a scheduler-level integration harness: build a deterministic fake-clock full-import + restart scenario in the T executor (or a new sched integration executor) that drives the REAL scheduler (worker/src/scheduler/) over a temp DB and emits observations for all four.
- all_corrections_survive — build the re-derivation-after-user-correction scenario: apply a user correction, run a full re-derive, prove the correction survives; emit the observation.
- loops_done_detection_precision — an N/Q-side fixture or corpus-level observation naming it, from the real P-DD1 parser over the labelled corpus.
- CI: ensure the eval run in .github/workflows/ci.yml fails the build when any §14.2 gate is breached (it may already; verify and prove with a deliberate local breach, reverted).
Report which gates you moved from no-data to measured, each one's value, and any that remain genuinely unmeasurable offline (the enrichment media set may be — see item 4.4's owner note).`,
    { label: '4.1 gate-enforcement', phase: 'Group M', schema: REPORT }),

  () => agent(`${BRIEF}

YOUR ITEM: **4.2 Latency instrumentation** — grep -n "4.2 Latency" SuperTwinV13_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md and read the item.

Also read arch doc §9.5 (first-paint critical path) and §9.7 (pacing/stalls). The global acceptance numbers to instrument and enforce: first claim <= 30 s, spaces and tasks <= 120 s, longest silent gap <= 90 s during a full import, steady-state <= 12 model calls on a quiet day. Latency marks must be persisted (runs table or a marks table) and rendered on the ops surface (coordinate: item 4.4 owns the UI — expose the data via a route; only add minimal UI if 4.4's agent has not built the panel). Prove the quiet-day call budget with a simulated quiet day over the real scheduler.`,
    { label: '4.2 latency', phase: 'Group M', schema: REPORT }),

  () => agent(`${BRIEF}

YOUR ITEM: **4.3 Confluence test** — grep -n "4.3 Confluence" SuperTwinV13_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md and read the item.

The global acceptance says: the SAME corpus ingested in 3 different orders yields an IDENTICAL graph. Build the confluence harness: one reference corpus, three ingest orders (chronological, reverse, shuffled-by-stream), full pipeline run each time over a fresh temp DB, then a deep graph comparison (entities, edges, sessions, episodes, arcs, claims_active, loops — compare by content-derived keys, not row ids where ids are nondeterministic; verdict-id nondeterminism is known and acceptable, graph shape is not). Any divergence is a FAIL with a diff. Wire the result into the eval gate that covers determinism/confluence if one exists in §14.2, else assert it in a worker test. This is the single strongest correctness proof in the build — be rigorous, and report the actual comparison coverage (which tables, how many rows).`,
    { label: '4.3 confluence', phase: 'Group M', schema: REPORT }),

  () => agent(`${BRIEF}

YOUR ITEM: **4.4 Ops surfaces** — grep -n "4.4 Ops surfaces" SuperTwinV13_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md and read the item, plus arch doc §14.0c (Settings — processing, line 2583) and the ops parts of §14.

React work in src/tabs/ + src/styles/tabs/ following the existing patterns; tests with @testing-library/react. Surface: import progress with the coverage meter, quarantine browser, question queue, latency panel (4.2 exposes the data — read its routes; build against whatever it exposed, or a minimal typed stub route if it has not landed yet, flagged in notes), pause/resume controls per lane.

ALSO: the 9 enrichment no-data gates (enrich_*) need real media files to measure. Check worker test fixtures for any existing small media samples (grep the media tests). If tiny synthetic samples can be generated (a 1-second wav, a 2x2 png) and driven through the REAL enrichment queue in a worker test, do it and emit observations for the gates that become measurable — especially the bolded enrich_caption_wrong_image (mismatch detection). Whatever remains genuinely unmeasurable without a live model, list explicitly.`,
    { label: '4.4 ops+enrich', phase: 'Group M', schema: REPORT }),
])

phase('Gate')

const gate = await agent(`${BRIEF}

You are the PHASE 4 GATE verifier. Items 4.1-4.4 landed concurrently.

1. npx tsc -b AND npx tsc --noEmit in worker/ — fix everything, preserving all agents' intent on collisions.
2. All three suites green: npm test -w worker, npx vitest run, npx vitest run --config scripts/vitest.config.mjs.
3. npm run eval — report: total cases, gates defined/measured/breached, and the full remaining no-data list with one line each on why it cannot be measured offline.
4. Verify the Phase 4 / global acceptance boxes: grep -n "6. Global acceptance" SuperTwinV13_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md and check every box in that section against real code/output where offline-verifiable; mark the ones that need a live device run as such, honestly.
5. Confluence: run the 3-order harness and report the real result.
6. Cheat-scan: no .skip/.only, gates.ts thresholds verbatim vs §14.2.
Do NOT git commit or push.
Report: TYPECHECK / SUITES / EVAL / CONFLUENCE / GLOBAL-ACCEPTANCE (box by box) / NO-DATA-REMAINING / CHEAT-SCAN / FIXES.`,
  { label: 'phase-4 gate', phase: 'Gate', effort: 'high' })

return { gM: gM.filter(Boolean), gate }
