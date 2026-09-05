# SuperTwin V13 — Build V6 · Phase 1

Builds `SuperTwinV13_Product_V6_Phase1.md` on top of the current V13 tree (HEAD `7346b15`).

- This is the **only** V6 document where V13 code appears.
- Progress goes in `progressV13.md` and `RELEASES.md`, never here.
- Phase 1 is split into **seven stages, S0–S6**. Each stage ends in a DMG.
- Backlog items from `docs/implementation-backlog.md` (T-ids) are folded in and traced in §9.

**Contents**

| § | Section |
|---|---|
| 1 | [Conventions](#1-conventions) |
| 2 | [Reconciliation with V13](#2-reconciliation-with-v13) |
| 3 | [Stage 0 — Ground clearing and rails](#3-stage-0--ground-clearing-and-rails) |
| 4 | [Stage 1 — Consent, archive, adapters](#4-stage-1--consent-archive-adapters) |
| 5 | [Stage 2 — Index and T0 retrieval](#5-stage-2--index-and-t0-retrieval) |
| 6 | [Stage 3 — Understanding core](#6-stage-3--understanding-core) |
| 7 | [Stage 4 — Live path, executor-lite, assist](#7-stage-4--live-path-executor-lite-assist) |
| 8 | [Stage 5 — World model surfaces and the bar](#8-stage-5--world-model-surfaces-and-the-bar) |
| 9 | [Stage 6 — Graduation](#9-stage-6--graduation) |
| 10 | [Cross-stage release checklist](#10-cross-stage-release-checklist) |
| 11 | [Backlog traceability](#11-backlog-traceability) |
| 12 | [Parallelization plan](#12-parallelization-plan) |

---

## 1. Conventions

### 1.1 Identity and releases

- **Name, port, home stay.** `SuperTwinV13`, port 8013, home `~/SuperTwinV13/`. No rebrand.
- **No data migration.** The existing database is backed up once, then removed. Every test runs from a fresh install.
- **Versions.** Stage *N* releases as `13.(5+N).x`.
- **DMG name.** `SuperTwinV13_V6P1S<N>_<version>.dmg`. Keep every DMG. Bump via `scripts/release.mjs`.

### 1.2 Definition of done

- **Per task:** tests green → acceptance met → commit → one line in `progressV13.md`.
- **Per stage:** all tasks accepted, the stage's eval categories green, DMG built and recorded in `RELEASES.md`.

### 1.3 Process rules (hard)

1. Never run the worker without **both** `SUPERTWIN_HOME=<scratch>` and `SUPERTWIN_WORKER_PORT≠8013`.
2. Never detach a process. No `&`, no `nohup`, no `disown`.
3. Any agent that opens a port closes it in the same turn and says so.
4. A listener you did not start is **not** automatically the user's app. Report it.
5. Any command reaching the `claude` CLI spends tokens. State the expected call count.
6. Never boot a worker against the production home to verify a change. Tests are enough.

### 1.4 Task notation

- **SERIAL** tasks run in order, first.
- **Lane** tasks, marked `[A]`…`[F]`, run in parallel after the serial block.
- Prompts are specified in `SuperTwinV13_Prompts_V6_Phase1.md`. A task that ships a prompt ships it at the version named there.

---

## 2. Reconciliation with V13

Every module gets one verdict before any code is written.

### 2.1 Keep

| Module | Verdict | Note |
|---|---|---|
| `sources/whatsapp-go` (Go) | keep | add `count_range`; token send already exists |
| `sources/screenwatch` (Swift) | keep, extend | roles in `RawCapture`, docKey fallback, consent-gated spawn |
| `src-tauri` | keep, extend | launched-by token, sidecar reap, menu-bar state |
| `adapters/whatsapp`, `adapters/browser`, `adapters/screen` | keep, rewire | consent gate, archive emit, param strip, profile discovery |
| `providers/`, `traces/`, `evals/`, `media/`, `server/` | keep, extend | budget, flags, breaker wiring, new routes, new eval categories |
| `retrieval/` | keep, rewrite `semantic.ts` | RRF, bounded candidates, graph walk, structured, coverage; `rank()` stays verbatim |
| `bridges/` | keep, wire | bridges become graph edges and packer input |
| `entities/`, `claims/`, `consolidation/`, `salience/`, `tiers/`, `categories/`, `freshness/`, `wire/`, `ingest/`, `library/`, `grounded/`, `executor/`, `approvals/` | keep, extend | typed fields on claims; consolidation on change; `ingest` gets the gate |
| `browser/` (SuperTwin browser) | keep, dormant | not wired in P1 |
| `prompts/` | keep runner, add versions | `orient.v6` and `critic.v4` stay as the frozen baseline until the S4 gate |
| `db/` | keep framework | migrations `0200_v6_core`, `0201_v6_graph`; drop dead columns |

### 2.2 Rewrite

| Module | Scope of rewrite |
|---|---|
| `scheduler/` | state gate, burst, cold window, history day-bundler, digest lane, attempts, slot-cap invariants |
| `brain/` | consumer and commit path; keep `parseOrientOutput`, `resolveEventAliases`, `buildCriticInput` |
| `packer/` | sections, event heads, untrusted block, `[NOW]`, `[OPEN TASKS]`, `[CALENDAR]`, budgeted truncation, T0 retrieval |

### 2.3 Delete

| Deleted | When |
|---|---|
| `assist/` — watcher, evaluator, tick, cursor, gate (`executor-lite.ts` moves to `executor/lite.ts`) | S4 |
| Engagement tiers (hot/warm/cold delays) | S0 |
| `INTENT_RE` gating and low-signal deferral | S0 |
| Tracker blocklist and `isDroppableTrackerHop` | S0 |
| `content_pending` | S0 |
| `sources.connected_at`, `sources.enabled` | S0 |
| 5-minute dispatch windows and the per-stream orphan scan | S0 |

---

## 3. Stage 0 — Ground clearing and rails

> **Goal.** The tree is safe, clean and empty. **No new design lands here.**
> **Backlog.** T0-1..15, T1-1/2, T8-1..3.

### 3.1 SERIAL

#### S0.1 — Freeze the baseline

- **Change.** Run the V2 golden suite once on the current tree. Store per-category scores in `evals/baseline/v13.json`.
- **Accept.** `npm run eval -- --baseline` prints it.

#### S0.2 — Spend and process rails

- **Budget.** New `worker/src/providers/budget.ts`, enforced after `assertTraceContext` in `providers/claude-local/index.ts`.
  - Ceilings: $3/hour, $15/day, 400 calls/hour, 3,000 calls/day.
  - `BUDGET_EXCEEDED` throws **before** spawn; latch in `app_state.budget_tripped_at`.
  - Chat and the grounded bar are counted but exempt from the latch.
- **Dev worker.** New `scripts/dev-worker.mjs`: scratch home, port 8113, PID file, 30-minute self-kill. Point `package.json` `worker` at it; add `worker:live`.
- **Home guard.** New `worker/src/home-guard.ts`, lifted from `evals/home.ts`, as the first line of `main()`. The app sets `SUPERTWIN_LAUNCHED_BY=app` in `src-tauri/src/lib.rs`. Waiver: `SUPERTWIN_ALLOW_PRODUCTION_HOME=1`.
- **Self-shutdown.** `worker/src/index.ts` exits 10 minutes after parent loss unless `SUPERTWIN_WORKER_NO_PARENT=1`. Startup sweep kills pre-existing workers; `killAll()` on unhandled rejection.
- **Docs.** `CLAUDE.md` carrying §1.3. Fix `README.md:32`.
- **Tests.** SPD-01, SPD-02; `npm run worker` writes to temp and exits; a bare boot against `~/SuperTwinV13` exits non-zero; the app token boots.
- **Accept.** `lsof -i:8013` empty after the run.

#### S0.3 — Disarm the old dispatcher (temporary until S3)

- **Change.**
  - Cap `admittedOrphans` at `cfg.slots - slotted.length` — `scheduler/dispatch.ts:626-635`.
  - Key the in-flight set — `brain/consumer.ts:146`.
  - Re-check `dispatched_at` at the top of `runBrainTick`.
- **Tests.** BND-08..10 against the old dispatcher.
- **Note.** This code dies in S3. It exists so the tree is safe until then.

#### S0.4 — Transport stage 1+2

- **Where.** `providers/claude-local/index.ts`.
- **Change.** `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`; remove the double prompt send at `:184-191`; add `--no-session-persistence`, `--max-budget-usd`, `--safe-mode`, `--strict-mcp-config`.
- **Tests.** argv snapshot; SPD-04 and SPD-05 on one live call.

#### S0.5 — Prune

- **Change.** Delete everything marked delete in §2.3, plus the tests asserting it. Fill the `IMPORT_RANGES` gaps (`3d`, `3y`, `4y`).
- **Accept.** `tsc` clean, `npm test` green, `/api/health` boots on a scratch home.

#### S0.6 — Remove the data

- **Change.** Copy `~/SuperTwinV13/supertwinv13.db` and `traces/` to `~/SuperTwinV13-incident-2026-08-29/`, record the hash in `progressV13.md`, delete the home.
- **Accept.** Fresh home has zero events.

### 3.2 Lanes

#### S0.7 [A] — Breaker, quota, waiters

- `brain/llm.ts` calls `pool.noteSuccess` / `pool.noteFailure`; 10 consecutive failures pause a lane and raise a banner.
- `logRun` calls `db.addUsage`.
- `pool.ts` caps waiters at 4× capacity and exposes `waiting` on `/api/ops`.
- **Tests.** SPD-07, SPD-08, BND-12.

#### S0.8 [B] — Kill switch and heartbeat

- `app_state.model_activity_paused` checked beside the budget.
- "Stop all model activity" in `GeneralPanel.tsx`; `/api/ops/lanes/pause` binding in `src/lib/api.ts`; drop `MAX_MANUAL_PAUSE_MS`.
- `[spend] 60s: …` heartbeat in the operator log.
- **Tests.** SPD-03, SPD-06.

#### S0.9 [C] — Ledger hygiene

- Populate `runs.pass` and `runs.origin` at insert.
- Write the trace row in the same transaction as `extraction_runs`.
- Route `digest-pass.ts:142`, `grounded/handlers.ts:170` and `media/describe.ts:600,711` through the pool.
- **Tests.** No NULL `pass`; `runs` count equals `traces` count.

#### S0.10 [D] — Latent loops

- `whatsapp/adapter.ts` `cleanRestart()` gets backoff and a give-up threshold.
- The assist accumulator loop dies with `assist/` in S4; until then, reset it on every exit path.

### 3.3 Exit S0

- **Release.** `V6P1S0_13.5.x`
- **Gates.** Baseline file present · SPD-01..08 · BND-08..10, BND-12 · TRC-01..03

---

## 4. Stage 1 — Consent, archive, adapters

> **Goal.** Nothing captured before yes. Everything consented to is indexed. Only the window is understood. Screen keeps what it captured.
> **Backlog.** T4-1..14, T6-5..8, T6-12/13/16/17.

### 4.1 SERIAL

#### S1.1 — Migration `0200_v6_core`

- **New tables.**
  - `consents` — source, state, granted_at, granted_build, scope_json, index_all, understand_from, decision_id, revoked_at
  - `archive` — narrow, zlib text, raw payload kept
  - `episode_events` — explicit membership
  - `bundle_attempts` — attempts, last_attempt_at, dead_letter_at
  - `blobs` — content-addressed screen text
  - `coverage` — source × date range × status
- **Envelope.** Gains `consent_id`, `tier`, `roles` per V6 §23.1.
- **Drop.** `sources.connected_at`, `sources.enabled`, `content_pending`.
- **Test.** Migrate up on empty; round-trip.

#### S1.2 — The consent gate

- **Where.** `db/eventlog.ts:229` and `db/ingest.ts:1396` — the two single-writer funnels.
- **Change.** `captureAllowed(source)` at both. Tier predicate at write: outside Understand → `origin='archive'`, `dispatched_at=capture_ts`.
- **Widening.** `UPDATE … SET dispatched_at=NULL, origin='backfill' WHERE ts>=?` — a replay, resumable, never a re-import.
- **Tests.** CNS-01..04.

#### S1.3 — Boot inversion

- `worker/src/index.ts` starts an adapter only on a `connected` consent row.
- Screen sidecar spawns after consent → Accessibility → explicit "Record from now on".
- `sinceMs` becomes **required** in `browser/watcher.ts` so the 90-day floor cannot return by omission.
- **Test.** CNS-01 — 60 s, zero events, no daemon, no sidecar.

### 4.2 Lanes

#### S1.4 [A] — Browser connect

- **Discovery.** `discoverProfiles()` enumerates every browser and every profile: Chrome, Brave, Arc, Edge, Comet, Safari.
- **Counts.** Copy-then-read per window; plateau copy ("Chrome keeps 90 days"); Safari Full Disk Access message; local-path disclosure.
- **Card.** No longer gated on `event_count === 0`.
- **URLs.** Param strip at emit in the `text` field only (extend `bridges/normalise.ts`; whitelist `path` on `*.localhost:7373`); raw URL on the payload; transition and `visit_count` on the payload; 30-second duplicate collapse at render.
- **Tests.** SRC-01, SRC-02, SRC-10.

#### S1.5 [B] — WhatsApp connect

- Flow: pair → buffer → `messagesInRange` counts → windows → confirm.
- No live ingest between pairing and confirm.
- Reply, reaction, forward, mention and audience carried on the envelope.
- **Tests.** CNS-09, SRC-09.

#### S1.6 [C] — Screen

- `envelope.ts:95` persists full text as anchor + diff into `blobs`.
- `consumer.ts:44` sets `source`; identity (app · title · doc key) on the envelope.
- Roles from `Live.swift:216,224` carried in `RawCapture`; structure-aware hash in `main.swift:62`.
- `""` docKey fallback fixed — `Live.swift:167`.
- New-chars floor on switch triggers.
- Pause persisted in `app_state` and seeded at boot — `adapter.ts:171`.
- **Tests.** SRC-03, SRC-04.

#### S1.7 [D] — Filter, verbs, indicator

- Never-list plus user lists (apps, sites, chats, senders) enforced at the funnel.
- Private moment — 15 minutes, menu bar and hotkey.
- Forget last N minutes with preview, routed through `hardDeleteEvents`.
- Pause / disconnect / delete per source with a `CascadeReport` preview; `resetSourceData` removed.
- Consent flips **before** teardown.
- Tray shows real capture state with one-click stop.
- **Tests.** CNS-05..08.

#### S1.8 [E] — Confirm card and Library

- Confirm card: four numbers with accuracy labels; text stored verbatim in `decisions`.
- Library per source: two bars (searchable · understood), bytes per tier, free disk first, two disk budgets.
- **Tests.** CNS-09, RET-04.

### 4.3 Exit S1

- **Release.** `V6P1S1_13.6.x`
- **Gates.** CNS-01..09 · SRC-01..04, SRC-09, SRC-10 · containment ≥ 95% on a mock import

---

## 5. Stage 2 — Index and T0 retrieval

> **Goal.** Five methods over one index, fused by rank, zero model calls, packer-ready.
> **Backlog.** T5-2/3; retrieval decision-record work items 1–6.

### 5.1 SERIAL

#### S2.1 — Migration `0201_v6_graph`

- `entity_edges` — kind, subtype, src, dst, confidence, status, valid_from, valid_to
- `edge_evidence` — event ids plus verbatim quote
- Typed-field columns on `claims` — amount, currency, date, status, merchant, order_id, location, duration_s
- `chunks` and `chunk_embeddings` — int8, rowid key, 16 KB pages
- `hub_nodes`
- **Test.** Migrate; `self` seeded as a hub.

#### S2.2 — Embeddings

- EmbeddingGemma 300M downloads on first run; a bundled small encoder covers search until then.
- Background re-embed, flipped in one transaction.
- **Chunk units.**
  - chat — rolling 2k chars per stream
  - screen — 2k chars of the reconstructed document, recomputed on re-anchor
  - browser — one per visit, deduped by content hash
  - plus episode summaries, space cards, claims, people cards
- **Tests.** RET-03, RET-05.

### 5.2 Lanes

#### S2.3 [A] — Lexical and the FTS projection

- FTS gains app, window_title, doc_key.
- BM25 over chunks and cards.
- **Test.** RET-06.

#### S2.4 [B] — RRF and reranker

- `retrieval/semantic.ts`: bounded candidates (FTS top 2,000 + vector top-k) → RRF at k=60 → cross-encoder (bge-reranker class, local).
- Delete the full-vector process cache. `rank()` kept verbatim.
- **Tests.** RET-01, RET-02.

#### S2.5 [C] — Structured and time window

- SQL method over typed fields: sum, count, range, status filter, enumerate by type.
- Time-window scan over the log, unscored.
- **Tests.** RET-07, RET-08.

#### S2.6 [D] — Graph

- Bridges written as edges at ingest — URL, phone, order id.
- BFS walk in TypeScript: seeds from lexical and vector, ≤ 2 hops, decay 0.6, fan-out cap, status and validity pruning, hub exclusion.
- **Tests.** RET-09, RET-10.

#### S2.7 [E] — Coverage index and type-ahead

- `coverage` rows maintained by adapters; `coverageCaveat(source, range)`.
- Bar type-ahead at T0, under 150 ms, over events, episodes, spaces, tasks, people, claims.
- **Tests.** RET-04, BAR-01.

### 5.3 Exit S2

- **Release.** `V6P1S2_13.7.x`
- **Gates.** RET-01..10 · BAR-01

---

## 6. Stage 3 — Understanding core

> **Goal.** The state gate, the day-bundler, grounded commit, and the understanding passes on the new pack.
> **Backlog.** T2-1..10, T3-1, T6-7/9/10/11, T7-2.

### 6.1 SERIAL

#### S3.1 — Commit rewrite

- **Where.** `brain/commit.ts`.
- **Change.**
  - Write `episode_events` rows.
  - Derive `episodes.stream_id` from resolved events; enforce single-stream (model tags `"stream":"S1"`, code enforces).
  - Per-item salvage; cursor advances on event ids.
  - Evidence must resolve to real ids with verbatim quotes, or the item rejects.
- **Keep.** `parseOrientOutput`, `resolveEventAliases`, `buildCriticInput`.
- **Tests.** CMT-01..05.

#### S3.2 — Packer rewrite

- **Blocks.** `[NOW]` · `[ROSTER]` · `[OPEN TASKS]` · `[CALENDAR]` · `[CANDIDATE SPACES]` (T0 retrieval, cap 5, with exemplars) · `[BRIDGED]` · `[THREAD S<k>]` · `[EPISODES]` · `[BUNDLE]`.
- **Rendering.** Sections by stream; event heads carry `time · source · app · title · doc`; all captured text inside one `<untrusted>` block.
- **History.** Episode-bounded: 1,500 chars per stream, 5 streams, quoted messages always fetched.
- **Truncation.** Budgeted from the remaining allowance — floor 400, ceiling 4,000.
- **Thin context.** Flag set when the packer cannot assemble enough.
- **Budget.** Whole pack under 16,000 chars, flat as the user's data grows.
- **Tests.** PCK-01..07.

#### S3.3 — State gate and lanes

New `scheduler/v6/`:

| File | Responsibility |
|---|---|
| `gate.ts` | open task in stream · active episode · bridge or entity in an active space · addressed to the twin. Under 100 ms, code only |
| `burst.ts` | K=4 content-new events on one stream within W=180 s |
| `cold.ts` | idle/max presets, bootstrapping 60/180, 30 s floor, 20k char cap, never fires empty |
| `history.ts` | one calendar day, newest first, split at 30k chars at the largest gap, empty days skipped |
| `digest.ts` | tier-3 weekly, empty weeks skipped |
| `attempts.ts` | 3 strikes → dead-letter → ops quarantine |

- Slot cap, keyed in-flight and revalidate-at-execution become invariants of the new dispatcher.
- `providers/pool.ts` gains lane `live` with a reserved slot.
- Old `scheduler/` deleted in the same commit.
- **Tests.** BND-01..12, GATE-01..10.

#### S3.4 — Stream keys

- `chains.ts`: `wa:<jid>` · `browser:<browser>:<profile>:<domain>:<day>` · `screen:<bundleId>:<session>` · `doc:<path>`.
- Fresh database, so no migration.

### 6.2 Lanes

#### S3.5 [A] — Orient `orient.v7` and Critic `critic.v5`

- v7 = v6 schema plus stream tag, untrusted block, thin-context mode.
- Critic gains the mechanical coverage check and grades bridges and edges.
- **Tests.** ORIENT golden ≥ baseline; CRI-01..04.

#### S3.6 [B] — Extract `extract.v6`

- Claims with typed fields; people, roles, tone, feelings.
- Self-reported provenance for bar events; supersede-or-coexist judgement.
- **Tests.** FACT-01..06, TYP-01..03.

#### S3.7 [C] — Decide `decide.v9`

- Per space: summary, latest, plan, milestones (only if staged), tasks, schedules, closures, follow-ups.
- TIM-04 rule: never fire before the evidence says the window opens.
- Space-birth dedupe via the critic.
- **Tests.** DEC-01..06, TIM-01..04.

#### S3.8 [D] — Tiering and digest

- Cached tiering call for the business split; code decides replied-versus-not.
- Promotion instant and retroactive.
- `digest.v2` weekly.
- **Tests.** TIER-01..04, DIG-01..02.

#### S3.9 [E] — Consolidation on change, eval isolation

- Hourly merge/split only over what changed; deep pass when idle.
- Dispatcher ignores `origin='eval'`.
- **Tests.** CON-01..03, IDEM-01.

### 6.3 Exit S3

- **Release.** `V6P1S3_13.8.x`
- **Gates.** BND · GATE · CMT · PCK · ORIENT ≥ baseline · CRI · FACT · TYP · DEC · TIM · TIER · DIG · CON · IDEM · CROSS-N2

---

## 7. Stage 4 — Live path, executor-lite, assist

> **Goal.** One live call that understands and decides; prepared work; delivered on the Mac.
> **Backlog.** T3-2..10.

### 7.1 SERIAL

#### S4.1 — `live.v1`

- One call, two sections: `understanding` (byte-compatible with `orient.v7`) and `decide` (tasks, schedules, closures, questions, prepared actions with `grounded_in`, intent, confidence, urgency, deadline).
- Section-independent parsing: a bad `decide` never blocks a commit; a bad `understanding` never blocks a nudge.
- Code discards `decide.prepared` when `lane !== "live"`.
- **Tests.** LIV-01..06.

#### S4.2 — Executor-lite

- **Where.** `executor/lite.ts`.
- Bounded loop, 3–8 turns, over `web_fetch`, `world_read`, `world_write_draft`.
- Cycle and money ceilings recorded in the trace.
- Thin context produces one combined question card, never an assumption.
- Artifacts carry evidence.
- **Tests.** EXE-01..05.

#### S4.3 — Surface router and nudge

- `surface-router.v1` — Mac active → card plus panel; otherwise panel, Prepared shelf, space, timeline. The router decides **where**, never whether.
- Nudge card: intent line · what I did · artifact peek · Open · Not now · 60-second auto-close.
- Unread counter, merge window per space, decay order, blocked kinds, intent-confidence floor.
- **Tests.** NUD-01..09.

#### S4.4 — Retire `assist/`

- Delete watcher, evaluator, tick, cursor, gate.
- Behavioural thresholds move to `settings.ts` and the output-side `nudgeVerdict()`.
- **Tests.** LIV-02, LIV-07.

### 7.2 Lanes

#### S4.5 [A] — WhatsApp send gate and approval card

- `approvals/` mints a single-use signed token on a tap; the daemon refuses without it.
- The approval card shows exactly what will be sent and to whom; editing invalidates the token.
- **Tests.** GATE-A-01..03.

#### S4.6 [B] — Brief

- Composed by code at the set times; `brief.v2` writes prose only on a delta.
- **Tests.** BRF-01..02.

#### S4.7 [C] — Injection surfacing

- Detector for directive text inside captured content; surfaced as a card with its source, never acted on.
- Tool arguments originating in captured text are validated against the world model before use.
- **Tests.** INJ-01..04.

### 7.3 Ship gate for S4

All four must hold before `assist/` is deleted:

1. ORIENT golden set ≥ baseline.
2. AST parity on the re-homed LIV cases.
3. CROSS-N50 — one space, two episodes, exactly one nudge citing both sources.
4. A history bundle containing a stale "pay by 5 pm" emits **zero** prepared actions.

**Fallback if it regresses.** Keep the merged pack, make two calls, do not delete `assist/`.

### 7.4 Exit S4

- **Release.** `V6P1S4_13.9.x`
- **Gates.** LIV · EXE · NUD · GATE-A · BRF · INJ · CROSS-N50

---

## 8. Stage 5 — World model surfaces and the bar

> **Goal.** Spaces, tasks, calendar, people and the bar behave as the product spec says.
> **Backlog.** T5-6/7, T7-5/6.

All six lanes run in parallel.

#### S5.1 [A] — Spaces

- **Birth.** Inferred → propose-only queue, graduating to auto after two clean weeks. Asked-for → created instantly, never proposed. Woken → reactivated with old evidence.
- **Sweep.** Runs at every birth over unsorted and the log, with a preview on proposals.
- **Dedupe.** Via the critic, even for user-created spaces.
- **Unsorted.** Weekly review only when it changed; archives at 30 days, still sweepable.
- **UI.** List by life area; view with a why-panel on every element; drag to re-file.
- **Tests.** SPC-01..08.

#### S5.2 [B] — Tasks and scheduler

- Explicit, implicit and suggested tasks; suggested is marked and uncapped.
- Scheduled steps and wait-until; follow-ups on close; owner resolved from roles.
- **Closure rules.** Hard evidence closes · one-sided intent makes a timed check · past due asks "done?" by code · cancellation closes as cancelled.
- Prioritized list with sections and an explained score.
- Wake-ups are lookups before they are calls.
- **Tests.** TSK-01..02, SCH-01..03, FUP-01, plus the V2 SCH and FUP cases carried.

#### S5.3 [C] — Calendar (derived) and time

- Layers: my events · my tasks · twin's tasks · people.
- Chat-derived events tentative until confirmed.
- Lead-time planning with snooze, by circle.
- Three clocks: message time, processing time, view time. Recurrence rules.
- **Tests.** CAL-01..05, TIM-01..04.

#### S5.4 [D] — People and CRM

- Resolution ladder; provisional people; merge and split by drag with undo.
- Circles inferred from content, tone, claims, metadata.
- Tone memory kept apart for DMs and groups; address terms classified discriminating or generic.
- Follow-up radar; dates with plan-or-wish; the "Who I am" card built by processing.
- **Tests.** ROL-01..10, CIR-01..04, CRM-01..05.

#### S5.5 [E] — Grounded bar

- `route.v1` returns class plus plan → code executes the five methods → RRF → reranker → `judge.v1`.
- Sufficiency checked in code per class; partial answers carry the coverage caveat; general answers labelled.
- The bar creates the named thing immediately; the rest of the utterance goes down the live path.
- Thread locks to the object it just made.
- `correction-parse.v3`, quick chips, behavioral memory, golden-case drafting.
- **Tests.** BAR-01..10, USR-01..06, FIX-01..09.

#### S5.6 [F] — Settings and Runs

- All P1 setting groups per product spec §25.
- Per-step model, reasoning and on/off, with the golden set run on any change.
- Trace viewer with run diff, quarantine, undo run.
- **Tests.** SET-01..03.

### 8.1 Exit S5

- **Release.** `V6P1S5_13.10.x`
- **Gates.** SPC · TSK · SCH · FUP · CAL · TIM · ROL · CIR · CRM · BAR · USR · FIX · SET

---

## 9. Stage 6 — Graduation

1. **Full suite.** Carried categories ≥ baseline; all P1 categories green; every hard gate green.
2. **Fresh install** on a clean macOS account: consent → 30-day import → first proposed space within 2 minutes → card cost within ±40%, time within ±30%.
3. **Week-one measurements logged.**
   - Screen events per day after content-hash dedup (the 725/day assumption).
   - Live calls per day; hot and cold freshness medians.
   - `cache_read_input_tokens` from the two-call test (V6 open question 6).
4. **Human steps.** Real-phone WhatsApp pairing · nudge card on a real Mac session · screen consent flow on a second account.
5. **V13 PENDING fixtures** — CIR-01..03, FIX-06, BRW-04/06/07 — resolved or deferred with reasons.
6. **Release.** `SuperTwinV13_V6P1S6_13.11.x.dmg`

---

## 10. Cross-stage release checklist

- [ ] `trace_coverage = 100%` and `pass_liveness = 100%`
- [ ] SPD-01..08 · BND-08..12 · CNS-01..09
- [ ] ORIENT golden ≥ `evals/baseline/v13.json`
- [ ] `false_receiver_assignment = 0` · `guess_rate = 0` · `risky_without_token = 0` · `login_automation = 0`
- [ ] `assist_from_history = 0` · `nudge_without_grounding = 0` · `content_gated_call = 0`
- [ ] `packer_enumeration = 0` · `packer_escalation = 0` · `full_vector_scan = 0`
- [ ] `injection_acted = 0` · `fabricated_evidence = 0` · `clock_only_call = 0`
- [ ] Pack size under 16,000 chars on the 104-space fixture
- [ ] `lsof -i:8013` empty after the full test run
- [ ] DMG recorded in `RELEASES.md`

---

## 11. Backlog traceability

Every item in `docs/implementation-backlog.md` lands somewhere, or is explicitly dropped.

| Backlog | Task |
|---|---|
| T0-1..3 | S0.3 (temporary) → S3.3 (invariant) |
| T0-4..8 | S0.2 |
| T0-9 | S3.3 `attempts.ts` |
| T0-10..12 | S0.7 |
| T0-13 | S0.8 |
| T0-14 | S0.10, S4.4 |
| T0-15 | S0.2 |
| T1-1, T1-2 | S0.4 |
| T1-3 | deferred — needs its own eval pass |
| T1-4 | settled: CLI door (product decision D5) |
| T2-1..10 | S3.1–S3.4 |
| T3-1 | S3.3 — pool lane `live` |
| T3-2..10 | S3.2, S4.1–S4.4 |
| T4-1..13 | S1.1–S1.8 |
| T4-14 | S0.6 — data removed, not migrated |
| T5-1 | S1.1 — `archive` |
| T5-2, T5-3 | S2.2, S2.4 |
| T5-4 | S1.6 |
| T5-5..7 | S1.8 |
| T5-8 | deferred — Google Takeout import |
| T6-1..4 | S1.4 |
| T6-5 | S3.9 |
| T6-6 | S0.5 — drop lists deleted |
| T6-7..17 | S1.6, S3.2, S3.8 |
| T6-18..23 | deferred to P2 — the writing lens needs screen roles, which land in S1.6 |
| T6-24..27 | not in P1 — product decision D7 |
| T7-1 | S4 ship gate |
| T7-2 | S3.5 |
| T7-3 | S0.3 and S3.3 |
| T7-5 | S3.7 |
| T7-6, T7-8 | S6 |
| T8-1..3 | S0.9 |
| T8-4 | S3.2 — seconds in event heads |
| T8-5 | **dropped** — the chain root is not carried; domain+day is the key |

---

## 12. Parallelization plan

### 12.1 Order within each stage

| Stage | Serial first | Then in parallel | May start when |
|---|---|---|---|
| S0 | S0.1 → S0.2 → S0.3 → S0.4 → S0.5 → S0.6 | S0.7 · S0.8 · S0.9 · S0.10 | — |
| S1 | S1.1 → S1.2 → S1.3 | S1.4 · S1.5 · S1.6 · S1.7 · S1.8 | S0 done |
| S2 | S2.1 → S2.2 | S2.3 · S2.4 · S2.5 · S2.6 · S2.7 | S1.1 done — needs the schema only |
| S3 | S3.1 → S3.2 → S3.3 → S3.4 | S3.5 · S3.6 · S3.7 · S3.8 · S3.9 | S1.2, S2.4 and S2.6 done — the packer needs T0 and bridges |
| S4 | S4.1 → S4.2 → S4.3 → **gate** → S4.4 | S4.5 · S4.6 · S4.7 | S3 done |
| S5 | — | S5.1 · S5.2 · S5.3 · S5.4 · S5.5 · S5.6 | S3 done; S5.5 needs all of S2 |
| S6 | 1 → 2 → 3 → 4 → 5 → 6 | — | S4 and S5 done |

### 12.2 Critical path

```
S0 ─► S1.1–S1.3 ─► S2.4 / S2.6 ─► S3.1–S3.4 ─► S4.1–S4.4 ─► S6
        │                │                          │
        └─ S1 lanes ─────┘                          └─ S5 lanes (overlap S4)
```

- S2 lanes overlap the S1 lanes once `0200_v6_core` has landed.
- S5 overlaps S4 entirely, except S5.5, which waits for all of S2.

### 12.3 Agent budget

- One orchestrator per stage.
- One agent per lane.
- One gate agent per stage, running that stage's eval categories.
- Every agent reports the ports it opened and the model calls it made.
