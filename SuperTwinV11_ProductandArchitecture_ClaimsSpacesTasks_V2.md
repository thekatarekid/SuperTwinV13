# SuperTwinV11 — Product & Architecture: Ingestion → Claims, Spaces, Tasks
**V2 · standalone · complete · built in the V11 repo**

**Scope:** the entire understanding pipeline — adapters → events → enrichment → **entity graph** → **sessions** → **episodes** → **arcs** → **claims + loops** → **spaces + tasks** → **7 inspection surfaces**, under **two operating modes** (bootstrap and steady state).
**Ends at:** extraction/inference of claims, spaces and tasks. No executor, no cards, no digest, no sharing, no agents that act.

> **Why the scope ends there.** The prior system produced 87 spaces from 3,000 events, 381 claims of which **zero** were ever superseded, and 81 tasks of which **zero** were ever approved — and a healthy mid-run backlog was indistinguishable from a silent failure. Those are data-model and control-plane failures, not prompt failures. This document rebuilds both end to end and stops.

---

## 1. Thesis

1. **Entities are the spine.** Every event, mention, claim, loop and space points at a **minted entity id** — never a name, phone, JID or slug. This is what makes sources #2–#18 additive instead of multiplicative clutter.
2. **Source shape, not source name, drives everything mechanical.** Eighteen source families reduce to five stream kinds. New sources ship a manifest; the core never changes.
3. **Three chunk tiers, three jobs.** Sessions are mechanical (code). Episodes are topical (one cheap call, stream-scoped). Arcs are cross-time and **cross-source** (exact joins first, judgment last).
4. **One understanding call, two orthogonal outputs, no container choice.** Every episode yields **claims** (always) and **loops** (conditionally).
5. **A space is an arc that holds a live loop.** Promotion is a `[CODE]` rule, not an LLM judgment.
6. **A task is a view, not a table.** A loop owned by the user with an unresolved end state.
7. **Newest first, always, in both modes.** Recency is what the user can verify and what makes the product feel alive. History fills in behind it, continuously, never in a separate phase.
8. **One pipeline, two pacings.** Bootstrap and steady state differ in *sealing rule, ordering source, batch size and parallelism* — not in code path. There is no special "first run" path and no demo mode.
9. **First claims, tasks and spaces in under 120 seconds**, then a monotonically growing stream of them with no stalls.
10. **Extraction cadence is decoupled from session boundaries.** A session boundary answers *"is this conversation over?"* and needs a long gap. Understanding answers *"what was just said?"* and must not wait for it. A new message is understood in **~30 s (configurable 30 s – 6 h)**, while its session stays open.
11. **Text is never held hostage to pixels.** Media is enriched asynchronously; text is understood immediately. When a caption or transcript lands, it flows back into *its own* event, session and episode, and every derived layer above recomputes.
12. **Nothing is final. Everything is derived from evidence.** `active` claims, loop state, space status and arc membership are **functions of the evidence set**, recomputed whenever it changes — not flags set by whoever wrote first.
13. **Arrival-order independence (confluence).** The final graph must be identical regardless of the order data arrived in. Precedence is keyed on **when something was said** (`stated_at`), never on when it was ingested or processed.
14. **Code computes facts; the model judges meaning.** Code may narrow the model's vocabulary. It never edits what the model concluded.
15. **Every automated decision records who made it and why** — `decided_by ∈ code|ml|llm|agent|user` + confidence + verbatim evidence.
16. **Three parties, nine directions.** Every claim and loop involves `self`, an `other` present in the conversation, or a `third` party who is mentioned but absent. The nine ordered pairs are **derived by code**, never judged by a model — the participant set is already known.
17. **Compact wire encoding, not JSON.** Prompts and responses use STW-2, a line-oriented pipe-delimited format with base-36 aliases. Measured on the prior corpus: **~40–60 % fewer characters**, because 37 % of JSON output was repeated raw event ids. Structure is compressed; **language is never compressed** — claim text and loop titles are stored as the model wrote them.

---

## 2. Sources — generic from day one

Built and tested on WhatsApp only. The architecture is source-shaped, not source-named.

| # | Source family | Emits | Vol/day | Actors |
|---|---|---|---|---|
| 1 | WhatsApp · iMessage · SMS | messages, media, replies, reactions | 10²–10³ | many |
| 2 | Notes · Reminders · Calendar | documents, point reminders, bounded blocks | 10⁰–10¹ | one/many |
| 3 | Google — Drive/Docs/Sheets/Slides/Tasks/Calendar/Gmail | revisions, threads, blocks | 10¹–10² | many |
| 4 | Slack | messages, threads, channels | 10²–10³ | many |
| 5 | Browser history · bookmarks | visits, saves | 10²–10³ | one |
| 6 | Instagram — DMs, posts, stories, reels, saves | conversation + activity | 10¹–10² | many/one |
| 7 | X — DMs, posts, bookmarks | conversation + activity | 10¹–10² | many/one |
| 8 | YouTube watch history, saves | plays, saves | 10¹–10² | one |
| 9 | TikTok saves, posts | plays, saves | 10¹–10² | one |
| 10 | Screen — a11y tree + screenshots, system audio | frames, trees, audio | **10⁴–10⁶** | one |
| 11 | Video calls, meeting transcripts | bounded conversation | 10⁰–10¹ | many |
| 12 | Ambient voice — PC | utterances | **10³–10⁵** | many |
| 13 | Ambient voice — mobile | utterances | **10³–10⁵** | many |
| 14 | Mobile screenshots | frames | 10²–10³ | one |
| 15 | Scratchpad — notes, screenshots, clipboard, saves | micro-artifacts | 10¹–10² | one |
| 16 | AI voice input · AI clipboard · AI keyboard | intent-rich micro-events | 10¹–10³ | one |
| 17 | Commerce — Amazon, Blinkit, Zomato, Swiggy, Instamart, Zepto, MakeMyTrip, Goibibo, Uber | transactions, line items | 10⁰–10¹ | one |
| 18 | Entertainment — Netflix, Hotstar, Spotify, BookMyShow | plays, bookings | 10¹–10² | one |

**Four facts this table forces:**

1. **A silence-gap rule alone is wrong.** It fits families 1, 4, 6, 7 and nothing else. A Google Doc, a Netflix play and an Uber ride have no gap.
2. **Volume spans six orders of magnitude.** Families 10, 12, 13 out-produce everything else combined and need a salience gate *before* segmentation.
3. **Actor cardinality differs.** Browser history has one actor; WhatsApp has many. Participant-shift boundaries are meaningless for single-actor streams.
4. **Enrichment latency differs by two orders of magnitude** — a link scrape is ~1 s, an image caption ~5 s, a 3-minute voice note ~25 s, a video ~60 s. The pipeline must not be hostage to its slowest attachment (§8.5).

### 2.1 Five stream kinds — the extensibility spine

```
 KIND           SHAPE                      SESSION BOUNDARY RULE
 ════════════   ════════════════════       ═══════════════════════════════════
 CONVERSATION   turn-taking, many actors   silence gap ∪ participant shift ∪
   fam 1,4,6dm,7dm                         reply-chain break ∪ size cap ∪
                                           local midnight
 DOCUMENT       revisions to one artifact  edit-burst gap ∪ author shift ∪
   fam 2notes,3docs,15notes                revision cap ("one working sitting")
 ACTIVITY       atomic acts, one actor     burst gap ∪ context shift (domain/
   fam 5,6feed,7feed,8,9,14,15,16,17,18    app/vertical) ∪ size cap;
                                           a transaction is ALWAYS its own
                                           session, never merged into a burst
 AMBIENT        unbounded sensor stream    salience prefilter FIRST, then
   fam 10,12,13                            context shift (app/speaker/scene/
                                           silence>90s) ∪ 10-min cap
                                           ∪ 15-min absolute ceiling
 BOUNDED        record has start + end     session = the record. No inference.
   fam 2cal,3cal,11,17trips                Caps do not apply.
```

### 2.2 The adapter manifest — the whole extension contract

```ts
SourceManifest = {
  source_id:        string,                    // "whatsapp" | "gmail" | "screen"…
  display_name:     string,
  stream_kind_of:   (stream) => "conversation"|"document"|"activity"
                              | "ambient"|"bounded",
  actor_model:      "multi_actor" | "single_actor",
  self_identity:    { kind, value_getter },    // how "me" appears in this source
  streams:          { key: (ev)=>string, label: (ev)=>string },
  identities_emitted: ("jid"|"phone"|"email"|"handle"|"account_id"
                      |"device_id"|"profile_url")[],

  capabilities:     { backfill, live, media, revisions, edits, deletion,
                      backfill_order: "desc" | "asc" | "unordered",
                      backfill_paged: bool, page_hint_events: number },

  segmentation:     { gap_ms, size_cap_events, size_cap_chars,
                      day_boundary: bool, participant_shift: bool,
                      shift_min_gap_ms, debounce_ms },
  enrichment:       { kinds: ("image"|"video"|"audio"|"link"|"doc")[],
                      expected_latency_ms_p50: {…} },   // scheduler planning
  salience:         { prefilter: "none"|"dedupe"|"vad"|"diff"|"threshold" },
  bridge_keys:      ("url"|"order_id"|"file_id"|"attendee_set"|"phone"
                    |"email"|"media_work_id"|"geo_time")[],
}
```

1. **`backfill_order: "desc"` is strongly preferred and is what the scheduler asks for first.** An adapter that can only deliver ascending history declares `"asc"`; the scheduler then buffers pages and re-orders them into descending cohorts itself (§8.2). **WhatsApp's history sync must be driven newest-page-first.**
2. **Segmentation and enrichment are data, not code** — per-source defaults, per-stream overridable at runtime from the Sessions surface.
3. **`salience.prefilter` is mandatory for `ambient`** — `ambient` + `none` fails validation at registration.
4. **`self_identity` is mandatory** — the canonical "me" entity binds through it.
5. **Adding a source = adapter + manifest.** Zero core file changes.

---

## 3. What changes on V11

### 3.1 Keep — untouched

| Subsystem | Path | State |
|---|---|---|
| WhatsApp daemon | `sources/whatsapp-go/` — whatsmeow, QR pair, backfill + live, media, reactions, edits/revokes, NDJSON over stdio, mock engine | Built, 130 Go tests |
| WhatsApp adapter + ingest | `worker/src/adapters/whatsapp/`, `worker/src/ingest/`, `worker/src/db/ingest.ts` | Built |
| Adapter interface | `worker/src/adapters/source-adapter.ts`, `adapters/types.ts` — already source-neutral | Built |
| CLI provider core | `worker/src/providers/claude-local/` — binary probing, `stream-json` parser, poison-session recovery, 4-way token accounting, PWD/TCC guard, kill/reap hygiene | Built, hardened |
| Enrichment workers | `worker/src/media/` — vision describe (batched, hallucination guard, anti-mismatch), whisper transcribe, ffmpeg frames, poster, link scrape, yt captions; crash-safe verdict-only queue | Built, deepest-tested |
| Embedding runtime | `worker/src/retrieval/embedder.ts`, `db/embeddings.ts` — e5-small 384d int8 | Built |
| Retrieval + chat | `worker/src/retrieval/`, `server/chat-grounding.ts` — FTS5, expansion, semantic, hybrid, citations | Built |
| Shell / server / UI | `src-tauri/`, `worker/src/server/`, `src/` | Built |

### 3.2 Delete — before writing new code

1. **`worker/src/store/store.ts`** — 1,864-line spaces/goals/milestones/tasks layer with **zero runtime callers**. It encodes declared-spaces and mandatory-goals, both rejected here. Keep only the `app_state` / model-selection helpers; move to `db/settings.ts`.
2. **`worker/src/brain/writers.ts` + `brain-template/`** — markdown wiki writers, zero callers. *A file tree is a single hierarchy; a life is a graph, and one entity legitimately belongs in six places. It is also a second source of truth.*
3. **Migrations `0004`–`0006`** — inert `spaces/goals/milestones/tasks/space_events/space_people/patterns/task_runs` tables.
4. **`<brain>/corpus/*.md` as a product path** — plaintext full-history dump on disk. Debug export only.

### 3.3 Fix — source leaks and ordering assumptions

1. `worker/src/db/ingest.ts:1990` — hardcoded `wa:` id prefix → `${source_id}:`.
2. `worker/src/db/ingest.ts:1964` — `resetWhatsappData("whatsapp")` → `resetSourceData(source_id)`.
3. `app_state` keys `whatsapp.paused|self_jid|import_done` → `source.<id>.*`.
4. `/api/whatsapp/*` → `/api/sources/:source_id/*` (alias old routes one release).
5. `worker/src/index.ts:39` — direct `WhatsAppAdapter` construction → manifest-driven **adapter registry**.
6. `events.channel_id` → **`stream_id`**; `channels` table → `streams`.
7. **`MODEL_ROLES` holds only `chat` and `media`.** Add: `entity`, `episode`, `arc`, `extract`, `triage`, `done_detect`, `classify`, `adjudicate`.
8. **Any rowid-ordered or FIFO processing assumption is removed.** Work is ordered by a **priority key derived from recency** (§8.2), never by insertion order. Backfilled history arrives with higher rowids and older timestamps; rowid order is exactly wrong.
9. **The media queue becomes priority-ordered**, sharing the scheduler's cohort key (§8.5). A FIFO media queue starves recent attachments behind two years of old photos.

### 3.4 Build

| Phase | # | Component | Executor |
|---|---|---|---|
| — | B0 | Eval harness + gold set | code + human |
| — | B1 | CLI bare-call contract + roles + thinking ladder | code |
| — | B2 | Deletions (§3.2) + leak/ordering fixes (§3.3) | code |
| A | B3 | Adapter registry + manifests + `stream_id` migration | code |
| A | B4 | **Cohort scheduler**: modes, horizons, priority queue, lanes, pacing | code |
| A | B5 | Embedder calibration | code + ML |
| A | B6 | Salience prefilter (schema + stage; ambient off) | code + ML |
| A | B7 | **Async enrichment + priority queue + update-in-place propagation** | code + ML + LLM-S |
| A | B8 | Entity graph: registry, identities, edges, mentions, me | code |
| A | B9 | **P-EP1** entity pass + resolution ladder + **P-AG1** resolver agent | LLM-S + agent |
| A | B10 | Sessions: 5 segmenters, dual seal modes, hash gate, ops rules | code |
| A | B11 | Surfaces: Entities, Sessions + coverage meters | code |
| B | B12 | Episodes: 1:1 default, **P-EP2**, verdicts, aging | code + ML + LLM-M |
| B | B13 | Bridge extractor | code |
| B | B14 | Arcs: binding ladder, **P-AG2**, two-phase reconcile, **P-LB1** | code + ML + LLM-M |
| B | B15 | Surfaces: Episodes, Arcs | code |
| C | B16 | **P-CL1** claims + loops understanding call | LLM-M |
| C | B17 | Code-facts pass | code |
| C | B18 | Write path: keys, reinforce, **P-AG3** supersede | code + ML + LLM-M |
| C | B19 | Space derivation from arcs + **P-SP1** archetype | code + LLM-S |
| C | B20 | **P-TR1** triage + **P-DD1** done-detection | LLM-S |
| C | B21 | Goal emergence + reconcile (cohort-boundary + nightly) | code |
| C | B22 | Surfaces: Claims, Spaces, Tasks + coverage meters | code |

---

## 4. The CLI contract

### 4.1 Bare-call contract — how the model is isolated

1. The Claude CLI exposes **`--append-system-prompt` only. There is no `--system-prompt` replace flag.** Isolation is achieved by **starving the default context**:
   - `--setting-sources ""` → no user `CLAUDE.md`, skills, hooks, MCP, plugins.
   - `--disallowedTools` with all 13 built-ins (`Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Task,NotebookEdit,TodoWrite,BashOutput,KillShell`).
   - `--allowedTools ""` → nothing granted.
   - `MAX_THINKING_TOKENS=0` on the child env.
   - `--max-turns 1`.
   - **Our instruction block is passed twice** — as `--append-system-prompt` (fresh sessions only; skipped on `--resume`) **and** as the head of stdin. Extraction always runs fresh, so both land.
2. **All levers are required together.** Measured on a ~35 KB prompt with only `--allowedTools ""`: 62 runaway thinking blocks, zero text, no result, killed at timeout having burned tokens. With all levers: JSON streaming from ~2 s.
3. **The prompt goes on stdin, never argv.**
4. **`cwd` must never be `~/Documents`, `~/Desktop` or `~/Downloads`.** macOS TCC blocks the CLI's startup scan in a single `openat()` with no output until timeout. All calls run with `cwd = tmpdir()`.
5. **Agent calls** are the one exception to tool denial: they register one local MCP server (`supertwin-tools`) exposing only that call's listed tools, with turn and wall-clock caps.

### 4.2 Model catalog and role mapping

Model ids pass verbatim to `--model`. `""` means "emit no flag" — subscription default.

| Tier | Model id | Used for |
|---|---|---|
| `[LLM-S]` | `claude-haiku-4-5-20251001` | mechanical work: media captions, triage, done-detection, archetype, labels |
| `[LLM-M]` | `claude-sonnet-5` | judgment: entity pass, episode segmentation, arc adjudication, claims+loops, contradiction |
| `[LLM-L]` | `claude-opus-4-8` | available in the picker for any step; not a default |

**Accuracy over economy on the judgment steps.** The entity pass and the claims+loops pass stay **separate calls** — merging them into one cheap call was considered and rejected: one call doing mentions + entities + edges + 8-kind claims + loops + summary is exactly the shape of prompt where a small model over-emits and loses roster discipline. The steps most at risk are loop precision (restraint), third-person resolution, and attribution — all in the merged call's blast radius.

**Every step has its own model picker in Settings.** The defaults above are a starting point; the gold set decides. If the eval harness shows haiku holds a step, move it down and keep the economics.

```
selected_model_media        claude-haiku-4-5-20251001   (V11 default, kept)
selected_model_entity       claude-sonnet-5             (accuracy: roster discipline)
selected_model_episode      claude-sonnet-5
selected_model_arc          claude-sonnet-5
selected_model_extract      claude-sonnet-5
selected_model_triage       claude-haiku-4-5-20251001
selected_model_done_detect  claude-haiku-4-5-20251001
selected_model_classify     claude-haiku-4-5-20251001
selected_model_adjudicate   claude-sonnet-5
selected_model_chat         ""   (subscription default, V11 kept)
```

### 4.3 Thinking-budget ladder — build this

The provider today has a **binary** thinking switch. Build a 6-rung ladder on `SendOptions.thinkingBudget`:

| Mode | `MAX_THINKING_TOKENS` | Use |
|---|---|---|
| `off` | `0` | **default for every call in this document** |
| `low` | `2048` | reserved |
| `medium` | `8192` | reserved |
| `high` | `24576` | reserved |
| `xhigh` | `49152` | reserved |
| `max` | `65536` | reserved |

Extraction with a fixed output schema gains nothing from reasoning tokens and loses determinism and money. The ladder exists so escalation is config, not a rewrite.

### 4.4 Call specification table

All calls: schema-validated · **one repair retry** → then `quarantine`. **Parallelism differs by mode** (§8.4).

| Call | Role | Model | Mode | Turns | Tools | Think | Timeout | Batch | Max out |
|---|---|---|---|---|---|---|---|---|---|
| media describe | `media` | haiku-4-5 | plain | 1 | none | off | 180 s | **16 images (1–32)** | 4,000 |
| **P-EP1** entity pass | `entity` | **sonnet-5** | plain | 1 | none | off | 120 s | ≤6 sessions / 8k in | 3,000 |
| **P-AG1** identity resolver | `adjudicate` | sonnet-5 | **tooled** | **≤3** | 3 read-only | off | 60 s | 1 pair | 800 |
| **P-EP2** episode pass | `episode` | sonnet-5 | plain | 1 | none | off | 120 s | ≤6 sessions / 8k in | 4,000 |
| **P-AG2** arc adjudicator | `arc` | sonnet-5 | plain | 1 | none | off | 60 s | 1 episode | 500 |
| **P-LB1** labeler | `classify` | haiku-4-5 | plain | 1 | none | off | 60 s | ≤10 arcs | 500 |
| **P-CL1** claims + loops (full) | `extract` | sonnet-5 | plain | 1 | none | off | 180 s | ≤4 episodes / 10k in | 6,000 |
| **P-CL1Δ** claims + loops (delta) | `extract` | sonnet-5 | plain | 1 | none | off | 90 s | 1 episode, new events only | 2,500 |
| **P-TR1** triage | `triage` | haiku-4-5 | plain | 1 | none | off | 90 s | 20–50 loops | 2,000 |
| **P-DD1** done-detection | `done_detect` | haiku-4-5 | plain | 1 | none | off | 90 s | ≤30 open loops | 2,000 |
| **P-SP1** archetype + label | `classify` | haiku-4-5 | plain | 1 | none | off | 60 s | ≤10 spaces | 1,000 |
| **P-AG3** contradiction | `adjudicate` | sonnet-5 | plain | 1 | none | off | 60 s | 1 pair | 500 |

### 4.4.1 Concurrency — per resource class, not one global number

A single "16 parallel" is wrong: LLM calls are network- and subscription-bound, local ML is hardware-bound. Sixteen concurrent whisper instances thrash the GPU and run **slower** than three.

| Resource class | Bound by | Default (8 GB M-series) | Max | Setting |
|---|---|---|---|---|
| **LLM calls** — every prompt, enrichment *and* understanding | subscription rate limit; ~250–350 MB per CLI child | **8** | 16 | `concurrency.llm` |
| whisper transcription | Metal GPU + ~1.5 GB resident model | 1 | 3 | `concurrency.transcribe` |
| embeddings (e5) | CPU | 2 | 8 | `concurrency.embed` |
| ffmpeg frame extraction | CPU | 2 | 4 | `concurrency.ffmpeg` |
| link scrape | network | 8 | 16 | `concurrency.scrape` |
| **DB apply** | SQLite single writer | **1 (fixed)** | 1 | — |

**Settings copy for `concurrency.llm`:**

> Each parallel call runs a separate Claude CLI process using roughly 250–350 MB. **8 parallel ≈ 2–3 GB · 16 parallel ≈ 4–6 GB.** On an 8 GB Mac, values above 8 may cause swapping and run *slower* than a lower setting. Higher values also reach your subscription's rate limit sooner — processing pauses and resumes automatically when that happens. Local transcription and embeddings have their own limits and are not affected by this setting.

1. **Enrichment and understanding share the LLM pool.** Image and video-frame captions are LLM calls, not local ML, and compete for the same rate limit. The pool is split by share — default **40 % enrichment / 60 % understanding** — so a photo backlog can never starve extraction, and extraction can never leave media unread.
2. **Adaptive backoff.** Sustained rate-limit refusals halve the effective LLM concurrency for the next 10 minutes, then ramp back. The user's setting is a ceiling, not a promise.

### 4.4.2 Parallelism is partitioned, not free-for-all

Throughput is not the constraint — **order-dependence** is. Each stage has a partition key inside which work is serial and across which it is parallel.

| Stage | Partition key | Why |
|---|---|---|
| Enrichment | event | zero shared state — fully parallel |
| **P-CL1 / P-CL1Δ** | episode | genuinely independent; deterministic keys + upsert |
| **P-EP2** episodes | **stream** | two sessions of the *same* stream could both attach to one open episode, or both mint duplicates |
| **P-EP1** entity pass | session (compute) | two parallel calls proposing "the broker" would mint two entities |
| Arc binding | compute parallel | commit only through two-phase reconcile |
| **P-AG3** | `(subject_id, kind)` | two adjudications on one `claim_key` would race |

**The general rule: compute in parallel, apply through a serialized writer.** Apply is code, so serializing it is cheap, and SQLite's WAL (many readers, one writer) enforces it for free — keep transactions short.

### 4.4.3 Prompt caching — measure it, never assume it

Caching is prefix-based: the request hashes `tools → system → messages` up to a breakpoint, and any change at or before that point is a miss. Many distinct prefixes coexist (keyed by hash, isolated per workspace); it is **not** a single "last call" slot. TTL is 5 minutes, refreshed free on every hit.

**Three facts make caching marginal for this workload, and the cost model must NOT assume it:**

1. **Minimum cacheable prefix — Sonnet 5: 1,024 tokens · Haiku 4.5: 4,096 tokens.** Our haiku prompts (P-EP1, P-TR1, P-DD1, P-SP1) are ~600–1,200 tokens and will **never cache**. This fails silently: no error, both cache fields simply return 0.
2. **Parallelism defeats caching.** A cache entry only becomes readable once the first response has *begun*. Firing 8 parallel calls that share a prefix means **8 misses and 8 write premiums (1.25×)** — 25 % worse than not caching at all.
3. **We do not control breakpoints.** `cache_control` cannot be passed through the CLI; the CLI decides. Our only lever is what goes in `--append-system-prompt` versus what goes on stdin.

**Therefore:**

1. **Warm-then-fan-out.** Run the first call of a batch alone; once it returns, release the remaining N−1 in parallel. If the prefix is cacheable this converts 8 writes into 1 write + 7 reads at 0.1×. Controlled by `caching.warm_first` (default **on**).
2. **Put stable content first and in the system prompt** — instructions + roster go in `--append-system-prompt`; the variable episode content goes on stdin.
3. **Instrument and surface the hit rate** (§4.4.4). If it sits near zero the prefix is under the minimum: either pad it deliberately or set `caching.warm_first = off` and stop paying write premiums.
4. **No cost estimate in this document assumes a cache hit.** The delta pass is cheap because the prompt is smaller, not because it is cached.

### 4.4.4 Token and cost accounting — correctness requirements

Four token classes, and they are **not** interchangeable. The prior system shipped three separate accounting bugs; these rules exist to prevent each.

```
 total_input_tokens = cache_read_input_tokens
                    + cache_creation_input_tokens
                    + input_tokens          ← ONLY tokens after the breakpoint

 billable_tokens    = input_tokens
                    + 1.25 × cache_creation_input_tokens
                    + 0.10 × cache_read_input_tokens
                    + output_tokens         ← for QUOTA gating only

 cost_usd           = the CLI's own reported total_cost_usd, verbatim
                      never recomputed from a local price table
```

1. **`input_tokens` is not "the input."** It counts only tokens *after* the last cache breakpoint. Rendering it as total input is the bug that made a real 59,700-token call display as 17.
2. **Never display `input` and `cache` as if they were separate spend.** A row reading "Input 21,849 · Cache 21,846" is the same tokens counted twice. Show the three components **and** their sum, explicitly labelled.
3. **Cost and tokens must aggregate over the same filter.** The prior build summed tokens from one table and cost from another with a different `WHERE`, so a real \$0.69 rendered as "—". One query, one filter, one row set.
4. **Attribute every run to its role and cohort.** `runs.role ∈ media|entity|episode|arc|extract|triage|done_detect|classify|adjudicate|chat` and `runs.cohort_id`. A block labelled "Chat" that is 100 % background extraction is a truthfulness defect.
5. **Quota gating counts `billable_tokens`, never a raw sum** — a raw sum trips the window roughly 10× early.
6. **Estimate before spending.** Before a bootstrap, show a projected cost from event count × measured tokens-per-event. During it, show spend-to-date and a projection.

**Settings → Usage surface:**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ USAGE                          today · 7d · 30d · this import  [ 7d ▾ ]  │
├──────────────────────────────────────────────────────────────────────────┤
│  TOKENS                    fresh     cache write   cache read    output  │
│   extract (sonnet-5)      412,880       128,400       96,200     84,110  │
│   media   (haiku-4.5)     980,200             0            0     41,300  │
│   entity  (haiku-4.5)     210,400             0            0     18,900  │
│   triage  (haiku-4.5)      38,100             0            0      6,200  │
│   ─────────────────────────────────────────────────────────────────────  │
│   total input 1,866,180  =  fresh 1,641,580 + write 128,400 + read 96,200│
│   total output 150,510                                                   │
│                                                                          │
│  CACHE          hit rate 12%   ⚠ haiku prompts are below the 4,096-token │
│                 minimum and cannot cache — this is expected              │
│                                                                          │
│  COST           $3.14 total    extract $1.82 · media $0.98 · other $0.34 │
│                 (reported by the Claude CLI, not estimated)              │
│                                                                          │
│  RUNS           1,284 ok · 6 retried · 2 quarantined   [ view ]          │
│  THIS IMPORT    3,028 events · 71% complete · $2.21 spent · ~$0.9 to go  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.5 The party model — three roles, nine directions

Every claim and every loop is a statement *by* someone *about* or *toward* someone. Three roles exist relative to a given session:

```
  s  SELF    the "me" entity
  o  OTHER   a participant of THIS session (present in the conversation)
  t  THIRD   mentioned but NOT a participant (absent from the conversation)
```

**Nine ordered pairs, source → target:**

| Pair | Claim reading | Loop reading |
|---|---|---|
| `ss` | I state something about myself | I owe myself (renew my passport) |
| `so` | I state something about you | I owe you (I'll send the link) |
| `st` | I state something about an absent person | I owe an absent person (call Rahul) |
| `os` | You state something about me | You owe me (you'll send the doc) |
| `oo` | You state something about yourself | You owe yourself |
| `ot` | You state something about an absent person | You owe an absent person |
| `ts` | An absent person's words, about me | An absent person owes me |
| `to` | An absent person's words, about you | An absent person owes you |
| `tt` | An absent person's words, about another absent person | Neither party is present |

**The pair is computed by code, never asked of the model.**

```
 role(entity, session) =  s  if entity == me
                          o  if entity ∈ session.participant_entity_ids
                          t  otherwise

 claim.party_pair = role(speaker_id) ‖ role(subject_id)      [CODE]
 loop.party_pair  = role(owner_id)   ‖ role(counterparty_id) [CODE]
```

1. **Zero model burden, zero wire bytes.** The participant set is already known from the session; `speaker_id` is already written by code from the event actor. The model emits only `subject`, `owner` and `counterparty` as aliases — the pair falls out.
2. **`other` means "participant of this session", not "the addressee".** In a five-person group everyone present is `o`; who was being spoken *to* is carried separately by `addressee_id`.
3. **`party_pair` is queryable and load-bearing:**
   - `os` claims are what other people assert about you — the highest-value and most error-prone class.
   - `ot` / `tt` claims are gossip about absent people; they belong on that person's record, weighted down.
   - `oo` loops are someone else's business entirely and must never reach your task list.
   - **A thread whose loops carry no `s` in either position is not your space** — it is context on that person. This is the code rule that kills the "8 spaces that were really other people's lives" failure.
4. **Attribution stays orthogonal.** `party_pair` answers *who, structurally*. `attribution ∈ first_person | about_other | reported_speech | quoted_third_party` answers *what kind of speech act*. A `ts` pair with `reported_speech` is "you told me what Rahul said about me" — both dimensions are needed and neither substitutes for the other.

### 4.6 Error handling

The provider's real error set is exactly seven: `TIMEOUT · SPAWN_FAILED · CLI_ERROR · POISONED_SESSION · CANCELLED · QUOTA_EXCEEDED · BAD_REQUEST`. **There is no `AUTH_REQUIRED` code** — auth failures arrive as `CLI_ERROR` with a refusal-shaped message.

1. `CLI_ERROR` matching `/rate.limit|too many requests|\b429\b|\b40[13]\b|quota|usage limit|unauthorized|authentication|invalid api key|credit balance|\/login/i` → **pause the lane**, backoff 60 s doubling to 900 s, **do not spend the unit's retry budget**. Punishing a good unit for an outage is how a whole backlog gets quarantined.
2. `TIMEOUT` and other `CLI_ERROR` → retry 2 s / 10 s / 30 s, then `quarantine` and step past. A failing unit never stops the others.
3. `QUOTA_EXCEEDED` → pre-dispatch gate on `billableTokens = input + 1.25·cache_create + 0.1·cache_read + output`. **Never a raw sum** — it trips ~10× early.
4. **A paused lane is never a silent stall.** The coverage meter renders "paused — resumes in mm:ss" (§9.6, §13).

---

## 5. STW-2 — the compact wire encoding

Every prompt and every response uses **STW-2**, a line-oriented, pipe-delimited format with base-36 aliases. JSON is never sent to or expected from a model in this pipeline.

**Why.** Measured on the prior corpus: **37.2 % of output characters were raw event ids**, echoed back 3,683 times. One WhatsApp id is 51 characters ≈ 13–15 tokens. Replacing it with `7` costs one token. A worked example — six events into one new thread — went from **~1,740 characters of JSON to ~62 characters of STW-2**, the same information. Fixture tests on the ancestor format asserted **≥40 % smaller on a mixed batch and >60 % on a 60-event batch**, the saving growing with batch size because ids stop repeating.

**The one rule that governs the whole format:**

> **Compress structure, never language.** Ids, enums, dates and repetition are abbreviated. Claim text, loop titles and quotes are stored **verbatim, as the model wrote them**.

### 5.1 Grammar

```
 record   ::= tag "|" field ( "|" field )* "\n"
 tag      ::= a single character, first character of the line
 fields   ::= separated by a bare "|", each trimmed of surrounding whitespace
 PROSE IS ALWAYS THE LAST FIELD AND MAY CONTAIN "|" — the tail is re-joined,
   never split. There is no escaping mechanism and none is needed.
 events   ::= item ( "," item )*      item ::= n | n "-" n   base-36, INCLUSIVE
 absent   ::= "" or "-"  (also – — ―)  meaning "not stated"
 conf     ::= decimal in [0,1]; AN EMPTY FIELD MEANS 0.9
```

Line endings are `\n`; a trailing `\r` is stripped. Every field is trimmed, so `F | a1 | …` and `F|a1|…` parse identically.

### 5.2 Alias namespaces

| Prefix | Namespace | Replaces |
|---|---|---|
| *(bare base-36)* | event | `wa:918506013131@s.whatsapp.net/FD830F18895B6A18D1` (51 ch) |
| `self` | the me entity | reserved, never numbered |
| `a1…an` | person / entity | full display name or `ent_` id |
| `c1…cn` | chat / stream | the full JID or stream key |
| `n1…nn` | thread (arc), existing | `arc_…` id |
| `k1…kn` | thread proposed in *this* answer | a slug the model would otherwise invent |
| `e1…en` | episode, existing/open | `epi_…` id |
| `t1…tn` | loop, existing/open | the loop uuid |
| `+Name` | an entity not on the roster | verbatim name, minted by code after dedupe |

1. **Base-36 above 35**: `a`=10 … `z`=35, `10`=36, `1a`=46. Ranges are **inclusive** and base-36: `c-f` is 12–15, `12-15` is 38–41.
2. **Aliases are prompt-local and never persisted.** A fresh table per prompt, resolved by range check — `a9` in a roster of seven resolves to `null`, never to a string match. Unresolvable aliases return `unresolved`, they do not guess.
3. **Range compression on emit**: a run of ≥3 becomes `lo-hi`; a run of 2 stays comma-separated.

### 5.3 Tag vocabulary — closed, single character, globally unique

| Tag | Meaning | Emitted by |
|---|---|---|
| `M` | mention — a text span linked to an entity | P-EP1 |
| `N` | new entity proposal | P-EP1 |
| `L` | link — a relation edge | P-EP1 |
| `F` | claim · **fact** | P-CL1 |
| `P` | claim · **preference** | P-CL1 |
| `B` | claim · **belief** | P-CL1 |
| `O` | claim · **opinion** | P-CL1 |
| `I` | claim · **interest** | P-CL1 |
| `R` | claim · **recommendation** | P-CL1 |
| `H` | claim · **habit** | P-CL1 |
| `W` | claim · **workflow** | P-CL1 |
| `T` | loop | P-CL1 |
| `Y` | episode summary | P-CL1 |
| `Z` | update to an already-extracted item (delta mode) | P-CL1Δ |
| `G` | segment — an episode split/attach decision | P-EP2 |
| `V` | verdict — arc membership or claim contradiction | P-AG2 · P-AG3 |
| `S` | state — done-detection verdict | P-DD1 |
| `J` | judgment — triage class | P-TR1 |
| `D` | derive — archetype + label for a thread | P-SP1 |
| `C` | caption — media description | media describe |
| `Q` | question — the model cannot resolve this, ask the user | any |
| `X` | noise — these events carry nothing | any |
| `?` | needs lookup — cannot place without more context | any |

**The claim kind is the tag.** No separate `kind` field, no enum to misspell, eight kinds for one character. An unknown tag is a violation, never a guess.

### 5.4 Enum tables — wire code → stored value

Decoding is case-insensitive and collapses whitespace/underscore/hyphen runs. **The stored long form is always also accepted**, so a model writing `first_person` instead of `1p` is tolerated. Tolerated spellings are alternative *spellings*, never reinterpretations.

```
 ATTRIBUTION   1p  = first_person        also: firstperson, self
               ao  = about_other         also: aboutother, other
               rs  = reported_speech     also: reported, relayed
               q3  = quoted_third_party  also: quoted, forwarded

 ORIGIN        ex  = explicit            also: stated, said
               im  = implicit            also: inferred

 DIRECTION     i2t = i_owe_them          also: u2o, user_to_other
               t2i = they_owe_me         also: o2u, other_to_user
               shr = shared              also: both, mutual
               slf = self                also: own

 STAKE         h = high · m = medium · l = low
 HORIZON       d = today · w = week · mo = month · q = quarter · y = year · n = none

 LOOP STATE    op = open · lt = latent · dn = done · lp = lapsed · dr = dropped
 TRIAGE        au = auto · ap = approval · cx = context

 ENTITY TYPE   per = person · grp = group · org = org · plc = place
               thg = thing  · med = media_work · doc = document
               occ = occasion · top = topic

 EDGE KIND     rel = related_to · aff = affiliated_with · has = has
               loc = located_at · prt = part_of · par = participates_in
               abt = about

 ARCHETYPE     prj = project · evt = event · rhy = rhythm · adm = admin
               hld = holding · mat = matter · pur = pursuit · wch = watch

 PROMOTION     cmt = commitment · ref = reference · rec = recurrence · usr = user

 SEGMENT       att = attach · new = new
 VERDICT       jn = join · nw = new · un = unsure
               dup = duplicate · rfn = refinement · ctr = contradiction · dst = distinct
 DONE STATE    dn = done · ps = possibly · dr = dropped · op = still_open

 CHAT KIND     grp = group · dm = dm · biz = business
```

**`party_pair` is never on the wire** — it is derived by code from the resolved aliases (§4.5).

### 5.5 Input format — what the model reads

```
 #R  a1=Pranjali Sachdeva | a2=Rahul Arora | a3=Villa Amara [plc]     roster
 #C  c1 Pranjali | dm | self,a1                                       stream header
 #E  e1 villa shortlist for Goa | open | last Mon | a2,a3             open episodes
 #T  t1 Confirm villa to Rohan | me | 2026-08-20 | op                  open loops
 #D  2026-08-12 Wed | Asia/Kolkata                                     date + tz
 1 09:14 a1  i've started bhangra classes on saturdays
 2 +1   self nice. i'll send you that villa link tonight
 3 +6   a1   ^1 the saturday batch is full actually
 4 +2   a1   [voice note, transcription pending]
 #COV c1=4                                                             expected coverage
```

| Marker | Grammar |
|---|---|
| `#R` | roster: `a<n>=<name>` joined by `\|`, with `[type]` appended when not a person |
| `#C` | `c<n> <name> \| <kind> \| <participants>` — `self` hoisted first, `a<n>=Name` at first mention only |
| `#E` | open episodes for this stream: `e<n> <label> \| <state> \| <last activity> \| <entities>` |
| `#T` | open loops touching these entities: `t<n> <intent> \| <owner> \| <due> \| <state>` |
| `#D` | `YYYY-MM-DD Ddd \| <tz>` — once per day per chat block |
| event | `<n> <time> <who>[ ^<n>][ <text>]` — `+m` = minutes since the line above; `^n` = reply to event n |
| `#COV` | expected event count per chat block, so silent drops are detectable |

Time deltas reset at every `#D` and `#C`. A delta that is negative or >999 minutes falls back to absolute `HH:MM`. Separators are neutralised in the packer: `|` → `/` in labels, `,` → space in participant names, all newline runs collapse to a single space.

### 5.6 Output templates — one per call

```
 P-EP1  entity pass
   M | <ev> | <surface text> | <a-alias | +Name | ->  | <conf> [| <hint>]
   N | <k-alias> | <Name> | <type> [| <subtype>]
   L | <ev> | <src> | <edge kind> | <subtype> | <dst> | <conf> | <quote>
   Q | <about> | <question>

 P-CL1  claims + loops                    (claim kind IS the tag)
   Y | <ep> | <2-3 sentence episode summary>
   F | <events> | <subject> | <attribution> | <conf> | <valid_from> | <text>
   P B O I R H W   — identical shape to F
   T | <events> | <owner> | <counterparty> | <origin> | <dir> | <stake>
     | <horizon> | <due> | <recurrence> | <conf> | <intent>
   Q | <about> | <question>

 P-CL1Δ delta mode — as P-CL1, plus
   Z | <claim|loop ref> | <change> | <events> | <note>
       change ::= ctr | dat | cmp | cnl | rfn

 P-EP2  episode segmentation
   G | <session> | <events> | <att|new> | <e-alias | -> | <conf> | <topic label>

 P-AG2  arc adjudication
   V | <ep> | <jn|nw|un> | <n-alias | -> | <conf> | <reason>

 P-AG3  claim contradiction
   V | <claim a> | <claim b> | <dup|rfn|ctr|dst|un> | <later: a|b|-> 
     | <valid_to for earlier> | <conf> | <reason>

 P-TR1  triage
   J | <t-alias> | <au|ap|cx> | <urgency> | <reason>

 P-DD1  done-detection
   S | <t-alias> | <dn|ps|dr|op> | <ev | -> | <conf> | <quote>

 P-SP1  archetype + label
   D | <n-alias> | <archetype> | <cadence> | <ends_at> | <conf> | <label>

 media describe
   C | <img id> | <caption>
```

### 5.7 Tolerance — repair only where it is lossless

Four failure classes were observed in production and are repaired silently; everything else is a loud violation.

1. **Markdown wrappers.** Code fences, headings and bullets are skipped and counted. **Emphasis is stripped** when the leading and trailing runs mirror (`**T|…**`, `` `…` ``) or when an opener has no partner — models open bold and forget to close. *In the ancestor system a single unstripped `**T|` produced 212 `unknown_tag` violations and zero claims in one run.* Interior emphasis survives byte-for-byte.
2. **Enum drift.** Casing, spacing, underscores, and the stored long form all decode. A genuinely wrong word is a violation, **not** a silent default — "a blank is the model being honest; a wrong word is the model being wrong."
3. **Token wrappers.** `{due:2026-08-08}` in a date field and `{conf:0.8}` in a confidence field unwrap. **The key must match the field** — `{conf:…}` in a due slot stays a violation. A bare `{due}` yields "not stated"; inventing a date is forbidden.
4. **Field-count slack** only where a tail is genuinely droppable (a hint, an `ends_at`, an evidence ref). Tags ending in machine fields accept no surplus.

**Not softened:** a line containing `|` with a broken tag is a violation. Unknown tags are violations. A line with no `|` is prose and is skipped, not repaired.

### 5.8 Failure handling

1. **Violations carry a 1-based line number and quote the model's original text**, so repair re-asks only the failing lines.
2. **One repair round, bounded.** The retry prompt lists `line N — rule: detail` per rejection and instructs: *re-emit only the corrected lines, do not repeat accepted lines, do not re-answer events those lines already covered.* Accepted lines from round 1 are kept and merged. A second failure leaves the violations in the result rather than looping.
3. **`no_wire_lines`** — when the entire answer was prose, exactly **one** violation is emitted for the whole response, not one per line.
4. **Accounting invariant:** `accepted_lines + violations + content_skipped == non_blank_lines`. Nothing is ever silently dropped.
5. **Totality:** the parser never throws — on random bytes, truncated lines, `null`, or `"||||||"`. A malformed line can never take down a batch.
6. **Roster misses are honest.** An `a<n>` outside the roster resolves to `null`, which reads as "the model did not say", never as a mis-attribution to the user.

### 5.9 Round-trip and rollout

1. **Byte-identical round trip is a CI gate**: `serialize(parse(serialize(x))) == serialize(x)` over a generated cross-product covering every tag.
2. **A/B correctness gate, not a token gate.** The wire and JSON paths must produce **equal parsed results** on the gold set. Token savings are *reported*, never asserted — a test that fails on a token count turns a measurement into a flake.
3. **Rollout flag `wire.enabled`**, defaulting **on** for this build, with the JSON path retained behind it for one release as an escape hatch. A packer refusal (roster over cap) falls back to JSON for that call and logs it.
4. **The instruction half of every prompt is a stable prefix** — the grammar and enum legend never vary within a call type, which is what makes them a cache candidate at all (§4.4.3).

---

## 6. Data model — complete

```sql
-- ═══ L0 registry ════════════════════════════════════════════════════════
sources           (id PK, display_name, actor_model, manifest_json,
                   enabled, mode, connected_at, created_at)
                   -- mode: bootstrap | steady
streams           (id PK, source_id FK, external_key, label, stream_kind,
                   participant_entity_ids JSON, tz,
                   segmentation_override_json NULL,
                   UNIQUE(source_id, external_key))
watermarks        (stream_id PK, live_high_ts, live_high_external_id,
                   backfill_low_ts NULL, backfill_complete BOOL)
                   -- live head moves FORWARD; backfill floor moves BACKWARD

-- ═══ L1 events ══════════════════════════════════════════════════════════
events            (id PK, source_id, stream_id FK, external_id,
                   actor_entity_id NULL, actor_raw, is_self, is_business,
                   ts, ts_end NULL, tz, ingested_at, is_historical,
                   kind, text, structured_json,
                   media_* / link_* / transcript_*  (V11 lifecycle cols kept),
                   reply_to_external_id, revision_of NULL,
                   salience REAL NULL,
                   enrichment_state, enriched_at NULL, enrich_salient BOOL NULL,
                   UNIQUE(source_id, external_id))
-- kind: message|post|comment|reaction|edit|revoke|view|play|save|order
--     | visit|frame|utterance|appointment|file_change|reminder|clip
-- enrichment_state: none_needed | pending | ready | failed | skipped
-- ⚠ ts        = when it was SAID  → the ONLY basis for precedence
--   ingested_at = when the row was written → audit/debug ONLY, never precedence
events_fts        -- FTS5 external-content over text + enrichment columns (V11)
event_embeddings  (event_id PK, vec BLOB, model, dim)

-- ═══ SCHEDULER ══════════════════════════════════════════════════════════
cohorts           (id PK, source_id NULL, mode, horizon, seq,
                   ts_hi, ts_lo, priority,
                   session_ids JSON, event_count, token_estimate,
                   state, opened_at, enriched_at NULL,
                   understood_at NULL, surfaced_at NULL,
                   reason NULL)
-- mode: bootstrap | steady | reprocess
-- horizon: live | h24 | d7 | d30 | d90 | y1 | older
-- state: planned|enriching|ready|understanding|done|paused|quarantined
work_queue        (id PK, unit_kind, unit_id, cohort_id FK, stage,
                   priority, attempts, not_before_at, state, created_at)
-- unit_kind: event|session|episode|arc|claim_pair|loop_batch
-- stage: enrich|entity|segment|episode|arc|extract|triage|done|derive
coverage          (scope_kind, scope_id, horizon, total_units, done_units,
                   updated_at, PRIMARY KEY(scope_kind, scope_id, horizon))
-- scope_kind: global | source | stream

-- ═══ L2 entity graph ════════════════════════════════════════════════════
entities          (id PK minted, type, subtype NULL, canonical,
                   provisional, merged_into NULL, user_pinned,
                   first_seen_at, last_seen_at, created_at)
-- type: person|group|org|place|product|service|media_work|document
--     | app_site|occasion|topic|pet|vehicle|account|health_item|food_item
entity_identities (id PK, entity_id FK, source_id, kind, value_norm,
                   confidence REAL, decided_by, decided_at,
                   UNIQUE(source_id, kind, value_norm))
-- kind: jid|phone|email|handle|account_id|device_id|profile_url|alias
entity_edges      (id PK, kind, subtype NULL, src_entity_id FK, dst_entity_id FK,
                   confidence REAL, decided_by, status,
                   valid_from NULL, valid_to NULL, created_at,
                   UNIQUE(kind, subtype, src_entity_id, dst_entity_id))
-- kind: family_of|social_of|works_with|works_at|provides_care|member_of
--     | owns|pet_of|subscribes_to|lives_at|located_in|part_of|created
--     | provides|about|participant_in     status: active|superseded|rejected
edge_evidence     (edge_id FK, event_id FK, quote, PRIMARY KEY(edge_id, event_id))
mentions          (id PK, event_id FK, span_start, span_end, surface_text,
                   entity_id NULL, new_entity_json NULL, entity_hint NULL,
                   confidence REAL, decided_by)
resolution_decisions (id PK, left_id, right_id, verdict, decided_by, reason,
                   created_at, UNIQUE(left_id, right_id))
entity_embeddings (entity_id PK, vec BLOB, model, dim)
embedder_calib    (model, use_case, floor REAL, measured_at, n_pairs,
                   PRIMARY KEY(model, use_case))

-- ═══ L3 sessions ════════════════════════════════════════════════════════
sessions          (id PK, stream_id FK, source_id,
                   started_at, ended_at, tz,
                   event_ids JSON, participant_entity_ids JSON,
                   boundary_reason_start, boundary_reason_end,
                   boundary_params_json,
                   seal_mode,                    -- immediate | debounce | ceiling
                   content_hash, superseded_hash NULL, hash_version,
                   status, sealed_at, late_arrival, overlap_of NULL,
                   pending_enrichment_count INT DEFAULT 0,
                   reprocess_count INT DEFAULT 0,
                   last_delta_at NULL, delta_pass_count INT DEFAULT 0)
-- boundary_reason: gap|participant_shift|reply_break|size_cap|day_boundary
--                | context_shift|record_bounded|ceiling|debounce|stream_start
-- status: open | sealed

-- ═══ L4 episodes ════════════════════════════════════════════════════════
episodes          (id PK, stream_id FK, source_id, topic_label, label_source,
                   session_ids JSON, event_ids JSON, entity_ids JSON,
                   arc_state, outcome NULL,
                   started_at, ended_at, created_at, updated_at)
episode_sessions  (episode_id FK, session_id FK, added_by, verdict_id NULL,
                   PRIMARY KEY(episode_id, session_id))
episode_verdicts  (id PK, episode_id NULL, session_id FK, run_id, decision,
                   candidates_json, output_json, model, created_at)
episode_embeddings(episode_id PK, vec BLOB, model, dim)

-- ═══ L5 arcs ════════════════════════════════════════════════════════════
arcs              (id PK, arc_key UNIQUE, label, label_source,
                   anchor_entity_ids JSON, source_ids JSON,
                   state, started_at, last_evidence_at,
                   promoted BOOL, promotion_reason NULL,
                   archetype NULL, archetype_source NULL,
                   status NULL, ends_at NULL, cadence NULL,
                   user_pinned, user_label NULL, created_at, updated_at)
-- state: live|dormant|archived (the THREAD's own aging)
-- status: active|dormant|archived (the SPACE's, derived from member loops)
arc_episodes      (arc_id FK, episode_id FK, added_by, signal,
                   signal_detail_json, PRIMARY KEY(arc_id, episode_id))
arc_verdicts      (id PK, arc_id NULL, episode_id, run_id, decision,
                   candidates_json, output_json, model, created_at)
bridges           (id PK, kind, value_norm, left_kind, left_id,
                   right_kind, right_id, confidence, decided_by, created_at,
                   UNIQUE(kind, value_norm, left_id, right_id))
provisional_arcs  (id PK, batch_id, arc_key_candidate, episode_ids JSON,
                   created_at)

-- ═══ L6 claims + loops ══════════════════════════════════════════════════
-- ⚠ TEMPORAL MODEL — three distinct fields, never conflated:
--     stated_at   when it was SAID (= source event ts) → PRECEDENCE, always
--     valid_from  when the fact became true of the world  } query + validity
--     valid_to    when it stopped being true              } windows
--     ingested_at when the row was written → audit/debug ONLY
--   Precedence NEVER uses ingested_at. This is what makes the final graph
--   independent of arrival order (confluence).
claim_versions    (id PK, claim_key, kind, subject_id FK entities,
                   subject_hint NULL, predicate, object NULL, text,
                   speaker_id FK entities, addressee_id NULL, attribution,
                   party_pair,                    -- ss|so|st|os|oo|ot|ts|to|tt
                                                  -- DERIVED by code (§4.5)
                   confidence REAL,
                   stated_at, valid_from NULL, valid_to NULL, ingested_at,
                   closed_by NULL, closed_reason NULL,
                   decided_by, created_at, updated_at)
-- ALL versions of a claim_key live here. Nothing is deleted.
-- "which version is ACTIVE" is DERIVED, not stored (see claims_active).

claims_active     -- VIEW, recomputed as a function of the version set:
--   for each claim_key: the version with the greatest stated_at
--   that has closed_by IS NULL and (valid_to IS NULL OR valid_to > now)
--   → an older claim arriving late lands as a PREDECESSOR and cannot
--     dislodge the current truth; a newer one takes over automatically

loops             (id PK, loop_key, intent, origin,
                   owner_id FK entities NULL, counterparty_id NULL,
                   party_pair,                    -- DERIVED by code (§4.5)
                   direction, stake, horizon,
                   due_utc NULL, due_tz NULL, recurrence NULL,
                   next_occurrence_utc NULL,     -- projected from recurrence
                   state, state_reason, triage, urgency,
                   resolution_evidence_event_id NULL, arc_id FK arcs NULL,
                   confidence REAL, stated_at, ingested_at,
                   created_at, updated_at)
-- state is DERIVED from (due_utc, next_occurrence_utc, resolution evidence,
-- recency of reinforcement) — recomputed whenever any of them changes.
claim_embeddings  (claim_id PK, vec BLOB, model, dim)
loop_embeddings   (loop_id  PK, vec BLOB, model, dim)

-- ═══ L7 spaces + goals ══════════════════════════════════════════════════
-- NO spaces TABLE. A "space" is an arc with promoted = true.
-- Promotion is a DERIVED field flip, never the creation of a second object,
-- so the arc id IS the space id and nothing desynchronises.
--   arcs.promoted            BOOL      derived every reconcile
--   arcs.promotion_reason    cmt | ref | rec | usr
--   arcs.archetype           prj|evt|rhy|adm|hld|mat|pur|wch   (when promoted)
--   arcs.archetype_source    model | user
--   arcs.status              active | dormant | archived        (when promoted)
--   arcs.ends_at NULL, arcs.cadence, arcs.user_label NULL
goals             (id PK, name, kind, owner_id FK entities,
                   emerged_from_json, created_at)
goal_spaces       (goal_id FK, space_id FK, PRIMARY KEY(goal_id, space_id))

-- ═══ shared ═════════════════════════════════════════════════════════════
evidence          (subject_kind, subject_id, event_id FK, episode_id FK NULL,
                   quote, PRIMARY KEY(subject_kind, subject_id, event_id))
questions         (id PK, kind, target_kind, target_id, question, options_json,
                   status, answer_json NULL, asked_at, answered_at NULL)
mutations         (id PK, ts, actor, run_id NULL, target_kind, target_id,
                   field, old_json, new_json, reason)
runs              (id PK, kind, role, model, cohort_id NULL, started_at,
                   ended_at, status, input_tokens, cache_create, cache_read,
                   output_tokens, billable_tokens, cost_usd,
                   error_code NULL, error_msg NULL)
quarantine        (id PK, unit_kind, unit_id, cohort_id, run_id, error_code,
                   last_error, attempts, created_at, replayed_at NULL)
```

**Invariants enforced in schema or code, never in a prompt:**

1. `events.actor_entity_id` and `claims.subject_id` are entity ids or NULL + a hint. **A name string is never an id.**
2. `claims.speaker_id` is written by code from `events.actor_entity_id`.
3. Sealed sessions are **immutable in membership**. Enrichment may change their *content hash*; it never changes which events belong.
4. Every session records **both** boundary reasons, the measured params, and its `seal_mode`.
5. Every episode persists its verdict. **Replay reuses it and never re-judges.**
6. `loops.state`, `loops.triage`, `arcs.state`, `spaces.status` are code-written only.
7. `spaces.arc_id` is UNIQUE.
8. Every claim, loop and text edge has ≥1 `evidence` row with a verbatim quote. **No evidence → no write.**
9. `goals` are never created by extraction.
10. Every write emits a `mutations` row. "Undo run X" is reverse-replay.
11. **Work is dequeued by `work_queue.priority` descending, never by rowid or insertion order.**

---

## 7. System architecture

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                        YOUR MAC — everything local                             │
│                                                                                │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L0  ADAPTER REGISTRY                                     [CODE]             ││
│ │  manifest-driven · backfill_order=desc requested · live stream              ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L1  EVENTS — immutable, source-neutral                   [CODE]             ││
│ │  UNIQUE(source_id, external_id) · stream_id · ts (said) / ingested_at      ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ╔════════════════════════════════════════════════════════════════════════════╗│
│ ║ ★ COHORT SCHEDULER — the control plane            [CODE]                    ║│
│ ║   modes: BOOTSTRAP · STEADY · REPROCESS                                     ║│
│ ║   horizons: live → h24 → d7 → d30 → d90 → y1 → older  (NEWEST FIRST)       ║│
│ ║   adaptive cohort budget (warm-up ramp) · one priority queue                ║│
│ ║   TWO LANES, pipelined:                                                     ║│
│ ║      LANE E enrichment  works cohort N+1, N+2   (lookahead)                ║│
│ ║      LANE U understanding works cohort N        (never idle)               ║│
│ ║   pacing · quota-aware · coverage meters · no stalls                       ║│
│ ╚══════════════════════════════════╤═════════════════════════════════════════╝│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L1b SALIENCE PREFILTER — ambient only               [CODE]+[ML]             ││
│ │  phash dedupe · a11y diff · VAD · salience score · 90–99% dropped          ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L1c ENRICH (LANE E, priority = cohort)      [CODE]+[ML]+[LLM-S]             ││
│ │  image/sticker/frames → caption  [LLM-S haiku via CLI]  V11 built          ││
│ │  audio → text                    [ML whisper.cpp]                          ││
│ │  link → scrape · yt → captions   [CODE fetch / yt-dlp]                     ││
│ │  text → embedding                [ML e5-small int8]                        ││
│ │  ★ BARRIER + DEADLINE + late-arrival SUPERSEDE (§8.5)                       ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L2  ENTITY GRAPH                 [CODE]→[ML]→[LLM-S]→[AGENT]                ││
│ │  16 types · identities · 16 edge kinds · mentions · me-entity              ││
│ │  structural binding [CODE] · P-EP1 [LLM-S] · ladder → P-AG1 → ask user     ││
│ │  OUTPUT: the ROSTER injected into every downstream prompt                  ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L3  SESSIONS — deterministic, NO MODEL                   [CODE]             ││
│ │  5 stream-kind policies · seal_mode immediate|debounce|ceiling            ││
│ │  content_hash · boundary_reason + params on every cut                     ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L4  EPISODES — topical, stream-scoped         [CODE]+[ML]+[LLM-M]           ││
│ │  hash gate · drift pre-flag · default 1:1 NO CALL · P-EP2 split/attach     ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L5  ARCS — cross-time, CROSS-SOURCE           [CODE]+[ML]+[LLM-M]           ││
│ │  ① bridges [CODE] ② entity overlap [CODE] ③ calibrated sim [ML]           ││
│ │  ④ P-AG2 [LLM-M] → else ask · two-phase reconcile at cohort boundaries    ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L6  UNDERSTAND — ONE call per episode  P-CL1   [LLM-M, parallel ≤4]         ││
│ │   CLAIMS (unconditional)        ‖        LOOPS (intent + unresolved end)   ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L7  CODE FACTS + WRITE PATH             [CODE]+[ML]+[LLM-M]                 ││
│ │  due<now→lapsed · owner≠me→context · attribution repair · stamps          ││
│ │  claim_key/loop_key → REINFORCE | P-AG3 → supersede | insert | question    ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L8  DERIVE                                    [CODE]+[LLM-S]                ││
│ │  space := arc WITH ≥1 live loop · P-SP1 archetype · P-TR1 · P-DD1         ││
│ │  goal emergence · reconcile (cohort boundary + nightly)                   ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L9  STORE — plain SQLite (WAL), ONE file, ONE truth       [CODE]            ││
│ │  relational + entity_edges (graph) + FTS5 + int8 vectors + mutations      ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L10 SEVEN SURFACES + COVERAGE METERS                      [CODE]            ││
│ │  ENTITIES · SESSIONS · EPISODES · ARCS · CLAIMS · SPACES · TASKS           ││
│ └────────────────────────────────────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────────────────────┘
```

**Executor legend used everywhere:**

| Tag | Means | Runs on | Cost | Determinism |
|---|---|---|---|---|
| `[CODE]` | Deterministic code | worker | free | exact, replayable |
| `[ML]` | Small on-device model — e5, whisper.cpp, phash, VAD | device | ~free | stable |
| `[LLM-S]` | Haiku-class via CLI bare call — high volume, low difficulty | subscription | cheap | judged; verdict persisted |
| `[LLM-M]` | Sonnet-class via CLI bare call — judgment | subscription | metered | judged; verdict persisted |
| `[AGENT]` | LLM-M + our tools, bounded turns | subscription | metered | judged; session persisted |

---

## 8. Operating modes

### 8.1 The two modes

| Aspect | **BOOTSTRAP** | **STEADY STATE** |
|---|---|---|
| Trigger | source connected · import range extended · backfill incomplete on boot | event arrival on a live stream |
| Data property | history is **complete and fixed** — every session's end is already known | the newest session is **still open**; more may arrive |
| Session sealing | **immediate** on the boundary rule. No debounce wait. | **debounce** ∪ boundary rule ∪ 24 h ceiling |
| Understanding cadence | per cohort, as sealed | **live trigger every ~30 s** on the open session + consolidation at seal |
| Work ordering | cohorts by horizon, **newest → oldest** | live events first, then any remaining backfill cohorts |
| Cohort size | adaptive ramp, up to full batch | small, latency-optimised |
| Enrichment | async, priority = cohort priority | async, priority = live |
| Arc reconcile | at **every cohort boundary** + nightly | on change + nightly |
| Question raising | deferred to end of horizon (batched, not 200 popups) | immediate |
| Cost profile | burst; quota-aware pacing | idle-cheap; hash gate absorbs re-syncs |
| Exit condition | `backfill_complete` on every stream → mode flips to `steady` | — |

**Both modes run the same code path.** The differences are parameters on the scheduler and the segmenter. There is **no separate first-run pipeline** and no demo mode.

### 8.2 Why bootstrap can seal immediately

The debounce timer exists to answer "is this conversation over?" for **live** data. In bootstrap the answer is already known: the next event in the stream either exists (and its gap decides the boundary) or does not (end of history → seal). Waiting for a conversation that ended in 2024 is pure latency for zero information.

```
 STEADY   [msg]…[msg] ──?── may continue ── debounce ──► SEAL
 BOOTSTRAP[msg]…[msg] ──gap 7h known from the next row──► SEAL now
```

The **one exception**: the newest session of a stream during bootstrap has no "next row". It is left `open` and handed to steady-state rules, so live continuation appends to it rather than orphaning it.

### 8.3 Near-realtime: extraction cadence is decoupled from session boundaries

**The mistake to avoid:** waiting for a session to seal before understanding it. A 6 h conversation gap would mean a new message is understood up to 45 minutes later. That is not an assistant.

**The wrong fix:** shrinking the session gap. Dropping 6 h → 5 min splits a conversation with a ten-minute pause into two sessions, two episodes, possibly two arcs. That trades latency for shredded topical coherence — the exact thing sessions exist to protect. **Session boundaries stay semantically correct; only the extraction cadence changes.**

**Two independent triggers on the same open session:**

```
 ┌── LIVE TRIGGER ── near-realtime ─────────────────────────────────────┐
 │  fires on:  live_interval of quiet (default 30 s)                    │
 │             OR K new events (default 10)                             │
 │  runs:      P-CL1Δ — DELTA extraction over the NEW events only,      │
 │             with a compact running summary of the session as context │
 │  emits:     claims + loops immediately · session stays OPEN          │
 │  surfaces:  marked "conversation in progress", updated in place      │
 └──────────────────────────────────────────────────────────────────────┘
 ┌── SEAL TRIGGER ── coherence ─────────────────────────────────────────┐
 │  fires on:  the normal boundary rules (gap · cap · midnight ·        │
 │             debounce · 24 h ceiling)                                 │
 │  runs:      ONE consolidation pass (full P-CL1) — but only if the    │
 │             session gained material content since the last delta.    │
 │             Otherwise the hash gate skips it entirely.               │
 │  purpose:   cross-message conclusions only visible whole-session     │
 └──────────────────────────────────────────────────────────────────────┘
```

**Delta extraction is mandatory, not an optimisation.** At a 30 s interval a 40-message session would otherwise be re-read ~40 times: cost **O(n²)** in session length. A delta pass sends only new events plus a running summary → **O(n)** overall. At the old 45-minute cadence this barely mattered; at 30 s it is the difference between viable and ruinous.

**`live_interval` is user-configurable, 30 s – 6 h (default 30 s).**

| Setting | Behaviour |
|---|---|
| 30 s (default) | near-realtime; a commitment appears about half a minute after it is made |
| 2–10 min | conversations mostly resolved before extraction; less churn, fewer calls |
| ≥ 6 h | meets the conversation gap, so the live trigger effectively never fires — pure seal-time behaviour, chosen deliberately |

Four guards keep the floor safe:

1. **Backpressure is visible, never silent.** `effective_interval = max(live_interval, backpressure(stream activity))`. A 50-message burst does not fire 20 passes; the stream shows "high activity — batching every 2 min" so the system never appears to ignore the setting.
2. **Hard cap: 20 live passes per stream per hour.** Beyond that the stream waits for seal.
3. **Steady state only.** Bootstrap uses immediate-seal, so setting 6 h never slows an import or the 120 s first-output target.
4. **Consolidation is conditional.** If the deltas already covered everything and the hash is unchanged, seal costs nothing.

**Cost:** a session with three conversational bursts costs ~3 small delta calls plus at most one consolidation, versus one large call. Roughly 2–3× the calls **for live data only** — and steady state is 10²–10³ events/day against bootstrap's 10⁵+. Negligible.

### 8.4 Text-first, enrich-later — exactly two passes

**Media never blocks text.** There is no barrier and no waiting period.

```
 EPISODE containing attachments
   │
   ├─► PASS 1 — TEXT ONLY, immediately                 [CODE]+[LLM-M]
   │     attachments appear as explicit placeholders:
   │       "[image, description pending]"
   │       "[voice note, transcription pending]"
   │     → claims + loops emitted now · surfaces update now
   │     → the episode is marked ◍ "media still reading"
   │
   └─► ENRICHMENT runs async, own concurrency class    [ML]/[LLM-S]
         whisper · vision captions (batched, §9.1) · frames · scrape
         priority = the event's cohort priority (never FIFO)
              │
              ▼  WAIT FOR ALL enrichments on this episode to finish
                 (ready · failed · skipped — no pending remain)
              │
         ┌────▼──────────────────────────────────────────────────┐
         │ PASS 2 — COMPLETE, exactly once                       │
         │   the whole episode, media now readable, same session,│
         │   same neighbours, same roster                        │
         │   → write path absorbs idempotently: exact keys       │
         │     REINFORCE · new content INSERTs · changed meaning │
         │     SUPERSEDES                                        │
         │   → ◍ marker clears                                   │
         └───────────────────────────────────────────────────────┘
              │
              ▼  derived layers recompute                        [CODE]
                 entities → episode → arc → space → loop state → tasks
```

1. **Two passes, not N.** Pass 1 is text-only and immediate; pass 2 fires **once all enrichment for the episode has completed**. No debounce tuning, no partial re-reads, no barrier thresholds. An episode with no media has exactly one pass.
2. **A third pass happens only if media arrives later still** — a delayed sync, an extended history range, a re-downloaded attachment. Bounded at `reprocess_max` (default 3).
3. **Failed and skipped enrichments do not block pass 2.** An attachment whose transcription failed counts as resolved; its placeholder becomes "[voice note, unreadable]" and pass 2 proceeds.
4. **This is the same mechanism as any other late data**, which is your "nothing is final" principle applied to attachments. One mechanism, not two.
5. **Why this beats a barrier:** no arbitrary per-source thresholds, text latency is always minimal, and a session containing one image never waits on it.

**Configurable behaviour:**

| Setting | Default | Effect |
|---|---|---|
| `enrichment.read_all_media` | **on** | Caption **every** image and sticker, transcribe every voice note. Off: skip stickers and sub-2 s audio. |
| `enrichment.salience_gate` | **off** | When on, an enrichment whose text carries no entity, date, number, price or commitment does not trigger pass 2 (a `[CODE]` check, no model call). Saves cost, at the risk of missing a caption that mattered. **Off by default — read everything.** |
| `enrichment.delta_context_mode` | **`summary`** | What pass 2 and live delta passes carry as context (below). |
| `enrichment.reprocess_max` | 3 | Hard ceiling on passes per episode. |

**Delta context mode — `summary` vs `raw_events`:**

```
 summary (default)   episode_summary (2–3 lines, emitted FREE by pass 1)
                     + the already-extracted claim/loop ids
                     + only the new or newly-readable events
                     → ~20% of a full call. Cheapest. Slightly lossy:
                       the model cannot see exact prior wording.

 raw_events          the full original event list + the newly-readable
                     events, with delta instructions
                     → ~100% of a full call. Faithful: media captions are
                       interpreted against the exact surrounding text.
                       Better quality where a photo only makes sense next
                       to what was said around it.
```

**The summary is free.** P-CL1 emits an `episode_summary` field as part of pass 1's normal output (~80 output tokens) — it is not a separate call. This is what makes `summary` mode the sensible default rather than a false economy.

## 9. The cohort scheduler

### 9.1 Cohorts

A **cohort** is the unit of scheduling: a bounded set of sessions, drawn from one horizon, processed end-to-end together.

```
cohort = (mode, horizon, seq, ts_hi, ts_lo, session_ids[],
          event_count, token_estimate, priority, state)
```

1. **Bounded by work, not by wall-clock time.** A cohort closes when it hits its budget in sessions *or* estimated tokens, whichever comes first.
2. **Adaptive budget with a warm-up ramp** — one formula, no special-casing:

```
   cohort_budget(seq) = min( MAX_BUDGET , BASE_BUDGET × 2^seq )

   BASE_BUDGET = 4 sessions / 6k tokens        (seq 0)
   MAX_BUDGET  = 24 sessions / 40k tokens      (seq ≥ 3)

   seq 0 →  4 sessions   ← small by construction, fast first paint
   seq 1 →  8 sessions
   seq 2 → 16 sessions
   seq 3+ → 24 sessions  (steady maximum)
```

The first cohort is small **because the ramp starts small**, not because it is a different process. Every cohort travels the identical path.

3. **A cohort is the unit of progress.** It moves `planned → enriching → ready → understanding → done`, and each transition updates `coverage`. Surfaces refresh on `done`.

### 9.2 Ordering — newest first, in both modes

```
 HORIZON LADDER (descending recency)

   live   ──►  h24  ──►   d7   ──►  d30  ──►  d90  ──►   y1  ──►  older
   now         −24h        −7d       −30d      −90d      −365d     ∞

 priority = (horizon_rank × 10^6) + (ts_hi normalised)
   → the queue is a single priority queue; live always outranks h24,
     h24 outranks d7, and within a horizon newer outranks older.
```

1. **Time-first, not stream-first.** A cohort draws from **all streams** inside its horizon. Processing stream-by-stream would produce a lopsided brain — all of one chat, none of the others — and the earliest arcs would be unrepresentative.
2. **Backfill walks backwards.** The adapter is asked for `backfill_order: "desc"`, and `watermarks.backfill_low_ts` moves **downward**. `live_high_ts` moves upward independently. The two never collide.
3. **An `asc`-only adapter is adapted, not accommodated.** The scheduler buffers its pages, holds them in a staging window, and emits descending cohorts once a page boundary is complete. The rest of the system never sees ascending order.
4. **Live always pre-empts.** A new event arriving mid-bootstrap creates a `live` cohort that jumps the queue at the next cohort boundary — never mid-cohort, so no partial work is discarded.
5. **Never rowid, never FIFO.** Backfilled history has higher rowids and older timestamps; insertion order is exactly the wrong order.

### 9.3 Stream tiers — what gets processed first

Recency alone is not enough. A promotional blast from an hour ago is worth less than a friend's message from last week. Every **stream** is assigned a tier once, by code, and the tier is the **primary** sort key.

```
 T1  ENGAGED      1:1 conversations with people, and groups where the user
                  has ever replied
 T2  TRANSACTIONAL businesses sending updates that matter — order confirmations,
                  bank alerts, appointment reminders, bookings, bills
 T3  PASSIVE      groups the user has never replied in
 T4  PROMOTIONAL  businesses sending marketing, offers, campaigns

 Exhaust a tier before starting the next.
```

**Tier assignment — code first, one cheap model call as fallback:**

```
 T1  is_group = false AND is_business = false
     OR  is_group = true AND the user has ≥1 message in that stream
 T3  is_group = true AND the user has 0 messages
 T2/T4  is_business = true → split by content:
        [CODE] heuristics first — order/booking/PNR ids, amounts, due dates,
               "your order|booking|appointment|statement|payment"  → T2
               "% off", "sale", "limited time", "unsubscribe", campaign
               formatting, no user-specific identifiers               → T4
        ambiguous → P-TI1, ONE haiku call PER CHANNEL (not per message),
               cached on the stream, re-run only if the channel's character
               changes
```

**How tier composes with the recency horizon:**

```
 priority = (tier_rank × 10^9) + (horizon_rank × 10^6) + recency

   T1 live → T1 h24 → T1 d7 → … → T1 older
   → T2 live → T2 h24 → …  → T3 …  → T4 …

 EXCEPTION — the live horizon pre-empts, for T1 and T2 only.
 A message arriving now from a person or a transactional sender jumps the
 queue at the next cohort boundary. T3 and T4 live messages join the normal
 tier order — a promotional blast must never interrupt a history import.
```

**Four rules that keep tiering honest:**

1. **Tiering delays scheduling only. It never decides whether output is kept.** A T4 marketing channel's *real* obligation — an actual bill with a real due date — is extracted in full, with the same prompts and the same care. It simply waits its turn. Filtering by tier would be code deciding what matters, which is a rule-1 violation.
2. **Tier is a property of the stream, computed once and stored** — never re-derived per event, never a per-message judgment.
3. **⚠ Promotion must never orphan events.** When a user replies in a group for the first time, that stream moves T3 → T1. In the prior system this exact transition **permanently lost 10 real scheduling messages in a 16-minute run**, because the events sat below the destination lane's watermark and became unreachable by every lane. The rule here: on any tier change, **re-enqueue the stream's unprocessed events at the new tier's priority, and never move a watermark backwards.** A tier change is a re-scan, not a hand-off.
4. **Tiering must actually run.** The prior build shipped this concept with `tier NULL` on all 97 channels, so lanes 2 and 4 sat permanently empty and 63 promotional events went through full extraction only to be labelled "promotional blast". Tier assignment is a boot-time backfill with a coverage assertion, not a lazy write.

### 9.4 The two lanes — fully independent, never blocking each other

```
  time ──►
  LANE E  [enrich C0][enrich C1][enrich C2][enrich C3][enrich C4] …
  LANE U  [underst C0][underst C1][underst C2][underst C3] …
          ▲
          └ U starts IMMEDIATELY on text. It never waits for E.
            E's results flow back later and update in place (§7.4).
```

1. **Lane E** (whisper, vision captions, frame sampling, scrape, embed) and **Lane U** (entity → segment → episode → arc → extract → derive) run concurrently with independent concurrency caps (§4.4.1).
2. **Lane U never waits for Lane E.** Text is understood the moment it lands, with unread attachments marked as explicit placeholders. This is the correction to the earlier "barrier" design: there is no waiting period and no threshold to tune.
3. **Lane E runs a lookahead anyway** (2 cohorts in bootstrap, 1 in steady) — not because U depends on it, but because it smooths the enrichment queue and means most attachments *are* readable by the time their cohort is understood, avoiding an update pass.
4. **Both lanes draw from the same LLM pool** (captions are LLM calls), split 40/60 so neither starves the other.
5. **Neither lane can stall the pipeline.** If E falls behind on video, U proceeds. If U is paused on quota, E keeps going and deepens the lookahead. **The only quiet state is a rate-limit pause, rendered with a countdown.**

### 9.5 The first-paint critical path

**Latency is driven by ACTUAL output tokens, not the max-output cap.** A 6,000-token budget on P-CL1 does not mean 6,000 tokens are generated. Confusing the two is how a latency target quietly becomes unreachable.

| Call | Max out | **Actual** output, cohort 0 (4 small sessions) |
|---|---|---|
| P-EP1 | 3,000 | ~15–30 wire lines ≈ **250–400 tok** |
| P-CL1 | 6,000 | summary + ~15 claims + ~5 loops ≈ **450–600 tok** |
| P-TR1 | 2,000 | ~6 lines ≈ **90 tok** |
| P-SP1 | 800 | ~5 lines ≈ **80 tok** |

Large calls **do** take 30–60 s — 3,000–4,000 output tokens at typical streaming rates. That happens on **later** cohorts (seq 3+, 24 sessions of dense group chat), and it is correct there. **Cohort 0 is latency-optimised; later cohorts are throughput-optimised.** That is what the adaptive ramp is for.

**STW-2 cuts latency, not just cost.** Output drops 40–60 %, and latency is roughly proportional to output tokens. The wire format buys more on this target than it does on the bill.

#### 9.5.1 One call on the critical path

Serial depth, not call count, is the constraint — the calls form a dependency chain and parallelism cannot flatten it. So the chain is cut to **one**:

```
 ON THE PATH          P-CL1 only
 DEFERRED, always     P-EP1  · P-TR1 · P-SP1 · media enrichment
 NEVER ON THE PATH    P-AG1 · P-AG2 · P-AG3   (rule, not cold-DB luck)
```

1. **P-EP1 deferred.** Structural binding already resolves conversation participants from stream metadata, so P-CL1 runs with a participants-only roster. A mention of an absent person becomes `-` plus a hint — which is the honest representation anyway — and resolves on the next delta pass.
2. **P-TR1 deferred.** Triage is code-derivable for first paint: `owner ≠ me → context`, `origin = implicit → approval`, otherwise `approval`. The model refines it later; the safe default is never `auto`.
3. **P-SP1 deferred.** Archetype is cosmetic. A space renders with a neutral default and refines within the minute.
4. **The three adjudicators are barred from the path by rule.** They are the multi-turn, serial, expensive calls. On a cold database they mostly would not fire anyway — no prior entities, arcs or claims to compare against — but that is luck, and the guarantee must not rest on it.

#### 9.5.2 Stream to the surface, line by line

**Every `\n` in STW-2 is a complete, independently parseable record**, so claims render *as they stream* rather than after the call returns. JSON cannot do this — you need the closing brace. This is the single largest latency win, and it exists only because the format is line-oriented.

```
  JSON     [────────── 12 s ──────────]▮ first claim visible at 12 s
  STW-2    [─ 2 s ─]▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮  first claim visible at ~2–3 s,
                                        the rest arriving continuously
```

#### 9.5.3 Four more guarantees

1. **Reserve the pool.** During first paint, Lane E gets **zero** LLM slots — not 40 %. Text-first means captions are not needed for first output. Normal 40/60 split resumes once first paint completes.
2. **Size cohort 0 by expected output tokens, not session count.** Budget ~600 output tokens, estimated from event count × character density. Four sessions of a noisy group produce several times the output of four quiet DMs; session count is the wrong axis.
3. **Pre-warm the CLI.** Spawn one child at connect time so binary resolution and process start are paid before the clock starts. Five cold spawns at 1–2 s each is real money against a 120 s budget.
4. **Instrument TTFT and tokens/sec per model per call type**, and gate on per-call latency, not only end-to-end. Every figure in this section needs measurement; a regression should surface at the call that caused it, not as a mysterious end-to-end failure.

#### 9.5.4 The budget

```
  t=0–10    adapter first page (T1 streams first) · ingest ·
            structural binding · metadata edges                    [CODE]
  t=10–14   cohort 0 sealed — immediate, no debounce               [CODE]
  t=14–16   P-CL1 dispatched to a pre-warmed child
  t≈18      ★ FIRST CLAIM RENDERS — streamed, line by line
  t=18–30   remaining claims and loops stream in continuously
  t=30–34   code facts · write path · promotion routes             [CODE]
  t≈35      ★ SPACES AND TASKS VISIBLE
  t=35+     deferred work begins: P-EP1 mentions · P-TR1 triage ·
            P-SP1 archetypes · enrichment resumes · cohort 1 starts
```

**~35 s against a 120 s gate — roughly 3.5× margin**, where the previous five-call chain left barely 2×.

1. **The 120 s target is a CI gate**, measured on the reference corpus, not an aspiration.
2. **If a cohort would miss it**, the scheduler shrinks the output-token budget. It never skips stages, never downgrades the model, and never emits provisional objects it will retract.
3. **Nothing waits for the whole import.** Coverage after first paint reads honestly: "the last few hours understood; older data in progress."

### 9.6 Media never blocks text — the update-in-place path

**There is no barrier and no waiting period.** An image, voice note or video must be understood **inside its own session, with its own neighbours** — but text around it must not wait for that to happen. Both are satisfied by understanding text now and letting enrichment update the same chunk later. Full mechanism in §7.4; the scheduler's obligations are:

1. **Enrichment priority = cohort priority.** The media queue is priority-ordered on the same key as understanding, so a photo sent an hour ago is captioned before a photo from 2023. **A FIFO media queue is the single easiest way to break the 120 s target.**
2. **Captions are LLM work, not background CPU.** Image and video-frame descriptions run on haiku through the same CLI pool and the same rate limit as extraction (§4.4.1) — a bootstrap with 2,000 photos is a serious LLM workload, and the 40/60 pool split is what keeps it from starving understanding.
3. **Images are batched 16 per call** (§9.1), not one per call. 2,000 photos become ~125 calls, not 2,000.
4. **Pass 2 fires once per episode, when all of its enrichment has resolved** (§7.4). The scheduler tracks `sessions.pending_enrichment_count` and enqueues the complete pass at high priority the moment it reaches zero.
5. **The hash gate makes updates free when nothing changed.** A re-sync delivering identical content produces an identical `content_hash` and is skipped entirely.
6. **Bounded at `reprocess_max` (default 3) per episode.** Beyond that the enrichment is stored, searchable and attached for provenance; the episode is flagged for nightly reconcile instead.
7. **Placeholders are explicit in every prompt** — an unread attachment is UNKNOWN content, never absent content, never an acknowledgement.

### 9.7 Pacing, stalls and progress

1. **The pipeline is never idle while work exists.** The only quiet states are: all cohorts `done`, or a lane `paused` on quota/auth with a countdown.
2. **Bootstrap is paced against the quota window.** The scheduler estimates `billableTokens` per cohort and throttles cohort admission so a large import degrades to *slower*, never to *failed*. Pacing is visible: "understanding the last 90 days — ~40 min remaining at current rate".
3. **Progress is monotonic and legible.** `coverage` is written per `(scope, horizon)` on every cohort transition. Surfaces render it (§13). *A healthy mid-run system that looks like a silent failure is itself a shipped defect.*
4. **Questions are batched during bootstrap** and released at horizon boundaries. Two hundred identity popups during an import is a worse failure than a slow import.
5. **Interruption is safe.** Cohorts and `work_queue` live in the DB. On restart, in-flight cohorts resume from their last completed stage; nothing is re-judged that already has a verdict.

---

## 10. Layers L1–L3 — enrichment, entities, sessions

### 10.1 Enrichment — executor map

Vision runs on a **small hosted LLM via the CLI**, not on-device ML. V11 has this built.

| Input | Step | Executor | Engine · batching |
|---|---|---|---|
| image / sticker | caption | **[LLM-S]** | haiku-4-5 via CLI · **16 images per call** (configurable 1–32) |
| video | frame sampling | [CODE] | ffmpeg · downscale to ≤1092 px longest edge |
| video frames | caption | **[LLM-S]** | one call per video (all its frames); short videos may share a call up to the image cap |
| voice / audio | transcription | [ML] | whisper.cpp Metal, large-v3-turbo-q5 |
| link | scrape + og fill | [CODE] | fetch |
| YouTube link | captions | [CODE] | yt-dlp |
| any text | embedding | [ML] | e5-small int8 |
| screen frame (ambient) | dedupe | [ML]/[CODE] | phash + a11y-tree diff |
| ambient audio | speech gate | [ML] | VAD — silence never reaches disk |
| screen frame (salient) | caption/read | **[LLM-S]** | haiku-4-5, only frames surviving prefilter |

**Enrichment is a cost centre — gate it.** Low-salience ambient runs get zero LLM calls. V11's crash-safe queue semantics (verdict-only state transitions, growing backoff, rate throttle) are kept and extended with the priority key from §8.5.

**Image batching discipline — 16 per call, with mismatch protection:**

1. **Default batch 16, range 1–32** (`enrichment.image_batch_size`). At ~1,100–1,600 vision tokens per downscaled image, 16 images ≈ 20–26 k input tokens — a large but comfortable call, and it turns 2,000 photos into ~125 calls instead of 2,000.
2. **Downscale before sending.** Longest edge ≤1092 px. Beyond that you pay more tokens for no additional caption quality.
3. **Every image carries an explicit id in the prompt, and the model must echo it back.** The response is rejected unless the returned id set matches the sent id set **exactly**.
4. **On mismatch, split the batch in half and retry** (binary degradation), recursing until the halves pass or reach size 1. This replaces V11's straight drop-to-solo, which turned one bad batch into 16 calls.
5. **Never let a caption attach to the wrong image.** A mismatched batch is discarded and re-run, never partially applied — a caption on the wrong photo silently corrupts a claim.
6. **Stickers and images are both read by default** (`enrichment.read_all_media = on`).

### 10.2 Salience prefilter — the ambient problem

```
 RAW AMBIENT                                                  10⁴–10⁶ /day
   │  ① CAPTURE-TIME THRESHOLD                    [CODE]
   │     screen: sample on a11y-tree change or app switch, never a timer
   │     audio : VAD gates the recorder; silence is never written
   ▼
   │  ② PERCEPTUAL DEDUPE                         [ML]         −90%
   ▼
   │  ③ SALIENCE SCORE                            [CODE]+[ML]
   │     text density · app category · user input present · known entity
   │     present · novelty vs last N minutes → events.salience
   ▼
   │  ④ SEGMENT ONLY ABOVE THRESHOLD              [CODE]
   │     low-salience runs collapse to ONE coarse session, never N
   ▼
   │  ⑤ ENRICH ONLY WHAT SURVIVES         [ML]/[LLM-S]         10¹–10² /day
```

1. **Discard at capture, not after storage.** Raw audio is never persisted after it becomes text.
2. **A low-salience run is one coarse session** ("browsing, ~40m").
3. **Ambient never binds to an arc on similarity alone** — only via bridge or entity overlap.
4. **Ambient sources bootstrap in their own horizon ladder** and are admitted last within each horizon, so a screen-recording backlog can never delay a friend's messages.
5. **Ambient is off by default**, with a visible recording indicator and a "forget this hour / app / person" gesture that really deletes and cascades.

### 10.3 The entity graph

**16 entity types — closed set. Anything that fits nowhere becomes `topic`.**

| # | Type | Subtypes | Example |
|---|---|---|---|
| 1 | `person` | — | Pranjali, Dr. Shreedhar, "the broker" (hint until resolved) |
| 2 | `group` | family, friends, work, community, event | "Ghar+" WhatsApp group |
| 3 | `org` | company, hospital, clinic, school, government, vendor, restaurant_chain | Hotstar, Policybazaar |
| 4 | `place` | city, area, venue, restaurant, home, office, address | Indiranagar, Pizza 4P's |
| 5 | `product` | physical, digital | M2 MacBook, air fryer |
| 6 | `service` | subscription, plan, policy, utility, membership | Superhuman, broadband plan |
| 7 | `media_work` | film, show, song, album, video, book, article, podcast, game | a YouTube video |
| 8 | `document` | doc, sheet, slide, note, pdf, form | rent agreement PDF |
| 9 | `app_site` | app, website | Zomato, booking.com |
| 10 | `occasion` | birthday, wedding, trip, festival, party, appointment, meeting | Goa trip |
| 11 | `topic` | — | local LLM performance, bhangra |
| 12 | `pet` | dog, cat, other | a friend's Rottweiler |
| 13 | `vehicle` | car, bike, other | — |
| 14 | `account` | bank, wallet, utility, membership_id | HDFC account (referenced, no numbers) |
| 15 | `health_item` | condition, medication, treatment, procedure | rabies vaccination |
| 16 | `food_item` | dish, cuisine, recipe | chole bhature |

**16 edge kinds — closed set, structural relations only.** Opinions and preferences are *claims*, not edges.

| Kind | Subtypes | Direction | Origin |
|---|---|---|---|
| `family_of` | mother, father, sibling, spouse, child, grandparent, cousin, in_law, aunt_uncle, niece_nephew | src is subtype of dst | text [LLM-S] |
| `social_of` | friend, roommate, neighbor, acquaintance | symmetric | text [LLM-S] |
| `works_with` | colleague, manager, report, cofounder, client | src role toward dst | text [LLM-S] |
| `works_at` | employee, founder, contractor | person → org | text [LLM-S] |
| `provides_care` | doctor, therapist, trainer, cook, domestic_help | provider → person | text [LLM-S] |
| `member_of` | — | person → group | **metadata [CODE] conf 1.0** |
| `owns` | — | person → product/vehicle/pet/account | text [LLM-S] |
| `pet_of` | — | pet → person | text [LLM-S] |
| `subscribes_to` | — | person → service | text / commerce |
| `lives_at` | current, past | person → place | text [LLM-S] |
| `located_in` | — | place→place, org→place | metadata / text |
| `part_of` | — | place/org/group hierarchies | metadata / text |
| `created` | — | person → document/media_work | **file metadata [CODE]** |
| `provides` | — | org → product/service | text / commerce |
| `about` | — | document/media_work/occasion → any | text [LLM-S] |
| `participant_in` | organizer, attendee, guest_of_honor | person → occasion | **calendar [CODE]** / text |

1. **Metadata edges are free and exact** — extract them **before any model runs**. During bootstrap this means a usable relationship graph exists within seconds.
2. **Text edges require a verbatim quote.**
3. **Edges are bitemporal-lite.** A move ends one `lives_at` (`valid_to`, `status: superseded`) and opens another. Both survive.
4. **Minted ids, always.** `ent_` + random. Renames and merges never change an id.

**Two binding paths:**

```
 ① STRUCTURAL BINDING                              [CODE]  high confidence
    metadata identity: whatsapp sender jid · gmail From: · calendar attendee
    · slack user id · order account · device id
    exact match → bind · no match → mint provisional entity + identity

 ② TEXTUAL MENTION LINKING                  [ML] → [LLM-S]  lower confidence
    a name inside text → candidates [ML] → disambiguate [LLM-S] (P-EP1)
    still ambiguous → entity_id NULL + entity_hint + a question
```

**Resolution ladder — escalate, never guess:**

```
   new identity or proposed entity
        ├─ exact (source_id, kind, value_norm) ──────────► BIND     [CODE]
        ├─ cross-source exact (phone/email norm) ────────► BIND     [CODE]
        ├─ candidates: embedding + alias + string dist ──► score    [ML]
        │     calibrated ≥ high bar ─────────────────────► BIND
        │     in band ───────────────────────────────────► P-AG1    [AGENT]
        └─ still torn ───────────────────────────────────► ASK USER
   INVARIANT: zero silent guesses. Every bind records decided_by + confidence.
```

1. **Handle strings never bind cross-source.** `@rahul` on Slack and `@rahul` on X are different identities. Only normalised **phone** and **email** bind at `[CODE]`.
2. **Merges are tombstones** — `merged_into` redirect, O(1), reversible; refs re-point lazily, compacted at reconcile.
3. **Negative pairs are permanent.**
4. **The "me" entity** is created at install; every manifest's `self_identity` binds into it; `events.is_self` is derived by code.
5. **Creation discipline:** `person`/`group`/`org` mint freely from structural identity. Other types mint only from text with ≥1 quote and pass the near-duplicate check. A `topic` needs its surface form ≥2× in the session. Model-created entities stay `provisional` until a second evidence event or a user touch; provisional + single-evidence + 30 days → auto-archive.
6. **During bootstrap, entity resolution runs continuously but adjudication is batched.** Exact and cross-source binds apply immediately; in-band pairs accumulate and are adjudicated at horizon boundaries, so P-AG1 does not serialise the import.

**Embedder calibration — a prerequisite, not an optimisation:**

1. The shipped embedder (`multilingual-e5-small`) has an **unrelated-pair cosine floor of ~0.75–0.85, not ~0**. An absolute `0.85` bar sits inside its noise band; in a prior run **50 of 54 comparisons collapsed to "same"** and 30 of 62 claims were folded across topics.
2. At startup, measure the floor from ≥1,000 random unrelated pairs; normalise `score = (cos − floor) / (1 − floor)`; persist per `(model, use_case)`.
3. Independent thresholds per use-case: `entity_name`, `entity_rich_text`, `episode_topic`, `arc_topic`, `claim_text`, `loop_intent`. The `arc_topic` bar is strictly higher than `episode_topic`.
4. **Never compare bare short strings.** Embed rich text: name + aliases + co-occurring entities + a quote.
5. **Stale calibration blocks the similarity rungs.** On a cold install, calibration runs on the first cohort's embeddings and is refined as the corpus grows; until it exists, pairs route to the agent or the queue rather than to a guessed threshold.

### 10.4 Sessions — mechanical, code only

**Per stream-kind policy. Cut when ANY trigger fires.**

```
 CONVERSATION   gap > G                 default 6h (1:1), 4h (group), per-stream
                participant shift       multi_actor only, AND gap ≥ shift_min_gap
                                        (default 1h) — a conjunction
                reply-chain break       a reply targeting an event > G older
                                        starts a NEW session; old stays sealed
                size cap                40 events or 6,000 tokens
                local midnight          in the STREAM's tz

 DOCUMENT       revision gap > 45m ∪ author shift ∪ 200-revision cap
 ACTIVITY       gap > 30m ∪ context shift (registrable domain / app id /
                commerce vertical) ∪ 100-event cap
                ⚠ kind=order ALWAYS seals as its own single-event session
 AMBIENT        after prefilter: context shift (app · speaker · scene ·
                silence > 90s) ∪ 10-min cap ∪ 15-min ceiling
 BOUNDED        session = the record. Caps do NOT apply.
```

**Sealing — two modes, one segmenter:**

```
 BOOTSTRAP (history complete)                          seal_mode = immediate
   the next event in the stream is already known
   → apply the boundary rule and SEAL AT ONCE
   → exception: the newest session of each stream stays open and is
     handed to steady-state rules

 STEADY (live)                                         seal_mode = debounce
   event arrives → open or append → reset debounce (default 45 min)
   NOTE sealing is INDEPENDENT of understanding: the live trigger (§7.3)
        extracts every ~30 s while the session is still open
   seal on: debounce expiry ∪ any boundary trigger ∪ 24h ceiling
                                                       seal_mode = ceiling

 BOTH: on seal → content_hash = sha256(sorted external_ids + text hashes,
       INCLUDING enrichment text) · immutable membership ·
       boundary_reason + measured params recorded
       → HASH GATE: already understood at this hash? downstream skips.
```

1. **Backfill and live share one segmenter**, ordered by `ts` — never insertion order or rowid.
2. **Reactions** attach to the parent event's session even if sealed. They never open a session and **never reset the debounce** — a 👍 seven hours later is not a conversation.
3. **Edits** in an open session mutate in place. Edits after seal are stored, attach to the parent for provenance, and set `superseded_hash` → high-priority reprocess (same mechanism as late enrichment, §8.5). **Membership never changes.**
4. **Revokes** mark the event revoked; membership unchanged; `superseded_hash` set.
5. **Read receipts and delivery events are not events.** Dropped at the adapter.
6. **Timezones:** every event stores `tz`; day-boundary cuts compute midnight in the **stream's** tz.
7. **Restart safety:** open sessions and cohorts live in the DB. On boot, debounce timers recompute from each open session's last event `ts`; anything past its window seals immediately; in-flight cohorts resume at their last completed stage.
8. **Late arrivals:** an event whose `ts` falls inside an already-sealed session's range forms a **new** session flagged `late_arrival` with `overlap_of`. **Sealed sessions are never reopened.**
9. **Clock skew:** `ts > now + 5 min` is clamped and flagged.

---

## 11. Layers L4–L8 — episodes, threads, claims, spaces

### 11.1 Episodes — topical, stream-scoped

```
 session S (sealed, or open and hit by the live trigger)
   ├─ hash gate: verdict exists for S.content_hash? → reuse, done   [CODE]
   ├─ PRE-FLAG: intra-session embedding drift                       [ML]
   │    no drift AND no open episodes in stream
   │        └─► DEFAULT: episode := session (1:1). NO MODEL CALL.   [CODE]
   └─ else P-EP2                                                    [LLM-M]
        input : S + open episodes of the SAME stream (≤10)
        output: segments[] → attach(episode_id) | new(topic_label)
        verdict persisted
```

1. **Split:** segments **partition** the session's events — every event id in exactly one segment.
2. **Attach:** only to **open** episodes in the **same stream**.
3. **Topic matching is always stream-scoped.** Candidate sets stay at 5–10 real items. Cross-stream joining is an arc.
4. **Batch for cost, never for semantics** — each session is its own prompt item.
5. **Aging:** open episode quiet 14 days → `closed/faded` [CODE]. A topic returning later is a **new** episode bound to the same arc.
6. **Confidence < 0.6 on an attach → prefer new.** A wrong merge destroys; a wrong split is repairable by reconcile.
7. **In bootstrap, "open episodes" means open *within the horizon processed so far*.** Because processing is newest-first, an older session may later attach to an episode created from newer data — that is correct and expected; reconcile keeps ids stable.

### 11.2 Arcs — cross-time, cross-source

**Bridge extraction — `[CODE]`, at ingest/enrich time:**

| Bridge kind | Fires when | Normalisation |
|---|---|---|
| `url` | same canonical URL in two places | strip tracking params, resolve shortlinks, lowercase host |
| `order_id` | order/booking/PNR ref in two places | vendor-prefixed exact string |
| `file_id` | same Drive/Docs file | provider file id |
| `attendee_set` | calendar attendees ≈ chat participants (Jaccard ≥ 0.6) | sorted entity-id set |
| `phone` / `email` | same identity entity referenced | normalised value |
| `media_work_id` | same media_work entity | entity id |
| `geo_time` | two location-stamped events within 200 m ∧ 45 min | geohash6 + time bucket |

**Binding ladder:**

```
 ① BRIDGES                                            [CODE]  precision ~1.0
 ② ENTITY OVERLAP  weighted Jaccard ≥ 0.5             [CODE]
    weights: person/place/occasion 1.0 · product/service/media 0.7 · topic 0.4
 ③ TOPIC SIMILARITY  calibrated, bar HIGHER than episode attach   [ML]
 ④ ADJUDICATION  P-AG2 → join | new | unsure→ASK USER            [LLM-M]

 ambient episodes join ONLY via ① or ②
 new arcs stay PROVISIONAL until reconcile
```

**Two-phase commit + reconcile — `[CODE]`:**

```
 continuous: new arcs are PROVISIONAL (no id, no surface)
 at EVERY COHORT BOUNDARY (bootstrap) and NIGHTLY (both modes):
   ① compare provisional ↔ provisional AND ↔ committed
      (duplicates die the moment they are comparable — a sequential pass
       can never provide this, and bootstrap's parallelism makes it acute)
   ② arc_key = sha1(sorted(top-3 anchor_entity_ids) │ normalize(label_stem))
      → rebind to the same id or mint
   ③ aging: quiet 3w → dormant · quiet 12w → archived
   ④ user constraints (pin/move/split) are HARD WALLS
   ⑤ compact merged-entity redirects into anchor sets
   ⑥ every change → mutations rows, undoable as one run
```

**Arc-id stability is the point of `arc_key`.** As older cohorts land and arcs grow, re-derivation rebinds to the same ids, so labels, pins, spaces and user corrections survive the entire import.

### 11.3 Claims, loops, spaces, tasks

**Claim — a descriptive statement about an entity**

1. **Extracted unconditionally.** All of history welcome.
2. `kind` ∈ `fact · belief · preference · opinion · interest · recommendation · habit · workflow`.
3. **`subject_id` is a roster entity id**, or NULL + `subject_hint`. **Unknown beats wrong.**
4. **`speaker_id` is written by CODE** from the event actor.
5. **`attribution`** ∈ `first_person · about_other · reported_speech · quoted_third_party` — one enum, three bug classes killed.
6. **Stored in resolved third person.**
7. **Three time fields, never conflated.** `stated_at` = when it was said (the event ts) and is the **only** basis for precedence; `valid_from`/`valid_to` = when the fact was true of the world; `ingested_at` = when the row was written, for audit only. Mandatory: a Gmail backfill of 2019 arriving in 2026 is otherwise unrepresentable — and in a newest-first import, *most* claims arrive out of chronological order by design.
8. **Claims attach to entities, never to spaces.**

**Loop — an intent with an unresolved end state**

1. Requires **BOTH** intent AND an unresolved end state.
2. **The test:** evidence of intent → loop. Evidence of state → claim. Both, always, from the same episode.
3. `origin` ∈ `explicit · implicit` — **different products** (§10.5).
4. `state` ∈ `open · latent · done · lapsed · dropped`, **code-derived** (§10.4).
5. **Latent ≠ hypothetical.**
6. **Four generators:** explicit commitment with an open end · **a fact with a temporal boundary** (lease, passport, warranty, renewal, subscription, appointment — *currently captured: zero; largest untapped value*) · recurring obligation · user-declared.
7. **Newest-first import matters here.** A loop found in 2024 history is usually already resolved; the code-facts pass (§10.4) marks it `lapsed` or `done` from later evidence that has *already been processed*, because newer data came first. Processing oldest-first would have surfaced hundreds of stale open tasks.

**Space — an arc that holds a live loop**

```
 PROMOTION — an arc becomes a space if ANY route qualifies.   [CODE]
 promotion_reason is recorded, so "why is this a space?" always answers.

  ⚑ cmt COMMITMENT  holds ≥1 loop in state open
  ⚓ ref REFERENCE   anchored on a durable entity you have a has/located_at
                    relation to  →  "my flat", "my car", "my ACT connection"
  ↻ rec RECURRENCE  ≥3 episodes · ≥3 distinct days · spanning ≥2 weeks ·
                    user participated                    (cap ~10 live)
  📌 usr USER        explicitly pinned

 STATUS — derived from member loops, every reconcile.          [CODE]
   ≥1 open loop            → active
   only latent loops       → dormant
   all done/lapsed/dropped → archived (retrievable, not surfaced)
   promoted by ref/rec with no loops at all → active while evidence is fresh,
     dormant after 8 weeks quiet

 NOT PROMOTED → stays a browsable thread. Nothing is lost, nothing is deleted.
 Demotion is the same field flipping back — the id never changes.

 ⚠ PARTY RULE  a thread whose loops carry no `s` in either position of
   party_pair is NOT your space. It is context on that person, and it belongs
   on their People record. This is the code rule that kills the prior
   system's "8 spaces that were really other people's lives".
```

1. **A space is not a separate object.** One `arcs` table; `promoted` is a derived field. "Space" is the product's word for `arc WHERE promoted`. No second clustering pass, no id sync, no create/delete on promotion.
2. **`status` derived on every reconcile.**
3. **`ends_at`** (nullable) replaces duration + permanence.
4. **`cadence`** ∈ `one_time · recurring`.
5. **`archetype`** ∈ **8 fixed shapes** — multi-route promotion produces shapes the original five could not carry. A reference-route thread ("my flat") is not a project; a recurrence-route thread ("cooking experiments") is not a rhythm.

| Archetype | Icon | Accent | Shape of the thing | Typical route |
|---|---|---|---|---|
| `project` | 🎯 | indigo | an outcome with a span and many steps | commitment |
| `event` | 📅 | amber | a single point in time approaching | commitment |
| `rhythm` | 🔁 | green | a recurring **commitment** to others | commitment · recurrence |
| `admin` | 🧾 | slate | a recurring external duty with a ledger | commitment · reference |
| `holding` | 📦 | stone | a durable thing you own or inhabit | **reference** |
| `matter` | 🌀 | rose | an unresolved situation with no fixed end | commitment |
| `pursuit` | 🌱 | lime | a self-directed recurring activity you **do** | **recurrence** |
| `watch` | 👁 | teal | a topic you **follow** without doing | recurrence · user |

**Interests and hobbies live in `pursuit` and `watch`, split by one question: do you act, or do you observe?**

- **You act → `pursuit`.** Cooking experiments, running, learning guitar, reading, photography, a side project. There is recurring *activity by you*, with no obligation to anyone.
- **You observe → `watch`.** Following AI research, tracking a stock, monitoring a neighbourhood, keeping an eye on a product's price. Evidence accumulates; you produce none.
- **The tell:** if the evidence is mostly *your own* events, it is a pursuit. If it is mostly things arriving *at* you, it is a watch.
- An interest that grows an obligation stops being either — "learning guitar" becomes a `project` the moment there is a recital date. Archetype is revisable, and the transition is recorded with a reason.

Chosen by the model from this closed set. Non-determinism must never reach the interface layer.
6. **No mandatory goals.** Mandating one produced 3 tautologies across 23 spaces and zero milestones. Goals emerge (§10.6) or are user-stated.
7. **Early spaces are legitimately thin and grow.** A space created from cohort 0 may hold one loop and one episode; as older cohorts land it accretes. `arc_key` stability means it grows *in place* rather than being replaced.

**Task — a view over loops**

1. **`task = loop WHERE owner_id == me AND state ∈ {open, latent}`.** A query, not a stored duplicate.
2. Loops owned by others surface on that **person**, never in the task list.
3. `explicit` and `implicit` render as **separate lists**.

**The containment rule, stated once:**

```
                      ┌──────────────────────────────────┐
    every EPISODE ───►│   ONE understanding call (P-CL1) │
                      └────────┬──────────────┬──────────┘
                       always  ▼              ▼  only if intent
                            CLAIMS          LOOPS       + unresolved end
                               │              ├─ owner == me ──► TASK (view)
                               │              └─ owner != me ──► person context
                     attach to ▼              ▼ episode → ARC
                          ENTITIES                  │
                                                    ▼
                                     arc holds a live loop → SPACE
```

### 11.4 Code facts and loop state

**Loop state is a function of the END STATE, never of the age of the evidence.**

```
 STATE FUNCTION — recomputed whenever due, recurrence or evidence changes [CODE]

   resolution evidence exists            → done
   user gesture                          → done | dropped
   due_utc in the FUTURE                 → open          ← however old the
                                                            evidence is
   due_utc in the PAST + recurrence      → project next_occurrence_utc
                                             future?     → open
                                             none left?  → lapsed
   due_utc in the PAST, no recurrence,
     no resolving evidence               → lapsed        (history, not a task)
   no due, intent stated, reinforced
     within N weeks                      → open
   no due, intent stated, not reinforced → latent        (ages out)

 ALSO AT CREATION                                                       [CODE]
   owner ≠ me AND cpty ≠ me       → triage = context (not a task)
   attribution=first_person AND
     subject_id ≠ speaker_id      → downgrade to about_other + flag
   speaker_id                     → from events.actor_entity_id
   stated_at                      → from the event ts (never ingest time)
   horizon                        → computed from due − now
```

1. **Age is never a rule.** An insurance policy noticed a year ago has `recurrence: annual`; its next occurrence is in the future, so it is `open` and a live task. "I'll book the tickets tonight" from 2024 has a past due and no recurrence, so it is `lapsed`. The discriminator is the end state, not when it was said.
2. **Temporal-boundary loops are the highest-value thing in old data** — renewals, expiries, warranties, policies, leases, passports, subscriptions, AMCs. The prior corpus captured **zero**. Extract them aggressively from *all* history; the state function keeps the dead ones out of the task list by itself.
3. **`possibly_done` is not a state.** The prior system accumulated 27 tasks in that limbo. Evidence or a one-tap question. It never parks.
4. **A `done` loop leaves every surface immediately** — but it is **extracted and retained**, never skipped. It is a member of its arc, part of its space's history, and evidence about follow-through. Since tasks are a view over `state ∈ {open, latent}`, a done loop simply never appears there: you see "compare flights ✓ done 12 Aug" inside the Goa trip space, and nothing in Tasks.
5. **Done-detection is usually free.** Because newer data is processed first, a loop found in older history is checked against resolving evidence **already in the DB** — a `[CODE]` lookup before any P-DD1 call. Most historical loops resolve with no model call at all.

### 11.5 Explicit vs implicit — different products

1. **Two separate lists with different verbs**, never interleaved.
2. **Implicit is always `approval` or `context`. Never `auto`.**
3. Tune implicit for **precision over recall**.
4. **Rejecting an implicit loop writes a claim** (`kind: preference`, subject `me`, `decided_by: user`) that enters every future roster block. Rejection teaches.
5. **No blanket approval queue.** Approval attaches to a *class of action*, never to understanding. The prior system had 0 of 81 approved with 49 waiting because everything went into one undifferentiated queue.
6. **Claims are never age-filtered.** Recommendations, opinions, interests, preferences, habits and facts from any point in history are extracted in full. Old data is where most of a person's stable profile lives.
7. **The only age-sensitive rule that survives:** an **implicit** loop with no due date and no recurrence, from evidence older than ~30 days and never reinforced, defaults to `latent` rather than `open` — present in the graph, absent from the task list, and promotable the moment newer evidence reinforces it. Explicit commitments and temporal-boundary loops are never treated this way.

### 11.6 Write path, adjudication, goals

```
   incoming CLAIM
        │  claim_key = sha1(kind │ subject_id │ normalize(predicate))
        ├── exact key hit ─────────► REINFORCE  (union evidence, max confidence)
        │                            also how habit/workflow claims graduate —
        │                            no MIN_EVIDENCE constant, no code judging
        ├── near hit ──────────────► P-AG3                      [LLM-M]
        │                              duplicate     → reinforce
        │                              refinement    → supersede
        │                              contradiction → supersede + valid_to
        │                              distinct      → insert
        │                              unsure        → insert + QUESTION
        └── else ──────────────────► INSERT
```

1. **`loop_key = sha1(owner_id │ counterparty_id │ normalize(intent))`.**
2. **`loop_key` must NOT contain `space_id` or `arc_id`** — spaces derive *from* loops; keying a loop on its space is circular.
3. **Nothing is deleted.** Every version of a `claim_key` is retained in `claim_versions` with its `stated_at` and validity window.
4. **Zero model output is discarded by code.** A duplicate becomes evidence.
5. **Precedence is keyed on `stated_at` — when it was said — never on write order or ingest time.** Writing first must not mean winning. `active` is a **derived view** over the version set (§9.2): the version with the greatest `stated_at` that is not closed. An older claim arriving late (backfill, a new source, a delayed sync) lands as a **predecessor with a closed window** and cannot dislodge the current truth; a genuinely newer one takes over automatically.
6. **This yields arrival-order independence (confluence):** the final graph is identical whether Gmail was connected before or after WhatsApp, and whether a failed sync landed today or last month. It is the invariant that makes "nothing is final" safe.
7. **Derived state is recomputed, not appended.** When new evidence touches a `claim_key`, an entity, a loop or an arc, the affected derived values — `claims_active`, loop `state`, `spaces.status`, arc membership — are recomputed from the evidence set. Cheap, because it is all `[CODE]`.
8. **Goal emergence [CODE], never scaffolded:** when 2–3 loops across ≥2 spaces share ≥2 anchor entities and a horizon, propose a **life project** linking those spaces. Goals live **above** spaces, many-to-one.
9. **Every write emits a `mutations` row.**

### 11.7 Claims as query-time context

1. **Claims never store a space link.** Relevance is computed at read time: `subject_id ∈ space.anchor_entities ∪ calibrated_similarity(claim, space topic) top-K`.
2. **Weight preferences and constraints above facts** when context is for *doing* rather than *recalling*.
3. **One exception is stored:** user-pinned claims.

---

## 12. Prompts

All calls use the bare-call contract (§4.1) and **STW-2 in both directions** (§5). Every prompt is passed twice — as `--append-system-prompt` and as the head of stdin. Schema-validated, one repair round, then quarantine.

**Every system prompt opens with the same shared legend**, which is the stable cacheable prefix:

```
SHARED LEGEND (identical in every call — never varies)

Input you will read:
  #R  roster — the ONLY entity aliases you may cite. a<n>=Name, [type] if not a person
  #C  stream: alias, name, kind (grp/dm/biz), participants
  #E  open episodes for this stream · #T open loops · #D date + timezone
  <n> <time> <who> <text>   one event; "+m" = m minutes after the line above;
                            "^n" = a reply to event n
  #COV expected event count per stream
  Event numbers are base 36 above 35 (a=10 … z=35, 10=36). "c-f" is INCLUSIVE.

How you must answer:
  STW-2 lines ONLY. One statement per line, first character a tag.
  No prose, no headings, no bullets, no code fences, no JSON.
  Fields separated by "|". The LAST field may contain "|" and is kept whole.
  "-" or an empty field means NOT STATED. Never invent to fill a slot.
  An empty confidence field means 0.9 — write a number only to mean otherwise.
  Cite ONLY aliases present in the input. Never invent an alias.
  COMPRESS STRUCTURE, NEVER LANGUAGE: claim text, loop intents and quotes are
  your own words and are stored verbatim.
```

---

### 12.1 P-EP1 — Entity pass — `[LLM-M]` sonnet-5

**SYSTEM** (after the shared legend)
```
You are the entity linker for a private personal-memory system.

TASKS
1. MENTIONS — every textual reference to a person, group, org, place, thing,
   media work, document, occasion or topic. Link each to a roster alias.
2. NEW ENTITIES — propose anything clearly referred to but absent from the
   roster. Mint k1, k2 … yourself; every k you cite needs its own N line.
3. EDGES — durable structural relations only. Every edge REQUIRES a quote.

RULES
- Unsure between two roster entries, or the referent is unclear? Emit the
  mention with "-" as the target and a hint. UNKNOWN BEATS WRONG.
- Resolve pronouns only within this stream block and only when unambiguous.
- Speaker identity is given per event. Never infer or contradict it.
- "[voice note, transcription pending]" and "[image, description pending]"
  are UNKNOWN content. Extract nothing from them. They are not empty
  messages and not acknowledgements.
- Do NOT emit edges for opinions, preferences, feelings or one-off actions.
  Those are claims, and another pass handles them.
- Propose a topic only if its surface form occurs 2+ times or matches the roster.

OUTPUT
  M | <ev> | <surface text> | <a-alias | k-alias | -> | <conf> [| <hint>]
  N | <k-alias> | <Name> | <type> [| <subtype>]
  L | <ev> | <src> | <edge> | <subtype> | <dst> | <conf> | <quote>
  Q | <about> | <question>
Values: type = per|grp|org|plc|thg|med|doc|occ|top
        edge = rel|aff|has|loc|prt|par|abt
```

**USER**
```
#R a1=Rahul Arora | a2=Pranjali Sachdeva | a3=Indiranagar [plc] | a4=Ghar+ [grp]
#C c1 Ghar+ | grp | self,a1,a2
#D 2026-08-11 Tue | Asia/Kolkata
1 19:04 a1 shifting to Indiranagar next month, the broker found a 2BHK near the metro
2 +2   self nice, congrats
3 +5   a1 [voice note, transcription pending]
#COV c1=3
```

**EXPECTED**
```
M|1|Indiranagar|a3|0.95
M|1|the broker|-|0.9|Rahul's broker, unnamed
L|1|a1|loc|current|a3|0.7|shifting to Indiranagar next month
```

```
NOTES
- event 2 produced nothing — acknowledgements carry no entities
- event 3 produced nothing — a pending placeholder is unknown, never guessed
- no `aff` edge for Ghar+ membership: group participant lists are [CODE],
  confidence 1.0, extracted before any model runs
```

**Settings:** sonnet-5 · plain · 1 turn · tools none · thinking off · 120 s · ≤6 sessions or 8k in · 3,000 max out.

---

### 12.2 P-AG1 — Identity resolver — `[AGENT]` sonnet-5, tooled

**SYSTEM**
```
You resolve whether two entity records refer to the same real-world entity.
You have read-only tools. Investigate, then answer with ONE line.

RULES
- Evidence beats name similarity. A shared phone or email is near-proof.
  The same first name alone is weak.
- For people consider co-occurring contacts, shared groups, places, time patterns.
- Insufficient or conflicting evidence → "un". A human will decide. Never force.

OUTPUT
  V | <left> | <right> | <same|diff|un> | <conf> | <reason> [| <ev,ev>]
```

**USER**
```
A: a1 "Papa (new number Jio)" per · jid 919812…21 · seen from 2026-07-28 · in a4
B: a2 "Papa"                   per · jid 919425…07, phone +919425…07
   · last event 2026-07-24 · in a4, a5
ML score (calibrated): 0.62
shared: both in a4; both addressed as "Papa"; B silent since A appeared
```

**EXPECTED**
```
V|a1|a2|same|0.88|same group, same address term, old number went silent the day the new one appeared|q1,r4
```

**Tools** (local MCP `supertwin-tools`, this call only): `search_entities(query, type?)` → ≤10 matches · `read_entity(id)` → identities, edges, top mentions with quotes · `read_events(ids ≤10)` → raw text.
**Settings:** sonnet-5 · **max 3 turns** · 60 s wall · 8k total · thinking off · write scope **none** · `un` → resolution queue, never auto-retried.

---

### 12.3 P-EP2 — Episode segmentation — `[LLM-M]` sonnet-5

**SYSTEM**
```
You segment sealed sessions into topical episodes.

FOR EACH SESSION
1. One topic or several? Split only when the topic genuinely changes
   ("dinner plans" → "her surgery"). Small asides do not split. A segment
   needs ≥2 events or ≥1 substantial event.
2. Per segment: does it continue an OPEN episode of THAT stream, or start new?
   attach — the same ongoing matter, even days later
   new    — a different matter, even if the same people appear

RULES
- Segments MUST partition the session. Every event id appears exactly once.
- Attach only to e-aliases listed for that session's stream. Never invent one.
- Label: 2-6 plain words, concrete ("villa shortlist for Goa", not "travel talk").
  Episode labels are SHORT — they name a topic inside one stream. Thread/space
  names are longer (4-8 words) because they must be unique across a whole life.
- Sessions may arrive newer-first, so an open episode can be NEWER than the
  session you are placing. Judge by subject matter, never by order.
- Placeholders carry no topic signal. Never split or attach on one.
- Confidence < 0.6 on an attach → prefer new. A wrong merge destroys; a wrong
  split is repairable.

OUTPUT
  G | <session> | <events> | <att|new> | <e-alias | -> | <conf> | <label>
```

**USER**
```
#C c1 Rohan | dm | self,a1
#E e1 villa shortlist for Goa | open | last Mon | a1,a5
#D 2026-08-13 Thu | Asia/Kolkata
1 20:40 a1 Amara confirmed 4 rooms, need deposit by 20th
2 +1   self ok
3 +3   a1 also — did your mom's reports come?
4 +2   self yes, all clear
#COV c1=4
```

**EXPECTED**
```
G|s1|1,2|att|e1|0.93|villa shortlist for Goa
G|s1|3,4|new|-|0.85|mom's medical reports
```

**Settings:** sonnet-5 · 1 turn · none · off · 120 s · ≤6 sessions / 8k in · 3,000 max out.

---

### 12.4 P-CL1 — Claims + Loops — `[LLM-M]` sonnet-5 · **the core call**

**SYSTEM**
```
You extract structured memory from one person's life data.

For EVERY episode produce TWO independent outputs. Never choose between them.

A) CLAIMS — always. Every descriptive statement about any entity.
   The TAG is the kind:
     F fact   P preference   B belief   O opinion
     I interest   R recommendation   H habit   W workflow
   - Subject MUST be a roster alias, or "-" with a hint. UNKNOWN BEATS WRONG.
   - Write every claim in RESOLVED THIRD PERSON. Never leave "me", "she",
     "there" unresolved. If self says "I love X", the subject is me and the
     text is "Loves X".
   - attribution: 1p first-person · ao about-other · rs reported speech ·
     q3 quoted/forwarded content the speaker did not author
   - valid_from only when the episode states a time bound.
   - No claims for logistics chatter ("ok", "sent", "reaching").

B) LOOPS — ONLY when BOTH are present: evidence of INTENT and an UNRESOLVED
   END STATE. Generated by exactly one of:
     1. an explicit commitment with an open end
     2. a fact with a TEMPORAL BOUNDARY — lease, passport, warranty, renewal,
        subscription, policy, appointment. These are the highest-value loops
        in old data. Extract them wherever they appear.
     3. a recurring obligation
     4. the user declaring one
   - origin ex when stated by anyone present, im when you inferred it.
     Be conservative with im: a false suggestion costs more than a missed one.
   - due: ISO date, or "-". NEVER invent one. "soon"/"next week" → "-" unless
     the episode fixes it. Resolve relative dates against the EPISODE's date.
   - recurrence when the obligation repeats (monthly, annual, weekly).
   - NO loop for something you merely could help with — that is a capability
     guess, not the person's intent.
   - NO loop for a recommendation someone made. That is an R claim. It becomes
     a loop only when the user commits.

C) SUMMARY — one Y line per episode, 2-3 self-contained sentences. It is reused
   as context when this episode is re-read later. Describe, do not editorialise.

HARD RULES
- Cite ONLY roster aliases. Every claim and loop MUST cite ≥1 event.
- Speakers are given. Never infer or contradict them.
- Episodes arrive out of chronological order by design. Judge only from what
  this episode says, using the episode's own date for relative time.
- Placeholders are UNKNOWN content, never empty and never an acknowledgement.

OUTPUT
  Y | <ep> | <summary>
  F | <events> | <subject> | <attribution> | <conf> | <valid_from> | <text>
      P B O I R H W are identical in shape
  T | <events> | <owner> | <cpty> | <origin> | <dir> | <stake> | <horizon>
    | <due> | <recurrence> | <conf> | <intent>
  Q | <about> | <question>
Values: attribution 1p|ao|rs|q3 · origin ex|im · dir i2t|t2i|shr|slf
        stake h|m|l · horizon d|w|mo|q|y|n
```

**USER**
```
#R a1=Pranjali Sachdeva | a2=Rahul Arora | a3=ACT broadband [thg]
   | a4=Goa trip [occ] | a5=Indiranagar [plc]
#C c1 Pranjali | dm | self,a1
#T t1 Confirm villa to Rohan | self | 2026-08-20 | op
#D 2026-08-12 Wed | Asia/Kolkata
1 21:10 a1   i've started bhangra classes on saturdays, it's so much better than the gym
2 +2   self  nice. i'll send you that villa link for Goa tonight, remind me if i forget
3 +4   a1    also my broadband renews on the 28th, ACT is way overpriced
4 +1   self  ok
#COV c1=4
```

**EXPECTED**
```
Y|e1|Pranjali has started Saturday bhangra classes and prefers them to the gym. Aditya offered to send her a Goa villa link the same night. Her broadband renews on the 28th and she finds ACT overpriced.
H|1|a1|1p|0.95|-|Attends bhangra classes on Saturdays
P|1|a1|1p||-|Prefers bhangra classes over the gym
O|3|a3|ao||-|Pranjali considers ACT broadband overpriced
T|2|self|a1|ex|i2t|l|d|2026-08-12|-|0.95|Send Pranjali the Goa villa link
T|3|a1|-|ex|slf|m|mo|2026-08-28|monthly||Pranjali's broadband renews
```

```
NOTES ON THIS EXAMPLE
- event 4 "ok" produced nothing. Acknowledgements are not claims.
- "the 28th" resolved against the EPISODE's date, not today's.
- the P line has an EMPTY confidence field, meaning 0.9. Only the H line,
  where the model meant 0.95, spends bytes on a number.
- the second T is owner=a1 → party_pair "oo" by code → NOT the user's task.
  It is a temporal-boundary loop and becomes context on her People record.
- bhangra produced a habit claim and NO loop — no open end state.
- t1 was supplied as context and correctly NOT re-emitted.
- party_pair is never written by the model. Code derives so/oo from the
  resolved aliases and the session participant set.
```

**Settings:** sonnet-5 · plain · 1 turn · tools none · thinking off · 180 s · ≤4 episodes / 10k in · 6,000 max out.

---

### 12.5 P-CL1Δ — Claims + Loops, delta — `[LLM-M]` sonnet-5

Used by the live trigger (every ~30 s on an open session) and by the enrichment completion pass. Same rules and tags as P-CL1, plus the `Z` update line.

Context is controlled by `enrichment.delta_context_mode`:

| Mode | Sends | Cost | Trade-off |
|---|---|---|---|
| **`summary`** (default) | the `Y` summary + already-extracted ids + only the ► events | ~20 % of a full call | cheapest; exact prior wording not visible |
| `raw_events` | the full original event list + the ► events | ~100 % | faithful; media captions read against the exact surrounding text |

The summary is free — P-CL1 already emits it as a `Y` line in pass 1.

**SYSTEM** — the P-CL1 prompt plus:
```
DELTA MODE
You are re-reading an episode you have already partly processed. You receive
either a summary or the full prior events, the already-extracted items, and
the NEW or NEWLY-READABLE events marked ►.

- Extract ONLY from ► events. Never re-emit an item already listed.
- Prior context is for resolving references ("she", "that place") only.
- If a ► event CHANGES an existing item — contradicts it, dates it, completes
  it, cancels it, refines it — emit a Z line instead of a corrected copy.
- A newly-readable attachment is a ► event. Read it as if it had always been
  there, in its true position.
- The conversation may still be in progress. Extract what was said; do not
  anticipate where it is going.

  Z | <claim|loop alias> | <ctr|dat|cmp|cnl|rfn> | <events> | <note>
```

**USER**
```
#R a1=Pranjali Sachdeva | a5=Indiranagar [plc]
#C c1 Pranjali | dm | self,a1
Y|e1|Pranjali started Saturday bhangra classes and prefers them to the gym.
  Aditya offered to send a Goa villa link tonight.
EXTRACTED  H1 Attends bhangra classes on Saturdays | P1 Prefers bhangra over gym
           T1 Send Pranjali the Goa villa link (op)
#D 2026-08-12 Wed | Asia/Kolkata
► 7 22:15 a1 actually the saturday batch is full, moving to sunday
► 8 +1   self [voice note, transcription pending]
```

**EXPECTED**
```
H|7|a1|1p|0.9|2026-08-12|Attends bhangra classes on Sundays
Z|H1|ctr|7|batch moved from Saturday to Sunday
```

```
NOTES
- P1 untouched and correctly not re-emitted.
- event 8 is a pending placeholder → nothing extracted. When the transcript
  lands it becomes a ► event in a later delta pass, in this same position.
- the new H carries valid_from; the write path closes H1's window using
  stated_at ordering, never arrival order.
```

**Settings:** sonnet-5 · 1 turn · none · off · 90 s · 1 episode · 2,500 max out.

---

### 12.6 P-AG2 — Arc adjudication — `[LLM-M]` sonnet-5

**SYSTEM**
```
You decide whether an episode belongs to an existing thread — a cross-source
strand of one person's life.

RULES
- Bridges (shared url, order id, file id, attendee set) are near-proof.
- Same people + the same concrete matter → same thread. Same people ALONE is
  not enough; friends discuss many things.
- Different concrete matters stay separate even with identical participants.
- Episodes may be processed newest-first, so a candidate thread can be newer
  than the episode. Judge by matter, not by order of arrival.
- Evidence genuinely underdetermines it → "un". Never force.

OUTPUT
  V | <ep> | <jn|nw|un> | <n-alias | -> | <conf> | <reason>
```

**USER**
```
EP e9 booking.com villa session | browser | 11–12 Aug | a5,a6
   user compared 3 villas, opened Amara twice
n1 Goa trip | wa,cal | anchors a2,a7,a5,a6 | bridge url booking.com/villa-amara
   (browser↔wa) | overlap 0.66 | sim 0.81
n2 weekend lunches | wa | anchors a8,a9 | bridge - | overlap 0.0 | sim 0.28
```

**EXPECTED**
```
V|e9|jn|n1|0.97|exact url bridge to the same villa page already in that thread
```

**Settings:** sonnet-5 · 1 turn · none · off · 60 s · 1 episode · 400 max out.

---

### 12.7 P-AG3 — Claim contradiction — `[LLM-M]` sonnet-5

**SYSTEM**
```
You decide the relationship between two claims about the same subject.

  dup duplicate · rfn refinement · ctr contradiction · dst distinct · un unsure

RULES
- Time matters. "Lived in Ratlam" and "lives in Bangalore" contradict only if
  both are asserted as current. If one is clearly past they are distinct with
  different validity windows.
- A preference changing over time IS a contradiction. Record it so the earlier
  one closes with a date, never deleted.
- CRITICAL: judge ONLY by stated_at — when each was SAID. Data does not arrive
  in order: history is read newest-first, sources connect at different times,
  delayed syncs land late. Either claim may be the older one. Never assume the
  incoming one is newer and never reason about which was recorded first.
- Say which claim describes the LATER state, and give a validity end for the
  earlier one where one is implied.

OUTPUT
  V | <a> | <b> | <dup|rfn|ctr|dst|un> | <later: a|b|-> | <valid_to earlier>
    | <conf> | <reason>
```

**USER**
```
SUBJ a2 Rahul Arora per
A stored   F "Lives in Indiranagar."  said 2026-08-11 · valid - / -  · "shifting to Indiranagar"
B incoming F "Lives in Koramangala."  said 2026-03-02 · "my place in koramangala"
sim 0.71
```

**EXPECTED**
```
V|A|B|ctr|a|2026-09-01|0.9|B was said five months before A and describes the residence before the stated move
```

```
NOTE: B arrived second but was SAID first. It stores as a predecessor with a
closed window; A stays active. Storage order is irrelevant — stated_at decides.
```

**Settings:** sonnet-5 · 1 turn · none · off · 60 s · 1 pair · 400 max out.

---

### 12.8 P-TR1 — Triage — `[LLM-S]` haiku-4-5

**SYSTEM**
```
You classify newly extracted loops.

  au auto      — safe without asking. ONLY research, summarise, look up, or
                 prepare a draft that is not sent.
  ap approval  — anything outward-facing (a message, email, purchase, booking,
                 payment), anything irreversible, anything ambiguous, and
                 EVERY loop with origin im.
  cx context   — not actionable by the system. A loop owned by someone other
                 than the user is ALWAYS cx.

RULES
- origin im is ALWAYS ap or cx. Never au.
- owner not self is ALWAYS cx.
- Past due AND no recurrence → cx. It is history.
- BUT a recurring obligation whose NEXT occurrence is in the future is live,
  however old the evidence. An insurance policy, lease, warranty or
  subscription first mentioned two years ago is a real current item.
  Judge by the next occurrence, never by the age of the message.
- Torn between au and ap → choose ap.

OUTPUT
  J | <t-alias> | <au|ap|cx> | <u|h|m|l> | <reason>
```

**USER**
```
SELF self   TODAY 2026-08-15
t1 Send Pranjali the Goa villa link | ex | self | a1 | due 2026-08-16 | rec - | l
t2 Pranjali's broadband renews      | ex | a1   | -  | due 2026-08-28 | rec monthly | m
t3 Compare broadband plans          | im | self | -  | due -          | rec - | m
t4 Summarise the rent agreement PDF | ex | self | -  | due -          | rec - | l
t5 Book the Ratlam tickets          | ex | self | -  | due 2024-11-02 | rec - | m
t6 Renew health insurance policy    | ex | self | -  | due 2025-03-15 | rec annual next 2027-03-15 | h
```

**EXPECTED**
```
J|t1|ap|h|outward-facing message to a person
J|t2|cx|m|owned by Pranjali, not the user
J|t3|ap|l|implicit inference, never auto
J|t4|au|l|read-and-summarise, nothing leaves the device
J|t5|cx|l|past due, no recurrence, historical
J|t6|ap|m|recurring obligation with a future next occurrence
```

```
NOTE: t5 and t6 were both said in the past and both arrived via backfill.
t5 is dead; t6 is live. The difference is the next occurrence, not the age.
```

**Settings:** haiku-4-5 · 1 turn · none · off · 90 s · 20–50 loops · 2,000 max out.

---

### 12.9 P-DD1 — Done-detection — `[LLM-S]` haiku-4-5

**SYSTEM**
```
You check whether any open loop was completed, given new episodes.

  dn done · ps possibly · dr dropped · op still open

RULES
- Mark dn ONLY on concrete evidence: a confirmation, receipt, completion
  statement, delivery, or an explicit "done".
- Intent to do it later is NOT done.
- Suggestive but not conclusive → ps with the event id. A human confirms.
  Never mark done on a guess.
- The loop's subject is now moot (cancelled, irrelevant) → dr with evidence.
- Episodes may be older OR newer than the loop. Count only evidence occurring
  AFTER the loop was stated.

OUTPUT
  S | <t-alias> | <dn|ps|dr|op> | <ev | -> | <conf> | <quote>
```

**USER**
```
t1 Send Pranjali the Goa villa link | self | a1 | due 12 Aug | said 2026-08-12T19:40
t2 Confirm villa to Rohan           | self | a2 | due 20 Aug | said 2026-08-10T09:00
#C c1 Pranjali | dm | self,a1
#D 2026-08-12 Wed | Asia/Kolkata
1 21:04 self here — https://booking.com/villa-amara
2 +2   a1   ooh this looks great
#C c2 Rohan | dm | self,a2
3 22:10 self will confirm the villa by tomorrow for sure
```

**EXPECTED**
```
S|t1|dn|1|0.95|here — https://booking.com/villa-amara
S|t2|op|-|0.9|
```

```
NOTE: t2 restated the intention. Intent to do it later is NOT done.
```

**Settings:** haiku-4-5 · 1 turn · none · off · 90 s · ≤30 loops · 1,500 max out.

---

### 12.10 P-SP1 — Archetype + label — `[LLM-S]` haiku-4-5

**SYSTEM**
```
You classify a thread of a person's life into exactly ONE shape and name it.

  prj project  an outcome with a span and many steps
  evt event    a single point in time
  rhy rhythm   a recurring COMMITMENT to others
  adm admin    a recurring external duty with a ledger (bills, renewals, tax)
  hld holding  a durable thing owned or inhabited (a flat, a car, a connection)
  mat matter   an unresolved situation with no fixed end (a health concern,
               a dispute, an ongoing worry)
  pur pursuit  a self-directed recurring activity with no obligation
               (cooking experiments, reading, learning)
  wch watch    standing attention on a topic, no obligation

RULES
- Choose by the SHAPE of the thing, not its subject matter.
- pursuit vs watch: does the person ACT (pursuit) or OBSERVE (watch)?
  Mostly their own events → pursuit. Mostly things arriving at them → watch.
- LABEL: MORE THAN THREE WORDS. 4 to 8 plain words, concrete, in the person's
  own vocabulary. A label must distinguish this thread from every other one
  the person has, so include the anchor that makes it specific — who, where,
  or when.
    BAD  "Goa trip"        "Housing"        "Insurance"      "Rahul"
    GOOD "Goa trip with Rohan in September"
         "Flat hunt in Indiranagar"
         "Health insurance renewal every March"
         "Rahul's wedding in December"
- ends_at only if there is a real end. cadence rec if its loops regenerate.
- A thread may still be growing as older data lands. Classify what is present;
  you will be asked again if it changes materially.

OUTPUT
  D | <n-alias> | <archetype> | <one|rec> | <ends_at | -> | <conf> | <label>
```

**USER**
```
n1 Goa trip | wa,web,cal,gmail,shop | anchors a2,a7,a5 | promo cmt
   loops: confirm villa to Rohan (due 20 Aug) · compare flights (-) · split deposit (-)
   "villa held till 20 Aug" / "12–15 Sep" / "who pays deposit?"
n2 broadband renewal | gmail,shop | anchors a3 | promo cmt
   loops: broadband renews (due 28 Aug, monthly)
n3 weekend lunches | wa | anchors a8,a9 | promo rec
   loops: pick a place for Saturday (weekly)
n4 the Indiranagar flat | wa,doc,gmail | anchors a5,a10 | promo ref
   loops: - | facts: rent ₹52k, lease to Nov 2027, landlord a10
n5 sourdough experiments | wa,web | anchors a11 | promo rec
   loops: - | 9 episodes over 7 weeks, user participated in all
```

**EXPECTED**
```
D|n1|evt|one|2026-09-15|0.9|Goa trip with Rohan in September
D|n2|adm|rec|-|0.95|ACT broadband renewal each month
D|n3|rhy|rec|-|0.92|Weekend lunches with Rajat and Mansi
D|n4|hld|one|2027-11-30|0.9|The Indiranagar flat and its lease
D|n5|pur|rec|-|0.85|Sourdough baking experiments at home
```

```
NOTE: every label is 4-8 words and carries the anchor that makes it findable
among forty others. "Goa trip" and "Broadband renewal" would both be rejected.
```

**Settings:** haiku-4-5 · 1 turn · none · off · 60 s · ≤10 threads · 800 max out.

---

### 12.11 P-TI1 — Business channel tier — `[LLM-S]` haiku-4-5

Runs **once per business channel**, not per message. Code heuristics decide most channels; this call only sees the ambiguous ones. The verdict is cached on the stream.

**SYSTEM**
```
You classify a business sender into one of two tiers for a personal-memory
system's processing queue.

  tx TRANSACTIONAL  messages about THIS person's own affairs: order and
                    booking confirmations, delivery updates, bank and card
                    alerts, statements, bills, appointment reminders,
                    tickets, policy and subscription notices, OTPs.
  pm PROMOTIONAL    campaigns aimed at many people: offers, sales, discounts,
                    newsletters, product launches, re-engagement nudges.

RULES
- Judge the CHANNEL by its sample, not any single message.
- The tell is specificity: does the sender reference THIS person's order,
  booking, account, appointment or amount? That is tx. Generic offers with
  no user-specific identifier are pm.
- A sender that does both → tx. Under-prioritising a real bill is the more
  expensive mistake.
- Tier only changes WHEN a channel is processed, never WHETHER. Both tiers
  are extracted in full. Do not filter, only order.
- Unsure → tx.

OUTPUT
  J | <c-alias> | <tx|pm> | <conf> | <reason>
```

**USER**
```
#C c7 HDFC Bank | biz | self,a20   sample 5 of 214
  1 "Rs.3398.23 debited from a/c XX4412 on 11-Aug toward Axis Max Life premium"
  2 "Your card ending 8891 was used for Rs.1,499 at ACT FIBERNET"
  3 "Statement for Aug is ready. Total due Rs.24,110 by 05-Sep"
#C c9 Zomato | biz | self,a21   sample 5 of 803
  1 "FLAT 60% OFF on your first 3 orders this weekend! Use code WEEKEND60"
  2 "We miss you! Here's Rs.150 off your next order"
  3 "Your order from Meghana Foods has been delivered"
```

**EXPECTED**
```
J|c7|tx|0.97|every message references this person's own account, amount and due date
J|c9|pm|0.85|predominantly campaign offers; one delivery notice does not change the channel's character
```

**Settings:** haiku-4-5 · plain · 1 turn · tools none · thinking off · 60 s · ≤10 channels per call · 600 max out. Runs at boot as a backfill over all business channels, then once per newly seen business channel. **Never on the first-paint critical path.**

---

### 12.12 Media describe — `[LLM-S]` haiku-4-5

**SYSTEM**
```
Describe each image for a private personal-memory index.

RULES
- One C line per image, echoing the id you were given.
- Return EXACTLY the ids you were given — no more, no fewer, same ids.
- Describe what is visibly there. Read visible text verbatim where legible.
- Never speculate about who someone is, what they feel, or what happened
  outside the frame.
- Nothing legible or meaningful → "C|<id>|-".

OUTPUT
  C | <id> | <caption>
```

**USER** — `{{16 images, each preceded by its id: img1 … img16}}`

**EXPECTED**
```
C|img1|A restaurant menu, Italian. Visible: "Margherita 480", "Diavola 560".
C|img2|Screenshot of a booking confirmation. Visible: "Villa Amara, 12–15 Sep, 4 rooms".
C|img3|-
```

**Settings:** haiku-4-5 · 1 turn · none · off · 180 s · **16 images (1–32)** · 4,000 max out. Id set must match exactly; on mismatch the batch splits in half and retries recursively (§10.1).

---

## 13. Step-by-step — one signal to a task

```
 STEP  WHAT                                              EXECUTOR    MODE
 ════  ═══════════════════════════════════════════════   ══════════  ══════
  1    SOURCE CONNECT / EVENT ARRIVES                    [CODE]      both
       set sources.mode = bootstrap | steady
  2    ADAPTER PULLS  (backfill_order=desc requested;    [CODE]      both
       asc adapters are buffered and re-ordered)
  3    INGEST  dedupe (source_id, external_id) · stream  [CODE]      both
       resolve · ts (said) / tz / ingested_at · watermarks
       (live_high ↑ · backfill_low ↓)
  4    ★ SCHEDULER PLANS COHORTS                         [CODE]      both
       horizon ladder live→h24→d7→d30→d90→y1→older
       adaptive budget = min(MAX, BASE × 2^seq)
       priority = horizon_rank ×10^6 + recency
  5    SALIENCE PREFILTER (ambient only)                 [CODE]+[ML] both
  6    ★ LANE E — ENRICH cohort N+1, N+2       [CODE]+[ML]+[LLM-S]  both
       image/frames→caption [LLM-S] · audio→text [ML whisper]
       link→scrape [CODE] · yt→captions [CODE] · embed [ML]
       priority = cohort priority (never FIFO)
  7    STRUCTURAL IDENTITY BINDING                       [CODE]      both
       metadata identity → exact bind, else mint provisional
       me-entity · metadata edges (member_of, participant_in,
       created) at confidence 1.0 — free, before any model
  8    SEGMENT + SEAL                                    [CODE]      both
       bootstrap → seal_mode=immediate (history complete)
       steady    → seal_mode=debounce ∪ trigger ∪ ceiling
       boundary_reason + params · content_hash
  9    ★ ENRICHMENT BARRIER                              [CODE]      both
       release to Lane U when all events ready/failed/timed_out
       attachments marked pending; text never waits
 10    HASH GATE  already understood at this hash?       [CODE]      both
 11    P-EP1 ENTITY PASS per sealed session              [LLM-S]     both
 12    RESOLUTION LADDER                          [CODE]→[ML]→[AGENT]
       exact + cross-source bind now; in-band pairs batched to
       horizon boundaries in bootstrap, immediate in steady
 13    EPISODE PRE-FLAG  intra-session drift             [ML]        both
       no drift AND no open episodes → 1:1 default, NO CALL [CODE]
 14    P-EP2 EPISODE PASS  split / attach / new          [LLM-M]     both
 15    EMBED episode topic vector                        [ML]        both
 16    BRIDGES recomputed for new events                 [CODE]      both
 17    ARC LADDER ①→④                        [CODE]→[ML]→[LLM-M]     both
       ① bridge ② overlap ≥0.5 ③ calibrated sim ④ P-AG2
       ambient joins via ① or ② only
 18    BUILD ROSTER for the episode                      [CODE]+[ML] both
 19    P-CL1 UNDERSTAND — one call per episode           [LLM-M]     both
       parallelism 4 (bootstrap) / 2 (steady)
 20    APPLY CODE FACTS                                  [CODE]      both
       due<now→lapsed · owner≠me→context · attribution repair
       · stamps · horizon
 21    EMBED claim text + loop intent                    [ML]        both
 22    WRITE PATH  exact REINFORCE · near → 23 · else INSERT [CODE]+[ML]
 23    P-AG3 ADJUDICATE near hits                        [LLM-M]     both
 24    P-TR1 TRIAGE new loops (batched)                  [LLM-S]     both
       bootstrap suppresses implicit loops older than d30
 25    P-DD1 DONE-DETECTION                              [LLM-S]     both
       preceded by a [CODE] lookup: newest-first means resolving
       evidence is often already in the DB — no call needed
 26    DERIVE SPACES from arcs                           [CODE]      both
 27    P-SP1 ARCHETYPE + LABEL (new/changed)             [LLM-S]     both
 28    ★ RECONCILE                                       [CODE]
       cohort boundary (bootstrap) + nightly (both):
       provisional arcs deduped · arc_key rebind · space status ·
       aging · user walls · entity redirect compaction ·
       coverage updated · all undoable as one run
 29    GOAL EMERGENCE  2–3 loops, ≥2 spaces, shared      [CODE]      both
       anchors → propose life project (NEVER scaffolded)
 30    SURFACE  7 surfaces + coverage meters             [CODE]      both
       first output ≤120 s; grows monotonically
 31    ★ LATE ENRICHMENT ARRIVES                         [CODE]      both
       content_hash changes → superseded_hash →
       REPROCESS cohort at high priority → steps 11–27 on the
       SAME session/episode → write path absorbs idempotently
 32    CORRECT  typed gestures → mutations(actor:user)   [CODE]      both
       permanent; rejections become claims that feed step 18
```

**Steady-state budget, quiet day:** hash gate and the 1:1 default absorb most work; typical **5–12 calls/day**.
**Bootstrap budget:** paced against the quota window; a large import degrades to *slower*, never *failed*, with a visible ETA.

---

## 14. The eight surfaces

Four make the mechanical layers debuggable; three are the product's understanding made inspectable. All answer **"why?"**, and all carry a **coverage meter**.

### 14.0 The coverage meter — on every surface

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⟳ UNDERSTANDING YOUR HISTORY        live ✓ · 24h ✓ · 7d ✓ · 30d ▓▓▓░ 71% │
│   90d ░ queued · 1y ░ queued · older ░ queued                            │
│   1,204 of 3,028 events · ~14 min remaining · newest first               │
└──────────────────────────────────────────────────────────────────────────┘
```

1. **Progress is per-horizon and monotonic.** The meter never goes backwards.
2. **A paused lane says so**: "paused — rate limit, resumes in 04:12". *A healthy mid-run system that looks like a silent failure is itself a shipped defect.*
3. **The meter disappears in steady state** unless a backlog exists.

### 14.0b "Conversation in progress" — live, provisional output

Anything produced by a live trigger on a still-open session is rendered immediately, marked, and **updated in place** as the conversation continues.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ● Send Pranjali the Goa villa link          due today · Goa trip         │
│   ◍ conversation in progress · updated 12s ago            [ why? ]       │
│   "i'll send you that villa link tonight"                                │
│   [ done ][ drop ][ snooze ]                                             │
└──────────────────────────────────────────────────────────────────────────┘
```

1. **Everything surfaces immediately** — explicit and implicit alike — with the marker, rather than being withheld until the session seals.
2. **Items update in place, they do not stack.** A later delta pass that corrects an item edits it; it does not create a second one. The idempotent write path is what guarantees this.
3. **An item can change or disappear** as a conversation resolves ("dinner tonight?" → "let's skip it"). The marker sets that expectation honestly.
4. **The marker clears at seal**, when the consolidation pass confirms the final state.
5. **A pending attachment is visible on the item**: "◍ 1 voice note still transcribing" — so a partially-read conversation never looks like a complete one.

### 14.0c Settings — processing

```
┌──────────────────────────────────────────────────────────────────────────┐
│ PROCESSING                                                               │
│                                                                          │
│  Understand new messages after    [ 30 seconds ▾ ]     30 s ─── 6 h      │
│    How long to wait after a message before extracting from it. Lower is  │
│    more responsive; higher is calmer and cheaper. At 6 hours, extraction │
│    happens only when a conversation ends.                                │
│                                                                          │
│  Parallel AI calls                [ 8 ▾ ]              1 ──────── 16     │
│    Each parallel call runs a separate Claude CLI process using roughly   │
│    250–350 MB. 8 parallel ≈ 2–3 GB · 16 parallel ≈ 4–6 GB. On an 8 GB    │
│    Mac, values above 8 may cause swapping and run SLOWER than a lower    │
│    setting. Higher values also reach your subscription's rate limit      │
│    sooner — processing pauses and resumes automatically when that        │
│    happens. Local transcription and embeddings have their own limits and │
│    are not affected by this setting.                                     │
│                                                                          │
│  ▸ Advanced   transcription 1 · embeddings 2 · frames 2 · scrape 8       │
│               enrichment/understanding pool split  40 / 60               │
│               warm cache before fan-out                    [ on  ]       │
├──────────────────────────────────────────────────────────────────────────┤
│ MEDIA                                                                    │
│                                                                          │
│  Read all images and stickers               [ on  ]                      │
│    Caption every image and sticker and transcribe every voice note.      │
│    Turn off to skip stickers and very short audio.                       │
│                                                                          │
│  Images per AI call                [ 16 ▾ ]            1 ──────── 32     │
│    Higher batches cost far fewer calls. 16 images ≈ 20–26k tokens per    │
│    call. If a batch comes back mismatched it is split and retried, so    │
│    very large batches can occasionally cost more, not less.              │
│                                                                          │
│  Skip low-information media               [ off ]                        │
│    When on, a caption with no person, place, date, number or commitment  │
│    in it will not trigger a re-read of its conversation. Saves cost;     │
│    risks missing a caption that mattered. Off by default.                │
│                                                                          │
│  Re-read context                  [ Summary ▾ ]  Summary | Full events    │
│    When media finishes reading, the conversation is understood again.    │
│    Summary is ~5x cheaper. Full events is more faithful where a photo    │
│    only makes sense alongside the messages around it.                    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 14.1 Entities

```
┌────────────────────────────────────────────────────────────────────────┐
│ ENTITIES  [person 132][group 9][org 14][place 11][service 6][topic 18] │
│ 🔍 search                                       ⚠ 12 need resolution   │
├────────────────────────────────────────────────────────────────────────┤
│ Pranjali Sachdeva                              person · 4 identities   │
│  IDENTITIES  whatsapp:jid 9177…03 ✓code   phone +9177…03 ✓code         │
│              gmail:pranjali@…     ✓user   slack:@pran    ⚠ml 0.71      │
│  RELATIONS                                                             │
│      [me] ──social_of:friend──▶ Pranjali                               │
│      Pranjali ──member_of──▶ "Ghar+"                    ✓code 1.0      │
│      Pranjali ──lives_at:current──▶ Bangalore      llm 0.8 "…quote…"   │
│  41 sessions · 12 episodes · 3 arcs · first seen 12 Mar                │
│  [ merge ][ split ][ rename ][ pin ][ add relation ]                   │
├────────────────────────────────────────────────────────────────────────┤
│ ⚠ RESOLUTION QUEUE            (batched during import · 12 waiting)     │
│  "Papa (new number Jio)" ↔ "Papa"        agent: same 0.88              │
│    "same group, same address term, old number went silent"             │
│    [ same ][ different ][ later ]        [ answer all 12 → ]           │
└────────────────────────────────────────────────────────────────────────┘
```

### 14.2 Sessions

```
┌────────────────────────────────────────────────────────────────────────┐
│ SESSIONS  source [all ▾] stream [all ▾] date [14 Aug ▾]     38 sealed  │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ WhatsApp · Pranjali          09:12–09:41 · 14 events · conversation  │
│    START: gap 7h20m > 6h (G=6h)       END: debounce 45m                │
│    seal_mode: debounce · hash 3f9a… ✓understood                        │
│    [ view events ][ replay stream ][ cut here / don't cut ]            │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ WhatsApp · Ghar+ (backfill)  20:02–23:59 ✂ day_boundary              │
│    seal_mode: immediate (history complete — no debounce wait)          │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ WhatsApp · Rohan             14:20–14:52 · 9 events                  │
│    ⏳ 1 voice note pending · text understood immediately             │
│    ↻ reprocessed at 14:53 when transcript landed (reprocess_count 1)   │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ Calendar · Standup           10:00–10:15 · bounded · record_bounded  │
│ ▸ Screen · low-salience run    11:30–12:10 · 1,204 → 6 · ambient       │
├────────────────────────────────────────────────────────────────────────┤
│ REPLAY stream "Pranjali" with G=4h  →  diff: 3 sessions become 5       │
│    [ apply new params ][ discard ]                                     │
└────────────────────────────────────────────────────────────────────────┘
```

Every session shows both boundaries with the rule and measured value, its `seal_mode`, its enrichment state, and any reprocess history. `replay` re-segments with candidate params and **diffs** before applying.

### 14.3 Episodes

```
┌────────────────────────────────────────────────────────────────────────┐
│ EPISODES  [open 22][closed·concluded 61][closed·faded 31] stream [▾]   │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ "villa shortlist for Goa"       open · WhatsApp/Rohan · 3 sessions   │
│    ├ Mon 09:12  seed (1:1 default, no model call)                      │
│    ├ Wed 20:40  ATTACHED conf 0.93 "continues the Amara booking"       │
│    └ Fri 08:15  ATTACHED conf 0.88                                     │
│    entities: Rohan · Villa Amara · Goa      arc: "Goa trip" ──▶        │
│    [ why? ][ detach session ][ split ][ relabel ][ close ]             │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ "mom's medical reports"         open · 1 session                     │
│    SPLIT from session Wed 20:40 (2 topics)  [ why? ][ merge back ]     │
└────────────────────────────────────────────────────────────────────────┘
```

`[ why? ]` renders the persisted verdict — the exact candidates the model saw and its stated reason.

### 14.4 Arcs

```
┌────────────────────────────────────────────────────────────────────────┐
│ ARCS  [live 18][dormant 24][archived 61]                    🔍   + pin │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ Goa trip                        live · 5 sources · 12 episodes       │
│   Jun ───●────●─────────●────●────●───────● Sep                        │
│          wa   wa        web  gmail cal    mmt                          │
│   BOUND BY (precedence order)                                          │
│    ① url        booking.com/villa-amara    web ↔ wa        exact       │
│    ① attendees  {me,Rohan,Ana,Kabir}       cal ↔ wa        J=0.75      │
│    ② overlap    0.71                       wa ↔ wa                     │
│    ④ adjudicated "same trip, same villa"   mmt ep          conf 0.90   │
│   anchors: Rohan · Ana · Villa Amara · Goa    space: "Goa trip" ──▶    │
│   ⟳ still growing — 90d+ history queued                                │
│   [ why together? ][ remove episode ][ split arc ][ merge ][ pin ]     │
├────────────────────────────────────────────────────────────────────────┤
│ ❓ NEEDS YOU (adjudicator unsure)                                       │
│   "flight price alerts" episode → arc "Goa trip"?                      │
│   [ yes, same trip ][ no, separate ][ later ]                          │
└────────────────────────────────────────────────────────────────────────┘
```

**The source-contribution timeline is the core visual.** Arcs still receiving older cohorts are marked "still growing" so a thin arc is not mistaken for a wrong one.

### 14.5 Claims

```
┌──────────────────────────────────────────────────────────────────────────┐
│ CLAIMS  [fact 144][preference 57][belief 51][interest 65][opinion 40]    │
│         [recommendation 24][habit 12][workflow 8]        ⚠ 6 conflicts   │
│ subject [ all ▾ ]  🔍 search                     ○ active ○ superseded   │
├──────────────────────────────────────────────────────────────────────────┤
│ ▸ Pranjali Sachdeva                                          41 claims   │
│   habit       Attends bhangra classes on Saturdays.     0.95  1st-person │
│               ev_9001 "i've started bhangra classes…"        [ why? ]    │
│   preference  Prefers bhangra classes over the gym.     0.90  1st-person │
│   opinion     Considers ACT broadband overpriced.       0.90  about-other │
├──────────────────────────────────────────────────────────────────────────┤
│ ⚠ CONFLICT — Rahul Arora                                                 │
│   now  "Lives in Indiranagar."   observed 11 Aug   active               │
│   was  "Lives in Koramangala."   observed 02 Mar   valid → 01 Sep 2026  │
│   adjudicator: contradiction 0.90 "the incoming claim is older and       │
│   describes the residence before the stated move"                        │
│   [ accept ][ both true ][ neither ][ show both quotes ]                 │
├──────────────────────────────────────────────────────────────────────────┤
│ HISTORY  "Prefers houses in Indiranagar"                                 │
│   v3 active     11 Aug  refined by better evidence                       │
│   v2 superseded 04 Jul  refined by better evidence                       │
│   v1 superseded 20 May  original                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

Grouped by subject entity; every claim shows confidence, attribution, `decided_by` and its verbatim quote. **Supersede chains are browsable.** The conflict queue is the human loop.

### 14.6 Spaces

```
┌──────────────────────────────────────────────────────────────────────────┐
│ SPACES  [active 14][dormant 9][archived 22]      archetype [ all ▾ ]     │
│ ⟳ 30d ▓▓▓░ 71% — spaces will keep filling in                            │
├──────────────────────────────────────────────────────────────────────────┤
│ ▸ Goa trip                          EVENT · active · ends 15 Sep         │
│   ┌─ countdown 31 days ──────────────────────────────────────────────┐   │
│   │ LOOPS  confirm villa to Rohan     open  · due 20 Aug     ● you    │   │
│   │        compare flights            done  · 12 Aug                  │   │
│   │        split the deposit          open  · no due         ● you    │   │
│   │ PEOPLE Rohan · Ana · Kabir · Pranjali                             │   │
│   │ SOURCES whatsapp · browser · gmail · calendar · commerce          │   │
│   └───────────────────────────────────────────────────────────────────┘   │
│   CONTEXT (claims, computed at query time — not stored on the space)     │
│     · Ana is vegetarian.                            preference  0.90     │
│     · Budget ₹40k each.                             fact        0.95     │
│   arc: arc_77 ──▶   [ why a space? ][ pin ][ relabel ][ archetype ]      │
├──────────────────────────────────────────────────────────────────────────┤
│ ▸ 🧾 Broadband renewal     ADMIN ⚑commitment · active · recurring        │
│   ₹1,499 due 28 Aug · ACT · unpaid                                       │
│ ▸ 🔁 Weekend lunches       RHYTHM ↻recurrence · active · weekly          │
│   next Sat · 6-week streak · Rajat, Mansi                                │
│ ▸ 📦 The Indiranagar flat  HOLDING ⚓reference · active                   │
│   lease to Nov 2027 · rent ₹52k · landlord Mr Nair · 3 docs              │
│ ▸ 🌀 Papa's eye treatment  MATTER ⚑commitment · active                   │
│   unresolved 6 weeks · last update 3d ago · Dr Shreedhar                 │
│ ▸ 🌱 Sourdough experiments PURSUIT ↻recurrence · active 💤 quiet 9d      │
│   9 sessions over 7 weeks · last 2d ago                                  │
├──────────────────────────────────────────────────────────────────────────┤
│ ○ NOT A SPACE (arcs with no live loop — browsable, never surfaced here)  │
│   "pets and animals discussion" · "restaurant reviews"     [ view arcs ] │
├──────────────────────────────────────────────────────────────────────────┤
│ 🎯 LIFE PROJECT  "Move near Indiranagar by Dec 2026"  (emerged, 4 spaces)│
│    Housing search · Lease exit · Movers · Move budget                    │
└──────────────────────────────────────────────────────────────────────────┘
```

Five archetype layouts — project (milestones, timeline), rhythm (next occurrence, streak, cadence), event (countdown, logistics), admin (ledger), watch (findings feed). `[ why a space? ]` shows the promotion rule and the loops that caused it.

### 14.7 Tasks

```
┌──────────────────────────────────────────────────────────────────────────┐
│ TASKS   ● 7 you said you'd do      ○ 4 suggested      ⏳ 2 need a check  │
├──────────────────────────────────────────────────────────────────────────┤
│ YOU SAID YOU'D DO THIS                              (origin: explicit)   │
│  ⚠ Send Pranjali the Goa villa link       due today · Goa trip          │
│     "i'll send you that villa link tonight" · 12 Aug        [ why? ]     │
│     ◍ conversation in progress · updated 12s ago                        │
│     [ done ][ drop ][ snooze ][ open space ]                            │
│  ⚠ Confirm villa to Rohan                 due 20 Aug · Goa trip         │
│  ⏱ Reply to Dr. Rao about Tuesday         LAPSED (due 20 Jul)           │
│     born lapsed — the due date had passed when it was found             │
├──────────────────────────────────────────────────────────────────────────┤
│ SUGGESTED BY YOUR TWIN                              (origin: implicit)   │
│  ○ Compare broadband plans in Bangalore   no due · Broadband renewal    │
│     inferred from: "ACT is way overpriced"                              │
│     [ yes, track it ][ not useful ]  ← rejection teaches, permanently    │
├──────────────────────────────────────────────────────────────────────────┤
│ ⏳ DID YOU DO THIS?                                                       │
│  Send Pranjali the villa link — I saw a booking.com link at 21:04       │
│     "here — https://booking.com/villa-amara"        [ yes ][ no ]       │
├──────────────────────────────────────────────────────────────────────────┤
│ WAITING ON OTHERS  (not your tasks — context only)                       │
│  Rohan: hold the villa till 20 Aug   ·  Pranjali: broadband renews 28th │
└──────────────────────────────────────────────────────────────────────────┘
```

1. **Explicit and implicit are separate lists with different verbs.**
2. **Rejecting a suggestion writes a user-sourced preference claim** — teaching, not deleting.
3. **"Did you do this?" is one tap** with the evidence quote. Nothing parks in limbo.
4. **Lapsed tasks say why** — including "born lapsed", which is honest about backfill.
5. **"Waiting on others" is context, never a to-do.**

### 14.8 Correction gestures — shared across all seven

| Gesture | Target | Effect |
|---|---|---|
| same / different entity | entity pair | merge tombstone, or a permanent negative pair |
| rename · pin | entity, episode, arc, space | user label outranks every model label |
| cut here / don't cut here | session boundary | per-stream param override + regenerate |
| detach · split · merge back | episode | verdict overridden, sticky |
| remove episode · split arc | arc | re-derivation must preserve |
| accept / both true / neither | claim conflict | supersede with the user's reason, or keep both with windows |
| pin · reject · correct | claim | permanent; rejection writes a user claim |
| done · drop · snooze · not useful | task | state written directly; rejection teaches |
| override archetype · archive | space | model never reverts it |
| pause / resume import · re-prioritise | cohort | scheduler honours it immediately |
| forget this hour / app / person | events | real deletion, cascades to sessions, episodes, arcs, claims |

Every gesture writes `mutations(actor: user)` and **wins permanently over every future automated verdict.**

---

## 15. Evals and acceptance

### 14.1 Gold set

> **The golden eval set for this build is `SuperTwinV11_GoldenEvals_V2.md`** — 1,000 cases across 22 categories, each with a fixture, an expected result and an assertion mode. It supersedes `SuperTwinV11_GoldenEvals_V1.md`, which predates claims, loops, spaces, tasks, party pairs and the wire format. Every gate in §14.2 is measured against it, and every gate name below maps to a category there.

1. **1,000 labelled units** spanning all five stream kinds, both actor models, both operating modes, and every layer.
2. **Each labelled with:** correct session boundaries and `seal_mode`; correct entity for every actor and mention; expected edges; correct episode grouping; correct arc membership; expected claims (kind, subject, attribution, validity); expected loops (intent, owner, origin, due, state); expected triage; whether a space should exist and its archetype.
3. **Scheduler fixtures** additionally freeze: a synthetic 24-month history with known timestamps; attachments with controlled enrichment latencies (including one arriving minutes late); an out-of-order corpus (a source connected second whose events predate the first); and a mid-run restart.
4. **Fixtures freeze both inputs and model verdicts**, so the suite runs offline and deterministically.

### 14.2 CI gates

| Layer | Metric | Fails the build if |
|---|---|---|
| **scheduler** | **time to first claim + task + space (reference corpus)** | **> 120 s** |
| **scheduler** | **new message → its claims/tasks visible (steady state)** | **> live_interval + 15 s** |
| scheduler | live pass is DELTA (tokens scale O(n), not O(n²), in session length) | any O(n²) growth |
| scheduler | live passes per stream per hour | > 20 |
| scheduler | consolidation at seal skipped when hash unchanged | < 100% |
| **latency** | **first claim rendered (streamed, not call-complete)** | **> 30 s** |
| latency | calls on the first-paint critical path | **> 1** |
| latency | an adjudicator (P-AG1/2/3) executed before first paint | **> 0** |
| latency | Lane E held LLM slots during first paint | > 0 |
| latency | per-call TTFT and tok/s recorded per model per call type | absent |
| tiers | every stream has a tier assigned after boot backfill | < 100% |
| tiers | tier order respected — a T2 backfill cohort ran before T1 exhausted | > 0 |
| tiers | **events orphaned by a T3→T1 promotion** | **> 0** |
| tiers | a T4 channel's real obligation dropped rather than deferred | > 0 |
| tiers | T1/T2 live events pre-empt backfill at the next cohort boundary | < 100% |
| labels | space labels containing no anchor entity where one exists | > 10% |
| **wire** | **byte-identical round trip `serialize(parse(serialize(x)))`** | **any drift** |
| wire | A/B: wire path and JSON path produce equal parsed results on the gold set | any inequality |
| wire | accounting `accepted + violations + skipped == non_blank_lines` | any mismatch |
| wire | parser throws on random bytes / truncation / null | > 0 |
| wire | an out-of-roster alias resolved to a guess instead of null | > 0 |
| wire | emphasis-wrapped lines recovered rather than rejected | < 100% |
| wire | measured char saving vs JSON | **reported, never asserted** |
| party | party_pair derived by code, never emitted by a model | any model emission |
| party | all 9 pairs correct vs gold | < 0.98 |
| party | a thread with no `s` in any loop pair surfaced as a space | **> 0** |
| party | `oo` loops appearing in the user's task list | **> 0** |
| archetype | accuracy across all 8 shapes vs gold | < 0.85 |
| promotion | reference/recurrence-route threads promoted vs gold | < 0.85 |
| promotion | promotion_reason recorded on every promoted thread | < 100% |
| **confluence** | **same corpus ingested in 3 different orders → identical final graph** | **any divergence** |
| confluence | precedence ever decided by ingested_at rather than stated_at | > 0 |
| confluence | an older claim arriving late dislodges a newer active claim | > 0 |
| loops | recurring loop from >1y-old evidence with a future next occurrence marked live | < 100% |
| loops | past-due non-recurring loop from backfill surfacing as a task | > 0 |
| loops | done/lapsed loops extracted and retained (not skipped) | < 100% |
| claims | claims age-filtered out of old history | > 0 |
| enrichment | update pass triggered by an information-free caption | > 5% |
| scheduler | any gap with zero completed work while cohorts remain (excl. quota pause) | > 90 s |
| scheduler | processing order is recency-descending across all streams | any inversion |
| scheduler | coverage monotonic (never regresses) | any regression |
| scheduler | restart mid-import resumes without re-judging verdicts | any re-judge |
| scheduler | bootstrap sessions sealed with `seal_mode=immediate` | < 100% |
| scheduler | live event pre-empts backfill at next cohort boundary | > 1 cohort delay |
| enrichment | late enrichment reprocessed into its **original** session/episode | < 100% |
| enrichment | duplicate claims created by reprocess | > 0 |
| enrichment | media queue ordered by cohort priority (not FIFO) | any inversion |
| enrichment | a slow attachment delays understanding of its session's text | > 0 |
| enrichment | passes per episode with media (expect exactly 2) | ≠ 2 without late media |
| enrichment | image batch size honoured (default 16) | < 10 without a mismatch retry |
| enrichment | a caption attached to the wrong image | **> 0** |
| enrichment | mismatched batch applied partially instead of split-and-retried | > 0 |
| enrichment | every image and sticker captioned at default settings | < 100% |
| accounting | `total_input = read + create + input` holds on every run row | any mismatch |
| accounting | input and cache columns presented as separate spend | > 0 |
| accounting | cost and tokens aggregated over different filters | > 0 |
| accounting | a run lacking `role` or `cohort_id` attribution | > 0 |
| accounting | quota gated on a raw token sum instead of `billable_tokens` | > 0 |
| caching | measured hit rate reported in Settings (not assumed) | absent |
| caching | parallel fan-out issued before the warm call returns | > 0 when warm_first on |
| enrichment | routed to correct executor | < 100% |
| enrichment | ambient prefilter drop ratio | < 90% |
| sessions | boundary F1 vs gold (all 5 kinds, both seal modes) | < 0.90 |
| sessions | segmentation determinism | any drift |
| sessions | explainable boundaries | < 100% |
| entities | resolution precision / recall | < 0.98 / < 0.90 |
| entities | identities silently guessed | > 0 |
| entities | mention linking accuracy | < 0.92 |
| entities | edge precision · metadata edges captured | < 0.90 · < 100% |
| episodes | 1:1 default rate | < 60% |
| episodes | split / attach accuracy | < 0.85 |
| episodes | wrong-attach rate | > 2% |
| episodes | verdict replay determinism | any drift |
| arcs | recall on bridge-joinable pairs | < 0.95 |
| arcs | precision | < 0.90 |
| arcs | ambient joined by similarity alone | > 0 |
| arcs | arc-id stability across full re-derivation | < 100% |
| claims | subject / attribution accuracy | < 0.95 / < 0.95 |
| claims | third-person resolution | < 0.98 |
| claims | duplicates surviving the write path | > 2% |
| claims | out-of-order supersession correct (older claim → predecessor) | < 0.95 |
| loops | precision / recall on explicit | < 0.90 / < 0.90 |
| loops | implicit precision | < 0.70 |
| loops | triage accuracy · done-detection precision | < 0.90 · < 0.95 |
| loops | born past-due marked open | > 0 |
| loops | owned by non-user appearing as tasks | > 0 |
| spaces | count vs gold · archetype accuracy | ±25% · < 0.85 |
| all | user corrections surviving re-derivation | < 100% |
| all | **model output discarded by code** | **> 0** |
| calib | similarity run with stale/absent calibration | > 0 |

**The `model output discarded by code` row is the one that killed four systems. It must never move off zero.**

### 14.3 Acceptance against the real corpus

~3,000 WhatsApp events, then re-run with Calendar + Contacts added.

| # | Question | Prior result | Target |
|---|---|---|---|
| 1 | **first claims + tasks + spaces visible (cold connect)** | n/a | **≤ 120 s** |
| 1b | **new message → its claims/tasks visible (steady state)** | up to 45 min | **≤ 45 s at default setting** |
| 1c | same corpus ingested in 3 different orders | n/a | **identical final graph** |
| 2 | longest silent gap during a full import | unbounded | ≤ 90 s |
| 3 | output grows monotonically, no retractions | n/a | 100% |
| 4 | media understood in its own session with its own context | n/a | 100% |
| 5 | sessions matching human judgment of "one conversation" | n/a | F1 ≥ 0.90 |
| 6 | distinct entities vs raw actor rows | 132 people, 98 orphaned | resolved 1:1 |
| 7 | slug-shaped subjects (`papa-new-number-jio`) | present | **0** |
| 8 | ambiguous identities asked rather than guessed | n/a | 100% |
| 9 | arcs from this corpus | n/a | ≤ 50 |
| 10 | spaces holding a live loop with user stake | 5 / 23 (22%) | **> 90%** |
| 11 | total spaces | 87 | **≤ 45** |
| 12 | other people's lives rendered as spaces | 8 | **0** |
| 13 | claims ever superseded | 0 / 381 | **chain functioning** |
| 14 | near-duplicate claim pairs | 19 | **0** |
| 15 | tasks born past-due as `open` | 2 | **0** |
| 16 | tasks owned by a non-user, actionable | 1 | **0** |
| 17 | content living in two containers | ≥ 1 | **0** |
| 18 | tasks parked in `possibly_done` | 27 | **0 (state removed)** |
| 19 | temporal-boundary loops captured | 0 | **tracked, > 0** |
| 20 | goals scaffolded without evidence | 3 tautologies | **0** |
| 21 | steady-state model calls per quiet day | n/a | ≤ 12 |
| 22 | **cross-source: a space whose arc spans WhatsApp + Calendar via a bridge** | n/a | **> 0, precision 1.0** |

**Row 1 proves the product is alive. Row 22 proves the thesis.**

---

## 16. Build order

```
 ── PRELUDE ─────────────────────────────────────────────────────────────
 B0  EVAL HARNESS + 1,000-unit GOLD SET (incl. scheduler fixtures) [code+human]
 B1a ★ STW-2 WIRE CODEC ..................................... [code]
       packer (#R #C #E #T #D events #COV) · codec (23 tags) ·
       enum tables · tolerance (fences, emphasis, drift, tokens) ·
       violations + one bounded repair round · round-trip CI gate
 B1  CLI BARE-CALL CONTRACT ................................ [code]
       all levers default-on · 8 new MODEL_ROLES · thinking ladder ·
       schema validation + repair retry · refusal-pattern lane pause ·
       cwd = tmpdir() · per-resource-class concurrency caps
       ★ 4-way token accounting + cost correctness + Usage surface
       ★ warm-then-fan-out + measured cache hit rate (never assumed)
 B2  DELETE store.ts · brain/writers.ts · migrations 0004-06 . [code]
       + leak fixes + REMOVE all rowid/FIFO ordering assumptions

 ── PHASE A — foundations to sessions ────────────────────────────────────
 B3  ADAPTER REGISTRY + manifests + stream_id migration ..... [code]
       + backfill_order=desc negotiation, asc buffering
 B4  ★ COHORT SCHEDULER ..................................... [code]
       STREAM TIERS T1-T4 + P-TI1 channel classifier + boot backfill
       tier-change RE-SCAN (never orphan events, never rewind watermark)
       first-paint path: P-CL1 only · adjudicators barred · Lane E
       yields all slots · CLI pre-warm · output-token cohort sizing
       LINE-STREAMING to surfaces (every \n is a complete record)
       modes · horizon ladder · adaptive budget ramp · priority queue ·
       two lanes with lookahead · pacing · coverage · restart resume
 B5  EMBEDDER CALIBRATION ................................... [code+ML]
 B6  SALIENCE PREFILTER scaffold ............................ [code+ML]
 B7  ★ ASYNC ENRICHMENT + priority queue ..................... [code+ML+LLM-S]
       16-image batching + id-echo validation + binary split retry
       two-pass model: text now, complete once all media resolves
       per-resource-class concurrency caps + 40/60 LLM pool split
       salience gate (OFF by default) · delta context mode (summary)
 B7b ★ PARTY MODEL — role() + 9-pair derivation ............. [code]
       zero model burden, zero wire bytes; the "not your space" rule
 B8  ENTITY GRAPH tables · structural binding · me-entity .... [code]
       metadata edges · tombstones · negative pairs
 B9  P-EP1 + resolution ladder + P-AG1 agent ................. [LLM-S/agent]
       batched adjudication during bootstrap
 B10 SESSIONS — 5 segmenters, dual seal modes, hash gate, .... [code]
       reactions/edits/revokes, tz, restarts, late arrivals
 B11 SURFACES: Entities, Sessions + coverage meters .......... [code]
 GATE A: session F1 ≥0.90 · determinism exact · entity precision ≥0.98 ·
         zero silent guesses · scheduler order/coverage gates green.
         Then add Calendar + Contacts and prove cross-source identity.

 ── PHASE B — episodes and arcs ──────────────────────────────────────────
 B12 EPISODES: hash gate · drift pre-flag · 1:1 default ...... [code+ML+LLM-M]
       P-EP2 · verdicts · partition invariant · aging
 B13 BRIDGE EXTRACTOR (8 kinds) ............................. [code]
 B14 ARCS: ladder ①→④ · P-AG2 · provisional · reconcile ...... [code+ML+LLM-M]
       cohort-boundary reconcile · arc_key stability · P-LB1
 B15 SURFACES: Episodes, Arcs ............................... [code]
 GATE B: 1:1 rate ≥60% · bridge recall ≥0.95 · arc precision ≥0.90 ·
         arc-id stability 100% · a WhatsApp↔Calendar bridged arc exists.

 ── PHASE C — claims, spaces, tasks ──────────────────────────────────────
 B16 P-CL1 UNDERSTANDING CALL + P-CL1Δ DELTA VARIANT ........ [LLM-M]
       ★ LIVE TRIGGER (configurable 30 s – 6 h, default 30 s)
       backpressure · 20/hr cap · conditional consolidation at seal
 B17 CODE FACTS ............................................. [code]
 B18 WRITE PATH: keys · reinforce · P-AG3 · supersede ....... [code+ML+LLM-M]
       out-of-order (newest-first) supersession semantics
 B19 PROMOTION on arcs (4 routes) + P-SP1 8 archetypes ...... [code+LLM-S]
       promoted/promotion_reason/archetype/status as arc FIELDS —
       no spaces table, no id sync, demotion is the flag flipping back
 B20 P-TR1 TRIAGE + P-DD1 DONE-DETECTION + question path .... [LLM-S]
       [CODE] pre-check resolves most historical loops call-free
 B21 GOAL EMERGENCE + RECONCILE (cohort + nightly) .......... [code]
 B22 SURFACES: Claims, Spaces, Tasks + coverage meters ...... [code]
 GATE C: §14.2 green (incl. the 120 s row) · §14.3 rows 1–21 hit ·
         row 22 hit with Calendar. Only then build above this layer.
```

**B4, B7 and B10 are the control-plane thesis:** order by recency, bound work by cohort, hide enrichment latency behind a lookahead lane, never stall, and let late media re-enter its own chunk idempotently.
**B8–B19 are the model thesis:** minted entity ids, deterministic explainable boundaries, exact cross-source binding before fuzzy, no container choice, idempotent writes, derived spaces.

---

## 17. The paragraph to remember

A session is one burst of one stream, cut by rules you can read. An episode is one topic. An arc is one thread of a life, wherever it was recorded. Claims describe, loops intend, a space is an arc that holds a live loop, and a task is a loop you own. History is read newest-first in bounded cohorts, so the first claims, tasks and spaces appear within two minutes and the rest fills in behind them without a pause; a voice note that takes forty seconds to transcribe re-enters the exact session it came from and is understood beside the messages that surrounded it. Code does everything deterministic, whisper and e5 do the cheap perception, a small model reads what needs reading with no tools and no personality, a mid-size model judges only real ambiguity, and anything still unclear becomes a one-tap question, never a guess.
