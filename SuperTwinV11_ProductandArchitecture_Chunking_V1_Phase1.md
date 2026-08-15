# SuperTwinV11 — Chunking Phase 1: Entities, Relations, Sessions
**V1 · Phase 1 of 2 · standalone · built in the V11 repo**

**Scope:** adapter registry → ingest → enrich → **entity graph** (entities · identities · relations · mentions) → **sessions** → **2 surfaces** (Entities, Sessions).
**Phase 2 (separate doc):** episodes, arcs, + their 2 surfaces.
**Out of scope entirely:** claims, spaces, tasks, loops, agents-that-act, cards, digests.

> **Why this is Phase 1.** Sessions and entities are the only two layers with zero judgment risk — sessions are deterministic code, entities are mostly exact joins. If these are wrong, they are wrong for debuggable reasons. Everything above them (episodes, arcs, claims) consumes them. Build them, inspect them through their surfaces, hit the eval gates, and only then start Phase 2.

---

## 1. Thesis

1. **A session is the atomic unit of lived time.** One burst of one stream. Deterministic, immutable, explainable. No model touches it.
2. **Entities are the spine.** Every event, mention and session points at a **minted entity id** — never a name, phone, JID or slug. This decision is what makes source #2..#18 additive instead of multiplicative clutter.
3. **Relations are first-class.** "Rashmi is my sister", "Dr. Shreedhar treats me", "Prabhat works at my home" are edges in the graph, not prose. They are what later layers reason over.
4. **Source shape, not source name, drives segmentation.** Eighteen source families reduce to five stream kinds. New sources declare a kind in a manifest; the core never changes.
5. **The model is a bare instrument.** Every LLM call replaces the CLI's system prompt with ours, grants zero tools unless we define them, and returns schema-validated JSON. The CLI's own personality, tools and settings never leak in.
6. **Every automated decision is recorded with who made it and why.** `decided_by ∈ code|ml|llm|agent|user`, confidence, evidence. The two surfaces exist to inspect exactly this.

---

## 2. Sources → five stream kinds

Target source list and what each emits:

| # | Source family | Emits | Vol/day | Actors |
|---|---|---|---|---|
| 1 | WhatsApp · iMessage · SMS | turn-taking messages, media, replies, reactions | 10²–10³ | many |
| 2 | Notes · Reminders · Calendar | documents, point reminders, bounded blocks | 10⁰–10¹ | one/many |
| 3 | Google — Drive/Docs/Sheets/Slides/Tasks/Calendar/Gmail | file revisions, threads, bounded blocks | 10¹–10² | many |
| 4 | Slack | turn-taking, threads, channels | 10²–10³ | many |
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

**Five stream kinds** — every source declares exactly one per stream:

```
 KIND           SHAPE                        SESSION BOUNDARY RULE
 ════════════   ══════════════════════       ═════════════════════════════════
 CONVERSATION   turn-taking, many actors     silence gap ∪ participant shift ∪
   fam 1,4,6dm,7dm                           reply-chain break ∪ size cap ∪
                                             local midnight
 DOCUMENT       revisions to one artifact    edit-burst gap ∪ author shift ∪
   fam 2notes,3docs,15notes                  size cap  ("one working sitting")
 ACTIVITY       atomic acts by one actor     burst gap ∪ context shift (domain/
   fam 5,6feed,7feed,8,9,14,15,16,17,18      app/vertical) ∪ size cap;
                                             a transaction is ALWAYS its own
                                             session, never merged into a burst
 AMBIENT        unbounded sensor stream      salience prefilter FIRST, then
   fam 10,12,13                              context shift (app/speaker/scene/
                                             silence>90s) ∪ 10-min cap
                                             ∪ 15-min ceiling
 BOUNDED        record has start+end         session = the record. No inference.
   fam 2cal,3cal,11,17trips                  A meeting, a calendar block, a ride.
```

### 2.1 The adapter manifest — the whole extension contract

```ts
SourceManifest = {
  source_id:        string,                    // "whatsapp", "gmail", "screen"…
  display_name:     string,
  stream_kind_of:   (stream) => "conversation"|"document"|"activity"
                              | "ambient"|"bounded",
  actor_model:      "multi_actor" | "single_actor",
  self_identity:    { kind, value_getter },    // how "me" appears in this source
  streams:          { key: (ev)=>string, label: (ev)=>string },
  identities_emitted: ("jid"|"phone"|"email"|"handle"|"account_id"
                      |"device_id"|"profile_url")[],
  capabilities:     { backfill, live, media, revisions, edits, deletion },
  segmentation:     { gap_ms, size_cap_events, size_cap_chars,
                      day_boundary: bool, participant_shift: bool,
                      debounce_ms },
  salience:         { prefilter: "none"|"dedupe"|"vad"|"diff"|"threshold" },
  bridge_keys:      ("url"|"order_id"|"file_id"|"attendee_set"|"phone"
                    |"email"|"media_work_id"|"geo_time")[],   // used in Phase 2
}
```

1. **Segmentation is data, not code** — per-source defaults, per-stream overridable at runtime from the Sessions surface.
2. **`salience.prefilter` is mandatory for `ambient`** — a manifest with `ambient` + `none` fails validation at registration.
3. **`self_identity` is mandatory for every source** — the "me" entity (§6.6) binds through it.
4. **Manifest validation runs at registration**, not first use: missing fields, unknown kinds and duplicate `source_id`s are boot errors.

---

## 3. What changes on V11

### 3.1 Keep — untouched

| Subsystem | Path | State |
|---|---|---|
| WhatsApp daemon | `sources/whatsapp-go/` (whatsmeow, NDJSON stdio, mock engine) | Built, 130 Go tests |
| WhatsApp adapter + ingest | `worker/src/adapters/whatsapp/`, `worker/src/ingest/`, `worker/src/db/ingest.ts` | Built |
| Adapter interface | `worker/src/adapters/source-adapter.ts`, `adapters/types.ts` | Built, source-neutral |
| CLI provider core | `worker/src/providers/claude-local/` — binary probing, stream-json parse, poison-session recovery, 4-way token accounting, quota/auth pause ladders | Built, hardened |
| Enrichment workers | `worker/src/media/` — describe (vision), transcribe (whisper), frames, poster, link, yt captions, hallucination guard | Built, deepest-tested |
| Embedding runtime | `worker/src/retrieval/embedder.ts`, `db/embeddings.ts` (e5-small 384d int8) | Built |
| Retrieval + chat | `worker/src/retrieval/`, `server/chat-grounding.ts` | Built (untouched this phase) |
| Shell / server / UI | `src-tauri/`, `worker/src/server/`, `src/` | Built |

### 3.2 Delete — before writing new code

1. **`worker/src/store/store.ts`** — 1,864-line spaces/goals/milestones/tasks layer, zero runtime callers. It encodes an ontology this build does not use.
2. **`worker/src/brain/writers.ts` + `brain-template/`** — markdown wiki writers, zero callers. A file tree is one hierarchy; a life is a graph.
3. **Migrations `0004`–`0006`** — inert `spaces/goals/milestones/tasks/space_events/space_people/patterns/task_runs` tables.
4. **`<brain>/corpus/*.md` as a product path** — plaintext full-history dump on disk. Keep only behind an explicit debug-export action.

### 3.3 Fix — source leaks in generic layers

1. `db/ingest.ts:1990` — hardcoded `wa:` id prefix → `${source_id}:`.
2. `db/ingest.ts:1964` — `resetWhatsappData("whatsapp")` → `resetSourceData(source_id)`.
3. `app_state` keys `whatsapp.paused|self_jid|import_done` → `source.<id>.*`.
4. `/api/whatsapp/*` → `/api/sources/:source_id/*` (old routes alias for one release).
5. `index.ts:39` direct `WhatsAppAdapter` construction → manifest-driven **adapter registry**.
6. `events.channel_id` → **`stream_id`**; `channels` table → `streams` (channels are one flavour of stream).

### 3.4 Build — Phase 1 new components

| # | Component | Executor |
|---|---|---|
| P1-B0 | Eval harness + Phase-1 gold set (from `SuperTwinV11_GoldenEvals_V1.md`) | code + human |
| P1-B1 | Deletions (§3.2) + leak fixes (§3.3) | code |
| P1-B2 | Adapter registry + manifests + `stream_id` generalisation | code |
| P1-B3 | CLI **bare-call contract** (§5) | code |
| P1-B4 | Embedder calibration | code + ML |
| P1-B5 | Entity graph: registry, identities, edges, mentions, me-entity | code → ML → LLM → agent |
| P1-B6 | Sessions: 5 segmenters, seal/debounce, hash gate, ops rules | code |
| P1-B7 | Salience prefilter scaffolding (schema + pipeline stage; ambient off) | code + ML |
| P1-B8 | Surfaces: Entities (with relations), Sessions + correction gestures + APIs | code |

---

## 4. System architecture — Phase 1

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        YOUR MAC — everything local                            │
│                                                                               │
│ ┌───────────────────────────────────────────────────────────────────────────┐│
│ │ L0  ADAPTER REGISTRY                                   [CODE]              ││
│ │     manifest-driven · whatsapp (built) · calendar/contacts (gate 2) · …   ││
│ └─────────────────────────────────┬─────────────────────────────────────────┘│
│                                   ▼                                           │
│ ┌───────────────────────────────────────────────────────────────────────────┐│
│ │ L1  EVENTS — immutable, source-neutral                 [CODE]              ││
│ │     UNIQUE(source_id, external_id) · stream_id · actor binding · ts/tz    ││
│ └─────────────────────────────────┬─────────────────────────────────────────┘│
│                                   ▼                                           │
│ ┌───────────────────────────────────────────────────────────────────────────┐│
│ │ L1b SALIENCE PREFILTER (ambient only; scaffold now)    [CODE]+[ML]         ││
│ │     capture threshold · phash dedupe · a11y diff · VAD · salience score   ││
│ └─────────────────────────────────┬─────────────────────────────────────────┘│
│                                   ▼                                           │
│ ┌───────────────────────────────────────────────────────────────────────────┐│
│ │ L1c ENRICH                                     [CODE]+[ML]+[LLM-S]         ││
│ │     image/sticker/frames → caption   [LLM-S  via CLI, V11 built]           ││
│ │     audio → text                     [ML     whisper.cpp]                  ││
│ │     link → scrape · yt → captions    [CODE   fetch / yt-dlp]               ││
│ │     text → embedding                 [ML     e5-small]                     ││
│ └─────────────────────────────────┬─────────────────────────────────────────┘│
│                                   ▼                                           │
│ ┌───────────────────────────────────────────────────────────────────────────┐│
│ │ L2  ENTITY GRAPH                    [CODE]→[ML]→[LLM-S]→[AGENT]            ││
│ │     entities (16 types) · identities · EDGES (relations) · mentions       ││
│ │     structural binding [CODE] · mention+edge pass [LLM-S] ·               ││
│ │     resolution ladder [CODE→ML→AGENT→user] · me-entity                    ││
│ │     OUTPUT: the ROSTER injected into every downstream prompt              ││
│ └─────────────────────────────────┬─────────────────────────────────────────┘│
│                                   ▼                                           │
│ ┌───────────────────────────────────────────────────────────────────────────┐│
│ │ L3  SESSIONS — deterministic, NO MODEL                 [CODE]              ││
│ │     5 stream-kind policies · debounce per stream · seal → immutable       ││
│ │     content_hash · boundary_reason + params recorded on every cut         ││
│ └─────────────────────────────────┬─────────────────────────────────────────┘│
│                                   ▼                                           │
│ ┌───────────────────────────────────────────────────────────────────────────┐│
│ │ L6  STORE — SQLite (plain, WAL). ONE file, ONE truth.  [CODE]              ││
│ │     relational + edges table (graph) + FTS5 + int8 vectors + mutations    ││
│ │     NOT encrypted in Phase 1 — see §7.1                                   ││
│ └─────────────────────────────────┬─────────────────────────────────────────┘│
│                                   ▼                                           │
│ ┌───────────────────────────────────────────────────────────────────────────┐│
│ │ L7  SURFACES: ENTITIES (graph + relations) · SESSIONS  [CODE]              ││
│ │     every boundary and binding → "why?" → rule + params + evidence        ││
│ └───────────────────────────────────────────────────────────────────────────┘│
│                                                                               │
│  MODEL ROUTER (§5):  [ML] on-device  ·  [LLM-S]/[LLM-M]/[AGENT] → CLI bare   │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Executor legend used everywhere:**

| Tag | Means | Runs on | Cost |
|---|---|---|---|
| `[CODE]` | Deterministic code | worker | free |
| `[ML]` | Small on-device model — e5 embeddings, whisper.cpp, phash, VAD | device | ~free |
| `[LLM-S]` | Small hosted LLM (Haiku-class) via CLI bare call — high volume, low difficulty | user's subscription | metered, cheap |
| `[LLM-M]` | Mid hosted LLM (Sonnet-class) via CLI bare call — judgment calls | user's subscription | metered |
| `[AGENT]` | LLM-M + our tools, bounded turns | user's subscription | metered |

---

## 5. The CLI adapter — bare-call contract

V11's provider already probes binaries, parses `stream-json`, recovers poisoned sessions, and accounts tokens 4-way. Phase 1 hardens it into a **bare instrument**:

### 5.1 The contract

1. **No CLI system prompt.** Every call **replaces** the CLI's default system prompt with ours (`--system-prompt`, never `--append-system-prompt`). The CLI's personality must never leak into extraction.
2. **No tools by default.** Deny-all: `--allowedTools ""` + `--disallowedTools "*"` + `--setting-sources ""` + no MCP servers. (V11's four-lever denial, made the default for every call.)
3. **No thinking by default.** `MAX_THINKING_TOKENS=0` for all bare calls — determinism and cost.
4. **No user settings, no CLAUDE.md, no hooks.** `--setting-sources ""` so the user's own Claude Code config cannot alter extraction behaviour.
5. **JSON in, JSON out.** Every bare call carries an explicit output schema in the system prompt; the response is parsed and schema-validated. Parse failure → one repair retry (same call + "return ONLY valid JSON matching the schema") → quarantine.
6. **Tooled mode is opt-in per call.** An agent call registers exactly one local MCP server (`supertwin-tools`) exposing only the tools listed in that call's spec (§10), with turn/time caps. Nothing else.
7. **Model tier is chosen by the caller**, not the CLI default: `[LLM-S]` = Haiku-class, `[LLM-M]` = Sonnet-class, mapped in `providers/claude-local/models.ts`.
8. **Failure taxonomy is preserved:** `QUOTA_EXCEEDED` → pause with countdown, `AUTH_REQUIRED` → pause with re-probe ladder, `CLI_ERROR` → retry 2s/10s/30s then quarantine. A quota or auth pause never burns a unit's retry budget.

### 5.2 Call modes

```
 MODE     SYSTEM PROMPT   TOOLS                 THINKING   OUTPUT
 ═══════  ══════════════  ════════════════════  ═════════  ════════════════
 bare     ours, replace   none (deny-all)       off        schema JSON
 tooled   ours, replace   supertwin-tools only  off        schema JSON verdict
          (agent)         (per-call whitelist)             + persisted session
```

---

## 6. The entity graph

### 6.1 Entity types — 16, closed set

| # | Type | Subtypes (closed per type) | Examples from the corpus |
|---|---|---|---|
| 1 | `person` | — | Pranjali, Rahul, Dr. Shreedhar, "the broker" (hint until resolved) |
| 2 | `group` | family, friends, work, community, event | "Ghar+" WhatsApp group, Goa Crew |
| 3 | `org` | company, hospital, clinic, school, government, vendor, restaurant_chain | Hotstar, Policybazaar, Apollo Clinic |
| 4 | `place` | city, area, venue, restaurant, home, office, address | Indiranagar, Pizza 4P's, Vega City |
| 5 | `product` | physical, digital | M2 MacBook, muesli brand, air fryer |
| 6 | `service` | subscription, plan, policy, utility, membership | Superhuman, Wispr Flow, broadband plan, insurance policy |
| 7 | `media_work` | film, show, song, album, video, book, article, podcast, game | a WWE match, a YouTube video, a book |
| 8 | `document` | doc, sheet, slide, note, pdf, form | rent agreement PDF, a shared Doc |
| 9 | `app_site` | app, website | Zomato, booking.com, Claude CLI |
| 10 | `occasion` | birthday, wedding, trip, festival, party, appointment, meeting | Gargi's 40th, Rahul's wedding, Goa trip |
| 11 | `topic` | — (free label, closed creation rules §6.5) | local LLM performance, bhangra, therapy |
| 12 | `pet` | dog, cat, other | a friend's Rottweiler |
| 13 | `vehicle` | car, bike, other | — |
| 14 | `account` | bank, wallet, utility, membership_id | HDFC account (as referenced, no numbers) |
| 15 | `health_item` | condition, medication, treatment, procedure | rabies vaccination, arthritis treatment |
| 16 | `food_item` | dish, cuisine, recipe | chole bhature, a baked experiment |

1. **The set is closed.** The model may only mint within these 16. Anything that fits nowhere becomes a `topic` — never a new type.
2. **Minted ids, always.** `ent_` + random. Never derived from name/JID/phone/URL. Renames and merges must not change ids.
3. **`canonical` display name** is chosen by code (longest user-confirmed alias, else most-frequent surface form); the model never renames an entity.

### 6.2 Identities — how sources point at entities

```sql
entity_identities (id PK, entity_id FK, source_id, kind, value_norm,
                   confidence REAL, decided_by, decided_at,
                   UNIQUE(source_id, kind, value_norm))
-- kind: jid | phone | email | handle | account_id | device_id | profile_url | alias
-- decided_by: code | ml | agent | user
```

1. Values are **normalised before storage** (E.164 phones, lowercased emails, canonical URLs).
2. `phone` and `email` are **cross-source join keys**: the same normalised value observed in two sources binds to one entity at `[CODE]` confidence.
3. `alias` holds nicknames ("Babbu" → Shaurya) — created only by the mention pass with evidence, or by the user.

### 6.3 Relations — the edges table

```sql
entity_edges (id PK, kind, subtype, src_entity_id FK, dst_entity_id FK,
              confidence REAL, decided_by, status, valid_from, valid_to,
              created_at, UNIQUE(kind, subtype, src_entity_id, dst_entity_id))
-- status: active | superseded | rejected
edge_evidence (edge_id FK, event_id FK, quote, PRIMARY KEY(edge_id, event_id))
```

**Edge kinds — closed set, structural relations only** (descriptive statements like opinions/preferences are NOT edges; they are claims, out of scope):

| Kind | Subtypes | Direction | Typical origin |
|---|---|---|---|
| `family_of` | mother, father, sibling, spouse, child, grandparent, cousin, in_law, aunt_uncle, niece_nephew | src is subtype of dst | text `[LLM-S]` |
| `social_of` | friend, roommate, neighbor, acquaintance | symmetric | text `[LLM-S]` |
| `works_with` | colleague, manager, report, cofounder, client | src role toward dst | text `[LLM-S]` |
| `works_at` | employee, founder, contractor | person → org | text `[LLM-S]` |
| `provides_care` | doctor, therapist, trainer, cook, domestic_help | provider → person | text `[LLM-S]` |
| `member_of` | — | person → group | **chat metadata `[CODE]`** |
| `owns` | — | person → product/vehicle/pet/account | text `[LLM-S]` |
| `pet_of` | — | pet → person | text `[LLM-S]` |
| `subscribes_to` | — | person → service | text / commerce `[CODE]` |
| `lives_at` | current, past | person → place | text `[LLM-S]` |
| `located_in` | — | place → place, org → place | text / metadata |
| `part_of` | — | place→place, org→org, group→group | metadata / text |
| `created` | — | person → document/media_work | file metadata `[CODE]` |
| `provides` | — | org → product/service | text / commerce |
| `about` | — | document/media_work/occasion → any | text `[LLM-S]` |
| `participant_in` | organizer, attendee, guest_of_honor | person → occasion | calendar `[CODE]` / text |

1. **Metadata-derived edges are `[CODE]`, confidence 1.0**: group membership from chat participant lists, calendar attendees, file owners. These are free and exact — extract them before any model runs.
2. **Text-derived edges come from the mention pass** (§10.1) with a mandatory verbatim quote.
3. **Edges are bitemporal-lite**: `valid_from`/`valid_to` nullable. "Rashmi moved offices" ends one `works_at` and opens another; both rows survive.
4. **Contradiction → supersede, never overwrite.** New evidence that Prabhat no longer cooks for the house sets `valid_to` + `status: superseded` with the evidence attached.
5. **User edits win permanently** (`decided_by: user` outranks all future automation for that pair).

### 6.4 Mentions — textual references inside events

```sql
mentions (id PK, event_id FK, span_start, span_end, surface_text,
          entity_id NULL, new_entity_json NULL, entity_hint NULL,
          confidence REAL, decided_by)
```

1. A mention links a text span to a roster id, **or** proposes a new entity, **or** records an honest unknown (`entity_id NULL` + `entity_hint "the broker"`). **Unknown beats wrong.**
2. Pronouns and elliptical references ("she", "that place") are resolved **within the session only**, never across sessions, and only when unambiguous — else hint.

### 6.5 Creation discipline — what stops entity sprawl

1. `person`/`group`/`org` from **structural identity**: minted freely by `[CODE]` (a new JID is a new provisional person).
2. All other types from **text**: minted only by the mention pass with ≥1 verbatim quote, and pass through the same near-duplicate check as resolution (§6.7) before commit.
3. `topic` minting requires the surface form to appear ≥2 times in the session or match an existing topic — one-off nouns do not become topics.
4. Every entity created by a model is `provisional` until it accumulates a second evidence event or a user touch; provisional entities older than 30 days with one evidence are auto-archived.

### 6.6 The "me" entity

1. One canonical `person` entity `me`, created at install.
2. Every manifest's `self_identity` binds into it: WhatsApp self-JID, Gmail account email, device ids. `[CODE]`, confidence 1.0.
3. `events.is_self` is computed by code from identity binding — never asked of a model.

### 6.7 The resolution ladder — escalate, never guess

```
   new identity or proposed entity observed
        │
        ├─ exact match (source_id, kind, value_norm) ─────────► BIND      [CODE]
        ├─ cross-source exact (phone/email norm) ─────────────► BIND      [CODE]
        ├─ candidate set: embedding sim + alias + string dist ► score     [ML]
        │     calibrated score ≥ high bar ────────────────────► BIND      [ML]
        │     score in band ──────────────────────────────────► ADJUDICATE[AGENT]
        │                                                       (§10.2: ≤3 turns,
        │                                                        read-only tools)
        │     agent verdict same/different, conf ≥ bar ───────► APPLY
        └─ still torn ────────────────────────────────────────► RESOLUTION QUEUE
                                                                (ask user, §12.1)
   INVARIANT: zero silent guesses. Every bind records decided_by + confidence.
```

1. **Merges are tombstones**: `entities.merged_into` redirect, O(1), reversible; all identities/edges/mentions re-point lazily via the redirect at read time, compacted nightly.
2. **Negative pairs are stored** (`resolution_decisions` table): a user's "different people" verdict permanently blocks re-proposal of that pair.

### 6.8 Embedder calibration — prerequisite for the `[ML]` rung

1. V11 ships `multilingual-e5-small`. Its **unrelated-pair cosine floor is ~0.75–0.85, not ~0**. Absolute thresholds sit inside the noise band — a prior run against this exact embedder collapsed 50 of 54 comparisons to "same".
2. At startup: measure the floor per model from stored vectors (sample ≥1,000 random unrelated pairs), persist to `embedder_calib`, and normalise every score: `score = (cos − floor) / (1 − floor)`.
3. Thresholds are **per-use-case** (`entity_name`, `entity_rich_text`) and **per-model** — never module constants.
4. **Never compare bare names.** Candidate scoring embeds rich text: name + aliases + top co-occurring entities + a representative quote.

---

## 7. Storage

### 7.1 One plain SQLite file — the only truth

1. **SQLite via better-sqlite3, WAL mode, one file.** V11's existing runtime, kept.
2. **NOT encrypted in Phase 1.** Encryption (SQLCipher + OS-keychain key) is deferred until the system works — but the design keeps it a contained flip: one DB file, no plaintext side-stores (that is why §3.2.4 removes the corpus dump), no absolute paths inside the DB.
3. **No separate graph database — deliberate.** The graph workload here is shallow (1–3 hops: person→edges→entities; entity→mentions→events) over small cardinality (≤10⁵ entities, ≤10⁶ edges, ≤10⁷ events for years of data). An `entity_edges` table + recursive CTEs serves this exactly, keeps **one transaction domain** (a session seal, its mentions and its mutations commit atomically), one backup story, and the mutations log spanning everything. A dedicated graph DB (Kùzu/Neo4j-embedded) becomes worth it only if hop-depth or edge cardinality explodes — and then **as a derived index rebuilt from SQLite, never as truth**.
4. **Vectors**: int8 BLOBs + brute-force cosine (V11's approach) — exact and fast to ~10⁶ vectors; revisit with an ANN index only past that.
5. **Lexical**: FTS5 external-content over event text + enrichment columns (V11's, kept).

### 7.2 Data model — Phase 1 DDL

```sql
-- registry ───────────────────────────────────────────────────────────
sources           (id PK, display_name, actor_model, manifest_json,
                   enabled, created_at)
streams           (id PK, source_id FK, external_key, label, stream_kind,
                   participant_entity_ids JSON, tz,
                   segmentation_override_json NULL,
                   UNIQUE(source_id, external_key))

-- events (V11 evolved: channel_id→stream_id, + salience, tz, actor binding) ─
events            (id PK, source_id, stream_id FK, external_id,
                   actor_entity_id NULL, actor_raw, is_self, is_business,
                   ts, ts_end NULL, tz, observed_at, is_historical,
                   kind, text, structured_json,
                   media_* (V11 lifecycle cols kept),
                   link_*  (V11 lifecycle cols kept),
                   transcript_* (V11 kept),
                   reply_to_external_id, revision_of NULL,
                   salience REAL NULL,
                   UNIQUE(source_id, external_id))
-- kind: message|post|comment|reaction|edit|revoke|view|play|save|order
--     | visit|frame|utterance|appointment|file_change|reminder|clip

-- entity graph ───────────────────────────────────────────────────────
entities          (id PK minted, type, subtype NULL, canonical,
                   provisional, merged_into NULL, user_pinned,
                   first_seen_at, last_seen_at, created_at)
entity_identities (…)                                   -- §6.2
entity_edges      (…) + edge_evidence (…)               -- §6.3
mentions          (…)                                   -- §6.4
resolution_decisions (id PK, left_id, right_id, verdict, decided_by,
                   reason, created_at, UNIQUE(left_id, right_id))
entity_embeddings (entity_id PK, vec BLOB, model, dim)
embedder_calib    (model PK, use_case, floor REAL, measured_at, n_pairs,
                   PRIMARY KEY(model, use_case))

-- sessions ───────────────────────────────────────────────────────────
sessions          (id PK, stream_id FK, source_id,
                   started_at, ended_at, tz,
                   event_ids JSON, participant_entity_ids JSON,
                   boundary_reason_start, boundary_reason_end,
                   boundary_params_json,
                   content_hash, superseded_hash NULL,
                   status, sealed_at,
                   late_arrival, overlap_of NULL)
-- boundary_reason: gap|participant_shift|reply_break|size_cap|day_boundary
--                | context_shift|record_bounded|ceiling|debounce|stream_start
-- status: open | sealed

-- ops ────────────────────────────────────────────────────────────────
runs              (id PK, kind, started_at, ended_at, status,
                   input_tokens, cache_create, cache_read, output_tokens,
                   cost_usd, model, error_code NULL, error_msg NULL)
                   -- kind: entity_pass|resolve_agent|enrich_describe|calib|…
quarantine        (id PK, unit_kind, unit_id, run_id, error_code,
                   last_error, attempts, created_at, replayed_at NULL)
mutations         (id PK, ts, actor, run_id NULL, target_kind, target_id,
                   field, old_json, new_json, reason)
                   -- actor: ingest|code|ml|llm|agent|user
watermarks        (stream_id PK, live_high_ts, live_high_external_id,
                   backfill_low_ts NULL)
```

**Invariants (schema/code, never prompts):**

1. `events.actor_entity_id` is an entity id or NULL + `actor_raw`. A name string is never an id.
2. Sealed sessions are **immutable** — no UPDATE path exists for `event_ids` of a sealed session.
3. Every session stores **both** boundary reasons + the measured params that fired.
4. Every model-created row carries `decided_by` + `confidence` + evidence.
5. Every write emits a `mutations` row. "Undo last run" replays them in reverse.

---

## 8. Sessions — full specification

### 8.1 Policies per stream kind

```
 CONVERSATION   cut when ANY fires:
                  gap > G            G default 6h; group chats default 4h;
                                     per-stream override
                  participant shift  (multi_actor streams only)
                  reply-chain break  a reply targeting an event > G older
                                     starts a NEW session (linked via
                                     reply_to; the old session stays sealed)
                  size cap           40 events or 6,000 tokens, whichever first
                  local midnight     in the STREAM's tz (§8.4)

 DOCUMENT       revision gap > 45m ∪ author shift ∪ 200 revisions cap
                session = one working sitting on one artifact

 ACTIVITY       gap > 30m ∪ context shift (registrable domain / app id /
                commerce vertical changes) ∪ 100 events cap
                a transaction event (kind=order) ALWAYS seals as its own
                single-event session

 AMBIENT        (after prefilter §9) context shift: foreground app change,
                speaker change, scene change, silence > 90s
                ∪ 10-min cap ∪ 15-min absolute ceiling
                a contiguous low-salience run collapses to ONE coarse session

 BOUNDED        session = the record; start/end given; caps DO NOT apply
                (a 90-min meeting is one session regardless of size)
```

### 8.2 Live streams — open-session + debounce

```
 event arrives in stream S
   ├─ no open session for S → open one (boundary_reason_start recorded)
   └─ else → append
   reset debounce timer for S (manifest debounce_ms, default 45 min)
        │
   debounce fires ∪ any §8.1 trigger ∪ 24h ceiling
        ▼
   SEAL: ended_at set · content_hash = sha256(sorted event external_ids
         + text hashes) · immutable · boundary_reason_end recorded
        ▼
   HASH GATE: hash already processed downstream? → downstream skips
```

1. **Event-driven, debounced per stream — never a global clock.** Most hours hold 3 messages across 8 streams; a global "process the last hour" both wastes calls and splits live exchanges.
2. **Backfill and live use the same segmenter**, ordered by `ts` (never insertion order/rowid — backfill arrives late but belongs early). Durability = per-stream `(ts, external_id)` watermark.

### 8.3 Non-content events — the rules that keep sessions honest

1. **Reactions** attach to their parent event's session (even if sealed). They never open a session and never reset the debounce — a 👍 seven hours later is not a conversation.
2. **Edits** within an open session mutate the event in place. Edits arriving **after seal** are stored, attach to the parent session for provenance, and set `sessions.superseded_hash` — the hash gate then treats the session as changed, so downstream (Phase 2) may re-read it. The session's event membership never changes.
3. **Revokes** mark the event revoked; membership unchanged; `superseded_hash` set.
4. **Read receipts / delivery events** are not events. Dropped at the adapter.

### 8.4 Time, restarts, late arrivals

1. **Timezones:** every event stores its `tz`. A stream's tz = the device tz at ingest (per-stream overridable). Day-boundary cuts compute midnight in the **stream's** tz.
2. **Restart safety:** open sessions live in the DB (`status: open`). On boot, debounce timers are recomputed from each open session's last event `ts`; anything past its window seals immediately. No in-memory-only state.
3. **Late arrivals:** an event whose `ts` falls inside an already-sealed session's range (backfill overlap, device sync lag) forms a **new** session flagged `late_arrival` with `overlap_of` pointing at the sealed one. Sealed sessions are never reopened.
4. **Clock skew:** events with `ts` > now + 5 min are clamped and flagged in `structured_json`.

---

## 9. Enrichment — corrected executor map

The prior draft tagged enrichment `[ML]` wholesale. Wrong: **vision runs on a small hosted LLM via the CLI adapter** (already built in V11). The correct map:

| Input | Step | Executor | Engine | Notes |
|---|---|---|---|---|
| image / sticker | caption | **[LLM-S]** | Haiku-class via CLI bare call | V11 `media/describe.ts` — batched, hallucination guard, anti-mismatch degradation kept |
| video | frame sampling | [CODE] | ffmpeg | V11 `frames.ts` |
| video frames | caption (one call, N frames) | **[LLM-S]** | Haiku-class via CLI | V11 built |
| voice / audio | transcription | [ML] | whisper.cpp (Metal, large-v3-turbo-q5) | V11 `transcribe.ts` |
| link | scrape + og fill | [CODE] | fetch | V11 `link.ts` |
| YouTube link | captions | [CODE] | yt-dlp | V11 `linkvideo.ts` |
| any text | embedding | [ML] | e5-small int8 | V11 `embedder.ts` |
| screen frame (ambient) | dedupe | [ML]/[CODE] | phash + a11y-tree diff | new, scaffold |
| ambient audio | speech gate | [ML] | VAD | new, scaffold; silence never reaches disk |
| screen frame (salient) | caption/read | **[LLM-S]** | Haiku-class via CLI | only frames that survive prefilter |

1. **Enrichment is a cost center — gate it.** Ambient sources enrich only above the salience threshold; low-salience runs get zero LLM calls.
2. V11's crash-safe queue semantics (verdict-only state transitions, growing backoff, rate throttle) are kept as-is.

---

## 10. Prompts and agent specifications

Conventions: `{{…}}` are template slots. All calls follow the bare-call contract (§5). Every output is schema-validated; failure → 1 repair retry → quarantine.

### 10.1 P-EP1 — Entity pass (per sealed session) — `[LLM-S]`, bare

**Purpose:** link textual mentions to the roster, propose new entities, propose relation edges. One call per sealed session (batched N sessions per call for cost — each session a separate item, never blended).

**SYSTEM:**
```
You are the entity linker for a private personal-memory system. You receive
ONE conversation/activity session and a ROSTER of known entities.

TASKS
1. MENTIONS: find every textual reference to a person, group, org, place,
   product, service, media work, document, app/site, occasion, topic, pet,
   vehicle, account, health item, or food item. Link each to a roster id.
2. NEW ENTITIES: if a mention clearly refers to something not on the roster,
   propose it with a type from the closed list above and a subtype.
3. EDGES: propose relation edges ONLY from this closed list:
   family_of, social_of, works_with, works_at, provides_care, owns, pet_of,
   subscribes_to, lives_at, located_in, part_of, created, provides, about,
   participant_in. Every edge requires a verbatim quote from the session.

RULES
- Use ONLY ids from the roster. If unsure between two roster entries, or the
  referent is unclear, set entity_id null and give entity_hint. UNKNOWN BEATS
  WRONG. Never guess.
- Resolve pronouns only within this session and only when unambiguous.
- Speaker identity is provided per message by the system; never infer or
  contradict it.
- Do not propose edges for opinions, preferences, recommendations, feelings,
  or one-off actions. Edges are durable structural relations only.
- A topic may be proposed only if its surface form occurs 2+ times in the
  session or matches an existing roster topic.
- Output ONLY JSON matching the schema. No prose.

SCHEMA
{"sessions":[{"session_id":"...",
  "mentions":[{"event_id":"...","surface":"...","entity_id":"ent_..|null",
    "new_entity":{"type":"...","subtype":"...","name":"..."}|null,
    "entity_hint":"...|null","confidence":0.0}],
  "edges":[{"kind":"...","subtype":"...|null","src":"ent_..","dst":"ent_..",
    "quote":"...","event_id":"...","confidence":0.0}],
  "questions":[{"about":"...","question":"..."}]}]}
```

**USER (template):**
```
ROSTER (id · type · name · aliases · 1-line context):
{{roster_block — participants first, then top-K candidates by embedding
   similarity to the session text, K ≤ 40}}

SESSIONS:
--- session {{session_id}} · {{source}} · {{stream_label}} · {{date}} ---
{{numbered events: [event_id] [speaker: entity display name] text}}
--- end ---
{{…next session…}}
```

**EXAMPLE (one, held in the prompt):**
```
Input event: [ev_812] [Rahul Arora] "shifting to Indiranagar next month,
             the broker found a 2BHK near the metro"
Output:
 mentions: [{event_id:"ev_812",surface:"Indiranagar",entity_id:"ent_pl_ind",
             confidence:0.95},
            {event_id:"ev_812",surface:"the broker",entity_id:null,
             entity_hint:"Rahul's broker (unnamed)",confidence:0.9}]
 edges:    [{kind:"lives_at",subtype:"current",src:"ent_p_rahul",
             dst:"ent_pl_ind",quote:"shifting to Indiranagar next month",
             event_id:"ev_812",confidence:0.7}]
```

**Settings:** model `[LLM-S]` · max output 4,000 tok · thinking off · tools none · batch ≤6 sessions or ≤8k input tok per call.

### 10.2 P-AG1 — Identity resolver — `[AGENT]`, tooled

**Purpose:** adjudicate one candidate pair the `[ML]` rung could not settle.

**SYSTEM:**
```
You resolve whether two entity records refer to the same real-world entity in
a private personal-memory system. You have read-only tools. Investigate, then
answer.

RULES
- Evidence beats similarity of names. Shared phone/email/handle is near-proof.
  Same first name alone is weak.
- People: consider co-occurring contacts, groups, places, time patterns.
- If evidence is insufficient or conflicting, answer "unsure" — a human will
  decide. Never force a verdict.
- Output ONLY the JSON verdict.

SCHEMA
{"verdict":"same|different|unsure","confidence":0.0,
 "reason":"one sentence citing the decisive evidence",
 "evidence_event_ids":["..."]}
```

**USER (template):**
```
PAIR
A: {{entity A: id, type, canonical, identities, top edges, first/last seen}}
B: {{entity B: same}}
ML score (calibrated): {{score}}
Shared context precomputed: {{shared groups/streams/phones if any}}
```

**Tools (local MCP `supertwin-tools`, this call only):**

| Tool | Sig | Returns |
|---|---|---|
| `search_entities` | (query, type?) | ≤10 matches: id, canonical, identities summary |
| `read_entity` | (id) | full record: identities, edges, top mentions w/ quotes, streams seen in |
| `read_events` | (event_ids ≤10) | raw event texts |

**Settings:** model `[LLM-M]` · **max 3 turns** · wall clock 60s · max 8k tok total · write scope: none (verdict applied by code) · session persisted to `runs` for audit · `unsure` → resolution queue, never retried automatically.

### 10.3 Call settings summary

| Call | Tier | Tools | Turns | Thinking | Output | On parse fail | On quota/auth |
|---|---|---|---|---|---|---|---|
| P-EP1 entity pass | LLM-S | none | 1 | off | schema JSON | 1 repair → quarantine session | pause, resume, no budget burn |
| P-AG1 resolver | LLM-M | 3 read-only | ≤3 | off | verdict JSON | 1 repair → queue as unsure | pause |
| media describe (V11) | LLM-S | none | 1 | off | per-item captions | V11 solo-degrade rule | V11 ladder |

---

## 11. Ops

1. **Runs:** every model call writes a `runs` row (tokens 4-way, cost, model, error). Surfaced in Settings; the "chat vs background" spend split is honest (separate `kind`s).
2. **Quarantine:** a unit failing 3 retries lands in `quarantine` with its error; the pipeline steps past it and keeps going. Quarantined units are replayable from the surface after a fix.
3. **Mutations:** append-only; "undo run X" is reverse-replay of its rows. User gestures are mutations with `actor: user` and are never undone by automation.
4. **Determinism:** sessions are a pure function of (events, params) — byte-identical on re-run. Entity/edge writes are idempotent upserts keyed on natural keys (§6.2, §6.3 UNIQUE constraints).
5. **API routes (Phase 1):**

```
GET  /api/entities?type=&q=&unresolved=      GET  /api/entities/:id
GET  /api/entities/:id/edges                 GET  /api/entities/:id/mentions
POST /api/entities/:id/merge                 POST /api/entities/:id/split
POST /api/entities/:id/pin|rename
GET  /api/resolution-queue                   POST /api/resolution-queue/:id/answer
GET  /api/sessions?stream=&date=&source=     GET  /api/sessions/:id
POST /api/sessions/replay?stream=            GET  /api/streams/:id/segmentation
PUT  /api/streams/:id/segmentation           GET  /api/runs · /api/quarantine
POST /api/quarantine/:id/replay              POST /api/runs/:id/undo
```

---

## 12. The two surfaces

### 12.1 Entities — registry, graph, resolution queue

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
│      Pranjali ──works_with:colleague──▶ (glass artist, unresolved ⚠)   │
│      Pranjali ──member_of──▶ "Ghar+" group          ✓code              │
│      Pranjali ──lives_at:current──▶ Bangalore       0.8 llm "…quote…"  │
│  41 sessions · first seen 12 Mar · last seen today                     │
│  [ merge ] [ split ] [ rename ] [ pin ] [ add relation ]               │
├────────────────────────────────────────────────────────────────────────┤
│ ⚠ RESOLUTION QUEUE                                                     │
│  "Papa (new number Jio)" ↔ "Papa"      agent: unsure 0.83              │
│    evidence: same groups (Family), same nickname usage                 │
│    [ same ] [ different ] [ later ]                                    │
└────────────────────────────────────────────────────────────────────────┘
```

1. Browse/search by type; filter unresolved/provisional. Every identity and edge shows `decided_by`, confidence, and its evidence quote on hover.
2. **Relations pane renders the 1-hop ego graph** with edge kind/subtype labels; click-through walks the graph.
3. Gestures: `merge` `split` `rename` `pin` `add relation` `reject edge` — each a `mutations(actor:user)` row, permanent.
4. The resolution queue is the primary human loop: pairs and hints the ladder could not settle, each with the agent's reasoning attached.

### 12.2 Sessions — the segmentation debugger

```
┌────────────────────────────────────────────────────────────────────────┐
│ SESSIONS   source [all ▾] stream [all ▾] date [14 Aug ▾]    38 sealed  │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ WhatsApp · Pranjali          09:12–09:41 · 14 events · conversation  │
│    START: gap 7h20m > 6h (G=6h)      END: debounce 45m                 │
│    participants: me, Pranjali        hash 3f9a… ✓processed             │
│    [ view events ] [ replay stream ] [ cut here / don't cut ]          │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ WhatsApp · Ghar+ group       20:02–23:58+00:14 ✂ · day_boundary      │
│    note: split at local midnight (Asia/Kolkata)                        │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ Calendar · Standup           10:00–10:15 · 1 event · bounded         │
│    boundary: record_bounded (no inference)                             │
├────────────────────────────────────────────────────────────────────────┤
│ REPLAY stream "Pranjali" with G=4h  →  diff: 3 sessions become 5       │
│    [ apply new params ] [ discard ]                                    │
└────────────────────────────────────────────────────────────────────────┘
```

1. Every session shows **both boundaries with the exact rule and measured value**.
2. `replay` re-segments a stream with candidate params and **diffs** old vs new before applying — this is the tuning loop, not guesswork.
3. Per-stream overrides (`segmentation_override_json`) are set here.
4. Reactions/edits display attached to their parent session; `superseded_hash` sessions carry a "content changed after seal" badge.

---

## 13. Step-by-step — one signal to the surfaces

```
 STEP  WHAT                                               EXECUTOR
 ════  ══════════════════════════════════════════════     ═══════════════
  1    ADAPTER PULLS  (manifest-driven, backfill+live)    [CODE]
  2    INGEST  dedupe (source_id, external_id) · stream   [CODE]
       resolve · ts/tz/observed_at stamp · watermark
  3    SALIENCE PREFILTER (ambient only)                  [CODE]+[ML]
       capture threshold · phash/a11y dedupe · VAD · score
  4    ENRICH                                             [CODE]+[ML]+[LLM-S]
       image/frames→caption [LLM-S via CLI] ·
       audio→text [ML whisper] · link→scrape [CODE] ·
       embed [ML e5]
  5    STRUCTURAL IDENTITY BINDING                        [CODE]
       metadata identity → exact bind, else mint
       provisional entity · me-entity via self_identity ·
       metadata edges (member_of, participant_in, created)
  6    OPEN/APPEND SESSION · debounce reset               [CODE]
       (reactions/edits attach, never reset)
  7    SEAL  (§8.1 triggers ∪ debounce ∪ ceiling)         [CODE]
       boundary_reason + params · content_hash · immutable
  8    ENTITY PASS  P-EP1 per sealed session              [LLM-S]
       mentions + new entities + text edges (quoted)
  9    RESOLUTION LADDER  for provisional/proposed        [CODE]→[ML]→[AGENT]
       exact → cross-source → calibrated ML → P-AG1 agent
       → resolution queue (ask user; never guess)
 10    WRITE  idempotent upserts · decided_by/confidence  [CODE]
       /evidence on every row · mutations appended
 11    SURFACE  Entities · Sessions                       [CODE]
 12    CORRECT  typed gestures → mutations(actor:user)    [CODE]
       → permanent, feed every future prompt
```

---

## 14. Eval gates — Phase 1

Gold set: `SuperTwinV11_GoldenEvals_V1.md` categories A–I (session boundaries, entity resolution, mentions, edges, enrichment routing) + L (calibration). CI-gated:

| Metric | Gate |
|---|---|
| Session boundary F1 vs gold (all 5 kinds) | ≥ 0.90 |
| Segmentation determinism (same input → same output) | exact |
| Every sealed session has explainable boundaries | 100% |
| Entity resolution precision | ≥ 0.98 |
| Entity resolution recall | ≥ 0.90 |
| Identities silently guessed (should have asked) | 0 |
| Mention linking accuracy (roster cases) | ≥ 0.92 |
| Edge precision (structural relations) | ≥ 0.90 |
| Metadata edges (groups, attendees) captured | 100% |
| Enrichment routed to correct executor | 100% |
| User corrections surviving full re-derivation | 100% |

**Gate 2 (before Phase 2 starts):** add **Calendar + Contacts** adapters. Contacts phones/emails must merge with WhatsApp identities at precision ≥ 0.98 via the `[CODE]` rung alone. This proves cross-source identity — the load-bearing claim of the whole design.

---

## 15. Build order — Phase 1

```
 P1-B0  EVAL HARNESS + gold set wiring ..................... [code+human]
 P1-B1  DELETE store.ts · brain/writers.ts · migr 0004-06 ... [code]
        + leak fixes (wa: prefix, whatsapp.* keys, routes)
 P1-B2  ADAPTER REGISTRY + manifests + stream_id migration .. [code]
 P1-B3  CLI BARE-CALL CONTRACT (replace-system-prompt, ...... [code]
        deny-all default, schema validation, repair-retry)
 P1-B4  EMBEDDER CALIBRATION (floor, per-use-case) .......... [code+ML]
 P1-B5  ENTITY GRAPH (tables, structural binding, me, ....... [code]
        metadata edges, tombstones, negative pairs)
 P1-B6  SESSIONS (5 segmenters, debounce, seal, hash, ....... [code]
        reactions/edits rules, restarts, late arrivals)
 P1-B7  ENTITY PASS P-EP1 + resolution ladder + P-AG1 ....... [LLM-S/agent]
 P1-B8  SALIENCE SCAFFOLD (schema + stage; ambient off) ..... [code+ML]
 P1-B9  SURFACES ×2 + gestures + APIs + runs/quarantine UI .. [code]
 ─────────────────────────────────────────────────────────────────────
 GATE 1: WhatsApp corpus passes §14 table.
 GATE 2: Calendar + Contacts added; cross-source identity proven.
         → Phase 2 (episodes, arcs) begins.
```

---

## 16. The paragraph to remember

A session is one burst of one stream, cut by rules you can read. An entity is one real thing with one minted id, however many sources point at it. A relation is an edge with a quote behind it. Code does everything deterministic, whisper and e5 do the cheap perception, a small LLM reads what needs reading with no tools and no personality, and an agent with three read-only turns settles what similarity cannot — and anything still unclear becomes a question, never a guess.
