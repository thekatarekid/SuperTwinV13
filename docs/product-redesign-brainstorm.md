# SuperTwin V13 — Product Redesign Brainstorm

Frame: nothing in the old spec is sacred. Objective is product quality — best understanding of your life, realtime delight, proactive assist. Cost numbers are here because the $512 incident made them matter, but the deeper bug the incident exposed is **context starvation**: 84.9% of Orient calls carried exactly ONE event. A call that sees one URL cannot understand an evening.

All numbers are CONFIRMED (measured from code, ledger, or DBs read-only) unless marked ESTIMATE. Sources: `docs/incident-runaway-spawn.md`, `docs/stream-economics-options.md`, `docs/bundle-design-brainstorm.md`, plus fresh queries against `supertwinv13.db` and `~/SuperTwin/supertwin.db`.

---

## Part 1 — Direct answers to your 8 points

### 1. Cache finding vs the B1 "88%" screenshot — both true; what was misleading

They answer different questions. The 88% was **token composition** (what Haiku sees): of 29,462 input tok/call, 26,382 (89.5%) is not our data — the screenshot was right. The cache finding is **price per token class**: the big 18,483-tok Claude-Code prefix is cache_read (×0.1) = only **7.5% of cost**; the 11,166-tok segment written as a **1-hour cache_create (×2)** — CLI attachments (~7,899) + our prompt sent twice (2×1,151) + the bundle — is **91% of cost**.

What was misleadingly presented earlier: (a) token share was implicitly equated with cost share, pointing at the prefix as the main cost — it isn't; (b) read+create were lumped into one "~$310 gap"; (c) the single dominant line item — a 1h cache write, created 16,654 times and read back **zero** times — was not surfaced. Why zero reads: every call spawns a fresh single-turn session (`llm.ts:329-344` passes no sessionId; `extraction_runs.session_id` NULL on all 18,031 rows), the write's tail is per-call-unique, and with `--max-turns 1` there is never a second turn. 100% waste by construction, at the 1h premium (×2 vs ×1.25; `cache_create_5m` = 0 everywhere).

B1 survives fully — the flags attack the expensive 91%, not the cheap 7.5%: stage 1 (5m TTL + kill double-send at `claude-local/index.ts:184-191` + `--no-session-persistence` + `--max-budget-usd`) → $0.0171 (−40%), zero behavior change. Stage 2 (+`--safe-mode --strict-mcp-config`) → $0.0057 (−80%), also stops shipping your connector names to Haiku. Stage 3 (+`--system-prompt-file --tools ""`) → $0.0022 (−92%) but swaps the agent prompt orient.v6 was implicitly tuned against — gate it on one eval run. Independent re-derivation agrees within ±9%.

### 2. Anatomy of the 16,654 calls — and the V1 existence proof

- Ledger: 18,031 calls / $512.08. Orient.v6: 16,654 / $476.13. Critic rode along ×1.7 (965 calls / $24).
- **98.0% browser**: 15,181 traced calls over 2,346 streams = **6.47 calls/stream (max 14)** — the orphan-scan path with no slot cap.
- What was imported: **3,452 `browser.visit` events spanning exactly the 90-day floor** (May 31 → Aug 29; `watcher.ts:132`). Zero bookmarks ingested (read only for the domain classifier). Chrome Default profile only. 115 of the 3,452 are `.example` eval fixtures that leaked into production ingest — real corpus is 3,337.
- **Events per call: mean 1.73, median 1, p90 3; 84.9% singletons.** Even first-dispatch-only (no bug): mean 1.43, 90.3% singletons — the chain keys guarantee starvation; the bug multiplied a starved design, it didn't create it.
- **83.6% of calls re-sent a stream already sent; 82.9% were byte-identical bundles.** Only **2,470 distinct (stream, bundle) pairs** existed — the entire genuine workload.
- Counterfactuals: bug fixed, same design → ~2,470 calls ≈ $71. V1-style batching → **~36 calls ≈ $1.7** (ESTIMATE).
- **V1 verified** (`~/SuperTwin/supertwin.db`): 30-day WhatsApp import day = 3,684 events, **456 calls, $9.35** — your "<500 calls" memory is near-exact. Real batch size: **25.2 events/extract call** on import day (lifetime 14.4); the "100" cap is plausible from the 24.5K-char max prompt but not directly verifiable. Same model, same subscription: 1,454 calls / 26 days / $27.37 lifetime. Its nightly brain updates read as real life understanding ("explored housing alternatives… started treatment for a throat infection… booked a weekend venue") — no 1-event call can ever write that sentence. Honest other half: V1 had no grounding — no evidence quotes, no episode identity, duplicate spaces, task-agent litter in the brain root. And V13's own eval showed mixed batches merge conversations at just N=2 until v6's per-stream rule fixed it. **Target: V1's batch economics with V13's grounding.**

### 3. Structural restrictions we propose to drop

Now that everything is declared changeable, these go (full list with reasons in Part 3): one-stream-per-call dispatch; the scalar `bundle.streamId` in commit; rowid-range episode membership; all-or-nothing parse/repair/quarantine; the hot/warm/cold engagement-tiered understanding delays; orphan-rescan-without-cap semantics; stream key = call unit coupling. The stream survives as an **identity/retrieval** concept (per-source keys: JID, domain+day, app-session); it stops being the **dispatch** unit.

### 4. Cross-source in one call — the honest verdict

**More context helps when events are temporally related; it hurts only for arbitrary co-passengers.** The starvation damage is measured (4,409 episodes from 3,452 events, "clicked a Netflix link" ×50; 99.7% of thread-history/episode context blocks were literally "(none)"); the dilution risk is hypothesized (TOP-09 measured merge errors only at N=2, and v6 passes 5/5 there — never tested above N=2, which is an eval gap, not a known failure). V1's assign prompt was already cross-chat by design and worked. The trap today is the opposite one: **the model is already better at separation than the engine** — correct per-stream output gets destroyed by the scalar-streamId commit layer.

So: same-day/same-window events across sources in ONE call (villa WhatsApp chat + villa tabs + goibibo = the inference this product exists for) — yes. Packing 30 unrelated singleton streams together purely to save money — no, and the window/day quantum naturally prevents it. Lost-in-the-middle is a non-issue at real day sizes (p50 day ≈ 1.6K content tokens vs 200K window); the real large-N risk is output laziness, handled by a ~150-200 event cap and a mechanical Critic coverage check. Quality above N=2 gets measured before we commit: a ~$0.30 CROSS-N50 fixture (50 events, 6 known threads, 3 sources).

### 5. URLs — "every deliberate URL matters", quantified

Full classification of the 3,337 real events: **deliberate content ~74%; navigation scaffolding 13 events (0.4%); machine noise 0 — structurally zero**, because Chrome's visits API records top-level navigations only; ad pixels/telemetry never become visits. The capture layer already solved "spam URLs" by construction. Your pop-up-ad category has no members in your data.

So the rule collapses to three layers, **no URL-drop policy at all**:
- **Layer 1 — capture: keep 100%.** Only change: exclude the 115 `.example` fixtures from production ingest.
- **Layer 2 — strip tracking params at emit** (denylist, fail-open, per-domain content-param overrides like youtube `{v,t}`, search `{q}`). −33% of all text bytes, fixes FTS (11 of top-24 salient tokens were base64 tracking garbage), reveals 394 hidden duplicates. Fully reversible: `payload.url` stays raw byte-for-byte (confirmed no model/index path reads it — `watcher.ts:238/240`, `digest.ts:283-295`, `eventlog.ts:242`).
- **Layer 3 — render-time collapse of ≤30s duplicates** (858 events) into one line with ×N and first–last times. Nothing deleted, ever; all 858 lines rendered raw would cost ~$0.17 anyway — this is attention polish, not economics.

Timestamps: every event line the model sees carries its own visit time (`pack.ts:258`); millisecond truth is in the DB. Prompt renders minute precision — a one-line change in `short()` gets seconds.

### 6. Screen — captured nearly everything, then the worker threw it away

The sidecar already captures what you want: full AX text of the frontmost window (visible AND scrolled-out, 4,000 nodes), window_title, app, doc_key/URL, links, file paths, triggers on app/tab switch, typing pause, scroll stop, 60s heartbeat; private windows and password managers dropped in-sidecar. Four worker-side gaps:
1. **Full text discarded at the adapter** — `envelope.ts:95` stores only the diff (`new_chars`). Mean 5,284 chars captured → 1,494 stored (72% deleted); a heartbeat stores 332 chars of a 21,999-char screen.
2. **App/window/doc identity never reaches the model** — `pack.ts:258` renders naked diff text with no "this was VS Code editing X".
3. What survives is truncated to 1,200 chars and the digest layer is inert (`CONTENT_KINDS` mismatch; `content_digests` = 0 rows).
4. `content_pending` links/files: writers exist, zero readers.

Capture-everything design, ordered by value/LOC: (1) identity in the event head — one line; (2) persist full text alongside the diff; (3) revive digests so 22K-char captures arrive as distillations, not first-1,200-chars; (4) app-session stream keys (bundleId + 30-min idle gap) so "40 min in VS Code across 3 files" is one arc; (5) wire or delete the pending-content backlog; (6) local-OCR screenshot fallback only when AX text is poor for the foreground app — vision-model calls never by default (~a full Orient call per image, plus a real privacy step-change). Volume at full capture: ~5MB/day of text — trivial; the pressure lands on the pack cap and digest layer, which (3) absorbs.

### 7. Realtime vs batching — they never conflicted. Code-confirmed.

**Nudges never waited on Orient.** The assist lane reads the raw event-log tail from its own cursor (`assist/watcher.ts:101-107`, header says "one capture, two readers") — no join to episodes, bundles, or runs. Tick = 20s; gate is pure code; one Haiku evaluator call only after the gate passes. End-to-end nudge latency today: **~20-25s** for screen/WhatsApp, ~20-80s for browser (its 60s poll is the only laggard — an 8ms SQLite read, droppable to 15-20s). No code path exists from dispatch windows into assistTick. So the two-speed architecture is already real:
- **Fast lane (seconds):** raw events → code gate → nudge. Independent of every batching decision. Also rides the same expensive transport — the stage-2 fix cuts each nudge evaluation ~5× too.
- **Slow lane (minutes):** understanding. Batching by time quantum makes it BETTER, not slower — freshness ≤ window close + ~30s, versus the incident where the 4-slot queue lagged 8 hours.
One soft dependency, honestly: topic-joining falls back from `space:` to `stream:` keys when understanding lags — nudges still fire, cross-source joining is briefly coarser. A quality gradient, not a latency dependency.

### 8. The six knobs, quality-first

1. **Browser grouping — domain+day** as the stream identity: quality-optimal AND cost-optimal; no tradeoff, nothing to ask.
2. **Screen grouping — app-session keys** after the render fix: same, no tradeoff.
3. **Transport — stage 1+2 now** (no behavior change, ~5× cheaper, privacy-positive), stage 3 after one eval pass.
4. **Batch size — bigger is better.** Starvation is the quality bug. Backfill batches maximally; live is bounded by your data anyway (mean 2.4 streams with news per 5-min window).
5. **Live cadence — kill the hour tiers, flush every active window.** The ONE knob where quality and cost genuinely pull apart — see Question 4 below. Idle-gap debounce survives only as a burst-coherence feature (splitting a burst across a boundary makes two half-episodes).
6. **Connect-flow defaults — import generously.** Full WhatsApp lifetime ≈ $10 one-time, browser 90d ≈ $6 even at old prices; under this design the first run is ~$1-2. The real issue is consent, not cost: capture auto-starts with zero consent, `connected_at` wired to nothing, pause switches read by nothing, source-delete leaves derived episodes standing (must route through `hardDeleteEvents`).

---

## Part 2 — The proposed product design (one page)

**One principle: capture everything; two readers at two speeds; one batching mechanism with two clocks.**

```
CAPTURE (keep 100%, strip tracking params at emit, raw payload.url/full-text preserved)
   │
   ├── FAST LANE — assist (seconds)
   │     raw event tail → code gate (N events, cooldown, quiet hours) → 1 Haiku call → nudge
   │     ~20-25s end-to-end. Untouched by batching. INTENT_RE force-flush stays as express path.
   │
   └── SLOW LANE — understanding (minutes / replay)
         BACKFILL: one call per calendar DAY of your life — all sources, temporal order,
           sectioned by stream ([STREAM S1: wa:family] … [STREAM S2: browser goibibo.com]),
           per-event heads carry time + app/title/doc_key. Split oversized days at the largest
           inactivity gap (sleep/work boundaries). Oldest→newest, so each day's call receives
           prior days' committed episodes — backfill becomes a narrative replay of your life.
           85 of 88 real days fit one call under the 28K cap; 87/88 at a 60K cap.
         LIVE: the same machinery at WINDOW granularity — one call per 5-min window that has
           events, any source, any stream count (p50=1, mean 2.4). Same schema, same commit
           path. Window can shrink to 1-2 min for delight; active windows, not wall clock,
           drive cost.
```

**Engine changes the model output already supports** (~500-700 LOC, 1 migration): the schema already emits per-episode event lists and commit already resolves them (`commit.ts:219`) — then throws the resolution away. So: (1) episode_events → explicit membership rows (retro-fixes the 4% contaminated ranges); (2) `episodes.stream_id` derived from resolved events, single-stream enforced at commit, explicit `"stream":"S1"` tag in the schema; (3) **per-item salvage** — commit valid items, repair/quarantine only invalid ones, cursor advances on event ids never whole bundles (kills "one bad item parks 25 streams" and the infinite-retry shape); (4) dispatcher groups by day/window instead of stream; (5) packer renders sections and loses the truncation trap at `pack.ts:315-319`.

**Transport, on subscription:** stage 1+2 now ($0.0286 → $0.0057/call, no behavior change); stage 3 ($0.0022) behind one eval run.

**Safety rails:** slot cap + in-flight-key dedupe + revalidation on the orphan path; `--max-budget-usd` per call + a daily circuit breaker on the ledger; single-instance lock; per-item salvage removes the retry runaway class; Critic gains a mechanical coverage check (every alias in exactly one of episodes/unsorted).

**Quality gate before committing to large-N:** CROSS-N50 fixture (~$0.30) — no episode may cite events from two unrelated threads; the deliberately related chat+booking pair must join ONE space via two episodes.

### Cost table (stage-2 transport, $0.0057/call; Critic ×1.7 included)

| Item | Calls | Cost |
|---|---|---|
| **First run**: full 88-day two-source backfill (10,730 events) | ~160 | **~$0.91** (vs $476 spent; ~$4.60 even at today's transport) |
| Full WhatsApp lifetime import, if chosen | +ε | ~$10 ceiling at OLD prices; ~$2 ESTIMATE under day-bundles |
| **Steady month, live** — browser+WhatsApp only (~32 active windows/day) | ~1,000/mo | **~$5.5/mo** |
| Steady month with full screen capture live (ESTIMATE: screen makes ~most working-hours windows active, ~100/day) | ~3,000/mo | **~$15-20/mo** (≈$7 at stage 3) |
| Assist evaluator (gate + 45-min cooldown → a few/day) | ~100/mo | **<$1/mo** |
| Reconciling the two live figures: $5.5/mo was measured on the browser+WA corpus; screen at 2.13 captures/min is what pushes windows/day from ~33 toward ~100. A 10-min screen debounce roughly halves the screen share. |||

---

## Part 3 — Explicitly dropped from the old spec

| Old rule | Why it goes |
|---|---|
| One-stream-per-call (§6.3.1) | Guarantees starvation: 90.3% singletons on first dispatch even bug-free. Stream stays as identity; day/window becomes the call unit. |
| Scalar `bundle.streamId` in commit (10 sites) | Destroys correct per-stream model output; replaced by per-episode derived stream + explicit tags. |
| Rowid-range episode membership | Already 4% contaminated; explicit membership rows are simpler and retro-fix it. |
| All-or-nothing parse/repair/quarantine | One bad item parks a whole bundle and feeds infinite retry; per-item salvage. |
| Engagement-tiered delays (hot 30m / warm 4h / cold 24h) | Cost optimization at yesterday's price; saved 13% of calls while making understanding hours stale. Per-active-window flush instead. |
| Orphan rescan without slot cap / in-flight dedupe | The direct $476 mechanism: 6.47 calls/stream, 82.9% byte-identical re-sends. |
| Fresh CLI session per call with 1h cache TTL + double-sent prompt | 91% of the bill, written 16,654× and read 0×. Stage-1 flags. |
| Whole-URL drop lists (tracker blocklist, isDroppableTrackerHop) | The category has zero members in your data — visits API sees only top-level navigations. Keep everything, strip params only. |
| Diff-only screen storage; identity-less event rendering | Deletes 72% of what the sidecar captured and strips the "which app/doc" frame the model needs. |
| 90-day browser floor + 7-day cautious defaults as cost protection | Cost ceiling is now ~$1-2 for the whole backfill; defaults become generosity + consent, not thrift. |

---

## Part 4 — Final questions (only where evidence can't settle it)

**Q1 — Roughdraft / your own writing in scope?**
Include: your drafting is the richest signal of what you're actually working on, and the AX capture already sees it. Exclude: it's your most private surface, and screen text of half-written thoughts entering a model pipeline is a different consent class than URLs. Product/privacy call, not cost (marginal cost ≈ $0).

**Q2 — Screenshot fallback for AX-poor apps (Figma canvas, video, games): off / local-OCR-only / vision model?**
Local OCR: free, private, catches most text AX misses — but pixels can capture others' messages and popovers the AX privacy filter can't parse. Vision model: real understanding of visual surfaces, but ~1 Orient call per image and a genuine privacy step-change. Recommendation embedded: OCR opt-in, vision never by default — but the opt-in is yours.

**Q3 — Default first-import horizon?**
Everything (WhatsApp lifetime + browser 90d floor): best cold-start understanding, ~$2-12 one-time, longest first-run wall clock and biggest consent ask. Conservative (30-90d): near-identical recent-life quality, cheaper trust footprint. Pure preference now that cost is ~noise; the consent card must be honest either way.

**Q4 — Live freshness price: ~$15-20/mo for minutes-fresh everything (screen included, 5-min windows), or ~half that with a 10-15-min screen debounce?**
Full freshness: understanding ≤5-10 min behind your life, matching "the more realtime, the more delightful"; nudges are ≤25s regardless. Debounced: same nudge latency, understanding of screen activity lags ~15 min, ~$8-10/mo. This is the one genuine quality-vs-cost knob left.

**Q5 — Should assist act on screen-derived events before the consent UX is rebuilt?**
Act now: the fast lane already reads them and the delight is real. Hold until consent ships: capture auto-starts with zero consent today, pause switches are wired to nothing, and a nudge quoting your own screen back at you is the moment trust breaks if you never said yes. (The consent fixes are needed regardless; this only decides sequencing.)
