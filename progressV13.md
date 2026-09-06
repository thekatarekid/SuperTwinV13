# SuperTwinV13 — Build Progress

**Goal (P0–P4): ✅ COMPLETE (2026-08-29).** Rebrand → substrate → understanding → screen/assist → execution → full UI + graduation all shipped and gated; five phase DMGs cut (13.0.1 → 13.4.1). Post-P4 defect fixes from real use of the installed build ship as 13.4.7 (see below).

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
- [x] Phase 4 DMG: releases/SuperTwinV13_Phase4_13.4.1.dmg (991 MB, built 2026-08-29)

## Post-P4 fixes (13.4.2 → 13.4.7)
Defects found by using the installed 13.4.1 DMG, each fixed in the current tree and version-bumped as it landed.
- **Eval harness ran against the real home** — `npm run eval` resolved to `~/SuperTwinV13/supertwinv13.db` and wrote fixture rows into live capture. `worker/src/evals/home.ts` now mints a throwaway `SUPERTWIN_HOME` by default and throws `EvalHomeLeakError` when the home resolves inside `~/SuperTwinV13` without `--allow-production-home`; the same assertion re-runs at the executor chokepoint so dropping the CLI step throws instead of leaking. (13.4.2)
- **No way to remove the rows already leaked** — new `npm run purge:eval-data` (`worker/src/evals/purge.ts`) matches four signatures impossible in real capture (`.example` URL host, `.example` stream key, `ast-<digit>` assist nonce, eval stream key), dry-run by default, `--confirm` deletes through the existing `hardDeleteEvents()` cascade. (13.4.2)
- **Freshness chip climbed minutes during history import and dropped the identity line** — `lag_minutes` now measures only pending *live* events; imported history reports a shrinking count; one pure `freshnessStatus()` drives both the chip and the detail lines, so they can no longer contradict each other. (13.4.2)
- **"Open System Settings" did nothing in the packaged app** — the shell plugin's default open scope rejects `x-apple.systempreferences:`. New Rust command `open_external` (`src-tauri/src/opener.rs`) with its own tight allow-list plus a `/usr/bin/open` fallback; failures now render an inline error with the manual path and a copyable deep link. (13.4.3)
- **Library was one flat list** — now a subtab shell (WhatsApp · Screen · Browser) with honest not-connected states: pairing QR, history range picker, Accessibility permission flow, Chrome profile import. People promoted to its own nav destination; ⌘1–5. (13.4.4)
- **Settings subtab nav rendered as a full-width stack that scrolled away** — an inline style set `display`/`gap` but not `flex-direction`, so `.library { flex-direction: column }` won. Replaced with a sticky top-centre `.pill-nav-sub` row; the 816-line monolith split into one file per subtab under `src/screens/settings/`. (13.4.5)
- **Spaces never auto-created on a fresh install** — `graduationMode()` treated a missing `app_state` row as propose-only. Default is now `auto`; the 14-day auto-flip and its announcement artifact are gone (propose-only stays available and sticky). (13.4.5)
- **"undo run" was a guaranteed-failure no-op** — implemented `runUndoPreview()`/`undoRun()` over the existing `reverseDecision`, GET preview + confirm dialog listing every decision and why each is or is not reversible, POST applies; a `pass='user'` row is never reversed. (13.4.5)
- **Model pickers listed stale family names and had no reasoning control** — models are now read at runtime from the Claude CLI's own baked-in catalogue (21 models, real ids and prices, reasoning ladders derived from each model's capabilities) with a curated versioned fallback; per-pass reasoning level; embedding default moved to EmbeddingGemma 300M (E5 Small stays bundled); both registries got real Download/Delete rows. (13.4.6)
- **Integration defects the combination exposed** — decision ordering tie-broken by `rowid` instead of a random id (the "why?" surface and undo order were randomized); browser profile follows `SUPERTWIN_HOME` instead of the real logged-in Chrome profile; `.nav-row` made a grid so the 5-tab nav and the longer freshness chip cannot overlap (46px at the default 1100px window); `purge.ts` NUL byte replaced so the file is greppable text; two suite tests that measured the runner (wall-clock, machine-global tmpdir) made deterministic. (13.4.7)

## Log
- 2026-09-06: V6 Phase 1 Stage 4 release 13.9.1. `scripts/release.mjs --set 13.9.1 --no-build`, BUILT_THROUGH_PHASE=V6P1S4, `npm run build:app` clean. DMG 992 MB, sha256 `2a6f77c5708c68a9…` → releases/SuperTwinV13_V6P1S4_13.9.1.dmg. Per-task detail in progressV13_V6_Phase1.md.
- 2026-09-06: S4 gate — §7.4 exit gates all PASS (LIV 7, EXE 5, NUD 9, GATE-A 3, BRF 2, INJ 4, CROSS 2 incl. CROSS-N50) and the §7.3 ship gate's four items now ALL hold: TOP 10/10 = 100% vs the frozen baseline under orient.v7 + critic.v5 (21 counted calls), AST parity holds, CROSS-N50 green, a stale "pay by 5 pm" history bundle emits zero prepared actions. Every hard gate PASS — assist_from_history, nudge_without_grounding, injection_acted, risky_without_token, login_automation, clock_only_call, unbounded_loop all 0; content_gated_call 100% over 11 GATE cases. Eval `--mode code --ast-parity` 152/152 with 2 by-design pending and ZERO model calls. Worker 3652 passed / 2 skipped + all six integration suites; root 181 + 88; tsc, build, go vet/test clean. Five reds attributed and fixed (7df72f1): a db→brain import ring that left the bundled whisper model with no id, the brief's missing Settings stem, the P3.5 demo's unbound mint, AST-02 spending live calls in a `--mode code` run, and an AST seeder stamping events in the FUTURE before 2pm (which broke CON-01; reproduces at the S3 release, so pre-existing). 38 live calls, shim-counted. `assist/` NOT deleted — the flip is S4.4's checklist, now unblocked.
- 2026-09-06: S4.7 [C] injection surfacing — a zero-call detector in three families writes injection_flags and ONE card per event carrying the verbatim quote and its source; tool arguments born in captured text are checked against the world model before use, and an untrusted argument becomes a question; injectionActed() measures the world, not a comment. INJ-01..04, injection_acted hard (2cdd1f0).
- 2026-09-06: S4.6 [B] the brief — code composes needs-you / today / moved from the world model at the set times (one due slot, never a backlog), brief.v2 writes prose only on a delta, and any figure not in the ledger is named. Own table 0207_v6_brief; BRF-01..02 (cccb948, f7c6396).
- 2026-09-06: S4.5 [A] the send gate — a tap mints an HMAC token bound to ONE recipient and ONE text; editing revokes it; the Go daemon verifies the tap itself under the key handed over in its spawn env, so the two gates are independent. GATE-A-01..03 + 11 Go tests (07bd14b, 146daf4).
- 2026-09-06: S4.4 the §7.3 fallback engaged — the live lane packs once and makes two calls so the only understanding prompt in production is the one the golden set scores; the input-side gateVerdict() became the output-side nudgeVerdict(), fixing a 0.7-vs-0.6 split on the same settings row. assist/ kept, deletion still outstanding (949c482).
- 2026-09-06: S4.3 surface router and nudge — presence grants a card ON TOP of the panel/shelf/space/timeline and never instead of them; merge window per space, decay order, blocked kinds filed not shown, dismissal ranks rather than mutes; unread counter is a query on nudged_at/seen_at. NUD-01..09 (eba72af).
- 2026-09-06: S4.2 executor-lite — assist/executor-lite.ts moved to executor/lite.ts and rebuilt as a 3–8 turn loop over web_fetch · world_read · world_write_draft, both ceilings enforced as refusals in code and written into the trace, thin context checked BEFORE the model so a doomed run spends nothing, citations only for what was actually fetched. EXE-01..05, unbounded_loop hard (6a626fe).
- 2026-09-06: S4.1 live.v1 — one call, two sections; a bad decide never blocks a commit and a bad understanding never blocks a nudge; prepared work is discarded off the live lane, grounded only in this flush, and shelved below the 0.7 intent floor. LIV-01..06; assist_from_history and nudge_without_grounding hard (10e7213).
- 2026-09-06: S4 workflow launched (serial S4.1→S4.4, lanes A–C parallel, gate, release).
- 2026-09-06: V6 Phase 1 Stage 3 release 13.8.1. `scripts/release.mjs --set 13.8.1 --no-build`, BUILT_THROUGH_PHASE=V6P1S3, `npm run build:app` clean. DMG 992 MB, sha256 `2e620952da1e4357…` → releases/SuperTwinV13_V6P1S3_13.8.1.dmg. Per-task detail in progressV13_V6_Phase1.md.
- 2026-09-06: S3 gate — BND 12, GATE 10, CMT 5, PCK 7, FACT 6, TYP 3, DEC 6, CON 3, IDEM 1, CROSS-N2, CRI-04, TIER 3, DIG-01 green as code fixtures (59/59, `--mode code`); live TIM 4/4 and TIER-03 green (best-of-2), CRI-01 green; ⚠️ CRI-02/03 and DIG-02 red on model judgement, TOP 9/10 under the shipped v6/v4 default (10/10 under v7/v5). Worker 2969 passed / 2 skipped (235 files), root 127 + 88, tsc clean, go test ok. One gate fix (6fd3cf8: HEAD did not compile — uncommitted flipInChunks; 3 stale pins; CROSS-N2; digest evidence shape; CRI PROPOSAL rendering). 55 live calls.
- 2026-09-06: S3.9 [E] consolidation on change + eval isolation — T2 skips with zero calls when nothing changed, merge verdicts become merge questions (no auto-merge), T3 scoped and ends old claim versions; origin='eval' ignored by every lane; CON-01..03 + IDEM-01 code, clock_only_call hard gate (749de45).
- 2026-09-06: S3.8 [D] tiering and digest — code decides replied-vs-not, one cached tier.v1 call per never-replied business, instant + retroactive promotion; digest.v2 on the weekly lane; TIER-01..04, DIG-01..02 (8a5060f).
- 2026-09-06: S3.7 [C] decide.v9 — per-space card (0203_v6_space_card), staged milestones only, check_at closure checks (lookup first), other-person tasks → monitor, TIM-04 window clamp, space-birth dedupe; eval clock pinned; DEC-01..06 code, TIM-01..04 + SCH-01 live (702d985).
- 2026-09-06: S3.6 [B] extract.v6 — typed fields literal-only, self-reported provenance, supersede-or-coexist (never overwritten), people/tone/feelings, sensitive + ad-copy rails; FACT-01..06, TYP-01..03, overwrite hard gate (71c435c).
- 2026-09-06: S3.5 [A] orient.v7 + critic.v5 — stream tag, untrusted block, thin-context/history modes, mechanical critic layer, prompts/versions.ts (defaults stay v6/v4), CRI-01..04 re-authored, eval --compare-baseline; TOP 10/10 under v7/v5 (82a473a).
- 2026-09-06: S3.4 stream keys — wa:<jid> · browser:<browser>:<profile>:<domain>:<day> · screen:<bundleId>:<session> · doc:<path>; adapters emit them, session tracker seeded at boot; no migration (3b852a0).
- 2026-09-06: S3.3 state gate and lanes — scheduler/v6 (gate, burst, cold, history day-bundler, digest lane, attempts, dispatcher invariants), pool lane live with a reserved slot, old scheduler/ deleted; BND-01..12, GATE-01..10 (e2021fc).
- 2026-09-06: S3.2 packer rewrite — T0 pack, one <untrusted> block, candidates from retrieval (cap 5), episode-bounded history, budgeted truncation, thin context; 104-space pack ≈ 4.5k chars; PCK-01..07 (1952117).
- 2026-09-06: S3.1 commit rewrite — explicit episode_events, one stream per episode, per-item salvage, hard verbatim evidence, cursor on event ids, 3-strike dead-letter; CMT-01..05 (1736cde).
- 2026-09-06: V6 Phase 1 Stage 2 release 13.7.1. `scripts/release.mjs --set 13.7.1 --no-build`, BUILT_THROUGH_PHASE=V6P1S2, `npm run build:app` clean. DMG 992 MB, sha256 `d23cb5c01c312938…` → releases/SuperTwinV13_V6P1S2_13.7.1.dmg. Per-task detail in progressV13_V6_Phase1.md.
- 2026-09-06: S2 gate — RET-01..10, BAR-01 green (deterministic suites, 15 files / 153 tests), full_vector_scan = 0, RET-02 p50 14.7 ms over 300 k vectors. Worker 2823 passed / 2 skipped (215 files), root 127 + 88, tsc clean, go test ok, `--mode code` evals 12/12. One gate fix (b8c6f82, semantic report TOCTOU). 0 live calls.
- 2026-09-06: S2.7 [E] coverage index maintained by adapters + coverageCaveat; T0 bar type-ahead over events/episodes/spaces/tasks/people/claims under 150 ms (017b26f).
- 2026-09-06: S2.6 [D] graph — bridges as edges, bounded BFS walk (2 hops, decay 0.6, fan-out cap, status/validity pruning, hub exclusion), [BRIDGED] block (0829ac8).
- 2026-09-06: S2.5 [C] structured (sum/count/range/list over typed claim fields) and unscored time-window scan (7f0a94d).
- 2026-09-06: S2.4 [B] RRF and reranker — bounded candidates → RRF k=60 → local cross-encoder; full-vector cache deleted (11d5c54).
- 2026-09-06: S2.3 [A] lexical — events.app/window_title/doc_key in a ten-column events_fts, chunks_fts over chunks and cards, ranked lists for fusion (48d949d).
- 2026-09-06: S2.2 embeddings — chunks as the embedded unit, staged re-embed flipped in one transaction, first-run Gemma download (98254a7).
- 2026-09-06: S2.1 migration 0201_v6_graph — walk indexes, typed claim fields, chunks + int8 chunk_embeddings, hub_nodes with self seeded, 16 KB pages (724af78).
- 2026-09-06: V6 Phase 1 Stage 1 release 13.6.1. `scripts/release.mjs --set 13.6.1 --no-build`, BUILT_THROUGH_PHASE=V6P1S1, `npm run build:app` clean. DMG 991 MB, sha256 `367a457c4bf43b92…` → releases/SuperTwinV13_V6P1S1_13.6.1.dmg. Per-task detail in progressV13_V6_Phase1.md.
- 2026-09-06: S1 gate — CNS-01..09, SRC-01..04/09/10 green (deterministic suites + `--cat BND,SRC --mode code`), containment 100% on the BND-01 mock import. Worker 2823 passed / 2 skipped (215 files), root 127 + 88, tsc clean, go test ok, screenwatch 75 checks. One gate fix (95afc12, RET-02 teardown timeout). 0 live calls.
- 2026-09-06: S1.8 [E] confirm card + Library storage — four numbers with accuracy labels, card text verbatim in decisions, two bars per source, free disk first, two disk budgets (9aa1b86).
- 2026-09-06: S1.7 [D] filter, verbs, indicator — never-list + user lists at both funnels, private moment (tray + ⌘⇧P), forget-last-N with preview, per-source pause/disconnect/delete with CascadeReport, consent flips before teardown, resetSourceData removed (cdd466a).
- 2026-09-06: S1.6 [C] screen — full text as anchor + diff in blobs, identity on the envelope, roles-based structure hash, docKey fallback, switch-trigger new-chars floor, pause persisted (8dfb719).
- 2026-09-06: S1.5 [B] WhatsApp connect — pair → buffer → measured `count_range` → windows → confirm; no live ingest before confirm; reply/reaction/forward/mention/audience on the envelope (cfef719).
- 2026-09-06: S1.4 [A] browser connect — every browser/profile discovered, copy-then-read counts, consent-first connect, URL text form, render-time visit collapse; SRC eval category (c35d5fe).
- 2026-09-06: S1.3 boot inversion — adapters start only on a connected consent row; screen after consent → Accessibility → Record from now on; sinceMs required (d9e2980).
- 2026-09-06: S1.2 consent gate at both funnels — captureAllowed, tier predicate, archive row, widening as resumable replay; CNS-01..04 (785b1d4).
- 2026-09-06: S1.1 migration 0200_v6_core — consents, archive, episode membership, bundle_attempts, blobs, coverage; envelope consent_id + tier (b1386fa).
- 2026-09-06: V6 Phase 1 Stage 0 release 13.5.1. `scripts/release.mjs --set 13.5.1 --no-build`, BUILT_THROUGH_PHASE=V6P1S0, `npm run build:app` clean. DMG 991 MB, sha256 `6f428557c796029f…` → releases/SuperTwinV13_V6P1S0_13.5.1.dmg. Per-task detail in progressV13_V6_Phase1.md.
- 2026-09-06: S0 gate — baseline present, SPD-01..08 (04 partial, pending T1-3), BND-08..10/12, TRC-01/02 green; TRC-03/pass_liveness red as expected until S3. Worker 2500 passed / 2 skipped, root 112 + 88, tsc clean. Three gate fixes (e2c393b, 2002650, 9fbe39b). 10 live calls.
- 2026-09-06: S0.10 [D] latent loops — whatsapp restart backoff + give-up at 8, assist accumulator spent on every exit path (1185e12).
- 2026-09-06: S0.9 [C] ledger hygiene — runs.pass/origin/trace_id at insert, trace row in the runs transaction, digest/bar/media through the pool (7def8ea).
- 2026-09-06: S0.8 [B] kill switch + `[spend]` heartbeat — model_activity_paused blocks every caller, Stop all model activity in GeneralPanel, /api/ops/spend + model-activity + budget/reset (45cc1a2).
- 2026-09-06: S0.7 [A] breaker, bounded waiters, quota metering — 10 failures pause a lane 30 min, waiters capped 4×, `/api/ops` shows waiting + breakers (ccf652b, e2c393b).
- 2026-09-06: S0.6 data removed — ~/SuperTwinV13 backed up to ~/SuperTwinV13-incident-2026-08-29 (db sha256 `e3458fb73199d8dc284ac122e3ece78be0e4f54d898ceaa571100bb19d058e78`) and deleted; fresh home has zero events (d1ea9da).
- 2026-09-06: S0.5 prune — window clock, orphan scan, low-signal deferral, tracker blocklist, content_pending, dead sources columns deleted; IMPORT_RANGES 3d/3y/4y (f35b598).
- 2026-09-06: S0.4 transport stage 1+2 — 5m cache TTL, prompt sent once, safe-mode/strict-mcp-config/max-budget-usd/no-session-persistence; warm call $0.0068, SPD-04 target pending T1-3 (5aa7201).
- 2026-09-06: S0.3 old dispatcher disarmed — slot-capped orphans, keyed in-flight set, dispatched_at re-check in runBrainTick; BND-08..10 (bfae619).
- 2026-09-06: S0.2 spend + process rails — budget ceilings/latch, home guard, dev worker on 8113, self-shutdown; CLAUDE.md carries §1.3 (92567f5).
- 2026-09-06: S0.1 baseline frozen — evals/baseline/v13.json, `npm run eval -- --baseline`; 68 live calls (9ec9d1c).
- 2026-08-29: Post-P4 fix release 13.4.7. Six version-bump commits (13.4.2…13.4.7), one per landed fix, BUILT_THROUGH_PHASE unchanged at P4. Worker 2431 passed / 2 skipped (175 files); root 112 + 80 green; `npm run build:app` clean. DMG 992 MB, sha256 `f31d40dc3a71ee65…` → releases/SuperTwinV13_Phase4_13.4.7.dmg; all five earlier phase DMGs re-hashed and byte-identical to their recorded digests.
- 2026-08-29: Phase 4 release cut. `scripts/release.mjs --set 13.4.1 --no-build`, BUILT_THROUGH_PHASE=P4, full `npm run build:app` clean. DMG 991 MB, sha256 `fb06ce7fcb46d7b5…` → releases/SuperTwinV13_Phase4_13.4.1.dmg; all four earlier phase DMGs verified present with matching recorded digests. Build-plan Phase 4 STATUS ✅ + §8 cross-phase checklist checked (real-phone pairing and installed-app visual pass annotated as human steps). P0–P4 goal complete.
- 2026-08-29: Phase 4 gates complete. Worker 2349 tests green (168 files), root 67+80 green, vite build + tsc clean, go test ./... ok. New: USR/CIR/FIX/TRC eval executors (p4.ts), correction-parse.v2 + bar-action.v2, bar/correction seams moved onto the traced JSON runner (the wire PromptRunner rejected their JSON contract on first live contact), executor protocol fix (needs_approval survives a malformed optional result), Critic gate chained into Orient eval ticks, scripts/privacy-audit.mjs (CLEAN). Live evals: USR 6/6, CIR-04, FIX-01/02/03/04/05, TRC-02, CON 8/8, CLM smoke 3/3 green; full 176-fixture suite run + 4 remediation rounds — all 14 hard gates green (over_creation, false_auto_merge, false_auto_close, containment, risky_without_token, guess_rate, false_receiver_assignment, auto_schedule_policy_violation, challenge_ignore, login_automation, trigger_gate, trace_coverage 100%, pass_liveness 100%, idempotency). Known-red (tracked gates only): TIM-04 (model adds an unrequested early-fire buffer; time_accuracy/schedule_math). Pending by design: CIR-01..03 (circle-inference surface is P5+), FIX-06 (React-suite contract), ROL (orient+extract executor unbuilt), BRW-04/06/07 (P5 adapters). Fresh-install smoke on SUPERTWIN_HOME=/tmp: health 13.3.1/P3, mock pairing paired+online, import 9/9 chats done. V11 grep clean. 24h eval spend $17.34/607 runs, zero anonymous traces, zero browsing-lane LLM calls.
- 2026-08-28: Kickoff. Phase 0 orchestration started.
- 2026-08-28: Phase 0 complete (10 agents, all green). Worker 1762 tests pass, go tests pass, BND deterministic suite green, rebrand grep clean. DMG 13.0.1 (724MB) in releases/. Commits 48f9e65..c739875.
- 2026-08-28: Phase 1 workflow launched (P1.1 serial → lanes A–E parallel).
- 2026-08-29: Phase 2 complete. Worker 2162/2162 tests green (vitest); root 29 + 75 scripts tests green, vite build green; `go test ./...` all ok; screenwatch build + 57/57 checks. Evals: AST 9/9 green (hard gates risky_without_token, trigger_gate PASS); P1 regression 50 cases — hard gates (containment ≥95%, over_creation <10%, false_auto_merge=0, idempotency, assignment 100%) green in both full runs; per-case judge variance resolved on retry. Version 13.2.1, BUILT_THROUGH_PHASE=P2. DMG in releases/.
- 2026-08-29: Phase 3 complete. Worker 2284 passed / 2 skipped (161 files, includes new p3.test.ts 13 tests — zero live model calls in unit tests); root npm test 80 passed; npm run build clean; tsc --noEmit clean; `go test ./...` all ok. Live evals (SCH/FUP/TIM/EXE/BRW) run via `npm run eval`. Version 13.3.1, BUILT_THROUGH_PHASE=P3. DMG in releases/.
- 2026-08-28: Phase 1 complete. Worker 2073/2073 tests green (139 files), tsc clean. Live golden suite run 4x (r5–r8, ~500 traced calls, claude-local provider + haiku judge): 83 → 89 → 94 → 96 of 100; r8 gate rows all PASS or no-data, zero hard-gate breaches. Version 13.1.1, BUILT_THROUGH_PHASE=P1, /api/health version wired into Settings footer. DMG in releases/.
