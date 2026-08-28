export const meta = {
  name: 'stw-phase-2',
  description: 'SuperTwinV13 Phase 2 — episodes and arcs: episode engine, P-EP2, embeddings/attach gate, bridge extractor, arc engine, reconcile, surfaces',
  phases: [{ title: 'Group F' }, { title: 'Group G' }, { title: '2.5 arc-engine' }, { title: 'Group H' }, { title: 'Gate' }],
}

const BUILD = 'SuperTwinV13_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md'
const BRIEF = 'Read /home/user/SuperTwinV13/.claude/BUILD_BRIEF.md FIRST — repo map, rules, report format. Then read your item section in the build doc with `sed -n` over the given line range, plus the architecture sections it cites. Do not read whole documents.'
const REPORT = {
  type: 'object', additionalProperties: false,
  required: ['item', 'files', 'tests', 'typecheck', 'acceptance', 'notes'],
  properties: {
    item: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' }, typecheck: { type: 'string' },
    acceptance: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
  },
}
const item = (id, label, ph, range, extra) => agent(
  `${BRIEF}\n\nYOUR ITEM: **${id}** — build doc lines ${range}: run \`sed -n '${range.replace('-', ',')}p' ${BUILD}\`.\n\n${extra}`,
  { label, phase: ph, schema: REPORT })

phase('Group F')
const gF = await parallel([
  () => item('2.1 Episode engine', '2.1 episodes', 'Group F', '352-361',
    'Read arch doc §11.1 "Episodes — topical, stream-scoped" IN FULL (line 1518-1539). Episodes are topical and SCOPED TO ONE STREAM — cross-stream grouping is an arc, not an episode. Tables episodes, episode_sessions, episode_verdicts, episode_embeddings come from migration 0020; read the SQL for real columns. Satisfy evals category J (`### J — EPISODES (55)`, evals doc line 572).'),
  () => item('2.2 P-EP2 episode pass', '2.2 p-ep2', 'Group F', '362-367',
    'Read arch doc §12.3 P-EP2 episode segmentation IN FULL (line 1898-1949). [LLM-M] sonnet-5. Use the STW-2 codec in worker/src/wire/ and the prompt runner from item 1.9 (worker/src/prompts/ + the runner) — read both before writing. Output template comes from arch §5.6. thinkingBudget is `off`.'),
])

phase('Group G')
const gG = await parallel([
  () => item('2.3 Episode embeddings and attach gate', '2.3 ep-embed', 'Group G', '368-373',
    'Use the calibrated scoring from worker/src/retrieval/calibration.ts (item 0.7): score = (cos - floor)/(1 - floor), use_case `episode_topic`. The attach gate MUST be disabled when calibration is missing or stale — route to the agent or question queue instead of guessing. Never compare bare short strings; embed rich text.'),
  () => item('2.4 Bridge extractor', '2.4 bridges', 'Group G', '374-384',
    'The bridge_keys come from the adapter manifest (["url","phone","email","media_work_id","order_id"] for WhatsApp), not from hardcoded constants. Normalise into bridges.value_norm — the index is bridges(kind, value_norm). Bridges are [CODE], deterministic, zero model calls. Satisfy evals category K (`### K — BRIDGES (30)`, evals doc line 634).'),
])

phase('2.5 arc-engine')
const r25 = await item('2.5 Arc engine', '2.5 arcs', '2.5 arc-engine', '385-395',
  'Read arch doc §11.2 "Arcs — cross-time, cross-source" IN FULL (line 1540-1584) and §12.6 P-AG2 arc adjudication (line 2116-2153).\nArcs span time AND sources. Tables arcs, arc_episodes, arc_verdicts, bridges, provisional_arcs come from migration 0020 — read the SQL.\nCRITICAL: there is NO `spaces` table. Promotion is a set of FIELDS ON `arcs`: promoted, promotion_reason, archetype, archetype_source, status, ends_at, cadence, user_label. Phase 3 item 3.6 sets them; you create the arcs they hang off.\nThe adjudicator (P-AG2) must NOT be on the first-paint path — provisional_arcs exist so first paint can proceed without it.\nSatisfy evals category L (`### L — ARCS (45)`, evals doc line 671).')

phase('Group H')
const gH = await parallel([
  () => item('2.6 Reconcile job and scheduling', '2.6 reconcile', 'Group H', '396-401',
    'Hook into the cohort scheduler from item 1.8 (read worker/src/ for it first). Reconciliation must respect the steady-state budget from global acceptance: <= 12 model calls on a quiet day. Output grows monotonically — reconciliation never retracts what was already shown.'),
  () => item('2.7 Surfaces — Episodes and Threads', '2.7 surfaces', 'Group H', '402-409',
    'Read arch doc §14.3 Episodes (line 2682) and the Threads surface section (grep -n "Threads" on the arch doc), plus §14.0 the coverage meter (line 2550) and §14.0b conversation-in-progress (line 2564). React tabs in src/tabs/ + styles in src/styles/tabs/, following the existing InboxTab/inbox.css patterns. Every surface carries the coverage meter. Tests with @testing-library/react.'),
])

phase('Gate')
const gate = await agent(
  'Read /home/user/SuperTwinV13/.claude/BUILD_BRIEF.md. You are the PHASE 2 GATE verifier for SuperTwinV13. Items 2.1-2.7 just landed concurrently.\n1. `npx tsc -b` — fix all errors including concurrent-agent merge collisions, preserving both agents intent.\n2. `npx vitest run` AND `npm test -w worker` (the worker workspace has its own ~950-test suite the root run does NOT cover) AND `npx vitest run --config scripts/vitest.config.mjs` — fix every failure in all three.\n3. `npm run eval` — report pass rates for categories J, K and L.\n4. Verify the Phase 2 gate boxes: `sed -n \'410,417p\' SuperTwinV13_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md`, checking each against real code and real command output.\nYou MAY edit any file. Do NOT git commit or git push.\nReport: TYPECHECK / TESTS (N passed, N failed + files) / EVAL (J K L) / GATE PASS|FAIL + unmet boxes / FIXES (max 10 lines).',
  { label: 'phase-2 gate', phase: 'Gate', effort: 'high' })

return { gF: gF.filter(Boolean), gG: gG.filter(Boolean), r25, gH: gH.filter(Boolean), gate }
