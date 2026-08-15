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

- **Setup** — baseline repo at v0.5.3 (Tauri 2 + React + TS worker + Go WhatsApp sidecar). Release tooling (`scripts/release.mjs`) already archives per-version `.dmg` into `releases/` and refuses to overwrite. Deps installed, baseline captured.
- **Note — .dmg builds:** this session runs on Linux; a macOS `.dmg` cannot be produced in-container. Version bumps + `RELEASES.md` manifest are maintained per build, and a macOS CI job produces/uploads the real `.dmg` per version. All prior versions retained.
