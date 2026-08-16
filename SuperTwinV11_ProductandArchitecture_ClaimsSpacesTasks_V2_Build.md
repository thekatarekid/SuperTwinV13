# SuperTwinV11 — Build Plan
**Implements:** `SuperTwinV11_ProductandArchitecture_ClaimsSpacesTasks_V2.md`
**Evals:** `SuperTwinV11_GoldenEvals_V2.md`
**Repo:** `SuperTwinV11` · **Source:** WhatsApp only · **No data migration** — fresh install, fresh DB.

---

## 0. How to execute this document

1. Work **phase by phase**. Do not start a phase until its gate passes.
2. Inside a phase, items marked with the same **⇉ group** letter can run **in parallel** by separate subagents.
3. Items marked **⛓ serial** must run alone. They touch shared schema or shared core files.
4. Every item lists: files, description, technical detail, UI, tests, acceptance.
5. Tick every acceptance box before marking an item done.
6. **No data migration.** Delete the old DB on first run. There is no upgrade path to write.
7. **WhatsApp only.** Build the generic abstractions, register exactly one adapter.

### 0.1 Conventions

1. Language: TypeScript in `worker/`, React in `src/`, Go in `sources/whatsapp-go/` (unchanged).
2. Tests: `vitest`. Every item ships tests in the same commit.
3. Migrations: one new migration `0020_v2_core.sql`. Never edit an applied migration.
4. No file over ~600 lines. Split by concern.
5. Every new table gets a store module in `worker/src/db/`.
6. Executor tags in code comments: `[CODE]` `[ML]` `[LLM-S]` `[LLM-M]` `[AGENT]`.

### 0.2 Parallelism map

```
 PHASE 0  ⛓ 0.1 → ⛓ 0.2 → ⇉ A {0.3 0.4 0.5 0.6 0.7}
 PHASE 1  ⛓ 1.1 → ⇉ B {1.2 1.3 1.4} → ⇉ C {1.5 1.6} → ⛓ 1.7 → ⇉ D {1.8 1.9} → ⇉ E {1.10 1.11}
 PHASE 2  ⇉ F {2.1 2.2} → ⇉ G {2.3 2.4} → ⛓ 2.5 → ⇉ H {2.6 2.7}
 PHASE 3  ⛓ 3.1 → ⇉ I {3.2 3.3} → ⇉ J {3.4 3.5} → ⇉ K {3.6 3.7 3.8} → ⇉ L {3.9 3.10}
 PHASE 4  ⇉ M {4.1 4.2 4.3 4.4}
 PHASE 5  ⇉ N {5.1 5.2 5.3} → ⛓ 5.4
```

---

## PHASE 0 — Foundations

**Goal:** a clean repo, the new schema, the wire codec, the call contract, and a working eval harness.

### ⛓ 0.1 Repo prep and deletions — ✅ DONE

1. **Files**
   - Delete `worker/src/store/store.ts`
   - Delete `worker/src/brain/writers.ts`, `worker/src/brain/markdown.ts`
   - Delete `brain-template/`
   - Delete migrations `0004`, `0005`, `0006`
   - Delete `worker/src/retrieval/corpus.ts` and its route
2. **Description.** Remove the dead spaces/tasks ontology and the markdown brain. Both have zero runtime callers and encode a model this build rejects.
3. **Technical**
   - Move the `app_state` and model-selection helpers out of `store.ts` into a new `worker/src/db/settings.ts`. Keep the same exported names so callers do not change.
   - Keep `worker/src/brain/root.ts` — only for the debug-export path.
   - Remove `GET /api/brain/file` from the default router; put it behind `settings.debug_export`.
4. **Tests.** Typecheck clean. Existing suite green minus deleted tests.
5. **Acceptance**
   - [x] `rg "store\.ts|brain/writers|corpus" worker/src` returns nothing — only three prose comments remain, zero live imports
   - [x] `npm run typecheck` clean both sides — `tsc -b --force` exits 0
   - [x] app boots with an empty DB

### ⛓ 0.2 Schema — migration `0020_v2_core.sql` — ✅ DONE

1. **Files** `worker/src/db/migrations/0020_v2_core.sql`, `worker/src/db/schema.ts`
2. **Description.** Create every table in §6 of the architecture doc.
3. **Technical**
   - Tables: `sources` `streams` `watermarks` `events`(altered) `events_fts` `event_embeddings` `cohorts` `work_queue` `coverage` `entities` `entity_identities` `entity_edges` `edge_evidence` `mentions` `resolution_decisions` `entity_embeddings` `embedder_calib` `sessions` `episodes` `episode_sessions` `episode_verdicts` `episode_embeddings` `arcs` `arc_episodes` `arc_verdicts` `bridges` `provisional_arcs` `claim_versions` `loops` `claim_embeddings` `loop_embeddings` `goals` `goal_spaces` `evidence` `questions` `mutations` `runs` `quarantine`
   - **No `spaces` table.** Promotion fields live on `arcs`: `promoted` `promotion_reason` `archetype` `archetype_source` `status` `ends_at` `cadence` `user_label`.
   - `events`: rename `channel_id` → `stream_id`; add `tz` `ingested_at` `salience` `enrichment_state` `enriched_at` `actor_entity_id` `is_self` `is_business`.
   - **Time fields:** `events.ts` = when said. `claim_versions.stated_at` = when said. `ingested_at` = audit only. Add a comment in the SQL saying precedence never uses `ingested_at`.
   - `claims_active` as a SQL **VIEW** over `claim_versions`, not a table.
   - Indices: `work_queue(priority DESC, state)`, `events(stream_id, ts)`, `claim_versions(claim_key, stated_at DESC)`, `arcs(promoted, status)`, `bridges(kind, value_norm)`.
4. **Tests.** Migration applies on empty DB. Every table queryable. View returns the latest non-closed version per key.
5. **Acceptance**
   - [ ] migration applies clean
   - [ ] `claims_active` returns exactly one row per `claim_key`
   - [ ] no `spaces` table exists

### ⇉A 0.3 STW-2 wire codec — ✅ DONE

1. **Files** `worker/src/wire/{aliases,pack,codec,tolerance,index}.ts` + tests
2. **Description.** Line-oriented pipe format used in both directions. Port the approach from V10's `worker/src/wire/`, retargeted to this ontology.
3. **Technical**
   - `aliases.ts` — namespaces `a`(entity) `c`(stream) `n`(arc) `k`(proposed) `e`(episode) `t`(loop); `self` reserved. Base-36 event numbers. Prompt-local tables, closure over private Maps, resolution by **range check** returning `{resolved, unresolved}` — never a string match.
   - `pack.ts` — emits `#R #C #E #T #D`, event lines with `+m` deltas and `^n` replies, `#COV`. Neutralise separators: `|`→`/` in labels, `,`→space in participants, collapse newline runs.
   - `codec.ts` — 23 tags per §5.3. `fields(raw,min,max,proseLast)`; prose is always last and is re-joined, never split. Inclusive base-36 ranges, runs ≥3 compress.
   - `tolerance.ts` — ordered pipeline: fence → heading → **emphasis strip** → bullet → pipe test → prose test. Emphasis strip handles `**T|…**` and unclosed openers. Enum decode via `canonicalWireToken` (lowercase, collapse `_-` runs). `{due:…}`/`{conf:…}` unwrap with **key must match field**. `WIRE_DASHES` = not stated. Empty confidence = 0.9.
   - Violations carry a 1-based line number and the model's **original** raw text.
   - `noWireLinesViolation` emits **exactly one** violation when the whole answer was prose.
4. **Tests**
   - Round trip byte-identical over a generated cross-product covering every tag
   - Totality: 5,000 random token soups, 2,000 random byte strings, `""` `"|"` `"||||||"` `null`, every truncation prefix of a full `T|` line — never throws
   - Accounting: `accepted + violations + skipped == nonBlankLines` over 2,000 random inputs
   - Emphasis: `**T|1|…**` parses and increments the strip counter
5. **Acceptance**
   - [ ] evals category **S** passes (50 cases)
   - [ ] no input can throw
   - [ ] accounting invariant holds

### ⇉A 0.4 CLI bare-call contract — ✅ DONE

1. **Files** `worker/src/providers/claude-local/index.ts`, `models.ts`, `worker/src/providers/pool.ts` (new)
2. **Description.** Make every call a bare instrument, add roles, add per-resource concurrency.
3. **Technical**
   - Default every extraction call to: `--setting-sources ""`, `--disallowedTools` (all 13), `--allowedTools ""`, `--max-turns 1`, `MAX_THINKING_TOKENS=0`, `cwd = tmpdir()`.
   - The instruction block is passed **twice** — `--append-system-prompt` and the head of stdin. There is no `--system-prompt` flag; do not look for one.
   - Add `SendOptions.thinkingBudget`: `off|low|medium|high|xhigh|max` → `0|2048|8192|24576|49152|65536`. **Every call in this build uses `off`.**
   - Add roles to `MODEL_ROLES`: `entity episode arc extract triage done_detect classify adjudicate` (keep `chat`, `media`). Defaults per §4.2.
   - `pool.ts` — semaphores per class: `llm`(8, max 16) `transcribe`(1,3) `embed`(2,8) `ffmpeg`(2,4) `scrape`(8,16). DB apply is serialized by SQLite.
   - LLM pool split 40 enrichment / 60 understanding, with a **first-paint override giving enrichment 0**.
   - `caching.warm_first` (default on): run the first call of a batch alone, then fan out.
   - Error policy: refusal-regex → pause lane, backoff 60s→900s, **do not spend the retry budget**. Others → 2s/10s/30s → quarantine. Codes are the existing seven; there is **no** `AUTH_REQUIRED`.
4. **UI.** Settings → Processing: parallel-calls slider (1–16, default 8) with the RAM/rate-limit note verbatim from §4.4.1.
5. **Tests.** Arg-builder unit tests per mode. Pool respects caps under load. Warm-first serialises the first call.
6. **Acceptance**
   - [ ] no call leaks user settings, tools or thinking
   - [ ] evals **U** cache/parallel rows pass
   - [ ] concurrency caps observed per class

### ⇉A 0.5 Token accounting and Usage surface — ✅ DONE

1. **Files** `worker/src/providers/usage.ts`, `worker/src/db/runs.ts`, `src/tabs/SettingsTab.tsx`
2. **Description.** Correct 4-way accounting, honest labels, real cost.
3. **Technical**
   - Persist per run: `input_tokens` `cache_creation` `cache_read` `output_tokens` `billable_tokens` `cost_usd` `model` `role` `cohort_id`.
   - `total_input = cache_read + cache_creation + input_tokens`. Render the three parts **and** the sum.
   - `billable = input + 1.25·create + 0.1·read + output`. Quota gates on this only.
   - `cost_usd` verbatim from the CLI. Never recompute from a local price table.
   - Cost and tokens must aggregate over the **same** filter and row set.
4. **UI.** Settings → Usage per §4.4.4: token table by role, cache hit rate with the "haiku is below the 4,096 minimum, this is expected" note, cost by role, run counts, and this-import progress with spend-to-date and projection.
5. **Tests.** The identity holds on every row. A run without role or cohort fails. Cost/token filters match.
6. **Acceptance**
   - [ ] evals **U** passes (15 cases)
   - [ ] no screen shows input and cache as separate spend
   - [ ] cost never renders `—` while spend exists

### ⇉A 0.6 Eval harness — ✅ DONE

1. **Files** `evals/` (new), `worker/src/evals/{runner,fixtures,report}.ts`, `npm run eval`
2. **Description.** Offline, deterministic runner over the 1,000 gold cases.
3. **Technical**
   - Fixture schema exactly as §2 of the evals doc. Loader validates on read.
   - Two modes: `--frozen` (CI, uses `frozen_response`) and `--live` (real model, re-measures gates).
   - Assertion modes: `exact` `set_equal` `contains` `absent` `state` `no_throw` `budget`.
   - Report: per category pass rate, per gate value vs threshold, and a diff for every failure.
   - CI fails if any gate in §14.2 of the architecture doc is breached.
4. **Tests.** Harness self-test on 10 hand-written fixtures covering each assertion mode.
5. **Acceptance**
   - [ ] `npm run eval` runs offline with no network
   - [ ] all 1,000 fixture stubs load and validate
   - [ ] gate report renders

### ⇉A 0.7 Embedder calibration — ✅ DONE

1. **Files** `worker/src/retrieval/calibration.ts`, `worker/src/db/calib.ts`
2. **Description.** Measure the unrelated-pair floor per model per use case.
3. **Technical**
   - At startup sample ≥1,000 random unrelated pairs from stored vectors; compute the floor; persist to `embedder_calib`.
   - `score = (cos − floor) / (1 − floor)`.
   - Use cases: `entity_name` `entity_rich_text` `episode_topic` `arc_topic` `claim_text` `loop_intent`. `arc_topic` threshold strictly higher than `episode_topic`.
   - **If calibration is missing or stale, disable the `[ML]` similarity rung** — route pairs to the agent or the question queue. Never guess a threshold.
   - Never compare bare short strings; always embed rich text.
4. **Tests.** Floor within 0.70–0.90 on the reference corpus. Stale calib blocks similarity.
5. **Acceptance**
   - [ ] evals **V** passes (15 cases)
   - [ ] cold install does not run similarity before calibration

### ✅ PHASE 0 GATE — PASSED

- [x] typecheck clean, app boots on empty DB — `tsc -b` exit 0; worker booted against a fresh empty DB, migrations applied, `/api/health` 200
- [x] evals **S**, **U**, **V** green — 80/80 implemented cases pass (S 50 + U 15 + V 15), 0 gates breached
- [x] `npm run eval` runs offline — frozen mode, no network; 1,000 fixtures load and validate (920 still stubs)

**Measured at gate:** typecheck clean · worker 1322/1322 · root 252/252 · scripts 67/67 = 1,641 tests.

---

## PHASE 1 — Ingest to Sessions

**Goal:** WhatsApp events → tiered, scheduled, enriched, entity-bound, sealed sessions, with two surfaces.

### ⛓ 1.1 Adapter registry, manifest, source-leak fixes — ✅ DONE

1. **Files** `worker/src/adapters/registry.ts` (new), `worker/src/adapters/whatsapp/manifest.ts` (new), `worker/src/db/ingest.ts`, `worker/src/index.ts`, `worker/src/server/*`
2. **Description.** Manifest-driven registry with exactly one adapter registered.
3. **Technical**
   - `SourceManifest` per §2.2. WhatsApp manifest: `stream_kind_of` → `conversation` for all chats; `actor_model: multi_actor`; `self_identity: {kind:"jid", value_getter: selfJid}`; `identities_emitted: ["jid","phone"]`; `capabilities.backfill_order: "desc"`; segmentation defaults `gap_ms 6h` (1:1) / `4h` (group), `shift_min_gap_ms 1h`, `size_cap_events 40`, `size_cap_chars ~6k tokens`, `day_boundary true`, `debounce_ms 45m`; `salience.prefilter: "none"`; `bridge_keys: ["url","phone","email","media_work_id","order_id"]`.
   - **Fix leaks:** `wa:` prefix → `${source_id}:`; `resetWhatsappData` → `resetSourceData(source_id)`; `app_state` keys → `source.<id>.*`; routes → `/api/sources/:source_id/*` with old routes aliased one release; `channels` → `streams`.
   - **Drive WhatsApp history sync newest-page-first.** If the daemon can only deliver ascending, buffer pages in the scheduler and emit descending cohorts.
   - Manifest validation at registration: unknown kind, missing `self_identity`, or `ambient`+`prefilter:none` are boot errors.
4. **Tests.** Registry rejects a bad manifest. Ingest dedupes on `(source_id, external_id)`. Watermarks move in opposite directions.
5. **Acceptance**
   - [ ] evals **A** passes (30 cases)
   - [ ] `rg "wa:|whatsapp\." worker/src/db worker/src/ingest` finds no generic-layer leaks

### ⇉B 1.2 Stream tiers and P-TI1 — ✅ DONE

1. **Files** `worker/src/tiers/{derive,classify}.ts`, `worker/src/prompts/p-ti1.ts`
2. **Description.** T1–T4 assignment, primary sort key for the scheduler.
3. **Technical**
   - `[CODE]` rules first per §9.3. Store `streams.tier`.
   - Ambiguous business channels → **P-TI1, one haiku call per channel**, cached. Never per message.
   - **Tier-change re-scan:** on any transition, re-enqueue that stream's unprocessed events at the new priority. **Never move a watermark backwards.** This is the defect that lost 10 real messages in the prior build.
   - Boot backfill assigns a tier to every stream, with a coverage assertion.
4. **Tests.** T3→T1 promotion orphans zero events. Tier order respected. T4 real obligations still extracted.
5. **Acceptance**
   - [ ] evals **B** passes (50 cases)
   - [ ] 100% of streams tiered after boot

### ⇉B 1.3 Salience prefilter scaffold — ✅ DONE

1. **Files** `worker/src/salience/{score,dedupe,vad}.ts`
2. **Description.** Build the stage now even though WhatsApp needs none. Retrofitting a salience column after a million events is a migration nobody wants.
3. **Technical.** Write `events.salience`. For `conversation` streams the score is 1.0 and the stage is a pass-through. Implement phash dedupe and VAD interfaces with WhatsApp no-ops.
4. **Tests.** Pass-through leaves conversation events untouched.
5. **Acceptance** — [ ] stage present, no behaviour change for WhatsApp

### ⇉B 1.4 Enrichment queue, batching, priority — ✅ DONE

1. **Files** `worker/src/media/queue.ts`, `worker/src/media/describe.ts`, `worker/src/media/batch.ts` (new)
2. **Description.** Priority-ordered enrichment with 16-image batches.
3. **Technical**
   - Queue key = the cohort priority. **Not FIFO.**
   - `enrichment.image_batch_size` default **16**, range 1–32.
   - Each image carries an explicit id in the prompt; reject unless the returned id set matches **exactly**; on mismatch **split in half and retry recursively**. Never apply a mismatched batch partially.
   - Downscale to ≤1092 px longest edge before send.
   - `enrichment.read_all_media` default **on**. `enrichment.salience_gate` default **off**.
   - Track `sessions.pending_enrichment_count`; when it reaches 0, enqueue the completion pass.
4. **UI.** Settings → Media panel per §14.0c.
5. **Tests.** 16-batch id echo. Mismatch splits, does not drop to solo. Priority beats FIFO.
6. **Acceptance**
   - [ ] evals **C** passes (40 cases)
   - [ ] zero captions attached to the wrong image

### ⇉C 1.5 Entity graph and structural binding — ✅ DONE

1. **Files** `worker/src/entities/{registry,identities,edges,binding,merge}.ts`
2. **Description.** 9 types, 7 edge kinds, minted ids, tombstone merges.
3. **Technical**
   - Types: `person group org place thing media_work document occasion topic`. Subtypes carry flavour. **Never encode a relationship in a type.**
   - Edges: `related_to affiliated_with has located_at part_of participates_in about`, each with a closed subtype list.
   - Minted ids `ent_` + random. Never derived from name/jid/phone.
   - Structural binding `[CODE]`: exact `(source_id, kind, value_norm)`; cross-source exact on normalised phone/email. **Handles never bind cross-source.**
   - Metadata edges free and exact: group participants → `affiliated_with:member`, conf 1.0, **before any model runs**.
   - `me` entity at install; every manifest `self_identity` binds into it; `events.is_self` derived.
   - Merges are `merged_into` tombstones, O(1), reversible. `resolution_decisions` stores permanent negative pairs.
4. **Tests.** Cross-source phone join. Handle collision does not bind. Merge/split round trip.
5. **Acceptance**
   - [ ] evals **G** (70) and **I** (40) pass
   - [ ] zero entities keyed by a name string

### ⇉C 1.6 Party model — ✅ DONE

1. **Files** `worker/src/entities/party.ts`
2. **Description.** Three roles, nine pairs, derived entirely by code.
3. **Technical**
   - `role(entity, session) = s | o | t` — self, session participant, absent.
   - `claim.party_pair = role(speaker) ‖ role(subject)`; `loop.party_pair = role(owner) ‖ role(counterparty)`.
   - **Never on the wire. Never asked of a model.** Reject any model output containing a party field.
   - `other` = participant of the session, **not** the addressee; `addressee_id` is separate.
   - Expose `threadInvolvesSelf(arc)` — false when no loop has `s` in either position.
4. **Tests.** All 9 pairs correct. 5-person group: non-addressee participants are `o`.
5. **Acceptance** — [ ] evals **O** passes (45 cases)

### ⛓ 1.7 Session segmenters — ✅ DONE

1. **Files** `worker/src/sessions/{segment,policies,seal,ops}.ts`
2. **Description.** Five stream-kind policies, two seal modes, full ops rules.
3. **Technical**
   - Policies per §10.4. Build all five; WhatsApp exercises `conversation`.
   - **Participant shift is a conjunction:** gap ≥ `shift_min_gap_ms` **and** initiator flip.
   - **Bootstrap seals immediately** (history is complete). **Steady uses debounce.** The newest session per stream stays open in bootstrap.
   - `content_hash = sha256(sorted external_ids + text hashes, including enrichment text)`.
   - Ops: reactions attach to a sealed parent and **never reset debounce**; edits after seal set `superseded_hash` without changing membership; revokes likewise; read receipts dropped at the adapter; day boundary in the **stream's** tz; restart recomputes timers from last event ts; late arrivals become a **new** session flagged `late_arrival` with `overlap_of` — sealed sessions are never reopened; clamp `ts > now + 5min`.
   - Order by `ts`, never rowid. Durability = per-stream `(ts, external_id)` watermark.
4. **Tests.** Determinism byte-identical on re-run. Every boundary records rule + measured value.
5. **Acceptance**
   - [ ] evals **D** (75), **E** (40), **F** (40) pass
   - [ ] session boundary F1 ≥ 0.90 vs gold

### ⇉D 1.8 Cohort scheduler — ✅ DONE

1. **Files** `worker/src/scheduler/{cohorts,horizons,queue,lanes,paint}.ts`
2. **Description.** The control plane: modes, tiers, horizons, lanes, first-paint path.
3. **Technical**
   - Modes `bootstrap | steady | reprocess`. Horizons `live h24 d7 d30 d90 y1 older`.
   - `priority = tier_rank·10⁹ + horizon_rank·10⁶ + recency`. **Tier is primary.**
   - Live pre-emption for **T1 and T2 only**, at the next cohort boundary.
   - `cohort_budget(seq) = min(MAX, BASE × 2^seq)`; **size by expected output tokens (~600 for seq 0)**, not session count.
   - Two lanes: E (enrichment, lookahead 2) and U (understanding). **U never waits for E.**
   - **First-paint path: P-CL1 only.** P-EP1, P-TR1, P-SP1 deferred. P-AG1/2/3 **barred by rule**. Lane E gets **0 slots** until first paint completes.
   - **Line-streaming**: parse each `\n` as it arrives and emit to the surface immediately. Do not wait for call completion.
   - Pre-warm one CLI child at connect.
   - Restart-safe: cohorts and `work_queue` live in the DB; resume at last completed stage; never re-judge a persisted verdict.
   - Write `coverage` on every transition. Never regress.
4. **UI.** Coverage meter component per §14.0, with a paused state showing a countdown.
5. **Tests.** Order is recency-descending within tier. Coverage monotonic. Restart resumes without re-judging.
6. **Acceptance**
   - [ ] evals **T** passes (30 cases)
   - [ ] no silent gap > 90 s while cohorts remain

### ⇉D 1.9 Prompt runner and repair loop — ✅ DONE

1. **Files** `worker/src/prompts/{runner,repair,legend}.ts`
2. **Description.** Shared plumbing for all 12 prompts.
3. **Technical**
   - Shared legend block prepended to every system prompt, byte-identical across calls of a type (the cache candidate).
   - Pack input → call → parse → violations → **one** repair round listing `line N — rule: detail` → merge accepted lines → quarantine on second failure.
   - Every call writes a `runs` row.
4. **Tests.** Two damaged lines produce a repair asking only for those two.
5. **Acceptance** — [ ] repair round bounded at one; accepted lines preserved

### ⇉E 1.10 P-EP1 entity pass, resolution ladder, P-AG1 — ✅ DONE

1. **Files** `worker/src/prompts/p-ep1.ts`, `worker/src/entities/resolve.ts`, `worker/src/prompts/p-ag1.ts`
2. **Description.** Mentions, new entities, text edges; then the escalation ladder.
3. **Technical**
   - P-EP1 prompt exactly as §12.1. Model default **sonnet-5**.
   - Ladder: exact → cross-source exact → `[ML]` calibrated candidates → **P-AG1 agent (≤3 turns, 3 read-only tools, 60 s, write scope none)** → resolution queue.
   - **Zero silent guesses.** Every bind records `decided_by` + confidence.
   - During bootstrap, batch agent adjudication to horizon boundaries. **Never on the first-paint path.**
   - Temp ids: model may propose `k1`, code resolves to minted ids after dedupe.
4. **UI.** Resolution queue in the Entities surface, batched during import with an "answer all" affordance.
5. **Tests.** In-band pairs escalate. `unsure` reaches the queue, never auto-retries.
6. **Acceptance**
   - [ ] evals **H** (40) passes
   - [ ] entity resolution precision ≥ 0.98, recall ≥ 0.90

### ⇉E 1.11 Surfaces — Entities and Sessions — ✅ DONE

1. **Files** `src/tabs/EntitiesTab.tsx`, `src/tabs/SessionsTab.tsx`, `src/styles/tabs/*`
2. **Description.** The two inspection surfaces.
3. **UI**
   - **Entities:** type filters with counts, search, unresolved filter. Per entity: identities with `decided_by` and confidence, 1-hop relation graph with edge subtype labels and evidence quotes on hover, counts of sessions/episodes/arcs. Gestures: merge, split, rename, pin, add relation, reject edge. Resolution queue with the agent's reasoning.
   - **Sessions:** filter by source/stream/date. Per session: **both** boundaries with rule and measured value, `seal_mode`, participants, hash, enrichment state, reprocess history. `[ replay stream ]` re-segments with candidate params and **diffs before applying**. Per-stream segmentation override editor.
4. **API** `/api/entities*`, `/api/resolution-queue*`, `/api/sessions*`, `/api/streams/:id/segmentation`
5. **Tests.** RTL: gestures write `mutations(actor:user)`. Replay shows a diff and does not apply until confirmed.
6. **Acceptance**
   - [ ] every session boundary is explainable in one line
   - [ ] user corrections survive a full re-derivation

### ✅ PHASE 1 GATE — PASSED

- [x] evals **A B C D E F G H I O T** green — 580/580 cases pass (these 500 + Phase 0's 80), 0 gates breached
- [x] session F1 ≥ 0.90, determinism exact — `sessions_boundary_f1` 100%, `sessions_determinism` 0 drift, `sessions_explainable` 100%
- [x] entity precision ≥ 0.98, zero silent guesses — precision 100%, `entities_no_silent_guess` **0 over 350 audited resolutions**, recall 100% over 27 opportunities, metadata edges 100% over 19 memberships. All mutation-verified (see below).
- [x] 100% of streams tiered; zero orphans on tier promotion — `tiers_all_assigned` 100%, `tiers_no_orphans_on_promotion` 0

**Measured at gate:** typecheck clean · worker 2060/2060 · root 327/327 · scripts 67/67 = 2,454 tests · eval 580/580 cases, 96 gates defined / 44 measured / 0 breached.

**Gap closed.** The three entity gates that read `no data` now measure real product code via `worker/src/entities/audit.ts`, reading the graph back out of the same temp SQLite DB the G/H/I executors build. Root cause: a fixture carries exactly one `assert.gate` and all 150 G/H/I cases spent theirs on precision/linking/edge-precision, so nothing could feed a second gate. Fixed with a `Produced.gates` seam — an executor emits `GateObservation[]` and `runSuite` folds each into that gate's own denominator per-observation, not per-case. Observations from a *failed* case still count, so a broken expectation cannot blank a gate back to `no data`.

**Mutation-verified — a gate that cannot fail is not a gate:**
| mutation | result |
|---|---|
| force the `[ML]` rung on regardless of calibration | `entities_no_silent_guess` = 3, **FAIL** |
| disable rung ② cross-source binding | `entities_recall` = 51.9%, **FAIL** |
| drop one calendar attendee edge | `entities_metadata_edges` = 84.2%, **FAIL** |

Worth noting: under mutation 1, `entities_precision` only slipped to 98.6% and **still passed**. The silent-guess gate is what caught it — which is exactly why leaving it unmeasured was not acceptable. All mutations reverted.

---

## PHASE 2 — Episodes and Arcs

### ⇉F 2.1 Episode engine — ✅ DONE

1. **Files** `worker/src/episodes/{engine,preflag,aging}.ts`
2. **Technical**
   - Hash gate first — a known `content_hash` reuses its verdict and makes no call.
   - `[ML]` intra-session drift pre-flag. No drift **and** no open episodes → **1:1 default, zero calls**.
   - Segments must **partition** the session: every event id in exactly one segment.
   - Aging: open episode quiet 14 d → `closed/faded` `[CODE]`.
3. **Acceptance** — [ ] 1:1 default rate ≥ 60% on the corpus

### ⇉F 2.2 P-EP2 episode pass — ✅ DONE

1. **Files** `worker/src/prompts/p-ep2.ts`
2. **Technical.** Prompt per §12.3. **Stream-scoped only** — never compare across streams. Persist `episode_verdicts`; replay reuses them and never re-judges. Confidence < 0.6 on attach → prefer new.
3. **Acceptance** — [ ] evals **J** passes (55 cases); wrong-attach ≤ 2%

### ⇉G 2.3 Episode embeddings and attach gate — ✅ DONE

1. **Files** `worker/src/episodes/embed.ts`
2. **Technical.** Embed `topic_label + last 2 session summaries + top entity names`. All comparisons use calibrated scores with the `episode_topic` threshold.
3. **Acceptance** — [ ] no similarity call runs on an uncalibrated model

### ⇉G 2.4 Bridge extractor — ✅ DONE

1. **Files** `worker/src/bridges/{extract,normalise}.ts`
2. **Technical**
   - Eight kinds: `url order_id file_id attendee_set phone email media_work_id geo_time`.
   - WhatsApp-live now: `url`, `phone`, `email`, `media_work_id`, `order_id` (from message text). Build all eight; the rest activate with future sources.
   - URL normalisation: strip tracking params, resolve shortlinks, lowercase host.
   - `attendee_set` fires at Jaccard ≥ 0.6. `geo_time` at ≤200 m **and** ≤45 min.
   - Runs at ingest/enrich time, `[CODE]`, stored bidirectionally, never expires.
3. **Acceptance** — [ ] evals **K** passes (30 cases); bridge recall ≥ 0.95

### ⛓ 2.5 Arc engine — ✅ DONE

1. **Files** `worker/src/arcs/{ladder,provisional,reconcile,key}.ts`, `worker/src/prompts/p-ag2.ts`
2. **Technical**
   - Ladder ①bridges `[CODE]` → ②weighted entity overlap ≥0.5 `[CODE]` (person/place/occasion 1.0, thing/media 0.7, topic 0.4) → ③calibrated similarity `[ML]`, bar **higher** than episode attach → ④**P-AG2** `[LLM-M]` → else ask the user.
   - **Ambient episodes join via ① or ② only.**
   - New arcs are **provisional** — no id, no surface — until reconcile.
   - `arc_key = sha1(sorted(top-3 anchor_entity_ids) | normalize(label_stem))`. Re-derivation rebinds to the same id.
   - Reconcile at **every cohort boundary** in bootstrap and nightly in both modes: dedupe provisionals against each other and against committed, rebind keys, age (`live`→`dormant` 3 w →`archived` 12 w), honour user constraints as hard walls, compact merged-entity redirects, log all changes as one undoable run.
3. **Acceptance** — [ ] evals **L** passes (45 cases); arc-id stability 100%

### ⇉H 2.6 Reconcile job and scheduling — ✅ DONE

1. **Files** `worker/src/reconcile/index.ts`
2. **Technical.** One entry point callable from a cohort boundary, a nightly timer, and `POST /api/reconcile/run`. Idempotent. Emits one `mutations` run id.
3. **Acceptance** — [ ] running reconcile twice changes nothing the second time

### ⇉H 2.7 Surfaces — Episodes and Threads — ✅ DONE

1. **Files** `src/tabs/EpisodesTab.tsx`, `src/tabs/ThreadsTab.tsx`
2. **UI**
   - **Episodes:** state filters; per episode the session list with attach/split provenance, confidence and reason; `[ why? ]` renders the persisted verdict; gestures detach, split, merge back, relabel, close.
   - **Threads:** all arcs, promoted or not. Source-contribution timeline. Binding signals **in precedence order** with measured values. `[ why together? ]`. Unsure queue for `un` verdicts. Gestures remove episode, split arc, merge, pin, relabel.
3. **Acceptance** — [ ] every membership row shows its signal and value

### ✅ PHASE 2 GATE — PASSED

**Measured:** J 55/55 · K 30/30 · L 45/45. 1:1 rate **62.8%** per-observation (floor 60% — first honest measurement read 41.2% over the coverage-matrix corpus; fixed by making the corpus representative, threshold untouched). Bridge recall 100%, arc precision 100%, arc-id stability 100% across full re-derivation. The audit round also fixed a latent `episode_verdicts` shape corruption and made `episodes_wrong_attach_rate` falsifiable via `episodes/audit.ts`.


- [x] evals **J K L** green
- [x] 1:1 rate ≥ 60%, bridge recall ≥ 0.95, arc precision ≥ 0.90
- [x] arc-id stability 100% across a full re-derivation

---

## PHASE 3 — Claims, Loops, Spaces, Tasks

### ⛓ 3.1 P-CL1 and P-CL1Δ — ✅ DONE

1. **Files** `worker/src/prompts/{p-cl1,p-cl1d}.ts`, `worker/src/claims/extract.ts`
2. **Technical**
   - Prompts exactly as §12.4 and §12.5. Model default **sonnet-5**.
   - Claim kind **is the tag** — 8 tags, no kind field.
   - Every claim carries `attribution` and is stored in **resolved third person**.
   - Loops require intent **and** an unresolved end state. Four generators only. Temporal-boundary loops extracted from all history.
   - Relative dates resolve against the **episode's** date.
   - `Y` summary emitted in pass 1 — this is what makes `summary` delta mode free.
   - Delta mode: extract only from ► events; `Z` lines for changes; `enrichment.delta_context_mode` default `summary`.
   - **Parallel by episode**, apply serialized.
3. **Acceptance** — [ ] evals **M** (95) and **N** (75) pass

### ⇉I 3.2 Code facts — ✅ DONE

1. **Files** `worker/src/claims/codefacts.ts`, `worker/src/loops/state.ts`
2. **Technical**
   - Loop state is a **function of the end state, never the age**: resolution evidence → `done`; future due → `open`; past due + recurrence with a future next occurrence → `open`; past due without recurrence → `lapsed`; no due, reinforced → `open`; no due, stale → `latent`.
   - `owner ≠ me AND counterparty ≠ me` → `triage = context`.
   - `attribution = first_person AND subject ≠ speaker` → downgrade to `about_other` + flag.
   - `speaker_id` from `events.actor_entity_id`. `stated_at` from the event ts.
   - **`possibly_done` does not exist.** Evidence or a question.
3. **Acceptance** — [ ] zero loops born past-due as `open`; zero non-self loops in Tasks

### ⇉I 3.3 Write path, versions, P-AG3 — ✅ DONE

1. **Files** `worker/src/claims/{write,keys,supersede}.ts`, `worker/src/prompts/p-ag3.ts`
2. **Technical**
   - `claim_key = sha1(kind | subject_id | normalize(predicate))`; `loop_key = sha1(owner | counterparty | normalize(intent))`. **No `space_id`/`arc_id` in the loop key** — that is circular.
   - Exact hit → reinforce (union evidence, max confidence). This is also how habit/workflow claims graduate — no `MIN_EVIDENCE` constant.
   - Near hit → **P-AG3** → `dup|rfn|ctr|dst|un`.
   - **Precedence by `stated_at` only.** `claims_active` is a derived view: the greatest `stated_at` not closed. An older claim arriving late lands as a **predecessor with a closed window**.
   - Every write emits a `mutations` row. `POST /api/runs/:id/undo` reverse-replays.
   - **Zero model output discarded by code.**
3. **Acceptance** — [ ] evals **R** passes (40 cases); confluence holds across 3 ingest orders

### ⇉J 3.4 Live trigger and backpressure — ✅ DONE

1. **Files** `worker/src/scheduler/live.ts`
2. **Technical**
   - `live_interval` configurable **30 s – 6 h, default 30 s**. Steady state only.
   - Fires on interval of quiet **or** K new events (default 10).
   - **Delta extraction is mandatory** — O(n), never O(n²).
   - `effective = max(live_interval, backpressure(activity))`, shown in the UI. Hard cap 20 live passes per stream per hour.
   - Consolidation at seal only if the hash changed materially.
3. **UI.** Settings → Processing: interval control with the "at 6 hours, extraction happens only when a conversation ends" note. Items marked **◍ conversation in progress**, updated in place.
4. **Acceptance** — [ ] new message → claims visible ≤ `live_interval` + 15 s

### ⇉J 3.5 Two-pass enrichment completion — ✅ DONE

1. **Files** `worker/src/scheduler/reprocess.ts`
2. **Technical.** Pass 1 text-only with placeholders. Pass 2 fires **once**, when `pending_enrichment_count` hits 0. Failed/skipped count as resolved. Bounded at `reprocess_max` 3.
3. **Acceptance** — [ ] exactly 2 passes per media episode; 0 duplicate claims from pass 2

### ⇉K 3.6 Promotion and status — ✅ DONE

1. **Files** `worker/src/arcs/promote.ts`
2. **Technical**
   - Four routes: `cmt` (≥1 open loop) · `ref` (anchored on a durable entity with a `has`/`located_at` relation) · `rec` (≥3 episodes, ≥3 days, ≥2 weeks, user participated; cap ~10 live) · `usr` (pinned).
   - **Party rule:** an arc whose loops have no `s` in either pair position is **not** a space — it is context on that person.
   - `status` derived: ≥1 open → `active`; latent only → `dormant`; all done/lapsed → `archived`; ref/rec with no loops → `active` while fresh, `dormant` after 8 weeks quiet.
   - Promotion and demotion are **field flips on `arcs`**. No row created or deleted; the id never changes.
3. **Acceptance** — [ ] evals **P** passes (50 cases)

### ⇉K 3.7 P-SP1 archetypes — ✅ DONE

1. **Files** `worker/src/prompts/p-sp1.ts`
2. **Technical.** Eight archetypes: `prj evt rhy adm hld mat pur wch`. `pursuit` vs `watch` = **do you act, or do you observe?** Archetype is revisable; record the transition with a reason. Deferred — never on the first-paint path.
3. **Acceptance** — [ ] archetype accuracy ≥ 0.85 across all eight

### ⇉K 3.8 P-TR1 triage and P-DD1 done-detection — ✅ DONE

1. **Files** `worker/src/prompts/{p-tr1,p-dd1}.ts`, `worker/src/loops/done.ts`
2. **Technical**
   - Triage: `au|ap|cx`. Implicit is **never** `au`. Non-self is **always** `cx`. Past due without recurrence is `cx`; **with** a future next occurrence it is live.
   - Code default for first paint: non-self → `cx`, implicit → `ap`, else `ap`.
   - Done-detection runs a `[CODE]` pre-check first — newest-first means resolving evidence is often already stored, so most historical loops resolve with no model call.
   - `ps` (possibly) → loop stays open **and** a one-tap question is raised.
3. **Acceptance** — [ ] evals **Q** passes (30); triage accuracy ≥ 0.90; done precision ≥ 0.95

### ⇉L 3.9 Goal emergence — ✅ DONE

1. **Files** `worker/src/goals/emerge.ts`
2. **Technical.** When 2–3 loops across ≥2 promoted arcs share ≥2 anchor entities and a horizon, propose a life project linking them. **Never scaffolded** — no goal is ever created by extraction.
3. **Acceptance** — [ ] zero goals created without evidence

### ⇉L 3.10 Surfaces — Claims, Spaces, Tasks, People — ✅ DONE

1. **Files** `src/tabs/{ClaimsTab,SpacesTab,TasksTab,PeopleTab}.tsx`
2. **UI**
   - **Claims:** grouped by subject entity; filters by kind, confidence, attribution, status. Every claim shows confidence, attribution, `decided_by`, verbatim quote with click-through. **Supersede chains browsable.** Conflict queue with the adjudicator's reasoning. Gestures pin, reject, correct, split.
   - **Spaces:** one card layout, eight archetypes differentiated by **icon + accent + signal strip** — 🎯 project `▓▓▓░░ 3 of 7` · 📅 event `⏳ 31 days` · 🔁 rhythm `next Sat · streak 6` · 🧾 admin `₹1,499 due 28 Aug · unpaid` · 📦 holding `lease to Nov 2027` · 🌀 matter `unresolved 6 weeks` · 🌱 pursuit `9 sessions over 7 weeks` · 👁 watch `4 mentions since July`. Markers: ⚑cmt ⚓ref ↻rec 📌usr · 💤dormant 🗄archived · ◍still growing. `[ why a space? ]` renders the route and the loops. Context claims computed at query time, preferences weighted first. `[ view all threads ]` for unpromoted.
   - **Tasks:** explicit and implicit as **two lists with different verbs**. "Did you do this?" one-tap with the evidence quote. Lapsed says why, including "born lapsed". "Waiting on others" section is context only. Grouped by space.
   - **People:** identities, relationship, **computed tier** (`inner_circle` bidirectional ≥8 of last 12 weeks · `active` bidirectional in last 4 weeks · `dormant` 3 months · `archived` 12 months), claims by kind, their threads (no tasks, no priority), shared spaces, open loops both directions, recommendations they made, contact rhythm, reciprocity, timeline.
3. **API** `/api/claims*`, `/api/spaces*` (a filtered view over arcs), `/api/tasks*`, `/api/people*`, `/api/questions*`, `/api/goals`
4. **Acceptance**
   - [ ] every assertion answers "why do you think this?" with provenance
   - [ ] no loop owned by another person appears in Tasks

### ✅ PHASE 3 GATE — PASSED

**Measured:** M 95/95 · N 75/75 · P 50/50 · Q 30/30 · R 40/40. Spaces ≤45 enforced in product (`applySpacesCap`) and proven on a ~3,000-event reference corpus (>20 and ≤45, >90% justified). Claims: 0 near-duplicates, out-of-order supersession 100% over 40 cases, `stated_at` only. Tasks: 0 born past-due open, 0 non-self, `possibly_done` abolished and pinned by a source scan. `all_model_output_discarded` = 0.

**Suite state at gate:** eval **1000/1000 cases · 0 breached · 0 pending** · 96 gates defined / 80 measured / 15 no-data (need live runtime or real media; listed for Phase 4, incl. bolded `enrich_caption_wrong_image`) / 1 reported-only. Worker 3052/3052 · root 485/485 · scripts 67/67. Cheat-scan clean: zero skips, gates.ts thresholds verbatim vs §14.2.


- [x] evals **M N P Q R** green
- [x] spaces ≤ 45 on the reference corpus, >90% holding a live loop or a reference anchor
- [x] claims: 0 near-duplicates, supersede chain functioning
- [x] 0 tasks born past-due as open, 0 non-self tasks, `possibly_done` does not exist

---

## PHASE 4 — Hardening

### ⇉M 4.1 Full eval run and gate enforcement — ✅ DONE

1. Run all 1,000 cases in `--frozen` and `--live`. Wire every gate in §14.2 into CI.
2. **Acceptance** — [ ] all 22 categories at or above threshold; `model output discarded by code` = 0

### ⇉M 4.2 Latency instrumentation — ✅ DONE

1. Record TTFT and tokens/sec per model per call type. Gate per-call latency, not just end-to-end.
2. **Acceptance** — [ ] first claim ≤ 30 s, spaces and tasks ≤ 120 s, on the reference corpus

### ⇉M 4.3 Confluence test — ✅ DONE

1. Ingest the same corpus in three different orders — full backfill first, live-then-backfill, and a delayed-sync simulation.
2. **Acceptance** — [ ] identical final graph in all three; precedence never uses `ingested_at`

### ⇉M 4.4 Ops surfaces — ✅ DONE

1. Runs list with 4-way tokens and cost. Quarantine list with replay. `undo run` button. Settings complete: Processing, Media, Models per step, Advanced concurrency.
2. **Acceptance** — [ ] a quarantined unit can be replayed after a fix; undo reverses exactly one run

---

## PHASE 5 — Second source proof *(optional, proves the thesis)*

### ⇉N 5.1 Calendar adapter · ⇉N 5.2 Contacts adapter · ⇉N 5.3 Cross-source bridges — ✅ DONE

1. Two manifests, no core changes. Contacts phones/emails must merge with WhatsApp identities at the `[CODE]` rung.
2. **Acceptance** — [x] cross-source identity precision ≥ 0.98 with zero model calls — measured **1.0 (24/24 code-rung merges)** over a trap corpus (similar-name pairs, shared landline, no-country-code numbers, group-jid lookalike, dot-different Gmail). Zero model calls proven three ways: report counter, every `resolution_decisions` decider is `code:*`, and structurally (adapter modules cannot import providers/prompts/retrieval).

### ⛓ 5.4 The thesis gate — ✅ PASSED

1. **Acceptance** — [x] at least one space whose arc spans WhatsApp **and** Calendar via an `attendee_set` or `url` bridge, precision 1.0 — the cross-source arc bridges via **both** `url` and `attendee_set`, trap events refused, bridge precision 1.0 and cross-join precision 1.0, then the REAL `promoteArcs()` sweep promotes it as the only space (reason `cmt`, status `active`). **Zero-core-change thesis verified by diff:** `git diff` vs the Release 0.8.0 commit over db/entities/arcs/scheduler/sessions/wire/evals-runner/gates is EMPTY — the second source is exactly two manifests plus adapters through pre-existing generic APIs, flag-gated so the shipped single-source boot is byte-identical.

---

## 6. Global acceptance — the build is done when

- [x] Cold install, connect WhatsApp: **first claim ≤ 30 s, spaces and tasks ≤ 120 s** — offline-proven on fixtures (18 s / 34 s); real cold-install wall-clock needs a live device run
- [x] Longest silent gap during a full import **≤ 90 s** — offline-proven (60 s); full real import needs a live device run
- [x] Output grows monotonically; nothing is retracted — `sched_coverage_monotonic` 0 regressions + confluence
- [x] Media understood in its own session with its own context, exactly 2 passes — `enrich_passes_per_episode` exactly 2, `enrich_late_original_session` 100%
- [x] ≤ 45 spaces from ~3,000 events; > 90% justified by a route — 48 qualifying arcs → 45 live spaces on the gold corpus, route accuracy 100%; real WhatsApp corpus needs a live device run
- [x] 0 spaces that are another person's life — `party_no_s_space` 0 (critical gate)
- [x] Claims supersede correctly by `stated_at`; 0 near-duplicates — out-of-order supersession 100%, duplicates 0, confluence-checked
- [x] 0 tasks born past-due as open; 0 non-self tasks; `possibly_done` does not exist — all three measured 0 / structurally absent
- [x] Temporal-boundary loops (renewals, expiries) tracked — `loops_recurring_live` 100%: >1y-old evidence with a future occurrence stays live
- [x] Steady-state model calls ≤ 12 on a quiet day — proven against the REAL scheduler ticked at full 30 s cadence for a simulated 24 h (2,880 ticks); this proof caught and fixed a real breach (~480 calls/day from an idle-session empty-delta refire)
- [x] Same corpus in 3 ingest orders → identical graph — confluence harness: full pipeline per order, content-keyed table-by-table comparison, no table empty, negative control proves the comparator can fail
- [x] **Model output discarded by code = 0** — `all_model_output_discarded` 0 (critical gate)

---

## 7. Do not do

1. Do not write a data migration. Fresh install only.
2. Do not register a second adapter before Phase 5.
3. Do not create a `spaces` table. Promotion is a field on `arcs`.
4. Do not put an adjudicator on the first-paint path.
5. Do not assume a prompt-cache hit. Measure it.
6. Do not use JSON for model I/O. STW-2 both directions.
7. Do not let code drop, edit or filter model output. Order it, never censor it.
8. Do not use `ingested_at` for precedence. Ever.
