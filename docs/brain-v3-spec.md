# Brain v3 — Specification
**Status:** design, build against this. Supersedes `brain-v2-spec.md` as the build target. The v2 spec stays as the detailed reference for schema DDL, validation rules and the predicate vocabulary — v3 changes how the system _runs_, not what it _stores_.

**What v3 is.** The comprehension layer of SuperTwin: raw events from any source become spaces, commitments, claims, rhythms, a CRM and a user model — correct, cited, and correctable. Built from a forensic audit of all three shipped versions (Appendix A).

**Core decisions:**

1. **Two modes** — bootstrap (bulk history) and steady state (live data) are different problems with different machinery.
  
2. **Fast first, deep later** — the user sees results from recent data within minutes of connecting a source. Old history fills in behind.
  
3. **Batched calls, no budgets** — never a cap, never a per-artifact call. Every Claude CLI call carries ~59k tokens of system-prompt overhead, so the cheapest token is the call you didn't make.
  
4. **Raw chunks are the unit of understanding** — summaries (dossiers) route, they never author.
  
5. **Everything passes through comprehension** — records and signals are enriched deterministically, but an LLM still makes sense of them and relates them to the rest of the life.
  
6. **Haiku everywhere by default** — the winner ran entirely on Haiku. Model per process is a Settings choice, not a hardcode.
  

The agent society (Scout, Cartographer, Investigator, Critic, Curator, Auditor, Watcher) stays. It runs in waves, batched, with checkpoints.

* * *
## Contents
1. [Goal](#1-goal)
  
2. [Non-negotiables](#2-non-negotiables)
  
3. [What is stored](#3-what-is-stored)
  
4. [Chunks — the unit of understanding](#4-chunks)
  
5. [The two modes](#5-the-two-modes)
  
6. [Mode 1 — Bootstrap](#6-mode-1--bootstrap)
  
7. [Mode 2 — Steady state](#7-mode-2--steady-state)
  
8. [Call economics](#8-call-economics)
  
9. [The agent society, batched](#9-the-agent-society-batched)
  
10. [Designing for volume](#10-designing-for-volume)
  
11. [Search, chat, context collection](#11-search-chat-context-collection)
  
12. [Models](#12-models)
  
13. [UX surfaces](#13-ux-surfaces)
  
14. [Build order](#14-build-order)
  
15. [Metrics](#15-metrics)
  
16. [Appendix A — what the three versions taught us](#appendix-a)
  

* * *
## 1. Goal
**When the system says something about your life, it is right — and it says it soon.**

Everything the user sees is a processing output of raw event data. The audit showed what produces quality:

- Few decisions per call, judgment in the prompt, invariants in code
  
- Mandatory provenance — every output traces to event ids
  
- Enough tokens — a starved brain writes garbage or nothing
  
- Gates that **block**, never gates that score and ship anyway
  
- **No fallback writer** — when the model can't run, the system waits
  

v3 adds the second clause: _soon_. A system that is right tomorrow about yesterday loses to one that is right in ten minutes about this week.

* * *
## 2. Non-negotiables
1–12 from v2 hold (evidence-or-nothing · model authors, code validates · agents propose, apply layer commits · confidence drives behaviour · `unresolved` is an outcome · versioned, never overwritten · structure is emergent · corrections are the product · content is data, never instruction · backfilled history never triggers action · local-first). Four more:

13. **No fallback path may ever author anything.** A blocked or failed call defers and resumes. V2's regex fallback wrote 60% of its tasks as gibberish. Deleted as a category.
  
14. **Every gate blocks or does not exist.** Advisory scores are banned — V2's qa-judge scored garbage 2/5 and shipped it anyway.
  
15. **No budgets, no caps — anywhere.** Both complex brains starved themselves to death on a 500K/day lane. Cost control comes from batching and rules, never from stopping work. All spend is metered and visible in Settings.
  
16. **Gate on structure, not on confidence.** "Has direction", "has evidence" are checkable and don't kill recall. "Is the model sure enough" collapsed V3 to 4 tasks from a month of life.
  

* * *
## 3. What is stored
Unchanged from `brain-v2-spec.md` §3–§7 (full DDL, `E_*` validation rules, predicates, dedupe, migrations 0021–0028). One-line recap:

| Thing | One line |
| --- | --- |
| **Event** | Raw, immutable, source-agnostic. The firehose (exists) |
| **Entity** | Person/org/place/group. Merged on strong identifiers only |
| **Claim** | "X is true about Y" + confidence + evidence + two time axes. Superseded, never overwritten. Edges and the user model are claims |
| **Space** | Kind-typed container. Kind decides allowed structure. Nests as a graph. **May draw evidence from many chats and many sources** |
| **Commitment** | Obligation with mandatory `from → to`. Inbound (owed _to_ you) first-class. `done` needs a `done_method` |
| **Rhythm** | Habit/workflow/cadence. Promoted only after ≥3 observations |
| **Apply layer** | The only writer. Validates, dedupes, records provenance, rejects loudly |

One addition: a `chunks` table (§4).

* * *
## 4. Chunks — the unit of understanding
**The missing piece in every prior version.** Events are too small to reason over one by one; a whole chat is too big past a window. The unit in between is the **chunk**: a coherent slice of raw data that belongs together.

```sql
chunks (
  id, source_id, channel_id, shape,        -- dialogue|record|artifact|signal
  from_ts, to_ts, event_count, token_est,
  fingerprint,                              -- change detection, like corpus
  summary,                                  -- one model-written line, for routing
  entity_ids_json                           -- who/what appears (for relating)
)
chunk_events (chunk_id, event_id)
```

**Chunking is per-source, deterministic, cheap:**

| Source shape | Chunk boundary |
| --- | --- |
| Dialogue (WhatsApp, DMs, Slack) | Conversation burst: time-gap lull (>4h) or day boundary, ≤ ~200 events. A thread that spans days stays linked via the space, not the chunk |
| Email | The thread. One thread = one chunk |
| Records (orders, bills, bookings) | Per account per month |
| Browser / YouTube history | Session: gap > 30 min |
| Saves / bookmarks | Per batch of saving activity |

**Chunks are related, across chats and sources.** Two chunks are linked when they share entities, overlap in time, or an agent says they discuss the same thing. This is how "the Goa trip" pulls from a group chat + a DM + a flight receipt email + hotel browsing — one space, many chunks, many sources.

**Rules:**

- **Reading = raw chunks, always.** Spaces, commitments, claims are extracted from raw chunk text — never from summaries. Summaries lose the exact line that carries the signal.
  
- **A chunk is the retrieval unit too.** Search returns chunks; chat context packs chunks; re-reads re-read chunks.
  
- New events extend the open chunk of their channel; a closed chunk whose events change (edit, late transcript) reopens via fingerprint.
  

**Dossiers demoted.** A dossier is a per-relationship _map_: who this is, what's live, which chunks matter. Agents use it to **decide which chunks to read**. No artifact is ever authored from a dossier — the dossier routes, raw chunks author.

* * *
## 5. The two modes
|     | **Bootstrap** | **Steady state** |
| --- | --- | --- |
| Trigger | Connecting a source / extending range | New events arriving |
| Data | Months or years, at once | A trickle |
| Latency | **Fast window: minutes. Deep history: background** | Minutes |
| Unit | Waves over chunk sets | Micro-batches |
| Actions | **Never** — historical data is read-only | Normal approval tiers |
| Failure | Checkpoint, resume | Defer, retry |

* * *
## 6. Mode 1 — Bootstrap
### 6.1 Two passes: fast, then deep
The user will not stare at a progress bar for hours. Bootstrap runs the same waves twice:

|     | **Fast pass** | **Deep pass** |
| --- | --- | --- |
| Window | Last **30 days** (configurable: 7 / 15 / 30 / 90) | Everything older (configurable end) |
| Priority | Runs first, end to end | Starts after fast pass completes; background |
| Target | **First spaces/commitments on screen in ~10–20 min** for a typical month | Hours to a day for a year; resumable across days |
| UI  | Surfaces populate live as waves complete | "History filling in: 34%…" banner; artifacts refine as old evidence lands |

Old evidence arriving later **updates** existing artifacts through the same apply layer (claims gain validity windows, spaces gain history, commitments found already-resolved get `done`). Deep pass never duplicates — deterministic ids and dedupe-by-meaning make re-touching convergent.

Both windows are settings. A user who wants everything fast can widen the fast window and pay the wait.
### 6.2 The waves (per pass)
```
W0  INGEST + ENRICH
    Daemon imports → events (is_historical=1). Chunker runs per source.
    Enrich: transcription + embeddings (local, free) · image/video
    description + link understanding (LLM vision — cheap, BATCHED many
    images per call, but not $0). [mostly exists]

W1  RESOLVE            deterministic
    Contacts first (ground truth), then entities from senders/actors.
    Strong identifiers only. Businesses = orgs, never people.

W2  CHUNK + RELATE     deterministic + one cheap batched pass
    Chunk boundaries cut. One batched LLM pass writes one-line chunk
    summaries + entity tags (hundreds of chunks per call). Chunk graph
    linked (shared entities, time overlap).

W3  COMPREHEND (Scout wave)      the main spend
    Reads RAW CHUNKS, packed (§8): big chats in month-windows, small
    chats bundled by social cluster, and — this is new — RELATED
    record/signal chunks ride in the same call as the dialogue they
    belong with (the flight receipt next to the trip planning chat).
    Output per call: proposals (entities, claims, commitments both
    directions incl. ALREADY-RESOLVED ones, space candidates, rhythm
    observations) + dossier updates. Checkpoint per chunk.

W4  CARTOGRAPHER
    Clusters chunk/dossier maps deterministically, then packed calls per
    cluster group. Decides: space kinds, nesting, merges ACROSS chats and
    ACROSS sources. Never a per-space call.

W5  INVESTIGATE + CRITICIZE      batched
    Open ambiguities grouped by shared context → packed investigation
    calls (many questions per call; answers come from raw chunks).
    Critic falsifies the whole proposal set, dozens of artifacts per
    call, against raw chunk evidence. Flags block (rule 14).

W6  CURATE + ELICIT
    Curator ranks, suppresses, writes the Brief, picks the ≤15
    highest-value questions. Fast pass: flips surfaces live.
```

**Resume rules:** a wave interrupted at chunk N restarts at chunk N. A failed call defers the item, not the wave. Three real failures (not deferral) quarantine the item loudly. Partial output is always kept.

**Cost, honest, uncapped:** 1 year of WhatsApp ≈ 1M dialogue tokens. Comprehension ≈ $15–50 on Haiku with packed calls; enrichment (vision) and the other waves ≈ $10–25. Live meter in Settings; never stopped.

* * *
## 7. Mode 2 — Steady state
Live events flow through **micro-batches**: lull timer (10 min quiet) or size trigger (≥50 pending), whichever first.

```
event arrives → chunker extends open chunk
   │
   ▼
WATCHER — rules first, then ONE packed call per micro-batch
   Deterministic pre-triage at $0 where certain: exact-format OTPs,
   known-noise channels, media → enrich queue. Everything uncertain goes
   to the model — classification is judgment, not regex (a "receipt" or
   "spam" call by rule alone is how marketing became tasks).
   The single packed call handles the whole batch: route chunks to
   spaces · new commitments (both directions) · RESOLVED-detection
   against open commitments (evidence event cited → done_method='stated'
   or queued for 'verified') · claim updates · escalations.
   │
   ├── escalations → next Investigator sweep (batched)
   ▼
APPLY → substrate → projections (corpus, chunk summaries, wiki, self.md)
```
### Scheduled work — frequent, triggered, small
Nightly/weekly batch jobs leave stale wrongness on screen for hours. Instead:

| Job | Cadence | Work |
| --- | --- | --- |
| **Consolidate** | Every **3–6 h**, triggered early by ≥N applied updates, skipped when idle | Fold chunk deltas into dossiers · recompute rhythms · regenerate self.md + wiki · git commit · Critic pass over artifacts created since last run (one packed call) |
| **Re-verify** | **Rolling, continuous** — not a weekly big-bang | Auditor re-reads the oldest-verified artifacts against raw chunks, N per call; fast-volatility claims checked first; drift → fix jobs |
| **Curate** | With each consolidate | Brief refresh, question queue re-rank |
| On correction | Immediately | Re-derive downstream, bounded blast radius |

Steady-state cost: rules + batching keep it to single-digit dollars/month — as an _outcome_ of design, not a cap.

* * *
## 8. Call economics
Design constraints, not optimizations:

1. **Every call costs ~59k tokens before it says a word** (Claude CLI system prompt). Ten calls doing one thing each waste half a million tokens. Minimum call count is the first-order cost lever.
  
2. **Pack every call to ~70% of the context window** with input; the rest is instructions and output room.
  
3. **Never one call per artifact.** One call emits all artifacts for all touched chunks/spaces, as one structured output. Critic reviews dozens per call. Investigator answers many questions per call. Vision describes many images per call.
  
4. **Bundle small, split big.** Small chats ride together grouped by social cluster; big chats split by month with dossier carry-forward.
  
5. **Read whole within a unit.** Bundling across chats is fine; chunking _inside_ a conversation burst is not — chronology must survive within the chunk.
  
6. **One model per wave** — byte-stable system prompt, cache reuse intact.
  
7. **Deterministic where certainty is real** — id-minting, dedupe, validation, promotion gates, FTS, graph hops, fusion math, exact-format matches. **LLM where meaning is involved** — including "is this email a receipt", "is this message noise". Classification by regex is how marketing blasts became financial tasks.
  
8. **Local models are free — use them in bulk.** Whisper, embeddings, ffmpeg run on everything, no rationing.
  

* * *
## 9. The agent society, batched
| Agent | Job | Bootstrap | Steady state | Batching |
| --- | --- | --- | --- | --- |
| **Scout** | Comprehend raw chunks → proposals | W3, main spend | Absorbed into Watcher; full re-read on correction/audit | Chunks packed by cluster; records/signals ride with related dialogue |
| **Cartographer** | Space map: kinds, nesting, cross-chat/cross-source merges | W4  | On ≥N new space candidates | Deterministic cluster → packed calls |
| **Investigator** | Resolve ambiguity from raw chunks | W5  | Sweeps when questions accumulate or block a surface | Many questions per call, grouped by shared context; returns evidence or "cannot determine" |
| **Critic** | Falsify against raw chunk evidence | W5  | Each consolidate cycle | Dozens of artifacts per call. **A flag blocks** |
| **Curator** | Rank, suppress, Brief, questions | W6  | Each consolidate cycle | One call, whole picture |
| **Auditor** | Find what is wrong | —   | Rolling re-verify | N artifacts per call, oldest-verified + fast-volatility first |
| **Watcher** | Triage live micro-batches | —   | Every micro-batch | Rules where certain, one packed call for everything else |

Shared read toolset for all seven plus chat: `search`, `read_chunk`, `read_around`, `who_is`, `timeline`, `recall`, `owed`, `transcribe`, `unfurl`. One toolset, so roles cannot drift.

Per-call context is bounded by physics; when input exceeds it, the agent returns what it has plus `unresolved` — never a guess, never a fallback writer. There are no token allowances beyond that (rule 15).

* * *
## 10. Designing for volume
Sources split by shape. Every shape is **enriched** by the right machinery and **understood** by the LLM — enrichment ≠ comprehension:

| Shape | Sources | Enrichment (cheap/free) | Comprehension (LLM, batched) |
| --- | --- | --- | --- |
| Dialogue | WhatsApp, iMessage, Slack, IG DMs, human email threads | transcripts, media descriptions, link text | Scout reads raw chunks — the main spend |
| Record | Order/bill/booking emails, bank alerts, calendar, contacts | field extraction where fields truly exist (calendar times, contact cards) | Batched classification + sense-making; related to dialogue chunks (receipt ↔ trip) |
| Artifact | Files, PDFs, docs, AI-chat exports | text extraction, embeddings | Read on demand; claims at low confidence |
| Signal | Browser, YouTube, Instagram saves, Spotify | session chunking, counts | Batched interpretation → `interested_in` claims, rhythm observations, Collection items |

**The structural safety stays:** signal- and record-origin proposals **cannot become commitments** unless explicit terms exist (amount + due date, stated). Consumption is never obligation — enforced at the apply layer by origin, not by hoping the prompt behaves.

Scale numbers:

|     | 30d WhatsApp | 1y WhatsApp | 1y × 5 sources |
| --- | --- | --- | --- |
| Events | ~4.3k | ~52k | ~250k+ |
| Chunks | ~600 | ~7k | ~25k |
| Comprehension input | ~85k tok | ~1M tok | ~1.5M tok |
| Claims (reasoning surface) | ~2k | ~20k | ~60k |

Engineering blockers at this scale:

- [ ] 
  
  **Vector index** (`sqlite-vec` or equivalent) before multi-source — brute-force cosine dies past ~100k vectors
  
- [ ] 
  
  **Hierarchical Cartographer** — cluster → map → merge maps; never all dossiers in one call; incremental after bootstrap
  
- [ ] 
  
  **Corpus + chunk sharding** by month past ~5k messages/chat
  
- [ ] 
  
  **Recency tiering** — fast window always full-quality; older low-signal chats may take the bundled path
  
- [ ] 
  
  **Correction blast radius bounded** — re-derive direct dependents, not every chunk an entity appears in
  
- [ ] 
  
  **Context packing policy** — rank by confidence × recency × relevance × predicate priority; commitments and self-model get reserved slots
  

* * *
## 11. Search, chat, context collection
**Agentic-first.** The fused index is the accelerator; the agent loop is the search. Chat, search and every agent collect context the same way:

```
question → planner (one small call: entities, time, as_of, intent)
        → parallel engines: FTS · vectors · SQL · graph hops   (fast, $0)
        → fused candidates (RRF) = starting set of CHUNKS + claims
        → AGENTIC LOOP: the model reads the candidates and then goes and
          gets what's missing — read_chunk, read_around, who_is, timeline,
          recall, owed — iterating until it can answer or knows it can't
        → answer with [n] citations → deterministic validation
```

- Claims arrive with confidence + validity window visible; conflicting claims both shown, never silently resolved.
  
- Every factual sentence cites a claim or event id. Validation: citations resolve · no uncited assertions · no superseded claim as current · no raw identifiers. Failures counted and alarmed.
  
- "I don't have anything on that" is a correct, reachable answer.
  
- Verify pass on high-stakes answers (money, health, dates, commitments).
  
- "Why this answer?" expands the exact chunks and claims used.
  

* * *
## 12. Models
**Default: Haiku for every process.** The winner ran 455/456 calls on Haiku with zero failures; capability was never the bottleneck — structure was.

Settings exposes a **per-process model picker** (extends V8's existing chat/media roles):

| Role | Default |
| --- | --- |
| chat | subscription default |
| media (vision) | haiku |
| scout / comprehend | haiku |
| cartographer | haiku |
| investigator | haiku |
| critic | haiku — _different model recommended when available_ |
| curator / brief | haiku |
| watcher | haiku |
| auditor | haiku |
| planner (search) | haiku |

Rules: one model per wave (cache reuse) · Critic should differ from the author when the subscription allows · every call logged to `extraction_runs` with role, model, all four token counts, cost.

* * *
## 13. UX surfaces
Global rules: nothing appears without a tappable "why" (evidence) · uncertainty visible below 0.8 confidence · correction is one tap, everywhere · memory types are views (episodic = Timeline, semantic = Facts + CRM, procedural = Rhythms, user model = Self, working = "why this answer?").

| #   | Surface | What it shows |
| --- | --- | --- |
| 1   | **Brief** | Front door. Model-written prose catching you up: what moved, what you owe, what's owed to you, what's stuck. Every noun tappable, every sentence correctable |
| 2   | **Messages** | The WhatsApp inbox (exists today) — raw chats, media, search within chats. Stays. Future sources add their views here |
| 3   | **Spaces** | The life map, by kind, nested. Each space shows badges: **one-time / recurring · permanent / ephemeral · long-term / short-term** (derived from kind + recurrence + ends_at). Goals/milestones only where the kind allows. Merge/split/rename/pin = one tap |
| 4   | **People (CRM)** | Every person/org: relationship, shared spaces, claims with confidence, **owed in both directions**, tone/dictionary, timeline. Businesses separated from humans |
| 5   | **Commitments** | Two lists: **You owe** / **Owed to you** — grouped by space, never a flat dump. Same badges as spaces (one-time/recurring · short/long-term). Direction, due date, evidence, done-method visible. **Resolved ones shown as resolved with their evidence** — the system notices when history shows a thing already happened. Approve/snooze/dismiss inline; implicit suggestions visually distinct |
| 6   | **Facts** | Claims browser: filter by person/space/predicate/confidence/privacy. Each claim: evidence, validity window, belief history. One-tap correct/confirm |
| 7   | **Self** | The user model: preferences, voice, boundaries, goals, dictionary — editable, pinnable. Shows exactly what's injected into every conversation |
| 8   | **Timeline** | Episodic memory: chronological, filterable by person/space/source/kind |
| 9   | **Rhythms** | Habits/workflows/cadences: confirmed vs candidates, evidence counts, confirm/dismiss |
| 10  | **Chat + Search** | One box. Grounded, cited answers; "why this answer?"; agentic lookups visible ("checking…") |
| 11  | **Attention** | One queue for everything that wants the user: elicitation questions (ranked), approvals, low-confidence artifacts awaiting a nod, digest of what changed |
| 12  | **Settings** | Exists, extended: source connections + import ranges (fast/deep windows) · **per-process model picker (§12)** · **full token/cost accounting — every call, every agent, every process, per day and per bootstrap, with the four token counts and cost** · runs viewer · brain folder · kill switch |
| 13  | **Health** | Bootstrap progress (pass, wave, %, live cost, ETA) · steady-state stats · apply reject rate by agent/code · chat validation failures · correction rate · quarantine with reasons |

* * *
## 14. Build order
| Phase | What | Gate |
| --- | --- | --- |
| 0   | **Eval harness + generate the labelled set.** No labelled data exists today. Build the harness, then produce the set during development: (a) run the pipeline on the real corpus, (b) surface outputs in a labelling UI (correct / wrong / partial — one tap), (c) bank ~200 labelled items + every known failure from the audit as failing tests, (d) synthetic edge cases (Hinglish, forwards, broadcasts) as supplements | Harness scores an empty system; labelling UI works |
| 1   | Substrate + apply layer (v2 migrations 0021–0028) **+ chunks tables** | Fresh + upgraded DB boot green; malformed proposals rejected loudly |
| 2   | Resolve: contacts-first, entities, identifiers | Zero name-only merges; businesses ≠ people |
| 3   | Chunker (per-source rules) + chunk graph + read toolset | Chunks cover 100% of events; tools tested on real corpus |
| 4   | **Bootstrap fast pass** (W0–W6 on the fast window) with live progress UI | Fast window on screen in ~10–20 min; spaces ≥ simple-brain quality on same data; zero gibberish; zero invented goals; kill-and-resume loses nothing |
| 5   | **Bootstrap deep pass** — background, resumable, convergent | 1-year import completes across restarts; second run creates zero new artifacts |
| 6   | Commitments: direction, inbound, **resolved-detection** | Direction ≥95%; misattribution = 0; already-resolved history commitments marked done with evidence |
| 7   | Investigator + Critic (batched, blocking) + Curator + elicitation | Critic catches ≥90% of seeded false claims; ≤15 questions |
| 8   | **Steady state**: Watcher micro-batches, 3–6h consolidate, rolling re-verify | Event → surfaced artifact <15 min p50; consolidate triggers on update count |
| 9   | Chat + search (agentic loop) + answer validation | Citation validity ≥95% |
| 10  | Correction loop + surfaces 1–13 | Correction re-derives downstream in one run |
| 11  | Scale hardening: sqlite-vec, sharding, 1-year test | Search p95 <500ms at 250k events |
| 12  | Second source (email: dialogue/record split via chunker) | Zero brain changes — adapter + chunk rules only |

Gate 4 is the moment of truth: **v3's fast pass must beat the simple brain on its own corpus** before anything else is built.

* * *
## 15. Metrics
Correctness:

- Misattributed commitments **0** · direction ≥95% · duplicates <2%
  
- Invented goals **0** · gibberish titles **0** · superseded-claim-as-current **0**
  
- Citation validity ≥95% · calibration ±10% per bucket
  

Coverage (precision without recall is failure):

- Spaces naming real life-threads ≥ simple brain on same corpus
  
- Commitments ≥100/month of dialogue · inbound >20 · **resolved-detected with evidence >0**
  
- Chats dropped/quarantined **0** · events chunked 100%
  

Latency:

- Source connect → first artifacts on screen: **≤20 min** (fast window)
  
- Live event → surfaced artifact: <15 min p50
  
- Consolidate staleness: never >6 h with pending updates
  

Throughput & convergence:

- Deep pass resumable; kill-and-restart loses zero work
  
- Full re-run creates zero new artifacts
  
- Call count per 1k events tracked — trending down is a feature
  

Learning:

- Corrections change behaviour within one run: 100%
  
- ≤15 onboarding questions resolving ≥80% of flagged ambiguity
  
- Day-60 quality ≥ day-30
  

* * *
## Appendix A — what the three versions taught us
Measured from the real databases, July 2026.

|     | V2 (complex) | V3 (simplified) | Whatsapp (simple) |
| --- | --- | --- | --- |
| Spaces | 6 from 100 chats, 2 dupes | 18, all real | **55, ~50 real, 0 gibberish** |
| Tasks | 42, **60% gibberish** | 4 (recall collapse) | **155, 0 gibberish** |
| Facts/claims | 12, 3 contradictory | 103, evidence-linked | —   |
| Cost | starved at 500K cap in 24 min | $1.40, starved | $10.34, uncapped, 0 errors |
| Provenance | partial | 100% | 100% of tasks |

The lessons this spec is built on:

1. **Starvation, not stupidity.** Both complex brains hard-stopped on a self-imposed daily cap mid-bootstrap. → rule 15, no budgets anywhere.
  
2. **The fallback writer was the garbage factory.** V2's regex path authored "Pay aapna Lil to tight". → rule 13.
  
3. **Advisory gates ship junk.** qa-judge scored the gibberish 2/5 and it went into every brief. → rule 14.
  
4. **Over-gating on confidence killed recall.** V3: 4 tasks, all correct, nearly useless. → rule 16.
  
5. **Deterministic classification misfiles meaning.** Regex-tier triage is how marketing blasts became financial tasks. → §8 rule 7: rules only where certainty is real; meaning goes to the model, batched.
  
6. **The winner's shape holds:** two decision stages, judgment in the prompt ("precision over recall — a wrong inference erodes trust"), invariants in code, deterministic ids, 100% provenance, INSERT OR IGNORE convergence — all on Haiku. v3 keeps that core and fixes the winner's measured flaws: direction (54% misattribution), done_method (81 possibly_done), space kinds (filler goals), cross-chat merge (3 fragmented Rajat spaces), batch-boundary blindness (chunks + whole-unit reads).
