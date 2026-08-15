# SuperTwinV11 — Product & Architecture: Entities & Chunking
**V1 · scope-limited by design · standalone**

> ⚠️ **SUPERSEDED.** Replaced by `SuperTwinV11_ProductandArchitecture_Chunking_V1_Phase1.md` (entities, relations, sessions) and `SuperTwinV11_ProductandArchitecture_Chunking_V1_Phase2.md` (episodes, arcs). Those docs correct this one: full 16-type entity taxonomy, relations/edges defined, enrichment executors fixed (vision = small LLM via CLI, not ML), DB decision explicit (plain SQLite now, no graph DB, encryption deferred), full prompts + agent settings, CLI bare-call contract. Do not build from this file.

**Base:** SuperTwinV11 (v0.5.3). Built in the V11 repo itself.
**Scope:** ingest → enrich → **entities + resolution** → **sessions → episodes → arcs** → **4 inspection surfaces**.
**Explicitly out of scope:** claims, spaces, tasks, loops, agents, cards, digests, sharing.

> **Why the scope stops here.** Everything a personal AI can ever conclude is a function of two things: *who and what is this about* (entities) and *what is one coherent unit of life* (chunks). Both are currently absent. Building conclusions on top of bad chunks and unresolved identities is how three prior iterations failed. This document ends where a correct, inspectable chunk ends.

---

## 1. Thesis

1. **A chunk is the unit of judgment.** Nothing above this layer can be more coherent than the chunk it reads. Get the chunk wrong and every conclusion inherits the error.
2. **Entities are the spine.** Every event, chunk and link points at a **minted entity id**. Never a name, never a phone number, never a handle, never a slug. This is the single decision that makes source #2 through #18 additive instead of multiplicative clutter.
3. **Three tiers, three different jobs.** Sessions are mechanical and deterministic (code). Episodes are topical (one cheap model call). Arcs are cross-time and **cross-source** (code bridges + calibrated similarity). Do not collapse them.
4. **Cross-source is the product.** A single-source twin is a search box. The value appears when a WhatsApp thread, a calendar block, a browser visit and an order confirmation are recognised as one arc. Arcs are where that happens.
5. **Source shape, not source name, drives segmentation.** Eighteen source families reduce to **five stream kinds**. New sources declare a kind; the core never changes.
6. **Every boundary decision is recorded and inspectable.** A chunker you cannot debug is a chunker you cannot trust. The four surfaces exist for this reason, not for end users.

---

## 2. What chunking has to survive

The target source list, and what each actually emits:

| # | Source family | Emits | Volume/day | Actors |
|---|---|---|---|---|
| 1 | WhatsApp · iMessage · SMS | turn-taking messages, media, replies | 10²–10³ | many |
| 2 | Notes · Reminders · Calendar | documents, point reminders, bounded blocks | 10⁰–10¹ | one / many |
| 3 | Google — Drive/Docs/Sheets/Slides/Tasks/Calendar/Gmail | file revisions, threads, bounded blocks | 10¹–10² | many |
| 4 | Slack | turn-taking, threads, channels | 10²–10³ | many |
| 5 | Browser history · bookmarks | visits, saves | 10²–10³ | one |
| 6 | Instagram — DMs, posts, stories, reels, saves | mixed: conversation + activity | 10¹–10² | many / one |
| 7 | X — DMs, posts, bookmarks | mixed | 10¹–10² | many / one |
| 8 | YouTube watch history, saves | plays, saves | 10¹–10² | one |
| 9 | TikTok saves, posts | plays, saves | 10¹–10² | one |
| 10 | **Screen: accessibility tree + screenshots, system audio** | frames, a11y trees, audio | **10⁴–10⁶** | one |
| 11 | Video calls, meeting transcripts | bounded conversation | 10⁰–10¹ | many |
| 12 | **Ambient voice — PC** | audio utterances | **10³–10⁵** | many |
| 13 | **Ambient voice — mobile** | audio utterances | **10³–10⁵** | many |
| 14 | Mobile screenshots | frames | 10²–10³ | one |
| 15 | Scratchpad — notes, screenshots, clipboard, saves | mixed micro-artifacts | 10¹–10² | one |
| 16 | AI voice input · AI clipboard · AI keyboard | intent-rich micro-events | 10¹–10³ | one |
| 17 | Commerce — Amazon, Blinkit, Zomato, Swiggy, Instamart, Zepto, MakeMyTrip, Goibibo, Uber | transactions, line items | 10⁰–10¹ | one |
| 18 | Entertainment — Netflix, Hotstar, Spotify, BookMyShow | plays, bookings | 10¹–10² | one |

**Three facts this table forces:**

1. **A gap-based rule alone is wrong.** It fits families 1, 4, 6, 7 and nothing else. A Google Doc, a Netflix play and an Uber ride have no silence gap.
2. **Volume spans six orders of magnitude.** Families 10, 12 and 13 will produce more events per day than everything else combined for a year. They need a salience gate *before* segmentation or they destroy the system.
3. **Actor cardinality differs.** Browser history has one actor (you). WhatsApp has many. Participant-shift boundaries are meaningless for single-actor streams.

---

## 3. The extensibility spine — five stream kinds

Every source declares exactly one **stream kind**. The kind selects a segmentation policy. **This is the only thing the core needs to know about a source.**

```
 STREAM KIND    SHAPE                        SESSION BOUNDARY RULE
 ═══════════    ══════════════════════       ══════════════════════════════════
 CONVERSATION   turn-taking, many actors,    silence gap ∪ participant shift ∪
                one channel                  reply-chain break ∪ size cap ∪
                                             local midnight
                fam 1,4,6dm,7dm,11

 DOCUMENT       revisions to one artifact    edit burst: gap between revisions
                fam 2notes,3docs,15notes     ∪ author shift ∪ size cap
                                             session = "a working sitting"

 ACTIVITY       atomic acts by one actor,    activity burst: gap ∪ context shift
                logged                       (domain/app/vertical change) ∪ cap
                fam 5,6feed,7feed,8,9,       a single transaction is always its
                14,15,16,17,18               own session, never merged

 AMBIENT        unbounded sensor stream      salience prefilter FIRST, then:
                fam 10,12,13                 context shift (app / speaker /
                                             scene / silence) ∪ hard cap
                                             ∪ 15-min ceiling

 BOUNDED        the record already has       session = the record. No inference.
                start and end                A meeting, a calendar block, a ride,
                fam 2cal,3cal,11,17trip      an order: the boundary is given.
```

### 3.1 The adapter manifest — the whole extension contract

Adding a source means writing an adapter and a manifest. **No core file changes.**

```ts
SourceManifest = {
  source_id:        "whatsapp" | "gmail" | "screen" | ...,
  display_name:     string,
  stream_kind:      "conversation"|"document"|"activity"|"ambient"|"bounded",
  actor_model:      "multi_actor" | "single_actor",

  streams:          { key: (ev) => string, label: (ev) => string },
      // how raw events group into streams:
      //   conversation → chat/channel   document → file id
      //   activity     → vertical/app   ambient  → device+sensor
      //   bounded      → the record id

  identities_emitted: ("jid"|"phone"|"email"|"handle"|"account_id"
                      |"device_id"|"profile_url")[],

  capabilities:     { backfill, live, media, revisions, deletion, edits },

  segmentation:     { gap_ms, size_cap_events, size_cap_chars,
                      day_boundary: bool, participant_shift: bool },

  salience:         { prefilter: "none"|"dedupe"|"vad"|"diff"|"threshold" },

  bridge_keys:      ("url"|"order_id"|"file_id"|"attendee_set"
                     |"phone"|"email"|"media_work_id"|"geo")[],
}
```

1. **`segmentation` is data, not code.** Tuning WhatsApp's gap to 6h and Slack's to 2h is a config change, and it is per-stream-tunable at runtime.
2. **`bridge_keys` declares what this source can join on.** This is what makes cross-source arcs deterministic instead of guessed (§7.2).
3. **`salience.prefilter` is mandatory for `ambient`.** An ambient manifest with `prefilter: "none"` fails validation.

---

## 4. What changes on V11

### 4.1 Keep — untouched

| Subsystem | Path | State |
|---|---|---|
| WhatsApp daemon | `sources/whatsapp-go/` (whatsmeow, NDJSON over stdio) | Built, 130 Go tests |
| WhatsApp adapter + ingest | `worker/src/adapters/whatsapp/`, `worker/src/ingest/`, `worker/src/db/ingest.ts` | Built |
| Adapter interface | `worker/src/adapters/source-adapter.ts`, `adapters/types.ts` | Built, already source-neutral |
| CLI provider (Claude) | `worker/src/providers/claude-local/` | Built, hardened |
| Enrichment | `worker/src/media/` — vision captions, whisper, frames, link scrape, yt captions | Built, deepest-tested |
| Embeddings | `worker/src/retrieval/embedder.ts`, `db/embeddings.ts` (e5-small, 384d, int8) | Built, ships off |
| Retrieval | `worker/src/retrieval/` — FTS5, expansion, semantic, hybrid, citations | Built |
| Shell / server / UI | `src-tauri/`, `worker/src/server/`, `src/` | Built |

### 4.2 Delete — before writing new code

1. **`worker/src/store/store.ts`** — 1,864-line spaces/goals/milestones/tasks data layer with **zero runtime callers**. It encodes an ontology this build does not use. Delete it so the wrong model is not reachable.
2. **`worker/src/brain/writers.ts` and `brain-template/`** — markdown wiki writers, zero callers. *A file tree is a single hierarchy; a life is a graph. Cross-source means one entity legitimately belongs in six places, and files force a parent.*
3. **Migrations `0004`–`0006`** — inert `spaces`/`goals`/`milestones`/`tasks`/`space_events`/`space_people`/`patterns`/`task_runs` tables.
4. **`<brain>/corpus/*.md` as a product path.** Retrieval currently materialises full message history to plaintext on disk. Keep only as a keychain-gated debug export.
5. **Do not port any prior extraction engine.** Prior versions batch on a global rowid cursor with a markdown brain and an uncalibrated cosine gate. All three assumptions are rejected here.

### 4.3 Fix — source leaks in generic layers

V11's abstraction is clean at the interface and WhatsApp-wired underneath. Fix now, not after source #2:

1. `worker/src/db/ingest.ts:1990` — hardcoded `wa:` id prefix → `${source_id}:`.
2. `worker/src/db/ingest.ts:1964` — `resetWhatsappData(sourceId = "whatsapp")` → `resetSourceData(source_id)`.
3. `app_state` keys `whatsapp.paused` / `whatsapp.self_jid` / `whatsapp.import_done` → `source.<id>.*`.
4. All `/api/whatsapp/*` routes → `/api/sources/:source_id/*`.
5. `worker/src/index.ts:39` constructs `WhatsAppAdapter` directly → **adapter registry** driven by manifests.
6. `events.channel_id` → generalise to `stream_id` (channels become one flavour of stream).

### 4.4 Build — new

| # | Component | Executor |
|---|---|---|
| B0 | Eval harness + gold set | code + human |
| B1 | Embedder calibration | code + ML |
| B2 | Adapter registry + manifests + generalised event model | code |
| B3 | Salience prefilter (ambient) | code + ML |
| B4 | Entity registry + identity resolution + mention linking | code → ML → agent |
| B5 | **Sessions** — 5 stream-kind segmenters | code only |
| B6 | **Episodes** — topical split/merge | LLM |
| B7 | **Arcs** — bridges + calibrated similarity | code + ML + LLM |
| B8 | 4 inspection surfaces + correction gestures | code |

---

## 5. System architecture

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                         YOUR MAC — everything local                            │
│                                                                                │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L0  ADAPTER REGISTRY                                    [CODE]  ── B2       ││
│ │     manifest-driven. one adapter per source. core never changes.           ││
│ │     whatsapp(built) · imessage · gmail · calendar · slack · browser ·      ││
│ │     screen · voice · commerce · entertainment · scratchpad · …             ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L1  EVENTS — immutable, source-neutral                  [CODE]  ── V11+B2  ││
│ │     UNIQUE(source_id, external_id) · stream_id · actor_ref · ts/ts_end     ││
│ │     kind · text · structured_json · media · links · revision_of            ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L1b SALIENCE PREFILTER — ambient only                [CODE]+[ML]  ── B3    ││
│ │     frames: perceptual-hash dedupe · a11y-tree diff · app-switch keep      ││
│ │     audio : VAD → speech only · silence dropped, never stored              ││
│ │     drops 90-99% of ambient volume BEFORE it can reach a model             ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L1c ENRICH                                              [ML]  ── V11 KEEP  ││
│ │     image→caption (VLM) · audio→text (whisper) · video→frames             ││
│ │     link→scrape · yt→captions · text→embedding (e5-small)                 ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L2  ENTITY REGISTRY                    [CODE]→[ML]→[AGENT]  ── B4          ││
│ │     entities: person org place product media_work document topic app      ││
│ │     entity_identities: jid|phone|email|handle|account|device|profile_url   ││
│ │     structural binding [CODE] · textual mention linking [ML]+[LLM]         ││
│ │     merged_into tombstones · user merges win permanently                   ││
│ │     OUTPUT: the ROSTER — closed id list injected into every prompt         ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L3  SESSIONS — mechanical, deterministic, NO MODEL      [CODE]  ── B5      ││
│ │     one stream · policy by stream_kind (§3)                                ││
│ │     immutable once sealed · content_hash · boundary_reason recorded        ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L4  EPISODES — topical                              [LLM]  ── B6           ││
│ │     default: session = episode (1:1, no call)                              ││
│ │     one session → N topics : split      [LLM, same read]                   ││
│ │     N sessions → one topic : attach     [gate, stream-scoped]              ││
│ │     arc_state open|closed · verdict persisted → replay never re-judges     ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L5  ARCS — cross-time, CROSS-SOURCE            [CODE]+[ML]+[LLM]  ── B7    ││
│ │     ① BRIDGES  deterministic joins            [CODE]  high precision      ││
│ │        shared url · order_id · file_id · attendee_set · phone/email ·     ││
│ │        media_work_id · geo+time                                            ││
│ │     ② ENTITY OVERLAP  Jaccard on entity sets  [CODE]                      ││
│ │     ③ TOPIC SIMILARITY  calibrated cosine     [ML]                        ││
│ │     ④ ADJUDICATION  ties + cross-source       [LLM] → else ask user       ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L6  STORE — SQLCipher, the only truth                   [CODE]             ││
│ │     entities · identities · events · sessions · episodes · arcs ·         ││
│ │     bridges · mentions · mutations(append-only) · FTS5 · embeddings       ││
│ └──────────────────────────────────┬─────────────────────────────────────────┘│
│                                    ▼                                           │
│ ┌────────────────────────────────────────────────────────────────────────────┐│
│ │ L7  FOUR INSPECTION SURFACES                            [CODE]  ── B8      ││
│ │     ENTITIES · SESSIONS · EPISODES · ARCS                                  ││
│ │     every boundary → "why was this cut / merged here?"                     ││
│ └────────────────────────────────────────────────────────────────────────────┘│
│                                                                                │
│  ROUTER: [ML] on-device (e5, whisper, VLM, phash, VAD)                        │
│          [LLM]/[AGENT] → CLI adapter → user's own Claude subscription         │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Executor legend, used everywhere in this document:**

| Tag | Means | Cost | Determinism |
|---|---|---|---|
| `[CODE]` | Deterministic code | free | exact, replayable |
| `[ML]` | Small on-device model — embeddings, whisper, VLM, phash, VAD | ~free | stable |
| `[LLM]` | One bounded call, fixed output schema | metered | judged; verdict persisted → replayable |
| `[AGENT]` | Multi-turn with tools, bounded turns/time/scope | metered | judged; session persisted |

---

## 6. Data model

```sql
-- L0/L2 ─────────────────────────────────────────────────────────────────
sources           (id PK, display_name, stream_kind, actor_model,
                   manifest_json, enabled, created_at)

entities          (id PK minted, type, display_name, canonical,
                   merged_into NULL, user_pinned, created_at)
                   -- type: person|org|place|product|media_work|document|topic|app

entity_identities (id PK, entity_id FK, source_id, kind, value,
                   confidence, decided_by, decided_at,
                   UNIQUE(source_id, kind, value))
                   -- kind: jid|phone|email|handle|account_id|device_id|profile_url|alias
                   -- decided_by: code|ml|agent|user

-- L1 ────────────────────────────────────────────────────────────────────
streams           (id PK, source_id FK, external_key, label,
                   stream_kind, participant_entity_ids JSON,
                   segmentation_override_json NULL)

events            (id PK, source_id, stream_id FK, external_id,
                   actor_entity_id NULL, actor_raw,
                   ts, ts_end NULL, tz,
                   kind, text, structured_json,
                   media_ref, link_ref, reply_to_external_id,
                   revision_of NULL, is_self, is_business, is_historical,
                   salience REAL, observed_at,
                   UNIQUE(source_id, external_id))
                   -- kind: message|post|comment|reaction|edit|view|play|save
                   --     | order|visit|frame|utterance|appointment|file_change

-- L2b ───────────────────────────────────────────────────────────────────
mentions          (id PK, event_id FK, span_start, span_end, surface_text,
                   entity_id NULL, entity_hint NULL,
                   confidence, decided_by)
                   -- textual mentions; NULL entity_id + hint = honest unknown

-- L3 ────────────────────────────────────────────────────────────────────
sessions          (id PK, stream_id FK, source_id,
                   started_at, ended_at, event_ids JSON,
                   participant_entity_ids JSON,
                   boundary_reason, boundary_params_json,
                   content_hash, status, sealed_at)
                   -- boundary_reason: gap|participant_shift|reply_break|size_cap
                   --                | day_boundary|context_shift|record_bounded
                   --                | ceiling_24h
                   -- status: open|sealed|segmented

-- L4 ────────────────────────────────────────────────────────────────────
episodes          (id PK, stream_id, source_id, topic_label, label_source,
                   session_ids JSON, event_ids JSON,
                   entity_ids JSON, topic_vec BLOB,
                   arc_state, outcome, decision_verdict_json,
                   started_at, ended_at, created_at)
                   -- arc_state: open|closed     outcome: concluded|faded|NULL

-- L5 ────────────────────────────────────────────────────────────────────
arcs              (id PK, arc_key, label, label_source,
                   anchor_entity_ids JSON, source_ids JSON,
                   episode_ids JSON, started_at, last_evidence_at,
                   state, user_pinned, user_label, created_at)
                   -- state: live|dormant|archived   (DERIVED, never declared)

bridges           (id PK, kind, value_norm,
                   left_kind, left_id, right_kind, right_id,
                   confidence, decided_by, created_at)
                   -- kind: url|order_id|file_id|attendee_set|phone|email
                   --     | media_work_id|geo_time
                   -- deterministic cross-source joins; the cheapest high-precision link

-- L6 ────────────────────────────────────────────────────────────────────
mutations         (id PK, ts, actor, run_id, target_kind, target_id,
                   field, old_json, new_json, reason)
                   -- actor: ingest|code|ml|llm|agent|user
episode_embeddings(episode_id PK, vec BLOB, model, dim)
entity_embeddings (entity_id  PK, vec BLOB, model, dim)
embedder_calib    (model PK, floor REAL, mean_vec BLOB, measured_at, n_pairs)
```

**Invariants enforced in schema or code, never in a prompt:**

1. `events.actor_entity_id` is an entity id or `NULL` + `actor_raw`. **A name string is never an id.**
2. `sessions` are **immutable once sealed**. A resumption is a new session, never an edit.
3. Every `session` records `boundary_reason` + the exact params used. A boundary you cannot explain is a bug.
4. Every `episode` persists its `decision_verdict_json`. **Replay reuses the stored verdict and never re-judges** — otherwise bugs are irreproducible.
5. `arcs.state` is derived on every reconcile. No model writes it.
6. Every write emits a `mutations` row. This is what makes "undo last night's run" a real button.

---

## 7. Layer specifications

### 7.1 L2 — Entities and resolution

**Two binding paths, deliberately separated:**

```
 ① STRUCTURAL BINDING                         [CODE]  ── high confidence
    metadata carries an identity:
      whatsapp sender jid · gmail From: · calendar attendee email ·
      slack user id · order account · device id
    exact match on entity_identities → bind
    no match → mint provisional entity + identity, flag for resolution

 ② TEXTUAL MENTION LINKING              [ML] → [LLM]  ── lower confidence
    a name appearing inside text: "ask Rahul about the villa"
    candidate generation      [ML]  embedding + alias + string distance
    disambiguation            [LLM] roster-constrained, top-K only
    still ambiguous           →  entity_id NULL + entity_hint "Rahul(?)"
                                 and a question. UNKNOWN BEATS WRONG.
```

**Resolution ladder — escalate, never guess:**

```
   new identity observed
        │
        ├─ exact match on (source_id, kind, value) ──────────► BIND        [CODE]
        │
        ├─ same value, different source                  ────► BIND        [CODE]
        │  (phone in WhatsApp == phone in Contacts)
        │
        ├─ candidate set from embeddings + aliases      ────► score        [ML]
        │     score ≥ high bar  ────────────────────────────► BIND
        │     score in band     ────────────────────────────► ADJUDICATE   [AGENT]
        │                        bounded: 3 turns, read-only,
        │                        tools = search_entities, read_entity
        │
        └─ still torn ──────────────────────────────────────► ASK USER
                                                              (never silent guess)
```

1. **Entity ids are minted**, never derived from a name, jid, phone or email. Deriving ids from source values is what makes cross-source identity impossible later.
2. **Merges are tombstones.** `merged_into` makes a merge O(1) and reversible; nothing is deleted.
3. **User decisions are permanent.** An `actor: user` merge or split outranks every future automated verdict for that pair.
4. **The roster is a closed list.** Any prompt that must name a person receives entity ids and their display names, and may only return ids from that list — or `null` plus a hint.
5. **Non-person entities matter early.** `media_work` (a film, a song), `product` (a broadband plan), `place` (a restaurant) and `document` (a Doc) are what let arcs bridge YouTube ↔ WhatsApp ↔ Netflix ↔ Swiggy.

### 7.2 L3 — Sessions (mechanical, code only, no model)

**Per stream-kind policy. Cut when ANY trigger fires.**

```
 CONVERSATION   gap > G(stream)          G default 6h; tune per stream
                participant shift         (multi_actor only)
                reply-chain break         a reply to a much older msg starts new
                size cap                  ~40 events / ~6k tokens
                local midnight            keeps "today/tomorrow" reasoning clean

 DOCUMENT       revision gap > G          G default 45m
                author shift
                size cap on diff volume
                session = one working sitting on one artifact

 ACTIVITY       gap > G                   G default 30m
                context shift             domain / app / vertical change
                size cap
                ⚠ a transaction is ALWAYS its own session — never merged
                  into a browsing burst

 AMBIENT        (after salience prefilter)
                context shift             foreground app change · speaker change
                                          · scene change · silence > 90s
                hard cap                  ~10 min wall-clock
                ceiling                   15 min absolute

 BOUNDED        session = the record. start/end are given. no inference.
                a 90-min meeting is ONE session regardless of size cap.
```

**Live streams — the open-session mechanism:**

```
 event arrives in stream S
        │
        ├─ S has no open session ──► open one
        └─ else ──────────────────► append
        │
        ▼  reset debounce timer for S  (30–60 min silence, per manifest)
        │
   debounce fires  OR  day boundary  OR  24h ceiling
        │
        ▼
   SESSION SEALED — immutable, content_hash computed
        │
        ▼
   HASH GATE: already segmented with this hash? → skip entirely
```

1. **Event-driven and debounced per stream, never a global clock.** A global "process the last hour" wastes calls on hours holding three messages across eight streams, and splits a 12:55–13:10 exchange in half.
2. **Sessions are immutable once sealed.** A topic resuming two hours later becomes a *new* session that may *attach* to an open episode (§7.3). Immutability is what makes replay and caching correct.
3. **Backfill and live use the same segmenter.** Backfill has known ends; live has one open trailing session per stream. No second code path.
4. **`boundary_reason` and the exact params are recorded on every session** so the Sessions surface can answer "why here?".
5. **Ordering is by `ts`, not by insertion order.** Backfilled history arrives later but belongs earlier. Durability is a per-stream `(ts, external_id)` watermark, not a global rowid.

### 7.3 L4 — Episodes (topical, one cheap model call)

```
 DEFAULT: session = episode, 1:1, ZERO extra model calls.
          Most sessions are about one thing.

 CASE A — one session, two topics          [LLM, same read]
          chat pivots "dinner plans" → "your surgery"
          the segmenter already reads the whole session, so it returns
          1–N topic segments from that single call
          optional cheap pre-flag: intra-session embedding shift   [ML]

 CASE B — two sessions, one topic          [CODE]+[ML] gate
          Monday's Odyssey chat + Wednesday's Odyssey chat
          new session's topic vec ≥ calibrated threshold against an
          OPEN episode IN THE SAME STREAM  →  ATTACH, do not create
```

1. **Topic matching is scoped to one stream.** A session in the Pranjali chat is never compared against episodes in the Hrishikesh chat. Candidate sets stay at ~5–10, cost stays low, and the model chooses from a tiny real list instead of minting from the full catalogue.
2. **Episodes stay open and accrete sessions** until an explicit conclusion or an aging timeout (default 14 days quiet → `outcome = faded`).
3. **The verdict is persisted.** Replay reuses `decision_verdict_json` rather than re-judging, so boundaries are reproducible and bugs are debuggable.
4. **Batch for cost, never for semantics.** Collect sealed sessions and process on a short cadence, but keep **each session as its own item in the prompt** so meaning never blends across streams.
5. **Cross-stream topic matching does not happen here.** That is an arc (§7.4).

### 7.4 L5 — Arcs (cross-time, cross-source — the product)

An arc is a **cross-session, cross-source topic thread**. This is the only layer that crosses sources, and it is where the twin stops being a search box.

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │  ARC: "Goa trip, Sep"                                                │
 ├──────────────────────────────────────────────────────────────────────┤
 │  WhatsApp   ep: villa shortlist        ─┐                            │
 │  WhatsApp   ep: who pays deposit       ─┤                            │
 │  Browser    ep: booking.com session    ─┤  bound by:                 │
 │  Gmail      ep: booking confirmation   ─┼─ ① url bridge              │
 │  Calendar   ep: 12–15 Sep block        ─┤  ② attendee_set bridge     │
 │  Commerce   ep: MakeMyTrip flights     ─┤  ③ entity overlap          │
 │  Photos     ep: villa screenshots      ─┘  ④ topic similarity        │
 └──────────────────────────────────────────────────────────────────────┘
```

**Four binding signals, in strict precedence order:**

```
 ① BRIDGES — deterministic joins                    [CODE]   precision ~1.0
    same normalised url                (browser visit ↔ WhatsApp link ↔ bookmark)
    same order_id / booking ref        (Gmail receipt ↔ commerce ↔ calendar)
    same file_id                       (Drive doc ↔ Slack share ↔ browser visit)
    same attendee_set                  (calendar ↔ meeting transcript ↔ chat group)
    same phone / email                 (contact ↔ any source)
    same media_work_id                 (YouTube ↔ Netflix ↔ chat recommendation)
    geo + time coincidence             (Uber drop ↔ restaurant order ↔ photo)
    ── run these FIRST. They are free, exact, and cross-source by nature.

 ② ENTITY OVERLAP — Jaccard on entity sets          [CODE]   cheap, strong
    same people + same place + same product = strong prior

 ③ TOPIC SIMILARITY — calibrated cosine             [ML]     fuzzy, last resort
    only above a HIGHER bar than the intra-stream episode gate

 ④ ADJUDICATION                                     [LLM]
    cross-source ties and borderline scores get one bounded call
    still ambiguous → ASK USER. Never resolve by giving up.
```

1. **Bridges are the cheapest high-precision cross-source mechanism, and they run first.** A URL shared in WhatsApp and visited in the browser is the *same thing* with certainty. Do not spend a cosine on what a string join answers exactly.
2. **Cross-source similarity requires a higher bar than same-stream similarity.** Different sources have different registers — a calendar title, a chat message and an order line describe the same trip in three vocabularies, so raw cosine is unreliable across them. Bridges and entity overlap carry the weight; similarity only breaks ties.
3. **`arc_key = sha1(sorted(anchor_entity_ids) │ normalize(topic))`.** Arcs are re-derived on a nightly reconcile; a stable key means re-derivation rebinds to the **same id**, so history, labels and user corrections survive.
4. **Two-phase commit.** New arcs are *provisional* — no id, no surface — until a batched reconcile compares them against each other **and** against committed arcs. Duplicates die at the moment they are comparable, which a single sequential pass can never provide.
5. **`state` is derived:** new evidence recently → `live`; quiet N weeks → `dormant`; quiet longer → `archived` (retrievable, never surfaced). Arcs must age or they accumulate monotonically.
6. **User gestures are sticky.** `user_pinned`, `user_label`, and manual episode moves are `actor: user` mutations that re-derivation **must not overwrite**.

### 7.5 Embedder calibration — a prerequisite, not an optimisation

1. V11 ships `multilingual-e5-small`. Its **unrelated-pair cosine floor is ~0.75–0.85, not ~0.** An absolute threshold like `0.85` sits inside the model's noise band; in a prior run against this exact embedder, **50 of 54 topic comparisons collapsed to "same"**.
2. **Fix:** at startup, measure the floor per model from stored vectors, then normalise `score = (cos − floor) / (1 − floor)`. Persist to `embedder_calib`.
3. **Thresholds are per-kind and per-model.** Entity names, episode topics and cross-source arcs sit at different points on the compressed scale. One module constant cannot serve three jobs.
4. **Never compare short strings.** Compare rich text: topic label + representative quotes + participant names.
5. **A borderline score raises a question. It never resolves by giving up.** An installed adjudicator is mandatory; without one, every hard call silently becomes a duplicate or a bad merge.

---

## 8. Volume control — the ambient problem

Families 10, 12 and 13 will out-produce everything else combined. Without a gate, they make the system unusable and unaffordable.

```
 RAW AMBIENT                                                    10⁴–10⁶ /day
      │
      ▼  ① CAPTURE-TIME THRESHOLD                    [CODE]
      │    screen: sample on a11y-tree change or app switch, not on a timer
      │    audio : VAD gates the recorder — silence is never written to disk
      │
      ▼  ② PERCEPTUAL DEDUPE                         [ML]     −90%
      │    phash near-identical frames collapse to one + a duration
      │    identical a11y subtrees collapse to one + a duration
      │
      ▼  ③ SALIENCE SCORE                            [CODE]+[ML]
      │    text density · app category · user input present · known entity
      │    present · novelty vs last N minutes
      │    score written to events.salience
      │
      ▼  ④ SEGMENT ONLY ABOVE THRESHOLD              [CODE]
      │    low-salience runs become ONE low-detail session ("browsing, 40m")
      │    never N sessions
      │
      ▼  ⑤ ENRICH ONLY WHAT SURVIVES                 [ML]
           VLM/whisper run on salient events only              10¹–10² /day
```

1. **Discard at capture, not after storage.** Raw audio is never persisted after it becomes text; silence never reaches disk.
2. **A low-salience run is one coarse session, not many.** This is the single rule that stops ambient sources from flooding the Sessions and Episodes surfaces.
3. **Ambient never bridges on similarity alone.** An ambient episode joins an arc only via a bridge (§7.4 ①) or explicit entity overlap. Otherwise the noisiest source would dominate every arc.
4. **Ambient is off by default**, with a visible recording indicator, per-source kill switch, and a "forget this hour / this app / this person" gesture that really deletes.

---

## 9. The four surfaces

These exist to make the chunker debuggable. Every screen answers **"why?"**.

### 9.1 Entities

```
┌──────────────────────────────────────────────────────────────────────┐
│ ENTITIES   [ person 132 ][ org 14 ][ place 9 ][ product 6 ][ …    ]  │
│ 🔍 search                                       ⚠ 12 need resolution │
├──────────────────────────────────────────────────────────────────────┤
│  Pranjali Sachdeva                          person · 4 identities    │
│   whatsapp:jid 9177…03  ✓code    phone +9177…03      ✓code           │
│   gmail:email pranjali@…  ✓user   slack:handle @pran  ⚠ml 0.71       │
│   ── 41 sessions · 12 episodes · 3 arcs · first seen 12 Mar 2026 ──   │
│   [ merge ][ split ][ rename ][ pin ]                                │
├──────────────────────────────────────────────────────────────────────┤
│ ⚠ NEEDS RESOLUTION                                                   │
│   "Papa (new number Jio)"  ←→  "Papa"        likely same   0.83      │
│   [ same person ][ different ][ ask me later ]                       │
└──────────────────────────────────────────────────────────────────────┘
```

1. Browse and search by type. Filter to unresolved.
2. Show every identity with **who decided it** (`code | ml | agent | user`) and confidence.
3. Merge / split / rename / pin — each writes a `mutations` row and wins permanently.
4. The resolution queue is the primary work surface: pairs the ladder could not settle.

### 9.2 Sessions

```
┌──────────────────────────────────────────────────────────────────────┐
│ SESSIONS   source [ all ▾ ]  stream [ all ▾ ]      14 Aug · 38 sealed│
├──────────────────────────────────────────────────────────────────────┤
│ ▸ WhatsApp · Pranjali            09:12–09:41   14 events   conversation│
│    cut BEFORE: gap 7h 20m > 6h                                        │
│    cut AFTER : participant shift                                      │
│    participants: Aditya, Pranjali          hash 3f9a…  [ replay ]     │
├──────────────────────────────────────────────────────────────────────┤
│ ▸ Browser · shopping              11:02–11:26   31 events   activity  │
│    cut AFTER : context shift  amazon.in → youtube.com                 │
├──────────────────────────────────────────────────────────────────────┤
│ ▸ Calendar · Standup              10:00–10:15    1 event    bounded   │
│    boundary: record_bounded (no inference)                            │
├──────────────────────────────────────────────────────────────────────┤
│ ▸ Screen · low-salience run       11:30–12:10  1,204 → 6   ambient    │
│    prefilter dropped 99.5% · coarse session                           │
└──────────────────────────────────────────────────────────────────────┘
```

1. Every session shows **both** boundaries with the exact rule and measured value that fired.
2. Show the raw events inside, and the prefilter drop ratio for ambient.
3. `[ replay ]` re-runs the segmenter on that stream with current params and **diffs** the result. This is how gap tuning is done.
4. Per-stream segmentation override lives here (a noisy family group needs a different gap than a 1:1).

### 9.3 Episodes

```
┌──────────────────────────────────────────────────────────────────────┐
│ EPISODES   [ open 22 ][ closed 140 ][ faded 31 ]                      │
├──────────────────────────────────────────────────────────────────────┤
│ ▸ "Villa shortlist for Goa"            open · WhatsApp · 3 sessions   │
│    ├ session 09:12 Mon   ← seed                                       │
│    ├ session 20:40 Wed   ← ATTACHED   score 0.91 vs open episode      │
│    └ session 08:15 Fri   ← ATTACHED   score 0.88                      │
│    entities: Pranjali, Rohan, Villa Amara, Goa                        │
│    [ why attached? ] [ detach ] [ split ] [ relabel ]                 │
├──────────────────────────────────────────────────────────────────────┤
│ ▸ "Dr. Rao appointment"          closed · WhatsApp · 1 session        │
│    SPLIT from session 14:02 — session held 2 topics                   │
│    sibling: "dinner plans"        [ why split? ]                      │
└──────────────────────────────────────────────────────────────────────┘
```

1. Show split and attach decisions explicitly, with the score and the persisted verdict.
2. `[ why attached? ]` renders the stored `decision_verdict_json` — the candidates considered and the reason.
3. Detach / split / relabel are user mutations that survive re-derivation.

### 9.4 Arcs

```
┌──────────────────────────────────────────────────────────────────────┐
│ ARCS   [ live 18 ][ dormant 24 ][ archived 61 ]                       │
├──────────────────────────────────────────────────────────────────────┤
│ ▸ Goa trip, Sep                        live · 5 sources · 12 episodes │
│                                                                       │
│   Jun ──●──────●───────────●────●──────●───── Sep                    │
│         wa     browser     gmail cal    mmt                           │
│                                                                       │
│   BOUND BY                                                            │
│    ① url bridge      booking.com/villa-amara   browser ↔ wa  exact   │
│    ② attendee_set    Aditya,Rohan,Ana,Kabir    cal ↔ wa      exact   │
│    ③ entity overlap  0.71                                             │
│    ④ topic sim       0.86 (calibrated)                                │
│                                                                       │
│   anchors: Rohan · Ana · Villa Amara · Goa                            │
│   [ why these together? ] [ remove episode ] [ split arc ] [ pin ]    │
└──────────────────────────────────────────────────────────────────────┘
```

1. **A source-contribution timeline is the core visual** — it is the only screen that makes cross-source value visible.
2. Show which binding signal fired, in precedence order, with values.
3. `[ split arc ]` and `[ remove episode ]` are the corrections that matter most; both are sticky.

### 9.5 Correction gestures — shared across all four

| Gesture | Target | Effect |
|---|---|---|
| same / different entity | entity pair | merge tombstone or permanent negative |
| rename · pin | entity, episode, arc | user label outranks model label |
| cut here / do not cut here | session boundary | per-stream param override + regenerate |
| detach · split | episode | verdict overridden, sticky |
| remove episode · split arc | arc | re-derivation must preserve |
| forget this hour / app / person | events | real deletion, cascades |

Every gesture writes `mutations(actor: user)` and **wins permanently over every future automated verdict**.

---

## 10. Step-by-step — raw signal to arc

```
 STEP  WHAT                                                EXECUTOR
 ════  ═════════════════════════════════════════════════   ══════════════
  1    ADAPTER PULLS                                       [CODE]
       manifest-driven · backfill + live
       raw → SourceEvent (neutral shape)
         │
  2    INGEST                                              [CODE]
       dedupe UNIQUE(source_id, external_id)
       resolve stream_id · stamp ts / observed_at
         │
  3    SALIENCE PREFILTER   (ambient only)                 [CODE]+[ML]
       capture threshold · phash dedupe · VAD · salience score
       90–99% dropped BEFORE anything downstream sees it
         │
  4    ENRICH                                              [ML]
       image→caption (VLM) · audio→text (whisper)
       video→frames · link→scrape · text→embedding
         │
  5    STRUCTURAL IDENTITY BINDING                         [CODE]
       metadata identity → exact match → bind entity_id
       no match → mint provisional entity + identity
         │
  6    IDENTITY RESOLUTION LADDER                    [CODE]→[ML]→[AGENT]
       exact → cross-source value match → embedding candidates
       → bounded resolver agent → ASK USER
       never a silent guess
         │
  7    MENTION LINKING                                     [ML]+[LLM]
       names inside text → roster-constrained top-K
       ambiguous → entity_id NULL + hint + question
         │
  8    OPEN / APPEND SESSION                               [CODE]
       per stream · reset debounce timer
         │
  9    SEAL SESSION                                        [CODE]
       debounce fires ∪ day boundary ∪ size cap ∪ 24h ceiling
       ∪ stream-kind trigger (§7.2)
       record boundary_reason + params · content_hash · IMMUTABLE
         │
 10    HASH GATE                                           [CODE]
       hash already segmented? → skip entirely (idle days ≈ 0 calls)
         │
 11    EPISODE SEGMENTATION                                [LLM]
       default session = episode (no call)
       CASE A one session N topics → split      (same read)
       CASE B new session vs OPEN episodes in SAME stream → attach
       persist decision_verdict_json → replay never re-judges
         │
 12    ARC BINDING — ① bridges first                       [CODE]
       url · order_id · file_id · attendee_set · phone/email
       · media_work_id · geo+time         ← exact, free, cross-source
         │
 13    ARC BINDING — ② entity overlap                      [CODE]
       Jaccard on anchor entity sets
         │
 14    ARC BINDING — ③ topic similarity                    [ML]
       calibrated cosine, HIGHER bar than intra-stream
         │
 15    ARC BINDING — ④ adjudication                        [LLM]
       cross-source ties only · still ambiguous → ASK USER
         │
 16    TWO-PHASE RECONCILE                                 [CODE]
       provisional arcs compared against each other AND committed
       arc_key rebinds to same id · duplicates die when comparable
         │
 17    LABEL                                               [LLM]
       plain-language label for episode and arc
       user label always outranks
         │
 18    AGE                                                 [CODE]
       episode quiet 14d → faded · arc quiet N weeks → dormant → archived
         │
 19    SURFACE                                             [CODE]
       Entities · Sessions · Episodes · Arcs
       every boundary → "why was this cut / merged here?"
         │
 20    CORRECT                                             [CODE]
       typed gestures → mutations(actor: user) → permanent
```

**Model-call budget per day, steady state, WhatsApp-only:** steps 11, 15 and 17 only. Most sessions become episodes 1:1 with **zero** calls; the hash gate makes re-syncs free. Steps 1–10 and 12–14 are code or on-device ML and cost nothing.

---

## 11. Determinism, replay, and privacy

1. **Sessions are a pure function of events + params.** Same input, same output, always. Re-running creates nothing new.
2. **Episodes and arcs are model-judged but replayable**, because the verdict is persisted and reused. A replay reuses the stored decision rather than re-judging it — otherwise boundary bugs are irreproducible.
3. **`[ replay ]` with changed params diffs old vs new** rather than silently mutating. This is the tuning loop.
4. **One SQLCipher DB is the only truth.** Key in the OS keychain, never leaves the device. No plaintext message dumps on disk.
5. **The append-only `mutations` log replaces git**: what changed, old, new, actor, run id, reason. This makes "undo last night's run" a real button — which is what makes it safe to let the system act boldly.
6. **Ambient sources are off by default**, with a visible recording indicator and a real "forget" that cascades to sessions, episodes and arcs.

---

## 12. Eval harness — build FIRST

> Without measurement, the next iteration is another theory of the same bug. V11 has no `evals/` directory and its eval script was removed.

1. **Gold set: 300–500 labelled units** spanning 1:1 chats, noisy groups, business broadcasts, forwarded content, multi-topic sessions, a document edit burst, a browsing burst, a transaction, a calendar block, and an ambient run.
2. **Label per unit:** correct session boundaries; correct episode grouping (split/attach); correct arc membership; correct entity for every actor and mention.
3. **CI gates:**

| Metric | Fails the build if |
|---|---|
| session boundary F1 vs gold | < 0.90 |
| episode grouping accuracy (split + attach) | < 0.85 |
| arc precision (wrong episodes in an arc) | < 0.90 |
| arc recall on bridge-joinable pairs | < 0.95 |
| entity resolution precision | < 0.98 |
| entity resolution recall | < 0.90 |
| identities silently guessed (should have asked) | **> 0** |
| ambient prefilter drop ratio | < 90% |
| segmentation determinism (same input → same output) | **any drift** |

4. **Arc recall on bridge-joinable pairs must be near-perfect** — those are exact string joins. Missing one is a code bug, not a judgment error.
5. **Fixtures are frozen events + frozen model verdicts**, so the harness runs offline and deterministically.

---

## 13. Acceptance — what "figured out" means

Run against the real WhatsApp corpus (~3,000 events, ~100 chats), then re-run with Calendar + Contacts added.

| # | Question | Target |
|---|---|---|
| 1 | Do sessions match human judgment of "one conversation"? | F1 ≥ 0.90 |
| 2 | Is every session boundary explainable in one line? | 100% |
| 3 | Is segmentation byte-identical on re-run? | 100% |
| 4 | Are episodes stable — no id churn on re-derivation? | 100% |
| 5 | Distinct entities vs raw actor rows | resolved 1:1, no `papa-new-number-jio` style ids |
| 6 | People with ≥2 identities correctly merged | ≥ 90% |
| 7 | Ambiguous identities asked rather than guessed | 100% |
| 8 | Arc count from this corpus | ≤ 50, none holding unrelated topics |
| 9 | **With Calendar added: arcs binding WhatsApp ↔ Calendar via bridges** | **> 0, precision 1.0** |
| 10 | Ambient prefilter drop ratio | ≥ 90% |
| 11 | Steady-state model calls per quiet day | ≤ 5 |
| 12 | User corrections surviving a full re-derivation | 100% |

**Row 9 is the one that proves the thesis.** If a calendar block and a WhatsApp thread about the same trip do not land in one arc, cross-source has not been achieved and nothing above this layer should be built.

---

## 14. Build order

```
 B0  EVAL HARNESS + GOLD SET ............................. [code + human]
        └─ nothing below is trustworthy without it
 B1  EMBEDDER CALIBRATION ................................ [code + ML]
        └─ measured floor per model, per-kind thresholds, persisted
 B2  DELETE store.ts · brain/writers.ts · migrations 0004-0006 .... [code]
 B3  ADAPTER REGISTRY + MANIFESTS ........................ [code]
        └─ generalise channel_id → stream_id; fix wa:/whatsapp.* leaks
 B4  SALIENCE PREFILTER (ambient scaffolding) ............ [code + ML]
        └─ build now even with WhatsApp only; retrofitting is brutal
 B5  ENTITY REGISTRY + RESOLUTION LADDER + MENTIONS ...... [code→ML→agent]
 B6  SESSIONS — 5 stream-kind segmenters ................. [code]
 B7  EPISODES — split / attach / verdicts ................ [LLM]
 B8  BRIDGES — deterministic cross-source joins .......... [code]
 B9  ARCS — overlap, similarity, adjudication, reconcile .. [code+ML+LLM]
 B10 FOUR SURFACES + CORRECTION GESTURES ................. [code]
 ───────────────────────────────────────────────────────────────────────
 GATE 1: WhatsApp only. Hit §13 rows 1–8, 10–12.
 GATE 2: add Calendar + Contacts. Hit row 9.
         Only then design anything above this layer.
```

1. **Add the second source before declaring victory.** A design that has only ever seen WhatsApp will bake in WhatsApp assumptions — V11 already did exactly this. **Calendar + Contacts** is the right second source: structured, low volume, and it forces identity resolution and bridges to be real. Two sources is the minimum viable proof of "cross-source". Not five — two.
2. **Build the ambient scaffolding early (B4) even while ambient is off.** Salience is a schema field and a pipeline stage; adding it after a million events exist is a migration nobody wants.
3. **B3–B9 are the thesis:** make the stream shape declarative, make identity a minted id, make boundaries deterministic and explainable, and make cross-source binding exact before it is fuzzy.

---

## 15. The one paragraph to remember

A session is a burst of one stream. An episode is one topic. An arc is one thread of your life, wherever it happened to be recorded. Sessions are code, episodes are one cheap call, arcs are string joins first and judgment last. Every one of them points at a minted entity id, so adding source #7 adds evidence instead of clutter — and every boundary the system draws can be shown to the user with the exact rule that drew it.
