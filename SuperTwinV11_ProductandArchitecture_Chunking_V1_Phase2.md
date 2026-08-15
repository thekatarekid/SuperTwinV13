# SuperTwinV11 — Chunking Phase 2: Episodes & Arcs
**V1 · Phase 2 of 2 · built in the V11 repo · requires Phase 1 gates passed**

**Prerequisites (from Phase 1):** sealed immutable sessions with content hashes · resolved entity graph with relations · roster injection · CLI bare-call contract · embedder calibration · eval harness.
**Scope:** sessions → **episodes** (topical) → **arcs** (cross-time, cross-source) → **2 surfaces** (Episodes, Arcs).
**Out of scope:** claims, spaces, tasks, loops, agents-that-act.

> **Why arcs are the point.** A single-source twin is a search box. The product appears when a WhatsApp thread, a calendar block, a browser visit and an order confirmation are recognised as **one thread of the user's life**. Episodes make sessions topical; arcs make topics cross-source. This phase ends when that works and can be inspected.

---

## 1. Thesis

1. **Default: session = episode.** Most sessions are about one thing. The common case costs zero extra model calls.
2. **Episodes are stream-scoped.** Topic matching happens inside one stream only — candidate sets stay at 5–10 real items, and the model picks from a tiny real list instead of minting from a catalogue.
3. **Arcs are the only cross-source layer**, and they bind by **exact joins first** (bridges), entity overlap second, calibrated similarity third, judgment last.
4. **Every model boundary decision is persisted as a verdict** and replay reuses it. A chunker whose boundaries change on re-run is undebuggable.
5. **Everything ages.** Episodes fade, arcs go dormant then archive. Nothing accumulates monotonically.
6. **User corrections are sticky.** Re-derivation must never overwrite an `actor: user` mutation.

---

## 2. Definitions

```
 SESSION   one burst of one stream            (Phase 1, mechanical, immutable)
 EPISODE   one topic, one stream              1..N sessions · may span days
 ARC       one thread of life, cross-source   1..N episodes · may span months

   sessions ──1:1 default──► episodes ──cluster──► arcs
              split/attach              bridges/overlap/similarity
```

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │ ARC "Goa trip, Sep"                                                 │
 ├─────────────────────────────────────────────────────────────────────┤
 │  WhatsApp  ep "villa shortlist"      ─┐                             │
 │  WhatsApp  ep "who pays deposit"     ─┤   bound by                  │
 │  Browser   ep "booking.com session"  ─┼─  ① url bridge              │
 │  Gmail     ep "booking confirmation" ─┤   ② attendee_set bridge     │
 │  Calendar  ep "12–15 Sep block"      ─┤   ③ entity overlap          │
 │  Commerce  ep "MMT flight order"     ─┘   ④ topic similarity        │
 └─────────────────────────────────────────────────────────────────────┘
```

---

## 3. What changes on V11+Phase 1

### 3.1 Build

| # | Component | Executor |
|---|---|---|
| P2-B0 | Phase-2 gold set wiring (GoldenEvals categories J, K) | code + human |
| P2-B1 | Episode engine: default 1:1, split, attach, verdicts, aging | code + ML + LLM-M |
| P2-B2 | Episode embeddings + calibrated attach gate | code + ML |
| P2-B3 | Bridge extractor + `bridges` table | code |
| P2-B4 | Arc engine: binding ladder, `arc_key`, two-phase reconcile, aging | code + ML + LLM-M |
| P2-B5 | Nightly reconcile job (re-derive, compact, age) | code |
| P2-B6 | Surfaces: Episodes, Arcs + gestures + APIs | code |

### 3.2 No deletions

Phase 1 already removed everything conflicting. Phase 2 is purely additive.

---

## 4. System architecture — Phase 2 delta

```
        (Phase 1 layers L0–L3 unchanged: adapters → events → prefilter
         → enrich → entity graph → sessions)
                                   │  sealed sessions + roster
                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L4  EPISODES — topical, stream-scoped                                        │
│                                                                              │
│   sealed session ──► hash gate [CODE] ──► pre-flag topic shift [ML]          │
│                          │                                                   │
│                          ▼                                                   │
│        P-EP2 episode pass [LLM-M]  — only when needed:                       │
│          CASE A  1 session → N topic segments (split)                        │
│          CASE B  session → attach to OPEN episode in SAME stream             │
│          default: 1:1, NO CALL                                               │
│        verdict persisted → replay never re-judges                            │
│        aging: quiet 14d → outcome=faded, arc_state=closed  [CODE]            │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L5  ARCS — cross-time, cross-source                                          │
│                                                                              │
│   ① BRIDGES        exact joins                     [CODE]   precision ~1.0   │
│      url · order_id · file_id · attendee_set · phone/email ·                 │
│      media_work_id · geo_time                                                │
│   ② ENTITY OVERLAP weighted Jaccard on entity sets [CODE]                    │
│   ③ TOPIC SIM      calibrated cosine, higher bar   [ML]                      │
│   ④ ADJUDICATE     P-AG2, ties + cross-source only [LLM-M] → else ASK USER   │
│                                                                              │
│   two-phase commit: provisional → batched reconcile → arc_key rebind         │
│   aging: live → dormant (quiet 3w) → archived (quiet 12w)     [CODE]         │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ L7  SURFACES: EPISODES · ARCS                                   [CODE]       │
│     every split/attach/bind → "why?" → persisted verdict + signals           │
└──────────────────────────────────────────────────────────────────────────────┘
```

Executor legend as Phase 1: `[CODE]` deterministic · `[ML]` on-device (e5, calibrated) · `[LLM-M]` Sonnet-class via CLI bare call · `[AGENT]` LLM-M + tools, bounded.

---

## 5. Data model — Phase 2 DDL

```sql
episodes           (id PK, stream_id FK, source_id,
                    topic_label, label_source,          -- model | user
                    session_ids JSON, event_ids JSON,
                    entity_ids JSON,                    -- from Phase-1 mentions
                    arc_state,                          -- open | closed
                    outcome NULL,                       -- concluded | faded
                    started_at, ended_at, created_at, updated_at)

episode_sessions   (episode_id FK, session_id FK, added_by, verdict_id NULL,
                    PRIMARY KEY(episode_id, session_id))

episode_verdicts   (id PK, episode_id NULL, session_id FK, run_id,
                    decision,                           -- one_to_one | split | attach | new
                    candidates_json,                    -- what the model saw
                    output_json,                        -- what it decided
                    model, created_at)
                    -- replay reuses this row; it never re-judges

episode_embeddings (episode_id PK, vec BLOB, model, dim)

bridges            (id PK, kind, value_norm,
                    left_kind, left_id, right_kind, right_id,
                    confidence, decided_by, created_at,
                    UNIQUE(kind, value_norm, left_id, right_id))
                    -- kind: url | order_id | file_id | attendee_set | phone
                    --     | email | media_work_id | geo_time
                    -- left/right kind: event | session | episode

arcs               (id PK, arc_key UNIQUE, label, label_source,
                    anchor_entity_ids JSON, source_ids JSON,
                    state,                              -- live | dormant | archived (DERIVED)
                    started_at, last_evidence_at,
                    user_pinned, user_label NULL, created_at, updated_at)

arc_episodes       (arc_id FK, episode_id FK, added_by,
                    signal,                             -- bridge | overlap | similarity | adjudicated | user
                    signal_detail_json,                 -- which bridge / scores
                    PRIMARY KEY(arc_id, episode_id))

arc_verdicts       (id PK, arc_id NULL, episode_id, run_id,
                    decision, candidates_json, output_json, model, created_at)

provisional_arcs   (id PK, batch_id, arc_key_candidate, episode_ids JSON,
                    created_at)                          -- die at reconcile
```

**Invariants:**

1. `episodes.arc_state`, `arcs.state` are **written by code only** (aging rules + membership). No model declares lifecycle.
2. Every attach/split/bind row points at its verdict (`verdict_id` / `signal_detail_json`). "Why?" is always answerable from the DB alone.
3. `arc_key = sha1(sorted(top-3 anchor_entity_ids) | normalize(label_stem))` — re-derivation rebinds to the same key → same id → user corrections survive.
4. An episode belongs to **exactly one arc** (or none). An event belongs to exactly one session; a session to exactly one episode after splitting (split segments partition the session's events).
5. User mutations (`detach`, `split`, `move`, `pin`, labels) are terminal for automation: the nightly reconcile reads them as constraints, never as suggestions.

---

## 6. Episodes — full specification

### 6.1 The flow per sealed session

```
 sealed session S (from Phase 1)
   │
   ├─ hash gate: S.content_hash already has a verdict? ─► reuse, done   [CODE]
   │
   ├─ PRE-FLAG                                                          [ML]
   │    intra-session embedding drift across event windows
   │    drift < low bar  AND  no open episodes in stream
   │        └─► DEFAULT: episode := session (1:1). NO MODEL CALL.       [CODE]
   │
   └─ else: P-EP2 call (§8.1)                                           [LLM-M]
        input : S + open episodes of the SAME stream (≤10, with labels,
                summaries, entity sets)
        output: segments[] — each mapped to
                  attach(episode_id)  |  new(topic_label)
        verdict persisted to episode_verdicts
```

1. **Split (CASE A):** one session, two topics — "dinner plans" pivots to "your surgery". The model returns 1–N segments **partitioning the session's events**; each segment attaches or news independently.
2. **Attach (CASE B):** Monday's session and Wednesday's session about the same villa → same episode. Only against **open** episodes **in the same stream**.
3. **Cross-stream never happens here.** That is an arc.
4. **Batching:** sealed sessions are collected ~30 min and sent N-per-call, each session a separate item in the prompt — batch for cost, never blend semantics.

### 6.2 Lifecycle

```
 open ──(explicit conclusion detected in a later session? no — Phase 2 has no
          conclusion detection; that is a claims-layer concern)──
 open ──14 days without a new session──► arc_state=closed, outcome=faded [CODE]
 closed episodes never re-open; a topic returning later = NEW episode,
 bound to the same arc by the arc ladder.
```

### 6.3 Episode embedding

1. Computed at creation and updated on attach: embed `topic_label + last 2 session summaries + top entity names`.
2. All comparisons use **calibrated** scores (Phase 1 §6.8) with the `episode_topic` use-case thresholds.

---

## 7. Arcs — full specification

### 7.1 Bridge extraction — `[CODE]`, runs at ingest/enrich time

| Bridge kind | Fires when | Normalisation |
|---|---|---|
| `url` | same canonical URL in two places (chat link ↔ browser visit ↔ bookmark) | strip tracking params, resolve shortlinks, lowercase host |
| `order_id` | order/booking/PNR ref in two places (Gmail receipt ↔ commerce ↔ chat) | vendor-prefixed exact string |
| `file_id` | same Drive/Docs file (doc share ↔ file_change ↔ visit) | provider file id |
| `attendee_set` | calendar attendees ⊇/≈ chat participants (Jaccard ≥ 0.6 on entity ids) | sorted entity-id set |
| `phone` / `email` | same identity entity referenced | Phase-1 normalised value |
| `media_work_id` | same media_work entity (YouTube watch ↔ chat recommendation ↔ Netflix play) | entity id |
| `geo_time` | two location-stamped events within 200m ∧ 45min (Uber drop ↔ restaurant order ↔ photo) | geohash6 + time bucket |

1. Bridges are **facts, not judgments** — extracted by code the moment both sides exist, stored bidirectionally, never expire.
2. Bridges connect events/sessions/episodes across **any** source pair. They are the cheapest, highest-precision cross-source mechanism and always run before similarity.

### 7.2 The binding ladder — new/updated episode E seeking an arc

```
 ① BRIDGES                                              [CODE]
    any bridge from E's events to an episode already in arc A?
        └─ yes → JOIN A   (signal=bridge, detail=which bridge)
 ② ENTITY OVERLAP                                       [CODE]
    weighted Jaccard(E.entity_ids, A.anchor_entity_ids)
    weights: person/place/occasion 1.0 · product/service/media 0.7 ·
             topic 0.4  (people anchor arcs; topics drift)
        └─ ≥ 0.5 → JOIN A   (signal=overlap, detail=score)
 ③ TOPIC SIMILARITY                                     [ML]
    calibrated cosine(E.vec, A.centroid) — use-case arc_topic,
    bar HIGHER than episode attach (different sources, different registers:
    a calendar title, a chat and an order line describe one trip in three
    vocabularies — cosine is a tie-breaker here, never the main signal)
        └─ ≥ bar → CANDIDATE, go to ④
 ④ ADJUDICATION  P-AG2 (§8.2)                           [LLM-M]
        same → JOIN  ·  different → NEW ARC  ·  unsure → ASK USER
        (an unsure never silently creates a duplicate)

 SPECIAL RULES
 - ambient episodes may join ONLY via ① or ② — never similarity alone,
   or the noisiest source dominates every arc.
 - single-episode arcs are held provisional until reconcile (§7.3).
```

### 7.3 Two-phase commit + nightly reconcile — `[CODE]`

```
 continuous:  new arcs are PROVISIONAL (no surface, no stable id)
 nightly:     ① compare provisional ↔ provisional and ↔ committed
                 (same ladder; duplicates merge at the moment they
                  are comparable — a sequential pass can never see this)
              ② compute arc_key for survivors → rebind or mint id
              ③ apply aging:  quiet 3w → dormant · quiet 12w → archived
              ④ re-check user constraints: pinned/moved/split rows are
                 hard walls; reconcile plans around them
              ⑤ compact merged-entity redirects into arc anchor sets
              ⑥ every change → mutations rows (undoable as one run)
```

### 7.4 Labels

1. Episode label: from P-EP2 output (`topic_label`), ≤6 words, plain language.
2. Arc label: P-LB1 (§8.3) at arc creation and on major growth (new source joins); `user_label` always wins and is never overwritten.

---

## 8. Prompts and call specifications

All calls use the Phase-1 CLI bare-call contract: our system prompt replaces the CLI's, zero tools unless listed, thinking off, schema-validated JSON, 1 repair retry → quarantine.

### 8.1 P-EP2 — Episode pass — `[LLM-M]`, bare

**SYSTEM:**
```
You segment conversation sessions into topical episodes for a private
personal-memory system.

You receive 1..N sealed SESSIONS (each from one chat/stream) and, per
session, the OPEN EPISODES of that same stream.

FOR EACH SESSION decide:
1. Is it one topic or several? Split into segments only when the topic
   genuinely changes ("dinner plans" → "her surgery"). Small asides do not
   split; a segment needs ≥2 events or ≥1 substantial event.
2. For each segment: does it continue one of the OPEN episodes listed for
   that stream, or start a new one?
   - attach when it is the same ongoing matter (same plan, same purchase,
     same trip, same issue), even days later.
   - new when the matter is different, even if entities overlap.

RULES
- Segments must partition the session's events. Every event id appears in
  exactly one segment.
- Only attach to episodes listed for THAT session's stream. Never invent
  episode ids.
- topic_label: ≤6 plain words, concrete ("villa shortlist for Goa", not
  "travel discussion").
- Confidence < 0.6 on an attach → prefer new; the nightly reconcile can
  merge later. A wrong merge destroys; a wrong split is repairable.
- Output ONLY JSON matching the schema.

SCHEMA
{"sessions":[{"session_id":"...",
  "segments":[{"event_ids":["..."],
    "action":"attach|new",
    "episode_id":"epi_...|null",
    "topic_label":"...",
    "confidence":0.0,
    "reason":"one sentence"}]}]}
```

**USER (template):**
```
--- session {{session_id}} · stream {{stream_label}} · {{date}} ---
OPEN EPISODES in this stream:
  {{per episode: id · topic_label · last-activity date · 1-line summary ·
    top entities}}
EVENTS:
  {{numbered: [event_id] [speaker] text (media captions/transcripts inline)}}
--- end ---
{{…next session…}}
```

**EXAMPLE (held in prompt):**
```
Open episode: epi_91 "villa shortlist for Goa" (last: Mon) — Villa Amara,
              Rohan, budgets
Session (Wed): [ev_1] [Rohan] "Amara confirmed 4 rooms, need deposit by 20th"
               [ev_2] [me] "ok" 
               [ev_3] [Rohan] "also — did your mom's reports come?"
               [ev_4] [me] "yes, all clear"
Output segments:
 [{event_ids:["ev_1","ev_2"],action:"attach",episode_id:"epi_91",
   topic_label:"villa shortlist for Goa",confidence:0.93,
   reason:"continues the Amara booking"},
  {event_ids:["ev_3","ev_4"],action:"new",episode_id:null,
   topic_label:"mom's medical reports",confidence:0.85,
   reason:"distinct topic, no open episode matches"}]
```

**Settings:** `[LLM-M]` · max out 4k tok · thinking off · tools none · ≤6 sessions or 8k input tok per call · verdict row per session.

### 8.2 P-AG2 — Arc adjudicator — `[LLM-M]`, bare (single call, no tools)

**SYSTEM:**
```
You decide whether an episode belongs to an existing arc (a cross-source
thread of one person's life) in a private personal-memory system.

You receive ONE episode and 1..3 candidate arcs with the mechanical evidence
already computed (bridges, entity overlap, similarity).

RULES
- Bridges (shared url / order id / file / attendee set) are near-proof.
- Same people + same concrete matter (same trip, same purchase, same event,
  same issue) → same arc. Same people alone is NOT enough — friends discuss
  many things.
- Different concrete matters stay separate even with identical participants.
- If the evidence genuinely underdetermines it, answer "unsure". Never force.
- Output ONLY JSON.

SCHEMA
{"decision":"join|new|unsure","arc_id":"arc_...|null","confidence":0.0,
 "reason":"one sentence citing the decisive evidence"}
```

**USER (template):**
```
EPISODE: {{id · stream · source · topic_label · date range · entities ·
          2-line summary}}
CANDIDATE ARCS:
  {{per arc: id · label · sources · anchor entities · last evidence date ·
    bridges to this episode (if any) · overlap score · calibrated sim}}
```

**Settings:** `[LLM-M]` · 1 turn · max out 500 tok · thinking off · tools none · `unsure` → user question in the Arcs surface, never auto-retried.

### 8.3 P-LB1 — Arc labeler — `[LLM-S]`, bare

**SYSTEM:**
```
Name this thread of a person's life. ≤6 plain words, concrete, no dates
unless essential. Prefer the user's own vocabulary from the quotes.
Output ONLY {"label":"..."}.
```

**USER:** `{{episode labels · anchor entities · 3 representative quotes}}`

**Settings:** `[LLM-S]` · 1 turn · 100 tok out.

### 8.4 Call settings summary

| Call | Tier | Tools | Turns | Output | Trigger | On fail |
|---|---|---|---|---|---|---|
| P-EP2 episode pass | LLM-M | none | 1 | segments JSON | sealed session w/ drift or open episodes | repair ×1 → quarantine session |
| P-AG2 arc adjudicator | LLM-M | none | 1 | verdict JSON | ladder step ④ only | repair ×1 → unsure → ask user |
| P-LB1 labeler | LLM-S | none | 1 | label JSON | arc create/growth | keep previous label |

**Steady-state budget, WhatsApp-only quiet day:** 0–3 calls (hash gate + 1:1 default absorb the rest). Bridges, overlap, aging, reconcile: all `[CODE]`, free.

---

## 9. The two surfaces

### 9.1 Episodes

```
┌────────────────────────────────────────────────────────────────────────┐
│ EPISODES  [open 22][closed·concluded 61][closed·faded 31]  stream [▾]  │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ "villa shortlist for Goa"        open · WhatsApp/Pranjali · 3 sess   │
│    ├ Mon 09:12  seed (1:1 default, no call)                            │
│    ├ Wed 20:40  ATTACHED  conf 0.93  "continues the Amara booking"     │
│    └ Fri 08:15  ATTACHED  conf 0.88                                    │
│    entities: Rohan · Villa Amara · Goa · Pranjali                      │
│    arc: "Goa trip, Sep" ──▶                                            │
│    [ why? ] [ detach session ] [ split ] [ relabel ] [ close ]         │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ "mom's medical reports"          open · WhatsApp/Rohan · 1 sess      │
│    SPLIT from session Wed 20:40 (2 topics)  [ why? ] [ merge back ]    │
├────────────────────────────────────────────────────────────────────────┤
│ ⏳ faded (14d quiet): "muesli speech-to-text idea"  [ reopen? ]         │
└────────────────────────────────────────────────────────────────────────┘
```

1. `[ why? ]` renders the persisted `episode_verdicts` row: the exact candidates the model saw and its stated reason.
2. Splits show their sibling; attaches show score + reason per session.
3. Gestures: `detach` `split` `merge back` `relabel` `close` — sticky user mutations.

### 9.2 Arcs

```
┌────────────────────────────────────────────────────────────────────────┐
│ ARCS  [live 18][dormant 24][archived 61]        🔍         + pin       │
├────────────────────────────────────────────────────────────────────────┤
│ ▸ Goa trip, Sep                       live · 5 sources · 12 episodes   │
│                                                                        │
│   Jun ───●────●─────────●────●────●───────● Sep                        │
│          wa   wa        web  gmail cal    mmt                          │
│                                                                        │
│   BOUND BY (precedence order)                                          │
│    ① url        booking.com/villa-amara     web ↔ wa       exact       │
│    ① attendees  {me,Rohan,Ana,Kabir}        cal ↔ wa       J=0.75      │
│    ② overlap    0.71                        wa ↔ wa                    │
│    ④ adjudicated "same trip, same villa"    mmt ep         conf 0.9    │
│                                                                        │
│   anchors: Rohan · Ana · Villa Amara · Goa                             │
│   [ why together? ] [ remove episode ] [ split arc ] [ merge ] [ pin ] │
├────────────────────────────────────────────────────────────────────────┤
│ ❓ NEEDS YOU (adjudicator unsure)                                       │
│   "flight price alerts" episode → arc "Goa trip, Sep"?                 │
│   [ yes, same trip ] [ no, separate ] [ later ]                        │
└────────────────────────────────────────────────────────────────────────┘
```

1. **The source-contribution timeline is the core visual** — the one screen that makes cross-source value visible.
2. Every membership row shows its **signal in precedence order** with the measured value.
3. The unsure queue lives here: adjudicator ties become one-tap questions.
4. Gestures: `remove episode` `split arc` `merge arcs` `pin` `relabel` — all terminal for automation; reconcile plans around them.

### 9.3 API routes (Phase 2)

```
GET  /api/episodes?stream=&state=          GET  /api/episodes/:id
GET  /api/episodes/:id/verdict             POST /api/episodes/:id/{detach|split|merge|relabel|close}
GET  /api/arcs?state=                      GET  /api/arcs/:id
GET  /api/arcs/:id/timeline                GET  /api/arcs/:id/signals
POST /api/arcs/:id/{remove-episode|split|merge|pin|relabel}
GET  /api/arc-questions                    POST /api/arc-questions/:id/answer
POST /api/reconcile/run                    GET  /api/reconcile/last
```

---

## 10. Step-by-step — sealed session to arc

```
 STEP  WHAT                                               EXECUTOR
 ════  ══════════════════════════════════════════════     ══════════════
  1    HASH GATE  session hash already judged? reuse      [CODE]
  2    PRE-FLAG   intra-session embedding drift           [ML]
  3    DEFAULT    no drift, no open episodes → 1:1        [CODE]  (no call)
  4    P-EP2      split / attach / new + verdict          [LLM-M]
  5    EMBED      episode vector create/update            [ML]
  6    BRIDGES    exact joins recomputed for new events   [CODE]
  7    LADDER ①   bridge to an arc? join                  [CODE]
  8    LADDER ②   weighted entity overlap ≥ 0.5? join     [CODE]
  9    LADDER ③   calibrated topic sim ≥ arc bar?         [ML]
 10    LADDER ④   P-AG2 adjudicate → join/new/unsure      [LLM-M]
        unsure → question in Arcs surface (never guess)
 11    PROVISIONAL new arcs held, no surface              [CODE]
 12    NIGHTLY RECONCILE  dedupe provisionals, arc_key    [CODE]
        rebind, aging (faded/dormant/archived),
        honor user constraints, mutations logged
 13    LABEL     P-LB1 on create/growth                   [LLM-S]
 14    SURFACE   Episodes · Arcs · unsure queue           [CODE]
 15    CORRECT   gestures → mutations(actor:user), sticky [CODE]
```

---

## 11. Eval gates — Phase 2

Gold set: `SuperTwinV11_GoldenEvals_V1.md` categories J (episodes), K (arcs). CI-gated:

| Metric | Gate |
|---|---|
| 1:1 default rate (sessions needing no call) | ≥ 60% |
| Episode split accuracy (multi-topic sessions) | ≥ 0.85 |
| Episode attach accuracy (same-topic resumption) | ≥ 0.85 |
| Wrong-attach rate (different topics merged) | ≤ 2% |
| Verdict replay determinism (re-run = same episodes) | exact |
| Arc recall on bridge-joinable pairs | ≥ 0.95 (a miss is a code bug) |
| Arc precision (unrelated episode in an arc) | ≥ 0.90 |
| Ambient episodes joined via similarity alone | 0 |
| Adjudicator unsure → question raised (not silent dup) | 100% |
| Arc-id stability across full re-derivation | 100% |
| User corrections surviving reconcile | 100% |
| **Cross-source: WhatsApp ↔ Calendar same-trip arc via bridge** | **exists, precision 1.0** |

**The last row proves the thesis.** If a calendar block and the WhatsApp thread about the same trip do not land in one arc through the attendee/url bridge, cross-source has not been achieved — stop and fix before building anything above.

---

## 12. Build order — Phase 2

```
 P2-B0  GOLD SET wiring (categories J, K) .................. [code+human]
 P2-B1  EPISODE ENGINE  hash gate · pre-flag · 1:1 default ·  [code+ML]
        P-EP2 · verdicts · partition invariant · aging
 P2-B2  EPISODE EMBEDDINGS + calibrated attach thresholds ... [code+ML]
 P2-B3  BRIDGE EXTRACTOR  (7 kinds, at ingest/enrich) ....... [code]
 P2-B4  ARC ENGINE  ladder ①→④ · P-AG2 · provisional arcs ... [code+ML+LLM]
 P2-B5  NIGHTLY RECONCILE  dedupe · arc_key · aging · ....... [code]
        user-constraint walls · undoable as one run
 P2-B6  SURFACES ×2 + unsure queue + gestures + APIs ........ [code]
 ─────────────────────────────────────────────────────────────────────
 GATE: §11 table green on WhatsApp corpus, then green again with
       Calendar + Contacts (incl. the cross-source bridge row).
       → only then design claims / spaces / tasks on top.
```

---

## 13. The paragraph to remember

An episode is one topic in one stream; an arc is one thread of a life across every stream that recorded it. The common case costs nothing: a session becomes its episode without a model call, and an arc grows by a string join before anyone reasons about anything. Judgment is reserved for real ambiguity, every judgment is written down with what the model saw, and anything genuinely unclear becomes a one-tap question — so the graph the next layer builds on is one you can open, read, and correct.
