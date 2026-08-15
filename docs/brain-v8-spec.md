# Brain v8 — Combined Specification
**Status:** frozen. Build target. Self-contained — no other spec document is needed. Companion: `brain-v8-buildplan.md` (execution plan).

**Fresh install.** No data migration. The local DB is cleared; the new app starts from scratch. Old brain tables are dropped and replaced with clean names.

**What this is.** The comprehension layer of SuperTwinV8: raw events from any source become spaces, commitments, claims, rhythms, a CRM and a user model — correct, cited, correctable, and fast.

* * *
## Contents
1. [Goal](#1-goal)
  
2. [Non-negotiables](#2-non-negotiables)
  
3. [Ontology](#3-ontology)
  
4. [Schema](#4-schema)
  
5. [The apply layer](#5-the-apply-layer)
  
6. [Confidence, time, privacy](#6-confidence-time-privacy)
  
7. [Predicates](#7-predicates)
  
8. [Chunks](#8-chunks)
  
9. [The two modes](#9-the-two-modes)
  
10. [Mode 1 — Bootstrap](#10-mode-1--bootstrap)
  
11. [Mode 2 — Steady state](#11-mode-2--steady-state)
  
12. [Call economics](#12-call-economics)
  
13. [The agent society](#13-the-agent-society)
  
14. [Designing for volume](#14-designing-for-volume)
  
15. [Search, chat, context collection](#15-search-chat-context-collection)
  
16. [Models](#16-models)
  
17. [UX surfaces](#17-ux-surfaces)
  
18. [Metrics](#18-metrics)
  
19. [Appendix — evidence from shipped versions](#19-appendix)
  

* * *
## 1. Goal
**When the system says something about your life, it is right — and it says it soon.**

- Everything the user sees is a processing output of raw event data
  
- Quality drivers (measured, not guessed): few decisions per call · judgment in the prompt · invariants in code · mandatory provenance · enough tokens · gates that block · no fallback writers
  
- Speed driver: recent data first, old history in the background
  

* * *
## 2. Non-negotiables
1. **Nothing stored without evidence.** Every claim/commitment/space links to the events that produced it. Zero evidence = validation failure.
  
2. **The model authors; code validates.** Code never composes a user-facing string.
  
3. **Agents propose; the apply layer commits.** No agent writes state. Ever.
  
4. **Confidence drives behaviour.** High → assert. Medium → hedge + one-tap correct. Low → ask or stay silent. Never silently guess.
  
5. `unresolved` **is a first-class outcome** for every agent, field, surface.
  
6. **Interpretations are versioned, never overwritten.**
  
7. **Structure is emergent.** A level exists only when evidence supports it. No empty scaffolding — enforced by the apply layer, not by prompts.
  
8. **Corrections are the product.** One tap, immediate, permanent, re-derives downstream.
  
9. **Content is data, never instruction.** Message text never enters an instruction channel; it is wrapped and marked untrusted.
  
10. **Backfilled history never triggers action.**
  
11. **Local-first.** Model calls are the only egress; every one is logged.
  
12. **Read whole within a unit.** Never chunk inside a conversation burst.
  
13. **No fallback path may ever author anything.** Blocked call = defer and resume. Never degrade to a dumber writer.
  
14. **Every gate blocks or does not exist.** Advisory scores are banned.
  
15. **No budgets, no caps — anywhere.** Cost control = batching + rules. All spend metered and visible in Settings.
  
16. **Gate on structure, not confidence.** "Has direction / has evidence / kind allows goal" — checkable, recall-safe. "Is the model sure" is not.
  

* * *
## 3. Ontology
### 3.1 Primitives
| Primitive | What it is | Mutability |
| --- | --- | --- |
| **Event** | Something that happened. Raw. | Immutable, append-only |
| **Chunk** | Physical container: a burst of raw events (§8) | Reopens on change |
| **Segment** | A topic-labeled sub-range inside a chunk (§8) | Re-derived cheaply |
| **Entity** | Person / org / place / product / account / group | Merged on strong identifiers only |
| **Claim** | "X is true about Y" + confidence + evidence + two time axes | Superseded, never overwritten |
| **Space** | Kind-typed container for a part of life. Nests as a graph | Reshaped continuously |
| **Commitment** | Obligation with mandatory direction `from → to` | Resolved, not deleted |
| **Run** | One attempt to act on a commitment | Append-only |
| **Rhythm** | Recurring pattern (habit / workflow / cadence) | Promoted, never asserted |

Consolidations (deliberate — do not rebuild the removed concepts):

- **Edges are claims** with an entity object. No separate edges table.
  
- **Habits, patterns, workflows are one table:** `rhythms`, split by `kind`.
  
- **Facts vs beliefs** = `source_type` + `confidence` on one `claims` table.
  
- **No** `possibly_done` **state.** `done` requires a `done_method`.
  
- Memory types are **views**: episodic = events/timeline · semantic = claims · procedural = rhythms · user model = claims about self · working = the per-turn context block.
  
### 3.2 Space kinds — executable policy
The kind decides what structure is permitted/required. Lives in code as `STRUCTURE_POLICY`; the apply layer enforces it.

| Kind | Example | Goal | Milestones | Done state | Recurs |
| --- | --- | --- | --- | --- | --- |
| `episode` | Weekend lunch plan | optional | forbidden | yes | no  |
| `project` | Flat hunt, job search | **required** | allowed | yes | no  |
| `pursuit` | A parent's health, career growth | optional | allowed | no  | no  |
| `relationship` | A person | **forbidden** | forbidden | never | —   |
| `routine` | Weekly groceries | **forbidden** | forbidden | never | yes |
| `stream` | Bank alerts | **forbidden** | forbidden | never | yes |
| `collection` | Places to try, reading list | **forbidden** | forbidden | never | —   |

- Spaces **nest** as a graph with one primary parent (relationship → its episodes/projects/pursuits)
  
- Every space carries `subject_entity_id` — whose life it is about; evidence about a different subject cannot join (kills cross-thread contamination)
  
- Life areas / categories = **tags**, many-to-many, browsing only — never a reasoning level
  
- Spaces may draw evidence from **many chats and many sources**
  
- UI badges derived per space: one-time/recurring · permanent/ephemeral · long-term/short-term (from kind + recurrence + ends_at)
  
### 3.3 Commitments
- `from_entity_id` and `to_entity_id` **mandatory** — or `status='unresolved'` (SQL CHECK). Unresolved is never shown as the user's.
  
- Types by direction: interpersonal (user → other) · **inbound (other → user — what people owe YOU, a first-class surface)** · self · external (institution → user) · broadcast (owner unresolved)
  
- Attaches to a milestone, goal, space, **or nothing**. "Buy blueberries" needs no goal.
  
- Recurrence lives on the commitment **or** on a routine space — never both.
  
- Runs (plan/result/error/cost) are separate rows — a commitment can have many attempts.
  
- **Resolved detection:** history and live data are checked against open commitments; a commitment already fulfilled is marked `done` with evidence and `done_method`:
  
  - `verified` — a capability re-checked the world
    
  - `stated` — someone said it, event cited
    
  - `user` — user tapped done
    
  - `expired` — time-boxed and the window passed
    

* * *
## 4. Schema
One SQLite file (`supertwin.db`, WAL, `foreign_keys=ON`), better-sqlite3, migration runner with ordered ids recorded in `schema_migrations`.

**Kept from the existing app (unchanged):** `events` (+ all enrichment columns), `events_fts` (7 columns), `event_embeddings`, `sources`, `channels`, `actors`, `app_state`, `extraction_runs`, `quota_usage`, `chat_sessions`, `chat_messages`, `evaluations`, `schema_migrations`.

**Dropped (fresh install, children before parents):** `task_runs` → `tasks` → `space_people` → `space_events` → `milestones` → `goals` → `spaces` → `patterns` → `people` (after `ALTER TABLE actors DROP COLUMN person_id`). Precondition: gut the dead eager `prepare()` statements in `worker/src/store/store.ts` first (65 statements; keep only settings / model-selection / runs / quota).

**New tables** (clean names — no old DB exists):

```sql
-- ===== Entities =====
entities (
  id TEXT PK,                    -- ent:<uuid>
  kind TEXT CHECK IN ('person','org','place','product','account','group'),
  display_name TEXT,             -- model-authored
  is_self INTEGER DEFAULT 0,
  privacy TEXT DEFAULT 'normal' CHECK IN ('normal','sensitive','secret'),
  confidence REAL DEFAULT 1.0,
  merged_into TEXT REFERENCES entities(id),   -- soft merge, reversible
  created_at, updated_at
)
entity_identifiers (             -- the ONLY merge key
  scheme TEXT CHECK IN ('phone','email','handle','jid','contact_id','account_no'),
  value TEXT,                    -- normalized (E.164, lowercase)
  entity_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
  source_id TEXT, created_at,
  PRIMARY KEY (scheme, value)
)
entity_aliases (                 -- weak names; resolve, NEVER merge
  entity_id, alias, scope,       -- scope = channel_id when local
  confidence REAL DEFAULT 0.5,
  PRIMARY KEY (entity_id, alias, scope)
)

-- ===== Predicates registry =====
predicates (
  name TEXT PK, category TEXT,
  object_types TEXT,             -- JSON array of allowed object types
  volatility TEXT DEFAULT 'slow' CHECK IN ('never','slow','medium','fast'),
  privacy_floor TEXT DEFAULT 'normal',
  symmetric INTEGER DEFAULT 0, inverse_of TEXT,
  single_valued INTEGER DEFAULT 0,  -- new object supersedes old
  description TEXT, builtin INTEGER DEFAULT 0, usage_count INTEGER DEFAULT 0
)

-- ===== Claims (semantic core; edges = claims with entity objects) =====
claims (
  id TEXT PK,                    -- clm:<uuid>
  subject_id TEXT, subject_type TEXT CHECK IN ('entity','space','self'),
  predicate TEXT REFERENCES predicates(name),
  object_type TEXT CHECK IN ('literal','entity','date','number','money','enum','bool'),
  object_value TEXT, object_entity_id TEXT REFERENCES entities(id), object_unit TEXT,
  valid_from TEXT, valid_to TEXT,          -- when true in the world
  observed_at TEXT NOT NULL,               -- when we learned it
  source_type TEXT CHECK IN ('user_asserted','stated','observed','inferred'),
  confidence REAL NOT NULL,
  privacy TEXT DEFAULT 'normal',
  superseded_by TEXT REFERENCES claims(id), supersede_reason TEXT,
  user_pinned INTEGER DEFAULT 0,           -- correction; agents may not override
  proposal_id TEXT, created_at,
  CHECK (object_type != 'entity' OR object_entity_id IS NOT NULL),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
)
-- hot path index: live claims
--   (subject_id, predicate) WHERE superseded_by IS NULL AND valid_to IS NULL
-- reverse index: (object_entity_id, predicate)
claim_evidence (claim_id, event_id, PRIMARY KEY (claim_id, event_id))  -- ≥1 required
claims_fts    (fts5: rendered text, e.g. "Priya Sharma lives in Pune")
claim_embeddings (claim_id PK, model, dim, vector BLOB, indexed_at)
  -- same (model,dim) invalidation discipline as event_embeddings

-- ===== Spaces =====
spaces (
  id TEXT PK,                    -- sp:<slug>
  kind TEXT CHECK IN ('episode','project','pursuit','relationship','routine','stream','collection'),
  name TEXT, slug TEXT UNIQUE,
  subject_entity_id TEXT REFERENCES entities(id),
  status TEXT DEFAULT 'active' CHECK IN ('active','dormant','closed','archived'),
  brief TEXT, brief_ts TEXT,     -- model-authored "what you should know now"
  ends_at TEXT, recurrence TEXT, -- recurrence only for routine/stream
  user_pinned INTEGER DEFAULT 0, confidence REAL DEFAULT 0.5,
  privacy TEXT DEFAULT 'normal', proposal_id TEXT, created_at, updated_at,
  CHECK (kind != 'relationship' OR subject_entity_id IS NOT NULL),
  CHECK (recurrence IS NULL OR kind IN ('routine','stream'))
)
space_parents (space_id, parent_id, is_primary,   -- graph; one primary parent
  PRIMARY KEY (space_id, parent_id), CHECK (space_id != parent_id))
  -- partial unique index: one is_primary=1 per space_id
space_tags   (space_id, tag, PRIMARY KEY (space_id, tag))
space_events (space_id, event_id, created_at, PRIMARY KEY (space_id, event_id))
goals        (id PK, space_id → spaces CASCADE, name, status DEFAULT 'open',
              confidence, created_at)
milestones   (id PK, goal_id → goals CASCADE, name, status, due_at, position, created_at)

-- ===== Commitments =====
commitments (
  id TEXT PK,
  from_entity_id TEXT, to_entity_id TEXT,
  type TEXT CHECK IN ('interpersonal','inbound','self','external','broadcast'),
  status TEXT DEFAULT 'unresolved' CHECK IN ('unresolved','open','done','dropped','expired'),
  title TEXT NOT NULL,           -- model-authored, never code
  detail TEXT,
  space_id → spaces SET NULL, goal_id → goals SET NULL, milestone_id → milestones SET NULL,
  due_at TEXT, recurrence TEXT,
  origin TEXT CHECK IN ('stated','inferred','suggested','imported','user'),
  approved INTEGER DEFAULT 0,
  done_at TEXT, done_method TEXT CHECK IN ('verified','stated','user','expired'),
  done_evidence_event_id TEXT,
  privacy, user_pinned, proposal_id, created_at, updated_at,
  CHECK (status='unresolved' OR (from_entity_id IS NOT NULL AND to_entity_id IS NOT NULL)),
  CHECK (status != 'done' OR done_method IS NOT NULL)
)
commitment_evidence (commitment_id, event_id, role,  -- origin|update|completion
  PRIMARY KEY (commitment_id, event_id))
runs (id PK, commitment_id → commitments CASCADE, status, plan, transcript_path,
  model, input_tokens, output_tokens, cache_read_tokens, cost_usd, duration_ms,
  verification_method, verified, error, approval_id, started_at, finished_at)

-- ===== Rhythms =====
rhythms (
  id TEXT PK, kind TEXT CHECK IN ('habit','workflow','cadence'),
  name TEXT, description TEXT, cadence TEXT,
  subject_entity_id TEXT, space_id → spaces SET NULL,
  observation_count INTEGER DEFAULT 0,       -- DERIVED, recomputed on apply
  status TEXT DEFAULT 'candidate' CHECK IN ('candidate','confirmed','dismissed'),
  confirmed_by TEXT CHECK IN ('threshold','user'),
  confidence REAL DEFAULT 0.3, proposal_id, created_at, updated_at,
  CHECK (status != 'confirmed' OR confirmed_by='user' OR observation_count >= 3)
)
rhythm_observations (rhythm_id, event_id, ts, PRIMARY KEY (rhythm_id, event_id))

-- ===== Chunks (§8) =====
chunks (
  id TEXT PK, source_id, channel_id,
  shape TEXT CHECK IN ('dialogue','record','artifact','signal'),
  from_ts, to_ts, event_count, token_est,
  fingerprint TEXT,              -- change detection; reopen on mismatch
  summary TEXT,                  -- ONE model line, for routing only
  entity_ids_json TEXT, status TEXT DEFAULT 'open' CHECK IN ('open','closed'),
  created_at, updated_at
)
chunk_events (chunk_id, event_id, PRIMARY KEY (chunk_id, event_id))
chunk_links  (chunk_id, related_chunk_id, reason,  -- shared_entity|time|topic|agent
  PRIMARY KEY (chunk_id, related_chunk_id))
chunk_segments (                 -- topic-labeled sub-ranges within a chunk (§8)
  id TEXT PK, chunk_id → chunks CASCADE,
  from_event_id TEXT, to_event_id TEXT,     -- inclusive range, chronological
  topic TEXT,                    -- model-authored, ≤80 chars
  space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,  -- once assigned
  method TEXT CHECK IN ('drift','llm','scout'),  -- how the boundary was found
  created_at, updated_at
)

-- ===== History / process =====
proposals (
  id TEXT PK, batch_id, agent, agent_run_id, kind, payload_json,
  status TEXT DEFAULT 'pending' CHECK IN ('pending','applied','rejected','superseded'),
  reject_code TEXT, reject_detail TEXT, target_id TEXT, created_at, applied_at
)
corrections (id PK, target_type, target_id, field, old_value, new_value, note,
  rederive_job, created_at)                 -- never deleted
questions (id PK, question, why, blocks_type, blocks_id,
  value_score REAL DEFAULT 0,               -- artifacts unblocked × confidence gap
  status DEFAULT 'pending' CHECK IN ('pending','asked','answered','dismissed'),
  answer, asked_at, answered_at, created_at)
dossiers (channel_id PK, entity_id, content_md, fingerprint,
  read_through_rowid INTEGER,               -- high-water mark
  threads_json TEXT,                        -- live-thread registry: topic →
                                            --   segment pointers → space id
  model, input_tokens, updated_at)          -- ROUTING MAP ONLY — never authors
jobs (id PK, kind,                          -- comprehend|cartograph|investigate|
                                            -- criticize|consolidate|reverify|rederive
  payload_json, wake_type CHECK IN ('now','time','event','state','dependency'),
  wake_at, wake_filter, depends_on,
  status DEFAULT 'pending' CHECK IN ('pending','running','done','failed','deferred'),
  attempts INTEGER DEFAULT 0,               -- deferral NEVER increments this
  partial_json, last_error, created_at, updated_at)
```
### Filesystem projections (generated, rebuildable, git-versioned)
```
~/SuperTwinV8/brain/          (git repo; cwd for grounded runs)
├── corpus/<slug>--<hash>.md  one message per line, sharded by month past ~5k msgs
├── dossiers/<chat>.md        routing maps
├── wiki/people/<slug>.md     rendered FROM claims
├── wiki/spaces/<slug>.md     rendered FROM claims
└── me/self.md                user-model digest, ≤800 tokens, priority-ranked
```

- DB is truth; files are views. Never hand-authored, never a second truth.
  
- Not git-ignored — grounded Grep must reach them.
  

* * *
## 5. The apply layer
**The only writer.** Everything else emits proposals. Reasoning stays probabilistic; state stays deterministic.
### 5.1 Proposal kinds
`entity.upsert` · `entity.identify` (strong id → merge) · `entity.alias` (never merges) · `claim.assert` · `claim.supersede` · `space.upsert` · `space.nest` · `space.attach_events` · `goal.add` · `milestone.add` · `commitment.assert` · `commitment.resolve` · `rhythm.observe` · `question.ask`

Every payload carries: `evidence: event_ids[] (≥1)` · `confidence` · `agent` · `batch_id`. Batches apply in one transaction; forward refs within a batch allowed (topological order); one bad proposal rejects alone, not the batch.
### 5.2 Validation rules (each = stable reject code, counted, alarmed)
Universal:

- [ ] 
  
  `E_NO_EVIDENCE` — ≥1 evidence event
  
- [ ] 
  
  `E_EVIDENCE_MISSING` — every evidence id exists
  
- [ ] 
  
  `E_EVIDENCE_ALIEN` — evidence within the agent's read scope
  
- [ ] 
  
  `E_DANGLING_REF` — referenced ids exist or created earlier in batch
  
- [ ] 
  
  `E_EMPTY_STRING` — no empty/fragment user-facing strings
  
- [ ] 
  
  `E_RAW_IDENTIFIER` — no JID/phone/`@numeric` in user-facing strings
  
- [ ] 
  
  `E_CONFIDENCE_RANGE` — 0..1
  
- [ ] 
  
  `E_PINNED` — target not user_pinned
  

Claims:

- [ ] 
  
  `E_UNKNOWN_PREDICATE` — predicate registered
  
- [ ] 
  
  `E_OBJECT_SHAPE` — object matches predicate's declared range
  
- [ ] 
  
  `E_TIME_ORDER` — valid_to ≥ valid_from
  
- [ ] 
  
  `E_SENSITIVE_LEAK` — claim privacy ≥ max evidence privacy
  

Spaces / goals / milestones:

- [ ] 
  
  `E_GOAL_FORBIDDEN` / `E_GOAL_REQUIRED` / `E_MILESTONE_FORBIDDEN` — per `STRUCTURE_POLICY[kind]`
  
- [ ] 
  
  `E_NO_SUBJECT` — relationship names a subject entity
  
- [ ] 
  
  `E_CONTAMINATION` — attached events involve the subject
  
- [ ] 
  
  `E_CYCLE` — nesting acyclic
  

Commitments (the misattribution killers):

- [ ] 
  
  `E_NO_DIRECTION` — from+to present, or status=unresolved
  
- [ ] 
  
  `E_SELF_UNSUPPORTED` — `from=self` requires ≥1 user-authored evidence event (actor resolves to self) or user_asserted source
  
- [ ] 
  
  `E_BROADCAST_OWNED` — broadcast can't set from=self unless user sent it
  
- [ ] 
  
  `E_HISTORICAL_APPROVAL` — all-historical evidence forces approved=0
  
- [ ] 
  
  `E_RECURRENCE_HOME` — recurrence on commitment XOR routine space
  

Rhythms:

- [ ] 
  
  `E_PROMOTION_GATE` — confirmed needs count≥3 (derived) or user
  
- [ ] 
  
  `E_OBSERVATION_SPREAD` — observations span ≥2 calendar periods at the claimed cadence
  

Soft outcomes: below-band confidence is **applied but not surfaced** (still counts as corroboration evidence). Rejection = invalid; not-surfaced = uncertain. Never conflate.
### 5.3 Dedupe by meaning (re-runs converge; second run = zero new artifacts)
| Artifact | Identity | On collision |
| --- | --- | --- |
| Entity | strong identifier (scheme,value) | merge; union aliases+evidence |
| Space | slug, or (kind, subject, ≥60% event overlap) | merge; union; keep earliest |
| Claim | (subject, predicate, normalized object) + overlapping validity | union evidence; recompute confidence |
| Claim | same (subject,predicate), different object, later observed_at | **supersede** old (set valid_to) |
| Commitment | same (from,to) + title cosine ≥0.90 + due within 3 days | union evidence; keep earliest |
| Rhythm | (kind, subject, normalized name) | union observations; recount |
| Goal | (space, normalized name) | keep first |

Deterministic ids: `sp:<slug>` · commitment `cm:<space>:<slug(title)>:<hash(evidence)>` · goal `g:<space>:<slug>` · `INSERT OR IGNORE` everywhere. User edits (done/dismissed/pinned) survive re-runs.
### 5.4 Rejection is loud
- Every rejection persisted with code + detail
  
- Health surface: reject rate by agent × code over time — a rising rate is the earliest drift alarm
  
- Silent swallows banned; bare try/catch around persistence is a review blocker
  

* * *
## 6. Confidence, time, privacy
### 6.1 Confidence — computed, not vibed
```
base          = {user_asserted:1.00, stated:0.85, observed:0.70, inferred:0.45}[source_type]
agent_signal  = 0.10 × (agent_confidence − 0.5)          // ±0.05, deliberately small
corroboration = min(0.15, 0.05 × (distinct_evidence − 1))
cross_source  = +0.05 if evidence spans ≥2 sources
critic        = +0.05 pass · −0.25 flag
decay         = volatility_penalty(predicate, age)
confidence    = clamp(sum, 0.05, 1.00)
```

- `user_pinned` bypasses at 1.0
  
- Constants are priors — recalibrate against the labelled set (reliability plot; 0.7–0.8 bucket must be ~75% correct)
  
### 6.2 Behaviour bands
| Band | Behaviour |
| --- | --- |
| ≥0.80 | Assert plainly |
| 0.50–0.79 | Assert hedged, one-tap correct |
| 0.25–0.49 | Only when asked; hedged; candidate question |
| <0.25 | Never surfaced; retained as corroboration |
### 6.3 Volatility (per predicate)
`never` (born_on) · `slow` ~2y (lives_in, works_at) · `medium` ~90d (is_dealing_with, owns) · `fast` ~21d (is_looking_for, traveling_to, available_on). Decayed-below-band claims that something depends on become questions ("Is Pranjali still looking?").
### 6.4 Privacy
- Classes: `normal` · `sensitive` (health/finance/legal/intimate — by default) · `secret`
  
- Claim privacy ≥ max evidence privacy (ratchets up, never down)
  
- `secret` never leaves the device without explicit per-query consent
  
- Export/share filters by class
  

* * *
## 7. Predicates
Registry table, seeded, extendable by proposal (`builtin=0`, listed in Health). `single_valued=1` → new object auto-supersedes (lives_in); `=0` → accumulates (knows).

| Category | Predicates |
| --- | --- |
| Identity | has_role, works_at¹, studies_at, born_on, has_pronouns |
| Location | lives_in¹, located_in, traveling_to*, from_place |
| Relation | related_to² (+label), knows², member_of, works_with, reports_to |
| State | is_looking_for*, is_dealing_with, owns, uses, subscribes_to |
| Preference | prefers, dislikes, allergic_to³, avoids |
| Communication | speaks_language, addressed_as, tone_with, uses_term |
| Availability | available_on*, busy_on*, timezone |
| Health/Finance³ | has_condition, takes_medication, banks_with, holds_account |
| Interest | interested_in, follows, saved |

¹ single_valued · ² symmetric · ³ privacy floor sensitive · * fast volatility

- Communication predicates store per-person/group **tone, address form, and the user's dictionary** (`uses_term(self,"sorted")="done/handled"`) — ordinary claims, correctable like everything else
  
- **No** `owes` **predicate.** Debts and obligations are commitments, not claims
  
- Watch both failure modes: synonym tails (vocabulary prompt too weak) and zero growth (too tight)
  

* * *
## 8. Chunks, segments, topics
Three layers. Conflating them is how chunking goes wrong — a WhatsApp burst routinely interleaves several topics, and no boundary rule fixes that. **Chunks are physical. Segments are topical. Topic membership is per-event.**
### 8.1 Chunks — physical containers
Deterministic boundaries per source shape. Their only job is preserving chronology and local context for whole-unit reading. **Mixed topics inside a chunk are fine** — mixed context is often the signal (a pronoun resolves because the other topic sits four lines up).

| Shape | Chunk boundary |
| --- | --- |
| Dialogue | Conversation burst: >4h lull or day boundary, ≤ ~200 events |
| Email | The thread |
| Record | Per account per month |
| Browser/YouTube | Session: gap >30 min |
| Saves | Per saving-activity batch |

- New events extend the open chunk; fingerprint mismatch (edit, late transcript) reopens a closed one
  
- **Reading = raw chunk text, always.** Artifacts are extracted from raw text — never from summaries. Summaries lose the line carrying the signal
  
### 8.2 Segments — topic-labeled sub-ranges, nearly free
Where topic purity lives. Two producers, both cheap:

- [ ] 
  
  **Embedding drift ($0):** event embeddings already exist locally. Slide a window over the burst; a cosine drop between adjacent windows = topic shift. Plus free structural signals: `reply_to` threads, participant changes, media boundaries. Method `drift`
  
- [ ] 
  
  **W2 rider (~$0 marginal):** the batched summary pass already reads every chunk's raw text. Its output schema also emits segments: `{events: [range], topic: "loan approval"}`. Same input tokens, slightly more output. Method `llm`
  
- [ ] 
  
  Scout may correct segment boundaries during comprehension (method `scout`); segments are derived data — cheap to re-derive, never a source of truth
  

**Never a standalone LLM chunking pass** — that re-reads the corpus for boundaries comprehension re-derives anyway.
### 8.3 Topic membership — per event, authoritative
- `space_events` is **event-level**, assigned during comprehension (Scout evidence is per-event). Segments get `space_id` once their space exists
  
- One space pulls from many chunks across many chats and sources — via event membership, not via chunk boundaries
  
- Chunk graph (`chunk_links`): shared entities, time overlap, agent judgment — used for packing related chunks into one call
  
### 8.4 Virtual chunks — topic purity at read time
When search/chat/re-verify needs one topic:

```
topic/space → its event ids (space_events + segments)
           → expand each ±n via read_around (context preserved)
           → merge overlapping windows
           → one chronological view, spanning chats AND sources
```

Deterministic, instant, no storage. Any pre-baked boundary is wrong for some future question; event-level membership + read-time assembly never needs re-chunking. Exposed as the `read_topic` tool (§13).
### 8.5 Dossiers — thread registries that route
A dossier is a per-relationship map: who this is, what is live, and a **thread registry** (`threads_json`): topic → segment pointers → space id. Agents use it to pick which segments to read, making packed calls denser. **No artifact is ever authored from a dossier** — it routes into raw text; it is regenerated, so a wrong entry self-heals on the next consolidate.

* * *
## 9. The two modes
|     | **Bootstrap** | **Steady state** |
| --- | --- | --- |
| Trigger | Source connect / range extend | New events |
| Data | Months–years at once | Trickle |
| Latency | Fast window: ~minutes. Deep: background | Minutes |
| Unit | Waves over chunk sets | Micro-batches |
| Actions | **Never** (historical read-only) | Approval tiers |
| Failure | Checkpoint + resume | Defer + retry |

* * *
## 10. Mode 1 — Bootstrap
### 10.1 Fast pass, then deep pass
|     | Fast pass | Deep pass |
| --- | --- | --- |
| Window | Last **30 days** (setting: 7/15/30/90) | Everything older (setting) |
| Runs | First, end to end | After fast pass; background |
| Target | **First artifacts on screen ≤20 min** | Hours–a day per year; resumable across days |
| UI  | Surfaces fill live per wave | "History filling in: 34%…" banner |

- Deep-pass evidence **updates** existing artifacts through the apply layer: claims gain validity windows; commitments found already-fulfilled become `done`; spaces gain history. Deterministic ids + dedupe = no duplicates.
  
### 10.2 Waves (per pass)
```
W0  INGEST + ENRICH   daemon imports → events (is_historical=1) · chunker runs
                      · transcripts+embeddings local (free) · image/video/link
                      understanding via vision LLM — BATCHED, cheap, not $0
W1  RESOLVE           deterministic. Contacts FIRST (ground truth), then
                      entities from senders. Strong ids only. Businesses=orgs
W2  CHUNK + RELATE    boundaries cut · embedding-drift segmentation ($0) ·
                      ONE batched LLM pass writes one-line summaries +
                      entity tags + SEGMENTS (topic sub-ranges) — hundreds
                      of chunks/call, same input tokens · chunk graph linked
W3  COMPREHEND        the main spend. Packed calls read RAW CHUNKS:
    (Scout wave)      big chats month-windowed · small chats bundled by
                      social cluster · related record/signal chunks ride
                      WITH their dialogue (receipt next to trip chat).
                      Output: proposals (entities, claims, commitments both
                      directions INCL. already-resolved, space candidates,
                      rhythm observations) + dossier updates.
                      Checkpoint per chunk.
W4  CARTOGRAPHER      deterministic clustering → packed calls per cluster
                      group. Kinds, nesting, merges across chats AND sources.
                      Never per-space calls.
W5  INVESTIGATE       ambiguities grouped by shared context → packed calls
    + CRITICIZE       (many questions/call, answered from raw chunks).
                      Critic falsifies whole proposal set, dozens/call,
                      against raw chunks. Flags BLOCK.
W6  CURATE + ELICIT   rank · suppress · write the Brief · pick ≤15
                      highest-value questions. Fast pass flips surfaces live.
```

Resume rules:

- [ ] 
  
  Wave interrupted at chunk N restarts at chunk N — nothing re-runs
  
- [ ] 
  
  Failed call defers the item, not the wave; deferral never increments `attempts`
  
- [ ] 
  
  3 real failures (not deferral/timeout) → quarantine the item, loudly
  
- [ ] 
  
  Partial output always kept (+ `unresolved`)
  

Cost (uncapped, metered live): 1y WhatsApp ≈ 1M dialogue tokens → comprehension ≈ $15–50 on Haiku packed; enrichment + other waves ≈ $10–25.

* * *
## 11. Mode 2 — Steady state
Micro-batch: 10-min lull **or** ≥50 pending, whichever first.

```
event → chunker extends open chunk
  ▼
WATCHER
  · deterministic pre-triage $0 only where CERTAIN: exact-format OTP,
    known-noise channels, media→enrich queue
  · everything uncertain → ONE packed call per micro-batch:
    route chunks→spaces · new commitments (both directions) ·
    RESOLVED-detection vs open commitments (cite evidence →
    done_method) · claim updates · escalations
  ▼
APPLY → substrate → projections (corpus, summaries, wiki, self.md)
escalations → next Investigator sweep (batched)
```

Scheduled work — frequent, triggered, small (no nightly/weekly big-bangs):

| Job | Cadence | Work |
| --- | --- | --- |
| **Consolidate** | Every **3–6h**, early-triggered by ≥N applied updates, skipped when idle | Fold chunk deltas into dossiers · recompute rhythms · regen self.md + wiki · git commit · **Critic pass** over artifacts since last run (one packed call) · Brief refresh · question re-rank |
| **Re-verify** | Rolling, continuous | Auditor re-reads oldest-verified artifacts vs raw chunks, N/call; fast-volatility claims first; drift → fix jobs |
| On correction | Immediate | Re-derive downstream, bounded blast radius |

* * *
## 12. Call economics
1. **Every CLI call costs ~59k tokens of system prompt before it says a word.** Minimum call count is the first-order cost lever.
  
2. Pack every call to ~70% of context with input.
  
3. **Never one call per artifact** — one call emits all artifacts for all touched chunks/spaces as one structured output. Critic: dozens/call. Investigator: many questions/call. Vision: many images/call.
  
4. Bundle small, split big (small chats grouped by social cluster; big chats month-windowed with dossier carry-forward).
  
5. Read whole within a unit — chronology survives inside a chunk.
  
6. One model per wave; byte-stable system prompt; cache reuse intact.
  
7. Deterministic only where certainty is real (ids, dedupe, validation, gates, FTS, graph, fusion, exact formats). **Meaning goes to the model** — "is this a receipt", "is this noise" are judgment, not regex.
  
8. Local models free — whisper/embeddings/ffmpeg on everything.
  

* * *
## 13. The agent society
| Agent | Job | Bootstrap | Steady state | Batching |
| --- | --- | --- | --- | --- |
| **Scout** | Comprehend raw chunks → proposals | W3  | Absorbed into Watcher; full re-read on correction/audit | Chunks packed by cluster; records/signals ride with related dialogue |
| **Cartographer** | Space map: kinds, nesting, cross-chat/source merges | W4  | On ≥N new candidates | Deterministic cluster → packed calls |
| **Investigator** | Resolve ambiguity from raw chunks | W5  | Sweeps when questions accumulate/block | Many questions per call, context-grouped; returns evidence or "cannot determine" |
| **Critic** | Falsify vs raw chunks | W5  | Each consolidate | Dozens of artifacts/call. **Flag blocks** (−0.25, above threshold → unsurfaced + question) |
| **Curator** | Rank, suppress, Brief, questions | W6  | Each consolidate | One call, whole picture |
| **Auditor** | Find what's wrong | —   | Rolling re-verify | N artifacts/call, oldest + fast-volatility first |
| **Watcher** | Triage live micro-batches | —   | Every micro-batch | Rules where certain; one packed call for the rest |

- Shared read toolset (all agents + chat): `search`, `read_chunk`, `read_topic` (virtual chunk — one topic across chats/sources, §8.4), `read_around`, `who_is`, `timeline`, `recall`, `owed`, `transcribe`, `unfurl`
  
- Context overflow → return partial + `unresolved`. Never a guess, never a fallback writer, no token allowances (rule 15)
  

* * *
## 14. Designing for volume
Enrichment ≠ comprehension. Every shape gets both:

| Shape | Sources | Enrichment (cheap/free) | Comprehension (LLM, batched) |
| --- | --- | --- | --- |
| Dialogue | WhatsApp, iMessage, Slack, IG DMs, human email | transcripts, media descriptions, link text | Scout — the main spend |
| Record | Order/bill/booking emails, bank alerts, calendar, contacts | field extraction where fields truly exist | Batched classification + sense-making; related to dialogue (receipt ↔ trip) |
| Artifact | Files, PDFs, AI-chat exports | text extraction, embeddings | On-demand reads; low-confidence claims |
| Signal | Browser, YouTube, IG saves, Spotify | session chunking, counts | Batched interpretation → interested_in claims, rhythm observations, collection items |

- **Consumption is never obligation:** signal/record-origin proposals cannot become commitments unless explicit terms exist (amount + due date, stated) — enforced at the apply layer by origin
  
- Compression is the scaling mechanism: events grow linearly; claims/dossiers grow with the life. Reason over the compressed layer; re-read raw on demand
  

|     | 30d WA | 1y WA | 1y × 5 sources |
| --- | --- | --- | --- |
| Events | ~4.3k | ~52k | ~250k+ |
| Chunks | ~600 | ~7k | ~25k |
| Comprehension input | ~85k tok | ~1M tok | ~1.5M tok |
| Claims | ~2k | ~20k | ~60k |

Blockers at scale:

- [ ] 
  
  `sqlite-vec` (or equivalent ANN) before multi-source — brute-force cosine dies past ~100k vectors
  
- [ ] 
  
  Hierarchical Cartographer — cluster → map → merge; incremental after bootstrap
  
- [ ] 
  
  Corpus + chunk sharding by month past ~5k messages/chat
  
- [ ] 
  
  Recency tiering — fast window always full-quality
  
- [ ] 
  
  Correction blast radius bounded — direct dependents only
  
- [ ] 
  
  Context packing policy — confidence × recency × relevance × predicate priority; reserved slots for commitments + self-model
  

* * *
## 15. Search, chat, context collection
**Agentic-first.** The fused index accelerates; the agent loop is the search.

```
question → planner (one small call: entities, time window, as_of, intent)
        → parallel engines ($0): FTS (events+claims) · vectors · SQL
          (structured: time/direction/status/owed) · graph hops (1–2)
        → RRF fusion (k=60, weights tuned on labelled set) → candidate
          SEGMENTS + chunks + claims (segments preferred — topic-pure,
          smaller, denser context)
        → AGENTIC LOOP: model reads candidates, then fetches what's
          missing (read_topic for one topic across chats/sources,
          read_chunk, read_around, who_is, timeline, recall, owed)
          until it can answer or knows it can't
        → answer with [n] citations → deterministic validation
```

- Claims arrive with confidence + validity window **visible**; conflicting claims both shown, never silently resolved
  
- Claims outrank raw events at equal score (evidence one hop away)
  
- Entity resolution first: alias → candidates → channel-context disambiguation; unresolved → ask, never pick silently
  
- `as_of` supported: "what did you believe last week" time-slices every engine
  
- Answer contract: every factual sentence cites claim/event id · no evidence → say so · bands govern phrasing · historical questions use as_of
  
- Deterministic post-validation: citations resolve · no uncited assertions · no superseded-claim-as-current · no raw identifiers · failures counted + alarmed
  
- Verify pass on high-stakes answers (money, health, dates, commitments)
  
- "Why this answer?" expands the exact chunks + claims used
  

* * *
## 16. Models
**Default: Haiku for every process.** (Evidence: the best shipped run was 455/456 calls on Haiku, zero failures.) Per-process picker in Settings:

chat (subscription default) · media/vision · scout · cartographer · investigator · critic (different model recommended when available) · curator · watcher · auditor · planner — all default haiku.

- One model per wave (cache reuse)
  
- Every call logged to `extraction_runs`: role, model, four token counts (input, output, cache-creation, cache-read), cost
  

* * *
## 17. UX surfaces
Global rules:

- [ ] 
  
  Nothing appears without a tappable "why" (evidence)
  
- [ ] 
  
  Uncertainty visible below 0.8 confidence
  
- [ ] 
  
  Correction is one tap, everywhere — never a form
  
- [ ] 
  
  Memory types are views: episodic=Timeline · semantic=Facts+CRM · procedural=Rhythms · user model=Self · working="why this answer?"
  

| #   | Surface | Content |
| --- | --- | --- |
| 1   | **Brief** | Front door. Model-written prose: what moved, what you owe, what's owed to you, what's stuck. Every noun tappable, every sentence correctable |
| 2   | **Messages** | The WhatsApp inbox (exists). Raw chats, media, in-chat search. Future sources add views here |
| 3   | **Spaces** | Life map by kind, nested. Badges: one-time/recurring · permanent/ephemeral · long/short-term. Goals/milestones only where kind allows. Merge/split/rename/pin one tap |
| 4   | **People (CRM)** | Person/org: relationship, shared spaces, claims w/ confidence, **owed both directions**, tone/dictionary, timeline. Businesses ≠ humans |
| 5   | **Commitments** | Two lists: **You owe** / **Owed to you**, grouped by space. Same badges. Direction, due, evidence, done-method visible. **Resolved shown as resolved with evidence.** Approve/snooze/dismiss inline; suggestions visually distinct |
| 6   | **Facts** | Claims browser: filter person/space/predicate/confidence/privacy. Evidence, validity window, belief history. One-tap correct/confirm |
| 7   | **Self** | User model: preferences, voice, boundaries, goals, dictionary — editable, pinnable. Shows what's injected everywhere |
| 8   | **Timeline** | Episodic: chronological, filter by person/space/source/kind |
| 9   | **Rhythms** | Confirmed vs candidates, evidence counts, confirm/dismiss |
| 10  | **Chat + Search** | One box. Grounded, cited; "why this answer?"; agentic lookups visible |
| 11  | **Attention** | One queue: elicitation questions (ranked), approvals, low-confidence artifacts, change digest |
| 12  | **Settings** | Exists, extended: sources + fast/deep windows · per-process model picker · **full token/cost accounting: every call, agent, process — per day + per bootstrap, four token counts + cost** · runs viewer · brain folder · kill switch |
| 13  | **Health** | Bootstrap progress (pass, wave, %, live cost, ETA) · reject rate by agent×code · chat validation failures · correction rate · quarantine w/ reasons |

* * *
## 18. Metrics
Correctness:

- [ ] 
  
  Misattributed commitments **0** · direction ≥95% · duplicates <2%
  
- [ ] 
  
  Invented goals **0** · gibberish titles **0**
  
- [ ] 
  
  Superseded-claim-shown-as-current **0** · citation validity ≥95%
  
- [ ] 
  
  Calibration ±10% per confidence bucket
  

Coverage (precision without recall is failure):

- [ ] 
  
  Spaces ≥ the best prior system on the same corpus (55 on the reference 30-day corpus)
  
- [ ] 
  
  Commitments ≥100/month of dialogue · inbound >20 · resolved-detected >0
  
- [ ] 
  
  Chats dropped/quarantined **0** · events chunked 100%
  

Latency:

- [ ] 
  
  Connect → first artifacts ≤20 min (fast window)
  
- [ ] 
  
  Live event → surfaced artifact <15 min p50
  
- [ ] 
  
  Consolidate staleness never >6h with pending updates
  

Convergence & ops:

- [ ] 
  
  Full re-run creates **zero** new artifacts
  
- [ ] 
  
  Kill-and-restart loses zero work
  
- [ ] 
  
  Call count per 1k events tracked, trending down
  
- [ ] 
  
  Token accounting within 20% of provider truth
  

Learning:

- [ ] 
  
  Correction changes behaviour within one run: 100%
  
- [ ] 
  
  ≤15 onboarding questions resolving ≥80% of flagged ambiguity
  
- [ ] 
  
  Day-60 quality ≥ day-30
  

* * *
## 19. Appendix — evidence from shipped versions
Measured from real DBs (July 2026), three prior systems on ~the same 30-day corpus:

|     | V2 (complex) | V3 (simplified) | Whatsapp (simple) |
| --- | --- | --- | --- |
| Spaces | 6/100 chats, 2 dupes | 18, all real | **55, ~50 real, 0 gibberish** |
| Tasks | 42, **60% gibberish** | 4 (recall collapse) | **155, 0 gibberish** |
| Facts | 12, 3 contradictory | 103, evidence-linked | —   |
| Outcome | starved on 500K/day cap in 24 min; regex fallback authored garbage | $1.40, starved, over-gated | $10.34 uncapped, 456 calls, 0 errors |

Lessons wired into this spec:

1. Starvation, not stupidity → **no budgets** (rule 15)
  
2. The fallback writer was the garbage factory → **rule 13**
  
3. Advisory gates ship junk (qa-judge scored 2/5, shipped anyway) → **rule 14**
  
4. Confidence-gating killed recall (4 tasks) → **rule 16**
  
5. Regex triage misfiled meaning (marketing → financial tasks) → meaning goes to the model, batched (§12.7)
  
6. The winner's shape holds: two decision stages, judgment in prompt ("precision over recall — a wrong inference erodes trust"), invariants in code, deterministic ids, 100% provenance, all Haiku. v8 keeps that core and fixes the winner's own measured flaws: direction (54% misattribution) · done_method (81 possibly_done) · space kinds (filler goals) · cross-chat merge (fragmented spaces) · chunks + whole-unit reads (batch-boundary blindness)
