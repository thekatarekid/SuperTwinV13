export const meta = {
  name: 'stw-phase-1',
  description: 'SuperTwinV11 Phase 1 — ingest to sessions: adapter registry, tiers, salience, enrichment queue, entity graph, party model, segmenters, scheduler, prompt runner, entity pass, surfaces',
  phases: [
    { title: '1.1 registry' },
    { title: 'Group B' },
    { title: 'Group C' },
    { title: '1.7 segmenters' },
    { title: 'Group D' },
    { title: 'Group E' },
    { title: 'Gate' },
  ],
}

const BUILD = 'SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md'
const BRIEF = 'Read /home/user/SuperTwinV11/.claude/BUILD_BRIEF.md FIRST — repo map, rules, and the report format. Then read your item section in the build doc with `sed -n` over the line range given, plus the architecture sections it cites. Do not read whole documents.'

const REPORT = {
  type: 'object',
  additionalProperties: false,
  required: ['item', 'files', 'tests', 'typecheck', 'acceptance', 'notes'],
  properties: {
    item: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    typecheck: { type: 'string' },
    acceptance: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const item = (id, label, ph, range, extra) => agent(
  `${BRIEF}\n\nYOUR ITEM: **${id}** — build doc lines ${range}: run \`sed -n '${range.replace('-', ',')}p' ${BUILD}\`.\n\n${extra}`,
  { label, phase: ph, schema: REPORT },
)

phase('1.1 registry')
const r11 = await item('1.1 Adapter registry, manifest, source-leak fixes', '1.1 registry', '1.1 registry', '181-194',
  'Read arch doc §2 (lines 33-123, especially §2.1 five stream kinds and §2.2 the adapter manifest) and §3.3 source leaks.\n\nCreate worker/src/adapters/registry.ts and worker/src/adapters/whatsapp/manifest.ts; modify worker/src/db/ingest.ts, worker/src/index.ts and worker/src/server/*.\nThe WhatsApp manifest must be exactly as the build doc specifies: stream_kind_of -> conversation for all chats; actor_model multi_actor; self_identity {kind:"jid", value_getter: selfJid}; identities_emitted ["jid","phone"]; capabilities.backfill_order "desc"; segmentation defaults gap_ms 6h (1:1) / 4h (group), shift_min_gap_ms 1h, size_cap_events 40, size_cap_chars ~6k tokens, day_boundary true, debounce_ms 45m; salience.prefilter "none"; bridge_keys ["url","phone","email","media_work_id","order_id"].\nFIX THE SOURCE LEAKS THOROUGHLY — this is the point of the item: the `wa:` prefix becomes `${source_id}:`; resetWhatsappData becomes resetSourceData(source_id); app_state keys become source.<id>.*; routes become /api/sources/:source_id/* with the OLD routes aliased for one release; the `channels` concept becomes `streams` everywhere in the generic layer.\nDrive WhatsApp history sync NEWEST-PAGE-FIRST. If the Go daemon can only deliver ascending, buffer pages in the scheduler and emit descending cohorts.\nManifest validation happens at registration time: an unknown stream kind, a missing self_identity, or ambient combined with prefilter:none are BOOT ERRORS.\nExactly ONE adapter is registered. Do not add a second.\nTests: the registry rejects a bad manifest; ingest dedupes on (source_id, external_id); watermarks move in opposite directions. Satisfy evals category A (evals doc `### A — INGEST (30)` at line 84). Verify the acceptance rg check and report its real output.')

phase('Group B')
const groupB = await parallel([
  () => item('1.2 Stream tiers and P-TI1', '1.2 tiers', 'Group B', '195-208',
    'Read arch doc §9.3 "Stream tiers" (line 1155) in full, and §12.11 P-TI1 (line 2379).\nCreate worker/src/tiers/{derive,classify}.ts and worker/src/prompts/p-ti1.ts. [CODE] rules run FIRST per §9.3; only what the code rules cannot decide goes to the P-TI1 [LLM-S] haiku call. Store the result in streams.tier. Tier is the scheduler primary sort key.\nSatisfy evals category B (`### B — TIERS (50)`, evals doc line 121) — read all 50 cases and make them pass.'),
  () => item('1.3 Salience prefilter scaffold', '1.3 salience', 'Group B', '209-216',
    'Read arch doc §10.2 "Salience prefilter — the ambient problem" (line 1344).\nBuild the scaffold generically even though WhatsApp sets prefilter:"none" — the point is that an ambient source can plug in later. Write events.salience. Nothing is dropped; salience only orders and gates.'),
  () => item('1.4 Enrichment queue, batching, priority', '1.4 enrich-queue', 'Group B', '217-233',
    'Read arch doc §10.1 "Enrichment — executor map" (line 1316) and §8.4 "Text-first, enrich-later — exactly two passes" (line 1037).\nThe work_queue table exists from migration 0020 — read worker/src/db/migrations/0020_v2_core.sql for its real columns. Enrichment must NEVER block the text path. Exactly two passes, no more. Satisfy evals category C (`### C — ENRICH (40)`, evals doc line 178).'),
])

phase('Group C')
const groupC = await parallel([
  () => item('1.5 Entity graph and structural binding', '1.5 entity-graph', 'Group C', '234-250',
    'Read arch doc §10.3 "The entity graph" IN FULL (line 1370 to 1459).\nTables entities, entity_identities, entity_edges, edge_evidence, mentions, resolution_decisions, entity_embeddings come from migration 0020 — read the SQL for the real columns.\nStructural binding is [CODE] and must be exact — identity merges at the code rung need no model call. Satisfy evals categories G IDENTITY (line 401, 70 cases), H MENTIONS (line 478, 40 cases) and I EDGES (line 525, 40 cases).'),
  () => item('1.6 Party model', '1.6 party', 'Group C', '251-263',
    'Read arch doc §4.5 "The party model — three roles, nine directions" IN FULL (line 368-411).\nThree roles, nine directions — enumerate all nine explicitly and test each. Satisfy evals category O (`### O — PARTY (45)`, evals doc line 907).'),
])

phase('1.7 segmenters')
const r17 = await item('1.7 Session segmenters', '1.7 segmenters', '1.7 segmenters', '264-279',
  'Read arch doc §10.4 "Sessions — mechanical, code only" IN FULL (line 1460-1515) and §2.1 five stream kinds (line 65).\nSessions are MECHANICAL — [CODE] ONLY, zero model calls. One segmenter per stream kind. The segmentation parameters come from the adapter manifest (gap_ms, shift_min_gap_ms, size_cap_events, size_cap_chars, day_boundary, debounce_ms), not from hardcoded constants.\nSatisfy evals categories D SESS-CONV (line 225, 75 cases), E SESS-OTHER (line 307, 40 cases) and F SESS-OPS (line 354, 40 cases) — 155 cases, read them all. This is the highest-cased area of the build; be exhaustive.')

phase('Group D')
const groupD = await parallel([
  () => item('1.8 Cohort scheduler', '1.8 scheduler', 'Group D', '280-300',
    'Read arch doc §9 IN FULL (lines 1106-1313): §9.1 cohorts, §9.2 ordering newest-first in BOTH modes, §9.4 the two lanes that never block each other, §9.5 the first-paint critical path, §9.6 media never blocks text, §9.7 pacing/stalls/progress. Also §8.1-§8.3 operating modes (line 960-1036).\nHard budgets from global acceptance: first claim <= 30s, spaces and tasks <= 120s, longest silent gap during a full import <= 90s. Design for those numbers and instrument them.\nSatisfy evals category T (`### T — SCHED (30)`, evals doc line 1157).'),
  () => item('1.9 Prompt runner and repair loop', '1.9 prompt-runner', 'Group D', '301-311',
    'Read arch doc §5.7 tolerance, §5.8 failure handling and §5.9 round-trip/rollout (lines 614-642), plus §4.6 error handling (line 412).\nUse the STW-2 codec from worker/src/wire/ (item 0.3) and the provider pool from worker/src/providers/pool.ts (item 0.4) — read both before writing.\nCRITICAL RULE: code must never drop, edit, censor or filter model output. The repair loop re-asks; it does not silently rewrite. Model output discarded by code must be ZERO. Quarantine, never delete.'),
])

phase('Group E')
const groupE = await parallel([
  () => item('1.10 P-EP1 entity pass, resolution ladder, P-AG1', '1.10 p-ep1', 'Group E', '312-327',
    'Read arch doc §12.1 P-EP1 (line 1798-1861) and §12.2 P-AG1 identity resolver (line 1862-1897) IN FULL, plus §10.3 the resolution ladder (line 1370).\nThe ladder rungs are [CODE] -> [ML] -> [AGENT] -> question queue. The [ML] rung uses the calibrated scores from worker/src/retrieval/calibration.ts (item 0.7) and MUST be disabled when calibration is missing or stale. Never guess a threshold.\nSatisfy evals category G IDENTITY (line 401, 70 cases) end-to-end.'),
  () => item('1.11 Surfaces — Entities and Sessions', '1.11 surfaces', 'Group E', '328-340',
    'Read arch doc §14.0 the coverage meter (line 2550), §14.0b conversation-in-progress (line 2564), §14.1 Entities (line 2630) and §14.2 Sessions (line 2654) IN FULL.\nReact tabs in src/tabs/, styles in src/styles/tabs/ following the existing patterns (read src/tabs/InboxTab.tsx and src/styles/tabs/inbox.css first). Every surface carries the coverage meter. Provisional live output must be visually distinguished, never silently retracted.\nTests with @testing-library/react next to the components, matching the existing *.test.tsx style.'),
])

phase('Gate')
const gate = await agent(
  'Read /home/user/SuperTwinV11/.claude/BUILD_BRIEF.md for repo context. You are the PHASE 1 GATE verifier for SuperTwinV11. Eleven items (1.1-1.11) just landed concurrently in this working tree.\n\n1. Run `npx tsc -b`. Fix every error, including merge collisions between concurrent agents. Preserve BOTH agents intent when resolving a collision.\n2. Run `npx vitest run`. Fix every failure.\n3. Run `npm run eval` and report the pass rate for categories A, B, C, D, E, F, G, H, I, O and T.\n4. Verify the Phase 1 gate boxes: `sed -n \'341,349p\' SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md`. Check each one against the real code and real command output, not against what an agent claimed.\nYou MAY edit any file. Do NOT git commit or git push.\n\nReport:\nTYPECHECK: clean | errors\nTESTS: N passed / N failed (+ failing files)\nEVAL: per-category pass rate for A B C D E F G H I O T\nGATE: PASS | FAIL + specific unmet boxes\nFIXES: max 10 lines',
  { label: 'phase-1 gate', phase: 'Gate', effort: 'high' },
)

return { r11, groupB: groupB.filter(Boolean), groupC: groupC.filter(Boolean), r17, groupD: groupD.filter(Boolean), groupE: groupE.filter(Boolean), gate }
