export const meta = {
  name: 'stw-phase-3',
  description: 'SuperTwinV11 Phase 3 — claims, loops, spaces, tasks: P-CL1, code facts, write path, live trigger, promotion, archetypes, triage, goals, surfaces',
  phases: [{ title: '3.1 P-CL1' }, { title: 'Group I' }, { title: 'Group J' }, { title: 'Group K' }, { title: 'Group L' }, { title: 'Gate' }],
}

const BUILD = 'SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md'
const BRIEF = 'Read /home/user/SuperTwinV11/.claude/BUILD_BRIEF.md FIRST — repo map, rules, report format. Then read your item section in the build doc with `sed -n` over the given line range, plus the architecture sections it cites. Do not read whole documents.'
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

phase('3.1 P-CL1')
const r31 = await item('3.1 P-CL1 and P-CL1delta', '3.1 p-cl1', '3.1 P-CL1', '420-433',
  'This is THE CORE CALL of the entire build. Read arch doc §12.4 P-CL1 IN FULL (line 1950-2051) and §12.5 P-CL1delta IN FULL (line 2052-2115). Also read §11.3 "Claims, loops, spaces, tasks" (line 1585-1686).\n[LLM-M] sonnet-5, thinkingBudget `off`. Use the STW-2 codec in worker/src/wire/ and the prompt runner from item 1.9 — read both first. Output template from arch §5.6; the tag vocabulary is arch §5.3 and the enum tables are §5.4.\nHARD RULES: no JSON for model I/O, STW-2 both directions. Code must never drop, edit, censor or filter model output — model output discarded by code must be ZERO. Precedence uses claim_versions.stated_at, NEVER ingested_at.\nSatisfy evals categories M CLAIMS (line 723, 95 cases) and N LOOPS (line 825, 75 cases) — 170 cases, the largest block in the suite. Read them all and be exhaustive.')

phase('Group I')
const gI = await parallel([
  () => item('3.2 Code facts', '3.2 code-facts', 'Group I', '434-444',
    'Read arch doc §11.4 "Code facts and loop state" IN FULL (line 1687-1721). Code facts are [CODE] — deterministic, zero model calls. They are the ground truth the model output is reconciled against, never a filter applied to model output.'),
  () => item('3.3 Write path, versions, P-AG3', '3.3 write-path', 'Group I', '445-456',
    'Read arch doc §11.6 "Write path, adjudication, goals" (line 1732-1758) and §12.7 P-AG3 claim contradiction IN FULL (line 2154-2201).\nclaim_versions is append-only; claims_active is the VIEW from migration 0020. Supersession is by stated_at ONLY — never ingested_at, never insertion order. Zero near-duplicate claims. Output grows monotonically; nothing already shown is retracted.\nSatisfy evals category R (`### R — WRITE (40)`, evals doc line 1053).'),
])

phase('Group J')
const gJ = await parallel([
  () => item('3.4 Live trigger and backpressure', '3.4 live-trigger', 'Group J', '457-468',
    'Read arch doc §8.3 "Near-realtime: extraction cadence is decoupled from session boundaries" IN FULL (line 991-1036) and §9.7 pacing/stalls/progress (line 1314).\nHook into the cohort scheduler from item 1.8. Budgets from global acceptance: first claim <= 30s, spaces and tasks <= 120s, longest silent gap during a full import <= 90s, steady-state <= 12 model calls on a quiet day. Instrument and test against those numbers.'),
  () => item('3.5 Two-pass enrichment completion', '3.5 two-pass', 'Group J', '469-474',
    'Read arch doc §8.4 "Text-first, enrich-later — exactly two passes" IN FULL (line 1037-1105) and §9.6 "Media never blocks text — the update-in-place path" (line 1292-1303).\nEXACTLY two passes, never three. Media is understood in its own session with its own context. Media never blocks the text path. Completes the enrichment queue from item 1.4.'),
])

phase('Group K')
const gK = await parallel([
  () => item('3.6 Promotion and status', '3.6 promotion', 'Group K', '475-484',
    'Read arch doc §11.3 (line 1585-1686) for promotion rules.\nCRITICAL: promotion writes FIELDS ON `arcs` — promoted, promotion_reason, archetype, archetype_source, status, ends_at, cadence, user_label. There is NO `spaces` table; never create one.\nGlobal acceptance targets you must hit: <= 45 spaces from ~3,000 events, > 90% justified by a route, and ZERO spaces that are another person life. Test all three.\nSatisfy evals category P (`### P — PROMOTION (50)`, evals doc line 959).'),
  () => item('3.7 P-SP1 archetypes', '3.7 p-sp1', 'Group K', '485-490',
    'Read arch doc §12.10 P-SP1 archetype + label IN FULL (line 2308-2378). [LLM-S] haiku-4-5, thinkingBudget `off`. Writes arcs.archetype and arcs.archetype_source. Uses the STW-2 codec and the prompt runner.'),
  () => item('3.8 P-TR1 triage and P-DD1 done-detection', '3.8 triage-done', 'Group K', '491-500',
    'Read arch doc §12.8 P-TR1 triage IN FULL (line 2202-2259) and §12.9 P-DD1 done-detection IN FULL (line 2260-2307). Both [LLM-S] haiku-4-5, thinkingBudget `off`.\nGlobal acceptance you must enforce and test: ZERO tasks born past-due as open; ZERO non-self tasks; the state `possibly_done` DOES NOT EXIST — a task is done or it is not.\nSatisfy evals category Q (`### Q — TASKS (30)`, evals doc line 1016).'),
])

phase('Group L')
const gL = await parallel([
  () => item('3.9 Goal emergence', '3.9 goals', 'Group L', '501-506',
    'Read arch doc §11.6 (line 1732-1758) for goals. Tables goals and goal_spaces come from migration 0020 — read the SQL. Goals EMERGE from the graph; they are not user-entered configuration.'),
  () => item('3.10 Surfaces — Claims, Spaces, Tasks, People', '3.10 surfaces', 'Group L', '507-519',
    'Read arch doc §14 the eight surfaces (line 2546 onwards) — specifically the Claims, Spaces, Tasks and People sections (grep -n "^### 14\\." on the arch doc for the exact lines), plus §14.0 the coverage meter (line 2550) and §14.0b conversation-in-progress (line 2564).\nReact tabs in src/tabs/ + styles in src/styles/tabs/, following the existing InboxTab/inbox.css patterns and the tab shell in src/App.tsx. Every surface carries the coverage meter. Provisional live output is visually distinguished and never silently retracted. Tests with @testing-library/react.'),
])

phase('Gate')
const gate = await agent(
  'Read /home/user/SuperTwinV11/.claude/BUILD_BRIEF.md. You are the PHASE 3 GATE verifier for SuperTwinV11. Items 3.1-3.10 just landed concurrently.\n1. `npx tsc -b` — fix all errors including concurrent-agent merge collisions, preserving both agents intent.\n2. `npx vitest run` — fix every failure.\n3. `npm run eval` — report pass rates for categories M, N, P, Q and R.\n4. Verify the Phase 3 gate boxes: `sed -n \'520,528p\' SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md`, checking each against real code and real command output.\n5. Verify these global invariants against the code and assert them in tests if not already asserted: no `spaces` table exists; claims supersede by stated_at only; zero tasks born past-due as open; zero non-self tasks; `possibly_done` appears nowhere in the codebase.\nYou MAY edit any file. Do NOT git commit or git push.\nReport: TYPECHECK / TESTS / EVAL (M N P Q R) / INVARIANTS (one line each) / GATE PASS|FAIL + unmet boxes / FIXES (max 10 lines).',
  { label: 'phase-3 gate', phase: 'Gate', effort: 'high' })

return { r31, gI: gI.filter(Boolean), gJ: gJ.filter(Boolean), gK: gK.filter(Boolean), gL: gL.filter(Boolean), gate }
