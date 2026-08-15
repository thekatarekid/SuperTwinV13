# SuperTwinV11 — Build Progress

**Spec:** `SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2_Build.md`
**Arch:** `..._ClaimsSpacesTasks_V2.md` · **Evals:** `SuperTwinV11_GoldenEvals_V2.md`
**Branch:** `claude/supertwinv11-implementation-kym09e`

## Status

| Phase | Items | State |
|---|---|---|
| 0 Foundations | 0.1–0.7 | in progress |
| 1 Ingest→Sessions | 1.1–1.11 | pending |
| 2 Episodes/Arcs | 2.1–2.7 | pending |
| 3 Claims/Loops/Spaces/Tasks | 3.1–3.10 | pending |
| 4 Hardening | 4.1–4.4 | pending |
| 5 Second source | 5.1–5.4 | pending |

## Log

- **0.1 Repo prep and deletions — DONE.** `store/`, `brain/writers.ts`, `brain/markdown.ts`, `retrieval/corpus.ts`, `brain-template/` and migrations 0004–0006 deleted. `app_state` + model-selection helpers moved to `worker/src/db/settings.ts` under the same exported names, so no caller changed shape. `brain/root.ts` kept for debug export only; `GET /api/brain/file` behind `settings.debug_export`. All 3 acceptance boxes verified against real command output.
- **CI repair (fan-out workflow)** — triage found item 0.1 had already landed clean; the 2 remaining reds were **pre-existing on `main`**, not branch damage:
  - `media-tools-routes.ts` download race — real ordering defect. The OS `rename()` made the model present on disk before the JS continuation dropped the in-flight entry, so a poll in that window saw `present: true` beside a stale `downloading`. Fixed by retiring the entry before the rename behind a `finalizing` flag (keeps the map entry so a concurrent POST can't start a duplicate fetch), restoring it if rename throws. 10/10 standalone runs green.
  - `cli-args.test.ts` asserted `MAX_THINKING_TOKENS` undefined, but `buildChildEnv` inherits `process.env` by design and this sandbox exports it. Test-isolation fix only; production behaviour untouched.
- **Suites green:** worker 930/930, root 234/234, scripts 67/67 — 1,231 tests, typecheck clean.
- **CI hygiene** — `push` + `pull_request` were double-running every commit; `push` restricted to `main` plus a per-ref concurrency group with `cancel-in-progress`.
- **Setup** — baseline repo at v0.5.3 (Tauri 2 + React + TS worker + Go WhatsApp sidecar). Release tooling (`scripts/release.mjs`) already archives per-version `.dmg` into `releases/` and refuses to overwrite. Deps installed, baseline captured.
- **Note — .dmg builds:** this session runs on Linux; a macOS `.dmg` cannot be produced in-container. Version bumps + `RELEASES.md` manifest are maintained per build, and a macOS CI job produces/uploads the real `.dmg` per version. All prior versions retained.
