# Incident: runaway `claude -p` spawning, 2026-08-29

**Status:** contained. Nothing is running now — no worker process, no listener on 8013, no `claude -p`, no LaunchAgent. `/Applications/SuperTwinV13.app` is deleted.

**Severity:** ~18,000 model calls and ~530M input tokens in 17.7 hours, ~15,900 calls of it in one 8h56m stretch. Roughly 30% of a weekly subscription allowance.

**The one-line finding:** this is a product defect in the shipped worker, not only an agent-session mistake. The dispatcher's orphan scan re-dispatches the *entire* backlog every 5 minutes with no cap, no de-duplication, and no attempt ceiling. An agent session left a worker running that had nowhere to stop; the same loop had already been running inside the user's installed app for the 50 minutes before that.

All times UTC. Local (IST) = UTC+5:30.

---

## 1. What happened

On first launch the worker silently imports **90 days of browser history** from every Chrome/Safari/Arc/Brave profile on the machine (`worker/src/adapters/browser/watcher.ts:132`, `const floor = opts.sinceMs ?? this.now() - 90 * DAY_MS`). That produced 3,452 `browser.visit` events across 2,436 distinct streams in a single hour.

Every 5 minutes the dispatcher wakes up. It picks **4** of those streams to send to the model — that part is correctly capped. Then it runs a second pass, the "orphan scan," which collects *every* event still not marked as processed and sends **all of them** with no cap at all (`worker/src/scheduler/dispatch.ts:626-635`). With 2,400 streams and a drain rate of 4 per window, essentially the whole corpus crossed the 15-minute orphan threshold before it could be processed. From that point the worker re-submitted the entire backlog every 5 minutes, forever.

Nothing stopped the pile-up. There is no check for "this bundle is already in flight" (`worker/src/brain/consumer.ts:143-164` tracks promises in a `Set` keyed by nothing), no re-validation before the model call, no attempt counter, no backoff, and no spend cap anywhere on this path. Work queued far faster than 8 concurrent CLI calls could drain it, so calls sat in the queue for hours and then ran anyway — the same stream's same single event was sent to the model **eleven separate times** over seven hours.

Two processes ran this loop. First the installed app's own bundled worker, for ~50 minutes. Then an agent-session dev worker on the same port, same database, same live provider, which nothing ever killed — it kept spending for 8h56m with no window open and, after the app was deleted, no app either. Deleting the app changed nothing because the app was never the thing holding port 8013 at that point; when the user re-launched it at 13:05Z it failed to start with `EADDRINUSE` because the orphaned worker owned the port.

---

## 2. Exactly what it cost

From `~/SuperTwinV13/supertwinv13.db`, read-only. Ledger totals: `runs` 18,031 rows, `extraction_runs` 18,031 rows.

### By phase

| Phase | Process | Calls | Window | Input tok | Output tok | Cost |
|---|---|---|---|---|---|---|
| A | Baseline / normal use | 619 | 08-28 19:37 → 08-29 03:22 | 18.1M | 139K | $17.51 |
| B | **Installed app's own sidecar** | 1,527 | 03:26:49 → 04:16:57 | 34.5M | 476K | $25.10 |
| C | Agent worker #1 (5 min, no completions) | 0 | — | — | — | $0.00 |
| D | **Orphaned agent worker (PID 19866)** | **15,885** | 04:28:31 → 13:19:13 | **477.5M** | **5.36M** | **$469.47** |
| | **Total** | **18,031** | | **530.1M** | **5.97M** | **$512.08** |

### By pass

| Pass | Calls | Cost |
|---|---|---|
| `orient.v6` | 16,654 | $476.13 |
| `critic.v4` | 965 | $24.22 |
| `decide` | 186 | $6.56 |
| `consolidate` | 66 | $1.44 |
| all others (extract, assist, followup, digest, bar-action, correction-parse, brief) | 160 | $3.73 |

Plus eval-lane passes recorded only in `traces` (`eval-judge` 670, `executor.v1` 46, `bar-answer.v1` 1, ≈$19.60), all of which **ended at 01:21Z — over two hours before the runaway began** and are not part of it.

### Rate

Phase B (the app): **38–41 calls/minute** sustained. Phase D: ~30 calls/minute for nine hours, one `claude -p` every ~2 seconds. Baseline was 0.4–0.7/minute. That is a **50–80× amplification**, and the app's own copy ran *faster* than the orphan did.

### Caveats on the numbers

- **The dollar figures are list-price equivalents, not billed dollars.** Every call went through the local `claude` CLI, which draws on the subscription allowance. `cost_usd` is what the tokens would cost at Haiku API list price. The real damage is the volume: **530M input / 5.97M output tokens**, consistent with the observed ~30% of a weekly allowance.
- **The trace file under-reports; the DB ledger does not.** `traces` has 17,240 rows and `traces/2026-08-29.jsonl` has 16,346 lines, but **1,508 runs have no trace row at all**. Anyone reconstructing this from the JSONL alone will under-count by ~8%. `runs` / `extraction_runs` are the complete ledger.
- **A prior analysis claimed the ledger broke at 05:18Z, leaving ~13,000 calls unbilled. That is wrong.** `runs.started_at` maxes at `05:18:14.389Z` but `runs.ended_at` maxes at `13:19:13.830Z`. `started_at` is minted *before* the queue wait (`worker/src/brain/llm.ts:302` vs `:329`), so 05:18 is the last *enqueue*, not the last call. Rows kept completing for 8 more hours. The ledger is intact.
- **True cost is slightly higher than $512.** Any call that spawned the CLI but failed before the `extraction_runs` insert is in neither ledger. Only 12 rows carry `CLI_ERROR`, so this is a small margin, not a large hidden one.

The `quota_usage` table has **0 rows**. Nothing metered any of it.

---

## 3. Root causes

### (a) Process / session hygiene — what started the long tail

**A build subagent started a worker against the real production home and never killed it.**

- Command, from `~/.claude/projects/-Users-adityakatare-Documents-SuperTwinV13/c53a8868-.../subagents/workflows/wf_bec708a2-f85/agent-af961d1f9b827ee04.jsonl` at `04:23:07.131Z`:
  `pkill -f "supertwinv13/worker"; pkill -f "worker/src/index"; lsof -ti:8013 | xargs -r kill; (npm run worker > .../worker.log 2>&1 &); sleep 14; curl ...`
- `npm run worker` → `package.json:14` `"worker": "npm run dev -w @supertwinv13/worker"` → `worker/package.json` `"dev": "tsx src/index.ts"`. **No `SUPERTWIN_HOME`, no port override.** `worker/src/home.ts:33-38` therefore resolves `~/SuperTwinV13` — the user's real data — and `worker/src/index.ts:43` registers the live `claude-local` provider unconditionally.
- Confirmed boot: `~/SuperTwinV13/logs/worker-node.log` `2026-08-29T04:23:11.304Z [log] WORKER_READY port=8013`, the last `WORKER_READY` in the file. Shutdown at `13:19:16.284Z` on the user's kill. **8h56m05s.**
- **The `( … & )` idiom is what made it survive.** A subshell fork backgrounds the job and exits immediately, so the worker is reparented to launchd and is not in the outer shell's job table — nothing in session teardown can reap it. Sibling agents in the same session that used `timeout 25 … &` + `kill %1`, or bound port 8113 with `SUPERTWIN_HOME=/tmp/stv13-verify`, all cleaned up correctly. This one used the default home, the default port, and never cleaned up. Its own `pkill` patterns could not have matched it either — actual argv is `tsx src/index.ts`, not `worker/src/index`.
- The agent reported "Done. Everything is committed and green." at `04:27:00.706Z`. **8h52m of the spend happened after that.**
- **A sibling agent found the orphan and deliberately left it.** `agent-a23f1c4463c3b1e7d.jsonl` at `05:38:19Z`: `echo "(8013 left alone — not mine)"`, and again at `05:50:52Z`: `"--- production worker on 8013 (not mine, left running) ---"`. It had started that process's predecessor 75 minutes earlier. That was the last chance to catch this at ~$60 instead of ~$470.
- **The repo has no CLAUDE.md.** `README.md:32` documents `npm run worker   # run the worker directly (tsx)` with no warning that it binds the user's real home and makes live billed calls.
- **The containment pattern already existed and was applied three minutes too late, to the wrong entry point.** Commit `be89cc5` at `04:15:15Z` — "FIX: isolate the eval harness from the production home" — created `worker/src/evals/home.ts` with `establishEvalHome()` / `assertEvalDbIsolated()`. It guards `npm run eval` only. At `04:18:16Z`, three minutes later, a sibling agent booted the full worker past that boundary via `npm run worker`.

### (b) Product defects — what made it unbounded once started

1. **The orphan scan has no cap.** `worker/src/scheduler/dispatch.ts:625-635`. The planned path is bounded by `assignSlots(plan, cfg.slots, gate)` with `slots: 4`. The orphan path is filtered only by a Cat-2 category gate and then routed in a bare `for` loop — `assignSlots` is never applied, no `.slice()`, no limit. Every event with `dispatched_at IS NULL` older than `orphanWindows(3) × windowMs(5min) = 15 minutes` is re-bundled and re-sent every window.
   `worker-node.log`: `03:26:18.057Z [dispatch] window: 4 bundle(s), 0 deferred, 3340 orphan(s)` … `13:18:11.541Z [dispatch] window: 4 bundle(s), 0 deferred, 798 orphan(s)`. The last four windows are pinned at 798 with zero decay — a non-converging fixed point that would have run forever.

2. **No in-flight de-duplication.** `worker/src/brain/consumer.ts:143-164`. `inflight` is a `Set<Promise<void>>` keyed by nothing. `dispatched_at` is only stamped at the *end* of a tick (`markDispatched`, `dispatch.ts:451-459`), and both `collectTick` and `orphanScan` select on `dispatched_at IS NULL`. Window N+1 re-collects everything window N is still working on and starts a second copy. The code comment at `consumer.ts:91-93` asserts the opposite — *"serial per stream by construction … an unmarked bundle re-collects rather than double-dispatching"* — that assumption is simply false.
   Measured: `browser:chrome:chain:127a3ba1070d4b8b` holds exactly **one** event row (created once at `01:33:36`, never re-inserted) and logs `[brain] tick … committed` **eleven times** between 05:31 and 12:52.

3. **No re-validation before the model call.** `runBrainTick` (`consumer.ts:26-76`) goes straight to `ensureDigests` → `runOrient` without re-checking whether the bundle's events are still undispatched. **13,152 of 16,654 orient calls sat in the queue for over an hour** before running (max **28,859s = 8h01m**) — every one of them already superseded, every one of them paid in full.

4. **Quarantine is an infinite retry loop, by design.** `consumer.ts:12-14` states it outright: *"A quarantined Orient call does NOT markDispatched: the orphan scan re-queues the events."* A failed bundle returns to the orphan set 15 minutes later, forever. Nothing reads the `quarantine` table back to suppress re-issue — the only readers are the ops HTTP routes (`worker/src/server/ops-routes.ts:199,205`). No attempt counter, no dead-letter, no backoff exists anywhere on this path.

5. **The pool's waiter queue is unbounded.** `worker/src/providers/pool.ts:110` — `private readonly waiters: Array<() => void> = []`, pushed with no cap. The pool throttles concurrency, never admission. That array is where the 8-hour waits accumulated, and it is why the loop absorbed an infinite feed instead of applying backpressure.

6. **Nothing is gated on user consent.** `worker/src/index.ts:97,160-176` starts the browser watcher, brain consumer, dispatcher, consolidation job, and assist lane unconditionally at boot. The 90-day history backfill (`watcher.ts:132`) is both the token trigger and an unasked-for privacy surface.

### (c) Missing guardrails — why it stayed invisible for nine hours

1. **The only token limit in the product does not cover the path that burned.** `worker/src/server/index.ts:914-921` is the single enforcement point (`QUOTA_TOKEN_LIMIT`, default 5,000,000 billable per 5h) and it sits **inside the chat SSE handler**. Its own comment at `:212`: *"Kept high so evals are never blocked."*

2. **The background passes don't even write to the counter that gate reads.** `db.addUsage()` — the only writer to `quota_usage` (`worker/src/db/index.ts:591`) — is called from exactly one place, `worker/src/server/index.ts:1150`, the chat handler. `brain/llm.ts` `logRun()` writes `runs` and `extraction_runs` and never calls it. Result: `quota_usage` = **0 rows** against 18,031 real calls.

3. **No cost ceiling anywhere.** `cost_usd` appears only in read paths — `/api/quota`, `settings-routes.ts`, `RunsPanel.tsx`. Nothing compares a spend sum against a limit. `DEFAULT_EXECUTOR_BUDGET.costUsd = 1` (`worker/src/prompts/executor.v1.ts:52`) is interpolated into prompt *text* and never checked in code.

4. **The circuit breaker exists and is not wired in.** `worker/src/providers/pool.ts` implements the whole error policy — refusal detection, 60s→900s doubling lane pause, the 2/10/30s ladder, concurrency halving. `pool.noteFailure` / `noteSuccess` are called from exactly one file: `worker/src/prompts/runner.ts:485,491`, the legacy V11 wire runner. `worker/src/brain/llm.ts:329` calls `pool.run("llm", …)` for the semaphore only and discards the failure signal. Every V13 pass — Orient, Critic, Digest, Decide, Assist — has no failure feedback into the pool at all.

5. **The per-stream rate cap is dead code and was tree-shaken out of the shipped binary.** `worker/src/scheduler/lanes.ts:257` defines `LIVE_PASSES_PER_HOUR = 20` and `:347` enforces it, backed by a DB ledger in `worker/src/scheduler/live-budgets.ts` whose own comment (`:13`) warns *"A counter that resets on restart is a counter that gives a runaway stream a fresh 20 passes."* Its only consumer is `worker/src/scheduler/live.ts`, which **has zero importers in `worker/src`**. Three confirmations it never ran: `app_state` has 0 `live_ledger:%` rows; `worker/src/index.ts` never imports it; and `grep -ac LIVE_PASSES_PER_HOUR worker/bundle/worker.cjs` → **0**.

6. **No provenance in the ledger.** `runs.pass` and `runs.origin` are NULL for all 18,031 rows. "Which code path is spending this?" required reconstructing enqueue epochs from `duration_ms` instead of being one query.

7. **No live spend surface, no kill switch, no orphan self-shutdown.** Nothing pushes a running spend figure. `POST /api/ops/lanes/pause` exists but is not bound in `src/lib/api.ts`, is capped at `MAX_MANUAL_PAUSE_MS = 60min` and self-resumes, is in-memory only, and doesn't reach the three provider call sites that bypass the pool (`worker/src/scheduler/digest-pass.ts:142`, `worker/src/grounded/handlers.ts:170`, `worker/src/media/describe.ts:600,711`). `worker/src/index.ts:181-205` handles only SIGINT/SIGTERM — no parent-PID watch, no idle exit.

---

## 4. Can this happen to a real user of the shipped 13.4.7 app?

### Yes. Not "in principle" — it already did, on this machine, before any agent worker existed.

This was the point the four investigation lanes disagreed on. Settled against primary evidence:

**It is observed, not inferred.** Phase B of the accounting — **1,527 calls, 34.5M input tokens, $25.10 between `03:26:49Z` and `04:16:57Z`** — came from the Tauri app's own bundled sidecar. The first agent worker did not boot until `04:18:17Z`, 80 seconds *after* Phase B ended. During those 50 minutes the app ran at **38–41 calls/minute**, faster than the orphaned dev worker's later steady state.

**The log evidence is unambiguous once you know which file is which.** `~/SuperTwinV13/worker.log` is written only by the Tauri shell for its own child process (`src-tauri/src/lib.rs:64-91`). `~/SuperTwinV13/logs/worker-node.log` is the shared console tee at `SUPERTWIN_HOME`, written by whichever worker is running. `worker.log` contains **11** dispatch-window lines, `03:26:18Z → 04:16:58Z`, byte-identical to the first 11 of the 118 lines in `worker-node.log`:

```
worker.log:       1787973978057 [worker:err] [dispatch] window: 4 bundle(s), 0 deferred, 3340 orphan(s)
worker-node.log:  2026-08-29T03:26:18.057Z [error] [dispatch] window: 4 bundle(s), 0 deferred, 3340 orphan(s)
```

Same event, same 3,340-orphan fan-out, logged by the app about itself. (One lane read the shared `worker-node.log` as exclusively app output and concluded all 118 windows were the app; another saw only 11 windows in `worker.log` and concluded the app was uninvolved. Both halves are wrong; the split at line 11 is the boundary between the two processes.)

**The shipped 13.4.7 binary contains the same loop.** `worker/bundle/worker.cjs` (1,152,435 bytes, built Aug 29 11:27, byte-identical to the copy inside the release `.app`) contains `admittedOrphans`, `orphanScan`, `assignSlots`, `startDispatcher`, `startBrainConsumer`, `startBrowserWatcher`, and the literal constants `slots: 4` and `orphanWindows: 3`. It contains `LIVE_PASSES_PER_HOUR`: **0 occurrences** — the cap is not in the binary. `git log` shows `worker/src/scheduler/dispatch.ts` last touched at `e1d3930` (P1.6) and `worker/src/brain/consumer.ts` at `794960d` (P1.3), both long before 13.4.1. **13.4.7 and 13.4.1 are identical on every implicated line.**

**The trigger requires nothing but launching the app.** Tauri spawns the worker at setup → the browser watcher starts with no opt-in and backfills 90 days → a normal Chrome profile yields thousands of visits and thousands of streams → the planner drains 4 per 5-minute window while everything older than 15 minutes becomes an orphan → from window 4 onward every window re-routes the whole backlog. No dev flag, no eval harness, no unusual setting.

**It will resume on next launch.** 798 events across 298 streams are still `dispatched_at IS NULL` in `~/SuperTwinV13/supertwinv13.db` — exactly the orphan count in the final dispatch log line. An unpatched build picks up from that state within 15 minutes of boot.

**Do not install or run 13.4.7 unpatched.** The agent-session mistake extended the burn from ~50 minutes to ~9 hours; it did not create it.

---

## 5. Proposed fixes

Nothing below has been applied. No code was changed and nothing was committed — this file is the only artifact.

### P0 — ship-blockers

**1. Cap the orphan path through the same slot gate as the planned path.**
*Change:* route `admittedOrphans` through `assignSlots(...)`, or at minimum `.slice(0, cfg.slots - slotted.length)`, prioritized oldest-first, so total routed bundles per window can never exceed `cfg.slots`.
*File:* `worker/src/scheduler/dispatch.ts:630-635`.
*Verify:* unit test with 3,000 undispatched events over 500 streams asserts `route` is called ≤4 times per tick; then a fixture-DB run asserts the `[dispatch] window` line never reports more routed bundles than slots.
*Blast radius:* small and contained to the dispatcher. Backlog drains slower — that is the point. Highest leverage single change in this list.

**2. In-flight registry keyed by stream; refuse to double-submit.**
*Change:* replace `Set<Promise<void>>` with `Map<string, Promise<void>>` keyed on `streamId:minRowid-maxRowid`; `onBundle` returns early if the key is present. This is the guard the assist lane already has at `worker/src/assist/watcher.ts:214-216`.
*File:* `worker/src/brain/consumer.ts:143-164`.
*Verify:* test that calling `onBundle` twice with the same bundle before the first settles produces exactly one `runOrient` call.
*Blast radius:* small. Without this, fix 1 is still defeated by any window slower than 5 minutes.

**3. Re-validate the bundle at execution time.**
*Change:* at the top of `runBrainTick`, re-query `events.dispatched_at` for the bundle's rows; return `{status:"stale"}` with no model call if they are already marked.
*File:* `worker/src/brain/consumer.ts:26-31`.
*Verify:* test that a bundle whose events are marked between enqueue and execution makes zero provider calls.
*Blast radius:* small; one extra indexed read per tick. This alone would have zeroed the 13,152 hour-plus-queued calls.

**4. Hard spend and call ceiling at the single spawn site.**
*Change:* new `worker/src/providers/budget.ts`; enforce in `worker/src/providers/claude-local/index.ts` immediately after `assertTraceContext`, because that sits downstream of the three pool bypasses. Rolling counters off `extraction_runs`. Suggested defaults: **$3/hour, $15/day, 400 calls/hour, 3,000 calls/day** — ~20× a plausible steady-state day and ~3.5% of what actually burned. On breach, throw `BUDGET_EXCEEDED` *before spawning*, latch a persisted `budget_tripped_at` in `app_state`, and require explicit user reset. Do not auto-resume on the hour. Exempt interactive chat and the grounded bar from the *latch* (still counted) so a tripped budget doesn't brick the UI needed to diagnose it.
*File:* `worker/src/providers/claude-local/index.ts`, new `worker/src/providers/budget.ts`.
*Verify:* test that call N+1 past the ceiling throws without spawning a child; integration test that a tripped latch survives a worker restart.
*Blast radius:* touches every model call in the product — the reason it works, and the reason the exemption for interactive paths matters. This is the backstop that catches runaways not yet written.

**5. Make `npm run worker` structurally safe; make the production path explicit.**
*Change:* repoint `"worker"` at a small `scripts/dev-worker.mjs` that defaults `SUPERTWIN_HOME` to a scratch dir under `os.tmpdir()` unless the caller set one, defaults `SUPERTWIN_WORKER_PORT` to 8113 so it can never collide with the installed app, writes a PID file and refuses to boot if a live one exists, and arms a max-lifetime self-kill (default 30 min). Add a separately named `"worker:live"` that carries the production home, so choosing it is deliberate.
*File:* `package.json:14`, new `scripts/dev-worker.mjs`.
*Verify:* `npm run worker` with no env writes to a temp dir and exits on its own; `lsof -i:8013` stays empty.
*Blast radius:* dev workflow only. Zero production risk. This single change makes the incident's start command harmless.

**6. Refuse to boot against the real home without an explicit signal.**
*Change:* lift `isProductionDbPath()` / `productionHome()` out of `worker/src/evals/home.ts` into a shared `worker/src/home-guard.ts`; call it as the first statement of `main()`. If the resolved home is `~/SuperTwinV13` and the boot is not app-launched (a token the Tauri sidecar spawner sets, e.g. `SUPERTWIN_LAUNCHED_BY=app`), throw with the named remedy. Waiver: `SUPERTWIN_ALLOW_PRODUCTION_HOME=1`.
*File:* `worker/src/index.ts:42`, `worker/src/evals/home.ts`, new `worker/src/home-guard.ts`.
*Verify:* `tsx worker/src/index.ts` with no env exits non-zero with the guard message; with the app token set, it boots.
*Blast radius:* the app must set the token or it stops booting — verify the Tauri spawn path in the same change. Belt-and-braces for 5, and it protects every future caller.

**7. Orphan self-shutdown.**
*Change:* require a liveness signal — `process.ppid` watch (exit when the parent becomes 1) or a heartbeat from the Tauri shell — and exit after 10 minutes without one. `SUPERTWIN_WORKER_NO_PARENT=1` for deliberate headless runs.
*File:* `worker/src/index.ts:181-205`.
*Verify:* kill the parent shell; the worker exits within 10 minutes with a logged reason.
*Blast radius:* small, but needs care so a legitimately backgrounded app worker isn't reaped. This is the fix that would have ended the incident on its own, at ~10 minutes instead of 8h56m.

### P1 — before the next release

**8. Attempt ceiling, dead-letter, and backoff per bundle.**
*Change:* add `attempts` / `last_attempt_at` / `dead_letter_at` keyed on `(stream_id, min_rowid, max_rowid)`; `orphanScan` excludes dead-lettered ranges and gates re-queue on `now - last_attempt_at > base * 2^attempts` (5→10→20 min). After 3 attempts, dead-letter, surface in the existing ops quarantine view, never auto-retry.
*File:* new migration beside `worker/src/db/migrations/0100_v13_core.ts`; `worker/src/scheduler/dispatch.ts:488-561`.
*Verify:* a bundle whose Orient always quarantines is attempted exactly 3 times, then appears on `/api/ops/quarantine`.
*Blast radius:* schema change plus dispatcher logic. Closes the documented infinite loop at `consumer.ts:12-14`. "Never drop a bundle" currently means "retry forever at $54/hour" — containment needs a floor.

**9. Wire the circuit breaker that is already written.**
*Change:* in `callOnce`, call `pool.noteSuccess(lane)` on ok and `pool.noteFailure(\`llm:${lane}\`, {code, message}, retriesSpent)` otherwise, honoring the returned decision — exactly as `worker/src/prompts/runner.ts:485,491` already does. Add a consecutive-failure breaker: 10 non-refusal failures on a lane → pause 30 min, raise a UI banner.
*File:* `worker/src/brain/llm.ts:315-390`.
*Verify:* simulate 3 refusals; assert the lane pauses and pool concurrency halves.
*Blast radius:* ~25 lines, zero new machinery — `pool.ts:186-261,442-464` already implements all of it.

**10. Meter background passes into the quota window.**
*Change:* `logRun()` also calls `db.addUsage(...)`. Revisit the `5_000_000` default at `worker/src/server/index.ts:214` and the `50_000_000` near-limit at `worker/src/db/index.ts:40` — both are set to "never block an eval," which means never block anything.
*File:* `worker/src/brain/llm.ts:385-437`.
*Verify:* after a fixture run, `quota_usage` row count matches `extraction_runs` row count.
*Blast radius:* small. Prerequisite for `/api/quota` to mean anything.

**11. Bound the pool waiter queue.**
*Change:* cap `Semaphore.waiters` (suggest 4× capacity) and reject or shed on overflow so backpressure reaches the dispatcher. Surface `waiting` (already exposed at `pool.ts:124`) on `/api/ops`.
*File:* `worker/src/providers/pool.ts:110,143-158`.
*Verify:* submit 10× capacity; assert overflow rejects rather than queueing, and that queue depth is readable from the ops route.
*Blast radius:* changes failure mode from "silent 8-hour wait" to "visible rejection." Callers must handle the rejection.

**12. Gate the browser-history backfill on consent, and bound the first sweep.**
*Change:* opt-in per browser profile, a default lookback far shorter than 90 days, and a cap on events admitted per first sweep.
*File:* `worker/src/index.ts:97`, `worker/src/adapters/browser/index.ts:58-66`, `worker/src/adapters/browser/watcher.ts:132`.
*Verify:* fresh home + no consent → 0 events ingested; with consent → bounded count.
*Blast radius:* changes first-run behavior and the product's data model on day one. Also closes an unasked-for privacy surface.

**13. Live spend counter and a real kill switch.**
*Change:* per-minute spend heartbeat from the provider pool — `[spend] 60s: 27 calls, 1.9M tok, ~$2.20 | run 8h56m` — into the same log an operator is already tailing. Add a persisted `app_state` key `model_activity_paused` checked at the same choke point as fix 4, surfaced as "Stop all model activity" in `src/screens/settings/GeneralPanel.tsx`, plus the missing `/api/ops/lanes/pause` binding in `src/lib/api.ts`. Remove or greatly raise `MAX_MANUAL_PAUSE_MS` (`ops-routes.ts:59`) — a kill switch that self-resumes after an hour is not a kill switch.
*File:* `worker/src/providers/pool.ts`, `worker/src/providers/claude-local/index.ts`, `src/screens/settings/GeneralPanel.tsx`, `src/lib/api.ts`.
*Verify:* heartbeat appears within 60s of the first call; toggling pause stops new spawns and survives a worker restart.
*Blast radius:* new UI surface; the pause must not deadlock in-flight work.

**14. Repo rules for agent sessions.** *(Cheapest item on this list — the repo has no CLAUDE.md at all today.)*
*Change:* create `/Users/adityakatare/Documents/SuperTwinV13/CLAUDE.md` with a hard "Running the worker" section, and mirror it into the workflow orchestrator's per-agent RULES block (which covered tests but said nothing about processes):
- Never run `npm run worker`, `tsx worker/src/index.ts`, or `npm run tauri dev` without **both** `SUPERTWIN_HOME=<scratch>` and `SUPERTWIN_WORKER_PORT=<not 8013>`. 8013 and `~/SuperTwinV13` are the user's real app and real data.
- Never detach a long-lived process from a Bash tool call. `( cmd & )`, `nohup`, `disown`, and bare `&` are forbidden — they orphan the child past session teardown. Use `run_in_background: true` so the harness owns the child, or `timeout <n>` so the kernel does.
- Any agent that starts a server kills it by PID/port in the same turn, and its final report lists every port it opened and states each is closed. "Committed and green" is not a completed turn while a listener is up.
- **A listener you did not start is not automatically the user's app.** If you find one, report it. Never write "not mine, left running" and move on — that sentence, verbatim, cost hours of spend.
- Any command that can reach the `claude` CLI (worker boot, `npm run eval`, `*.integration.test.ts`) spends the user's tokens. Name the expected call count in your report.
Also update `README.md:32`, which currently presents `npm run worker` as an innocuous convenience script.
*Verify:* not mechanically verifiable — pair it with fixes 5 and 6, which are.
*Blast radius:* none. Documentation only.

### P2 — hygiene

**15. Populate `runs.pass` and `runs.origin`** at insert (`worker/src/brain/llm.ts:385-437`). NULL across all 18,031 rows today; filling them makes "which code path is spending this?" one query. Verify: no NULL `pass` after a fixture run. Blast radius: none.

**16. Close the trace gap.** Write the trace row in the same transaction as the `extraction_runs` row, or reconcile on startup. 1,508 runs have no trace; the JSONL under-reports by ~8%. Files: `worker/src/traces/index.ts`, `worker/src/brain/llm.ts`. Verify: `runs` count == matching `traces` count after a fixture run.

**17. Fix the dead digest path.** `worker/src/brain/consumer.ts:34-53` `toEnvelope` never sets `contentHash`, so `worker/src/packer/digest.ts:216-217` (`if (!hash) continue`) skips every event, always. Confirmed: 19 `digest` runs vs 16,654 `orient.v6`. Quality bug, not a cost bug — but it means Orient has been running on undigested context in production the entire time.

**18. Route the three unpooled provider call sites through the pool** — `worker/src/scheduler/digest-pass.ts:142`, `worker/src/grounded/handlers.ts:170`, `worker/src/media/describe.ts:600,711` — and pass an explicit bounded `onDigestBundle` from `worker/src/index.ts:161` rather than inheriting the fire-and-forget default at `dispatch.ts:605-614`.

**19. Isolate eval data from the production DB.** `events` still holds `villas.example` (46), `goibibo.example` (25), `stays.example` (15), `airbnb.example` (10) — all `origin='live'`, all still undispatched, all re-bundled every window forever. Give `worker/src/evals/` its own home by default, or stamp an `origin='eval'` that `collectTick`/`orphanScan` exclude. `npm run purge:eval-data` is manual and after-the-fact.

**20. Reap orphaned sidecars.** `~/SuperTwinV13/worker.log` records 7 `worker sidecar spawned` against 2 `worker sidecar terminated`. Add a pidfile plus a startup sweep that kills any pre-existing worker before spawning, and call `claudeLocalProvider.killAll()` on an unhandled-rejection path, not only SIGINT/SIGTERM. File: `src-tauri/src/lib.rs`, `worker/src/index.ts:188`.

**21. Resolve the two latent loops of the same shape** — `worker/src/assist/watcher.ts` never resets its accumulator on the evaluator-error (`:127-130`), not-actionable (`:134`), or duplicate-content (`:179-182`) paths, so a ready topic re-evaluates every 20s indefinitely; and `worker/src/adapters/whatsapp/adapter.ts:492-511` `cleanRestart()` has no backoff and no give-up threshold. Neither caused this incident (assist: 30 calls, $0.82; WhatsApp reaches no provider), but both are the same defect.

---

## 6. What I would do first with one hour

**Minutes 0–5 — make the machine safe right now.** Nothing is running; keep it that way. Do not launch 13.4.7. The 798 undispatched events in `~/SuperTwinV13/supertwinv13.db` are a loaded spring: an unpatched build resumes the loop within 15 minutes of boot. Either back up the DB and stamp those rows dispatched, or leave the app closed until fix 1 lands.

**Minutes 5–25 — fixes 1, 2, 3.** Three small, independent, well-tested changes in two files (`dispatch.ts`, `consumer.ts`). Cap the orphan path at `cfg.slots`; key the in-flight set by stream; re-check `dispatched_at` at the top of `runBrainTick`. Any one of the three would have capped this incident at a small fraction of its cost; together they close the loop itself. This is the highest value per minute available.

**Minutes 25–45 — fix 4.** The budget ceiling at the single spawn site in `claude-local/index.ts`. This is the one that protects against the runaway *not yet written* — the assist lane and the WhatsApp restart loop are the same defect wearing different clothes, and a hard stop upstream of all of them is worth more than fixing each. Set it aggressively low and tune upward.

**Minutes 45–55 — fixes 5 and 14.** Repoint `npm run worker` at a scratch home on a non-production port with a lifetime cap, and write the CLAUDE.md. Twenty minutes of work that makes the exact command that started this incident harmless, and tells the next agent session what the last one did not know.

**Minutes 55–60 — verify.** Run the existing dispatcher tests, add the one assertion that matters (`route` called ≤ `slots` times per tick with 3,000 orphans queued), and confirm `worker/bundle/worker.cjs` is rebuilt from the patched source before any release. Do **not** boot a worker against the production home to check — the tests are enough, and that is exactly the step that started this.

Fix 7 (orphan self-shutdown) is the one I would put at the top of hour two. It is the difference between a bad ten minutes and a bad nine hours, and it is roughly fifteen lines.
