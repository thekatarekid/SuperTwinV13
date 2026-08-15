# Brain v8 — Build Plan
**This is the main execution document.** The supporting spec is `docs/brain-v8-spec.md` — read it fully before starting. Where this plan says "per spec §N", the spec section is authoritative.

**Context for the executor:**

- Repo: SuperTwin V8 (Tauri 2 + React/TS frontend `src/`, Node worker `worker/src/`, Go WhatsApp daemon `sources/whatsapp-go/`)
  
- DB: SQLite via better-sqlite3, WAL, `foreign_keys=ON`, migration runner in `worker/src/db/connection.ts`, migrations in `worker/src/db/schema.ts` (array ends at `0020_video_posters`; new ids start `0021`)
  
- LLM: Claude CLI provider in `worker/src/providers/` (stdin prompt, stream-json, session guards, `plainCompletion` mode). Default model for all new roles: **haiku**
  
- Tests: vitest (`*.test.ts` beside sources). Go: `go test ./...`
  
- **Fresh install. No data migration.** The user clears the local DB. Old brain tables are dropped; new tables use clean names
  
- Existing machinery that STAYS and is reused: events pipeline, events_fts (7 cols), event_embeddings, media enrichment (describe/transcribe/frames/ link), corpus writer (`worker/src/retrieval/corpus.ts`), semantic indexer, brain root + git (`worker/src/brain/root.ts`), runs viewer, quota tracking
  

**Global rules for every task (from spec §2 — violations are bugs):**

- [ ] 
  
  No agent writes state — proposals → apply layer only
  
- [ ] 
  
  No code-authored user-facing strings
  
- [ ] 
  
  No fallback writers; blocked = defer + resume
  
- [ ] 
  
  Gates block or don't exist
  
- [ ] 
  
  No budget caps; batch calls instead (spec §12)
  
- [ ] 
  
  Every LLM call logged to `extraction_runs` with role, model, 4 token counts, cost
  

* * *
## Parallelization map
```
Stage 1 (all parallel):   P0 evals ∥ P1 substrate ∥ P2 cleanup
Stage 2 (after P1):       P3 resolve ∥ P4 chunks ∥ P5 apply-layer
Stage 3 (after P5):       P6 toolset ∥ P7 prompts+schemas
Stage 4 (after P6,P7):    P8 bootstrap ∥ P9 watchers-agents(partial)
Stage 5 (after P8):       P10 steady-state ∥ P11 search+chat
Stage 6 (any time after
         API contracts):  P12 UI surfaces (12 parallel tasks)
Stage 7 (last):           P13 hardening ∥ P14 e2e quality gate
```

- **∥** = run as parallel subagents
  
- UI tasks (P12) only need the HTTP API contracts (defined in P8/P10/P11 tasks) — start them as soon as a contract is frozen, mock until live
  
- Within every phase, tasks marked **[∥]** are mutually parallel
  

* * *
## Phase 0 — Eval harness (∥ with P1, P2)
### T0.1 Harness skeleton [∥]
- **What:** a runner that scores the system's outputs against labelled expectations + property tests. No labelled data exists yet — the harness must run against an empty system.
  
- **Steps:**
  
  - [ ] 
    
    `worker/src/evals/` — runner CLI (`npm run evals`), fixtures dir, JSON schema for labelled items: `{id, input_ref, expect:{type, fields}, verdict}`
    
  - [ ] 
    
    Score types: exact, set-overlap, direction-match, pass-rate over N=5 runs with variance
    
  - [ ] 
    
    Report: per-metric table + trend file (`evals/results/<ts>.json`)
    
- **Tests:** runner on empty fixtures → exit 0, "0 items" report
  
- **Accept:** `npm run evals` runs and scores an empty system; N-run statistical gate works on a stub
  
### T0.2 Property tests P1–P14 [∥]
- **What:** invariants asserted directly against a DB handle (spec §2, §5).
  
- **Steps:** implement as vitest suite `worker/src/evals/properties.test.ts`:
  
  - [ ] 
    
    P1 every commitment has from+to or status=unresolved
    
  - [ ] 
    
    P2 every claim has ≥1 evidence, all evidence ids exist
    
  - [ ] 
    
    P3 no goal on relationship/routine/stream/collection spaces
    
  - [ ] 
    
    P4 no rhythm confirmed with <3 observations unless user-confirmed
    
  - [ ] 
    
    P5 no `from=self` commitment without user-authored evidence
    
  - [ ] 
    
    P6 no raw JID/phone/`@numeric` in user-facing strings
    
  - [ ] 
    
    P7 lint: no code path composes titles/names (writer inventory)
    
  - [ ] 
    
    P8 comprehension input ordered by ts, zero backward steps
    
  - [ ] 
    
    P9 no entity merge without a strong identifier match
    
  - [ ] 
    
    P10 all-historical evidence ⇒ approved=0
    
  - [ ] 
    
    P11 pipeline re-run over identical input ⇒ zero new artifacts
    
  - [ ] 
    
    P12 every done commitment has done_method
    
  - [ ] 
    
    P13 every expected table+column exists (schema introspection — guards silent CREATE-IF-NOT-EXISTS no-ops)
    
  - [ ] 
    
    P14 row counts of kept tables unchanged across the drop migration
    
- **Accept:** suite green on a fresh empty DB; each property fails when seeded with a synthetic violation (test the tests)
  
### T0.3 Labelling UI + seed eval set (build during, not before)
- **What:** one-tap labelling of real pipeline outputs; bank ~200 items.
  
- **Steps:**
  
  - [ ] 
    
    Worker route `POST /api/evals/verdict` `{output_type, output_id, verdict: correct|wrong|partial, note?}` → `evaluations` table
    
  - [ ] 
    
    Frontend: verdict chips on every artifact card (reuse in P12)
    
  - [ ] 
    
    Export: `npm run evals:bank` converts verdicts → labelled fixtures
    
  - [ ] 
    
    Synthetic supplements: generate Hinglish/forwards/broadcast edge cases as fixtures (script, ~30 items)
    
- **Accept:** a verdict tapped in UI appears in the next `evals:bank` export
  
- **Depends:** first pipeline outputs (P8); UI chips land with P12
  

* * *
## Phase 1 — Substrate (∥ with P0, P2)
### T1.1 Migration 0021: drop old brain tables
- **What:** fresh-install cleanup. **Precondition: T2.1 (store.ts gut) must merge first** — better-sqlite3 `prepare()` throws eagerly on missing tables.
  
- **Steps:**
  
  - [ ] 
    
    `ALTER TABLE actors DROP COLUMN person_id`
    
  - [ ] 
    
    Drop children-first: `task_runs → tasks → space_people → space_events → milestones → goals → spaces → patterns → people`
    
  - [ ] 
    
    Note: `PRAGMA foreign_keys=OFF` is a no-op inside the runner's transaction — order is the only safety
    
- **Tests:** fresh-DB boot green; upgraded-from-0020 boot green; P14
  
- **Accept:** both boots clean; no code references dropped tables (grep CI)
  
### T1.2 Migrations 0022–0027: new schema
- **What:** all new tables per spec §4, exact DDL. Clean names.
  
- **Steps:** one migration per group, ids in order:
  
  - [ ] 
    
    `0022_entities` — entities, entity_identifiers, entity_aliases
    
  - [ ] 
    
    `0023_predicates_claims` — predicates + seed vocabulary (spec §7), claims, claim_evidence, claims_fts, claim_embeddings
    
  - [ ] 
    
    `0024_spaces` — spaces, space_parents (+ partial unique is_primary), space_tags, space_events, goals, milestones
    
  - [ ] 
    
    `0025_commitments` — commitments, commitment_evidence, runs
    
  - [ ] 
    
    `0026_rhythms_chunks` — rhythms, rhythm_observations, chunks, chunk_events, chunk_links, **chunk_segments** (spec §8.2)
    
  - [ ] 
    
    `0027_process` — proposals, corrections, questions, dossiers (incl. `threads_json` thread registry), jobs
    
  - [ ] 
    
    All CHECK constraints and indexes exactly as spec §4
    
- **Tests:** P13 (every table+column present) · CHECK constraints reject seeded violations (direction-less open commitment, goal on relationship, confirmed rhythm with 2 observations)
  
- **Accept:** fresh DB boots; P13 green; constraint tests green
  
### T1.3 db access layer [∥ after T1.2]
- **What:** typed statement modules per table group, `worker/src/db/brain/*.ts` (entities.ts, claims.ts, spaces.ts, commitments.ts, rhythms.ts, chunks.ts, process.ts).
  
- **Steps:** lazy-prepared statements (no eager prepare-all) · deterministic id minting (`sp:<slug>`, `cm:<space>:<slug>:<hash>`) · INSERT OR IGNORE upserts · live-claim and reverse-claim queries · owed(direction) query
  
- **Tests:** unit per module; id determinism (same input → same id)
  
- **Accept:** all modules typed, tested, no eager prepare
  

* * *
## Phase 2 — Cleanup of dead V8 code (∥ with P0, P1)
### T2.1 Gut store.ts [∥]
- **What:** `worker/src/store/store.ts` eagerly prepares 65 statements, many against tables 0021 drops.
  
- **Steps:**
  
  - [ ] 
    
    Keep: app_state settings keys, model selection, extraction_runs logging, quota
    
  - [ ] 
    
    Delete: all spaces/goals/milestones/tasks/patterns/people/ space_people/space_events statements + their exports
    
  - [ ] 
    
    Move `slugify` usage: import stays from `brain/markdown.ts`
    
- **Tests:** fresh-DB boot; existing settings/runs/quota tests stay green
  
- **Accept:** boot green with T1.1 applied; no dead exports
  
### T2.2 Remove dead brain wiki code [∥]
- **What:** Phase-2 leftovers with zero callers.
  
- **Steps:**
  
  - [ ] 
    
    Delete `worker/src/brain/writers.ts` (7 writers + 1 reader + 5 types), prune `brain/index.ts` re-exports
    
  - [ ] 
    
    Delete upsert/managed-section helpers in `brain/markdown.ts`; KEEP `slugify`
    
  - [ ] 
    
    Prune `LAYOUT_DIRS`/`ME_SEEDS` in `brain/root.ts` AND prune `brain-template/` (template copy would recreate them)
    
  - [ ] 
    
    Delete `brain/routes.ts` + `getBrainFile()`/`BrainFile` in `src/lib/worker-client.ts`
    
  - [ ] 
    
    Update `server/brain-folder.test.ts` file-count expectation
    
  - [ ] 
    
    KEEP: `ensureBrain()`, `commitBrain()`, `brainRoot()`, `/api/brain/info`, `/api/brain/reveal`
    
- **Tests:** typecheck clean; worker + frontend suites green
  
- **Accept:** zero references to deleted symbols
  

* * *
## Phase 3 — Entity resolution (after P1)
### T3.1 Identity normalization lib [∥]
- **Steps:** E.164 phone normalize · email lowercase · JID → phone extraction · `worker/src/resolve/identity.ts`
  
- **Tests:** table-driven (Indian numbers, JIDs, edge formats)
  
- **Accept:** 100% of fixture identities normalize stably
  
### T3.2 Resolver [∥ after T3.1]
- **What:** contacts-first entity creation; actors → entities.
  
- **Steps:**
  
  - [ ] 
    
    Seed self entity (`is_self=1`) from WhatsApp self JID (`app_state whatsapp.self_jid`)
    
  - [ ] 
    
    Walk `actors`/`channels`: create entities + identifiers; JID = strong id
    
  - [ ] 
    
    `channels.is_business=1` → entity kind `org`
    
  - [ ] 
    
    Merge ONLY on (scheme,value) match → `merged_into` (reversible)
    
  - [ ] 
    
    Alias table fed from display names/push names — never merges
    
  - [ ] 
    
    `who_is(ref)` resolver: alias → candidates → channel-context disambiguation → entity or `unresolved`
    
- **Tests:** P9 · two "Rahul"s stay distinct · same phone across sources merges · business ≠ person
  
- **Accept:** run on real corpus copy: zero name-only merges; every actor maps to exactly one entity
  

* * *
## Phase 4 — Chunker (after P1, ∥ with P3)
### T4.1 Chunk boundaries [∥]
- **What:** deterministic chunking per source shape (spec §8).
  
- **Steps:**
  
  - [ ] 
    
    Dialogue: burst = >4h gap or day boundary, ≤200 events; open-chunk extension on live events
    
  - [ ] 
    
    Shape from source/channel type; records/signals rules stubbed for future sources (interface now, WhatsApp-only impl)
    
  - [ ] 
    
    Fingerprint = (count, max rowid, text length) — reopen on mismatch (edit/late transcript)
    
  - [ ] 
    
    Backfill job: chunk the entire existing events table
    
- **Tests:** boundary cases (exact 4h, midnight, 200-cap) · reopen on simulated edit · 100% event coverage
  
- **Accept:** every event belongs to exactly one chunk; re-run is a no-op
  
### T4.2 Segmentation — embedding drift [∥ after T4.1]
- **What:** topic-labeled sub-ranges inside chunks, layer 1 of 2 (spec §8.2). $0 — uses existing local event_embeddings.
  
- **Steps:**
  
  - [ ] 
    
    Sliding window over the burst's event embeddings; cosine drop between adjacent windows = boundary candidate
    
  - [ ] 
    
    Merge with structural signals: `reply_to` threads, participant changes, media boundaries
    
  - [ ] 
    
    Write `chunk_segments` rows, method=`drift`, topic NULL (labeled later by W2 rider)
    
  - [ ] 
    
    Re-derive on chunk reopen (segments are derived data)
    
- **Tests:** synthetic 2-topic burst splits at the seam · single-topic burst stays one segment · re-derive idempotent
  
- **Accept:** every dialogue chunk ≥200 tokens has segments; boundaries stable across re-runs
  
### T4.3 Chunk graph + summary/segment rider [∥ after T4.2, needs P7 prompt]
- **Steps:**
  
  - [ ] 
    
    Deterministic links: shared entities (via chunk_events → actors → entities), time overlap
    
  - [ ] 
    
    One batched LLM pass per hundreds of chunks: one-line summary + entity tags + **segments** `{events: range, topic}` in the SAME call (spec §8.2 — same input tokens, more output). Reconcile with drift segments: LLM ranges win, method=`llm`
    
  - [ ] 
    
    `read_chunk(id)` renders raw chunk text: `[ts] speaker: text` lines + media descriptions + transcripts inline
    
  - [ ] 
    
    **No standalone LLM chunking pass** — segmentation only ever rides the summary call or comprehension
    
- **Tests:** summary+segment pass on 50-chunk fixture = 1 call · segment ranges validated (in-chunk, chronological, no overlap) · link symmetry · render golden-file test
  
- **Accept:** chunk graph populated on real corpus; summaries ≤120 chars; segments carry topics ≤80 chars
  

* * *
## Phase 5 — Apply layer (after P1; the heart — do not parallelize internally)
### T5.1 Proposal schema + validator
- **Steps:**
  
  - [ ] 
    
    TS types for all 14 proposal kinds (spec §5.1) + zod (or hand) runtime validation
    
  - [ ] 
    
    All `E_*` rules (spec §5.2) as pure functions `(proposal, db) → ok | {code, detail}`
    
  - [ ] 
    
    `STRUCTURE_POLICY` constant (spec §3.2) consumed by goal/milestone rules
    
  - [ ] 
    
    Origin rule: signal/record-origin proposals cannot be commitments without explicit terms (spec §14)
    
- **Tests:** one test per rule × (pass, fail) minimum; E_SELF_UNSUPPORTED against synthetic actor/self mapping
  
- **Accept:** every rule has a stable code, a test pair, and a counter
  
### T5.2 Applier
- **Steps:**
  
  - [ ] 
    
    One transaction per batch; topological order (entities → claims → spaces → goals → milestones → commitments → rhythms → questions)
    
  - [ ] 
    
    Forward refs within batch resolved; per-proposal rejection doesn't fail the batch
    
  - [ ] 
    
    Dedupe-by-meaning exactly per spec §5.3 (incl. title-embedding cosine ≥0.90 for commitments — use local embedder)
    
  - [ ] 
    
    Confidence formula (spec §6.1) computed here; `user_pinned` bypass
    
  - [ ] 
    
    single_valued predicates auto-supersede (set valid_to + superseded_by)
    
  - [ ] 
    
    `rhythms.observation_count` recomputed from rhythm_observations — never taken from the proposal
    
  - [ ] 
    
    Rejections persisted with code+detail; counters exposed
    
- **Tests:** P11 (apply same batch twice → zero new) · supersede chain correctness · partial-batch apply · pinned protection
  
- **Accept:** P1–P14 green after applying a realistic synthetic batch; reject counters visible via `/api/health` (contract: T10.4)
  

* * *
## Phase 6 — Read toolset (after P4, P5)
### T6.1 Tools [each tool ∥]
- **What:** shared toolset for all agents + chat (spec §13), exposed to the Claude CLI as whitelisted tools in grounded runs, and as internal functions.
  
- **Steps:** implement + test each:
  
  - [ ] 
    
    `search(query, filters)` — fused (stub fusion until T11.1; FTS-only interim)
    
  - [ ] 
    
    `read_chunk(chunk_id)` (from T4.3)
    
  - [ ] 
    
    `read_topic(space_id | topic)` — **virtual chunk** (spec §8.4): event ids from space_events + segments → expand ±n via read_around → merge overlapping windows → one chronological view across chats and sources
    
  - [ ] 
    
    `read_around(event_id, n)` — window in same channel
    
  - [ ] 
    
    `who_is(ref)` (from T3.2)
    
  - [ ] 
    
    `timeline(entity_id, from?, to?)`
    
  - [ ] 
    
    `recall(subject, predicate?, as_of?)` — live + historical claims
    
  - [ ] 
    
    `owed(direction: in|out)` — open commitments
    
  - [ ] 
    
    `transcribe(event_id)` — existing whisper path
    
  - [ ] 
    
    `unfurl(url)` — existing link-scrape path
    
- **Tests:** each tool standalone against the real corpus copy; malformed input → typed error, never throw · `read_topic` merges a topic spanning 2 chats into one chronological view with no duplicate events
  
- **Accept:** all 10 callable via one registry; docs string per tool (agents read these)
  

* * *
## Phase 7 — Prompts + output schemas (∥ with P6)
### T7.1 Structured output contracts [∥]
- [ ] 
  
  **Steps:** JSON schemas for each agent's output: comprehend (proposals + dossier delta incl. thread-registry entries + segment corrections), cartograph (space ops), investigate (answers[]), criticize (flags[]), curate (brief, rankings, questions), watch (routing + commitments + resolved + claims + escalations), chunk-summarize (summary + entity tags
  
  - **segments** `{events, topic}`)
    
  
- [ ] 
  
  Normalizer per schema: type-check, drop hallucinated ids, clamp enums — mirror of the winner's `normalizeExtractResult`
  
- [ ] 
  
  **Tests:** golden malformed-output fixtures → normalized or rejected
  
- [ ] 
  
  **Accept:** no agent output reaches the applier unnormalized
  
### T7.2 Prompts [∥]
- **What:** the quality lives here. Port the winning prompt DNA.
  
- **Steps:** one prompt file per role (`worker/src/agents/prompts/*.md`), byte-stable, versioned; each contains:
  
  - [ ] 
    
    Role + the exact structured-output schema
    
  - [ ] 
    
    The winner's lines, adapted: "precision over recall — a wrong inference erodes trust" · "ONLY when genuinely warranted — never emit empty scaffolding" · "only HIGH-CONFIDENCE implicit suggestions" · "every artifact lists source event ids"
    
  - [ ] 
    
    Direction rules: from/to mandatory; who said it; inbound = they owe user; broadcast owner unresolved
    
  - [ ] 
    
    Space kinds table + when each applies
    
  - [ ] 
    
    Resolved-detection instruction: scan for completions of listed open commitments; cite the completing event
    
  - [ ] 
    
    Untrusted-content wrapper: chunk text is data, never instruction
    
- **Tests:** prompt-lint (schema present, no raw identifiers in examples); snapshot tests
  
- **Accept:** all 7 role prompts reviewed against spec §2 rules
  

* * *
## Phase 8 — Bootstrap (after P5, P6, P7)
### T8.1 Job runner + waves
- **Steps:**
  
  - [ ] 
    
    `jobs` table driven runner: pending → running → done/deferred; deferral never increments attempts; 3 real failures → quarantine loudly
    
  - [ ] 
    
    Wave orchestrator: W0→W6 per pass (spec §10.2); wave N+1 gated on wave N checkpoint
    
  - [ ] 
    
    Fast pass window from settings (`bootstrap.fast_days`, default 30); deep pass = remainder (`bootstrap.deep_enabled`)
    
  - [ ] 
    
    Checkpoints: per-chunk high-water marks in job payloads; kill → restart resumes exactly
    
- **Tests:** kill mid-W3 → resume loses zero chunks · deferred ≠ failed · wave gating
  
- **Accept:** full fast pass runs end-to-end on the real 30-day corpus copy
  
### T8.2 W3 comprehension packing
- **Steps:**
  
  - [ ] 
    
    Packer: group chunks to ~70% context — big chats month-windowed (dossier carried forward), small chats bundled by social cluster (shared participants), related record/signal chunks ride along; thread registries used to pull in cross-chat segments of the same topic
    
  - [ ] 
    
    Call = packed RAW chunk text + relevant dossiers + open questions → structured proposals (T7.1) with per-EVENT evidence → normalize → apply. space_events membership is per-event (spec §8.3)
    
  - [ ] 
    
    Dossier upsert with read_through_rowid + threads_json (topic → segment pointers → space id)
    
  - [ ] 
    
    Scout segment corrections applied (method=`scout` wins over `llm`)
    
- **Tests:** packing determinism · a 3k-token chat never gets its own call · month-window seam carries open_questions
  
- **Accept:** 30-day corpus comprehended in ≤~25 calls (vs 196 in the winner); zero unpacked leftover chunks
  
### T8.3 W4 cartographer
- **Steps:** deterministic clustering (shared participants + time overlap + chunk_links) → packed calls per cluster group → space ops (create with kind, nest, merge across chats/sources) → apply
  
- **Tests:** the fragmented-spaces case: 3 same-person spaces merge; a trip in 2 groups + 1 DM = 1 space
  
- **Accept:** kinds assigned on 100% of spaces; zero goals on goal-forbidden kinds (P3)
  
### T8.4 W5 investigator + critic
- **Steps:**
  
  - [ ] 
    
    Question grouping by shared context → packed calls; toolset access; output = evidence-cited answers or `cannot_determine`
    
  - [ ] 
    
    Critic: whole proposal-set falsification, dozens per call, reads raw chunks; flag → −0.25 + block-from-surface + question if above threshold
    
- **Tests:** seeded false claims (10 synthetic) → ≥9 flagged · flags actually block surfacing
  
- **Accept:** unresolved rate visible; zero guessed answers
  
### T8.5 W6 curator + elicitation
- **Steps:** rank artifacts · suppress below-band · author the Brief (model-written prose, every noun carrying an artifact ref) · pick ≤15 questions by value_score
  
- **Tests:** brief refs resolve 100% · question cap respected
  
- **Accept:** fast pass ends with Brief + populated surfaces + ≤15 questions
  
### T8.6 Bootstrap progress API + deep pass
- **Steps:** `GET /api/bootstrap/status` `{pass, wave, pct, tokens, cost, eta}` (SSE updates) · deep pass runs same waves windowed month-by-month backwards · deep evidence updates artifacts via apply (validity windows, resolved commitments)
  
- **Tests:** P11 across fast+deep overlap (no dupes) · status monotonic
  
- **Accept:** 1-year synthetic corpus completes across a forced restart; UI contract frozen for P12.13
  

* * *
## Phase 9 — Enrichment batching (∥ with P8, after P7)
### T9.1 Vision batching [∥]
- **What:** existing media describe pipeline calls per image-batch already; align to spec: many images per call, haiku default, logged per role `media`.
  
- **Steps:** batch N images/call (existing queue) · ensure historical media is fast-pass-window first, then deep
  
- **Accept:** media described for fast window before W3 needs it (W0 gate)
  
### T9.2 Record/signal comprehension stubs [∥]
- **What:** WhatsApp-only today, but the interfaces ship now.
  
- **Steps:** shape router (dialogue/record/artifact/signal per channel/source) · record classification prompt (batched) behind an interface with a single WhatsApp business-channel implementation · apply-layer origin rule already blocks signal→commitment (T5.1)
  
- **Accept:** adding a source = adapter + chunk rules only; zero brain changes (proven by a mock source in tests)
  

* * *
## Phase 10 — Steady state (after P8)
### T10.1 Micro-batch watcher
- **Steps:**
  
  - [ ] 
    
    Trigger: 10-min lull or ≥50 pending (reuse the winner's cadence; existing ingest nudge machinery)
    
  - [ ] 
    
    Deterministic pre-triage ONLY where certain: exact-format OTP, known-noise channel list, media → enrich queue
    
  - [ ] 
    
    One packed call per micro-batch: route → spaces · commitments both directions · resolved-detection vs open commitments (cite event → done_method=stated) · claim updates · escalations
    
  - [ ] 
    
    Live events: is_historical=0; approval tiers apply (no auto-anything in this phase — execution is out of scope)
    
- **Tests:** batch of 60 mixed events = 1 call · OTP never reaches the model · resolved-detection marks a seeded completion
  
- **Accept:** live event → surfaced artifact <15 min p50 on a replay of the real corpus tail
  
### T10.2 Consolidate cycle
- **Steps:** every 3–6h, early-trigger ≥N applied updates, skip when idle · fold chunk deltas into dossiers · recompute rhythms (cadence detection = statistics; naming = model) · regen self.md + wiki + corpus · git commit · Critic packed pass over new artifacts · Brief refresh · question re-rank
  
- **Tests:** trigger logic (count, timer, idle-skip) · self.md ≤800 tokens · wiki renders from claims only
  
- **Accept:** consolidate staleness never >6h with pending updates
  
### T10.3 Rolling re-verify (auditor)
- **Steps:** continuous low-rate job: N oldest-verified artifacts + fast-volatility claims per packed call, re-read raw chunks, propose supersede/confirm/question · drift metric
  
- **Tests:** seeded stale claim gets flagged within one sweep
  
- **Accept:** every artifact carries last_verified; oldest-first ordering holds
  
### T10.4 Correction loop
- **Steps:**
  
  - [ ] 
    
    `POST /api/corrections` `{target_type, target_id, field, new_value, note?}` → pin (confidence 1.0, user_pinned=1) → corrections row → spawn rederive job (direct dependents only: same evidence, same subject, downstream artifacts) → suppression few-shot appended to the relevant role prompt's corrections file → eval item banked
    
  - [ ] 
    
    `/api/health`: reject rates by agent×code, validation failures, correction rate, quarantine list
    
- **Tests:** correction round-trip: wrong space subject corrected → dependent commitments re-derived in one run · blast radius bounded (graph distance 1)
  
- **Accept:** 100% of corrections change behaviour within one run
  

* * *
## Phase 11 — Search + chat (after P5, P6; ∥ with P10)
### T11.1 Fusion search
- **Steps:**
  
  - [ ] 
    
    Planner: one small call → `{intent, entities, time, as_of, keywords, predicates, needs, ambiguous}`
    
  - [ ] 
    
    Engines parallel: events_fts + claims_fts (BM25) · event+claim embeddings (cosine) · structured SQL (time/direction/status/owed) · graph hops (1–2, via claims object index)
    
  - [ ] 
    
    RRF fusion k=60, per-engine weights in settings · claims outrank events at equal score · dedupe by artifact
    
  - [ ] 
    
    Output: ranked SEGMENTS + chunks + claims with scores — segments preferred (topic-pure, denser context); chat may expand a segment via `read_topic` / `read_chunk`
    
- **Tests:** each engine standalone · fusion golden queries on real corpus ("sunday plans" finds the booking via semantic)
  
- **Accept:** p95 <500ms on 30-day corpus (pre-vec-index)
  
### T11.2 Agentic chat
- **Steps:**
  
  - [ ] 
    
    Context block: self.md digest · top claims (with confidence + validity shown) · open commitments both directions · space cards · candidate chunks — packed by policy (confidence × recency × relevance × predicate priority; reserved slots for commitments + self)
    
  - [ ] 
    
    Chunk text wrapped + marked untrusted
    
  - [ ] 
    
    Grounded run: cwd = brain root, whitelisted tools = the 9 toolset tools; model iterates agentically until answer or "don't know"
    
  - [ ] 
    
    Answer contract + deterministic post-validation (spec §15): citations resolve, no uncited assertions, no superseded-as-current, no raw identifiers; failures counted
    
  - [ ] 
    
    Verify pass on high-stakes answers (money/health/dates/commitments)
    
  - [ ] 
    
    "Why this answer?" payload: exact chunks + claims used
    
- **Tests:** citation validity ≥95% on golden Q set · unanswerable → "I don't have anything on that" · as_of historical query returns superseded claim correctly labelled
  
- **Accept:** chat green on golden set; validation failure counter wired to Health
  

* * *
## Phase 12 — UI surfaces (each task ∥; start when its API contract freezes)
Shared foundations first (T12.0), then all surfaces in parallel. Stack: existing React + tokens (`src/styles/`), tab shell (`src/App.tsx`), worker client (`src/lib/worker-client.ts`).
### T12.0 Foundations
- [ ] 
  
  Evidence popover (tap any fact → source events/chunks) — used by all
  
- [ ] 
  
  Confidence hedging styles (<0.8 visual) · correction one-tap control (pencil → inline edit → POST /api/corrections) · verdict chips (T0.3)
  
- [ ] 
  
  API client additions typed per contract
  
- [ ] 
  
  **Accept:** storybook-style fixture page renders all three controls
  
### T12.1–T12.13 Surfaces [ALL ∥ after T12.0]
| Task | Surface | Key elements | Accept |
| --- | --- | --- | --- |
| T12.1 | **Brief** | Model prose, noun→artifact refs, inline correction | every noun taps to evidence |
| T12.2 | **Messages** | KEEP existing Inbox tab as-is (rename tab "Messages") | unchanged behaviour |
| T12.3 | **Spaces** | Kind-grouped, nested tree, badges (one-time/recurring · permanent/ephemeral · long/short), goals/milestones per policy, merge/split/rename/pin | pin survives re-extraction |
| T12.4 | **People (CRM)** | entity page: claims w/ confidence, shared spaces, owed both ways, tone/dictionary, timeline; orgs separated | business never renders as person |
| T12.5 | **Commitments** | two lists (You owe / Owed to you), space-grouped, badges, done-method + evidence, resolved shown resolved, approve/snooze/dismiss | zero direction-less items rendered |
| T12.6 | **Facts** | claims browser w/ filters, validity windows, belief history, correct/confirm | superseded shown as history |
| T12.7 | **Self** | user model editor, pin controls, "what gets injected" preview | edit → pinned claim |
| T12.8 | **Timeline** | chronological events, filters person/space/source/kind | 10k events scroll smoothly |
| T12.9 | **Rhythms** | candidates vs confirmed, evidence counts, confirm/dismiss | confirm respects gate |
| T12.10 | **Chat + Search** | one box, citations clickable, "why this answer?", agentic progress | citation click opens evidence |
| T12.11 | **Attention** | questions ranked, approvals, low-confidence queue, change digest | answering a question applies downstream |
| T12.12 | **Settings** | + fast/deep windows, per-process model picker (10 roles), full token/cost accounting per call/agent/process/day/bootstrap, runs viewer, kill switch | every LLM call visible with 4 token counts + cost |
| T12.13 | **Health** | bootstrap progress (SSE), reject rates agent×code, validation failures, correction rate, quarantine | live during a bootstrap run |

- **Tests per surface:** vitest component tests (existing pattern in `src/tabs/*.test.tsx`); fixture-driven
  
- **Design:** follow existing Dayflow tokens; no new design system
  

* * *
## Phase 13 — Scale hardening (after P8, P10, P11)
### T13.1 sqlite-vec [∥]
- **Steps:** integrate `sqlite-vec` extension (or better-sqlite3-compatible ANN alternative) · migrate event_embeddings + claim_embeddings reads · keep (model,dim) invalidation
  
- **Tests:** parity vs brute force on 10k vectors · perf at 250k synthetic
  
- **Accept:** search p95 <500ms at 250k events
  
### T13.2 Sharding + tiering [∥]
- **Steps:** corpus/chunk month-sharding past ~5k msgs/chat · recency tiering: low-signal old chats take bundled path (setting)
  
- **Accept:** 1-year synthetic corpus bootstraps within context limits
  
### T13.3 One-year soak [after T13.1–2]
- **Steps:** synthetic 1-year multi-chat corpus (generator script) → full bootstrap with 2 forced restarts → steady-state replay of final week
  
- **Accept:** zero dropped chats · P11 convergence · cost within estimate · all metrics (spec §18) reported
  

* * *
## Phase 14 — End-to-end quality gate (last; the moment of truth)
### T14.1 Beat the reference
- **What:** the prior simple brain produced 55 spaces / 155 tasks / 0 gibberish on the real 30-day corpus. v8 must beat it on the same data.
  
- **Steps:** run full fast pass on the real corpus copy → label outputs via T0.3 UI → score via harness → iterate prompts (T7.2) until green
  
- **Accept (all required):**
  
  - [ ] 
    
    Spaces naming real life-threads ≥55-equivalent quality; zero gibberish; zero invented goals; zero duplicate person-spaces
    
  - [ ] 
    
    Commitments ≥100; inbound >20; direction ≥95%; misattributed = 0
    
  - [ ] 
    
    Resolved-detection >0 with evidence
    
  - [ ] 
    
    First artifacts ≤20 min from connect
    
  - [ ] 
    
    P1–P14 green · re-run creates zero new artifacts
    
  - [ ] 
    
    Citation validity ≥95% on golden questions
    
  - [ ] 
    
    ~200 labelled items banked; calibration ±10% per bucket
    

* * *
## Task dependency summary
```
T2.1 → T1.1 → T1.2 → {T1.3, T3.*, T4.*, T5.*}
T5.* → T6.* ; T7.* independent after T1.2
{T6, T7} → T8.1 → T8.2 → T8.3 → T8.4 → T8.5 → T8.6
T7 → T9.* (∥ T8)
T8 → T10.1 → {T10.2, T10.3, T10.4}
{T5, T6} → T11.1 → T11.2
contracts(T8.6, T10.4, T11.2) → T12.0 → T12.1–T12.13 (all ∥)
{T8, T10, T11} → T13.* → T14.1
T0.* ∥ everything; T0.3 completes during T8/T14
```

**Suggested parallel subagent allocation:**

- Agent A: P1 substrate → P5 apply layer (the critical path)
  
- Agent B: P0 evals + P2 cleanup → P3 resolve
  
- Agent C: P4 chunker → P6 toolset
  
- Agent D: P7 prompts/schemas → P9 enrichment
  
- Agents E–H: P12 surfaces in parallel once contracts freeze
  
- Reconvene: P8 bootstrap (needs A+C+D), then P10/P11 split, then P13/P14
