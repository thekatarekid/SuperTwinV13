# SuperTwinV11 — Product & Architecture: Claims, Spaces, Tasks
**V1 · scope-limited by design**

**Supersedes for this scope:** `SuperTwinV10_BrainRedesign_V2.md`, `SuperTwinV10_Episodes_Design_V1.md`.
**Substrate:** SuperTwinV11 (v0.5.3) — ingestion, CLI provider, enrichment, retrieval already built.
**Deliberately out of scope:** Deck/Cards, Safe Levels, Runner, CRM surface, Circles, Stage, Commons, watches, life projects, mini-apps.

> **Why the scope is this small.** Every prior iteration (V8 → V9G → V10) died at the same place: the understanding layer. Surfaces built on a wrong ontology are wasted work. If claims, spaces and tasks are not right, nothing above them can be. This document ends where those three objects end.

---

## 1. Thesis

1. **Three objects, one extraction, no routing choice.** Every episode yields **claims** (always) and **loops** (conditionally). The model never picks a container. Forcing that choice is what produced content living in two places at once.
2. **Entities are the spine, not spaces.** Everything keys on minted entity ids. Names and slugs are never keys. This is the only design that survives source #2.
3. **Spaces are derived, never declared.** A space is the promoted state of an episode cluster that holds a live loop. Declared spaces are what produced 87 spaces from 3,028 events.
4. **Tasks are a view over loops, not a separate object.** A task is a loop the user owns with an unresolved end state.
5. **Code computes facts. The model judges meaning. Nothing edits what the model concluded.** Code may narrow vocabulary (closed rosters, enums) and compute arithmetic (dates, staleness, ownership). That is not a gate.
6. **Writes are idempotent upserts with supersede chains.** Nothing is deleted, nothing accumulates blindly.

---

## 2. The three objects — definitions that decide everything

### 2.1 Claim — a descriptive statement about an entity

```
claim = (id, kind, subject_id, predicate, object,
         speaker_id, addressee_id, attribution,
         confidence, valid_from, valid_to, observed_at,
         status, superseded_by, supersede_reason, evidence[])
```

1. **Extracted unconditionally.** All of history is welcome. Claims are context; context is what makes everything above this layer work.
2. **`kind`** ∈ `fact | belief | preference | opinion | interest | recommendation | habit | workflow`.
3. **`subject_id` is an entity id from the roster.** Never a name string. Off-roster is first class: `subject_id: null, subject_hint: "the broker"`. **Unknown beats wrong.**
4. **`speaker_id` is written by CODE** from the event actor. It is never asked of the model.
5. **`attribution`** ∈ `first_person | about_other | reported_speech | quoted_third_party`. This single enum kills three bug classes: misattributed interests, forwarded articles becoming the forwarder's belief, and second-hand claims carrying first-hand confidence.
6. **Stored in resolved third person.** `"All dogs love me"` with `subject: pranjali` is a defect — "me" resolves to the speaker, not the subject.
7. **Bitemporal.** `valid_from`/`valid_to` = when the world was this way. `observed_at` = when we learned it. Mandatory before source #2: a Gmail backfill of 2019 arriving in 2026 is unrepresentable without it.

### 2.2 Loop — an intent with an unresolved end state

```
loop = (id, intent, owner_id, counterparty_id, direction,
        stake, horizon, due_utc, due_tz,
        state, resolution_evidence, entities[], evidence[])
```

1. **A loop requires BOTH:** evidence of *intent* AND an *unresolved end state*. Either alone is a claim.
2. **The test:** evidence of intent → loop. Evidence of state → claim. **Both, always, from the same message.**
3. **`state`** ∈ `open | latent | done | lapsed | dropped`, and it is **derived by code**, not declared by the model (§7.3).
4. **Latent ≠ hypothetical.** Stated intent with nothing due ("must move by end of 2026") is a **latent loop**. Something the agent merely *could* help with is **not a loop at all**.
5. **Four generators of loops — and nothing else:**
   1. Explicit commitment with an open end state.
   2. **A fact with a temporal boundary** — lease ends, passport expires, warranty, renewal. *Currently captured: zero. Largest untapped value in the corpus.*
   3. Recurring obligation (habit + commitment).
   4. User-declared.

### 2.3 Space — a derived cluster that holds a live loop

```
space = (id, space_key, label, archetype, anchor_entities[],
         status, ends_at, cadence, episodes[], loops[],
         user_pinned, user_label, created_at)
```

1. **Not declared by the model.** Derived by code from episode clusters (§8), labelled by the model afterwards.
2. **Promotion rule:** cluster holds ≥1 `open` loop → `active`. Only `latent` → `dormant`. No loop at all → **not a space**; its claims stand alone and its episodes are archived.
3. **`status` is derived, never declared.** A model-declared `dormant` space holding a high-priority task three weeks past due is the failure this removes.
4. **`ends_at` (nullable) replaces `duration` + `permanence`.** Has an end date → it terminates. Horizon becomes arithmetic, not judgment.
5. **`cadence`** ∈ `one_time | recurring` — genuinely orthogonal and kept.
6. **`archetype`** ∈ `project | rhythm | event | admin | watch` — chosen by the model from a **fixed set of 5**. The model never invents an archetype, because archetype selects UI and non-determinism must never reach the interface layer.

### 2.4 Task — a view, not a table

1. **A task is a loop where `owner_id == me` and `state ∈ {open, latent}`.** It is a query, not a stored duplicate.
2. **Loops owned by others are not tasks.** They are context about that person — surfaced on the person, never in the user's list.
3. This removes the entire class of "another person's intention queued for auto-execution."

### 2.5 The containment rule, stated once

```
                     ┌──────────────────────────────┐
   every episode ───►│  ONE understanding call      │
                     └──────┬────────────────┬──────┘
                            │                │
                    always  ▼                ▼  only if intent
                        CLAIMS            LOOPS      + unresolved end
                            │                │
                            │                ├─ owner == me ──► TASK (view)
                            │                └─ owner != me ──► context on person
                            │                │
                            └────────┬───────┘
                                     ▼
                         cluster of episodes + ≥1 live loop
                                     ▼
                                  SPACE (derived)
```

**Never route between claims and loops.** A message produces both, one, or neither.

---

## 3. What changes on V11

### 3.1 Keep — untouched (the reason to build here)

| Subsystem | Path | State |
|---|---|---|
| WhatsApp ingestion | `sources/whatsapp-go/`, `worker/src/adapters/whatsapp/`, `worker/src/db/ingest.ts` | Built, 130 Go tests |
| CLI provider (Claude) | `worker/src/providers/claude-local/` | Built, hardened |
| Enrichment | `worker/src/media/` (vision, whisper, link, frames) | Built, deepest-tested |
| Retrieval | `worker/src/retrieval/` (FTS5 + expansion + semantic + hybrid + citations) | Built |
| Shell / server / UI | `src-tauri/`, `worker/src/server/`, `src/` | Built |

### 3.2 Delete — before writing a line of new code

1. **`worker/src/store/store.ts`** — the spaces/goals/milestones/tasks data layer (1,864 lines, **zero runtime callers**). It encodes V10's declared-space ontology. Deleting it is not cleanup; it is preventing the wrong model from being reachable.
2. **`worker/src/brain/writers.ts`** + `brain-template/` — the markdown wiki writers (zero callers). *Reason: a file tree is a single hierarchy; a life is a graph. Cross-source means one entity legitimately belongs in six places, and files force a parent. Also a second source of truth, which is where V10's DB/`brain/` divergence lives.*
3. **Migrations `0004`–`0006`** — the inert `spaces`/`goals`/`milestones`/`tasks`/`space_events`/`space_people`/`patterns`/`task_runs` tables.
4. **Do NOT port `SuperTwinV10/worker/src/extraction/engine.ts`** (4,327 lines). It is built around a rowid cursor, a markdown brain and a cosine gate — three assumptions this document rejects. Porting it imports the bugs with the code.
5. **Retire `<brain>/corpus/*.md`** as a *product* path. Keep it, if at all, as a keychain-gated debug export only. Plaintext message history on disk contradicts the positioning.

> **Inspectability is not lost.** It moves from files to a UI affordance: **"why do you think this?" → provenance chain → source message.** A file shows the conclusion; the chain shows the reasoning.

### 3.3 Build — new, in dependency order

| # | Layer | Executor | Why it is here |
|---|---|---|---|
| B0 | **Eval harness + gold set** (300–500 labelled episodes) | code + human | Without it, V12 is another theory of the same bug |
| B1 | **Embedder calibration** | code + ML | V11 ships `multilingual-e5-small` — the same anisotropic model whose ~0.75–0.85 noise floor collapsed 50 of 54 comparisons in V10 |
| B2 | **Entity registry + identity resolution** | code → ML → agent | Claims are unkeyable without it |
| B3 | **Episodes** (deterministic segmentation) | code only | The unit of judgment |
| B4 | **Understanding call** (claims + loops) | LLM, 1 call/episode | The core reframe |
| B5 | **Code-facts pass** | code | Arithmetic the model must not be asked for |
| B6 | **Write path** (keys, upsert, supersede) | code + ML | Stops duplication accumulating |
| B7 | **Space derivation** (cluster → promote → label) | code + ML + LLM | Removes declared-space sprawl |
| B8 | **Read APIs + 3 surfaces** | code | Spaces · Person · You |

### 3.4 Fix while rewriting — V11's source leaks

Generic layers currently carry WhatsApp specifics. Fix during this build, not after source #2:

1. `db/ingest.ts:1990` — hardcoded `wa:` id prefix.
2. `resetWhatsappData(sourceId = "whatsapp")` — `db/ingest.ts:1964`.
3. `app_state` keys `whatsapp.paused` / `whatsapp.self_jid` / `whatsapp.import_done`.
4. All routes under `/api/whatsapp/*` → `/api/sources/:source/*`.
5. `worker/src/index.ts:39` constructs `WhatsAppAdapter` directly → replace with an adapter registry.

---

## 4. System architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          YOUR MAC — everything local                          │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ L0  SOURCES + ADAPTERS                          [CODE]  ── V11, KEEP     │ │
│  │     WhatsApp (built) · Calendar + Contacts (next) · Gmail (later)        │ │
│  │     SourceAdapter iface → neutral SourceEvent / Channel / Actor          │ │
│  └────────────────────────────────┬────────────────────────────────────────┘ │
│                                   ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ L1  EVENTS — immutable                          [CODE]  ── V11, KEEP     │ │
│  │     dedupe UNIQUE(source_id, external_id) · FTS5 · enrichment lifecycle  │ │
│  │     media desc · transcript · link scrape         [ML: whisper/VLM/e5]   │ │
│  └────────────────────────────────┬────────────────────────────────────────┘ │
│                                   ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ L2  ENTITY REGISTRY                    [CODE]→[ML]→[AGENT]  ── BUILD B2  │ │
│  │     minted ids · entity_identities (jid|email|phone|handle|cal-attendee) │ │
│  │     merged_into tombstones · types: person org place thing topic         │ │
│  │     OUTPUT: the ROSTER — closed id list injected into every prompt       │ │
│  └────────────────────────────────┬────────────────────────────────────────┘ │
│                                   ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ L3  EPISODES — deterministic, NO model              [CODE]  ── BUILD B3  │ │
│  │     one channel · gap ∪ reply-chain ∪ participant-shift ∪ size cap       │ │
│  │     immutable once sealed · content_hash (skip gate)                     │ │
│  └────────────────────────────────┬────────────────────────────────────────┘ │
│                                   ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ L4  UNDERSTAND — ONE [LLM] call per episode              ── BUILD B4     │ │
│  │                                                                          │ │
│  │    ┌───────────────────────────┐    ┌──────────────────────────────┐    │ │
│  │    │  CLAIMS      unconditional│    │  LOOPS         conditional    │    │ │
│  │    │  8 kinds · subject_id from│    │  intent + unresolved end      │    │ │
│  │    │  roster · attribution enum│    │  owner · counterparty · stake │    │ │
│  │    └─────────────┬─────────────┘    └───────────────┬──────────────┘    │ │
│  └──────────────────┼──────────────────────────────────┼───────────────────┘ │
│                     ▼                                  ▼                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ L5  CODE FACTS — arithmetic, never judgment         [CODE]  ── BUILD B5  │ │
│  │     due < now at creation      → born lapsed, never open                 │ │
│  │     owner≠me AND cpty≠me       → not a task; context on that person      │ │
│  │     speaker≠subject + 1st pers → downgrade to about_other, flag          │ │
│  │     valid_from/observed_at     → stamped from event ts + ingest ts       │ │
│  └────────────────────────────────┬────────────────────────────────────────┘ │
│                                   ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ L6  WRITE PATH — upsert, never insert        [CODE]+[ML]  ── BUILD B6    │ │
│  │     claim_key / loop_key  →  exact hit  → reinforce                      │ │
│  │                              near hit   → supersede (calibrated cosine)  │ │
│  │                              contra     → supersede + model's reason     │ │
│  │     append-only mutations log (actor · old · new · reason · run_id)      │ │
│  └────────────────────────────────┬────────────────────────────────────────┘ │
│                                   ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ L7  DERIVE SPACES                       [CODE]+[ML]+[LLM]  ── BUILD B7   │ │
│  │     cluster episodes (entity overlap + topic vec + time)      [CODE+ML]  │ │
│  │     ≥1 open loop → active · latent only → dormant · none → no space      │ │
│  │     two-phase commit: provisional → batched reconcile         [CODE]     │ │
│  │     label + archetype (1 of 5)                                 [LLM]     │ │
│  └────────────────────────────────┬────────────────────────────────────────┘ │
│                                   ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ L8  GRAPH — SQLCipher, the only truth               [CODE]  ── BUILD     │ │
│  │     entities · claims · loops · episodes · spaces · edges                │ │
│  │     FTS5 · claim embeddings · episode embeddings · mutations             │ │
│  └────────────────────────────────┬────────────────────────────────────────┘ │
│                                   ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │ L9  SURFACES (this scope only)                      [CODE]  ── BUILD B8  │ │
│  │     Spaces · Person · You  —  every assertion → "why do you think this?" │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  MODEL ROUTER: [ML] on-device (e5 embeddings, whisper, VLM)                   │
│                [LLM]/[AGENT] → CLI adapter → user's own Claude subscription   │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Executor legend used throughout:**

| Tag | Means | Cost | Determinism |
|---|---|---|---|
| `[CODE]` | Plain deterministic code | free | exact |
| `[ML]` | Small local model — embeddings, whisper, VLM | ~free | stable |
| `[LLM]` | One bounded call, fixed output schema | metered | judged, replayable via stored verdict |
| `[AGENT]` | Multi-turn, tools, bounded turns/time/scope | metered | judged, session persisted |

---

## 5. Data model

```sql
-- L2 ────────────────────────────────────────────────────────────────
entities          (id PK minted, type, display_name, created_at,
                   merged_into NULL, user_pinned)
                   -- type: person | org | place | thing | topic
entity_identities (entity_id FK, source_id, kind, value,
                   confidence, decided_by, UNIQUE(source_id, kind, value))
                   -- kind: jid | phone | email | handle | cal_attendee | alias

-- L3 ────────────────────────────────────────────────────────────────
episodes          (id PK, channel_id, source_id, started_at, ended_at,
                   event_ids JSON, participant_ids JSON,
                   content_hash, status, sealed_at)
                   -- status: open | sealed | understood

-- L4/L6 ─────────────────────────────────────────────────────────────
claims            (id PK, claim_key, kind, subject_id FK entities,
                   predicate, object,
                   speaker_id, addressee_id, attribution,
                   confidence,
                   valid_from, valid_to, observed_at,
                   status, superseded_by, supersede_reason,
                   created_at, updated_at)
                   -- status: active | superseded

loops             (id PK, loop_key, intent, owner_id, counterparty_id,
                   direction, stake, horizon,
                   due_utc, due_tz, recurrence,
                   state, state_reason, resolution_evidence,
                   observed_at, created_at, updated_at)
                   -- state: open | latent | done | lapsed | dropped

evidence          (subject_kind, subject_id, episode_id, event_id,
                   quote, PRIMARY KEY(subject_kind, subject_id, event_id))
                   -- subject_kind: claim | loop | space | entity

-- L7 ────────────────────────────────────────────────────────────────
spaces            (id PK, space_key, label, label_source,
                   archetype, status, ends_at, cadence,
                   anchor_entities JSON,
                   user_pinned, user_label, created_at, updated_at)
                   -- archetype: project|rhythm|event|admin|watch
                   -- status: active | dormant | archived   (DERIVED)
space_episodes    (space_id, episode_id, PRIMARY KEY(space_id, episode_id))
space_loops       (space_id, loop_id,   PRIMARY KEY(space_id, loop_id))

-- L8 ────────────────────────────────────────────────────────────────
mutations         (id PK, ts, actor, run_id, target_kind, target_id,
                   field, old_json, new_json, reason)
                   -- actor: extract | code | reconcile | user
claim_embeddings  (claim_id PK, vec BLOB, model, dim)
episode_embeddings(episode_id PK, vec BLOB, model, dim)
embedder_calib    (model PK, floor, mean_vec BLOB, measured_at, n_pairs)
```

**Five invariants enforced in schema or code, not in prompts:**

1. `claims.subject_id` is an entity id or `NULL` + `subject_hint`. **Never a name string.**
2. `claims.speaker_id` is written by code from `events.actor_id`. The model cannot supply it.
3. `loops.state` is written by code. The model supplies intent and due date only.
4. `spaces.status` is derived from member loops on every reconcile. Never written by a model.
5. Every `claim` and `loop` has ≥1 `evidence` row. No evidence → no write.

---

## 6. Step-by-step — one message to one surface

```
 STEP  WHAT                                              EXECUTOR
 ════  ══════════════════════════════════════════════    ═══════════════
  1    INGEST                                            [CODE]
       message → event, immutable
       dedupe on (source_id, external_id)
         │
  2    ENRICH                                            [ML]
       image→caption · audio→text · link→scrape
       (V11, already built — unchanged)
         │
  3    RESOLVE IDENTITY                                  [CODE]→[ML]→[AGENT]
       exact identity match          ────────────────►  [CODE]
       no match → embedding candidates ──────────────►  [ML]
       still torn → bounded resolver agent ──────────►  [AGENT]
       ambiguous → ask user (never guess)
       OUTPUT: roster = closed list of entity_ids
         │
  4    SEGMENT INTO EPISODES                             [CODE]  ← no model
       open episode per channel; cut on ANY:
         • silence gap    (tuned per channel type)
         • reply-chain break
         • participant shift
         • size cap (~40 msgs / ~6k tok)
         • local midnight
       seal → content_hash → immutable
         │
  5    SKIP GATE                                         [CODE]
       content_hash already understood? → skip entirely
       (idle days cost ~zero model calls)
         │
  6    UNDERSTAND — ONE call per episode                 [LLM]
       INPUT : episode text + roster + open loops for these entities
       OUTPUT: { claims[], loops[] }   fixed schema
         ├─ claims : ALWAYS. all of history. subject_id ∈ roster.
         └─ loops  : ONLY if intent + unresolved end state
       verdict persisted → replayable without re-judging
         │
  7    APPLY CODE FACTS                                  [CODE]
       due < now at creation        → state = lapsed (never open)
       owner≠me AND cpty≠me         → not a task; person context
       attribution=1st AND subj≠spk → downgrade about_other + flag
       stamp valid_from / observed_at
         │
  8    WRITE                                             [CODE] + [ML]
       compute claim_key / loop_key
         exact hit      → REINFORCE  (union evidence, max confidence)
         near hit (cal.)→ SUPERSEDE  "refined by better evidence"   [ML]
         contradiction  → SUPERSEDE  with model's stated reason
         else           → INSERT
       every write → mutations row
         │
  9    CLUSTER EPISODES                                  [CODE] + [ML]
       score = entity overlap  (Jaccard, code)
             + topic similarity (calibrated cosine, ML)
             + time proximity   (code)
       candidates scoped to channel + anchor entity FIRST,
       cross-channel only above a higher bar
         │
 10    PROMOTE / DEMOTE                                  [CODE]
       cluster has ≥1 open loop     → SPACE active
       cluster has only latent      → SPACE dormant
       cluster has no loop          → NO SPACE
                                      claims stand alone,
                                      episodes archived (retrievable)
         │
 11    TWO-PHASE RECONCILE                               [CODE]
       new spaces are PROVISIONAL — no id, no surface
       batched pass compares provisional ↔ provisional
                          and provisional ↔ committed
       duplicates die at the moment they are comparable
       (a single sequential pass can never provide this)
         │
 12    LABEL + ARCHETYPE                                 [LLM]
       name the cluster in plain words
       pick archetype from FIXED SET OF 5
       (model never invents a UI shape)
         │
 13    SURFACE                                           [CODE]
       Spaces · Person · You
       every assertion → "why do you think this?"
                       → provenance chain → source message
         │
 14    CORRECT — every gesture is a typed mutation       [CODE]
       wrong person · same person · not true ·
       doesn't belong here · this is two things · always keep this
       actor=user → wins permanently → feeds every future prompt
```

---

## 7. The three rules that stop the known failures

### 7.1 Write path — replaces the deleted cosine gate

```
   incoming claim
        │
        ▼
   claim_key = sha1(kind │ subject_id │ normalize(predicate))
        │
        ├── exact match ──────────► REINFORCE
        │                           union evidence · max(confidence)
        │                           (this is also how habits/workflows
        │                            graduate — no MIN_EVIDENCE constant)
        │
        ├── near match ───────────► SUPERSEDE
        │   same subject_id + kind   reason: "refined by better evidence"
        │   AND cosine ≥ calibrated  old row kept, chain queryable
        │       threshold (§7.2)
        │
        ├── contradiction ────────► SUPERSEDE
        │                           reason: model's own words
        │
        └── else ─────────────────► INSERT
```

1. `loop_key = sha1(owner_id │ counterparty_id │ normalize(intent))`.
2. **`loop_key` must NOT contain `space_id`.** Spaces are derived *from* loops — keying a loop on its space is circular and was a latent bug in the V2 proposal. Loops key on entities only.
3. **Zero model output is discarded.** A duplicate becomes evidence, which is strictly more information than two rows.
4. **Every write emits a `mutations` row.** This is what makes "undo last night's run" a real button — and that button is what makes it safe to let the system act boldly.

### 7.2 Embedder calibration — the prerequisite everyone skipped

1. V11 ships `multilingual-e5-small`. Its **unrelated-pair cosine floor is ~0.75–0.85, not ~0**. V10 applied an absolute `0.85` bar against it; **50 of 54 space comparisons resolved `same`**, and 30 of 62 claims were folded across topic boundaries.
2. **Fix:** at startup, measure the floor per model from stored vectors, then normalise `score = (cos − floor) / (1 − floor)`. Persist to `embedder_calib`.
3. **Thresholds are per-kind and per-model.** Claim text, episode topics and entity names sit at different points on the compressed scale. Two module constants cannot serve three jobs.
4. **Never compare short names.** Compare rich text: predicate + subject + representative quote.
5. **A borderline call raises a question. It never resolves by giving up.** In V10, 0 of 129 verdicts were decided by an adjudicator and 31 explicitly recorded "no adjudicator is installed" — so every hard call became a silent duplicate.

### 7.3 Loop state — computed, never declared

```
   at creation:   due_utc < now          →  lapsed
                  no due, intent stated  →  latent
                  else                   →  open

   continuously:  resolution evidence    →  done       [LLM verdict + evidence]
                  due passed, no evidence→  lapsed     [CODE]
                  user gesture           →  dropped    [CODE]
                  N weeks no evidence    →  latent     [CODE]
```

1. **`possibly_done` is not a state.** V10 accumulated 27 tasks in that limbo, none ever confirmed. A done-check either has evidence (→ `done`) or it raises a question. It never parks.
2. **No approval queue.** V10 had 0 of 81 tasks approved with 49 waiting. Approval belongs to *actions* (a future Safe Level), never to *understanding*.

---

## 8. Space derivation — stability is the hard part

```
   episodes ──► cluster ──► promote ──► space
      ▲                                   │
      └──────── re-derived nightly ───────┘
```

1. **Derived spaces must be stable across re-runs**, or ids churn, the UI flickers, and user corrections are lost.
2. **`space_key = sha1(sorted(anchor_entity_ids) │ normalize(topic))`.** Re-derivation rebinds to the same key → same id → history and user edits survive.
3. **User gestures are sticky.** `user_pinned`, `user_label`, and manual episode moves are `actor: user` mutations that **re-derivation must not overwrite**.
4. **Dormant spaces need an aging rule too.** Active sprawl is solved by the loop requirement; dormant sprawl is not. No new evidence for N weeks → `archived` (retrievable, not surfaced).
5. **Cluster candidates are scoped**, not global: channel + anchor entity first; cross-channel promotion requires a higher bar and routes ties to a question. This is what keeps the candidate set at ~5–10 and stops the model minting from the full catalogue.

---

## 9. Surfaces in this scope — three, no more

| Surface | Answers | Contents |
|---|---|---|
| **Spaces** | *what is going on* | archetype view · loops · episodes · claims in context |
| **Person** | *who* | identity + merges · relationship · claims by kind · their loops · open loops with them · shared spaces |
| **You** | *what the twin has learned* | claims about me by kind · confidence · supersede history |

1. **One affordance everywhere: "why do you think this?"** → provenance chain → source message.
2. **Six typed correction gestures**, no free-text diffs: `wrong person` · `same person` · `not true / not anymore` · `doesn't belong here` · `this is two things` · `always keep this`.
3. **Loops owned by others never appear in a task list.** They appear on that person.

---

## 10. Eval harness — build this FIRST (B0)

> Four iterations died by shipping a redesign and *then* discovering the model was wrong. The only thing that breaks the pattern is measuring before building. V11 has **no `evals/` directory** and `npm run eval` was removed.

1. **Gold set: 300–500 labelled episodes** drawn from the real corpus, spanning 1:1 chats, noisy groups, business broadcasts, forwarded content, and multi-topic sessions.
2. **Each episode labelled by hand with the expected output:** claims (kind, subject, attribution), loops (intent, owner, state), and whether it should generate a space at all.
3. **Metrics gated in CI:**

| Metric | Fails the build if |
|---|---|
| claim subject accuracy | < 95% |
| attribution accuracy | < 95% |
| loop precision (not a loop → not extracted) | < 90% |
| loop recall on explicit commitments | < 90% |
| space count vs gold | ±25% |
| duplicate claims after write path | > 2% |
| **model output discarded by code** | **> 0** |

4. **The last row is the one that killed four systems. It must never move off zero.**
5. Fixtures are frozen episodes + frozen model verdicts, so the harness runs offline and deterministically.

---

## 11. Acceptance — what "figured out" means

Measured against the current V10 corpus (3,028 events · 87 spaces · 81 tasks · 381 claims):

| # | Metric | Now | Target |
|---|---|---|---|
| 1 | spaces holding a live loop with user stake | 5 / 23 (22%) | **> 90%** |
| 2 | total spaces from this corpus | 87 | **≤ 45** |
| 3 | other people's lives rendered as spaces | 8 | **0** |
| 4 | claims ever superseded | 0 / 381 | **functioning chain** |
| 5 | near-duplicate claim pairs | 19 | **0** |
| 6 | distinct claim subjects vs people | 23 vs 132 | **1:1 resolved** |
| 7 | tasks born past-due as `open` | 2 | **0** |
| 8 | tasks owned by a non-user | 1 (auto-queued) | **0** |
| 9 | content in two containers | ≥ 1 | **0** |
| 10 | tasks parked in `possibly_done` | 27 | **0 (state removed)** |
| 11 | temporal-boundary loops captured | 0 | **tracked** |
| 12 | model output discarded by code | 0 | **stays 0** |

---

## 12. Build order

```
 B0  EVAL HARNESS + GOLD SET ............................ [code + human]
        └─ nothing below is trustworthy without this
 B1  EMBEDDER CALIBRATION ............................... [code + ML]
        └─ floor measured per model, persisted, per-kind thresholds
 B2  DELETE store.ts · brain/writers.ts · migrations 0004-0006 ... [code]
 B3  ENTITY REGISTRY + ROSTER ........................... [code→ML→agent]
        └─ fix V11's wa:/whatsapp.* source leaks here
 B4  EPISODES .......................................... [code]
 B5  UNDERSTANDING CALL — claims + loops ................ [LLM]
 B6  CODE FACTS ........................................ [code]
 B7  WRITE PATH — keys, upsert, supersede, mutations .... [code + ML]
 B8  SPACE DERIVATION + TWO-PHASE RECONCILE ............. [code + ML + LLM]
 B9  READ APIs + 3 SURFACES + 6 CORRECTION GESTURES ..... [code]
 ──────────────────────────────────────────────────────────────────
 GATE: run B0 against the real corpus. Hit §11 targets.
       Only then design anything above this layer.
```

**B3–B8 are the thesis:** make the unit of judgment coherent, make identity a real id, make attribution structural, stop asking the model to choose a container, and make writes idempotent. Every prior iteration attacked these with prompt wording or a validator. **They are data-model problems.**

---

## 13. The one paragraph to remember

Claims describe. Loops intend. Spaces are what you get when a cluster of conversation holds an intent that has not finished. Tasks are the loops you own. Nothing in that sentence requires a model to choose a container, and nothing in it breaks when the second source arrives — because every object in it points at an entity id, not at a name, a chat, or a file.
