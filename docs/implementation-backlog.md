# SuperTwin V13 — implementation backlog

Consolidated from the session that built P0–P4 and then took the product apart:
`docs/incident-runaway-spawn.md`, `docs/stream-economics-options.md`,
`docs/bundle-design-brainstorm.md`, `docs/product-redesign-brainstorm.md`,
`docs/product-redesign-v2.md`, plus the 13.4.1 test report and the P0–P4 build residuals.

**Nothing here is implemented.** Verified against the tree at `7346b15`:
no `CLAUDE.md`, no `worker/src/providers/budget.ts`, no `worker/src/home-guard.ts`,
no `scripts/dev-worker.mjs`; `dispatch.ts:626` still routes orphans uncapped;
`consumer.ts:146` is still `Set<Promise<void>>`; `pool.ts:69` still has two LLM lanes.

Status key: **○** not started · **◐** partially landed · **●** done · **?** blocked on a decision.

---

## Tier 0 — Safety rails. Nothing else ships before these.

The $512 / 18,031-call incident is reproducible on the shipped 13.4.7 build: 798 undispatched
events are still in `~/SuperTwinV13/supertwinv13.db`, and an unpatched worker resumes the loop
within 15 minutes of boot.

| # | Item | Where | Status |
|---|---|---|---|
| T0-1 | **Cap the orphan path through the same slot gate as the planned path.** `assignSlots(...)` or `.slice(0, cfg.slots - slotted.length)`, oldest-first. Single highest-leverage change in this document — 6.47 calls/stream → 1. | `worker/src/scheduler/dispatch.ts:626-635` | ○ |
| T0-2 | **In-flight registry keyed by `streamId:minRowid-maxRowid`.** Replace `Set<Promise<void>>` with a `Map`; `onBundle` returns early on a live key. Without it T0-1 is defeated by any window slower than 5 min. | `worker/src/brain/consumer.ts:143-164` | ○ |
| T0-3 | **Re-validate the bundle at execution time.** Re-query `events.dispatched_at` at the top of `runBrainTick`; return `{status:"stale"}` with zero model calls. Would alone have zeroed the 13,152 hour-plus-queued calls. | `worker/src/brain/consumer.ts:26-31` | ○ |
| T0-4 | **Hard spend + call ceiling at the single spawn site.** New `providers/budget.ts`, enforced right after `assertTraceContext` (downstream of all three pool bypasses). Defaults $3/hr, $15/day, 400 calls/hr, 3,000 calls/day. Throw `BUDGET_EXCEEDED` *before* spawning, latch `budget_tripped_at` in `app_state`, no auto-resume. Exempt interactive chat + grounded bar from the latch (still counted) so a trip doesn't brick the UI you need to diagnose it. | `worker/src/providers/claude-local/index.ts`, new `worker/src/providers/budget.ts` | ○ |
| T0-5 | **Make `npm run worker` structurally safe.** New `scripts/dev-worker.mjs`: scratch `SUPERTWIN_HOME` under `os.tmpdir()`, port 8113, PID file that refuses a second boot, 30-min self-kill. Separate `worker:live` carries the production home. | `package.json:14` (currently `npm run dev -w @supertwinv13/worker`), new script | ○ |
| T0-6 | **Refuse to boot against the real home without an explicit signal.** Lift `isProductionDbPath()`/`productionHome()` out of `evals/home.ts` into `worker/src/home-guard.ts`; first statement of `main()`. Waiver `SUPERTWIN_ALLOW_PRODUCTION_HOME=1`, app sets `SUPERTWIN_LAUNCHED_BY=app`. **Verify the Tauri spawn path in the same change or the app stops booting.** | `worker/src/index.ts:42`, new `worker/src/home-guard.ts` | ○ |
| T0-7 | **Orphan self-shutdown.** `process.ppid` watch or a Tauri heartbeat; exit after 10 min with no liveness signal. `SUPERTWIN_WORKER_NO_PARENT=1` for deliberate headless runs. This is the fix that turns a 9-hour incident into a 10-minute one. | `worker/src/index.ts:181-205` | ○ |
| T0-8 | **`CLAUDE.md` with a hard "Running the worker" section** + mirror into the workflow orchestrator RULES block. Never `npm run worker` without both a scratch `SUPERTWIN_HOME` and a non-8013 port; never detach a process from a Bash call (`&`, `nohup`, `disown` forbidden — use `run_in_background`); any agent that opens a port closes it in the same turn and says so; *a listener you did not start is not automatically the user's app*. Also fix `README.md:32`, which sells `npm run worker` as harmless. | new `CLAUDE.md`, `README.md:32` | ○ |

**One-hour ordering if you only get an hour:** T0-1 → T0-2 → T0-3 (three small changes, two files),
then T0-4, then T0-5 + T0-8. Do **not** boot a worker against the production home to verify —
that is the step that started the incident. T0-7 is the top of hour two.

### Tier 0.5 — before the next release

| # | Item | Where | Status |
|---|---|---|---|
| T0-9 | **Attempt ceiling + dead-letter + exponential backoff per bundle.** `attempts`/`last_attempt_at`/`dead_letter_at` keyed on `(stream_id, min_rowid, max_rowid)`; orphan scan excludes dead-lettered ranges; 3 attempts → dead-letter → ops quarantine view, never auto-retry. Closes the documented infinite-retry loop. | new migration beside `db/migrations/0100_v13_core.ts`; `dispatch.ts:488-561` | ○ |
| T0-10 | **Wire the circuit breaker that is already written.** `pool.noteSuccess/noteFailure` in `callOnce`, honouring the returned decision — `prompts/runner.ts:485,491` already does exactly this. Add a 10-consecutive-failure lane pause + UI banner. ~25 lines; `pool.ts:186-261,442-464` already implements the machinery. | `worker/src/brain/llm.ts:315-390` | ○ |
| T0-11 | **Meter background passes into the quota window.** `logRun()` also calls `db.addUsage(...)`. Revisit the `5_000_000` default (`server/index.ts:214`) and `50_000_000` near-limit (`db/index.ts:40`) — both are tuned to never block an eval, which means never block anything. | `worker/src/brain/llm.ts:385-437` | ○ |
| T0-12 | **Bound the pool waiter queue.** Cap `Semaphore.waiters` (~4× capacity), reject on overflow so backpressure reaches the dispatcher; surface `waiting` on `/api/ops`. Changes the failure mode from a silent 8-hour wait to a visible rejection. | `worker/src/providers/pool.ts:110,143-158` | ○ |
| T0-13 | **Live spend heartbeat + a real kill switch.** `[spend] 60s: 27 calls, 1.9M tok, ~$2.20 \| run 8h56m` into the operator log. Persisted `app_state.model_activity_paused` checked at the same choke point as T0-4, surfaced as "Stop all model activity"; add the missing `/api/ops/lanes/pause` binding in `src/lib/api.ts`; remove or greatly raise `MAX_MANUAL_PAUSE_MS` (`ops-routes.ts:59`) — a kill switch that self-resumes after an hour is not a kill switch. | `providers/pool.ts`, `claude-local/index.ts`, `src/screens/settings/GeneralPanel.tsx`, `src/lib/api.ts` | ○ |
| T0-14 | **Resolve the two latent loops of the same shape.** `assist/watcher.ts:127-130,134,179-182` never resets its accumulator on evaluator-error / not-actionable / duplicate-content, so a ready topic re-evaluates every 20 s forever; `adapters/whatsapp/adapter.ts:492-511` `cleanRestart()` has no backoff and no give-up threshold. | as cited | ○ |
| T0-15 | **Reap orphaned sidecars.** `worker.log` records 7 spawns against 2 terminations. Pidfile + startup sweep that kills any pre-existing worker; call `claudeLocalProvider.killAll()` on unhandled-rejection, not only SIGINT/SIGTERM. | `src-tauri/src/lib.rs`, `worker/src/index.ts:188` | ○ |

---

## Tier 1 — Transport. ~5× cheaper, no behaviour change.

The bill was never the Claude Code prefix. Measured over 16,654 `orient.v6` calls: `cache_read`
18,293 tok ×0.1 = **7.5%** of cost; `cache_create_1h` 11,166 tok ×2 = **91.1%** — bytes that are
byte-identical every call, written 16,654 times and read back **zero** times, because every call
opens a fresh single-turn session (`llm.ts:329-344` passes no sessionId; `extraction_runs.session_id`
NULL on all 18,031 rows) and `--max-turns 1` guarantees no second turn.

| # | Item | Effect | Status |
|---|---|---|---|
| T1-1 | **Stage 1** — `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`, delete the double-send of our system prompt (`claude-local/index.ts:184-191`), `--no-session-persistence`, `--max-budget-usd` per call. | $0.0286 → **$0.0171** (−40%), zero behaviour change | ○ |
| T1-2 | **Stage 2** — add `--safe-mode --strict-mcp-config`. Also stops shipping your MCP connector names to Haiku on every call. | → **$0.0057** (−80%) | ○ |
| T1-3 | **Stage 3** — add `--system-prompt-file --tools ""`. Swaps out the default agent prompt `orient.v6` was implicitly tuned against, so **gate on one full eval run**. | → **$0.0022** (−92%) | ? (needs eval) |
| T1-4 | **Decide the transport question properly.** Messages API direct is ~1,450 input tokens vs ~29,500 and is the correct transport on the merits, but needs an API key and moves billing off the subscription. Stage 2 keeps the local-first "no API key" property and recovers 80%. The 27,000-token floor is set by a CLI you do not control and can change under you at any release. | product call | ? |

---

## Tier 2 — Dispatch and bundling. The context-starvation fix.

84.9% of Orient calls carried exactly **one** event (mean 1.73, median 1, p90 3). Even
first-dispatch-only, bug-free, it is 90.3% singletons — the chain keys guarantee starvation. Only
**2,470 distinct (stream, bundle) pairs** existed in the whole 16,654-call workload; 82.9% of calls
re-sent a byte-identical bundle. V1 did the same job at **25.2 events/call, 456 calls, $9.35**.

| # | Item | Where | Status |
|---|---|---|---|
| T2-1 | **Drop one-stream-per-call dispatch (spec §6.3.1).** Stream survives as *identity/retrieval*; the call unit becomes the **day** (backfill) or the **flush window** (live). | `dispatch.ts` | ○ |
| T2-2 | **Backfill = one call per calendar day, all sources, temporal order,** sectioned by stream (`[STREAM S1: wa:family]`, `[STREAM S2: browser goibibo.com]`), oldest→newest so each day sees prior days' committed episodes. Split oversized days at the largest inactivity gap. 85/88 real days fit one call under the 28K cap. | `dispatch.ts`, `packer/pack.ts` | ○ |
| T2-3 | **Live = idle-gap flush, not a fixed window.** `idleMs` 45 s · `maxAgeMs` 120 s backing off ×2 under sustained activity · `maxChars` 20,000 · express on `INTENT_RE` + ≥2 events + 120 s debounce · floor ≤1 non-express flush per 30 s. Measured **strictly better** than the 5-min window: 40.8 vs 47.7 calls/day at 3.3× the freshness. **Do not go to 1-minute windows** — cross-source co-occurrence collapses 4.1% → 0.8%. | new flush trigger | ○ |
| T2-4 | **Novelty filter hoisted into the flush trigger.** An event whose `content_hash` is already in the batch neither resets the idle timer nor counts toward the flush. Currently buried at `assist/gate.ts:265`. | `gate.ts:265` → flush trigger | ○ |
| T2-5 | **Explicit `episode_events` membership rows.** The schema already emits per-episode event lists and `commit.ts:219` already resolves them — then throws the resolution away. Retro-fixes the 4% of rowid ranges that are already contaminated. | migration + `commit.ts` | ○ |
| T2-6 | **Kill the scalar `bundle.streamId`** (10 call sites: `commit.ts:247,263,323,364,390`, `packer/history.ts:62,71,159`, `dispatch.ts:93-97,447`). Derive `episodes.stream_id` from resolved events, enforce single-stream at commit, add an explicit `"stream":"S1"` tag to the Orient schema. Today correct per-stream model output is destroyed by the commit layer. | `commit.ts`, `orient.ts`, `critic.ts` | ○ |
| T2-7 | **Per-item salvage.** Commit valid items, repair/quarantine only invalid ones, advance the cursor on event ids rather than whole bundles. Kills "one bad item parks 25 streams" and the infinite-retry shape. | `commit.ts`, `dispatch.ts:447` | ○ |
| T2-8 | **Packer renders sections**, and loses the truncation trap at `pack.ts:315-319`. | `packer/pack.ts` | ○ |
| T2-9 | **Delete the engagement-tiered hot/warm/cold delays** (30 m / 4 h / 24 h). Saved 13% of calls at yesterday's prices while making understanding hours stale. | `dispatch.ts` | ○ |
| T2-10 | **Browser stream key → `domain + day`;** screen → **app-session** (`bundleId` + 30-min idle gap); writing → `write:<doc_path>`. Confirmed by re-keying query: 2,436 → 643 browser streams, 1.4 → 5.4 ev/call. **Needs a one-time re-key migration** — stream keys are append-idempotency and cursor identity (`chains.ts:9-12`, `dispatch.ts:447`), and `streams.category`/`engagement_score`/`cursor_rowid` re-base. Fold per-profile keys (`browser:<browser>:<profile>:chain:<hash>`) into the same migration. | `adapters/browser/chains.ts:58-60` | ○ |

---

## Tier 3 — One lane. The capability that does not exist today.

Orient sees episodes, spaces, thread history, roster — and **has no `[NOW]` and no open tasks**.
Assist sees the clock and open tasks — and **no episodes**. "He is booking a villa and the advance is
due at 5 pm" needs all three. *Neither pass can produce that sentence today, at any price.* They
already share the one thing that hurts (the same `lane: "understanding"` semaphore) and are split on
the one thing that would help (context).

| # | Item | Where | Status |
|---|---|---|---|
| T3-1 | **Add a third pool lane `"live"` with ≥1 reserved slot;** route the live pass to it, backfill + Critic + Decide to `understanding`. ~20 LOC, and it is what makes "minutes-fresh" a property rather than a hope. **Ship this first, before any prompt change.** | `providers/pool.ts:69` | ○ |
| T3-2 | **`[NOW]` and `[OPEN TASKS]` blocks into the Orient pack.** Two blocks, no schema change, no new call. May deliver most of the villa capability on its own. | `packer/pack.ts` | ○ |
| T3-3 | **`live.v1` — one call, two payloads.** `{understanding:{…}, assist:{…}}`; the understanding half stays byte-compatible with `orient.v6` so `parseOrientOutput`, `resolveEventAliases`, `buildCriticInput` and `commitTick` are reused under a `.understanding` accessor. Combined prompt ≈ 6,300 chars = 22% of the 28,000 cap; combined output 681 tokens. Retire `assist.v1`. | new prompt + parser | ? (see gate) |
| T3-4 | **Section-independent parsing.** `.understanding` and `.assist` try/caught separately — one bad JSON section must not kill the other. | parser | ○ |
| T3-5 | **New assist fields `grounded_in` and `urgency`/`deadline_at`.** `grounded_in` aliases must resolve to events *in this flush* — this kills a real defect: the accumulator at `gate.ts:305-330` checks suppression, cooldown, quiet hours, count and new-content and **never a timestamp**, so five events spread over three weeks can fire a nudge today. | prompt + code check | ○ |
| T3-6 | **Move the trigger gate from the input side to the output side.** Same thresholds from `settings.ts:27-38`, evaluated in code on the flush: it now decides "may we interrupt," not "may we spend a call." | `assist/gate.ts` | ○ |
| T3-7 | **Backfill must never nudge** — enforced twice: the backfill user block omits the assist instruction, and code discards any assist section when `lane !== "live"`. | prompt + code | ○ |
| T3-8 | **Critic grades the understanding half only,** in parallel with executor-lite, so the nudge never waits behind a 7.1 s call. | `critic.ts` | ○ |
| T3-9 | **Fix the assist cursor that advances *before* work** (`assist/watcher.ts:108`) and so loses events on crash, while understanding does not. | `assist/watcher.ts:108` | ○ |
| T3-10 | **Safety classes stay frozen.** `executor-lite.ts:89-93` 3-tool table asserted against `RISKY_TOOL_NAME_PATTERNS`. Unification adds no capability — assert it in a test. | `executor-lite.ts` | ○ |

**Ship gate for T3-3.** Only after: ORIENT golden set **matches or beats** `orient.v6` (a regression
is disqualifying) · AST set matches or beats `assist.v1` · the CROSS-N50 fixture yields one space +
two episodes + **exactly one** nudge citing both sources · a backfill bundle containing a
three-month-old "pay by 5 pm" emits **zero** assist output.
**Fallback if it regresses:** keep T3-1/2 and the merged pack, make two calls off it. Steps
T3-1→T3-2→T2-3 are worth shipping regardless. *"Stay separate" is not defensible.*

**Honesty item:** the assist lane has never produced a nudge from real user data — all 43
`artifacts` rows have `run_id IS NULL`, all 30 `assist.v1` ledger rows came from eval executors.

---

## Tier 4 — Consent. Nothing runs before yes.

`main()` starts every capture path unconditionally; there is no consent check anywhere on the boot
path. The browser watcher's first 90-day import fires **within a microtask of boot**
(`index.ts:97` → `watcher.ts:132`, `queueMicrotask(() => this.pollSafe())`). `sources` has 5 rows,
all `enabled=1`, **`connected_at` NULL on every one** — 3,452 events sit behind a table that records
no connection ever happening.

**Six of the seven privacy controls the user can see are read by nobody**, including the most
visible one: the menu-bar ⏸ pauses *nudges* (`assist/watcher.ts:97` is its only consumer), not
capture. Browser and Screen capture toggles are display-only. App blocklist, domain blocklist and
page-text rules have zero readers outside `settings-routes.ts`.

| # | Item | Where | Status |
|---|---|---|---|
| T4-1 | **`consents` table + one `captureAllowed(source)` gate** at the two single-writer funnels every adapter already passes through — `db/eventlog.ts:229` and `db/ingest.ts:1396`, beside the per-stream pause that already works. A new adapter inherits the gate for free; this one function retires all six dead controls. | new migration, `eventlog.ts:229`, `ingest.ts:1396` | ○ |
| T4-2 | **Two windows per source, never one control: INDEX (tier b, default everything) and UNDERSTAND (tier a, default 30 d, can never exceed INDEX).** Mechanism is one predicate, not a filter someone can forget: tier-(b) rows insert with `origin='archive'`, `dispatched_at = capture_ts`, invisible to dispatcher and orphan scan by construction. Widening later = `UPDATE events SET dispatched_at=NULL, origin='backfill' WHERE ts >= ?`. Bridges and embeddings do **not** run on tier (b). | ingest + dispatch | ○ |
| T4-3 | **Invert the boot order.** Adapters spawn only after a consent row exists. Screen sidecar today begins capturing the instant `AXIsProcessTrusted()` flips true (`Live.swift:55`) with no in-app "start recording" step. | `worker/src/index.ts`, `Live.swift:55` | ○ |
| T4-4 | **Make `sinceMs` required** so the hardcoded 90-day floor can't return by omission; replace it with `consents.processed_from`. | `adapters/browser/watcher.ts:132` | ○ |
| T4-5 | **Browser connect flow.** Enumerate every installed browser **and every profile** — `discoverProfiles()` hardcodes three paths (Chrome `Default`, Arc, Safari), which is why Brave's 4,993 visits are invisible. Copy-then-read is 40 ms/profile and imports nothing. Show real counts and state the plateau honestly (`1d 306 · 7d 1,597 · 30d 6,091 · 90d 8,131 · everything 8,131`). Safari needs a real blocker message about Full Disk Access, not a silent zero at `watcher.ts:181`. Disclose that page URLs already carry absolute local file paths (307 of them). | `adapters/browser/*`, Library UI | ○ |
| T4-6 | **Fix the unreachable Browser connect card**, which renders only when `event_count === 0` — the watcher imports 90 days at boot, so it is gone before Library is ever opened. Its copy also claims *"SuperTwin never reads Chrome's encrypted stores itself"*; the watcher reads Chrome's History SQLite directly. | Library UI | ○ |
| T4-7 | **WhatsApp connect flow.** Pair → let history sync land in the daemon buffer → show *measured* counts per window from `messagesInRange`, not guesses. Print the honest caveat the `HistoryDepth` machinery already computes. Don't ingest live messages between pairing and range-confirm. Extend `IMPORT_RANGES` (`src/lib/api.ts:361-371` ships 9 of the 12 values the worker already accepts — missing `3d`, `3y`, `4y`). | `adapters/whatsapp/*`, `src/lib/api.ts:361` | ○ |
| T4-8 | **Screen consent.** Consent row → Accessibility permission → explicit **"Record from now on"** listing what is captured (frontmost window text, app, title, doc/URL) and what never is (password managers, private windows). Persist pause to `app_state` and seed `adapter.paused` from it at boot — `adapter.ts:171` is in-memory, so pause dies on restart. Show a **rate** (~0.8–2.7 GB/yr), never a total. | `Live.swift`, `adapters/screen/adapter.ts:171` | ○ |
| T4-9 | **Real recording indicator.** Repoint the tray ⏸ from `assist.capture_paused_until` to actual capture state, add a distinct recording glyph, make one click actually stop capture. | tray + `assist/watcher.ts:97` | ○ |
| T4-10 | **Confirm card with four numbers, each carrying its own accuracy.** Events (exact where exact) · cost (`days × $0.0104`, ESTIMATE ±40%, wired to `--max-budget-usd` and the daily breaker so *"we'll stop and ask if it passes $2"* is enforced) · time (`days × 8.2 s` **serial**, never quote a concurrency-8 number) · disk (narrow-archive model). **No number the code cannot compute at that moment.** Store the card text verbatim in the `decisions` row referenced by `consents.decision_id`. | new UI + `decisions` | ○ |
| T4-11 | **Disconnect / pause / delete as distinct verbs**, never one button. Consent flips **before** the adapter stops, so a throwing teardown still leaves capture blocked at the funnel. Deletes are a preview, not a surprise — `hardDeleteEvents` already returns a full `CascadeReport`; run it in a transaction, show "1,204 events, 38 episodes, 2 spaces, 1 task", commit on confirm. | new UI + `library/delete-cascade.ts` | ○ |
| T4-12 | **Route source deletion through `hardDeleteEvents`.** The path a user reaches today (`db/ingest.ts:2179-2197` `resetSourceData`) runs raw DELETEs and would strand **4,409 episodes, 65 spaces, 4,314 unsorted rows** citing event ids that no longer exist. | `ingest.ts:2179` | ○ |
| T4-13 | **Drop `sources.connected_at` and `sources.enabled`** — zero readers, zero writers. Columns that look like consent and mean nothing are worse than none. | schema | ○ |
| T4-14 | **Decide what happens to the 3,452 browser events already captured without consent** — one-time keep-or-delete card, or silent delete (which must go through `hardDeleteEvents`). | one-time migration | ? |

---

## Tier 5 — Two-tier storage and retrieval.

Measured: understanding output + telemetry is **18.1 KB/event**; a narrow archive row for a browser
visit is **739 B**. A 24× gap. Keeping history is nearly free; understanding it is what costs money.
Heavy user — 5 y browsing + 8 y WhatsApp + 1 y screen, fully indexed — is **1.57 GB**, 0.3% of a
512 GB SSD. Run rate **0.92 GB per year of life**.

| # | Item | Where | Status |
|---|---|---|---|
| T5-1 | **Narrow append-only archive table, one copy of the text, zlib.** Two measured causes of the 3.6–4.4× bloat: the text is stored twice (66.7% of browser events carry `text` verbatim inside `payload_json` too), and `events` is **62 columns wide**, so a 44-char message pays ~350 B of NULL-column header. | new table + migration | ○ |
| T5-2 | **Fix the retrieval shape before it breaks.** `retrieval/semantic.ts:309` loads *every* vector into a process cache and `:251` linear-scans. Benchmarked: 192 ms at 100 K vectors, 2,073 ms at 1 M. Breaks around **200–300 K vectors ≈ one year of screen.** Fix: **FTS5 recall (top ~2,000 by bm25, 3–13 ms at 221 K docs) → cosine rerank on candidates (3.8 ms) → neighbourhood expansion → cite by archive id.** `rank()` kept verbatim, just handed a bounded set. No ANN dependency, no index build. | `retrieval/semantic.ts:251,309` | ○ |
| T5-3 | **Embed chunks, not events.** Chat = rolling ~2,000-char window over consecutive messages (730 K msgs → 16,170 vectors → 0.012 GB); screen = ~2,000-char chunks of the reconstructed document, recomputed only on re-anchor; browser = one vector per visit (title + stripped URL), deduped by `content_hash`. A length filter is the wrong answer — 63.7% of real messages are 1–39 chars and they carry the identity; FTS finds them by exact term anyway. int8, 16 KB pages, rowid key (782 B/vector vs 3,280 fp32). | embeddings pipeline | ○ |
| T5-4 | **Screen anchor + diff storage** — store the first capture of a `doc_key` session in full, then only `new_chars`, re-anchoring every ~20 captures. Cuts the heavy-user total 3.49 GB → 1.57 GB in one decision. | `adapters/screen/envelope.ts` | ○ |
| T5-5 | **Retention as a privacy control, not a capacity control.** Compaction saves ~2 GB/year; nobody buys a policy for 2 GB. Offer "stop keeping the words that were on my screen after 30 days" with the disk figure shown small and honest underneath. | settings | ○ |
| T5-6 | **Library panel: two bars on one track per source** — searchable vs understood, with byte counts. `server/library-routes.ts:64` reports event counts and nothing about bytes today. Three rules: the two handles never share a control; lead with free space ("1.6 GB · 487 GB free"); deletion stays symmetric. Copy: *"Keeping more history costs disk. Understanding more history costs money."* | `library-routes.ts:64`, Library UI | ○ |
| T5-7 | **Say plainly in the UI that events outside the understand window are searchable but carry no episode.** | Library UI | ○ |
| T5-8 | **Google Takeout / My Activity import** if browser history deeper than ~90 days is ever wanted. Confirmed three times that every Chromium browser expires visits at ~90 days (Chrome 89, Comet 88, Aside 91) — a 5-year browser tier is an import feature, not a local-read feature. | new | ? |

---

## Tier 6 — Source quality.

### 6a. Browser

| # | Item | Where | Status |
|---|---|---|---|
| T6-1 | **Strip tracking params at emit — denylist, fail-open, per-domain content overrides.** Measured: query strings are 62.5% of URL bytes, of which **69.4% is tracking**; tracking junk is **33.1% of all `events.text` bytes**. Reuse `bridges/normalise.ts:186`, which already implements steps 2, 4 and 5 including the YouTube `{v,t}` case at `:206-213`. Order: per-domain override first (`youtube/watch → {v,t,list}`, `google/search → {q,udm,tbm}`, `hotstar → {search_query,seasonId,episodeNumber}`, **`localhost:7373 → {path}`**, `amazon → {k,node}`) → prefix denylist → name denylist → drop non-route fragments → 200-char cap → sort survivors. **Denylist, not allowlist**: an allowlist fails closed and a memory system cannot re-derive what it discarded. **Google is the offender, not Netflix** — 81.6% of its URL bytes are junk. | `adapters/browser/watcher.ts:238` (text only; `payload.url` at `:240` stays raw) | ○ |
| T6-2 | **Take T6-1 for retrieval first, money second.** `events.text` is what the prompt reads (`pack.ts:263`), what FTS indexes (`db/schema.ts:155`) **and what `salientTokens()` builds the retrieval query from** (`packer/spaces.ts:53-66`). On a real Google bundle about "tfidf", **11 of the top 24 salient tokens were base64 tracking garbage** — and a frequency ranker *promotes* `fbs` because it has only 9 distinct values across 120 occurrences. Result: −53% text bytes, 1,734 → 1,234 distinct URLs, 394 hidden duplicates revealed. | as above | ○ |
| T6-3 | **Render-time collapse of ≤30 s duplicate visits** into one line with ×N and first–last times (858 events). Nothing deleted, ever. Attention polish, not economics. | `packer/pack.ts` | ○ |
| T6-4 | **Render browser transition type** — `typed` 276 · `form_submit` 41 · `bookmark` 30. "Typed goibibo" ≠ "redirected to goibibo". **Do not render `dwell_ms`** (261 events are 0, the rest are 1–10); render `visit_count`. | `packer/pack.ts` | ○ |
| T6-5 | **Exclude the 115 `.example` eval fixtures from production ingest** — `villas.example` (46), `goibibo.example` (25), `stays.example` (15), `airbnb.example` (10), all `origin='live'`, all still undispatched, all re-bundled every window forever. 13.4.2 added an eval home + purge CLI; V6 S3.9 added `origin='eval'` (`EventOrigin`), `DEFAULT_IGNORED_ORIGINS = ['eval']` in `scheduler/v6/dispatch.ts`, the digest planner skips it, the history planner reads backfill only, and the purge CLI's `eval-origin` signature finds it. | `dispatch.ts`, ingest | ✓ |
| T6-6 | **Keep 100% of URLs — no drop policy at all.** Full classification of the 3,337 real events: deliberate content ~74%, navigation scaffolding 13 events (0.4%), machine noise **structurally zero** because Chrome's visits API records top-level navigations only. The pop-up-ad category has no members in this data. Delete the tracker blocklist / `isDroppableTrackerHop` idea. | drop from spec | ○ |

### 6b. Screen — nine fixes, ordered by value per LOC

The sidecar already captures full AX text of the frontmost window (visible **and** scrolled-out,
4,000 nodes), window title, app, doc_key/URL, links, file paths; triggers on app/tab switch, typing
pause, scroll stop, 60 s heartbeat; drops private windows and password managers in-sidecar. The
worker then throws most of it away.

| # | Item | Where | LOC | Status |
|---|---|---|---|---|
| T6-7 | **Identity + kind in every event head.** `pack.ts:258` renders `e7 08-18 10:27 self: <text>` — no app, no title, no doc_key — and `[kind]` renders only in the digest branch, which never runs. **Every event in every bundle ever sent looked identical across sources.** `consumer.ts:44` also sets `source: ""` on every envelope. ~100 chars against a 28,000 cap. | `pack.ts:258,261`, `consumer.ts:44` | ~30 | ○ |
| T6-8 | **Persist full text.** `envelope.ts:95` stores only `frame.new_chars`; the sidecar sends both. Measured 132,091 chars captured → 37,352 stored, **71.7% deleted**; a heartbeat stores 332 of 21,999. Fixes FTS in the same stroke (`eventlog.ts:242` projects `payload.text`). Add a content-addressed blob table so near-duplicate heartbeats don't re-store 22 KB. | `envelope.ts:95` | ~5 (+60) | ○ |
| T6-9 | **Revive the digest layer — deterministic only.** `CONTENT_KINDS` lists three kinds nothing emits; `content_digests` = 0 rows; `run_context_stats` L0/L1/L2 = 0/0/0 across 16,654 calls. Root cause: `consumer.ts:34-53` `toEnvelope` never sets `contentHash`, so `packer/digest.ts:216-217` (`if (!hash) continue`) skips every event, always — **Orient has run on undigested context in production the entire time.** ⚠️ **Cost landmine:** `ensureDigests` makes one Haiku call per unique `content_hash` — ~970 calls/day ≈ **$165/mo**, an order of magnitude above the whole live budget. Use the free deterministic `distillContent()`; gate model digests to `length > 8,000` **and** one per (stream, 10-min window). | `digest.ts:50-54,216`, `consumer.ts:34-53` | ~3 + gate | ○ |
| T6-10 | **Budgeted truncation.** `.slice(0, 1200)` is fixed regardless of bundle size — a 1-event day and a 150-event day get the same allowance. Derive from remaining budget (floor 400, ceiling 4,000). | `pack.ts:263` | ~20 | ○ |
| T6-11 | **Session arcs (`ts_end`).** Fold same-stream runs into one arc bounded by a 30-min idle gap: ~1,000 daily point-events → ~40 daily arcs. Prerequisite for `write.session`. | new | ~80 | ○ |
| T6-12 | **Revive the AX role walk.** `Live.swift:216,224` collects element roles and `RawCapture` never carries them; `main.swift:62` uses the default hasher, which is text-shaped, so the "structure vs content" dedup distinction does not actually exist. Restoring it delivers the *"the user is typing here"* signal the writing lens depends on. | `Live.swift`, `main.swift:62` | ~35 | ○ |
| T6-13 | **Enrich the FTS projection** with app · window_title · doc_key. "The tab about villas" is unfindable today. | `eventlog.ts:242` | ~5 | ○ |
| T6-14 | **Retire or wire `content_pending`.** Writers exist, **zero readers**, 556 B/event. Decide; don't leave it. | | 10 / 150 | ○ |
| T6-15 | **Node-side line diff for writing.** `Dedup.swift:47-55` is a prefix/suffix trim, so a one-word edit in paragraph 3 returns the whole middle span as "new" — fine for chat, wrong for a writing source. | new | ~80 | ○ |
| T6-16 | **Fix the `""` docKey fallback** (`Live.swift:167-169`) and add a minimum new-chars floor on switch-triggered captures — 64% of measured events were `window_switch`, some carrying **2–3 characters** of new text. | `Live.swift:167` | small | ○ |

### 6c. WhatsApp

| # | Item | Where | Status |
|---|---|---|---|
| T6-17 | **Render the reply/thread structure that is already captured and never sent** — `reply_to`, `reaction_to`, `forwarded`, `mentions`, real audience. All captured, none reach the model. | `packer/pack.ts` | ○ |

### 6d. Writing / drafts — a lens, not a new adapter

**Settled in-session:** no folder watcher. Opening a file is the signal; a directory watcher would
capture files you never looked at and edits made by other tools. Roughdraft is a local web app
(`http://rdN.localhost:7373/?path=<urlencoded absolute path>`) — the browser watcher and the AX walk
**already capture it**. What is missing is a recognizer.

**Roughdraft is 836 events = 24.2% of the entire browser corpus** across 92 hostnames and 339 `.md`
documents on 57 of 80 days — bigger than netflix.com (716) and hotstar.com (695). The system filed
**594 of its 603 episodes (98.5%) as unsorted**, mean confidence 0.36, with the model's own reason
being *"File access without stated goal"* — because it was handed a URL with no content and a
`domain+day` key that shards one app 92 ways.

| # | Item | Where | Status |
|---|---|---|---|
| T6-18 | **`write.session` as a derived kind** on top of the browser + screen lanes. Zero new daemons, zero new permissions. Fires when **(i)** the tab URL matches a registered local-editor pattern (`doc_path = decodeURIComponent(params.path)`), **or (ii)** the focused AX element is a text area/field/contenteditable, trigger is `typing_pause`, and `new_chars` is a genuine insertion of ≥40 chars — which makes VS Code, Notes, Obsidian, Bear, Word, Pages and Mail-compose work with no per-app integration. | new recognizer | ○ |
| T6-19 | **Stream key `write:<doc_path>`,** not `domain+day` — the document is the identity, the day is the batching unit. One 57-day arc instead of 92 shards. Event carries `ts`/`ts_end`, `added_chars`/`removed_chars`, the added text **in order** (not the whole document re-sent), a content-addressed `doc_snapshot_ref`, and `is_own_writing: true`. | chains + ingest | ○ |
| T6-20 | **Folder + app allowlist as the *consent* unit, empty by default, never a denylist.** Nothing is ever read from disk — this only scopes what the lens labels as yours. | consent UI | ○ |
| T6-21 | **R1 — ephemeral until settled.** A writing event does not reach the understanding lane until its session has been idle ≥10 min and the document still exists. A sentence typed and deleted 30 seconds later must never become a claim about you. | recognizer | ○ |
| T6-22 | **R2 — never quote drafts back proactively.** Assist may say "you've been on the paperclip roadmap three days running" (title + metrics) and never quote content. Grounded chat may quote when *you* ask. | assist prompt + code check | ○ |
| T6-23 | **Rails:** never watch a folder containing `.env`, `.ssh`, key material or `.git` internals; and **whitelist `path` on `*.localhost:7373`** in the T6-1 stripper, or connecting writing silently destroys the identity it depends on. | T6-1 + recognizer | ○ |

### 6e. Local OCR — blocked on Q3

Confirmed on this Mac, offline: `VNRecognizeTextRequest`, 30 languages, `conf 1.00`, **63 ms** for
1512×982 and **109 ms** for a 3024×1964 retina window at `.fast` (identical character counts to
`.accurate` on rendered UI text) — ~0.03% of one core. Build wrinkle: Swift `import Vision` fails on
this bare CommandLineTools install (`redefinition of module 'SwiftBridging'`); plain
`clang -framework Vision` works, so Vision needs a ~40 LOC ObjC shim following the existing
CommonCrypto precedent. AX-poor detection is not a close call — Claude desktop **13 chars**,
System Settings 525–858, Brave **21,998**; threshold ~200 chars.

| # | Item | Status |
|---|---|---|
| T6-24 | **The one rule that does all the work: OCR output enters the pipeline as `RawCapture.text`, never as a separate frame type.** `Snapshotter.process()` computes `privacy.dropReason(for: raw)` *before* anything is hashed, diffed or emitted, so OCR text inherits the password-manager blocklist, private-window detection, global pause, per-app pause and the Node-side re-check with zero new code. Any design that emits OCR as its own frame kind loses all of it. | ? |
| T6-25 | **Firing conditions (all must hold):** app on a per-app allowlist that is **empty by default** · `ax_poor` over the last 5 captures · trigger ∈ {app_switch, window_switch, typing_pause}, **never heartbeat** · ≥20 s since the last OCR of this stream. | ? |
| T6-26 | **Six compensating checks** for sub-window secrets: C1 window-only capture never display capture (biggest mitigation, costs nothing) · C2 occlusion abort via `CGWindowListCopyWindowInfo` · C3 secure-field abort on any `AXSecureTextField` · C4 post-OCR line redaction before hashing (a backstop, and it must be described that way) · C5 allowlist + live menu-bar indicator · C6 hard NEVER-OCR list checked *before* the allowlist. Images never written to disk, never a blob ref, never in a crash log; `CGImageRelease` before use, plus a test asserting no path can serialize a `CGImage`. | ? |
| T6-27 | **Consent copy must say "this reads your screen,"** not "this fills a gap in accessibility text." It costs a **Screen Recording** grant the product has never asked for. | ? |

---

## Tier 7 — Evals and verification

| # | Item | Status |
|---|---|---|
| T7-1 | **CROSS-N50 fixture (~$0.30)** — 50 events, 6 known threads, 3 sources. No episode may cite events from two unrelated threads; the deliberately related chat+booking pair must join ONE space via two episodes. Quality above N=2 has **never been measured** (TOP-09 tested merge errors only at N=2) — this is the eval gap that gates large-N batching. | ○ |
| T7-2 | **Mechanical Critic coverage check** — every alias appears in exactly one of episodes/unsorted. | ○ |
| T7-3 | **Dispatcher regression test:** 3,000 undispatched events over 500 streams asserts `route` is called ≤ `cfg.slots` times per tick. | ○ |
| T7-4 | **Eval run for T1-3 (stage-3 transport)** — it replaces the default agent prompt `orient.v6` was tuned against. | ○ |
| T7-5 | **TIM-04 red on tracked gates** — Haiku buffers fire times early; likely fix is a `decide.v9` rule. Carried from the P0–P4 build. | ○ |
| T7-6 | **PENDING eval fixtures whose surfaces arrive in P5:** CIR-01..03, FIX-06, ROL, BRW-04/06/07. | ○ |
| T7-7 | **Live-eval judge variance** — Haiku flips 1–4 cases per full run, all pass on retry. Gate agents used best-of-N; decide whether that is the permanent policy. | ○ |
| T7-8 | **Remaining human steps:** real-phone WhatsApp pairing, installed-app visual inspection. | ○ |

---

## Tier 8 — Hygiene

| # | Item | Where | Status |
|---|---|---|---|
| T8-1 | **Populate `runs.pass` and `runs.origin` at insert.** NULL across all 18,031 rows; filling them makes "which code path is spending this?" one query. | `brain/llm.ts:385-437` | ○ |
| T8-2 | **Close the trace gap.** Write the trace row in the same transaction as `extraction_runs`, or reconcile on startup. 1,508 runs have no trace; the JSONL under-reports by ~8%. | `traces/index.ts`, `brain/llm.ts` | ○ |
| T8-3 | **Route the three unpooled provider call sites through the pool** — `scheduler/digest-pass.ts:142`, `grounded/handlers.ts:170`, `media/describe.ts:600,711` — and pass an explicit bounded `onDigestBundle` from `index.ts:161` instead of inheriting the fire-and-forget default at `dispatch.ts:605-614`. | as cited | ○ |
| T8-4 | **Give per-event timestamps second precision** in `short()` if minute precision proves too coarse — millisecond truth is already in the DB, `pack.ts:258` just renders minutes. One line. | `pack.ts` | ○ |
| T8-5 | **Decide whether the tab-chain root hash stays on the payload** as a queryable view once `domain+day` becomes the key. Cheap to carry, dead weight if never used. | payload | ? |

---

## Blocked on your decision

| Q | Question | Cost of each branch |
|---|---|---|
| **Q1** | **Screen freshness: "Live" or "Balanced"?** 300 s backoff cap ≈ **$33/mo**, screen understanding ≤5 min behind you. 600 s ≈ **$20/mo**, lagging ~10 min. Nudges are unaffected either way — express is not window-bound. | one setting, two labels |
| **Q2** | **Does deep history ever get *processed*, or is it search-only forever?** 8 years of WhatsApp: **$0 to index, ~$19 and ~5 hours to understand.** If "understand my whole life" is a thing you'd buy once, the day-bundle replay needs to be a resumable, pausable, progress-visible background job. If not, tier (a) never scales past a few hundred days and the job stays simple. | changes T2-2's scope |
| **Q3** | **Do we ask for Screen Recording at all?** OCR is confirmed local, free, 109 ms, multilingual — but it needs a permission that lights macOS's own recording indicator and re-prompts, and the six checks in T6-26 are mitigations, not guarantees. The alternative is honest and cheap: don't ask, and accept that Figma canvases, video, games and poor-AX Electron apps are simply not understood. Ship the allowlist machinery either way. | gates T6-24..27 |
| **Q4** | **When you shorten the processed window, what happens to what was already understood?** Proposed: it **stays**, labelled, with one-click review-and-delete — it is a true record of what happened, and silently erasing it rewrites your history. The other reading is equally coherent: "stop processing days 31–90" *means* "forget them." A values call. | gates T4-2's UI |
| **Q5** | **Transport: subscription CLI (stage 2/3) or Messages API direct?** T1-4. | architectural |
| **Q6** | **The 3,452 browser events already captured without consent** — keep-or-delete card, or silent delete? T4-14. | one-time |

---

## Suggested order

1. **Tier 0** (T0-1..8) — the machine is not safe to run until these land. Do not boot a worker against the production home to verify; the tests are enough.
2. **T1-1 + T1-2** — no behaviour change, ~5× cheaper, privacy-positive. Independent of everything else.
3. **T0-9..15** — the rest of the rails.
4. **T3-1 → T3-2** — pool lane, then `[NOW]`/`[OPEN TASKS]`. Both are worth shipping even if unification never happens.
5. **T4-1..4** — the consent gate and the two-tier predicate. Everything downstream assumes it, and *nothing else about screen should ship before it* (settled in-session: hold assist on screen events until consent ships).
6. **T2-*** — the re-key migration, day/window bundles, per-item salvage, `episode_events`. One migration, ~500–700 LOC.
7. **T6-1/2, T6-7/8** — the four cheapest quality wins in the document.
8. **T7-1** — measure large-N before committing to it.
9. **T3-3** behind that gate, then Tier 5, then the rest of Tier 6.
