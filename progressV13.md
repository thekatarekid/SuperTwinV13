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
- [x] P3.1 Decide full scope (schedules + follow-ups un-deferred, auto-vs-confirm policy in code)
- [x] P3.2 Schedule timer service (timers.ts: fire → enqueue, polling, sleep-wake recovery, double-fire guard)
- [x] P3.3 Executor (Claude Code sessions with tools, result schemas, approval tokens consumed at tool layer)
- [x] P3.4 SuperTwin Browser core (bundled Chromium + CDP harness, challenge-page hard stop, agent-tab isolation)
- [x] P3.5 Approvals UI + task modal live states (approve mints token, whatsapp draft-send end-to-end)
- [x] Phase 3 DMG: releases/SuperTwinV13_Phase3_13.3.1.dmg (built 2026-08-29)

## Phase 4 — Full UI + graduation
- [x] P4.1 Timeline + grounded bar (six states, intent router, USR-04 citation hard gate in code)
- [x] P4.2 Generative result renderer + remaining modals + People view (circles drag = correction)
- [x] P4.3 Consolidation T3 + graduation switch + Settings (eight subtabs, embedding registry)
- [x] P4.4/P4.5 Integration + gates: USR/CIR/FIX/TRC eval executors; correction-parse.v2 + bar-action.v2; bar/correction model seams moved onto the traced JSON runner; privacy-audit script; fresh-install smoke

## Log
- 2026-08-29: Phase 4 gates complete. Worker 2349 tests green (168 files), root 67+80 green, vite build + tsc clean, go test ./... ok. New: USR/CIR/FIX/TRC eval executors (p4.ts), correction-parse.v2 + bar-action.v2, bar/correction seams moved onto the traced JSON runner (the wire PromptRunner rejected their JSON contract on first live contact), executor protocol fix (needs_approval survives a malformed optional result), Critic gate chained into Orient eval ticks, scripts/privacy-audit.mjs (CLEAN). Live evals: USR 6/6, CIR-04, FIX-01/02/03/04/05, TRC-02, CON 8/8, CLM smoke 3/3 green; full 176-fixture suite run + 4 remediation rounds — all 14 hard gates green (over_creation, false_auto_merge, false_auto_close, containment, risky_without_token, guess_rate, false_receiver_assignment, auto_schedule_policy_violation, challenge_ignore, login_automation, trigger_gate, trace_coverage 100%, pass_liveness 100%, idempotency). Known-red (tracked gates only): TIM-04 (model adds an unrequested early-fire buffer; time_accuracy/schedule_math). Pending by design: CIR-01..03 (circle-inference surface is P5+), FIX-06 (React-suite contract), ROL (orient+extract executor unbuilt), BRW-04/06/07 (P5 adapters). Fresh-install smoke on SUPERTWIN_HOME=/tmp: health 13.3.1/P3, mock pairing paired+online, import 9/9 chats done. V11 grep clean. 24h eval spend $17.34/607 runs, zero anonymous traces, zero browsing-lane LLM calls.
- 2026-08-28: Kickoff. Phase 0 orchestration started.
- 2026-08-28: Phase 0 complete (10 agents, all green). Worker 1762 tests pass, go tests pass, BND deterministic suite green, rebrand grep clean. DMG 13.0.1 (724MB) in releases/. Commits 48f9e65..c739875.
- 2026-08-28: Phase 1 workflow launched (P1.1 serial → lanes A–E parallel).
- 2026-08-29: Phase 2 complete. Worker 2162/2162 tests green (vitest); root 29 + 75 scripts tests green, vite build green; `go test ./...` all ok; screenwatch build + 57/57 checks. Evals: AST 9/9 green (hard gates risky_without_token, trigger_gate PASS); P1 regression 50 cases — hard gates (containment ≥95%, over_creation <10%, false_auto_merge=0, idempotency, assignment 100%) green in both full runs; per-case judge variance resolved on retry. Version 13.2.1, BUILT_THROUGH_PHASE=P2. DMG in releases/.
- 2026-08-29: Phase 3 complete. Worker 2284 passed / 2 skipped (161 files, includes new p3.test.ts 13 tests — zero live model calls in unit tests); root npm test 80 passed; npm run build clean; tsc --noEmit clean; `go test ./...` all ok. Live evals (SCH/FUP/TIM/EXE/BRW) run via `npm run eval`. Version 13.3.1, BUILT_THROUGH_PHASE=P3. DMG in releases/.
- 2026-08-28: Phase 1 complete. Worker 2073/2073 tests green (139 files), tsc clean. Live golden suite run 4x (r5–r8, ~500 traced calls, claude-local provider + haiku judge): 83 → 89 → 94 → 96 of 100; r8 gate rows all PASS or no-data, zero hard-gate breaches. Version 13.1.1, BUILT_THROUGH_PHASE=P1, /api/health version wired into Settings footer. DMG in releases/.
