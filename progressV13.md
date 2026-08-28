# SuperTwinV13 — Build Progress

## Phase 0 — Rebrand, prune, substrate
- [x] P0.1 Rebrand to SuperTwinV13 (port 8013, ~/SuperTwinV13, com.supertwin.v13)
- [x] P0.2 Logo + icons
- [x] P0.3 Prune V11 dead middle
- [x] P0.4 Event log v13 + roles envelope
- [x] P0.5 Cursors, dispatch windows, priority lanes (BND green)
- [x] P0.6 WhatsApp adapter rewire + ranges + send gate
- [x] P0.7 Trace store
- [x] P0.8 Browser watcher
- [x] P0.9 Golden eval harness (live-call)
- [x] Phase 0 DMG: releases/SuperTwinV13_Phase0_13.0.1.dmg (724 MB, built 2026-08-28)

## Phase 1 — Understanding lane (propose-only)
- [x] P1.1 World model schema (0101_world_model)
- [x] P1.2 Context packer + retrieval
- [x] P1.3 Orient + Critic passes
- [x] P1.4 Extract + Decide passes (P1 scope)
- [x] P1.5 Unsorted, sweep, consolidation T1/T2
- [x] P1.6 Digest pass + categories + priority order
- [x] P1.7 Minimal UI shell (Tauri + React rebuild)
- [x] P1.8 Enrichment rewire
- [x] Phase 1 DMG: releases/SuperTwinV13_Phase1_13.1.1.dmg (724 MB, built 2026-08-28)

## Phase 2 — Screen capture + assist lane
- [x] P2.1 Screen recorder sidecar (screenwatch + screen adapter)
- [x] P2.2 Assist lane
- [x] P2.3 Menu bar app + nudges
- [x] P2.4 Freshness + Library (screen/chats/browser views)
- [x] Phase 2 DMG: releases/SuperTwinV13_Phase2_13.2.1.dmg (built 2026-08-29)

## Phase 3 — Tasks, execution, browser core
- [ ] P3.1–P3.5

## Phase 4 — Full UI + graduation
- [ ] P4.1–P4.3

## Log
- 2026-08-28: Kickoff. Phase 0 orchestration started.
- 2026-08-28: Phase 0 complete (10 agents, all green). Worker 1762 tests pass, go tests pass, BND deterministic suite green, rebrand grep clean. DMG 13.0.1 (724MB) in releases/. Commits 48f9e65..c739875.
- 2026-08-28: Phase 1 workflow launched (P1.1 serial → lanes A–E parallel).
- 2026-08-29: Phase 2 complete. Worker 2162/2162 tests green (vitest); root 29 + 75 scripts tests green, vite build green; `go test ./...` all ok; screenwatch build + 57/57 checks. Evals: AST 9/9 green (hard gates risky_without_token, trigger_gate PASS); P1 regression 50 cases — hard gates (containment ≥95%, over_creation <10%, false_auto_merge=0, idempotency, assignment 100%) green in both full runs; per-case judge variance resolved on retry. Version 13.2.1, BUILT_THROUGH_PHASE=P2. DMG in releases/.
- 2026-08-28: Phase 1 complete. Worker 2073/2073 tests green (139 files), tsc clean. Live golden suite run 4x (r5–r8, ~500 traced calls, claude-local provider + haiku judge): 83 → 89 → 94 → 96 of 100; r8 gate rows all PASS or no-data, zero hard-gate breaches. Version 13.1.1, BUILT_THROUGH_PHASE=P1, /api/health version wired into Settings footer. DMG in releases/.
