# SuperTwin-WhatsApp — Progress

## Project
- Mac desktop app: a proactive personal AI assistant fed by WhatsApp. Local-first, private, agentic.
- Stack: Tauri 2 + React/TS (UI) · Node/TS worker (single SQLite writer) · SQLite · Go/whatsmeow daemon · Claude CLI adapter (per-role model-selectable).

## Status
- Phase 0 ✅ · Phase 1 ✅ · Phase 2 ✅ · Phase 3 ✅ · Phase 4 ✅ · Phase 5 ✅.

## Phase 0 — Skeleton + Claude adapter (done)
- Scaffold: Tauri 2 + React 18 + TS monorepo (npm workspaces) + `@supertwin/worker`; 5-tab shell.
- SQLite: full schema + FTS5 + migrations + chat/session/quota/extraction_runs tables.
- Claude adapter (Paperclip-style): stream-json, session guards, poison→fresh fallback, quota, cancel/kill (0 orphans).
- Chat tab UI: streaming, multi-turn (resume), session list/reopen, cancel; Tauri sidecar spawn/kill.
- Packaging: self-contained worker (esbuild bundle + better-sqlite3 + node sidecar) → signed macOS `.dmg`.

## Phase 1 — WhatsApp ingestion (done)
- Go/whatsmeow daemon (`sources/whatsapp-go`): QR pair, history-sync range backfill + on-demand extend, media download (sha256), canonical JIDs, reconnect/backoff, `--mock` mode. READ-ONLY — no send path.
- Runs as a worker-supervised child over NDJSON stdio; ships inside the worker bundle (ad-hoc signed), no new Tauri externalBin.
- Worker event pipeline: migrations 0002/0003, dedupe writer (ON CONFLICT DO NOTHING), SourceAdapter/WhatsAppAdapter, HTTP/SSE API (status/stream/pair/import/extend/pause/logout/reset/relink, inbox chats/messages/search, media w/ traversal guard).
- Inbox UI: QR onboarding, import-range picker, live Inbox (chat list, message pane, media), FTS search, reactions/replies, kill-switch, extend.
- Ships as a self-contained, codesigned `.dmg`.

## Phase 1 real-device fix rounds
- r1: real names + JID canonicalization/dedupe (single channel per contact, self-chat unified).
- r2: full re-link + re-sync (unlink→fresh QR→WhatsApp re-pushes history), business/noise filtering, empty chats hidden.
- r3: non-blocking background import + real business text + reactions (emoji chips) + quoted replies.
- r4: history-sync names + in-range progress/done + extend pagination + media-label previews.
- r5: latest-window paging (open at newest, scroll-up for older) + import completion on plateau/quiet-window + masked-number handling (WhatsApp privacy).

## Phase 1 fix round r6 (business messages + verified names — ported from ComplexBrain)
- Business/enterprise proto text extraction (daemon `events.go`): pull the real text out of `TemplateMessage(HydratedFourRowTemplate)` — walking the `HydratedFourRowTemplate` Format-oneof (e.g. Jio / OTP variants) — nested `HighlyStructuredMessage(HydratedHsm)` with recursion, list / buttons / interactive-footer, payment / comment / group-invite / event, 📊 poll, 📷 Album, and `AssociatedChildMessage` unwrap; any still-unhandled type self-reports via a `businessPlaceholderFor` diagnostic to the daemon log. Replaces the literal `[business message]` placeholder.
- Verified-name resolution (daemon `engine.go`/`helpers.go`): `verifiedName` > `pushName` precedence + masked-number guards + a bounded, read-only `GetUserInfo` recovery sweep that reads names back from the contact store (`resolveUnsavedBusinessNames`), a resweep while history is still streaming (`startBusinessNameResweep`), and LID→PN mapping. Replaces the phone-number fallback; emits RC1 empty-name when a name is genuinely unresolvable.
- Frontend (`whatsapp-types.ts` / `InboxTab.tsx`): `displayName` pretty-prints the number from the JID and hides masked numbers, so an empty/unresolved name renders as a formatted number rather than a raw JID.
- Identical whatsmeow version in both repos → verbatim adoption, zero API adaptation. New Go tests: `names_test.go`, `masked_test.go` (+ engine/mapper/completion test additions); new UI test `whatsapp-types.test.ts`.
- Operational caveat: already-imported chats stored the phone number *as* the name, so the new daemon can't retroactively fix persisted rows on its own — a re-link / "Re-sync from scratch" is the reliable way to apply it to pre-existing data (a plain reconnect also re-resolves and upserts names in place as history re-streams).

## Phase 1 fix round r7 (full history sync)
- Root cause of "0 chats imported / Message sync is paused": the daemon built the whatsmeow client bare and never set the global `store.DeviceProps`, so it inherited whatsmeow's default `RequireFullSync=false`. With that default the phone pushes only a minimal recent window and can stay "paused", delivering ~0 history.
- Fix (daemon `internal/wa/engine.go`): new `configureDeviceProps()` sets `RequireFullSync=true` (the load-bearing lever) plus a wide `HistorySyncConfig` (`FullSyncDaysLimit=3650`, `FullSyncSizeMbLimit=102400`, `StorageQuotaMb=102400`, `RecentSyncDaysLimit=90`) so the phone actually serves full/deep history — the daemon's `onHistorySync` still range-filters to the chosen import range. It also presents as a full client: `Os="SuperTwin"`, `PlatformType=DESKTOP`. `HistorySyncConfig` is MUTATED (not replaced) so whatsmeow's default capability flags (`SupportGroupHistory`, etc.) survive. Called BEFORE `whatsmeow.NewClient` in `Start()` so it lands in the registration payload.
- Session auto-recovery: new `configureClient()` sets `AutomaticMessageRerequestFromPhone=true` (re-requests undecryptable messages from our own primary device — recovers the "no session found"/"no signed prekey" Signal-session gaps) alongside the preserved `EnableAutoReconnect=true`, replacing the bare `EnableAutoReconnect` assignment.
- `go.mod`: `google.golang.org/protobuf` reclassified indirect→direct by `go mod tidy` (no version bump). New Go test `deviceprops_test.go` (`TestConfigureDeviceProps`, `TestConfigureClientEnablesPhoneRerequest`) — deterministic, offline. `go build`/`go vet`/`go test` (+race) green; worker + UI + `e2e-mock.mjs` 69/69 green; dmg rebuilt, codesign valid, fix confirmed in the bundled daemon.
- IMPORTANT operational note: `DeviceProps` are sent to the phone ONLY at REGISTRATION (device.ID==nil path), so this takes effect only after the user **UNLINKS + RE-LINKS once** with the new build installed. Keep the phone unlocked / foregrounded / on Wi-Fi during the first sync.

## Verification
- Suites green: Go build/vet/test (+race, arm64) · worker 126/126 · UI 76/76 · `scripts/e2e-mock.mjs` 69/69.
- `SuperTwin_0.1.0_aarch64.dmg` (47 MB), `codesign --verify --deep` valid; runs from outside the repo, 0 orphans.

## Known limits (WhatsApp platform — manual verification)
- Extend depth is bounded by WhatsApp's server-side retention for a linked device (chats bottom out at different dates).
- Some exotic business message types self-report their proto type to the daemon log for a targeted next-round fix.
- Masked numbers (`+91····15`) are WhatsApp's own privacy identifier — no real number to show.

## Phase 2 — Brain: Spaces + extraction (done)
- Migrations 0004/0005: spaces slug/pins, tasks origin/approved/provenance, evaluations, patterns, space_people, grounded chat columns.
- Brain wiki (`worker/src/brain/`): git-backed markdown at ~/SuperTwin/brain; marker-based writers preserve user edits; `[[wikilinks]]` + `evt:<id>` provenance; traversal-guarded `/api/brain/file`.
- Extraction engine (`worker/src/extraction/`): batcher (10-min lull / 50 msgs, kill-switch, durable cursor) → assign stage (cross-chat clustering, pinned-space protection) → extract stage (≥1 goal + latest_update enforced in code, no forced milestones, explicit vs implicit tasks, conservative entity resolution, pattern candidates need ≥2 repetitions) → transactional SQLite + brain apply; idempotent re-runs; backfill updates (never duplicates); every LLM call in extraction_runs.
- Phase 2 API: spaces (list/detail/events/rename/archive/merge/split/goals/tasks), tasks (status/move/approve), people, patterns confirm/dismiss, evaluations (👍/👎), extraction status/toggle/run/SSE.
- Spaces UI: cards led by latest_update, detail w/ goal tree, "Asked" vs "Suggested by assistant" (approve/dismiss), provenance popovers, merge/split/rename/archive/move, People CRM view, Patterns panel, extraction kill-switch strip, eval widgets on every output.
- Grounded Chat: cwd=brain, read-only tools (Read/Grep/Glob), pre-turn FTS retrieval injection, mandatory CITATIONS → clickable [n] chips (event popover, space/person/task → Spaces tab).
- Evals: `evals/fixtures/v1` (108 labeled events, 5 spaces, cross-chat clustering, code-switching, backfill) + `npm run eval` — deterministic fake-LLM CI mode (green: 100% assignment, 0 dupes, idempotent) and `--llm=real` quality mode.
- Verified: worker 198/198 · UI 103/103 · e2e-mock 69/69 · eval green · `.dmg` rebuilt (47 MB, codesign valid, outside-repo smoke, 0 orphans).

## Phase 2 fix round (real-device: "Run now" did nothing)
- Root cause: extraction Claude calls passed no `--max-turns` and `--allowedTools ""` (does not block tools), so on a real ~35KB prompt `claude` loaded CLAUDE.md/settings and ran away into agentic Bash/Read + extended thinking instead of returning JSON — killed at 180s (0 tokens, 0 spaces, cursor never advanced, `last_run_ts` null → UI stuck "Last run: never").
- Fix (all four required, proven vs real claude 2.1.197): `plainCompletion` = `--max-turns 1` + `--disallowedTools <tools>` + `--setting-sources ""` + `MAX_THINKING_TOKENS=0` + neutral temp cwd. Before: assign TIMEOUT/180s/0 tok. After: ok/31–36s/~2–6k tok, real spaces created.
- Resilience: `callJson` retries once on transient CLI errors; per-space extract failures skip (not fatal), failed new space still created invariant-valid, cursor advances on progress (idempotent), soft `last_error` note keeps status `ok` when spaces were created.
- Visibility: engine records `last_run_status`/`last_error`/`last_run_ts` every attempt; status API + SpacesTab strip (Running spinner, error banner, poll fallback); worker stdout/stderr tee'd to `~/SuperTwin/worker.log` (was black-holed in Finder-launched app). Default batch limit 200→100 (safe under 180s backstop).
- Verified: worker 219/219 · UI 108/108 · e2e-mock 69/69 · eval green · cargo check clean · **packaged .dmg** smoke under stripped Finder PATH on a db copy → `last_run_status=ok`, 3 spaces, assign 6459 tok (vs old TIMEOUT/0). Commits `2afbf4e`, `f638f59`.
- Known limit: each run processes ~100 events; a large imported backlog drains over repeated runs (continuous background auto-drain is a possible follow-up — it implies ongoing Claude quota spend, so left opt-in).

## Phase 2 backlog drain (opt-in)
- Why: single-batch "Run now" only processes ~100 events per run; a large imported history (8000+) needed a way to drain automatically instead of clicking repeatedly.
- Worker: engine `startDrain`/`stopDrain` loop processes batches back-to-back (reuses the single-batch path), inter-batch delay `SUPERTWIN_EXTRACTION_DRAIN_DELAY_MS` (default 1500); guards re-checked between batches → typed reasons (stopped/disabled/paused/empty/quota); quota near-limit stops with a soft `last_error` (no spin); serialized with `runNow` via a single-flight guard; `engine.stop()` stops drain; in-memory progress (no auto-resume across restart).
- API/SSE: `POST /api/extraction/drain/start` ({ok,draining}) + `/stop`; status adds `draining`/`drain_processed`/`drain_started_pending`/`drain_finished_reason`; SSE `drain_started{total}` → `run_progress{processed,remaining}` → `drain_finished{reason}`.
- UI: distinct "Catch up on backlog" button (separate from Run now; shown when pending>0, disabled when extraction off), live progress bar + Stop, quota-paused + caught-up soft notes, SSE-driven with 2.5s poll fallback.
- Verified: worker 225/225 · UI 115/115 · e2e-mock 69/69 · eval green · cargo check clean · contract cross-checked worker↔UI · packaged .dmg drain smoke (stripped Finder PATH, db copy): start→3 batches (drain_processed 0→120, pending 8131→8011)→4 spaces, assign ok (no timeout)→stop→draining false. Commit `cc30b5f`.

## Model picker (Claude CLI adapter)
- Why: let users choose which Claude model the local CLI adapter runs — now per-role, three independent roles (chat / extraction / execution), each with its own choice from the same catalog: Default (subscription) plus Haiku / Sonnet / Opus / Fable families as latest-alias + pinned versions (11 entries); verified vs `claude` 2.1.197 whose `--model` accepts family aliases and full IDs. Execution is persisted/exposed now and consumed once task execution ships (Phase 3/4).
- Adapter: catalog in `worker/src/providers/claude-local/models.ts` (`MODEL_CATALOG`, `isValidModelId`); `SendOptions.model` threaded through `send()`/`runOnce()`/`buildCliArgs()`; `--model` emitted only for a non-empty selection — the Default (`""`) path passes no flag, byte-identical to prior behavior (no Phase 1/2 regression).
- Persistence: SQLite `app_state` keys `selected_model_{chat,extraction,execution}` (`getSelectedModel(role)`/`setSelectedModel(role, model)` in `worker/src/extraction/store.ts`); legacy `selected_model` still read as a migration fallback for chat/extraction.
- API: `GET`/`POST /api/settings/models` in `worker/src/server/index.ts` (GET → `{models, roles, selections}`; POST `{role, model}` validates both, 400 on invalid role or model); applied per role at the send sites — interactive chat → role "chat" (`server/index.ts`) and extraction → role "extraction" (`worker/src/extraction/llm.ts`).
- UI: data-driven Models card in `src/tabs/SettingsTab.tsx` — one family-grouped `<select>` per role (future roles show a hint); `getModels`/`setModel(role, model)` in `src/lib/worker-client.ts`; `.settings__select` in `src/styles.css`.
- Verified: UI 118 · worker 250 · both typecheck clean · live smoke incl. per-role independence + restart persistence for all three roles (selections survive worker restart via SQLite) + invalid role/model rejection · `.dmg` rebuilt (47 MB, ad-hoc signed, codesign valid), feature verified bundled inside the packaged `.app`.

## Phase 3 — Task engine: propose + schedule (done)
- Migration 0006: tasks +(`task_type`,`urgency`,`intent`,`triage`,`snoozed_until`,`done_evidence_event_id`,`done_confidence`,`plan`,`result`,`error`,`updated_at`); extraction_runs +(`model`,`role`); new `task_runs` table (execution history).
- Triage (`worker/src/tasks/`): RuleTriage (deterministic) + ClaudeTaskTriage seam — explicit safe types (research/summarize/draft/reminder) auto-queue; implicit/outward/ambiguous need approval; `execute_at` date parser ("on the 5th"/tomorrow/next week/weekday/every-N-days). Engine post-extract hook triages new tasks + auto-queues safe ones.
- Scheduler (`worker/src/tasks/scheduler.ts`): interval poller (20s), fires due queued tasks within a tick, recurrence (daily/weekly/monthly/every-N-days), injectable clock, respects kill-switch.
- Done-detection: RuleDoneDetection + ClaudeDoneDetection — incoming events vs open tasks → done (evidence link) or possibly_done (one-tap confirm); never nags completed tasks.
- Chat write-access (`worker/src/chat/actions.ts`): parse NL → ProposedAction (add_task/edit_task/snooze_task/add_goal/create_space/run_task) with human diff; apply mutates store + refreshes brain markdown; UI confirm-diff card in ChatTab.
- Routes: `GET /api/tasks`, `/api/tasks/queue` (grouped by space), `/api/tasks/:id`; `POST` snooze/edit/schedule/reject/run/cancel/retry; `GET /api/tasks/stream` (SSE); `POST /api/chat/action` + `/apply`. macOS notifications (osascript, best-effort, settings-gated).
- UI: Agent tab (real) — queue grouped by space with approve/reject/edit/snooze/schedule/run + possibly-done confirm; SpacesTab richer task states.

## Phase 4 — Task execution (done)
- Executor (`worker/src/execution/`): pipeline per task = gather context (space.md + wikilinked people/workflows/habits/preferences + FTS over events) → plan (planning-role model) → execute (`claude -p`, cwd=brain, execution-role model, per-task-type tool allowlist) → results card appended to `spaces/<slug>/log.md` + space latest_update + task done/result; concurrency limit 2, cancel (parks to open, no auto-rerun), retry, per-run transcript logs in `~/SuperTwin/logs/runs/`, `task_runs` + `extraction_runs` logged (tokens/duration/model) for quota + runs viewer.
- Tool allowlist per task_type (research/summarize/draft/plan/reminder/outward/other); browser/calendar/email/whatsapp-draft are documented v1 stubs (approval-gated, never auto-sends).
- Chat-triggered execution (run_task) links the run back into the Agent tab live run view (plan + transcript SSE + results/cancel/retry).

## Settings features (done)
- Per-process model picker for all seven LLM roles: chat, extraction, triage, done_detection, planning, execution, nightly (data-driven card). The `nightly` role is the nightly brain-self-update summarizer — it previously piggybacked on the `extraction` role's model and now has its own per-role picker + on/off toggle, defaulting to the subscription default until selected. Env `SUPERTWIN_NIGHTLY_DISABLED` still exists as an independent override.
- Per-process on/off toggle (`app_state` `process_enabled_<role>`; `GET /api/settings/models` `enabledByRole` + `POST /api/settings/models/enabled`); extraction toggle unified with the existing kill-switch; each disabled process short-circuits its provider call.
- Runs viewer: `GET /api/runs` → table (process/model/input+output tokens/duration/status/time) from extraction_runs (all seven roles log model+role).
- Open logs folder: `~/SuperTwin/logs` (worker-node.log + runs/ transcripts); `GET /api/logs/info` + `POST /api/logs/reveal`.
- Open brain (LLM wiki) folder: `GET /api/brain/info` + `POST /api/brain/reveal` (`~/SuperTwin/brain`).
- Native folder-open + notifications kept worker-side (child_process open / osascript) — no Tauri/Rust/capability/entitlement changes, so codesigning stays intact.

## Phase 3/4 verification
- worker 446/446 vitest (twice-stable, tsc clean) incl. real-CLI integration (resume guards, cancel kills mid-flight, 0 orphaned claude), phase34-integration (route-shape live-wire) + phase34-acceptance (Phase 3 a–g + Phase 4 h–l) suites.
- UI 173/173 vitest, tsc clean.
- eval 18/18 green (fake, deterministic): triage classification 100% (12/12, >90% bar), triage task_type 100%, schedule-parse 100%, done-detection 100% (5/5, >90% bar); extraction eval unchanged green.
- e2e-mock 69/69 (Phase 1 regression intact).
- Adversarial-verify + live-wire fixes: extraction runs now log model+role; chat add_task refreshes brain md; executor maxTurns cap; cancel no longer auto-reruns (scheduler skip); taskOut approved emitted as 0|1 (was boolean → approved tasks stuck "needs approval"); reveal spawn mockable (no real Finder / no ENOTEMPTY flake).
- Packaged: `SuperTwin_0.1.0_aarch64.dmg` (46.7 MB), `codesign --verify --deep` valid; new backend verified inside the bundle; bundled-worker smoke under stripped Finder PATH → all new routes 200, six roles + enabledByRole confirmed, 0 orphans.
- Commits: `164a09d` (UI) · `d3a594e` (backend) · `91859f4` (settings extras) · `d6cefad` (integration).

## Phase 5 — Feedback loop + polish (done)
- Migration 0007_phase5: `task_runs.session_id` (provider session id of the execution run, so a follow-up can resume it), `nightly_runs` (one row per nightly brain-update/improvement job), `quality_snapshots` (rolled-up eval verdict counts per ISO-week × output_type).
- 5A — result feedback → preferences + follow-up resume (`64cfc4a`): executor persists `session_id`, `followUp()` re-invokes the same Claude session via `--resume`; `gatherContext` always injects `me/preferences.md` + `me/procedures/system-corrections.md` into the execution bundle; `POST /api/tasks/:id/feedback` (👍/👎 + free-text → `evaluations` `'task_result'` rows + a dated line in `me/preferences.md`) and `POST /api/tasks/:id/followup`; AgentTab feedback widget + follow-up input; `postTaskFeedback`/`postTaskFollowup` in worker-client.
- 5B — nightly brain self-update + improvement loop (`90833aa`, `worker/src/nightly/`): `runBrainUpdate` folds completed tasks + feedback into dated `me/journal.md` entries plus conservative preference drift; `runImprovement` turns down-votes into a deduped few-shot `me/procedures/system-corrections.md`, converts recurring failures into `evals/fixtures/regressions/cases.json`, and writes ISO-week `quality_snapshots`; `runNightly` orchestrator + `NightlyRunner` wall-clock once-per-day trigger wired in `worker/src/index.ts` (respects `SUPERTWIN_NIGHTLY_DISABLED` + ingestion pause); `system-corrections.md` is injected into the extraction + triage prompts; `POST /api/nightly/run` + `GET /api/nightly/status`; brain writes are guarded (balanced-frontmatter, no-corruption) with an injectable summarizer + clock.
- 5C — daily digest + weekly quality report (`356c849`): `GET /api/digest` (learned = nightly summaries + journal + new prefs/corrections · done today · pending proposals) + `GET /api/quality` (accuracy trend per output_type, live fallback when no snapshots exist); Digest tab (`src/tabs/DigestTab.tsx`) with dependency-free quality bars + a Run-nightly-now button; `getDigest`/`getQuality`/`runNightly` in worker-client.
- 5E — `nightly` LLM role added to Settings: `MODEL_ROLES` + `MODEL_KEY_BY_ROLE` gain `nightly`, so the data-driven Settings card auto-renders a seventh per-role model picker + on/off toggle (no SettingsTab change needed). The nightly summarizer now resolves its model from `getSelectedModel('nightly')` — previously it piggybacked on the `extraction` role — and defaults to the subscription default until selected; its provider call + the wall-clock auto-scheduler are gated by `getProcessEnabled('nightly')` (a disabled nightly short-circuits with no LLM/brain write, recording a `skipped` `nightly_runs` row). Env `SUPERTWIN_NIGHTLY_DISABLED` remains an independent override.

## Phase 5 verification
- worker 481/481 vitest (`npm test -w @supertwin/worker`): 35/35 test files, 481 tests passed, 0 failed, ~59s; includes real-CLI integration suites (claude-local adapter 7, server.integration 5).
- UI 180/180 vitest (root `npm test`, jsdom): 9/9 test files, 180 tests passed, 0 failed, ~7.5s (AgentTab 15, ChatTab 20, InboxTab 31, SettingsTab 14, SpacesTab 37, + others incl. DigestTab); only non-fatal React `act(...)` warnings.
- eval green (`npm run eval`, `--llm=fake`, fixtures v1): exit 0, all 18 mechanical checks green — space assignment 100.0% (76/76, >85%), noise filtered 24/24, explicit task precision/recall 100.0%, person-merge error 0.0% (0/8, <5%), triage classification 100.0% (12/12), done-detection confident-yes precision 100.0%.
- e2e-mock 69/69 (`node scripts/e2e-mock.mjs`): built Go daemon + bundled worker.cjs, mock end-to-end across import/reset/relink/24h-extend/pagination, RESULT PASS, exit 0 (matches prior baseline).
- Acceptance (Phase 5 a–c) + eval (a–b) covered as automated tests: feedback "too verbose" lands in `me/preferences.md` AND is applied via the executor's context builder; follow-up resumes the same session id (`--resume`); `/api/digest` renders the learned/tasksDone/pending shape; 3 down-vote corrections appear once each in extraction + triage + execution prompts with no re-run drift; `runBrainUpdate` appends without corrupting brain files (balanced frontmatter, idempotent, git commit made).
- Packaged: `SuperTwin_0.1.0_aarch64.dmg` rebuilt by `npm run tauri build` (46.76 MB / 49,033,763 bytes, mtime Jul 11 newer than the pre-Phase-5 Jul 10 bundle); `codesign --verify --deep --strict` valid (ad-hoc identity "-"), `SuperTwin.app: satisfies its Designated Requirement`.
- Bundled-worker smoke under stripped Finder PATH (`env -i`, isolated `SUPERTWIN_HOME` copy of the db/brain, `SUPERTWIN_WHATSAPP_MOCK=1`, `SUPERTWIN_NIGHTLY_DISABLED=1`, on a free port so the user's live workers on 8787/8799 were untouched): new routes all 200 — `GET /api/nightly/status`, `GET /api/digest`, `GET /api/quality`, `POST /api/nightly/run` (improvement job really ran: "corrections +1, regressions +0, snapshots 1"), `POST /api/tasks/<id>/feedback` on a real task id. Phase 5 markers present in the bundled `worker.cjs` (`/api/nightly` ×3, `/api/digest` ×2, `/api/quality` ×2, `runBrainUpdate` ×2, `nightly_runs` ×7; the Jul 10 bundle had 0 of each). Worker exited cleanly on SIGTERM, 0 orphaned claude/worker processes.
- Commits: `64cfc4a` (5A) · `90833aa` (5B) · `356c849` (5C).

## Dayflow UI revamp (2026-07-12)
- Full visual revamp of the app to Dayflow's design language: warm cream/peach gradient shell, 72px icon-rail sidebar (replacing text tabs), orange accents (#F96E00 / #FF6B05), capsule pills, warm cards, Instrument Serif display + Figtree body type (bundled offline via `@fontsource/instrument-serif` + `@fontsource/figtree`, imported in `src/main.tsx` — no network fetch).
- Foundation (`2e67034`): monolithic `src/styles.css` split into `src/styles/` — `tokens.css` (Dayflow design tokens: colors, type scale, radii, shadows), `base.css`, `shell.css` (gradient shell + icon rail), and per-tab sheets under `src/styles/tabs/` (inbox/spaces/agent/chat/digest/settings). `App.tsx` rebuilt around the icon-rail shell. Spec written to `docs/design/dayflow-design-spec.md`.
- Per-tab restyles: inbox + WhatsApp onboarding (`1058ce0`), spaces (`49a1562`), agent (`622e4a6`), digest incl. quality donut + tsc unused-var fix (`310bc93`), chat (`43858cf`), settings (`5c585a2`).
- Visual QA polish pass (`7d3f894`): Dayflow-conformance fixes from screenshot review; after-screenshots of all six tabs saved to `docs/design/after/`.
- Behavior-preserving: styling/markup only — no worker, daemon, or API changes. UI tests 189/189 green, typecheck clean, `npm run build` green; `.dmg` rebuilt from this revamp.

## Next
- Phase 5 done — all five phases shipped. Remaining known limits / possible follow-ups:
  - The nightly summarizer calls Claude, so leaving it on implies ongoing subscription quota spend; it is opt-out via `SUPERTWIN_NIGHTLY_DISABLED` (and skips while ingestion is paused), and runs at most once per wall-clock day.
  - Nightly triggering is wall-clock-only (no catch-up for days the app was closed); the regression suite grows from real down-votes but new cases are not yet auto-promoted into the CI gate.
  - Preference drift is deliberately conservative (≤3 preference updates per run, dedup, append-only) — visible corrections may take a couple of nights to accumulate.
  - Agent tools for calendar/email/browser/WhatsApp-draft remain approval-gated v1 stubs (never auto-send); real integrations are a v1.1 follow-up.
