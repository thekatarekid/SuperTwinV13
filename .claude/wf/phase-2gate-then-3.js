export const meta = {
  name: 'stw-p2gate-then-p3',
  description: 'Verify and repair the Phase 2 gate, then run all of Phase 3 (claims, loops, spaces, tasks)',
  phases: [
    { title: 'Phase 2 audit', detail: 'independent audit of the 7 landed Phase 2 items' },
    { title: 'Phase 2 gate', detail: 'drive suites + evals J K L green' },
    { title: 'Phase 3', detail: 'nested phase-3 workflow' },
  ],
}

const BRIEF = 'Read /home/user/SuperTwinV11/.claude/BUILD_BRIEF.md FIRST — repo map, rules, invariants, and which of the three test suites covers your files.'

phase('Phase 2 audit')

// Phase 2's items landed but the run never reported. Audit what is actually on disk
// before gating it — do not trust that the items are complete.
const AUDIT = {
  type: 'object', additionalProperties: false,
  required: ['item', 'present', 'complete', 'gaps'],
  properties: {
    item: { type: 'string' },
    present: { type: 'boolean', description: 'do the files exist at all' },
    complete: { type: 'boolean', description: 'does it satisfy every acceptance box in the build doc' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'specific unmet acceptance boxes or missing behaviour; empty if none' },
  },
}

const AUDIT_ITEMS = [
  ['2.1 Episode engine', '352-361', 'worker/src/episodes/'],
  ['2.2 P-EP2 episode pass', '362-367', 'worker/src/prompts/'],
  ['2.3 Episode embeddings and attach gate', '368-373', 'worker/src/episodes/'],
  ['2.4 Bridge extractor', '374-384', 'worker/src/bridges/'],
  ['2.5 Arc engine', '385-395', 'worker/src/arcs/'],
  ['2.6 Reconcile job and scheduling', '396-401', 'worker/src/arcs/reconcile.ts'],
  ['2.7 Surfaces — Episodes and Threads', '402-409', 'src/tabs/'],
]

const audits = await parallel(AUDIT_ITEMS.map(([id, range, where]) => () =>
  agent(
    `${BRIEF}

A Phase 2 workflow landed code for item **${id}** but never reported its result, so nobody has verified it. AUDIT IT — do not implement from scratch, and do not assume it is finished.

1. Read the item spec: \`sed -n '${range.replace('-', ',')}p' SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md\`, plus the architecture sections it cites.
2. Read what is actually on disk (start at ${where}) and the tests beside it.
3. Run that item's tests and report the REAL result.
4. For EVERY acceptance box in the item spec, decide MET or NOT MET against real code and real output — not against what a comment claims.

If you find a gap that is small and clearly within this item, FIX it and re-run the tests. If it is large, report it precisely and leave it. Do not edit files belonging to another Phase 2 item. Do NOT git commit or git push.`,
    { label: `audit:${id.slice(0, 20)}`, phase: 'Phase 2 audit', schema: AUDIT },
  )
))

const gaps = audits.filter(Boolean).filter(a => !a.complete)
log(`phase 2 audit: ${audits.filter(Boolean).length} items, ${gaps.length} with gaps`)

phase('Phase 2 gate')

const gate2 = await agent(
  `${BRIEF}

You are the PHASE 2 GATE verifier for SuperTwinV11. Items 2.1-2.7 landed concurrently and have just been audited. Audit findings you must act on:
${gaps.length ? gaps.map(g => `- ${g.item}: ${g.gaps.join('; ')}`).join('\n') : '- none; every item reported complete'}

1. \`npx tsc -b\` — fix every error, including merge collisions between the concurrent agents. Preserve BOTH agents' intent when resolving one.
2. \`npm test -w worker\` AND \`npx vitest run\` AND \`npx vitest run --config scripts/vitest.config.mjs\` — fix every failure in all three.
3. \`npm run eval\` — categories J, K and L must be implemented and green, and NO previously-passing category may regress (the suite was at 580/580 with 47 gates measured and 0 breached before Phase 2). Report the new totals.
4. Close any audit gap listed above that is still open.
5. Verify the Phase 2 gate boxes: \`sed -n '410,417p' SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md\` — check each against real code and real command output.
6. Verify these invariants hold and are asserted somewhere: NO \`spaces\` table exists (promotion is fields on \`arcs\`); episodes are stream-scoped; bridges are deterministic \`[CODE]\` with zero model calls; the arc adjudicator P-AG2 is NOT on the first-paint path.
7. A gate that reports \`no data\` is NOT passing. If a Phase 2 gate (episodes_*, arcs_*) reads \`no data\`, wire it to a real measurement the way \`worker/src/entities/audit.ts\` does for the entity gates — read that file for the established pattern. Do not stub a value or lower a threshold.

You MAY edit any file. Do NOT git commit or git push.

Report: TYPECHECK / TESTS (three suites, N passed N failed) / EVAL (total cases, J K L rates, gates measured, gates breached) / INVARIANTS (one line each) / GATE PASS|FAIL + specific unmet boxes / FIXES (max 10 lines).`,
  { label: 'phase-2 gate', phase: 'Phase 2 gate', effort: 'high' },
)

phase('Phase 3')

const p3 = await workflow({ scriptPath: '/home/user/SuperTwinV11/.claude/wf/phase-3.js' })

return { audits: audits.filter(Boolean), gate2, p3 }
