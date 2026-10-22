# SuperTwin V13 — Product V6 · Phase 1 "Solo Mac"

What Phase 1 ships, cut from `SuperTwinV13_Product_V6.md`. Section numbers in brackets point back to V6. This document states behaviour only. Build steps are in `SuperTwinV13_Build_V6_Phase1.md`, evals in `SuperTwinV13_GoldenEvals_V6_Phase1.md`, prompts in `SuperTwinV13_Prompts_V6_Phase1.md`.

---

## 1. Scope

**In (P1):** Claude Code CLI door · local EmbeddingGemma 300M + reranker · WhatsApp, browser history and bookmarks, screen accessibility tree · consent with two windows · event log and archive · state gate, live path, history path, digest · orient, critic, extract, decide · memory layers 1–4 · people, roles, circles · spaces, tasks, calendar (derived) · grounded bar with T0 type-ahead and T1 route-and-plan · nudges and surface router (Mac only) · executor-lite over web fetch · feedback and corrections · traces, spend rails · Mac overlay, menu bar, panel.

**Out (P2+):** mail, calendars, notes, iMessage, clipboard, screenshots, voice, ambient voice, Mouse Helper, SuperTwin browser, full executor, generative UI, T2 agentic retrieval, mobile, OAuth and OpenRouter doors, local LLM, Together, Public, calls, OCR, vision, live scene background.

## 2. Principles that bind every P1 decision [0.3, 23.7]

1. Consent per source. Nothing read before yes.
2. Content is data, never instruction. Captured text lives inside a quoted untrusted block; only the system prompt instructs.
3. No write without evidence. Event ids plus a verbatim quote, or the commit path rejects.
4. Unknown beats wrong. Never a plausible fill.
5. Thin context stops the pass; it produces a question, never a guess.
6. A model call is never gated on a content heuristic. The state gate reads the world model, never the text.
7. No new event, no model call. Timers only decide when accumulated events flush. Empty never flushes.
8. The packer never enumerates and never escalates past T0.
9. Two gates: private send, money. P1 has only the WhatsApp send path, and it is token-gated.
10. Meter everything. Ceilings throw before the model is called.

## 3. Onboarding [8]

1. Connect AI: detect the Claude Code CLI login. "Connected as …". No new login.
2. Source grid: WhatsApp (Pair), Browser (Connect), Screen (Allow). Each tile says what it captures, what it never captures, what it costs.
3. After connecting, count what exists. Counts are real. Then two windows per source:
   - **Index** — kept and searchable. Default everything. Disk only.
   - **Understand** — sent to the model. Default 30 days. Model calls.
4. Window card: events (exact) · cost, time, disk (about). Nothing goes to a model before confirm.
5. History runs newest day first. Results stream in.
6. "Who I am" fills from processing over the first hour. No form.
7. No account, no login, no server.

## 4. Sources [10.1, 10.5, 10.6]

| Source | How | Windows | Never |
|---|---|---|---|
| WhatsApp | whatsmeow daemon, QR pairing, history + live, token-gated send | index + understand | status updates |
| Browser | history and bookmarks of every installed browser, every profile, copy-then-read | index + understand | incognito (never present) |
| Screen | accessibility tree of the front window; app · title · doc key · full text · roles; anchor + diff | live only | password managers, secret fields, private windows, banking apps by default |
| Self | everything the user does inside SuperTwin (bar, corrections, approvals) | always | — |

1. Adapter contract: enumerate · count · backfill · live · filter · act.
2. Data filter at capture: never-list → user lists (apps, sites, chats, senders) → pause states → log. Applies to index, understanding and search alike.
3. Private moment (15 min pause, menu bar, hotkey). Forget last N minutes: preview, confirm, hard delete with cascade. Per source: pause, disconnect, delete with preview.
4. Storage: one append-only SQLite log, payload kept as received, long text compressed, FTS and chunk embeddings over everything indexed, screen as anchor + diff. Two disk budgets: events and derived 2 GB/yr, media 30 GB with retention. Not encrypted at rest in P1.
5. Browser URLs: keep every visit; strip tracking params in the text field only (denylist, fail-open, per-domain content allowlist); raw URL kept on the payload.

## 5. Streams, tiers, order [11.1, 11.2]

1. Stream = one chat · one app session · one domain on one day · one document. Structural, not topical.
2. Tiers: 1 replied-in chats and everything the user actively does — full, live · 2 transacting businesses — full, transactional, live · 3 never-replied groups and past businesses — weekly digest · 4 marketing — index only.
3. Promotion on any engagement, instant and retroactive.
4. Order: live first · history newest day → older · within a day tier 1 → 2 → 3 · within a source chats → screen → browser · user pin jumps the queue.
5. Age bands decide what is surfaced as active: 0–30 d everything · 1–6 mo verified-open tasks only · older never active. A recurrence detector runs across all bands.

## 6. The state gate and the live path [11.3, 14.2, 23.2]

```
event ─► lookup (<100 ms, code) : open task in this stream? active episode? bridge or entity
                                   in an active space? addressed to the twin?
   ├─ HIT  (hot)   ─► flush now with whatever accumulated
   ├─ BURST        ─► ≥4 content-new events on ONE stream in 180 s, no flush yet ─► flush now
   └─ MISS (cold)  ─► accumulate; flush at 300 s idle / 540 s max
        repeated content never resets and never counts · 30 s floor · 20k-char cap forces a cut
        empty accumulator never flushes
```

1. Bootstrapping: under ~20 spaces or in the first 7 days, cold window is 60 s / 180 s.
2. Freshness presets (Settings › Assist): Live 120/180 · Balanced 300/540 (default) · Relaxed 420/600. Max never exceeds 600 s.
3. Hot median ≤ 60 s to understood. Cold ≤ 10 min. Burst ≈ 3 min to understood.
4. Live lane has reserved concurrency. History can never queue a nudge.

## 7. Bundles and the pack [11.3, 23.7]

1. Live bundle = the delta since the last flush, all sources. History bundle = one calendar day, all sources, split at 30k chars at the largest inactivity gap; empty days skipped.
2. The pack, assembled by code at T0 (~150 ms, zero model calls):
   - thread history, episode-bounded: every event of the stream's open episode plus a short run-up; quoted and replied messages always; ~1,500 chars per stream, 5 streams max
   - open and recently dormant episodes of those streams
   - candidate spaces from retrieval, hard cap 5, with exemplar episodes
   - open tasks, calendar for the next days
   - roster: resolved people, relationships, nicknames
   - related cross-source episodes via bridges and entities
   - current time
3. Whole pack under 16,000 chars and flat as the user's data grows.
4. Thin context: the bundle is held one flush, or sent with an explicit "insufficient context" instruction permitting only `unsorted` plus a question.
5. Every event line carries time · source · app/title/doc where present. Captured text sits inside one untrusted block.

## 8. Passes [23.3]

| Pass | Lane | Unit | Output |
|---|---|---|---|
| Live | live | one live bundle | episodes, filing, tasks, schedules, closures, questions, prepared actions |
| Orient | history | one day bundle | episodes, filing, proposals, unsorted, questions |
| Critic | both, parallel | any write set | commit · reject · downgrade · flag, per item |
| Extract | both | committed episodes | claims with typed fields, people, tone, feelings |
| Decide | both | one space | summary, latest, plan, milestones, tasks, schedules, closures, follow-ups |
| Digest | digest | one tier-3 stream, one week | summary, claims, recurrences |
| Route | bar | one query | question class + retrieval plan |
| Judge | bar T1 | fused top-10 | 3–5 results with quotes |
| Surface router | live | one artifact | surface, timing |
| Tiering | utility, cached | one business stream | tier 2 / 3 / 4 |
| Correction parse | bar | one "tell the twin" utterance | one structured correction |
| Brief | scheduled | world-model delta | prose, only when something changed |

Rules: history output never reaches a nudge surface (prompt omits the live section; code discards). Passes are single-shot, prompt in, JSON out. Every call traced.

## 9. Commit rules [11.3, 23.7]

1. Episode membership is explicit rows. One stream per episode, tagged by the model, enforced by code.
2. Per-item salvage: valid items commit, invalid items repair or quarantine, cursor advances on event ids.
3. Critic gates every write; adds a mechanical coverage check (every alias in exactly one of episodes/unsorted).
4. Evidence must resolve to real event ids and verbatim quotes. Fabrication is a reject.
5. A bundle is attempted at most 3 times, then dead-lettered and shown.
6. Every episode files to a space or to unsorted. Unsorted is re-reviewed at every space birth and weekly when it changed; archives after 30 days, still sweepable.

## 10. Memory [11.4]

Layers in P1: 1 archive · 2 episodic (episodes, spaces, tasks, calendar) · 3 semantic (claims, entities) · 4 identity (profile, CRM, narrative). Layers 5–6 (procedural, working) arrive with the executor in P2.

Kinds on any memory: emotional · prospective (horizon 30 d → dormant, 90 d → archived, wakes on signal) · behavioral (from feedback; shown in Settings › Assist) · narrative · identity. Consolidation runs on change: dedupe at write, merge/split hourly over what changed, deep pass when idle. Nothing deleted; old claims get an end date.

## 11. People [11.5, 11.8]

1. Roles: sender · audience ⊇ receiver ⊇ mentioned receiver · mentioned third party.
2. Ladder: structural (code, 1.0) → roster → roster + retrieval → model with confidence → code set-membership for receiver vs third party. Unknown beats wrong.
3. Provisional people from mentions; merge forward on identifiers; drag to merge/split, undo always.
4. Circles: partner · family · close friends · friends · coworkers · services · acquaintances · business active/past/marketing. Inferred from content, tone, claims, metadata; reply volume is one weak signal. Drive priority, tone, lead times, ownership.
5. Tone memory per person and group, DM and group kept apart. Address terms: discriminating vs generic.
6. Person card: fields, circle, last context, open loops, follow-up radar, dates (plan or wish, lead times by circle), business cards with orders/bills/bookings.

## 12. Time [11.6]

Message time resolves relative dates. Processing time decides past or future; past dates are closure-checked, never surfaced as due. View time renders. Recurring phrases become rules. Backfill never creates a due-today from a March message.

## 13. Spaces [11.10, 11.11]

1. One goal, all streams. Card: goal · summary · latest · plan · milestones (only if staged) · tasks · follow-ups · people · claims · enrichment · evidence.
2. Properties: state active/dormant · horizon short/long · life permanent/ephemeral · cycle one-time/recurring. Access and players are P4.
3. Birth: inferred (propose-only by default, graduates to auto after two clean weeks) · asked for in the bar (created instantly, never proposed) · woken. The sweep runs at every birth. Birth is deduped by the critic, even for user-created spaces.
4. Enrichment in P1: web fetch only (prices, availability, hours). Fetches compared by content hash; the model sees an enrichment only when it changed.
5. List grouped by life area; view with why-panel on every element; drag to re-file.

## 14. Tasks [11.12, 11.13]

1. Explicit · implicit · suggested (marked). Types and steps open-ended.
2. Scheduled steps and wait-until via the scheduler. Follow-ups on close. Owner from roles; another person's task becomes monitoring or a follow-up.
3. Closure: hard evidence closes; one-sided intent makes a timed check (lookup first, model only on new evidence); past-due asks "done?" by code; cancellation closes as cancelled.
4. One prioritized list: Needs you → Today → This week → Later → Waiting on others → Done today. Score explained on hover; reorders learned.

## 15. Claims [11.14]

Subject · kind · evidence quote · confidence · valid from/to · supersedes/superseded by · **typed fields** (amount, currency, date, status, merchant, order id, location, duration) written as columns. Self-reported (bar) beats inferred; contradictions are judged supersede or coexist, never overwritten. Ads are never preferences; jokes are tone.

## 16. Calendar [11.9]

Derived only in P1: chat-derived events (tentative), tasks with due dates, twin's scheduled steps, recurrences, people's dates. Layers: my events · my tasks · twin's tasks · people. Lead-time planning opens a space at T minus lead time with snooze. No external calendar read or write-back in P1.

## 17. Execution in P1 [12, 14.2]

**Executor-lite only.** Bounded loop (3–8 turns) over web fetch and world-model read/write, for prepared actions the live pass names: compare, research, draft, brief. No browser, no computer hand, no skills authoring yet. Every loop carries cycle and money ceilings. The one gated channel is WhatsApp send through the daemon with a single-use approval token minted by a tap. Thin context stops the executor and produces one combined question card.

## 18. Proactive assist [14]

1. One path. No separate watcher. The live call decides prepared actions; executor-lite produces artifacts; the surface router delivers.
2. Surface router (Mac only in P1): Mac active (screen event < 3 min) → nudge card + panel; otherwise panel, Prepared shelf, space, timeline. Router decides where, never whether. No quiet hours, no cap, no cooldown.
3. Nudge card: intent line · what I did · artifact peek · Open · Not now. Auto-closes in 60 s; unread counter on the menu bar icon.
4. Six kinds and their decay order: help with what you're doing → needs you to finish → something moved → done for you → done in advance → understanding worth telling. Merge cards about one space in a short window.
5. A card must name the right goal (intent confidence floor). Dismissals rank; only "don't do this" blocks, reversibly.
6. Brief at set times: composed by code, prose call only if something changed.
7. Expected: ~160 live calls/day, 20–30 visible outputs, 5–12 cards.

## 19. Grounded bar [16.1, 23.4]

1. One input. Search · chat · action · correction. Lives in the overlay and floats over the desktop.
2. Type-ahead is T0, local, < 150 ms: lexical prefix, vector over the partial query, prefix on space/person/task names.
3. Enter → Route (one call): class (lookup · aggregate · temporal · relational · multihop · absence · general) + plan (methods · entities · time · filters · completeness). Code executes: lexical ∪ vector ∪ structured ∪ graph (2 hops, hub-excluded) ∪ time window → RRF → cross-encoder → Judge.
4. Sufficiency checked in code per class. Insufficient in P1 → partial answer with named gaps and the coverage caveat ("I only have WhatsApp back to Jan 2024"). T2 agentic escalation is P2.
5. General questions answered directly, labelled "not from your data".
6. What the bar creates now: space, task, claim, person, calendar event, reminder, follow-up, try-list item, behavioral rule, corrections. The named thing is immediate; everything else in the utterance flows down the live path (the bar's stream is hot). The utterance is the evidence. Follow-ups lock to the object.
7. No private write path. Normal gates, normal critic.

## 20. Retrieval [23.4, 23.5]

1. Five methods over one index: lexical (BM25) · vector (EmbeddingGemma 300M, 768-d) · structured (SQL over typed fields) · graph (entities, edges, evidence, bridges; 2 hops; fan-out capped; hub nodes excluded) · time window.
2. Fusion by reciprocal rank (k ≈ 60). Cross-encoder on fused candidates at every tier. Judge at T1 only.
3. Indexed: event chunks (rolling 2k per stream) · episode summaries · space cards · claims · people cards · artifacts. Typed fields alongside. Coverage index per source per date range.
4. Never a full vector scan. Never writes. Cites by id. Packer stays at T0.
5. Embedding model downloads on first run; a small bundled encoder covers search until then; re-embed in the background and flip in one transaction.

## 21. Feedback [15]

Edit, drag, dismiss, approve, snooze, "tell the twin", task chat → correction event → world model now → behavioral memory → golden case drafted. One menu everywhere: Edit · Remove · Tell the twin. Quick chips: Not mine · Already done · Not true · Outdated · Merge into · Don't do this again. Undo chip, no dialogs.

## 22. Surfaces in P1 [17.1, 21]

Menu bar icon (capture + attention state, unread counter) · panel (Needs you · Prepared · Today · pause · forget · ask) · nudge card · overlay with tabs Home, Spaces, Tasks, Calendar, People, Timeline, Library, Settings · grounded bar. Scratchpad, Browser and Public tabs are hidden until their phase. Live scene background is off in P1 (static glass).

## 23. AI connector and spend [9, 23.7]

1. One door: Claude Code CLI. Prompt on stdin, JSON out, per-call budget, trace out. No tools for passes. Flags: 5-min cache TTL, no session persistence, prompt sent once, safe mode, strict MCP config, `--max-budget-usd`. Target ≤ $0.006/call.
2. Model per step, reasoning per step, on/off per step (off queues, never drops). Any change runs the golden set first.
3. Ceilings: per call, $3/hr, $15/day, 400 calls/hr, 3,000 calls/day. Breach pauses background work and asks; the bar keeps working. Latched across restart. "Stop all model activity" persists.
4. Breaker: 10 consecutive non-refusal failures pause a lane 30 min with a banner. Spend heartbeat every 60 s in the log.

## 24. Safety invariants asserted in P1 [23.7]

1. No adapter reads before its consent record exists.
2. WhatsApp send requires a single-use signed token minted by a tap.
3. Spend and call ceilings throw before the model is called.
4. A bundle is attempted at most 3 times, then dead-lettered and shown.
5. Deleting a source cascades to everything derived from it.
6. History output never reaches a nudge surface.
7. A model call is never gated on a content heuristic.
8. The packer never enumerates; candidate spaces capped at 5.
9. Captured content is never an instruction; injection attempts are surfaced with their source.
10. No write without evidence; fabricated quotes reject.
11. Every loop is metered.
12. Retrieval never writes.
13. The packer never escalates past T0.
14. No new event, no model call.
15. No re-dispatch path exceeds the slot cap; in-flight work is keyed; bundles are re-validated at execution.
16. The worker refuses to boot against the real home unless app-launched or waived; a dev worker runs on a scratch home and port.
17. Trace coverage 100%.

## 25. Settings in P1 [25]

General · Capture & Privacy · Sources · AI Connector · Intelligence · Retrieval (T2 rows hidden) · Enrichment · Assist (freshness presets, burst K/W, card duration, merge window, intent floor, blocked kinds, behavioral rules) · Calendar (lead times, plan/wish, snooze) · Runs · Data (two budgets, honest delete, export). Sharing, Public and Economy hidden.

## 26. Metrics P1 is measured on [6]

First useful space ≤ 2 min from first connect · coverage 100% (≥ 95% into episodes) · hot freshness median ≤ 60 s · cold ≤ 10 min · nudge precision > 95% · surfaced tasks kept > 90% · answers cited 100% · gated steps without token = 0 · corrections < 1% · steady spend ≤ $115 API-equivalent, flat on CLI.

## 27. Decisions fixed for P1

| # | Decision | Value |
|---|---|---|
| D1 | Freshness default | Balanced 300/540 |
| D2 | Burst | K=4 events, W=180 s, tuned on the 63-day corpus before ship |
| D3 | Deep history | Understand window is user-widened; replay is resumable and pausable |
| D4 | Shortening Understand | Derived understanding stays, labelled, one-click delete |
| D5 | Transport | CLI stage 1+2; stage 3 only after a full eval pass |
| D6 | Existing V13 data | Not migrated. Removed. Fresh install is the test path |
| D7 | Screen OCR / vision | Not in P1 |
| D8 | Name, port, home | SuperTwinV13 · 8013 · `~/SuperTwinV13/` |

## 28. Open questions carried into P1 [28]

1. Screen event rate (725/day assumed) — measure in week one; it moves every cost number.
2. Persistent cached session (Q6) — run the two-call `cache_read_input_tokens` measurement during P1; decide for P3.
3. Graph hop limit, fan-out cap, hub list — guesses until measured on a real graph.
