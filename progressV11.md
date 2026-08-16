# SuperTwinV11 — Build Progress

**Spec:** `SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md`
**Arch:** `..._ClaimsSpacesTasks_V2.md` · **Evals:** `SuperTwinV11_GoldenEvals_V2.md`
**Branch:** `claude/supertwinv11-implementation-kym09e`

## Status

| Phase | Items | State |
|---|---|---|
| 0 Foundations | 0.1–0.7 | ✅ gate passed |
| 1 Ingest→Sessions | 1.1–1.11 | ✅ gate passed |
| 2 Episodes/Arcs | 2.1–2.7 | ✅ gate passed |
| 3 Claims/Loops/Spaces/Tasks | 3.1–3.10 | ✅ gate passed |
| 4 Hardening | 4.1–4.4 | pending |
| 5 Second source | 5.1–5.4 | pending |

## Log

- **PHASES 2 + 3 GATES PASSED.** Eval **1000/1000 cases · 0 gates breached · 0 pending** · 80/96 gates measured · worker 3052/3052 · root 485/485 · scripts 67/67. Cheat-scan clean (no skips; every gates.ts threshold verbatim vs arch §14.2).
- **Audit round (Phase 2)** — the unreported Phase 2 run was audited item-by-item before gating. Caught and fixed: a tautological `episodes_one_to_one_rate` (denominator was 14 hand-picked positives reading 1.00 by construction → per-observation over all routed sessions), a latent `episode_verdicts` row-shape corruption that would have silently broken never-re-judge, an unfalsifiable wrong-attach gate (now measured off persisted rows, all three violation kinds fire in tests), and the unwired P-EP2 judge seam.
- **1:1 rate** — first honest measurement read 41.2% vs the 60% floor because the J corpus was a coverage matrix, not a traffic sample. Fixed with a representative corpus; now **62.8%**, threshold untouched.
- **Gap-close fan-out** — M(95)/N(75)/Q(30) fixtures authored + `claims`/`loops`/`tasks` executors driving real product code over temp SQLite; spaces cap implemented in product (`applySpacesCap`) and proven on a ~3,000-event corpus; episode engine wired into the scheduler with the aging clock.
- **Still no-data (15 gates)** — need live runtime or real media files (scheduler restart/full-import, enrichment queue incl. bolded `enrich_caption_wrong_image`, corrections-survive). Flagged for Phase 4; the harness refuses to call them pass.
- **PHASE 1 GATE PASSED.** typecheck clean · worker 2060/2060 · root 327/327 · scripts 67/67 = **2,454 tests** · eval **580/580 cases**, 96 gates defined / **47 measured** / **0 breached**.
  - Session F1 100%, determinism 0 drift, explainable 100%. Entity precision 100%, mention linking 100%, edge precision 100%. All streams tiered, 0 orphans on promotion. First claim 18 s (gate 30 s), first triple 34 s (gate 120 s), no stall 60 s (gate 90 s), first-paint calls 1, adjudicator-before-paint 0.
  - **Gap closed.** Those three entity gates now measure real product code (`worker/src/entities/audit.ts`) — silent guesses **0 over 350 audited resolutions**, recall 100% over 27 opportunities, metadata edges 100% over 19 memberships. Gates measured 44 → 47.
  - Root cause was structural: a fixture carries one `assert.gate`, and all 150 G/H/I cases spent theirs on precision/linking/edge-precision, so nothing could feed a second gate. New `Produced.gates` seam folds `GateObservation[]` into each gate's own denominator per-observation; observations from a *failed* case still count, so a broken expectation can't blank a gate back to `no data`.
  - Mutation-verified: forcing the `[ML]` rung on without calibration → silent-guess gate **FAILS at 3**; disabling cross-source binding → recall **51.9% FAIL**; dropping an attendee edge → metadata edges **84.2% FAIL**. Under the first, `entities_precision` only fell to 98.6% and still passed — the silent-guess gate is what caught it.
- **1.1 Registry** — manifest-driven, exactly one adapter. Source leaks fixed: `wa:` → `${source_id}:`, `resetWhatsappData` → `resetSourceData(source_id)`, `app_state` → `source.<id>.*`, routes → `/api/sources/:source_id/*` with the old ones aliased one release, `channels` → `streams`. History sync driven newest-page-first with a descending cohort buffer.
- **1.2 Tiers** — `[CODE]` rules first; only ambiguous channels reach P-TI1, batched ≤10/call, verdict cached against a sample fingerprint so a second pass costs 0 calls. Tier is the scheduler's primary sort key. Mutation-checked: breaking the rules fails 18 cases, so the suite isn't vacuous.
- **1.3–1.4** — salience scaffold built generically (WhatsApp sets `prefilter:none`); enrichment queue never blocks the text path.
- **1.5–1.6** — entity graph with structural `[CODE]` binding; party model, all nine directions enumerated and tested.
- **1.7 Segmenters** — mechanical, zero model calls, one per stream kind, parameters from the manifest not constants. 155 cases (D/E/F) green.
- **1.8–1.9** — cohort scheduler with the two non-blocking lanes and first-paint path; prompt runner + repair loop that re-asks rather than rewriting, so no model output is discarded.
- **1.10–1.11** — P-EP1 + resolution ladder ([CODE]→[ML]→[AGENT]→question queue, `[ML]` disabled without fresh calibration); Entities and Sessions surfaces with the coverage meter.
- **PHASE 0 GATE PASSED.** typecheck clean · worker 1322/1322 · root 252/252 · scripts 67/67 = **1,641 tests** · `npm run eval` offline, 80/80 implemented cases (S 50 + U 15 + V 15), 0 gates breached, 920 fixtures loaded as stubs.
- **0.2 Schema** — `0020_v2_core.sql` + a bundle-safe `.ts` mirror. Every §6 table; **no `spaces` table** — promotion fields live on `arcs`. `claims_active` is a VIEW (latest `stated_at`, `closed_by IS NULL`, id-tiebroken so simultaneous timestamps still yield one row). Migrations 0004/0005/0006 retired the way 0007 was; three things with live readers (`evaluations`, `chat_sessions.grounded` + `chat_messages.citations_json`, `extraction_runs.model`/`role`) moved verbatim into a new `0021_v2_prep`. Next free id is 0022.
- **0.3 Wire codec** — STW-2 in `worker/src/wire/`. Alias resolution by range check returning `{resolved, unresolved}`, never string match; prose re-joined never split; tolerance pipeline fence→heading→emphasis→bullet→pipe→prose. Totality suite (random soups, byte strings, every truncation prefix) never throws; accounting invariant holds.
- **0.4 CLI contract** — bare-instrument defaults, instruction block passed twice (`--append-system-prompt` + stdin head), thinking budget ladder with every call at `off`, roles added, `pool.ts` per-resource semaphores with the 40/60 enrichment/understanding split and first-paint override, warm-first serialisation, refusal-regex lane pause that doesn't spend retry budget.
- **0.5 Accounting** — 4-way token split persisted per run; `total_input = cache_read + cache_creation + input_tokens` rendered as parts **and** sum; `billable = input + 1.25·create + 0.1·read + output` is the only quota gate; `cost_usd` verbatim from the CLI, never recomputed.
- **0.6 Eval harness** — offline `--frozen` / `--live`, all 7 assertion modes, per-category rates and per-gate value-vs-threshold. Unmeasured gates report `no data`, never a pass.
- **0.7 Calibration** — unrelated-pair floor per model per use case, `score = (cos − floor)/(1 − floor)`, `arc_topic` strictly above `episode_topic`; missing or stale calibration **disables** the `[ML]` rung rather than guessing a threshold.
- **0.1 Repo prep and deletions — DONE.** `store/`, `brain/writers.ts`, `brain/markdown.ts`, `retrieval/corpus.ts`, `brain-template/` and migrations 0004–0006 deleted. `app_state` + model-selection helpers moved to `worker/src/db/settings.ts` under the same exported names, so no caller changed shape. `brain/root.ts` kept for debug export only; `GET /api/brain/file` behind `settings.debug_export`. All 3 acceptance boxes verified against real command output.
- **CI repair (fan-out workflow)** — triage found item 0.1 had already landed clean; the 2 remaining reds were **pre-existing on `main`**, not branch damage:
  - `media-tools-routes.ts` download race — real ordering defect. The OS `rename()` made the model present on disk before the JS continuation dropped the in-flight entry, so a poll in that window saw `present: true` beside a stale `downloading`. Fixed by retiring the entry before the rename behind a `finalizing` flag (keeps the map entry so a concurrent POST can't start a duplicate fetch), restoring it if rename throws. 10/10 standalone runs green.
  - `cli-args.test.ts` asserted `MAX_THINKING_TOKENS` undefined, but `buildChildEnv` inherits `process.env` by design and this sandbox exports it. Test-isolation fix only; production behaviour untouched.
- **Suites green:** worker 930/930, root 234/234, scripts 67/67 — 1,231 tests, typecheck clean.
- **CI hygiene** — `push` + `pull_request` were double-running every commit; `push` restricted to `main` plus a per-ref concurrency group with `cancel-in-progress`.
- **Setup** — baseline repo at v0.5.3 (Tauri 2 + React + TS worker + Go WhatsApp sidecar). Release tooling (`scripts/release.mjs`) already archives per-version `.dmg` into `releases/` and refuses to overwrite. Deps installed, baseline captured.
- **Note — .dmg builds:** this session runs on Linux; a macOS `.dmg` cannot be produced in-container. Version bumps + `RELEASES.md` manifest are maintained per build, and a macOS CI job produces/uploads the real `.dmg` per version. All prior versions retained.
