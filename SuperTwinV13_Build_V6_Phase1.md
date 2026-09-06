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

## 0. Build status

| Stage | Status | Release |
|---|---|---|
| S0 — Ground clearing and rails | ✅ done 2026-09-06 | 13.5.1 · `releases/SuperTwinV13_V6P1S0_13.5.1.dmg` |
| S1 — Consent, archive, adapters | ✅ done 2026-09-06 | 13.6.1 · `releases/SuperTwinV13_V6P1S1_13.6.1.dmg` |
| S2 — Index and T0 retrieval | ✅ done 2026-09-06 | 13.7.1 · `releases/SuperTwinV13_V6P1S2_13.7.1.dmg` |
| S3 — Understanding core | ✅ done 2026-09-06 | 13.8.1 · `releases/SuperTwinV13_V6P1S3_13.8.1.dmg` |
| S4 — Live path, executor-lite, assist | ✅ done 2026-09-06 | 13.9.1 · `releases/SuperTwinV13_V6P1S4_13.9.1.dmg` |
| S5 — World model surfaces and the bar | ✅ done 2026-09-06 | 13.10.1 · `releases/SuperTwinV13_V6P1S5_13.10.1.dmg` |
| S6 — Graduation | ✅ done 2026-09-06 | 13.11.1 · `releases/SuperTwinV13_V6P1S6_13.11.1.dmg` |
| S6b — Residual closure | ✅ done 2026-09-06 | 13.11.2 · `releases/SuperTwinV13_V6P1S6b_13.11.2.dmg` |
| S6c — Worker-unreachable fix | ✅ done 2026-09-06 | 13.11.5 · `releases/SuperTwinV13_V6P1S6c_13.11.5.dmg` |

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
| `assist/` — watcher, evaluator, tick, cursor, gate (`executor-lite.ts` moves to `executor/lite.ts`) | S4 gate · **deleted at S6b** (R1 `3e6836f`) — the gate went green at S4 and the deletion was a refactor, so it trailed the gate by two stages |
| Engagement tiers (hot/warm/cold delays) | S0 |
| `INTENT_RE` gating and low-signal deferral | S0 |
| Tracker blocklist and `isDroppableTrackerHop` | S0 |
| `content_pending` | S0 |
| `sources.connected_at`, `sources.enabled` | S0 |
| 5-minute dispatch windows and the per-stream orphan scan | S0 |

---

## 3. Stage 0 — Ground clearing and rails

**STATUS:** ✅ done 13.5.1 (2026-09-06) — all ten tasks landed, gates verified (SPD-04 partial pending T1-3; TRC-03 red by design until S3). Detail in `progressV13_V6_Phase1.md`.

> **Goal.** The tree is safe, clean and empty. **No new design lands here.**
> **Backlog.** T0-1..15, T1-1/2, T8-1..3.

### 3.1 SERIAL

#### S0.1 — Freeze the baseline ✅ `9ec9d1c` — recorded; TIM-04 fail and SCH 63% are the tree's truth

- **Change.** Run the V2 golden suite once on the current tree. Store per-category scores in `evals/baseline/v13.json`.
- **Accept.** `npm run eval -- --baseline` prints it.

#### S0.2 — Spend and process rails ✅ `92567f5`

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

#### S0.3 — Disarm the old dispatcher (temporary until S3) ✅ `bfae619`

- **Change.**
  - Cap `admittedOrphans` at `cfg.slots - slotted.length` — `scheduler/dispatch.ts:626-635`.
  - Key the in-flight set — `brain/consumer.ts:146`.
  - Re-check `dispatched_at` at the top of `runBrainTick`.
- **Tests.** BND-08..10 against the old dispatcher.
- **Note.** This code dies in S3. It exists so the tree is safe until then.

#### S0.4 — Transport stage 1+2 ⚠️ `5aa7201` — landed; SPD-04 cost $0.0068 > $0.006 target, pending T1-3

- **Where.** `providers/claude-local/index.ts`.
- **Change.** `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`; remove the double prompt send at `:184-191`; add `--no-session-persistence`, `--max-budget-usd`, `--safe-mode`, `--strict-mcp-config`.
- **Tests.** argv snapshot; SPD-04 and SPD-05 on one live call.

#### S0.5 — Prune ✅ `f35b598` — no production dispatch path remains; S3 must wire `runDispatchTick`

- **Change.** Delete everything marked delete in §2.3, plus the tests asserting it. Fill the `IMPORT_RANGES` gaps (`3d`, `3y`, `4y`).
- **Accept.** `tsc` clean, `npm test` green, `/api/health` boots on a scratch home.

#### S0.6 — Remove the data ✅ `d1ea9da` — db sha256 `e3458fb7…058e78`

- **Change.** Copy `~/SuperTwinV13/supertwinv13.db` and `traces/` to `~/SuperTwinV13-incident-2026-08-29/`, record the hash in `progressV13.md`, delete the home.
- **Accept.** Fresh home has zero events.

### 3.2 Lanes

#### S0.7 [A] — Breaker, quota, waiters ✅ `ccf652b` + `e2c393b`

- `brain/llm.ts` calls `pool.noteSuccess` / `pool.noteFailure`; 10 consecutive failures pause a lane and raise a banner.
- `logRun` calls `db.addUsage`.
- `pool.ts` caps waiters at 4× capacity and exposes `waiting` on `/api/ops`.
- **Tests.** SPD-07, SPD-08, BND-12.

#### S0.8 [B] — Kill switch and heartbeat ✅ `45cc1a2`

- `app_state.model_activity_paused` checked beside the budget.
- "Stop all model activity" in `GeneralPanel.tsx`; `/api/ops/lanes/pause` binding in `src/lib/api.ts`; drop `MAX_MANUAL_PAUSE_MS`.
- `[spend] 60s: …` heartbeat in the operator log.
- **Tests.** SPD-03, SPD-06.

#### S0.9 [C] — Ledger hygiene ✅ `7def8ea`

- Populate `runs.pass` and `runs.origin` at insert.
- Write the trace row in the same transaction as `extraction_runs`.
- Route `digest-pass.ts:142`, `grounded/handlers.ts:170` and `media/describe.ts:600,711` through the pool.
- **Tests.** No NULL `pass`; `runs` count equals `traces` count.

#### S0.10 [D] — Latent loops ✅ `1185e12`

- `whatsapp/adapter.ts` `cleanRestart()` gets backoff and a give-up threshold.
- The assist accumulator loop dies with `assist/` in S4; until then, reset it on every exit path.

### 3.3 Exit S0

- **Release.** `V6P1S0_13.5.x`
- **Gates.** Baseline file present · SPD-01..08 · BND-08..10, BND-12 · TRC-01..03
- **Verified 2026-09-06:** baseline ✅ · SPD-01..03/05..08 ✅, SPD-04 ⚠️ partial (T1-3) · BND-08..10/12 ✅ · TRC-01/02 ✅, TRC-03 ✗ expected (pass_liveness 17%, no background pipeline until S3).

---

## 4. Stage 1 — Consent, archive, adapters

**STATUS:** ✅ done 13.6.1 (2026-09-06) — all eight tasks landed; gates verified (CNS-01..09, SRC-01..04/09/10 green as deterministic suites, containment 100% on the BND-01 mock import, 0 live calls). Detail in `progressV13_V6_Phase1.md`.

> **Goal.** Nothing captured before yes. Everything consented to is indexed. Only the window is understood. Screen keeps what it captured.
> **Backlog.** T4-1..14, T6-5..8, T6-12/13/16/17.

### 4.1 SERIAL

#### S1.1 — Migration `0200_v6_core` ✅ `b1386fa` — V2 `coverage` renamed `coverage_progress`; `episode_events.event_id` added additively (range readers survive until S3.1)

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

#### S1.2 — The consent gate ✅ `785b1d4` — gate enforced unconditionally in production; legacy suites open it via `test-setup.ts`

- **Where.** `db/eventlog.ts:229` and `db/ingest.ts:1396` — the two single-writer funnels.
- **Change.** `captureAllowed(source)` at both. Tier predicate at write: outside Understand → `origin='archive'`, `dispatched_at=capture_ts`.
- **Widening.** `UPDATE … SET dispatched_at=NULL, origin='backfill' WHERE ts>=?` — a replay, resumable, never a re-import.
- **Tests.** CNS-01..04.

#### S1.3 — Boot inversion ✅ `d9e2980` — `SourceSupervisor`; WhatsApp QR pairing is the one pre-consent spawn; `screenwatch --check-permission`

- `worker/src/index.ts` starts an adapter only on a `connected` consent row.
- Screen sidecar spawns after consent → Accessibility → explicit "Record from now on".
- `sinceMs` becomes **required** in `browser/watcher.ts` so the 90-day floor cannot return by omission.
- **Test.** CNS-01 — 60 s, zero events, no daemon, no sidecar.

### 4.2 Lanes

#### S1.4 [A] — Browser connect ✅ `c35d5fe` — SRC eval category (hand-authored) added; FDA deep link returned but not yet wired to `openExternal`

- **Discovery.** `discoverProfiles()` enumerates every browser and every profile: Chrome, Brave, Arc, Edge, Comet, Safari.
- **Counts.** Copy-then-read per window; plateau copy ("Chrome keeps 90 days"); Safari Full Disk Access message; local-path disclosure.
- **Card.** No longer gated on `event_count === 0`.
- **URLs.** Param strip at emit in the `text` field only (extend `bridges/normalise.ts`; whitelist `path` on `*.localhost:7373`); raw URL on the payload; transition and `visit_count` on the payload; 30-second duplicate collapse at render.
- **Tests.** SRC-01, SRC-02, SRC-10.

#### S1.5 [B] — WhatsApp connect ✅ `cfef719` — `count_range` in the Go daemon; live messages held until a window is installed; SRC-09 judge half waits on T6-17 (S3)

- Flow: pair → buffer → `messagesInRange` counts → windows → confirm.
- No live ingest between pairing and confirm.
- Reply, reaction, forward, mention and audience carried on the envelope.
- **Tests.** CNS-09, SRC-09.

#### S1.6 [C] — Screen ✅ `8dfb719` — anchor + diff into `blobs`; new-chars floor lives in the sidecar Deduper

- `envelope.ts:95` persists full text as anchor + diff into `blobs`.
- `consumer.ts:44` sets `source`; identity (app · title · doc key) on the envelope.
- Roles from `Live.swift:216,224` carried in `RawCapture`; structure-aware hash in `main.swift:62`.
- `""` docKey fallback fixed — `Live.swift:167`.
- New-chars floor on switch triggers.
- Pause persisted in `app_state` and seeded at boot — `adapter.ts:171`.
- **Tests.** SRC-03, SRC-04.

#### S1.7 [D] — Filter, verbs, indicator ✅ `cdd466a` — `capture.paused_until` now read at the funnel (V13 pauses-nudges-only defect fixed); banking never-list is user-list driven

- Never-list plus user lists (apps, sites, chats, senders) enforced at the funnel.
- Private moment — 15 minutes, menu bar and hotkey.
- Forget last N minutes with preview, routed through `hardDeleteEvents`.
- Pause / disconnect / delete per source with a `CascadeReport` preview; `resetSourceData` removed.
- Consent flips **before** teardown.
- Tray shows real capture state with one-click stop.
- **Tests.** CNS-05..08.

#### S1.8 [E] — Confirm card and Library ✅ `9aa1b86` — `ConfirmCard` reachable via Library › Storage › Change windows; not yet embedded in the three connect flows; disk budgets stored, not enforced

- Confirm card: four numbers with accuracy labels; text stored verbatim in `decisions`.
- Library per source: two bars (searchable · understood), bytes per tier, free disk first, two disk budgets.
- **Tests.** CNS-09, RET-04.

### 4.3 Exit S1

- **Release.** `V6P1S1_13.6.x`
- **Gates.** CNS-01..09 · SRC-01..04, SRC-09, SRC-10 · containment ≥ 95% on a mock import

---

## 5. Stage 2 — Index and T0 retrieval

**STATUS:** ✅ done 13.7.1 (2026-09-06) — all seven tasks landed; gates verified (RET-01..10, BAR-01 green as deterministic suites, `full_vector_scan = 0`, 0 live calls). One gate fix (`b8c6f82`, semantic report TOCTOU). Detail in `progressV13_V6_Phase1.md`.

> **Goal.** Five methods over one index, fused by rank, zero model calls, packer-ready.
> **Backlog.** T5-2/3; retrieval decision-record work items 1–6.

### 5.1 SERIAL

#### S2.1 — Migration `0201_v6_graph` ✅ `724af78` — typed `status` stored as `claims.typed_status` (lifecycle `status` kept); bridge edges live in `bridges`, not `entity_edges` (FK)

- `entity_edges` — kind, subtype, src, dst, confidence, status, valid_from, valid_to
- `edge_evidence` — event ids plus verbatim quote
- Typed-field columns on `claims` — amount, currency, date, status, merchant, order_id, location, duration_s
- `chunks` and `chunk_embeddings` — int8, rowid key, 16 KB pages
- `hub_nodes`
- **Test.** Migrate; `self` seeded as a hub.

#### S2.2 — Embeddings ✅ `98254a7` — legacy `event_embeddings` still filled alongside chunks; Settings card not yet showing chunk counts

- EmbeddingGemma 300M downloads on first run; a bundled small encoder covers search until then.
- Background re-embed, flipped in one transaction.
- **Chunk units.**
  - chat — rolling 2k chars per stream
  - screen — 2k chars of the reconstructed document, recomputed on re-anchor
  - browser — one per visit, deduped by content hash
  - plus episode summaries, space cards, claims, people cards
- **Tests.** RET-03, RET-05.

### 5.2 Lanes

#### S2.3 [A] — Lexical and the FTS projection ✅ `48d949d` — migration `0202_v6_fts_projection`; `lexical.ts` ranks consumed by S2.4 fusion only via events_fts (chunks_fts fusion pending)

- FTS gains app, window_title, doc_key.
- BM25 over chunks and cards.
- **Test.** RET-06.

#### S2.4 [B] — RRF and reranker ✅ `11d5c54` — `hybridSearch()` built for the S3 packer; `retrieve.ts` still seeds from `semanticSearch`; reranker download not yet in Settings

- `retrieval/semantic.ts`: bounded candidates (FTS top 2,000 + vector top-k) → RRF at k=60 → cross-encoder (bge-reranker class, local).
- Delete the full-vector process cache. `rank()` kept verbatim.
- **Tests.** RET-01, RET-02.

#### S2.5 [C] — Structured and time window ✅ `7f0a94d` — heuristic T0 planner until the S4 router; neither method fused into `retrieveContext` yet

- SQL method over typed fields: sum, count, range, status filter, enumerate by type.
- Time-window scan over the log, unscored.
- **Tests.** RET-07, RET-08.

#### S2.6 [D] — Graph ✅ `0829ac8` — `mentions` rows only from `writeMention` (S3 commit path must write them); `[BRIDGED]` block built, not mounted in the packer

- Bridges written as edges at ingest — URL, phone, order id.
- BFS walk in TypeScript: seeds from lexical and vector, ≤ 2 hops, decay 0.6, fan-out cap, status and validity pruning, hub exclusion.
- **Tests.** RET-09, RET-10.

#### S2.7 [E] — Coverage index and type-ahead ✅ `017b26f` — `promoteDay` not yet called by indexer/consolidation; Library coverage strip is S5

- `coverage` rows maintained by adapters; `coverageCaveat(source, range)`.
- Bar type-ahead at T0, under 150 ms, over events, episodes, spaces, tasks, people, claims.
- **Tests.** RET-04, BAR-01.

### 5.3 Exit S2

- **Release.** `V6P1S2_13.7.x`
- **Gates.** RET-01..10 · BAR-01

---

## 6. Stage 3 — Understanding core

**STATUS:** ✅ done 13.8.1 (2026-09-06) — all nine tasks landed; gates verified (BND 12 · GATE 10 · CMT 5 · PCK 7 · CRI-04 · FACT 6 · TYP 3 · DEC 6 · TIER 3 · DIG-01 · CON 3 · IDEM 1 · CROSS-N2 green as code fixtures, 59/59; live: TIM 4/4 and TIER-03 best-of-2 green, CRI-01 green; ORIENT golden 10/10 under v7/v5 (S3.5) but 9/10 under the shipped v6/v4 default on the new pack — TOP-08 ⚠️; CRI-02/03 and DIG-02 ⚠️ red on model judgement). One gate fix (`6fd3cf8`: HEAD did not compile — S3.8's `flipInChunks` was uncommitted; three stale test pins; CROSS-N2 authored; digest evidence shape; CRI PROPOSAL rendering). 55 live calls. Detail in `progressV13_V6_Phase1.md`.

> **Goal.** The state gate, the day-bundler, grounded commit, and the understanding passes on the new pack.
> **Backlog.** T2-1..10, T3-1, T6-7/9/10/11, T7-2.

### 6.1 SERIAL

#### S3.1 — Commit rewrite ✅ `1736cde` — range readers (packer/history, thin-pack, gate, graph…) still walk start/end rowid over ranges of one; `mentions` still not written by the commit path

- **Where.** `brain/commit.ts`.
- **Change.**
  - Write `episode_events` rows.
  - Derive `episodes.stream_id` from resolved events; enforce single-stream (model tags `"stream":"S1"`, code enforces).
  - Per-item salvage; cursor advances on event ids.
  - Evidence must resolve to real ids with verbatim quotes, or the item rejects.
- **Keep.** `parseOrientOutput`, `resolveEventAliases`, `buildCriticInput`.
- **Tests.** CMT-01..05.

#### S3.2 — Packer rewrite ✅ `1952117` — `[EPISODES]` rendered inside `<untrusted>`; reranker not run inside the packer (RRF order feeds the five); orient.v6 does not name the new block headers

- **Blocks.** `[NOW]` · `[ROSTER]` · `[OPEN TASKS]` · `[CALENDAR]` · `[CANDIDATE SPACES]` (T0 retrieval, cap 5, with exemplars) · `[BRIDGED]` · `[THREAD S<k>]` · `[EPISODES]` · `[BUNDLE]`.
- **Rendering.** Sections by stream; event heads carry `time · source · app · title · doc`; all captured text inside one `<untrusted>` block.
- **History.** Episode-bounded: 1,500 chars per stream, 5 streams, quoted messages always fetched.
- **Truncation.** Budgeted from the remaining allowance — floor 400, ceiling 4,000.
- **Thin context.** Flag set when the packer cannot assemble enough.
- **Budget.** Whole pack under 16,000 chars, flat as the user's data grows.
- **Tests.** PCK-01..07.

#### S3.3 — State gate and lanes ✅ `e2021fc` — history days are UTC; GATE-10 replay is a synthetic corpus; dispatcher runs in production boot on the frozen orient.v6

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

#### S3.4 — Stream keys ✅ `3b852a0` — `streams.external_key` stays the bare JID for daemon-facing paths; day slot is UTC

- `chains.ts`: `wa:<jid>` · `browser:<browser>:<profile>:<domain>:<day>` · `screen:<bundleId>:<session>` · `doc:<path>`.
- Fresh database, so no migration.

### 6.2 Lanes

#### S3.5 [A] — Orient `orient.v7` and Critic `critic.v5` ⚠️ `82a473a` — TOP 10/10 under v7/v5; defaults stay v6/v4 until the S4 gate; CRI-02 (half-fit flag) and CRI-03 (downgrade vs reject) red under critic.v5 twice at the gate — P-03 needs a critic.v6 iteration; ROL executor still unbuilt

- v7 = v6 schema plus stream tag, untrusted block, thin-context mode.
- Critic gains the mechanical coverage check and grades bridges and edges.
- **Tests.** ORIENT golden ≥ baseline; CRI-01..04.

#### S3.6 [B] — Extract `extract.v6` ✅ `71c435c` — recorded outputs hand-authored to P-04; month-precision dates drop to null; kinds bounded by CLAIM_KINDS

- Claims with typed fields; people, roles, tone, feelings.
- Self-reported provenance for bar events; supersede-or-coexist judgement.
- **Tests.** FACT-01..06, TYP-01..03.

#### S3.7 [C] — Decide `decide.v9` ✅ `702d985` — `runClosureChecks` not yet on a timer (S5.2); bar-created spaces should call `findBirthDuplicate` (S5.1); TIM-04 needs the model to emit `window_opens_at`

- Per space: summary, latest, plan, milestones (only if staged), tasks, schedules, closures, follow-ups.
- TIM-04 rule: never fire before the evidence says the window opens.
- Space-birth dedupe via the critic.
- **Tests.** DEC-01..06, TIM-01..04.

#### S3.8 [D] — Tiering and digest ⚠️ `8a5060f` — `flipInChunks` landed only at the gate (`6fd3cf8`); DIG-02 live: shape now passes code after the evidence-shape note in the user block, judge dings the volunteers line surfaced as a claim; first-boot tiering pass may spend one tier.v1 call per never-replied business

- Cached tiering call for the business split; code decides replied-versus-not.
- Promotion instant and retroactive.
- `digest.v2` weekly.
- **Tests.** TIER-01..04, DIG-01..02.

#### S3.9 [E] — Consolidation on change, eval isolation ✅ `749de45` — near-duplicate signal is exact label equality; merge-question answer path not yet on a route (S5); older executors still seed `origin='live'` inside the sandboxed eval home

- Hourly merge/split only over what changed; deep pass when idle.
- Dispatcher ignores `origin='eval'`.
- **Tests.** CON-01..03, IDEM-01.

### 6.3 Exit S3

- **Release.** `V6P1S3_13.8.x`
- **Gates.** BND · GATE · CMT · PCK · ORIENT ≥ baseline · CRI · FACT · TYP · DEC · TIM · TIER · DIG · CON · IDEM · CROSS-N2

---

## 7. Stage 4 — Live path, executor-lite, assist

**STATUS:** ✅ done 13.9.1 (2026-09-06) — all seven tasks landed; §7.4 exit gates all PASS (LIV 7/7 · EXE 5/5 · NUD 9/9 · GATE-A 3/3 · BRF 2/2 · INJ 4/4 · CROSS 2/2 incl. CROSS-N50) and the §7.3 ship gate's four items ALL hold — ORIENT golden TOP **10/10 = 100%** vs the frozen baseline under orient.v7 + critic.v5 (21 counted calls; the two earlier in-stage samples were 9/10 and 8/10, so best-of-2 after the harness fix is 10/10 and the variance is a recorded residual), AST parity holds, CROSS-N50 green, a stale "pay by 5 pm" history bundle emits zero prepared actions. Every hard gate PASS (assist_from_history · nudge_without_grounding · injection_acted · risky_without_token · login_automation · clock_only_call · unbounded_loop all 0; content_gated_call 100% over 11 GATE cases). Eval `--mode code --ast-parity` 152 pass / 0 fail / 2 by-design pending, ZERO model calls. ✅ **CLOSED AT S6b.** The clause that stood here — "`assist/` is NOT deleted and the defaults are still v6/v4/two-call" — is no longer true: S6 flipped the prompt pair to v7/v5 and S6b's R1 (`3e6836f`) flipped `DEFAULT_LIVE_MODE` to `merged` and deleted the lane. The live path now spends ONE call per bundle. Two gate commits (`ce58b25` in-stage; `7df72f1`: five reds attributed and fixed — a db→brain import ring that left the BUNDLED whisper model with no id, the brief's missing Settings stem, the P3.5 demo's unbound mint, AST-02 spending live calls in a `--mode code` run, and an AST seeder stamping events in the FUTURE before 2pm, which broke CON-01 and reproduces at the S3 release commit). 38 live calls. Detail in `progressV13_V6_Phase1.md`.

> **Goal.** One live call that understands and decides; prepared work; delivered on the Mac.
> **Backlog.** T3-2..10.

### 7.1 SERIAL

#### S4.1 — `live.v1` ✅ `10e7213` — one call, two sections, section-independent parsing; `decide.prepared` discarded off the live lane; grounding through the pack's alias table; below the 0.7 intent floor the work is shelved, never carded

- One call, two sections: `understanding` (byte-compatible with `orient.v7`) and `decide` (tasks, schedules, closures, questions, prepared actions with `grounded_in`, intent, confidence, urgency, deadline).
- Section-independent parsing: a bad `decide` never blocks a commit; a bad `understanding` never blocks a nudge.
- Code discards `decide.prepared` when `lane !== "live"`.
- **Tests.** LIV-01..06.

#### S4.2 — Executor-lite ✅ `6a626fe` — `executor/lite.ts` with both ceilings as CODE refusals written into the trace, thin context checked before the model spends anything, citations only for what was actually fetched; `runPreparedQueue()` still has no caller (draining costs money)

- **Where.** `executor/lite.ts`.
- Bounded loop, 3–8 turns, over `web_fetch`, `world_read`, `world_write_draft`.
- Cycle and money ceilings recorded in the trace.
- Thin context produces one combined question card, never an assumption.
- Artifacts carry evidence.
- **Tests.** EXE-01..05.

#### S4.3 — Surface router and nudge ✅ `eba72af` — the router decides where, never whether; card life rides `nudged_at`/`seen_at` so the unread counter is a query; `router.v1` (P-10) shipped as CODE, since every input is decidable without a model and NUD-01..09 must be deterministic

- `surface-router.v1` — Mac active → card plus panel; otherwise panel, Prepared shelf, space, timeline. The router decides **where**, never whether.
- Nudge card: intent line · what I did · artifact peek · Open · Not now · 60-second auto-close.
- Unread counter, merge window per space, decay order, blocked kinds, intent-confidence floor.
- **Tests.** NUD-01..09.

#### S4.4 — Retire `assist/` ✅ `949c482` + `319e383` (S6) + `3e6836f` (S6b · R1) — the §7.3 fallback engaged at S4 (one pack, two calls) and `gateVerdict()` was re-homed as the output-side `nudgeVerdict()`, closing a 0.7-vs-0.6 split on the same settings row; **the flip checklist is now fully landed** — step 1 (v7/v5) at S6, steps 2 and 3 (live mode `merged`; delete watcher/evaluator/gate/tick/cursor, the nine AST fixtures and `evals/executors/assist.ts`, re-home `assist/artifacts.ts` → `surfaces/artifacts.ts` and `assist/settings.ts` → `settings/assist-settings.ts`) at S6b. `evals/ship-gate.test.ts` was DELIBERATELY KEPT against the checklist's "and this file", with its assertions inverted: three of its four items are behaviour the tree still has to hold, and item 4 has no other home

- Delete watcher, evaluator, tick, cursor, gate.
- Behavioural thresholds move to `settings.ts` and the output-side `nudgeVerdict()`.
- **Tests.** LIV-02, LIV-07.

### 7.2 Lanes

#### S4.5 [A] — WhatsApp send gate and approval card ✅ `07bd14b` (+ `146daf4`) — a token bound to ONE recipient and ONE text, verified independently by the worker and by the Go daemon; editing revokes it; revocation is worker-side only (nothing can bypass `Ingestion.sendMessage` today)

- `approvals/` mints a single-use signed token on a tap; the daemon refuses without it.
- The approval card shows exactly what will be sent and to whom; editing invalidates the token.
- **Tests.** GATE-A-01..03.

#### S4.6 [B] — Brief ✅ `cccb948` (+ `f7c6396`) — code composes the ledger at the set times over the WORLD MODEL only (unread events are not "something moved"), `brief.v2` writes prose only on a delta, any figure not in the ledger is named; no React surface yet

- Composed by code at the set times; `brief.v2` writes prose only on a delta.
- **Tests.** BRF-01..02.

#### S4.7 [C] — Injection surfacing ✅ `2cdd1f0` — a zero-call detector on both ingest funnels, one card per event with the verbatim quote and its source, tool arguments corroborated against the world model before use, and `injectionActed()` measuring the world rather than trusting a comment; `injection_flags` is still a module-owned CREATE TABLE, not a numbered migration

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

**STATUS: ✅ all four hold, and the retirement has RUN (S6b · R1 `3e6836f`).** The fallback was engaged at S4.4 and is now stood down. Item 1 re-measured at the S6b HEAD under the shipped defaults (orient.v7 + critic.v5, `DEFAULT_LIVE_MODE` = `merged`, no env override): TOP **10/10 = 100%** vs the frozen 100%, best-of-2 (sample 1 8/10 — TOP-01 "mono-blob", TOP-06 "split point ambiguous", the second being the identical judge wording the S4 gate recorded as variance; sample 2 10/10, VERDICT green; 21 calls each, both samples kept in `evals/baseline/v13.json` `runs[]`). Items 2–4 are decidable without a model and are asserted by `worker/src/evals/ship-gate.test.ts`, which was kept rather than deleted — a gate whose evidence is removed the moment it goes green cannot be re-checked — with its assertions inverted into a resurrection guard. Item 2 also measures live: `--ast-parity` reports **PARITY HOLDS** with all nine AST rows green, no row left "not measured".

### 7.4 Exit S4

- **Release.** `V6P1S4_13.9.x`
- **Gates.** LIV · EXE · NUD · GATE-A · BRF · INJ · CROSS-N50

---

## 8. Stage 5 — World model surfaces and the bar

**STATUS:** ✅ done 13.10.1 (2026-09-06) — all six lanes landed; §8.1 gates 12 of 13 PASS (SPC · CAL · ROL · CIR · CRM · BAR · SET · SCH · FUP · TIM · USR · FIX green; TSK green as code, its 11 carried live fixtures unmeasured — no frozen baseline binds them and the live budget went to the categories that have one). FIX regressed to 63% against its frozen 100% and was fixed at the gate (`c98fdf0`), then re-measured 100% with `--compare-baseline` green. `false_receiver_assignment` = 0 and `guess_rate` = 0 both PASS. Detail in `progressV13_V6_Phase1.md`.

> **Goal.** Spaces, tasks, calendar, people and the bar behave as the product spec says.
> **Backlog.** T5-6/7, T7-5/6.

All six lanes run in parallel.

#### S5.1 [A] — Spaces ✅ `54a6d1c` — three birth modes, the sweep preview, graduation that flips back on a false auto-merge

- **Birth.** Inferred → propose-only queue, graduating to auto after two clean weeks. Asked-for → created instantly, never proposed. Woken → reactivated with old evidence.
- **Sweep.** Runs at every birth over unsorted and the log, with a preview on proposals.
- **Dedupe.** Via the critic, even for user-created spaces.
- **Unsorted.** Weekly review only when it changed; archives at 30 days, still sweepable.
- **UI.** List by life area; view with a why-panel on every element; drag to re-file.
- **Tests.** SPC-01..08.

#### S5.2 [B] — Tasks and scheduler ✅ `9586650` — suggested is uncapped, wake-ups read before they call; SCH 5/8 → 8/8

- Explicit, implicit and suggested tasks; suggested is marked and uncapped.
- Scheduled steps and wait-until; follow-ups on close; owner resolved from roles.
- **Closure rules.** Hard evidence closes · one-sided intent makes a timed check · past due asks "done?" by code · cancellation closes as cancelled.
- Prioritized list with sections and an explained score.
- Wake-ups are lookups before they are calls.
- **Tests.** TSK-01..02, SCH-01..03, FUP-01, plus the V2 SCH and FUP cases carried.

#### S5.3 [C] — Calendar (derived) and time ✅ `f251286` — four layers, tentative until confirmed, three clocks; TIM 75% → 100%

- Layers: my events · my tasks · twin's tasks · people.
- Chat-derived events tentative until confirmed.
- Lead-time planning with snooze, by circle.
- Three clocks: message time, processing time, view time. Recurrence rules.
- **Tests.** CAL-01..05, TIM-01..04.

#### S5.4 [D] — People and CRM ✅ `a133633` — the ladder (unknown beats wrong), circles from content, merge/split by drag with undo; ROL had no executor at the baseline

- Resolution ladder; provisional people; merge and split by drag with undo.
- Circles inferred from content, tone, claims, metadata.
- Tone memory kept apart for DMs and groups; address terms classified discriminating or generic.
- Follow-up radar; dates with plan-or-wish; the "Who I am" card built by processing.
- **Tests.** ROL-01..10, CIR-01..04, CRM-01..05.

#### S5.5 [E] — Grounded bar ⚠️ `628221e` — route plans, code executes, the judge only quotes; correction-parse.v3 lost three pipeline verbs, fixed at the gate (`c98fdf0`)

- `route.v1` returns class plus plan → code executes the five methods → RRF → reranker → `judge.v1`.
- Sufficiency checked in code per class; partial answers carry the coverage caveat; general answers labelled.
- The bar creates the named thing immediately; the rest of the utterance goes down the live path.
- Thread locks to the object it just made.
- `correction-parse.v3`, quick chips, behavioral memory, golden-case drafting.
- **Tests.** BAR-01..10, USR-01..06, FIX-01..09.

#### S5.6 [F] — Settings and Runs ✅ `2dc8b58` — every §25 group, a model change gated by the golden set, the run level of the trace viewer

- All P1 setting groups per product spec §25.
- Per-step model, reasoning and on/off, with the golden set run on any change.
- Trace viewer with run diff, quarantine, undo run.
- **Tests.** SET-01..03.

### 8.1 Exit S5

- **Release.** `V6P1S5_13.10.x`
- **Gates.** SPC · TSK · SCH · FUP · CAL · TIM · ROL · CIR · CRM · BAR · USR · FIX · SET

---

## 9. Stage 6 — Graduation

**STATUS:** ✅ done 13.11.1 (2026-09-06) — items 1, 3, 5 and 6 done; item 2 done on a scratch home with the mock daemon and its clean-account half handed to item 4; item 4 is human by definition and listed as pending. Four reds found by measuring what actually ships, all fixed at the gate (`319e383`), every category with a frozen rate now at or above it. 346 live calls, shim-counted, none from a unit test. Detail in `progressV13_V6_Phase1.md`.

1. ✅ **Full suite.** Carried categories ≥ baseline; all P1 categories green; every hard gate green. — _Deterministic `--mode code --ast-parity`: 154 cases, 152 pass, 0 fail, 2 pending (TRC-01/03 by design), VERDICT green, ZERO calls, PARITY HOLDS. Live: TOP 100% · CHP 100% (best-of-2) · TIM 100% · TRC 100% · SCH 88% · USR 100% · FIX 100% · FUP 100%, each at or above its frozen rate. The four reds: the shipped orient/critic pair was never the measured one (TOP 80% under v6/v4, 100% under v7/v5 — defaults flipped); TRC-02 spent decide.v8 under the v9 pass id; USR-03 guessed between two spaces (bar-action.v3); CHP-01/03/06 asserted the retired `chapters` vocabulary._
2. ✅⚠️ **Fresh install** on a clean macOS account: consent → 30-day import → first proposed space within 2 minutes → card cost within ±40%, time within ±30%. — _`scripts/fresh-install.mjs`, scratch home + OS-assigned port + mock daemon: 0 model calls before confirm; first proposed space at **106.6 s (HOLDS)**; cost $0.2259 vs $0.3224 = **−29.9% (±40% HOLDS)**; time 82.2 s vs 254.2 s = −67.7% (**±30% MISSES**, on the fast side — the mock corpus is 26 events where the card's constants model a real month). **The clean-account, real-corpus run is a human step — see item 4.**_
3. ✅ **Week-one measurements logged.**
   - Screen events per day after content-hash dedup (the 725/day assumption). — _`scripts/screen-dedup-rate.mjs`: **25.0% dedup** on the shipped fixture (7 captures → 3 never-list drops → 3 snapshots → 1 suppressed). Events/day needs a real Mac day: **pending week one**._
   - Live calls per day; hot and cold freshness medians. — _**0.6 calls per day of history** (19 calls over a 31-day window). Freshness medians need a live day: **pending week one**._
   - `cache_read_input_tokens` from the two-call test (V6 open question 6). — _**ANSWERED: cached across calls.** `worker/src/evals/two-call-cache.ts` — every call reads **17,239** cached input tokens, call 2 included; the whole install reads **363,138 of 485,318 = 74.8%**. The two-call fallback costs about one pack of fresh input, not two._
4. ⚠️ **Human steps.** Real-phone WhatsApp pairing · nudge card on a real Mac session · screen consent flow on a second account. — _**PENDING, none performed.** None can be faked from a build machine. Add: the clean-macOS-account fresh install with a real corpus (item 2's remaining half)._
5. ✅ **V13 PENDING fixtures** — CIR-01..03, FIX-06, BRW-04/06/07 — resolved or deferred with reasons. — _CIR-01..03 **resolved** (green code since S5.4, CIR 4/4 deterministic; the baseline's `pending` rows are stale). FIX-06 **resolved, asserted elsewhere** (`src/feedback.test.tsx` covers the menu, the per-type chips, the ≤3 cap and both `wrong[]` labels; pending in the worker harness only because the worker cannot render React). BRW-04/06/07 **deferred to P5.x** — they measure Phase 5 capture adapters, and §2.1 files `browser/` as dormant in P1._
6. ✅ **Release.** `SuperTwinV13_V6P1S6_13.11.x.dmg` — _13.11.1, 992 MB, sha256 `a90fc840…`, recorded in `RELEASES.md`._

### 9.7 Residual closure — S6b

**STATUS:** ✅ done 13.11.2 (2026-09-06) — the three residuals Stage 6 left open are closed, the exit gates re-verified at the new HEAD, and `evals/baseline/v13.json` re-recorded from this run so it stops lying about CIR/ROL and about the categories it never had. Gates: root `npm test` 22 files/201 + scripts 5/104 ✅ · worker vitest **299 files / 3706 passed / 2 skipped, integration included, 0 failures** ✅ · `tsc --noEmit` clean for `-p worker`, `tsconfig.app.json`, `tsconfig.node.json`, `tsconfig.json` ✅ · `npm run build` ✅ · Go `vet` + `test -count=1 ./...` ok over 5 packages ✅ · Swift `build.sh` → arm64 + `test.sh` **OK: 75 checks** ✅ · deterministic eval `--mode code --ast-parity` **157 cases, 155 pass, 0 fail, 2 pending (TRC-01/03 by design), VERDICT green, PARITY HOLDS, ZERO model calls** ✅ · every §10 hard-gate row at or better than S6 ✅. **83 live calls**, every one shim-counted. Detail in `progressV13_V6_Phase1.md`.

#### R1 — Retire `assist/` ✅ `3e6836f` — `DEFAULT_LIVE_MODE` → `merged` (one live call per bundle, the two-call fallback still selectable via `SUPERTWIN_PROMPT_LIVE`) and the lane deleted: watcher, evaluator, gate, the nine AST fixtures, `evals/executors/assist.ts` and the legacy P2.2 tail of `executor/lite.ts`; `artifacts.ts` and `settings.ts` re-homed to `surfaces/` and `settings/`. The parity ledger flipped direction — it now requires that no retired case is still in the corpus — and measures all nine rows green.

#### R2 — The P1 surfaces the S5 lanes built and never rendered ✅ `eb67d6a` — "Who I am" and the follow-up radar on the People screen, Settings › Assist stating `nudgeVerdict()` in words against the floor in force (the retired input-side knobs dropped), the bar's S5.5 coverage caveat / named gaps / thread lock and chips, and `runPreparedQueue()` finally given a caller: `executor/queue-job.ts`, lookup-first, ≤2 actions per 2-minute tick, the pause and budget latches HOLDING the queue rather than burning it.

#### R3 — Eval hygiene ✅ `a4d4fa8` — LIV-08/09/10 and CROSS-DAY authored as deterministic fixtures, the spec-retired TSK-03 re-authored onto the change that queues Decide (with a `REAUTHORED_MARK` so `--materialize` cannot clobber it), TSK-03..13 measured live for the first time this phase (which exposed two harness defects: `decideAppliedView` rendered only closures, and `buildJudgePrompt` named three `applied_by_*` annotations the emitter had stopped using), and `injection_flags` moved from a module-scope `CREATE TABLE` into `0208_v6_injection`.


### 9.8 Worker-unreachable fix — S6c

**STATUS:** ✅ done 13.11.5 (2026-09-06) — **13.11.1 and 13.11.2 shipped an app whose every screen said "worker unreachable", past a 3,700-test suite that was green the whole time.** `harnessRoot()` called `fileURLToPath(import.meta.url)` on the boot path; esbuild rewrites `import.meta` to `{}` for the CJS bundle, so inside the `.app` that argument was `undefined`, `main()` rejected before `startServer()`, and every request 404'd at the shell. Under `tsx` and `vitest` `import.meta.url` exists — which is exactly why the whole suite was green on a broken build. Fixed at the root (W1), at the reason nothing caught it (W2) and at the second screen it broke (W3). Gates: root `npm test` 23 files/234 + scripts 7/122 ✅ · worker vitest **303 files / 3786 passed / 2 skipped, integration included, 0 failures** ✅ · `tsc --noEmit` clean for `-p worker`, `tsconfig.app.json`, `tsconfig.node.json`, `tsconfig.json` ✅ · `npm run build` ✅ · Go `vet` + `test -count=1 ./...` ok over 5 packages ✅ · Swift `build.sh` → arm64 + `test.sh` **OK: 75 checks** ✅ · deterministic eval `--mode code --ast-parity` **157 cases, 155 pass, 0 fail, 2 pending (TRC-01/03 by design), VERDICT green, PARITY HOLDS, ZERO model calls** ✅ · every §10 hard-gate row PASS on that run ✅ · **the installed `.app` boots** ✅ (see below) · ORIENT/TOP **90% best-of-2 vs a frozen 100% ⚠️**, attributed to judge variance and recorded as a residual. **~59 live calls**, 45 shim-counted. Detail in `progressV13_V6_Phase1.md`.

**THE ACCEPTANCE IS THE APP.** A green suite is what shipped the bug, so the exit gate for this stage is the artifact, not the test count. The DMG was mounted, `SuperTwinV13.app` copied over `/Applications` (13.11.2 → 13.11.5), the image detached, and the installed app launched through its own path — which sets `SUPERTWIN_LAUNCHED_BY=app` and is the one legitimate way to touch the production home. `~/SuperTwinV13/worker.log` wrote `[worker] WORKER_READY port=8013` and **no `fatal:` line**, where 13.11.2 wrote a stack trace; the golden gate — the step that killed both previous builds — is now the fourth line, past the listener and inside `optionalStep()`, saying `golden gate: eval harness not found under /Applications/SuperTwinV13.app … (recorded as skipped)`. `GET /api/health` → `{"ok":true,"version":"13.11.5","builtThroughPhase":"V6P1S6c",…}`; `GET /api/settings/general` → **HTTP 200 with data**, as do the other nine panel reads and `/api/quota`; no `degraded` list, so nothing degraded. On quit both processes were gone and 8013 was empty — the sidecar is reaped. The launch spent **zero** model calls (`runs = 0` afterwards).

#### W1 — The boot crash: a bundler-safe module path, and a boot that degrades instead of dying ✅ `9498467` — `worker/src/module-path.ts` is the one place that knows the difference between the two module systems (`moduleDir(import.meta.url)` takes a real file URL when there is one, falls back to the CJS bundle's own `__dirname`, never throws), and every occurrence in the bundled graph moved onto it: `golden-gate.ts` `harnessRoot()` (the crash), `server/index.ts` `moduleBaseDir()` (it asked `globalThis.__dirname`, a value CJS never defines, so the packaged app walked up from cwd), the WhatsApp and screen adapters and `browser/chromium.ts` (all fell through to `process.cwd()` and were right only because src-tauri chdir's into the worker dir), `media/tools.ts`. The boot is two phases: hard rails (home guard, crash-kill, stale-worker sweep and pid claim, migrations, provider registry, adapter manifest) → the HTTP listener → every optional subsystem through `boot-guard.ts`'s `optionalStep()`, which turns a throw into a logged line, a null handle and a name on `/api/health`'s `degraded` list. The rails stay rails: nothing that must refuse a boot goes through the guard.

#### W2 — The bundle smoke test: the suite executes the artifact the DMG carries ✅ `4a74c1d` — `scripts/bundle-smoke.mjs` runs the real `bundle-worker.mjs` + `stage-node-sidecar.mjs`, boots `worker/bundle/worker.cjs` under exactly the env `src-tauri/src/lib.rs::build_worker_command` sets in release (scratch `$TMPDIR` home, OS-assigned port, 8013 refused in its own argument parser, `SUPERTWIN_DB_PATH` and the production-home waiver stripped), and asserts `/api/health` at the app version, the `WORKER_READY` line, `/api/quota` 200 — which proves the staged `better-sqlite3` addon serves a read — every declared migration applied, `runs = 0`, exit 0 on SIGTERM and a closed port. Twelve resource paths the packaged worker resolves relative to `worker.cjs` became a standing check. Verified as a real gate, not a decoration: on a pre-W1 tree it fails with the shipped `at harnessRoot (worker.cjs:…)` stack. Wired into `npm run test:scripts`, with a test asserting that wiring so it cannot be silently unhooked.

#### W3 — UI error states: one loading/error/retry primitive, and reads that never lie ✅ `2816b7b` — the half of the defect the crash log did not explain. Home said "worker unreachable"; Settings sat on `loading…` forever, because eleven panels each carried a swallowed rejection plus a `null`-means-pending render, so a dead worker was indistinguishable from a slow one and the spinner outlived the request. `components/LoadState.tsx` (`useLoad` — exactly one of pending/data/error, a rejection ALWAYS lands in `error`, `retry()` re-runs the read — plus `LoadFallback`, `LoadFailure` with `role="alert"`, and `SaveError` for a switch that springs back saying nothing), and `lib/api.ts` throwing a typed `WorkerError` so the words are honest: "worker unreachable" only when `fetch` itself rejects, otherwise "the worker answered 404 for /api/calendar". Wired through all eleven Settings panels, Home, Spaces, Calendar, Timeline, People, the four Library panes, Who-I-am, the radar, the why? drill-down and the menu-bar panel; action failures split off from read failures wherever they shared one `error` slot.

#### Gate fix — the suite stops writing into the user's real home ⚠️→✅ `cf9de93` — found at this gate by noticing `~/SuperTwinV13/supertwinv13.db`'s mtime move DURING a worker vitest run. `homeRoot()` falls back to `~/SuperTwinV13` when `SUPERTWIN_HOME` is unset — right in production, wrong in every test, and silent, because writing a file is not an assertion. `evals/executors/liv.test.ts` sandboxed `SUPERTWIN_DB_PATH` but not the home, and LIV-09 drives the REAL `executor/lite.ts`, whose `liteWorkspaceDir()` mkdir -p's `<home>/executor/lite-<id>/` and writes `result.json` there; `server.integration.test.ts` had the same shape. Fixed at the point of leak and at the class: `test-setup.ts`, loaded before every worker test file, now defaults an unset or blank `SUPERTWIN_HOME` to a per-file scratch dir under `$TMPDIR`, with `test-home-rail.test.ts` pinning it. Proved against the real home — rail alone HOLDS (3 → 3), both fixes removed LEAKS (3 → 5). Test-only: none of these files is in the bundled worker's import graph, so the 13.11.5 artifact was not rebuilt.

---

## 10. Cross-stage release checklist

- [x] `trace_coverage = 100%` and `pass_liveness = 100%` — _S0: trace_coverage 100% ✅; pass_liveness 17%, red until S3. S4: pass_liveness 100% ✅, trace_coverage `no data`. **S6 ✅: trace_coverage MEASURED 100%** on the live TRC run — it had read `no data` since S4 because TRC-02 threw before it could observe the gate (the executor was spending decide.v8 under the v9 `decide` pass id, which `stableSystemPrompt` refuses); with that fixed the case runs and the gate reports. pass_liveness 100% over 2 cases on the deterministic run. **Caveat kept in the open:** TRC-01 stays code-asserted by `src/traces/trc-01.test.ts`, and TRC-03's `--liveness` job reads the PRODUCTION `extraction_runs` table, so it needs a real home and is a week-one step, not a gate step. **S6b ✅ re-verified at the residual-closure HEAD**: `pass_liveness` 100% over 2 cases on the deterministic run, and `trace_coverage` **100%** on the live TRC run (it reads no-data on any deterministic run, because TRC-02 is the category's only live case). TRC compared green against its frozen 100%. **S6c ✅ re-verified**: `pass_liveness` 100% over 2 cases on the deterministic run. `trace_coverage` reads `no data` on a deterministic run by construction (TRC-02 is the category's only live case) and was NOT re-measured live this stage — S6c spent its live budget on the ORIENT row and on the app itself, and nothing in the S6c diff touches the trace path_
- [x] SPD-01..08 · BND-08..12 · CNS-01..09 — _S0: SPD-01..08 (04 partial) and BND-08..10/12 ✅; S1: CNS-01..09 ✅ (deterministic suites); S2: RET-01..10 · BAR-01 ✅ (deterministic suites); S3: BND-01..12 (incl. BND-11 dead letters) and GATE-01..10 ✅ as `evals/v13` code fixtures; S4: LIV-01..07 · EXE-01..05 · NUD-01..09 · GATE-A-01..03 · BRF-01..02 · INJ-01..04 · CROSS-N2/N50 ✅ (152/152 deterministic, 0 model calls); S5: SPC-01..08 · CAL-01..05 · ROL-01..10 · CIR-01..04 · CRM-01..05 · BAR-01..10 · SET-01..03 · TSK-01/02 · SCH-01..03/08 · FUP-01 · FIX-07..09 ✅ (55/55 deterministic, 0 model calls) plus live SCH 88% · FUP 100% · TIM 100% · USR 100% · FIX 100%, all ≥ their frozen rates; **S6 ✅ re-verified the whole deterministic corpus at the release HEAD — 154 cases, 152 pass, 0 fail, 2 pending, 0 model calls — and closed the V13 PENDING list: CIR-01..03 resolved, FIX-06 resolved in the React suite, BRW-04/06/07 deferred to P5.x**. **S6b ✅ re-verified again after the `assist/` retirement — 157 cases, 155 pass, 0 fail, 2 pending, VERDICT green, ZERO model calls.** The corpus moved 154 → 157: R1 retired AST-02 with its lane (−1) and R3 authored LIV-08/09/10 + CROSS-DAY (+4), so LIV is 10 and CROSS is 3. **S6c ✅ re-verified at the repair HEAD — 157 cases, 155 pass, 0 fail, 2 pending, VERDICT green, ZERO model calls, proved by a `CLAUDE_BIN` shim that refuses and exits 97 and whose log is empty**_
- [x] ORIENT golden ≥ `evals/baseline/v13.json` — _S3: TOP 10/10 under orient.v7 + critic.v5 (S3.5, 21 calls); 9/10 best-of-2 under the shipped v6/v4 default on the S3.2 pack. **S4 gate ✅: TOP 10/10 = 100% vs the frozen 100%, `--compare-baseline` green, at the release HEAD under v7/v5 (21 counted calls) — §7.3 item 1 holds.** Judge variance at the bar is real (the two in-stage samples were 9/10 and 8/10 on the same pair). **S6 ✅ AND FLIPPED**: the S6 sweep measured the SHIPPED pair for the first time — orient.v6/critic.v4 scored **80%** against its own frozen 100% — while v7/v5 re-measured **10/10 = 100%, COMPARE green**. One 26-event fresh install run under each pair committed 9 episodes vs 19, spent 12 orient repair rounds vs 1, and quarantined 5 bundles vs 0. `DEFAULT_ORIENT_VERSION`/`DEFAULT_CRITIC_VERSION` are now v7/v5, so the scored pass and the shipped pass are finally the same one. **S6b ✅ re-measured after R1 flipped the live lane to one merged call: TOP 10/10 = 100%, `--compare-baseline` green, best-of-2** (sample 1 8/10 — TOP-01 mono-blob and TOP-06 "split point ambiguous", the latter the identical judge wording the S4 gate logged as variance; sample 2 10/10 green). 21 calls per sample; both are in the baseline's `runs[]`, neither hidden. Nothing in R1–R3 touches `orient.v7`; the one judge-prompt edit (R3, generalising the `applied_by_*` annotation names) does not bear on either case. **S6c ⚠️ MISSED best-of-2 and recorded as a residual, not as a regression: 80% then 90%, against the frozen 100%.** TOP-08 red once (the critic rejecting the birthday proposal as a duplicate of `sp_goa_dec` — the same case and shape the S3 gate logged) and TOP-09 red twice, then **green on a third sample run alone (2 calls)**, so the three samples read red, red, green on the one stable case. The judge's own sample-2 text on TOP-09 says the system "correctly produced 2 episodes … satisfying the core rubric" and then fails it on an `episode_id` labelling nit the fixture does not ask about. The claim that the release cannot have caused it is checkable: the whole diff since `0fea779` touches thirteen worker files, none under `brain/`, `prompts/`, `packer/`, `providers/` or `evals/`, and under `tsx` — which is what the eval CLI runs — `moduleDir(import.meta.url)` is behaviourally identical to the code it replaced. `evals/baseline/v13.json` deliberately left unchanged_
- [x] `false_receiver_assignment = 0` · `guess_rate = 0` · `risky_without_token = 0` · `login_automation = 0` — _S4 ✅ on the full deterministic run: false_receiver_assignment 0 (1 case), guess_rate 0 (3), risky_without_token 0 (8, GATE-A + EXE + INJ), login_automation 0 (2, EXE-05 + INJ-03). **S5 ✅**: `false_receiver_assignment` 0 (1 case) and `guess_rate` 0 (2 cases) on the deterministic ROL/CRM run — the two rows the S5 gate was asked to verify by name; `risky_without_token` 0 (2 cases) on the live run, `login_automation` no data this stage. **S6 ✅**: `guess_rate` was BREACHED on the first sweep — the bar filed "buy sunscreen for goa" into one of two equally plausible Goa spaces, because bar-action.v2 stated the ask-don't-guess rule and showed only the opposite example — and reads **0 violations over 2 cases** after `bar-action.v3`; `risky_without_token` 0 and `login_automation` 0 on the deterministic run. **S6b ✅**: `false_receiver_assignment` 0 (1 case) · `guess_rate` 0 (5 cases, up from 2) · `risky_without_token` 0 (10) · `login_automation` 0 (2), all on the deterministic run. **S6c ✅ re-verified, same four, same counts, all 0 on the deterministic run**_
- [x] `assist_from_history = 0` · `nudge_without_grounding = 0` · `content_gated_call = 0` — _S4 ✅: assist_from_history 0 over 11 cases and nudge_without_grounding 0 over 12 (both hard, LIV/NUD/CROSS); content_gated_call 100% over 11 GATE cases — tracked, not bold-hard in GoldenEvals §3.1, and 100% there means zero violations. **S6 ✅ re-verified at the release HEAD**: assist_from_history 0 over 11 cases, nudge_without_grounding 0 over 12, content_gated_call 100% over 11. **S6b ✅ and on MORE cases than S6 measured, now that the lane it names is actually gone**: `assist_from_history` 0 over **17** cases, `nudge_without_grounding` 0 over **18**, `content_gated_call` 100% over 11. **S6c ✅ re-verified — 17 · 18 · 11, unchanged**_
- [x] `packer_enumeration = 0` · `packer_escalation = 0` · `full_vector_scan = 0` — _S2: full_vector_scan 0 ✅ (RET-01/02 assert `fullVectorScans = 0`; whole-table read + 30 s cache deleted); S3: packer_enumeration 0 · packer_escalation 0 ✅ (PCK-02/07 over 104 spaces, candidates from retrieval only, cap 5). **S6 ✅ re-verified — all three 0 at the release HEAD (PCK 7/7)**. **S6b ✅**: `packer_enumeration` and `packer_escalation` both clean over PCK 7/7; `full_vector_scan` is not an eval-harness gate row — RET-01/02 assert `fullVectorScans = 0` in the worker vitest suite, green in this gate's run. **S6c ✅ re-verified: `packer_enumeration` and `packer_escalation` clean over PCK 7/7 on the deterministic run, and RET-01/02 green in the worker suite**_
- [x] `injection_acted = 0` · `fabricated_evidence = 0` · `clock_only_call = 0` — _S3: fabricated_evidence 0 ✅ (CMT-01..05, CROSS-N2, TOP live), clock_only_call 0 ✅ (CON-01, IDEM-01 hard gate). S4 ✅: injection_acted 0 over 8 cases (INJ-01..04 + EXE), hard; clock_only_call 0 over 12 cases after the gate fixed an AST seeder that stamped events in the FUTURE before 2pm and woke CON-01's quiet roll. **S6 ✅ re-verified at the release HEAD — injection_acted 0, fabricated_evidence 0, clock_only_call 0**. **S6b ✅**: `injection_acted` 0 over 8 · `fabricated_evidence` clean · `clock_only_call` 0 over 12. **S6c ✅ re-verified — `injection_acted` 0 over 8, `clock_only_call` 0 over 12, `fabricated_evidence` clean**_
- [x] Pack size under 16,000 chars on the 104-space fixture — _S3 ✅: PCK-02/07 — exactly 5 candidates over 104 spaces, pack ≈ 4.5k chars, within 300 chars of the 24-space pack, < 200 ms, 0 model calls. **S6 ✅ re-verified at the release HEAD (PCK 7/7)**. **S6b ✅ re-verified again (PCK 7/7)**. **S6c ✅ re-verified again (PCK 7/7)**_
- [x] `lsof -i:8013` empty after the full test run — _S0 ✅ · S1 ✅ · S2 ✅ · S3 ✅ · S4 ✅ (8113 too; no worker booted by the gate — CNS-01's own sandboxed boot took OS-assigned port 61359 and reaped it in-run) · S5 ✅ (8113 too; no worker booted by the gate) · **S6 ✅ (8113 too). The only worker S6 booted was `scripts/fresh-install.mjs`'s own child, on a scratch home and an OS-assigned port — 8013 is refused in its argument parser — and it reaped that child and printed `port closed=true` on every run**. **S6b ✅ (8113 too), before, during and after. This gate booted NO worker at all: every eval ran through the harness's own temporary `SUPERTWIN_HOME` under `$TMPDIR`, which opens no listener. The only listeners in the run were the ephemeral OS-assigned ports the worker vitest suites bind and reap themselves**. **S6c ✅ (8113 too) — empty before the run and after every suite**; the only listeners were OS-assigned ephemeral ports the suites bind and reap themselves (CNS-01 printed `port closed=true`, `bundle-smoke` asserts `portClosed` before it passes). This stage DID take 8013, once and by design: the acceptance is the installed `.app`, which listens there, and it gave the port back on quit — verified empty, both processes gone, sidecar reaped. **Reported rather than assumed:** 8013 is held again at the end of the run by pid 89502, the worker of `/Applications/SuperTwinV13.app`, whose parent was spawned by `launchd` at 20:02:36 — after the quit, by the OS, not by the gate. That is the user's own app, on the build this release installed, healthy at 13.11.5 and spending nothing; it was already running when the stage began (as the broken 13.11.2), so the steady state is restored. Left alone deliberately_
- [x] DMG recorded in `RELEASES.md` — _S0: 13.5.1 ✅ · S1: 13.6.1 ✅ · S2: 13.7.1 ✅ · S3: 13.8.1 ✅ · S4: 13.9.1 ✅ · S5: 13.10.1 ✅ · **S6: 13.11.1 ✅** (992 MB, sha256 `a90fc840…`) · **S6b: 13.11.2 ✅** (992 MB, sha256 `60b7be78…`) · **S6c: 13.11.5 ✅** (992 MB, sha256 `afb8e299…`), with 13.11.3 and 13.11.4 recorded as "no artifact — fix bump" rows, one per landed fix_

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
