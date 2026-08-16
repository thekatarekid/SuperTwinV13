# SuperTwinV11 — Build Progress

**Spec:** `SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md`
**Arch:** `..._ClaimsSpacesTasks_V2.md` · **Evals:** `SuperTwinV11_GoldenEvals_V2.md`
**Branch:** `claude/supertwinv11-implementation-kym09e`

## Status

| Phase | Items | State |
|---|---|---|
| 0 Foundations | 0.1–0.7 | ✅ gate passed |
| 1 Ingest→Sessions | 1.1–1.11 | pending |
| 2 Episodes/Arcs | 2.1–2.7 | pending |
| 3 Claims/Loops/Spaces/Tasks | 3.1–3.10 | pending |
| 4 Hardening | 4.1–4.4 | pending |
| 5 Second source | 5.1–5.4 | pending |

## Log

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
