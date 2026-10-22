# SuperTwin V3 — Build Plan

Builds `SuperTwinV3_Product.md` on top of the current SuperTwinV13 tree. This is the only document
where V13 code is allowed to appear. Progress goes in `progressV13.md` and `RELEASES.md`, never here.

---

## 0. Conventions

1. **Name and home stay.** Product `SuperTwinV13`, port 8013, home `~/SuperTwinV13/`. No rebrand.
2. **Versions.** V3 phase *N* releases as `13.(5+N).x`. DMG name `SuperTwinV13_V3P<N>_<version>.dmg`. Keep every DMG. Bump via `scripts/release.mjs`.
3. **Every task:** tests green → acceptance met → commit → log one line in `progressV13.md`.
4. **Phase exit:** all tasks accepted, eval gates for the phase green, DMG built and recorded in `RELEASES.md`.
5. **Process rules (hard):**
   - Never run the worker without both `SUPERTWIN_HOME=<scratch>` and `SUPERTWIN_WORKER_PORT=<not 8013>`.
   - Never detach a process from a tool call. No `&`, `nohup`, `disown`. Use the harness's background mode or `timeout`.
   - Any agent that opens a port closes it in the same turn and says so. A listener you did not start is not automatically the user's app — report it.
   - Any command that can reach the `claude` CLI spends tokens. State the expected call count.
   - Never boot a worker against the production home to verify a change. Tests are enough.
6. **Parallel lanes** inside a phase may run concurrently. SERIAL tasks run in order first.

---

## 1. Phase 0 — Ground clearing

Goal: the tree is safe, clean, empty, and we know what we are keeping. **No new design lands here.**

### SERIAL

**P0.1 — Freeze the baseline**
- Run the V2 golden suite once more on the current tree. Store scores per category in `evals/baseline/v13.json` (orient.v6 r8 = 96/100, AST, gates).
- Accept: file exists; `npm run eval -- --baseline` prints it.

**P0.2 — Make the machine safe to work in** *(product §10.6–10.9)*
- New `worker/src/providers/budget.ts`; enforce after `assertTraceContext` in `providers/claude-local/index.ts`. Defaults $3/h, $15/d, 400 calls/h, 3,000/d. Latch `budget_tripped_at` in `app_state`. Chat + grounded bar exempt from latch.
- New `scripts/dev-worker.mjs`: scratch home, port 8113, PID file, 30-min self-kill. `package.json` `worker` → this script; add `worker:live`.
- New `worker/src/home-guard.ts` (lift from `evals/home.ts`); first statement of `main()`. App sets `SUPERTWIN_LAUNCHED_BY=app` in `src-tauri/src/lib.rs`. Waiver `SUPERTWIN_ALLOW_PRODUCTION_HOME=1`.
- Orphan self-shutdown in `worker/src/index.ts`: exit 10 min after parent loss unless `SUPERTWIN_WORKER_NO_PARENT=1`.
- Startup sweep kills pre-existing workers; `killAll()` on unhandled rejection.
- `CLAUDE.md` with the §0.5 rules. Fix `README.md:32`.
- Tests: ceiling throws before spawn; latch survives restart; `npm run worker` writes to temp and exits; bare boot against `~/SuperTwinV13` exits non-zero; app token boots.
- Accept: all green; `lsof -i:8013` empty after the test run.

**P0.3 — Disarm the old dispatcher**
- Cap `admittedOrphans` at `cfg.slots - slotted.length` in `scheduler/dispatch.ts:626-635`; key the in-flight set in `brain/consumer.ts:146`; re-check `dispatched_at` at the top of `runBrainTick`.
- Test: 3,000 undispatched events over 500 streams → `route` called ≤ slots per tick; double `onBundle` → one `runOrient`; marked bundle → zero calls.
- Note: this code is replaced in P3. It exists so the tree is safe until then.

**P0.4 — Reconciliation table**
Every module gets one verdict. Reasons in one line.

| Module | Verdict | Note |
|---|---|---|
| `sources/whatsapp-go` (13.4K Go) | **keep** | add `count_range` for the connect card |
| `sources/screenwatch` (Swift) | **keep** | P5: roles in `RawCapture`, docKey fallback; P2: consent-gated spawn |
| `src-tauri` | **keep** | P0.2 token; sidecar reap |
| `adapters/whatsapp`, `adapters/browser`, `adapters/screen` | **keep** | P2 consent + archive emit; P5 quality fixes |
| `providers/`, `traces/`, `evals/`, `media/`, `server/` | **keep** | new routes and flags only |
| `retrieval/` | **keep** | P6 rewrites `semantic.ts` scan → recall + rerank; `rank()` verbatim |
| `entities/ claims/ consolidation/ salience/ tiers/ bridges/ categories/ freshness/ wire/ ingest/ library/ grounded/ executor/ approvals/ browser/` | **keep** | `ingest` gets the gate + tier predicate |
| `prompts/` | **keep** | `orient.v6` + `critic.v4` stay as baseline until P4 gate; `live.v1` new |
| `db/` | **keep framework** | one migration `0200_v3_core`; drop dead columns |
| **`scheduler/`** | **rewrite** | new dispatcher: day/flush bundles, slot-cap invariants, attempts |
| **`brain/`** | **rewrite consumer + commit path** | keep `parseOrientOutput`, `resolveEventAliases`, `buildCriticInput` |
| **`packer/`** | **rewrite** | sections, heads, budgeted truncation, `[NOW]`, `[OPEN TASKS]` |
| **`assist/`** | **delete after P4 gate** | thresholds move to the output-side gate |
| engagement tiers (hot/warm/cold), tracker blocklist, `isDroppableTrackerHop`, `content_pending`, `sources.connected_at/enabled` | **delete** | in P0.5 |

**P0.5 — Prune**
- Delete everything marked delete, plus tests that assert deleted behaviour (engagement tiers, 5-min windows, drop lists). Remove `IMPORT_RANGES` gaps (`3d`, `3y`, `4y` missing in `src/lib/api.ts`).
- Accept: `tsc` clean, `npm test` green, `/api/health` boots on a scratch home.

**P0.6 — Reset the data**
- Copy `~/SuperTwinV13/supertwinv13.db` and `traces/` to `~/SuperTwinV13-incident-2026-08-29/`. Start empty.
- Accept: fresh home has zero events; backup hash recorded in `progressV13.md`.

**Exit:** `SuperTwinV13_V3P0_13.5.x.dmg`. Eval gates: baseline file present; SPD-01..03; BND-07..09 (old dispatcher, temporary).

---

## 2. Phase 1 — Rails and transport

Goal: the product cannot run away, and each call costs ≤ $0.006.

### SERIAL
**P1.1 — Transport stage 1+2** *(product §9.1)*
- `providers/claude-local/index.ts`: `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`, remove the double prompt send at `:184-191`, `--no-session-persistence`, `--max-budget-usd`, `--safe-mode`, `--strict-mcp-config`.
- Test: assembled argv snapshot; ledger asserts `cache_create_1h = 0` and cost ≤ $0.006 on one live call. Accept: one traced call ≤ $0.006.

### Lanes
**P1.2 [A] — Breaker, quota, waiter bound** — `brain/llm.ts` calls `pool.noteSuccess/noteFailure`; 10-failure lane pause + banner; `logRun` → `db.addUsage`; `pool.ts` caps waiters at 4× capacity and exposes `waiting` on `/api/ops`. Tests: 3 refusals halve the pool; overflow rejects; `quota_usage` rows == `extraction_runs` rows.

**P1.3 [B] — Kill switch + heartbeat** — `app_state.model_activity_paused` checked beside the budget; "Stop all model activity" in `GeneralPanel.tsx`; `/api/ops/lanes/pause` binding in `src/lib/api.ts`; drop `MAX_MANUAL_PAUSE_MS`; `[spend] 60s: …` heartbeat. Tests: toggle survives restart; heartbeat within 60 s of first call.

**P1.4 [C] — Ledger hygiene** — populate `runs.pass`/`runs.origin`; trace row in the same transaction as `extraction_runs`; route `digest-pass.ts:142`, `grounded/handlers.ts:170`, `media/describe.ts:600,711` through the pool. Tests: no NULL pass; runs == traces after a fixture run.

**P1.5 [D] — Latent loops** — `assist/watcher.ts` accumulator resets on every exit path (temporary until P4); `whatsapp/adapter.ts` `cleanRestart()` gets backoff + give-up.

**Exit:** `V3P1`. Gates: SPD-01..05, TRC-01..03.

---

## 3. Phase 2 — Consent and archive

Goal: nothing is captured before yes; everything consented to is indexed; only the window is understood.

### SERIAL
**P2.1 — Migration `0200_v3_core`** — tables `consents`, `archive` (narrow, zlib text, raw payload), `episode_events`, `bundle_attempts`; add `origin='archive'` semantics; drop `sources.connected_at`, `sources.enabled`, `content_pending`. Test: migrate up on empty and on a P0.6 backup; round-trip.

**P2.2 — The gate** — `captureAllowed(source)` at `db/eventlog.ts:229` and `db/ingest.ts:1396`. Tier predicate at write: outside UNDERSTAND → `origin='archive'`, `dispatched_at = capture_ts`. Widening = `UPDATE … SET dispatched_at=NULL, origin='backfill'`. Test: CNS-01..06.

**P2.3 — Boot inversion** — `worker/src/index.ts` starts an adapter only when its consent row is `connected`. Screen sidecar spawns after consent, then Accessibility, then "Record from now on". `sinceMs` required in `browser/watcher.ts`. Test: fresh home, no consent → 0 events after 60 s.

### Lanes
**P2.4 [A] — Browser connect** — `discoverProfiles()` enumerates every browser and profile; copy-then-read counts per window; plateau copy; Safari FDA message; local-path disclosure. Fix the card that only rendered at `event_count === 0`. UI in Library › Browser.

**P2.5 [B] — WhatsApp connect** — pair → buffer → `messagesInRange` counts → window → confirm. No live ingest between pair and confirm. UI in Library › WhatsApp.

**P2.6 [C] — Screen consent + indicator** — "Record from now on" step; pause persisted in `app_state` and seeded at boot (`adapter.ts:171`); tray shows real capture state; one click stops capture.

**P2.7 [D] — Confirm card + verbs** — four numbers per product §3.3, text stored in `decisions`; pause / disconnect / delete with preview from `hardDeleteEvents`' `CascadeReport`; `resetSourceData` removed. Shortening the window labels, never deletes.

**P2.8 [E] — Writing allowlist UI** — folders + apps, empty by default; stored on the consent record.

**Exit:** `V3P2`. Gates: CNS-01..08, BRW capture cases, `containment ≥ 95%` on a mock import.

---

## 4. Phase 3 — Understanding core

Goal: day bundles for backfill, idle-flush bundles for live, grounded commit.

### SERIAL
**P3.1 — Commit rewrite** *(product §6.2)* — `brain/commit.ts`: write `episode_events`; derive `episodes.stream_id` from resolved events, reject multi-stream episodes; per-item salvage; cursor on event ids. Schema gains `"stream":"S1"` tag. Keep `parseOrientOutput`, `resolveEventAliases`, `buildCriticInput`. Test: CMT-01..04.

**P3.2 — Packer rewrite** — sections by stream, event heads (`time · source · app · title · doc`), budgeted truncation, `[NOW]`, `[OPEN TASKS]`, WhatsApp reply/reaction/forward/mention structure, browser transition + visit count, ≤30 s duplicate collapse. Test: snapshot of a mixed 3-source day.

**P3.3 — New dispatcher** — `scheduler/v3/`: backfill day-bundler (oldest→newest, split at largest gap), live flush trigger (45 s / 120 s / backoff / 20K chars / express / novelty / 30 s floor), slot cap + keyed in-flight + revalidate as invariants, `bundle_attempts` with 3-strike dead-letter, waiter-bounded. Old `scheduler/` deleted in the same commit. Test: BND-01..10.

**P3.4 — Stream re-key** — `chains.ts`: `browser:<browser>:<profile>:<domain>:<day>`, `screen:<bundleId>:<session>`, `write:<doc_path>`. Empty DB, so no migration; re-key test on fixtures only.

### Lanes
**P3.5 [A] — Critic coverage check** — every alias in exactly one of episodes / unsorted; Critic on understanding half only.
**P3.6 [B] — Eval-origin exclusion** — dispatcher ignores `origin='eval'`; `.example` hosts never reach production ingest.

**Exit:** `V3P3`. Gates: BND, CMT, CROSS-N2, ORIENT golden ≥ baseline.

---

## 5. Phase 4 — One lane

Goal: one live call, two payloads, nudges never starve.

### SERIAL
**P4.1 — Pool lane `live`** — `providers/pool.ts`: third lane, ≥1 reserved slot; live → `live`, backfill + Critic + Decide → `understanding`. Test: LIV-10.
**P4.2 — `live.v1` prompt + parser** — combined system block; user block carries mode, clock, thresholds, quiet hours; section-independent parse; `.understanding` reuses the P3.1 path. Test: LIV-04, LIV-05.
**P4.3 — Output-side gate** — `nudgeVerdict()` in code with `settings.ts` thresholds; `grounded_in` must resolve to this flush; `urgency`/`deadline_at` quiet-hours override; assist section discarded when `lane !== "live"`. Test: LIV-01..03, LIV-06..08.
**P4.4 — Retire `assist/`** — delete watcher, evaluator, tick, cursor. Artifacts carry `grounded_in`. Executor tool table unchanged; assert it. Test: LIV-09.

**Gate (product §7.3):** ORIENT golden ≥ baseline · AST parity · CROSS-N50 · backfill "pay by 5 pm" → zero assist. If it fails: keep P4.1–P4.3's pack, make two calls, do not delete `assist/`.

**Exit:** `V3P4`. Gates: LIV-01..10, CROSS-N50, AST parity, ORIENT ≥ baseline.

---

## 6. Phase 5 — Source quality

### Lanes (all parallel)
**P5.1 [A] — Browser params** — extend `bridges/normalise.ts` per product §5.2; apply to `text` in `watcher.ts:238` only; `path` whitelisted on `*.localhost:7373`. Test: SRC-01, SRC-02.
**P5.2 [B] — Screen worker** — persist full text + anchor/diff blob table (`envelope.ts:95`); identity in heads (`consumer.ts:44` `source: ""` fixed); deterministic digest with the model gate (`digest.ts`; set `contentHash` in `toEnvelope`); budgeted truncation; session arcs; FTS projection gains app/title/doc; new-chars floor on switch triggers. Test: SRC-03..05, SRC-08.
**P5.3 [C] — Sidecar** — `RawCapture` carries roles (`Live.swift:216,224`); structure-aware hash (`main.swift:62`); `""` docKey fallback fixed (`Live.swift:167`). Test: Swift unit + fixture frame.
**P5.4 [D] — Writing lens** — `write.session` recognizer (URL pattern + editable-element rule), `write:<doc_path>` key, ephemeral-10-min rule, never-quote rule in `live.v1`, node-side line diff. Test: SRC-06, SRC-07, LIV-08.
**P5.5 [E] — WhatsApp structure** — `reply_to`, `reaction_to`, `forwarded`, `mentions`, audience rendered. Test: SRC-09; ROL-08 still green.

**Exit:** `V3P5`. Gates: SRC-01..09, ROL, BRW.

---

## 7. Phase 6 — Retrieval and Library

**P6.1 — Retrieval shape** — `retrieval/semantic.ts`: FTS recall (top 2,000) → cosine rerank → expand → cite. Delete the full-vector cache. Test: RET-01..03.
**P6.2 — Chunk embeddings** — chat rolling windows, screen chunks on re-anchor, browser per-visit deduped; int8, rowid key, 16 KB pages. Test: RET-03; disk per 10K events within 15% of product §4.1 figures.
**P6.3 — Library bars** — `library-routes.ts` returns bytes per tier; two-bar panel per source; free disk first; searchable-only label. Test: USR cases.
**P6.4 — Retention** — screen text retention setting as a privacy control; compaction job. Test: rows older than N days hold digest only.

**Exit:** `V3P6`. Gates: RET, USR, FIX.

---

## 8. Phase 7 — Graduation

1. Full golden suite (all categories) ≥ baseline; hard gates all green.
2. Fresh-install run on a clean user: consent → 30-day import → cost within card ±40% → time within ±30%.
3. Human steps: real-phone WhatsApp pairing; installed-app visual pass; screen consent flow on a second Mac account.
4. TIM-04 (`decide.v9` rule) and the PENDING fixtures (CIR-01..03, FIX-06, ROL, BRW-04/06/07) resolved or explicitly deferred with reasons.
5. `SuperTwinV13_V3P7_13.12.x.dmg`.

---

## 9. Deferred (not in this plan)
OCR (`docs/product-redesign-v2.md` §5.3) · Takeout import · direct API · stage-3 transport (needs its eval pass) · new sources.

---

## 10. Cross-phase gates (release checklist)

- [ ] `trace_coverage = 100%` · `pass_liveness = 100%`
- [ ] SPD-01..05 green (ceiling, latch, kill switch, per-call cost, no 1h cache writes)
- [ ] BND-07..10 green (slot cap, in-flight, revalidate, dead-letter)
- [ ] CNS-01..08 green (no capture without consent; tier predicate; delete cascade)
- [ ] ORIENT golden ≥ `evals/baseline/v13.json`
- [ ] `false_receiver_assignment = 0` · `guess_rate = 0` · `risky_without_token = 0` · `login_automation = 0`
- [ ] No assist output from any backfill bundle
- [ ] `lsof -i:8013` empty after the full test run
- [ ] DMG recorded in `RELEASES.md`

---

## 11. Parallelization map

| Phase | Serial first | Then in parallel |
|---|---|---|
| P0 | P0.1 → P0.2 → P0.3 → P0.4 → P0.5 → P0.6 | — |
| P1 | P1.1 | P1.2 · P1.3 · P1.4 · P1.5 |
| P2 | P2.1 → P2.2 → P2.3 | P2.4 · P2.5 · P2.6 · P2.7 · P2.8 |
| P3 | P3.1 → P3.2 → P3.3 → P3.4 | P3.5 · P3.6 |
| P4 | P4.1 → P4.2 → P4.3 → gate → P4.4 | — |
| P5 | — | P5.1 · P5.2 · P5.3 · P5.4 · P5.5 |
| P6 | P6.1 | P6.2 · P6.3 · P6.4 |
| P7 | 1 → 2 → 3 → 4 → 5 | — |

P5 may start after P3. P6 may start after P2. P4 must wait for P3.
