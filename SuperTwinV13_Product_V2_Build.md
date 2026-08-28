# SuperTwinV13 — Build Plan (V2)
Execution plan for Claude Code (`/goal`, opus). Builds SuperTwinV13 on top of a copy of the SuperTwinV11 repo placed in this folder.
## 0. Context and inputs
1. **REPO** = the copied SuperTwinV11 repo root inside `/Users/adityakatare/Documents/SuperTwinV13/` (the folder containing `src-tauri/`, `worker/`, `sources/`, `src/`). All paths below are relative to REPO.
  
2. **Spec** = `SuperTwinV13_Product_V2.md` (same folder). It defines every schema, prompt, policy, and UI in detail. When this plan says "per spec §N", read that section before coding. Evals = `SuperTwinV13_GoldenEvals_V1.md` (pipeline categories; ignore its SEG section) + `SuperTwinV13_GoldenEvals_V2.md` (V13 categories; its BND section replaces SEG).
  
3. **Logo** = `/Users/adityakatare/Documents/SuperTwinV13/Twinning Logo.png`.
  
4. **Fresh start**: no data migration from SuperTwinV11. New app name, ids, dirs, DB. Test with fresh installs only.
  
5. V11 stack (unchanged): Tauri 2 shell (Rust) + Node/TS worker (better-sqlite3, esbuild bundle) + React/Vite UI + Go whatsmeow daemon + local `claude` CLI as the only LLM engine.
  
## 1. Global conventions
1. **Task IDs**: `P<phase>.<n>`. `[LANE X]` marks parallel groups — tasks in different lanes of the same phase can run as parallel subagents. Tasks in one lane run in order. A phase's `SERIAL` tasks run before its lanes start.
  
2. **Definition of done, every task**: code + unit tests green (`npm test` in worker; `go test ./...` in `sources/whatsapp-go`) + no dead code (every new module has a production caller — add a liveness registration) + a trace row for every model call.
  
3. **Prompts** live in `worker/src/prompts/` as versioned modules (`orient.v1.ts` …). Changing a prompt = new version + eval run.
  
4. **Writes**: all DB writes via the single-writer path; every derived-object change is a decision row; mutations reversible.
  
5. **UI**: rebuild `src/` from scratch per spec §14. Design system first, screens after. No Tailwind; hand-written CSS tokens (V11 pattern) with liquid-glass materials (`backdrop-filter`, vibrancy via Tauri window effects).
  
6. **Commit style**: one task = one commit minimum, message `P1.4: packer — candidate retrieval`.
  
7. **Model defaults**: every LLM/agent step defaults to **Haiku** (spec §14.9). Per-step recommendations (spec §8 headings) are surfaced in Settings, never silently applied. Model selection plumbing = V11 per-role settings system, extended to the V13 step list.
  
8. **Versioning (every build)**: version scheme `13.<phase>.<build>` set in `tauri.conf.json` + `package.json` at release time, plus a `BUILT_THROUGH_PHASE` constant (e.g. `P2`). Shown in: About window, Settings › General footer, menu-bar panel footer (small, e.g. `v13.2.4 · built through P2`), and the DMG filename (`SuperTwinV13-13.2.4-P2.dmg`). CI asserts the constant matches the phase gates that are green.
  

* * *
## 2. Phase 0 — Rebrand, prune, substrate
> **STATUS: ✅ COMPLETE (2026-08-28).** All tasks P0.1–P0.9 done + verified (worker 1762 tests green, `go test ./...` green, BND deterministic suite green, rebrand grep clean). Release 13.0.1 → `releases/SuperTwinV13_Phase0_13.0.1.dmg`. Commits `48f9e65..c739875`.

Goal: a clean V13 skeleton that captures WhatsApp + browser into the new event log with traces. Exit: fresh install runs; ≥95% backfill containment on mock; replayable log.
### SERIAL (do first, in order)
**P0.1 — Rebrand everything to SuperTwinV13**

- Where: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json` (root + worker), `worker/src/**` constants, `sources/whatsapp-go` flags/docs, scripts, CI.
  
- Changes: product name `SuperTwinV13` · bundle identifier `com.supertwin.v13` · window titles · data home `~/SuperTwinV13/` (env override `SUPERTWIN_HOME` kept) · DB file `supertwinv13.db` · subdirs `media/ logs/ browser-profile/ traces/` · log file `worker.log` under the new home · worker port **8013** (avoid collision with a running V11) · UI `src/lib/config.ts` base URL to 8013 · session/db paths passed to whatsapp-go point into `~/SuperTwinV13/`.
  
- Grep-verify: zero remaining case-insensitive `supertwinv11`/`SuperTwinV11`/`com.supertwin.v11`/`8011` outside git history and docs.
  
- Tests: boot smoke test asserts home dir, DB name, port. Acceptance: fresh `npm run build:app` produces a `SuperTwinV13.app` that creates only `~/SuperTwinV13/`.
  

**P0.2 — Logo and icons**

- Run `npx tauri icon "/Users/adityakatare/Documents/SuperTwinV13/Twinning Logo.png"` → replaces `src-tauri/icons/*`. Use the logo in UI header + menu bar template icon (monochrome derivative) + DMG.
  
- Acceptance: built app shows the new icon in Dock, menu bar, and About.
  

**P0.3 — Prune V11 dead middle**

- Delete: `src/` (all 12 tabs — UI rebuilt in P1/P4), `worker/src/sessions/`, `worker/src/episodes/`, `worker/src/arcs/`, the 11 prompt files in `worker/src/prompts/` (keep `runner.ts`, `legend.ts` pattern, repair/quarantine), embedding-calibration (`worker/src/retrieval/calibration*`, `db/calib.ts`), `evals/fixtures/` + frozen-replay gating (keep runner/report/gates plumbing), `brain-template/`, `releases/`, `worker/dist/`, docs museum (`docs/` old specs).
  
- Fix compile: remove imports/routes referencing deleted modules; server boots with a minimal `/api/health`.
  
- Acceptance: `npm test` green on the reduced tree; bundle contains no deleted modules.
  
### Lanes (parallel after P0.3)
**P0.4 [LANE A] — Event log v13 + roles envelope**

- Where: new migration `worker/src/db/migrations/0100_v13_core`; keep V11's connection/migration framework.
  
- Tables: `events` (envelope per spec §6.1 incl. `roles` JSON, `age_band`, `origin`), `streams` (key, source, type, tier, category, engagement stats, cursor, watermark), `decisions`, `corrections`, `quarantine` (kept), `runs` (kept, extended), `traces` (P0.7). FTS5 over `events.text` with sync triggers (port V11's 0001 pattern).
  
- Single-writer module + idempotent append by `content_hash`.
  
- Tests: envelope round-trip, idempotent double-insert, FTS query. Acceptance: 10k-event synthetic append <5s; replay rebuild identical.
  

**P0.5 [LANE A] — Cursors, dispatch windows, priority lanes**

- Where: rewrite `worker/src/scheduler/` drivers (keep cohorts/queue/lanes structure where useful).
  
- Per spec §6.2: per-stream cursor; 5-min live window (config); delta bundle = events since cursor; low-signal deferral (floor + 45–60 min max-defer); max-size split with predecessor summary; priority lanes live > backfill A>B>C>D; live preemption; orphan scan re-queues any event older than N windows with no processed mark.
  
- Tests: golden BND-01…06 as unit tests (deterministic — no model). Acceptance: BND suite green.
  

**P0.6 [LANE B] — WhatsApp adapter rewire + ranges + send gate**

- Where: `worker/src/adapters/whatsapp/`, `sources/whatsapp-go/`.
  
- Adapter writes v13 envelopes (roles: sender, audience from group roster, @mentions structural, reply markers). Extend `internal/rangefilter` + protocol enum: `2y 3y 4y 5y` (durations) — `all` exists. Backfill wave watermark: advance only on daemon's completion signal.
  
- Go: add `send_message` command that requires `approval_token`; without a valid unused token → error, no send path. Token table + mint/consume in worker (UI mints in P3). Keep `--mock` working incl. a send-refusal fixture.
  
- Tests: Go tests for rangefilter ranges + send refusal; adapter unit tests for envelope/roles; mock e2e ingest. Acceptance: `printf import 90d | whatsapp-go --mock` lands ≥95% events into streams/log; send without token fails hard.
  

**P0.7 [LANE C] — Trace store**

- Where: extend `worker/src/providers/claude-local/` call path + new `worker/src/traces/`.
  
- Every CLI invocation writes a trace: `{run_id, pass, model, prompt_version, system_prompt, packed_context, raw_output, parsed_result, repair_count, verdicts, tokens_4way, cost, latency_ms, caller}`. Files under `~/SuperTwinV13/traces/` (jsonl per day) + index rows in DB. 30-day compression job (hash + sample keeps). No model call may bypass it (wrap at the single spawn site).
  
- Tests: TRC-01 (ghost-call assertion), retention job. Acceptance: any call site without a trace throws in dev.
  

**P0.8 [LANE D] — Browser watcher**

- Where: new `worker/src/adapters/browser/`.
  
- Read Chrome/Safari/Arc history SQLite (copy-then-read to dodge locks), bookmarks file watch. Emit `browser.visit` (url, title, transition, referrer, visit_count) + `browser.bookmark` events; tab-chain stream keys (tab id + referrer + 30-min gap). Per-domain Cat-1/2 heuristics (typed/bookmark/repeat/dwell vs tracker blocklist). Incognito never present in these DBs — nothing to filter.
  
- Page content (spec §4.2.3): frontmost-page text arrives from the AX capture (P2.1, linked ts+URL); fetch-by-reference for uncovered Cat-1 visits + all bookmarks lands with the SuperTwin Browser (P3.4) — mark the events `content_pending` until then so the backlog is fetchable later.
  
- Tests: fixture DBs → expected events/chains; CAT-02 as unit test. Acceptance: a real profile imports without error; chains look sane in log dump.
  

**P0.9 [LANE E] — Golden eval harness (live-call)**

- Where: rework `worker/src/evals/` (keep runner/report/gate plumbing; delete frozen-response execution).
  
- Fixture schema per GoldenEvals V2 header; executors call the real passes (which call the real CLI); LLM-judge scorer (haiku) + code assertions for `wrong[]`; gates from both eval docs; `npm run eval -- --cat ROL,BND`; liveness check job (TRC-03).
  
- Materialize fixtures: V1 doc categories (skip SEG) + V2 doc categories, as JSON under `evals/v13/`.
  
- Tests: harness self-test with a stub pass. Acceptance: `npm run eval -- --cat BND` runs green against P0.5.
  

* * *
## 3. Phase 1 — Understanding lane (propose-only)
Goal: WhatsApp + browser flow through the five passes into spaces/episodes/claims with review queue and minimal UI. Exit gates (hard): assignment ≥90%, over_creation <10%, false merges/closes = 0, containment ≥95% on the golden suite. **Do not start P2 until green.**
### SERIAL
**P1.1 — World model schema**

- Migration `0101_world_model`: `spaces` (label, life_area, goal, types, status, exemplars), `chapters`, `episodes` (stream-scoped, state, summary, chain links), `episode_events` (message ranges), `tasks` (per spec §11.1 incl. schedule JSON), `claims` (+ `claim_versions`, tone_profiles) — port/adapt V11 `claims/` tables, `people` view over entities + circles + provisional flag, `unsorted`, `second_look`, `space_index` (FTS + embedding + entity + bridge keys).
  
- Keep V11 `entities/` (add `circle`, provisional entities), `bridges/` (wire extraction of url/phone/email/order-id into event ingest), `tiers/`.
  
- Tests: schema round-trips; bridge extraction unit tests.
  
### Lanes (parallel after P1.1)
**P1.2 [LANE A] — Context packer + retrieval**

- Where: new `worker/src/packer/`; reuse `worker/src/retrieval/` (FTS + local embeddings; retrieve-then-judge — no bare cosine thresholds). Embeddings: V11's e5 carries through P1–P3; the registry default becomes **EmbeddingGemma 300M** at P4.3, swapped via background re-embed (spec §14.9) — build the retrieval interface model-agnostic now.
  
- Per spec §6.4: thread history (elastic ~20–40, reply-quote always fetched), open+relevant episodes, candidate spaces top 3–5 with exemplars (4 lanes: FTS, embedding, entity overlap, bridge match; recency boost), recent-context block, roster block (identities, circles, nickname notes, engagement stats, tier), cross-source related episodes, band/mode policy. Byte-identical preamble per pass (cache-friendly; port V11 `legend.ts` invariant).
  
- Content economy (spec §4.5): digest-line generation at ingest (code + cached haiku call per unique content-hash) for AX/page-text events; packer serves L0 digest / L1 distilled / L2 full per consumer rules; L2 requests logged; L1/L2 escalation-rate metric in run ledger.
  
- Tests: packer snapshot tests per scenario; prompt-size cap test; digest-cache hit test (same content-hash = zero new calls).
  

**P1.3 [LANE A] — Orient + Critic passes**

- Where: `worker/src/prompts/orient.v1.ts`, `critic.v1.ts`, pass runners in `worker/src/brain/`.
  
- Prompts per spec §8.1–8.2 (full text there). Map step: one Orient call per bundle, parallel via provider pool; Critic grades the tick's writes; commit via single writer; `flag_overlap` enqueues T2 review; conf 0.60–0.75 attaches → `second_look`. Propose-only mode enforced in code (proposals never activate without approval).
  
- Tests + evals: TOP, ASN, CRE, CRI categories. Acceptance: those categories ≥ their gates.
  

**P1.4 [LANE B] — Extract + Decide passes (P1 scope)**

- Prompts per spec §8.3–8.4. P1 scope of Decide: chapters, tasks, closures, plan (schedules/follow-ups arrive in P3 — emit but hold as `deferred`). Decide work queue table (one pending row per space, merge-in). Reduce step: group committed episodes by space; parallel across spaces, serial per space.
  
- Tests + evals: CLM, TSK, CLS, CHP categories.
  

**P1.5 [LANE B] — Unsorted, sweep, consolidation T1/T2**

- Sweep on space activation (retrieval over unsorted + log → Orient-style review call → attach). T2 job: flag-triggered + hourly rolling merge/split/dormancy over touched spaces + second-look processing + unsorted periodic review. All mutations reversible.
  
- Tests + evals: CON category + ASN-09/12; idempotency (CON-08, CHP-06).
  

**P1.6 [LANE C] — Digest pass + categories + priority order**

- `digest.v1.ts` per spec §8.5; Cat identification (chat = code; browser per P0.8; tier calls cached); promotion on engagement (retroactive full processing); processing order per spec §5.2 (day-major, source order, engagement order, Cat-1-before-Cat-2 slot rule incl. enrichment ordering); first-experience slice (recent 3–7 days of top-engagement chats first).
  
- Tests + evals: CAT category, AGE category. Acceptance: CAT-05 slot-leak test green.
  

**P1.7 [LANE D] — Minimal UI shell (Tauri + React rebuild)**

- New `src/`: design tokens (glass materials, type scale, spacing), window chrome (translucent, vibrancy), top-center pill nav (Home/Timeline/Library/Settings stubs), Home with Today + Spaces + Review queue + Recent understanding sections (spec §14.2), modal system with Task/Space/Proposal modals (spec §14.6), feedback system (drag-move, ···: Edit/Remove/Tell the twin with context-locked bar call + contextual chips, corrections pipeline → eval drafts) (spec §14.4), "why?" → decision → trace drill-down.
  
- Global hotkey double-tap right-⌘ (Tauri global shortcut + tap-interval detection in Rust), Esc dismiss.
  
- Tests: component tests (vitest+jsdom); FIX-01/02/05/06 evals. Acceptance: approve a proposed space end-to-end from the review queue; every object opens a modal with evidence + why.
  

**P1.8 [LANE E] — Enrichment rewire**

- Point V11 `worker/src/media/` at v13 events/bundles: pending counts per bundle; on zero → one scoped re-understand job; placeholder→unsorted re-dispatch rule. Enrichment priority follows §5.2 ordering.
  
- Tests: TOP-05, enrichment-completion re-run unit test.
  

* * *
## 4. Phase 2 — Screen capture + assist lane
Goal: screen becomes a source; the twin becomes proactive. Exit: P1 gates still green with screen on; ≤10-min understanding freshness; AST evals green.

**P2.1 [LANE A] — Screen recorder sidecar**

- New `sources/screenwatch/` — Swift CLI (mirrors whatsapp-go pattern: NDJSON on stdout, commands on stdin, `--mock` fixture mode). Uses AX API (`AXUIElement`) + NSWorkspace notifications: capture distilled AX text of frontmost window on app/window/tab switch, typing-pause, scroll-stop, 60s heartbeat; idle short-circuit (CGEventSource); tree-hash + content-hash dedup; `new_chars` diffs; stream key `bundleId¦docKey`.
  
- Privacy in the sidecar: private-window detection (Safari/Chrome/Arc AX attributes + window titles) → drop; password-manager bundle-id blocklist → drop; per-app pause via stdin command.
  
- Requires Accessibility permission: onboarding screen with deep-link to System Settings.
  
- Node adapter `worker/src/adapters/screen/` supervises it (reuse whatsapp adapter supervisor pattern), emits `screen.snapshot` events; reference enrichment: links/files seen in tree → fetch/scrape via lane E.
  
- Tests: Swift unit tests + mock fixtures; SEG-06-equivalent multitask keying test; privacy-drop tests (hard). Acceptance: 1h of real use → sane streams, no incognito/password content in log (manual audit script).
  

**P2.2 [LANE B] — Assist lane**

- New `worker/src/assist/`: activity trigger (new live events / screen switch) → **trigger gate in code (spec §10.1)**: per-topic novelty accumulator (distinct cross-source events joined by bridges/entities/episode; threshold `N` per category from settings; ≥2 new-content) + cooldowns + suppression + quiet hours → assist evaluator call (spec §10 prompt; intent_confidence threshold) → if actionable: executor-lite (bounded tool loop: packer reads, web fetch, drafts; NO risky tools wired) → artifact row + nudge. Watcher input = event-log tail (AX events + browser events + chat tail, L1/L0 per §4.5) — no separate capture path.
  
- Artifacts durable: `artifacts` table (status new/seen/dismissed/graduated/expired); graded reconcile signals from UI telemetry; graduation path through Critic gate.
  
- Tests + evals: AST-01…09 (AST-04 risky-leak asserted in code: executor-lite has no payment/send tools at all; AST-09 cross-source novelty count code-asserted).
  

**P2.3 [LANE B] — Menu bar app + nudges**

- Tauri tray (template icon states ◉◔●⏸) + 360px glass panel per spec §14.7: Needs-you (approvals/questions with safe inline answers), Prepared list holding assist artifacts AND executor results with latest-unseen nudge pinned + `●` dot (+ older drawer), Today strip, mini ask-bar, capture quick-pause. Nudge window: transient top-right card per spec anatomy, auto-minimize, one at a time. In-app nudge surfaces per spec §14.7.8 (Home shelf pulse, space-modal banner, grounded-bar idle chip — one artifact, one status).
  
- Tests: panel component tests; trigger-gate integration test (novelty threshold + suppression, clock-mocked). Acceptance: dismiss → Prepared → reopen → graduation flow works; identical re-captured content never fires a nudge.
  

**P2.4 [LANE C] — Freshness + Library (screen/chats/browser views)**

- "Knows you: X → Y" per-source computation (understood watermark vs capture range) + header chip; Library screens: Chats (streams, ranges, tier badges, pause), Browser (chains, dwell, bookmarks, filing chips), Screen (day strip of session cards, privacy controls incl. honest cascading delete).
  
- Tests: watermark math unit tests; delete-cascade test (hard: no orphaned derived rows referencing deleted events).
  

* * *
## 5. Phase 3 — Tasks, execution, browser core
Goal: the twin acts. Exit: ≥80% surfaced tasks are real (self-graded suite + user), zero unapproved risky steps, EXE/SCH/FUP evals green.

**P3.1 [LANE A] — Decide full scope**

- Un-defer schedules + follow-ups (spec §8.4 items 3/5, §11.2–11.3): schedule candidates with computed fire times, auto-vs-confirm policy in code (auto only if auto-class AND high confidence AND time-bound — enforced by a code check on the pass output, not just the prompt), next-step pass on both closure triggers.
  
- Tests + evals: SCH-01…07, FUP-01…05, TIM-01…04.
  

**P3.2 [LANE A] — Schedule timer service**

- `worker/src/scheduler/timers.ts`: fire schedules → enqueue executor tasks; polling patterns (interval/until/cap); sleep-wake recovery (late-execute if valid, skip+note if expired); double-fire guard.
  
- Tests: SCH-08 (clock-mocked).
  

**P3.3 [LANE B] — Executor**

- `worker/src/executor/`: one Claude Code session per task via the CLI adapter WITH tools this time (allowedTools: browser MCP set + world-model read + drafts + files; max-turns budget). Protocol per spec §11.4 prompt: criteria first, verify each cycle, attempt log, replan, best-partial on budget. Result schemas (comparison_table, itinerary, draft_preview, approval_card, research_brief, checklist, receipt) validated on emit.
  
- Approval tokens: mint on modal approve (UI → worker), single-use, consumed by gated actions (whatsapp send P0.6; browser payment steps refuse without token by tool-layer check).
  
- Tests + evals: EXE-01…06 (EXE-04 risky-leak is a code assertion on tool invocations), USR-05.
  

**P3.4 [LANE C] — SuperTwin Browser core**

- New `worker/src/browser/`: launch bundled Chromium (config: path to a downloaded Chrome-for-Testing build staged like ffmpeg in `scripts/stage-media-tools.mjs`) headed-but-hidden, persistent profile `~/SuperTwinV13/browser-profile/`, CDP over pipe; ~1k-line harness (targets, distilled-AX snapshot with stable ids, click/type, network capture); expose as MCP tools to executor sessions.
  
- "Connect your accounts" onboarding: visible login tabs + Chromium's built-in import-from-Chrome flow; session health checks.
  
- Safety in code: challenge-page detector → hard stop + notify + pause source; pacing module (jitter, active-hours, per-site serial); agent-tab isolation (agent tabs tagged, never touch untagged); kill-switch in menu bar; login never automated.
  
- Tests + evals: BRW-01/02/03/05/08 (code-asserted with a local test site simulating challenge pages).
  

**P3.5 [LANE D] — Approvals UI + task modal live states**

- Approval modal per spec §14.6 (mints token on approve), task modal executing states + live generative result region, question cards, WhatsApp draft-send flow end-to-end.
  
- Acceptance: full demo path — chat message → task → executor → approval modal → token → whatsapp mock send.
  

* * *
## 6. Phase 4 — Full UI + graduation
Goal: the product feels finished. Exit: daily-driver quality; auto-create graduated after 2 clean weeks.

**P4.1 [LANE A] — Timeline + grounded bar**

- Timeline view (event log rendered, day scrubber, filters, filing chips → modals). Grounded bar per spec §14.8 (six states, intent router, no modes): search (retrieval), grounded chat (citations → USR-04 hard gate), actions (create space/task per spec — sweep + plan on user-created; ambiguity asks once; all actions through normal task/risk gates), context-locked corrections, history (⌘↑, threads reopenable), inline webview cards via SuperTwin Browser.
  
- Evals: USR-01…06.
  

**P4.2 [LANE B] — Generative result renderer + remaining modals**

- Component library + `{result_type,data}` renderer (model composes, never styles); Person/Claim/Prepared-artifact modals; People view with circles (drag between circles = correction).
  
- Evals: CIR-04, FIX-03; visual QA checklist.
  

**P4.3 [LANE C] — Consolidation T3 + graduation + Settings**

- T3 opportunistic deep pass (idle+power): cross-space linking, claim compression (evidence preserved), embedding/summary refresh, ephemeral expiry, eval regression run. Graduation switch: auto-create spaces when gates hold 14 consecutive days (tracked metric, auto-flips with announcement, user can revert).
  
- Settings per spec §14.9 — eight subtabs: **General** (hotkeys, login launch, notifications toggle, brief times) · **Capture & Privacy** (toggles, blocklists, page-text rules) · **Sources** · **Intelligence** (model picker per step: V11 per-role system extended to the V13 step list, **default Haiku everywhere, recommendation shown per step**, per-step on/off toggles, embedding-model registry with default **EmbeddingGemma 300M** + background re-embed on swap, per-step cost, eval-gated changes) · **Enrichment** (port V11 media settings: whisper model picker default `large-v3-turbo-q5_0`, transcription toggles, describe live/backlog, photos/stickers, video thumb + frame sampling interval/max/height, business-chat media, link fetch, rate/concurrency) · **Assist** (novelty thresholds per category, new-content minimum, cooldowns, quiet hours, suppressed-context list clearable, popup toggle) · **Runs** = **Runs & Traces viewer** (filter by pass/space/date; open run → exact system prompt, packed context, raw output; diff two runs; cost dashboards; quarantine browser; run undo — port V11 OpsTab ideas) · **Data** (storage, export, honest delete, retention).
  
- Tests: TRC-02 chain test; CON category re-run; graduation flip integration test.
  

* * *
## 7. Phase 5 — Source expansion
Order fixed by risk: each source = one adapter task; all follow the same shape (backfill route + steady-state route + events into log). Parallel: P5.1 with P5.2; P5.3+ sequential after browser hardening proves out on X.

**P5.1 [LANE A] — Claude Code JSONL adapter** — file-watch `~/.claude/projects/*.jsonl`; backfill parse + live tail; malformed lines quarantined. Zero network. Evals: BRW-07. **P5.2 [LANE B] — YouTube** — Takeout import (watch-history.json parser + guided flow + 2-month re-export reminder); Data API v3 OAuth (playlists/likes/subs poll); agent-browser `/feed/history` read 1–2x/day via domain skill. **P5.3 [LANE B] — X** — archive import; bookmarks via agent-browser GraphQL capture (full scroll once, daily stop-at-last-seen diff — BRW-04/06 pattern); profile diff daily. **P5.4 [LANE B] — ChatGPT** — export import (walk the `mapping` tree); own-session `/backend-api/conversations` incremental read 1–2x/day in the SuperTwin Browser. **P5.5 [LANE B] — Gemini** — Takeout "Gemini Apps" JSON import + guided scheduled-export flow. No scraping. **P5.6 [LANE B] — Instagram (last)** — guided "Export your information" import (deep-link + Downloads watch, monthly prompt); optional opt-in gentle `/saved/` read ≤1x/day with explicit risk disclosure. Ships only after X capture has run 2+ weeks challenge-free.

- Each: Library card (connect flow + "Knows you" range), fixtures + adapter tests, pacing/challenge rules inherited from P3.4.
  

* * *
## 8. Cross-phase gates (release checklist)
- [ ] 
  
  Hard gates green (canonical list: spec §18.2): over_creation <10% · false_auto_merge 0 · false_auto_close 0 · containment ≥95% · risky_without_token 0 · guess_rate 0 · false_receiver_assignment 0 · auto_schedule_policy_violation 0 · challenge_ignore 0 · login_automation 0 · trigger_gate bypass 0 · trace_coverage 100% · pass_liveness 100% · idempotency
  
- [ ] 
  
  Fresh-install test: new machine/user account → onboarding → WhatsApp pairing (mock + real) → first proposals ≤3 min
  
- [ ] 
  
  Zero references to SuperTwinV11 anywhere in app, data paths, logs
  
- [ ] 
  
  Privacy audit script: no incognito/password-manager content in a day's log
  
- [ ] 
  
  DMG builds and runs ad-hoc-signed; icons correct; **version + built-through phase visible** (About, Settings › General, menu-bar footer) and encoded in the DMG filename (`SuperTwinV13-13.<phase>.<build>-P<n>.dmg`); `BUILT_THROUGH_PHASE` matches green gates
  
- [ ] 
  
  Cost dashboard sane: ¢/event within budget; no groundhog-LLM in scheduled browsing
  
## 9. Parallelization map (for /goal orchestration)
```
P0: P0.1 → P0.2 → P0.3 → [A: P0.4→P0.5] ∥ [B: P0.6] ∥ [C: P0.7] ∥ [D: P0.8] ∥ [E: P0.9]
P1: P1.1 → [A: P1.2→P1.3] ∥ [B: P1.4→P1.5] ∥ [C: P1.6] ∥ [D: P1.7] ∥ [E: P1.8]
    (P1.3 blocks P1.4's eval runs, not its coding)
P2: [A: P2.1] ∥ [B: P2.2→P2.3] ∥ [C: P2.4]
P3: [A: P3.1→P3.2] ∥ [B: P3.3] ∥ [C: P3.4] ∥ [D: P3.5 after P3.3]
P4: [A: P4.1] ∥ [B: P4.2] ∥ [C: P4.3]
P5: [A: P5.1] ∥ [B: P5.2→P5.3→P5.4→P5.5→P5.6]
Phase boundaries are hard: P1 exit gates gate P2; P3.4 hardening gates P5.3+.
```
