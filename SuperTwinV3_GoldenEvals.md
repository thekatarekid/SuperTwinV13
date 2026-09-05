# SuperTwin V3 — Golden Evals
Evals for `SuperTwinV3_Product.md`. Same harness, case format, standing cast and hard-gate mechanics as `SuperTwinV13_GoldenEvals_V2.md`: **Setup · Input · Expected · Wrong · Gates**; model-facing cases run against the real model with an LLM judge; deterministic cases are code-asserted; failed cases spawn adversarial siblings.

* * *
## 0. What changes from V2
| V2 category | V3 status |
| --- | --- |
| BND (per-stream windows, orphan scan) | **replaced** — new BND below |
| AST (separate assist lane) | **replaced** — LIV below. AST-01, 04, 06, 08 are re-homed as LIV cases; AST-02/03/05/07/09 retired with the lane |
| CAT-03 (engagement promotes Cat 2 → Cat 1 timing) | **retired** with engagement tiers; CAT-01/02/04/05/06 stay |
| ROL, CIR, CHP, SCH, FUP, USR, FIX, BRW, TIM, TRC | **unchanged** — run as-is, must match or beat the frozen baseline |
| —   | **new**: CNS, CMT, CROSS, LIV, SPD, SRC, RET |

**Baseline.** `evals/baseline/v13.json` (Phase 0). Every carried-forward category is a regression gate: a category scoring below its baseline is a hard fail.

**Hard gates (V3).** V2's list, plus: `dispatch_over_cap = 0` · `double_submit = 0` · `calls_on_stale_bundle = 0` · `capture_without_consent = 0` · `assist_from_backfill = 0` · `nudge_without_grounding = 0` · `cache_create_1h = 0` · `cost_per_call ≤ $0.006` · `orphan_rows_after_delete = 0` · `full_vector_scan = 0`.

* * *
## BND — Bundling and dispatch (deterministic, code-asserted)
**BND-01 · One call per day, all sources, sectioned by stream.** 3 sources, 1 day, 60 events → exactly one bundle; sections `S1..Sn` each single-stream; temporal order inside sections; each head carries time + source (+ app/title/doc for screen). _Wrong:_ two bundles for one day; a section mixing streams.

**BND-02 · Oversized day splits at the largest gap.** 300 events, 45K chars, one 6-hour gap at 02:00 → two bundles split at 02:00. _Wrong:_ split at the char cap mid-burst.

**BND-03 · Backfill runs oldest → newest.** Days D1..D5 undispatched → dispatched in order; D3's pack contains D1–D2 episodes. _Wrong:_ newest first.

**BND-04 · Idle flush.** Events at t=0, 10 s, 20 s, then silence → one flush at 65 s. _Wrong:_ flush at 20 s; flush before 45 s idle.

**BND-05 · Max-age flush with backoff.** Continuous events every 10 s → flushes at 120 s, 240 s, 480 s, then capped by the freshness setting; reset after one idle flush. _Wrong:_ a flush every 120 s forever; no cap.

**BND-06 · Express.** Two events, one matching the intent regex → immediate flush; a third intent match inside 120 s does not fire again. _Wrong:_ express on a single event; no debounce.

**BND-07 · Novelty.** A repeated `content_hash` neither resets the idle timer nor counts. Heartbeats only → no flush. _Wrong:_ heartbeats keep the batch alive.

**BND-08 · Slot cap is absolute.** 3,000 undispatched events over 500 streams → `route` called ≤ `slots` per tick, every tick, including re-dispatch paths. Gate `dispatch_over_cap`.

**BND-09 · Keyed in-flight.** Same bundle key submitted twice before the first settles → one model call. Gate `double_submit`.

**BND-10 · Revalidate at execution.** Bundle rows marked processed between enqueue and run → zero calls, status `stale`. Gate `calls_on_stale_bundle`.

**BND-11 · Three strikes.** A bundle whose output always quarantines → attempts at 0, 5, 10 min, then dead-lettered, visible on `/api/ops/quarantine`, never retried. _Wrong:_ a fourth attempt.

**BND-12 · Bounded waiters.** Submit 10× pool capacity → overflow rejected, `waiting` readable on `/api/ops`. _Wrong:_ silent queueing.

* * *
## CNS — Consent (deterministic)
**CNS-01 · Nothing before yes.** Fresh home, all adapters present, no consent rows → 0 events after 60 s; no sidecar process; no WhatsApp daemon. Gate `capture_without_consent`.

**CNS-02 · Windows are enforced at the funnel.** Consent UNDERSTAND=7d, INDEX=all; import 90 d → all rows in archive; rows older than 7 d have `origin='archive'` and are never dispatched. _Wrong:_ an archive row in any bundle.

**CNS-03 · UNDERSTAND ≤ INDEX.** Setting UNDERSTAND=90d with INDEX=30d is rejected.

**CNS-04 · Widening is a replay.** UNDERSTAND 7d → 30d → the 23 extra days become dispatchable with no new archive rows and no adapter activity.

**CNS-05 · Pause stops capture, not nudges.** Pause browser → 0 new browser rows while WhatsApp continues; tray shows paused. _Wrong:_ pause only silences nudges.

**CNS-06 · Consent flips before teardown.** Adapter teardown throws → capture still blocked at the funnel.

**CNS-07 · Delete previews then cascades.** Delete WhatsApp → preview lists N events / M episodes / K spaces; after confirm, no episode, claim, task or bridge references a deleted event. Gate `orphan_rows_after_delete`.

**CNS-08 · Shortening keeps understanding.** UNDERSTAND 90d → 30d → episodes from days 31–90 remain, labelled; review-and-delete removes exactly those.

**CNS-09 · The card is honest.** Card cost/time/events for a fixture import; actual run lands within ±40% / ±30% / exact. Card text stored verbatim in `decisions`.

* * *
## CMT — Commit (deterministic + judge)
**CMT-01 · Explicit membership.** Every committed episode has `episode_events` rows equal to its cited aliases. No rowid ranges anywhere.

**CMT-02 · One stream per episode.** Model output citing events from S1 and S2 in one episode → rejected and quarantined as one item; other episodes commit. _Wrong:_ silent acceptance; whole bundle quarantined.

**CMT-03 · Per-item salvage.** 5 episodes, 1 malformed → 4 commit, 1 repaired or quarantined, cursor advances past the 4's events only. _Wrong:_ nothing commits.

**CMT-04 · Coverage.** Every input alias appears in exactly one of episodes / unsorted. Missing or double-listed alias → Critic flags it mechanically.

* * *
## CROSS — Cross-source batching quality (live)
**CROSS-N2 · (carried from TOP-09)** Two unrelated chats in one bundle → two episodes, never merged.

**CROSS-N50 · The fixture that gates large-N.** 50 events, 6 known threads, 3 sources (WhatsApp villa chat + villa tabs + goibibo booking; an unrelated work thread; Netflix; a family chat). Expected: no episode cites events from two unrelated threads; villa chat + villa tabs + booking → **one space, two episodes**; **exactly one** nudge with `grounded_in` spanning both sources. _Wrong:_ invented cross-thread episode; two nudges; nudge citing the work thread.

**CROSS-DAY · A full mixed day.** Real-shaped 120-event day → every stream section produces ≥1 episode or unsorted entry; no section silently dropped (output laziness). Gate: coverage 100%.

* * *
## LIV — The unified live lane
**LIV-01 · The villa sentence.** Episodes: villa booking in progress. Open task: "pay advance". `[NOW]` 16:10. New event: "advance by 5 pm today or they release it". Expected: nudge with urgency `today`, `deadline_at` 17:00, `grounded_in` = the new event, references the open task. _Wrong:_ no nudge; nudge without deadline; deadline misread.

**LIV-02 · Backfill never nudges.** Same event inside a day-bundle dated three months ago → understanding commits an episode; assist section absent or discarded. Gate `assist_from_backfill`.

**LIV-03 · Grounding is this flush.** Accumulated context from 3 weeks ago + one trivial new event → `grounded_in` cannot cite old events → no nudge. Gate `nudge_without_grounding`.

**LIV-04 · Bad assist JSON.** `assist` section malformed → understanding commits normally; assist logged and dropped.

**LIV-05 · Bad understanding JSON.** `understanding` malformed → items quarantined per item; a valid `assist` still passes the gate.

**LIV-06 · Output-side gate.** helpfulness 0.5 with threshold 0.6 → no interrupt, artifact still stored. _Wrong:_ nudge shown.

**LIV-07 · Quiet hours and urgency.** 23:30, urgency `today` with `deadline_at` 09:00 → held until 08:00; urgency `now` with a 00:30 deadline → shown. _Wrong:_ `none` breaks quiet hours.

**LIV-08 · Never quote drafts.** Open writing session on `roadmap.md` for 3 days → nudge may say "three days on the paperclip roadmap"; must not contain any sentence from the document. _Wrong:_ verbatim draft text.

**LIV-09 · Risk line unchanged (from AST-04).** Any action outside the frozen 3-tool table is refused; `risky_without_token = 0`.

**LIV-10 · Live lane is never starved.** 200 backfill bundles queued → a live flush completes within 30 s. _Wrong:_ live waits behind backfill.

**LIV-11 · Intent + preparation (from AST-01).** Options prepared, no cart, no login.

**LIV-12 · Graded engagement (from AST-06).** Helpfulness scales with evidence count and recency, not binary.

**LIV-13 · Dedupe across crash (from AST-07).** Crash after call, before commit → events re-flush; nudge not shown twice (`contentKey`).

* * *
## SPD — Spend rails (deterministic + ledger)
**SPD-01 · Ceiling throws before spawn.** Call N+1 past 400/h → `BUDGET_EXCEEDED`, no child process. **SPD-02 · Latch survives restart.** Trip, restart worker → still tripped until user reset. **SPD-03 · Kill switch.** "Stop all model activity" → zero new spawns, in-flight completes, survives restart, never self-resumes. **SPD-04 · Per-call cost.** One live orient call: ledger `cost ≤ $0.006`. Gate `cost_per_call`. **SPD-05 · No 1-hour cache writes.** Ledger `cache_create_1h = 0` across a fixture run. **SPD-06 · Heartbeat.** `[spend]` line within 60 s of the first call. **SPD-07 · Breaker.** 10 consecutive non-refusal failures → lane paused 30 min, banner raised. **SPD-08 · Quota metered.** `quota_usage` rows == `extraction_runs` rows.

* * *
## SRC — Source quality
**SRC-01 · Params stripped, content kept (code).** `youtube.com/watch?v=X&t=5&utm_source=..` → `v,t` kept; `google.com/search?q=tfidf&gs_lp=..&ved=..` → `q` kept; `rd3.localhost:7373/?path=%2FUsers%2F..` → `path` kept; Netflix `trackId/tctx` dropped. Survivors sorted; fragment dropped. **SRC-02 · Raw URL preserved (code).** `payload.url` byte-identical to the visit. **SRC-03 · Screen head carries identity (code).** Packed line for a screen event contains app, title and doc key. **SRC-04 · Full text persisted (code).** 21,999-char capture → archive holds 21,999 chars (anchor) or the diff with a valid anchor ref. **SRC-05 · Digest never calls the model under 8,000 chars (code + ledger).** 100 screen captures under 8K → 0 digest runs; one 12K capture → ≤1 per stream per 10 min. **SRC-06 · Writing lens recognizes Roughdraft (code).** Visit to `rdN.localhost:7373/?path=..` + AX text → `write.session` with `doc_path` decoded and key `write:<path>`. **SRC-07 · Ephemeral until settled (code).** Writing session idle 5 min → not dispatched; idle 10 min and file exists → dispatched; file deleted → never dispatched. **SRC-08 · Session arcs (code).** 40 screen captures in VS Code across 3 files over 40 min, one 35-min gap → 2 arcs. **SRC-09 · Reply structure reaches the model (judge).** A reply to a message from 20 messages back → episode resolves the referent correctly; ROL-08 remains green. **SRC-10 · Duplicate visits collapse at render (code).** 6 visits to one URL within 30 s → one packed line with `×6` and first–last times; 6 archive rows remain.

* * *
## RET — Retrieval
**RET-01 · Recall + rerank matches full scan.** On a 20K-event fixture, top-10 from FTS-recall→rerank equals top-10 from the old full scan for 50 queries (≥ 90% overlap). Gate `full_vector_scan = 0`. **RET-02 · Latency bound.** 300K vectors → query p50 ≤ 50 ms. **RET-03 · Short message found via its window.** "yes, book it" (12 chars) is returned for "did I confirm the villa" through the chat window that contains it. **RET-04 · Archive-only rows are searchable.** Event outside UNDERSTAND → appears in grounded search, cited by archive id, labelled searchable-only, has no episode.

* * *
## Coverage map
| Product section | Cases |
| --- | --- |
| §3 Consent | CNS-01..09 |
| §4 Storage / Library | RET-04, USR (V2), SRC-04 |
| §5 Sources | SRC-01..10, BRW (V2), ROL (V2) |
| §6 Understanding | BND-01..07, CMT-01..04, CROSS-*, CHP (V2) |
| §7 One lane | LIV-01..13 |
| §8 Retrieval | RET-01..04 |
| §9 Transport / spend | SPD-01..08 |
| §10 Safety invariants | BND-08..12, SPD, CNS-01, TRC (V2) |
