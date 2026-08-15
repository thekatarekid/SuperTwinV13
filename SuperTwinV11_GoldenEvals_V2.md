# SuperTwinV11 — Golden Evals V2

**1,000 eval cases** for the full pipeline: WhatsApp ingest → sessions → episodes → arcs → claims → loops → spaces → tasks. Supersedes Golden Evals V1, which predates claims, loops, spaces, tasks, party pairs, stream tiers and the STW-2 wire format.

## 1. How to use this document

1. Every row is one eval case with a stable **ID** (`<CAT>-<nnn>`).
2. Each row materialises to a fixture at `evals/fixtures/<ID>.json`.
3. The harness runs offline: fixtures freeze both the input events **and** the model verdicts, so no network call is needed to run the suite.
4. Rows marked `[CODE]` in the Assert column must match **exactly**. Model-judged rows are scored against the category gate.
5. The same fixtures run in two modes: **build** (CI, frozen verdicts) and **live** (against a real model, to re-measure the gates).

## 2. Fixture schema

```json
{
  "id": "M-014",
  "category": "M",
  "layer": "claims",
  "call": "P-CL1",
  "mode": "steady",
  "given": {
    "roster":  ["a1=Pranjali Sachdeva", "a3=ACT broadband [thg]"],
    "streams": [{"alias":"c1","name":"Pranjali","kind":"dm","participants":["self","a1"]}],
    "events":  [{"n":1,"ts":"2026-08-12T21:10+05:30","who":"a1",
                 "text":"i've started bhangra classes on saturdays"}],
    "open":    {"episodes": [], "loops": []},
    "db":      {"entities": [], "claims": [], "arcs": []}
  },
  "frozen_response": "H|1|a1|1p|0.95|-|Attends bhangra classes on Saturdays",
  "expect": {
    "claims": [{"kind":"habit","subject":"a1","attribution":"1p",
                "text":"Attends bhangra classes on Saturdays",
                "party_pair":"oo","evidence":[1]}],
    "loops": []
  },
  "assert": {"mode":"set_equal","on":["kind","subject","attribution","party_pair"],
             "gate":"claim_subject_accuracy"}
}
```

## 3. Assertion modes

| Mode | Meaning |
|---|---|
| `exact` | byte-identical output. Used for all `[CODE]` rows. |
| `set_equal` | the produced set equals the expected set on the listed fields; order-independent. |
| `contains` | every expected item is present; extras are allowed but counted against precision. |
| `absent` | the named item must NOT be produced. The main tool for precision gates. |
| `state` | a DB field holds the expected value after the run. |
| `no_throw` | the call completes without an exception, whatever the input. |
| `budget` | a measured value (latency, tokens, call count) is within bound. |

## 4. Coverage

| Cat | Name | N | Covers |
|---|---|---|---|
| A | INGEST | 30 | WhatsApp adapter, dedupe, watermarks, skew |
| B | TIERS | 50 | Stream tiers T1-T4, P-TI1, promotion re-scan |
| C | ENRICH | 40 | Executor routing, image batching, priority, slots |
| D | SESS-CONV | 75 | Conversation segmentation, both seal modes |
| E | SESS-OTHER | 40 | Document, activity, ambient, bounded streams |
| F | SESS-OPS | 40 | Reactions, edits, revokes, tz, restart, late arrival |
| G | IDENTITY | 70 | Binding, cross-source joins, merges, negative pairs |
| H | MENTIONS | 40 | Roster hits, typing, pronouns, hints, ambiguity |
| I | EDGES | 40 | 7 edge kinds, metadata edges, validity, discipline |
| J | EPISODES | 55 | 1:1 default, split, attach, aging, verdict replay |
| K | BRIDGES | 30 | 8 deterministic cross-source joins |
| L | ARCS | 45 | Binding ladder, adjudication, aging, id stability |
| M | CLAIMS | 95 | 8 kinds, attribution, third person, evidence |
| N | LOOPS | 75 | Intent+end-state test, temporal boundaries, dates |
| O | PARTY | 45 | 3 roles, 9 pairs, code derivation, not-your-space |
| P | PROMOTION | 50 | 4 routes, 8 archetypes, demotion |
| Q | TASKS | 30 | The view, explicit/implicit, done, teaching |
| R | WRITE | 40 | Reinforce, supersede, stated_at precedence, confluence |
| S | WIRE | 50 | STW-2 codec, tolerance, repair, A/B |
| T | SCHED | 30 | Latency gates, critical path, streaming, two-pass |
| U | ACCT | 15 | 4-way tokens, cost correctness, caching reality |
| V | CALIB | 15 | Embedder floor, normalisation, per-use-case |
| — | **Total** | **1000** | |

## 5. Cases

### A — INGEST (30)

_WhatsApp adapter, dedupe, watermarks, skew_

| ID | Given | Expect | Assert |
|---|---|---|---|
| A-001 | whatsmeow delivers msg external_id wa:0A twice (resync) | one events row; second insert is a no-op | UNIQUE(source_id,external_id) upsert |
| A-002 | whatsmeow delivers msg external_id wa:1A twice (resync) | one events row; second insert is a no-op | UNIQUE(source_id,external_id) upsert |
| A-003 | whatsmeow delivers msg external_id wa:2A twice (resync) | one events row; second insert is a no-op | UNIQUE(source_id,external_id) upsert |
| A-004 | whatsmeow delivers msg external_id wa:3A twice (resync) | one events row; second insert is a no-op | UNIQUE(source_id,external_id) upsert |
| A-005 | whatsmeow delivers msg external_id wa:4A twice (resync) | one events row; second insert is a no-op | UNIQUE(source_id,external_id) upsert |
| A-006 | whatsmeow delivers msg external_id wa:5A twice (resync) | one events row; second insert is a no-op | UNIQUE(source_id,external_id) upsert |
| A-007 | whatsmeow delivers msg external_id wa:6A twice (resync) | one events row; second insert is a no-op | UNIQUE(source_id,external_id) upsert |
| A-008 | whatsmeow delivers msg external_id wa:7A twice (resync) | one events row; second insert is a no-op | UNIQUE(source_id,external_id) upsert |
| A-009 | whatsmeow delivers msg external_id wa:8A twice (resync) | one events row; second insert is a no-op | UNIQUE(source_id,external_id) upsert |
| A-010 | whatsmeow delivers msg external_id wa:9A twice (resync) | one events row; second insert is a no-op | UNIQUE(source_id,external_id) upsert |
| A-011 | history page 1 requested with backfill_order=desc | adapter returns newest-first; watermarks.backfill_low_ts moves DOWN | ordering + watermark direction |
| A-012 | history page 2 requested with backfill_order=desc | adapter returns newest-first; watermarks.backfill_low_ts moves DOWN | ordering + watermark direction |
| A-013 | history page 3 requested with backfill_order=desc | adapter returns newest-first; watermarks.backfill_low_ts moves DOWN | ordering + watermark direction |
| A-014 | history page 4 requested with backfill_order=desc | adapter returns newest-first; watermarks.backfill_low_ts moves DOWN | ordering + watermark direction |
| A-015 | history page 5 requested with backfill_order=desc | adapter returns newest-first; watermarks.backfill_low_ts moves DOWN | ordering + watermark direction |
| A-016 | history page 6 requested with backfill_order=desc | adapter returns newest-first; watermarks.backfill_low_ts moves DOWN | ordering + watermark direction |
| A-017 | live msg arrives while backfill page 1 in flight | live_high_ts moves UP independently; no collision with backfill_low_ts | dual watermark isolation |
| A-018 | live msg arrives while backfill page 2 in flight | live_high_ts moves UP independently; no collision with backfill_low_ts | dual watermark isolation |
| A-019 | live msg arrives while backfill page 3 in flight | live_high_ts moves UP independently; no collision with backfill_low_ts | dual watermark isolation |
| A-020 | live msg arrives while backfill page 4 in flight | live_high_ts moves UP independently; no collision with backfill_low_ts | dual watermark isolation |
| A-021 | read receipt event from daemon | dropped at adapter, no events row | non-content filtering |
| A-022 | delivery ack event from daemon | dropped at adapter | non-content filtering |
| A-023 | typing indicator event from daemon | dropped at adapter | non-content filtering |
| A-024 | presence update event from daemon | dropped at adapter | non-content filtering |
| A-025 | msg with ts +12min vs now | clamp+flag if > now+5min, else accept | clock skew tolerance |
| A-026 | msg with ts +3min vs now | clamp+flag if > now+5min, else accept | clock skew tolerance |
| A-027 | msg with ts -2min vs now | clamp+flag if > now+5min, else accept | clock skew tolerance |
| A-028 | msg with ts +6h vs now | clamp+flag if > now+5min, else accept | clock skew tolerance |
| A-029 | msg with ts +1d vs now | clamp+flag if > now+5min, else accept | clock skew tolerance |
| A-030 | msg with ts +30s vs now | clamp+flag if > now+5min, else accept | clock skew tolerance |

### B — TIERS (50)

_Stream tiers T1-T4, P-TI1, promotion re-scan_

| ID | Given | Expect | Assert |
|---|---|---|---|
| B-001 | 1:1 DM with Pranjali, is_business=false | tier=T1 | tier assignment [CODE] |
| B-002 | 1:1 DM with Rahul, is_business=false | tier=T1 | tier assignment [CODE] |
| B-003 | 1:1 DM with Rashmi, is_business=false | tier=T1 | tier assignment [CODE] |
| B-004 | 1:1 DM with Sudhir, is_business=false | tier=T1 | tier assignment [CODE] |
| B-005 | 1:1 DM with Hrishikesh, is_business=false | tier=T1 | tier assignment [CODE] |
| B-006 | 1:1 DM with Gargi, is_business=false | tier=T1 | tier assignment [CODE] |
| B-007 | 1:1 DM with Keerti, is_business=false | tier=T1 | tier assignment [CODE] |
| B-008 | 1:1 DM with Prabhat, is_business=false | tier=T1 | tier assignment [CODE] |
| B-009 | 1:1 DM with Rajat, is_business=false | tier=T1 | tier assignment [CODE] |
| B-010 | 1:1 DM with Mansi, is_business=false | tier=T1 | tier assignment [CODE] |
| B-011 | group Ghar+, user has 3 messages in it | tier=T1 | engaged group -> T1 |
| B-012 | group Goa Crew, user has 3 messages in it | tier=T1 | engaged group -> T1 |
| B-013 | group Family, user has 3 messages in it | tier=T1 | engaged group -> T1 |
| B-014 | group Office Frandss, user has 3 messages in it | tier=T1 | engaged group -> T1 |
| B-015 | group Society, user has 3 messages in it | tier=T1 | engaged group -> T1 |
| B-016 | group Cousins, user has 3 messages in it | tier=T1 | engaged group -> T1 |
| B-017 | group Ghar+, user has 0 messages in it | tier=T3 | passive group -> T3 |
| B-018 | group Goa Crew, user has 0 messages in it | tier=T3 | passive group -> T3 |
| B-019 | group Family, user has 0 messages in it | tier=T3 | passive group -> T3 |
| B-020 | group Office Frandss, user has 0 messages in it | tier=T3 | passive group -> T3 |
| B-021 | group Society, user has 0 messages in it | tier=T3 | passive group -> T3 |
| B-022 | group Cousins, user has 0 messages in it | tier=T3 | passive group -> T3 |
| B-023 | HDFC Bank sample: order id + amount + due date, user-specific | tier=T2 | transactional heuristic [CODE] |
| B-024 | Zomato sample: order id + amount + due date, user-specific | tier=T2 | transactional heuristic [CODE] |
| B-025 | Policybazaar sample: order id + amount + due date, user-specific | tier=T2 | transactional heuristic [CODE] |
| B-026 | Amazon sample: order id + amount + due date, user-specific | tier=T2 | transactional heuristic [CODE] |
| B-027 | Jio sample: order id + amount + due date, user-specific | tier=T2 | transactional heuristic [CODE] |
| B-028 | HDFC Bank sample: '60% OFF', 'limited time', unsubscribe, no user id | tier=T4 | promotional heuristic [CODE] |
| B-029 | Zomato sample: '60% OFF', 'limited time', unsubscribe, no user id | tier=T4 | promotional heuristic [CODE] |
| B-030 | Policybazaar sample: '60% OFF', 'limited time', unsubscribe, no user id | tier=T4 | promotional heuristic [CODE] |
| B-031 | Amazon sample: '60% OFF', 'limited time', unsubscribe, no user id | tier=T4 | promotional heuristic [CODE] |
| B-032 | Jio sample: '60% OFF', 'limited time', unsubscribe, no user id | tier=T4 | promotional heuristic [CODE] |
| B-033 | HDFC Bank ambiguous sample -> P-TI1 | J/c1/pm/>=0.7/reason | P-TI1 verdict, cached on stream |
| B-034 | Zomato ambiguous sample -> P-TI1 | J/c2/tx/>=0.7/reason | P-TI1 verdict, cached on stream |
| B-035 | Policybazaar ambiguous sample -> P-TI1 | J/c3/pm/>=0.7/reason | P-TI1 verdict, cached on stream |
| B-036 | Amazon ambiguous sample -> P-TI1 | J/c4/tx/>=0.7/reason | P-TI1 verdict, cached on stream |
| B-037 | Jio ambiguous sample -> P-TI1 | J/c5/pm/>=0.7/reason | P-TI1 verdict, cached on stream |
| B-038 | business channel sends both offers and one delivery notice | tx (under-prioritising a real bill is the costlier error) | P-TI1 tie-break rule |
| B-039 | boot completes | 100% of streams have a non-null tier | tier backfill coverage assertion |
| B-040 | backfill: T2 cohort queued while T1 h24 still pending | T2 does NOT run; T1 exhausts first | tier is primary sort key |
| B-041 | backfill: T2 cohort queued while T1 h7d still pending | T2 does NOT run; T1 exhausts first | tier is primary sort key |
| B-042 | backfill: T2 cohort queued while T1 h30d still pending | T2 does NOT run; T1 exhausts first | tier is primary sort key |
| B-043 | backfill: T2 cohort queued while T1 holder still pending | T2 does NOT run; T1 exhausts first | tier is primary sort key |
| B-044 | live msg from a person during T1-older backfill | pre-empts at next cohort boundary | T1 live pre-emption |
| B-045 | live msg from bank (T2) during T1 backfill | pre-empts at next cohort boundary | T2 live pre-emption |
| B-046 | live promotional blast (T4) during T1 backfill | does NOT pre-empt; joins tier order | T3/T4 no pre-emption |
| B-047 | user replies in a T3 group for the first time | stream promotes T3->T1 AND its unprocessed events are re-enqueued at T1 priority | tier-change RE-SCAN |
| B-048 | after a T3->T1 promotion, count events with no disposition | 0 orphaned events | never orphan on promotion |
| B-049 | tier promotion occurs | destination watermark never moves backwards | watermark monotonicity |
| B-050 | T4 channel contains a real bill with a real due date | loop extracted in full, just later | tiering orders, never filters |

### C — ENRICH (40)

_Executor routing, image batching, priority, slots_

| ID | Given | Expect | Assert |
|---|---|---|---|
| C-001 | image #1 in a WhatsApp session | caption via [LLM-S] haiku through CLI, batched | executor routing: vision is LLM not ML |
| C-002 | image #2 in a WhatsApp session | caption via [LLM-S] haiku through CLI, batched | executor routing: vision is LLM not ML |
| C-003 | image #3 in a WhatsApp session | caption via [LLM-S] haiku through CLI, batched | executor routing: vision is LLM not ML |
| C-004 | image #4 in a WhatsApp session | caption via [LLM-S] haiku through CLI, batched | executor routing: vision is LLM not ML |
| C-005 | image #5 in a WhatsApp session | caption via [LLM-S] haiku through CLI, batched | executor routing: vision is LLM not ML |
| C-006 | image #6 in a WhatsApp session | caption via [LLM-S] haiku through CLI, batched | executor routing: vision is LLM not ML |
| C-007 | image #7 in a WhatsApp session | caption via [LLM-S] haiku through CLI, batched | executor routing: vision is LLM not ML |
| C-008 | image #8 in a WhatsApp session | caption via [LLM-S] haiku through CLI, batched | executor routing: vision is LLM not ML |
| C-009 | sticker | captioned by default | enrichment.read_all_media=on |
| C-010 | animated sticker | captioned by default | enrichment.read_all_media=on |
| C-011 | photo | captioned by default | enrichment.read_all_media=on |
| C-012 | screenshot | captioned by default | enrichment.read_all_media=on |
| C-013 | batch of 1 images submitted | one call; ids echoed and matched exactly | batch size 16 default, 1-32 |
| C-014 | batch of 8 images submitted | one call; ids echoed and matched exactly | batch size 16 default, 1-32 |
| C-015 | batch of 16 images submitted | one call; ids echoed and matched exactly | batch size 16 default, 1-32 |
| C-016 | batch of 17 images submitted | one call; ids echoed and matched exactly | batch size 16 default, 1-32 |
| C-017 | batch of 32 images submitted | one call; ids echoed and matched exactly | batch size 16 default, 1-32 |
| C-018 | model returns 15 captions for a 16-image batch | REJECT; split into 8+8 and retry | id-echo mismatch -> binary split |
| C-019 | model returns 16 captions but 2 ids differ | REJECT whole batch; never apply partially | no partial application |
| C-020 | split retry: 8+8 both pass | captions applied; 3 calls total, not 16 | binary degradation not solo-drop |
| C-021 | 10s voice note | whisper.cpp on-device [ML], no LLM | transcription is local ML |
| C-022 | 45s voice note | whisper.cpp on-device [ML], no LLM | transcription is local ML |
| C-023 | 2min voice note | whisper.cpp on-device [ML], no LLM | transcription is local ML |
| C-024 | 8min voice note | whisper.cpp on-device [ML], no LLM | transcription is local ML |
| C-025 | 20s video | [CODE] ffmpeg frames -> ONE [LLM-S] call for all frames | one call per video |
| C-026 | 60s video | [CODE] ffmpeg frames -> ONE [LLM-S] call for all frames | one call per video |
| C-027 | 3min video | [CODE] ffmpeg frames -> ONE [LLM-S] call for all frames | one call per video |
| C-028 | link to booking.com | [CODE] fetch/yt-dlp; no model | scraping is code |
| C-029 | link to youtube.com | [CODE] fetch/yt-dlp; no model | scraping is code |
| C-030 | link to amazon.in | [CODE] fetch/yt-dlp; no model | scraping is code |
| C-031 | link to a news site | [CODE] fetch/yt-dlp; no model | scraping is code |
| C-032 | image longest edge 3000px | downscaled to <=1092px before send | vision token control |
| C-033 | quiet day: 4 text msgs, no media | ZERO enrichment LLM calls | cost scales with media not time |
| C-034 | photo from 1h ago and photo from 2023 both queued | 1h-ago photo captioned first | media queue priority = cohort priority |
| C-035 | enrichment queue is FIFO | FAIL | FIFO media queue is a defect |
| C-036 | first-paint window, 2 images pending | Lane E holds ZERO LLM slots until first paint completes | slot reservation |
| C-037 | first-paint window, 3 images pending | Lane E holds ZERO LLM slots until first paint completes | slot reservation |
| C-038 | first-paint window, 4 images pending | Lane E holds ZERO LLM slots until first paint completes | slot reservation |
| C-039 | first-paint window, 5 images pending | Lane E holds ZERO LLM slots until first paint completes | slot reservation |
| C-040 | salience_gate default state | off — all enrichments trigger the completion pass | enrichment.salience_gate=off |

### D — SESS-CONV (75)

_Conversation segmentation, both seal modes_

| ID | Given | Expect | Assert |
|---|---|---|---|
| D-001 | 1:1 Pranjali: gap 5h59m, stream G=6h | NO cut | gap trigger — under G=6h |
| D-002 | 1:1 Pranjali: gap 6h01m, stream G=6h | CUT gap | gap trigger — over G=6h |
| D-003 | 1:1 Pranjali: gap 30m, stream G=6h | NO cut | gap trigger — well under |
| D-004 | 1:1 Pranjali: gap 2h, stream G=6h | NO cut | gap trigger — under |
| D-005 | 1:1 Pranjali: gap 7h, stream G=6h | CUT gap | gap trigger — over |
| D-006 | 1:1 Pranjali: gap 12h, stream G=6h | CUT gap | gap trigger — far over |
| D-007 | 1:1 Pranjali: gap 5h30m, stream G=6h | NO cut | gap trigger — under |
| D-008 | 1:1 Pranjali: gap 6h30m, stream G=6h | CUT gap | gap trigger — over |
| D-009 | 1:1 Rahul: gap 5h59m, stream G=6h | NO cut | gap trigger — under G=6h |
| D-010 | 1:1 Rahul: gap 6h01m, stream G=6h | CUT gap | gap trigger — over G=6h |
| D-011 | 1:1 Rahul: gap 30m, stream G=6h | NO cut | gap trigger — well under |
| D-012 | 1:1 Rahul: gap 2h, stream G=6h | NO cut | gap trigger — under |
| D-013 | 1:1 Rahul: gap 7h, stream G=6h | CUT gap | gap trigger — over |
| D-014 | 1:1 Rahul: gap 12h, stream G=6h | CUT gap | gap trigger — far over |
| D-015 | 1:1 Rahul: gap 5h30m, stream G=6h | NO cut | gap trigger — under |
| D-016 | 1:1 Rahul: gap 6h30m, stream G=6h | CUT gap | gap trigger — over |
| D-017 | 1:1 Rashmi: gap 5h59m, stream G=6h | NO cut | gap trigger — under G=6h |
| D-018 | 1:1 Rashmi: gap 6h01m, stream G=6h | CUT gap | gap trigger — over G=6h |
| D-019 | 1:1 Rashmi: gap 30m, stream G=6h | NO cut | gap trigger — well under |
| D-020 | 1:1 Rashmi: gap 2h, stream G=6h | NO cut | gap trigger — under |
| D-021 | 1:1 Rashmi: gap 7h, stream G=6h | CUT gap | gap trigger — over |
| D-022 | 1:1 Rashmi: gap 12h, stream G=6h | CUT gap | gap trigger — far over |
| D-023 | 1:1 Rashmi: gap 5h30m, stream G=6h | NO cut | gap trigger — under |
| D-024 | 1:1 Rashmi: gap 6h30m, stream G=6h | CUT gap | gap trigger — over |
| D-025 | group Ghar+: gap 3h50m, group override G=4h | NO cut | per-stream override governs |
| D-026 | group Ghar+: gap 4h10m, group override G=4h | CUT gap | per-stream override governs |
| D-027 | group Goa Crew: gap 3h50m, group override G=4h | NO cut | per-stream override governs |
| D-028 | group Goa Crew: gap 4h10m, group override G=4h | CUT gap | per-stream override governs |
| D-029 | group Family: gap 3h50m, group override G=4h | NO cut | per-stream override governs |
| D-030 | group Family: gap 4h10m, group override G=4h | CUT gap | per-stream override governs |
| D-031 | group Office Frandss: gap 3h50m, group override G=4h | NO cut | per-stream override governs |
| D-032 | group Office Frandss: gap 4h10m, group override G=4h | CUT gap | per-stream override governs |
| D-033 | msgs at 23:50 and 00:01 next day, tz Asia/Kolkata | CUT day_boundary | midnight in STREAM tz not UTC |
| D-034 | msgs at 23:51 and 00:02 next day, tz Asia/Kolkata | CUT day_boundary | midnight in STREAM tz not UTC |
| D-035 | msgs at 23:52 and 00:03 next day, tz Asia/Kolkata | CUT day_boundary | midnight in STREAM tz not UTC |
| D-036 | 41 continuous msgs, no gap > 10m | CUT at event 40 (size_cap) | event cap |
| D-037 | 55 continuous msgs, no gap > 10m | CUT at event 40 (size_cap) | event cap |
| D-038 | 80 continuous msgs, no gap > 10m | CUT at event 40 (size_cap) | event cap |
| D-039 | long pastes totalling 6200 tokens | CUT at 6000-token cap | token cap fires first |
| D-040 | long pastes totalling 9000 tokens | CUT at 6000-token cap | token cap fires first |
| D-041 | gap 90m (>= shift_min_gap 1h) then Pranjali silent-all-burst initiates new subject | CUT participant_shift | conjunction: gap AND flip |
| D-042 | gap 90m (>= shift_min_gap 1h) then Rahul silent-all-burst initiates new subject | CUT participant_shift | conjunction: gap AND flip |
| D-043 | gap 90m (>= shift_min_gap 1h) then Rashmi silent-all-burst initiates new subject | CUT participant_shift | conjunction: gap AND flip |
| D-044 | gap 90m (>= shift_min_gap 1h) then Sudhir silent-all-burst initiates new subject | CUT participant_shift | conjunction: gap AND flip |
| D-045 | gap 90m (>= shift_min_gap 1h) then Hrishikesh silent-all-burst initiates new subject | CUT participant_shift | conjunction: gap AND flip |
| D-046 | gap 90m (>= shift_min_gap 1h) then Gargi silent-all-burst initiates new subject | CUT participant_shift | conjunction: gap AND flip |
| D-047 | gap 20m (< shift_min_gap) then Pranjali initiates | NO cut | shift below min-gap never cuts |
| D-048 | gap 20m (< shift_min_gap) then Rahul initiates | NO cut | shift below min-gap never cuts |
| D-049 | gap 20m (< shift_min_gap) then Rashmi initiates | NO cut | shift below min-gap never cuts |
| D-050 | gap 20m (< shift_min_gap) then Sudhir initiates | NO cut | shift below min-gap never cuts |
| D-051 | reply quoting a msg 2 days old | NEW session (reply_break); old stays sealed | reply-chain break |
| D-052 | reply quoting a msg 3 days old | NEW session (reply_break); old stays sealed | reply-chain break |
| D-053 | reply quoting a msg 4 days old | NEW session (reply_break); old stays sealed | reply-chain break |
| D-054 | reply quoting a msg 5 days old | NEW session (reply_break); old stays sealed | reply-chain break |
| D-055 | debounce 20m of silence, debounce_ms=45m | NO seal | debounce expiry |
| D-056 | debounce 44m of silence, debounce_ms=45m | NO seal | debounce expiry |
| D-057 | debounce 46m of silence, debounce_ms=45m | SEAL | debounce expiry |
| D-058 | debounce 90m of silence, debounce_ms=45m | SEAL | debounce expiry |
| D-059 | slow trickle: 1 msg every 3h for 30h | SEAL at 24h ceiling | ceiling |
| D-060 | bootstrap: gap 7h known from the next stored row | SEAL IMMEDIATELY, seal_mode=immediate | bootstrap no-debounce |
| D-061 | bootstrap: newest session of a stream, no next row | stays OPEN, handed to steady rules | bootstrap open-tail exception |
| D-062 | steady: same gap | seal_mode=debounce | mode-dependent sealing |
| D-063 | backfill chunk 1 on 24-month history | same boundaries as live; ordered by ts not rowid | one segmenter, ts order |
| D-064 | backfill chunk 2 on 24-month history | same boundaries as live; ordered by ts not rowid | one segmenter, ts order |
| D-065 | backfill chunk 3 on 24-month history | same boundaries as live; ordered by ts not rowid | one segmenter, ts order |
| D-066 | self-chat notes, gap 10h | CUT ; participant_shift disabled | single-actor stream |
| D-067 | self-chat notes, gap 6h05m | CUT ; participant_shift disabled | single-actor stream |
| D-068 | self-chat notes, gap 20m | NO cut ; participant_shift disabled | single-actor stream |
| D-069 | burst of 4 photos only, 2m apart | ONE session; caption tokens counted in cap | media events are events |
| D-070 | burst of 5 photos only, 2m apart | ONE session; caption tokens counted in cap | media events are events |
| D-071 | burst of 6 photos only, 2m apart | ONE session; caption tokens counted in cap | media events are events |
| D-072 | burst of 7 photos only, 2m apart | ONE session; caption tokens counted in cap | media events are events |
| D-073 | HDFC Bank broadcast, 5 msgs over 3 days, no reply | cut by gap only; no participant_shift (single sender) | business stream segmentation |
| D-074 | Zomato broadcast, 5 msgs over 3 days, no reply | cut by gap only; no participant_shift (single sender) | business stream segmentation |
| D-075 | Policybazaar broadcast, 5 msgs over 3 days, no reply | cut by gap only; no participant_shift (single sender) | business stream segmentation |

### E — SESS-OTHER (40)

_Document, activity, ambient, bounded streams_

| ID | Given | Expect | Assert |
|---|---|---|---|
| E-001 | document stream: revision gap 20m, G=45m | NO cut | document sitting |
| E-002 | document stream: revision gap 40m, G=45m | NO cut | document sitting |
| E-003 | document stream: revision gap 50m, G=45m | CUT gap | document sitting |
| E-004 | document stream: revision gap 2h, G=45m | CUT gap | document sitting |
| E-005 | document: Pranjali edits 10m after my last revision | CUT author_shift | per-author sitting |
| E-006 | document: Rahul edits 10m after my last revision | CUT author_shift | per-author sitting |
| E-007 | document: Rashmi edits 10m after my last revision | CUT author_shift | per-author sitting |
| E-008 | document: 210 rapid revisions | CUT at 200-revision cap | revision cap |
| E-009 | document: 250 rapid revisions | CUT at 200-revision cap | revision cap |
| E-010 | document: 290 rapid revisions | CUT at 200-revision cap | revision cap |
| E-011 | activity/browser airbnb.com: gap 25m, G=30m | NO cut | activity burst |
| E-012 | activity/browser zomato.com: gap 25m, G=30m | NO cut | activity burst |
| E-013 | activity/browser airbnb.com: gap 35m, G=30m | CUT gap | activity burst |
| E-014 | activity/browser zomato.com: gap 35m, G=30m | CUT gap | activity burst |
| E-015 | activity: 12 visits on site A then first visit to site B 4m later | CUT context_shift (domain change) | context shift |
| E-016 | activity: 12 visits on site A then first visit to site B 4m later | CUT context_shift (domain change) | context shift |
| E-017 | activity: 12 visits on site A then first visit to site B 4m later | CUT context_shift (domain change) | context shift |
| E-018 | activity: 12 visits on site A then first visit to site B 4m later | CUT context_shift (domain change) | context shift |
| E-019 | Zomato order lands amid a 20-visit browsing burst | order seals as its OWN single-event session | transaction never merged |
| E-020 | Uber receipt lands amid a 20-visit browsing burst | order seals as its OWN single-event session | transaction never merged |
| E-021 | Swiggy order lands amid a 20-visit browsing burst | order seals as its OWN single-event session | transaction never merged |
| E-022 | ambient: 200 near-identical frames | phash collapse to 1 + duration | dedupe before anything |
| E-023 | ambient: 300 near-identical frames | phash collapse to 1 + duration | dedupe before anything |
| E-024 | ambient: 400 near-identical frames | phash collapse to 1 + duration | dedupe before anything |
| E-025 | ambient: silence 91s between speech | CUT context_shift | silence>90s |
| E-026 | ambient: silence 120s between speech | CUT context_shift | silence>90s |
| E-027 | ambient: silence 200s between speech | CUT context_shift | silence>90s |
| E-028 | ambient: single app focused 16min | CUT at 15-min ceiling | ambient ceiling |
| E-029 | ambient: single app focused 21min | CUT at 15-min ceiling | ambient ceiling |
| E-030 | ambient: single app focused 26min | CUT at 15-min ceiling | ambient ceiling |
| E-031 | ambient: 30m idle scroll below salience threshold | ONE coarse session, zero LLM | low-salience collapse |
| E-032 | ambient: 40m idle scroll below salience threshold | ONE coarse session, zero LLM | low-salience collapse |
| E-033 | ambient: 50m idle scroll below salience threshold | ONE coarse session, zero LLM | low-salience collapse |
| E-034 | calendar event 'Standup 10:00-10:15' | session = the record; boundary=record_bounded | bounded, no inference |
| E-035 | calendar event 'Dr Shreedhar 16:00-16:30' | session = the record; boundary=record_bounded | bounded, no inference |
| E-036 | calendar event 'Flight 14:05-15:20' | session = the record; boundary=record_bounded | bounded, no inference |
| E-037 | 30-min meeting transcript, 80 utterances | ONE session; caps do NOT apply | bounded exempt from caps |
| E-038 | 50-min meeting transcript, 120 utterances | ONE session; caps do NOT apply | bounded exempt from caps |
| E-039 | 70-min meeting transcript, 160 utterances | ONE session; caps do NOT apply | bounded exempt from caps |
| E-040 | ambient manifest registered with prefilter=none | REJECT at registration | ambient requires a prefilter |

### F — SESS-OPS (40)

_Reactions, edits, revokes, tz, restart, late arrival_

| ID | Given | Expect | Assert |
|---|---|---|---|
| F-001 | reaction arrives 3h after parent, parent session sealed | attach to parent's sealed session; NO new session; NO debounce reset | reactions are not conversation |
| F-002 | reaction arrives 4h after parent, parent session sealed | attach to parent's sealed session; NO new session; NO debounce reset | reactions are not conversation |
| F-003 | reaction arrives 5h after parent, parent session sealed | attach to parent's sealed session; NO new session; NO debounce reset | reactions are not conversation |
| F-004 | reaction arrives 6h after parent, parent session sealed | attach to parent's sealed session; NO new session; NO debounce reset | reactions are not conversation |
| F-005 | reaction arrives 7h after parent, parent session sealed | attach to parent's sealed session; NO new session; NO debounce reset | reactions are not conversation |
| F-006 | reaction arrives 8h after parent, parent session sealed | attach to parent's sealed session; NO new session; NO debounce reset | reactions are not conversation |
| F-007 | edit to a msg in an OPEN session | mutate in place; hash unaffected until seal | edit in open session |
| F-008 | edit to a msg in an OPEN session | mutate in place; hash unaffected until seal | edit in open session |
| F-009 | edit to a msg in an OPEN session | mutate in place; hash unaffected until seal | edit in open session |
| F-010 | edit to a msg in an OPEN session | mutate in place; hash unaffected until seal | edit in open session |
| F-011 | edit arrives AFTER seal | store; attach to parent; set superseded_hash; membership unchanged | edit after seal |
| F-012 | edit arrives AFTER seal | store; attach to parent; set superseded_hash; membership unchanged | edit after seal |
| F-013 | edit arrives AFTER seal | store; attach to parent; set superseded_hash; membership unchanged | edit after seal |
| F-014 | edit arrives AFTER seal | store; attach to parent; set superseded_hash; membership unchanged | edit after seal |
| F-015 | revoke for msg in open session | mark revoked; membership unchanged; superseded_hash if sealed | revoke |
| F-016 | revoke for msg in sealed session | mark revoked; membership unchanged; superseded_hash if sealed | revoke |
| F-017 | revoke for msg in sealed session | mark revoked; membership unchanged; superseded_hash if sealed | revoke |
| F-018 | msgs 23:50 and 00:10 in stream tz Asia/Kolkata | CUT day_boundary computed in stream tz | per-stream tz |
| F-019 | msgs 23:50 and 00:10 in stream tz America/New_York | CUT day_boundary computed in stream tz | per-stream tz |
| F-020 | msgs 23:50 and 00:10 in stream tz Europe/London | CUT day_boundary computed in stream tz | per-stream tz |
| F-021 | msgs 23:50 and 00:10 in stream tz Asia/Dubai | CUT day_boundary computed in stream tz | per-stream tz |
| F-022 | worker restart with 1 open sessions | timers recomputed from last event ts; overdue seal immediately | restart safety |
| F-023 | worker restart with 2 open sessions | timers recomputed from last event ts; overdue seal immediately | restart safety |
| F-024 | worker restart with 3 open sessions | timers recomputed from last event ts; overdue seal immediately | restart safety |
| F-025 | worker restart with 4 open sessions | timers recomputed from last event ts; overdue seal immediately | restart safety |
| F-026 | worker restart with 5 open sessions | timers recomputed from last event ts; overdue seal immediately | restart safety |
| F-027 | backfilled event ts falls inside an already-sealed session range | NEW session flagged late_arrival, overlap_of set; sealed session untouched | never reopen a sealed session |
| F-028 | backfilled event ts falls inside an already-sealed session range | NEW session flagged late_arrival, overlap_of set; sealed session untouched | never reopen a sealed session |
| F-029 | backfilled event ts falls inside an already-sealed session range | NEW session flagged late_arrival, overlap_of set; sealed session untouched | never reopen a sealed session |
| F-030 | backfilled event ts falls inside an already-sealed session range | NEW session flagged late_arrival, overlap_of set; sealed session untouched | never reopen a sealed session |
| F-031 | backfilled event ts falls inside an already-sealed session range | NEW session flagged late_arrival, overlap_of set; sealed session untouched | never reopen a sealed session |
| F-032 | in-flight cohort at stage enrich when app quits | resumes at last completed stage; verdicts reused, not re-judged | cohort resume |
| F-033 | in-flight cohort at stage entity when app quits | resumes at last completed stage; verdicts reused, not re-judged | cohort resume |
| F-034 | in-flight cohort at stage segment when app quits | resumes at last completed stage; verdicts reused, not re-judged | cohort resume |
| F-035 | in-flight cohort at stage episode when app quits | resumes at last completed stage; verdicts reused, not re-judged | cohort resume |
| F-036 | in-flight cohort at stage extract when app quits | resumes at last completed stage; verdicts reused, not re-judged | cohort resume |
| F-037 | same events re-segmented with identical params | byte-identical sessions | segmentation determinism |
| F-038 | same events re-segmented with identical params | byte-identical sessions | segmentation determinism |
| F-039 | same events re-segmented with identical params | byte-identical sessions | segmentation determinism |
| F-040 | same events re-segmented with identical params | byte-identical sessions | segmentation determinism |

### G — IDENTITY (70)

_Binding, cross-source joins, merges, negative pairs_

| ID | Given | Expect | Assert |
|---|---|---|---|
| G-001 | known jid of Pranjali appears in a new group | BIND to existing entity [CODE] | exact (source,kind,value) match |
| G-002 | known jid of Rahul appears in a new group | BIND to existing entity [CODE] | exact (source,kind,value) match |
| G-003 | known jid of Rashmi appears in a new group | BIND to existing entity [CODE] | exact (source,kind,value) match |
| G-004 | known jid of Sudhir appears in a new group | BIND to existing entity [CODE] | exact (source,kind,value) match |
| G-005 | known jid of Hrishikesh appears in a new group | BIND to existing entity [CODE] | exact (source,kind,value) match |
| G-006 | known jid of Gargi appears in a new group | BIND to existing entity [CODE] | exact (source,kind,value) match |
| G-007 | known jid of Keerti appears in a new group | BIND to existing entity [CODE] | exact (source,kind,value) match |
| G-008 | known jid of Prabhat appears in a new group | BIND to existing entity [CODE] | exact (source,kind,value) match |
| G-009 | Contacts phone +919800 == WhatsApp jid phone for Pranjali | BIND same entity [CODE] conf 1.0 | cross-source phone join |
| G-010 | Contacts phone +919801 == WhatsApp jid phone for Rahul | BIND same entity [CODE] conf 1.0 | cross-source phone join |
| G-011 | Contacts phone +919802 == WhatsApp jid phone for Rashmi | BIND same entity [CODE] conf 1.0 | cross-source phone join |
| G-012 | Contacts phone +919803 == WhatsApp jid phone for Sudhir | BIND same entity [CODE] conf 1.0 | cross-source phone join |
| G-013 | Contacts phone +919804 == WhatsApp jid phone for Hrishikesh | BIND same entity [CODE] conf 1.0 | cross-source phone join |
| G-014 | Contacts phone +919805 == WhatsApp jid phone for Gargi | BIND same entity [CODE] conf 1.0 | cross-source phone join |
| G-015 | gmail From pranjali@x == calendar attendee email | BIND same entity [CODE] | cross-source email join |
| G-016 | gmail From rahul@x == calendar attendee email | BIND same entity [CODE] | cross-source email join |
| G-017 | gmail From rashmi@x == calendar attendee email | BIND same entity [CODE] | cross-source email join |
| G-018 | gmail From sudhir@x == calendar attendee email | BIND same entity [CODE] | cross-source email join |
| G-019 | gmail From hrishikesh@x == calendar attendee email | BIND same entity [CODE] | cross-source email join |
| G-020 | gmail From gargi@x == calendar attendee email | BIND same entity [CODE] | cross-source email join |
| G-021 | 'Babbu' used consistently where Shaurya is counterparty | alias identity row on Shaurya, evidence quoted | alias not a new entity |
| G-022 | 'Didi' used consistently where Rashmi is counterparty | alias identity row on Rashmi, evidence quoted | alias not a new entity |
| G-023 | 'Hrishi' used consistently where Hrishikesh is counterparty | alias identity row on Hrishikesh, evidence quoted | alias not a new entity |
| G-024 | 'Praj' used consistently where Pranjali is counterparty | alias identity row on Pranjali, evidence quoted | alias not a new entity |
| G-025 | 'Bhav' used consistently where Bhavesh is counterparty | alias identity row on Bhavesh, evidence quoted | alias not a new entity |
| G-026 | 'Mumma' used consistently where Mummy is counterparty | alias identity row on Mummy, evidence quoted | alias not a new entity |
| G-027 | 'Pops' used consistently where Papa is counterparty | alias identity row on Papa, evidence quoted | alias not a new entity |
| G-028 | 'Shivi' used consistently where Shivangi is counterparty | alias identity row on Shivangi, evidence quoted | alias not a new entity |
| G-029 | 'Rahul Arora' vs 'Rahul Mehta': no shared phone/email/groups | DIFFERENT; store negative pair; never re-propose | name similarity must not merge |
| G-030 | 'Amit (gym)' vs 'Amit (office)': no shared phone/email/groups | DIFFERENT; store negative pair; never re-propose | name similarity must not merge |
| G-031 | 'Priya S' vs 'Priya D': no shared phone/email/groups | DIFFERENT; store negative pair; never re-propose | name similarity must not merge |
| G-032 | 'Dr Rao (dentist)' vs 'Dr Rao (Amma's)': no shared phone/email/groups | DIFFERENT; store negative pair; never re-propose | name similarity must not merge |
| G-033 | 'Ankit HDFC' vs 'Ankit college': no shared phone/email/groups | DIFFERENT; store negative pair; never re-propose | name similarity must not merge |
| G-034 | 'Vikram' vs 'Vikram (broker)': no shared phone/email/groups | DIFFERENT; store negative pair; never re-propose | name similarity must not merge |
| G-035 | 'Neha' vs 'Neha (Keerti's)': no shared phone/email/groups | DIFFERENT; store negative pair; never re-propose | name similarity must not merge |
| G-036 | 'Arjun' vs 'Arjun (Goa)': no shared phone/email/groups | DIFFERENT; store negative pair; never re-propose | name similarity must not merge |
| G-037 | 'Karan' vs 'Karan (X)': no shared phone/email/groups | DIFFERENT; store negative pair; never re-propose | name similarity must not merge |
| G-038 | 'Divya' vs 'Divya (yoga)': no shared phone/email/groups | DIFFERENT; store negative pair; never re-propose | name similarity must not merge |
| G-039 | 'Papa (new number Jio)' vs 'Papa'; old jid silent 1w; same group | -> P-AG1; expect same conf>=0.8; below bar -> resolution queue | agent adjudication |
| G-040 | 'Papa (new number Jio)' vs 'Papa'; old jid silent 2w; same group | -> P-AG1; expect same conf>=0.8; below bar -> resolution queue | agent adjudication |
| G-041 | 'Papa (new number Jio)' vs 'Papa'; old jid silent 3w; same group | -> P-AG1; expect same conf>=0.8; below bar -> resolution queue | agent adjudication |
| G-042 | 'Papa (new number Jio)' vs 'Papa'; old jid silent 4w; same group | -> P-AG1; expect same conf>=0.8; below bar -> resolution queue | agent adjudication |
| G-043 | 'Papa (new number Jio)' vs 'Papa'; old jid silent 5w; same group | -> P-AG1; expect same conf>=0.8; below bar -> resolution queue | agent adjudication |
| G-044 | 'Papa (new number Jio)' vs 'Papa'; old jid silent 6w; same group | -> P-AG1; expect same conf>=0.8; below bar -> resolution queue | agent adjudication |
| G-045 | pair with calibrated ML score 0.55, two plausible candidates | resolution queue question; NO bind | in-band ambiguity is a question |
| G-046 | pair with calibrated ML score 0.58, two plausible candidates | resolution queue question; NO bind | in-band ambiguity is a question |
| G-047 | pair with calibrated ML score 0.61, two plausible candidates | resolution queue question; NO bind | in-band ambiguity is a question |
| G-048 | pair with calibrated ML score 0.64, two plausible candidates | resolution queue question; NO bind | in-band ambiguity is a question |
| G-049 | pair with calibrated ML score 0.67, two plausible candidates | resolution queue question; NO bind | in-band ambiguity is a question |
| G-050 | pair with calibrated ML score 0.70, two plausible candidates | resolution queue question; NO bind | in-band ambiguity is a question |
| G-051 | user answered 'different' on pair #1; automation later scores 0.93 | NO merge; negative pair permanent | actor:user outranks automation |
| G-052 | user answered 'different' on pair #2; automation later scores 0.93 | NO merge; negative pair permanent | actor:user outranks automation |
| G-053 | user answered 'different' on pair #3; automation later scores 0.93 | NO merge; negative pair permanent | actor:user outranks automation |
| G-054 | user answered 'different' on pair #4; automation later scores 0.93 | NO merge; negative pair permanent | actor:user outranks automation |
| G-055 | read entity B after merge B->A with 1 refs | redirect via merged_into O(1); nightly compaction | tombstone merges |
| G-056 | read entity B after merge B->A with 2 refs | redirect via merged_into O(1); nightly compaction | tombstone merges |
| G-057 | read entity B after merge B->A with 3 refs | redirect via merged_into O(1); nightly compaction | tombstone merges |
| G-058 | read entity B after merge B->A with 4 refs | redirect via merged_into O(1); nightly compaction | tombstone merges |
| G-059 | user splits a wrongly-merged entity | two entities restored; evidence re-points by source identity; mutation logged | reversible merge |
| G-060 | user splits a wrongly-merged entity | two entities restored; evidence re-points by source identity; mutation logged | reversible merge |
| G-061 | user splits a wrongly-merged entity | two entities restored; evidence re-points by source identity; mutation logged | reversible merge |
| G-062 | user splits a wrongly-merged entity | two entities restored; evidence re-points by source identity; mutation logged | reversible merge |
| G-063 | @rahul on slack vs @rahul on x | NO cross-source bind on handle string alone | handles collide; only phone/email bind at CODE |
| G-064 | @pran on slack vs @pran on instagram | NO cross-source bind on handle string alone | handles collide; only phone/email bind at CODE |
| G-065 | WhatsApp self_jid / gmail account / device id / contacts-me card (1) | bind to the ONE canonical me entity | self_identity funnels to me |
| G-066 | WhatsApp self_jid / gmail account / device id / contacts-me card (2) | bind to the ONE canonical me entity | self_identity funnels to me |
| G-067 | WhatsApp self_jid / gmail account / device id / contacts-me card (3) | bind to the ONE canonical me entity | self_identity funnels to me |
| G-068 | WhatsApp self_jid / gmail account / device id / contacts-me card (4) | bind to the ONE canonical me entity | self_identity funnels to me |
| G-069 | calibration absent at boot | similarity rung DISABLED; pairs route to agent or queue | stale calib blocks ML rung |
| G-070 | any bind performed | decided_by and confidence recorded | provenance on every bind |

### H — MENTIONS (40)

_Roster hits, typing, pronouns, hints, ambiguity_

| ID | Given | Expect | Assert |
|---|---|---|---|
| H-001 | msg: 'ask Pranjali about the Goa trip' | M/<ev>/Pranjali/a<k>/>=0.9 | roster hit |
| H-002 | msg: 'ask Rahul about the flat hunt' | M/<ev>/Rahul/a<k>/>=0.9 | roster hit |
| H-003 | msg: 'ask Rashmi about the bhangra class' | M/<ev>/Rashmi/a<k>/>=0.9 | roster hit |
| H-004 | msg: 'ask Sudhir about the therapy' | M/<ev>/Sudhir/a<k>/>=0.9 | roster hit |
| H-005 | msg: 'ask Hrishikesh about the tax filing' | M/<ev>/Hrishikesh/a<k>/>=0.9 | roster hit |
| H-006 | msg: 'ask Gargi about the rabies shots' | M/<ev>/Gargi/a<k>/>=0.9 | roster hit |
| H-007 | msg: 'ask Keerti about the muesli idea' | M/<ev>/Keerti/a<k>/>=0.9 | roster hit |
| H-008 | msg: 'ask Prabhat about the local LLM setup' | M/<ev>/Prabhat/a<k>/>=0.9 | roster hit |
| H-009 | msg: 'ask Rajat about the Rahul's wedding' | M/<ev>/Rajat/a<k>/>=0.9 | roster hit |
| H-010 | msg: 'ask Mansi about the Gargi's 40th' | M/<ev>/Mansi/a<k>/>=0.9 | roster hit |
| H-011 | msg: 'ask Natesh about the villa booking' | M/<ev>/Natesh/a<k>/>=0.9 | roster hit |
| H-012 | msg mentions 'Indiranagar' | M -> place entity; mint if novel with subtype | place typing |
| H-013 | msg mentions 'Pizza 4P's' | M -> place entity; mint if novel with subtype | place typing |
| H-014 | msg mentions 'Koramangala' | M -> place entity; mint if novel with subtype | place typing |
| H-015 | msg mentions 'Goa' | M -> place entity; mint if novel with subtype | place typing |
| H-016 | msg mentions 'Ratlam' | M -> place entity; mint if novel with subtype | place typing |
| H-017 | msg mentions 'M2 MacBook' | M -> thing or document (NOT product/service/app_site) | 9-type discipline |
| H-018 | msg mentions 'the air fryer' | M -> thing or document (NOT product/service/app_site) | 9-type discipline |
| H-019 | msg mentions 'Wispr Flow' | M -> thing or document (NOT product/service/app_site) | 9-type discipline |
| H-020 | msg mentions 'broadband plan' | M -> thing or document (NOT product/service/app_site) | 9-type discipline |
| H-021 | msg mentions 'the rent agreement PDF' | M -> thing or document (NOT product/service/app_site) | 9-type discipline |
| H-022 | msg: 'watched that WWE match' | M -> media_work | media_work typing |
| H-023 | msg: 'watched a YouTube video on local LLMs' | M -> media_work | media_work typing |
| H-024 | msg: 'watched the SRK film' | M -> media_work | media_work typing |
| H-025 | [Pranjali]: 'she said the reports are clear'; only Rahul (F) discussed in THIS session | 'she' -> Rahul | pronoun resolved within session only |
| H-026 | [Rahul]: 'she said the reports are clear'; only Rashmi (F) discussed in THIS session | 'she' -> Rashmi | pronoun resolved within session only |
| H-027 | [Rashmi]: 'she said the reports are clear'; only Sudhir (F) discussed in THIS session | 'she' -> Sudhir | pronoun resolved within session only |
| H-028 | [Sudhir]: 'she said the reports are clear'; only Hrishikesh (F) discussed in THIS session | 'she' -> Hrishikesh | pronoun resolved within session only |
| H-029 | [Hrishikesh]: 'she said the reports are clear'; only Gargi (F) discussed in THIS session | 'she' -> Gargi | pronoun resolved within session only |
| H-030 | [Gargi]: 'she said the reports are clear'; only Keerti (F) discussed in THIS session | 'she' -> Keerti | pronoun resolved within session only |
| H-031 | msg mentions 'the broker', no roster candidate | M/<ev>/the broker/-/conf/hint | UNKNOWN BEATS WRONG |
| H-032 | msg mentions 'the electrician', no roster candidate | M/<ev>/the electrician/-/conf/hint | UNKNOWN BEATS WRONG |
| H-033 | msg mentions 'Rahul's cousin', no roster candidate | M/<ev>/Rahul's cousin/-/conf/hint | UNKNOWN BEATS WRONG |
| H-034 | msg mentions 'the landlord', no roster candidate | M/<ev>/the landlord/-/conf/hint | UNKNOWN BEATS WRONG |
| H-035 | msg mentions 'the CA', no roster candidate | M/<ev>/the CA/-/conf/hint | UNKNOWN BEATS WRONG |
| H-036 | 'tell Amit' with TWO roster Amits, both plausible | entity '-' + hint + Q line | two live candidates -> question |
| H-037 | 'tell Amit' with TWO roster Amits, both plausible | entity '-' + hint + Q line | two live candidates -> question |
| H-038 | 'tell Amit' with TWO roster Amits, both plausible | entity '-' + hint + Q line | two live candidates -> question |
| H-039 | 'tell Amit' with TWO roster Amits, both plausible | entity '-' + hint + Q line | two live candidates -> question |
| H-040 | [voice note, transcription pending] event | NOTHING extracted from it | placeholder is unknown not empty |

### I — EDGES (40)

_7 edge kinds, metadata edges, validity, discipline_

| ID | Given | Expect | Assert |
|---|---|---|---|
| I-001 | quote 'meri didi' about Rashmi | L/<ev>/<src>/rel/sibling/<dst>/conf/'meri didi' | related_to with verbatim quote |
| I-002 | quote 'maa' about Mummy | L/<ev>/<src>/rel/mother/<dst>/conf/'maa' | related_to with verbatim quote |
| I-003 | quote 'papa' about Papa | L/<ev>/<src>/rel/father/<dst>/conf/'papa' | related_to with verbatim quote |
| I-004 | quote 'cousin Gargi' about Gargi | L/<ev>/<src>/rel/cousin/<dst>/conf/'cousin Gargi' | related_to with verbatim quote |
| I-005 | quote 'bhabhi' about Keerti | L/<ev>/<src>/rel/in_law/<dst>/conf/'bhabhi' | related_to with verbatim quote |
| I-006 | quote 'Nana blessed him' about Nana | L/<ev>/<src>/rel/grandparent/<dst>/conf/'Nana blessed him' | related_to with verbatim quote |
| I-007 | evidence Bhavesh works at Hotstar | L ... aff/employee ... | affiliated_with |
| I-008 | evidence Sudhir works at Hotstar | L ... aff/employee ... | affiliated_with |
| I-009 | evidence Rashmi works at her new office | L ... aff/employee ... | affiliated_with |
| I-010 | evidence Rajat works at Domlur office | L ... aff/employee ... | affiliated_with |
| I-011 | group Ghar+ participant list includes Pranjali | L ... aff/member ... [CODE] conf 1.0, ZERO model calls | metadata edge is free |
| I-012 | group Goa Crew participant list includes Rahul | L ... aff/member ... [CODE] conf 1.0, ZERO model calls | metadata edge is free |
| I-013 | group Family participant list includes Rashmi | L ... aff/member ... [CODE] conf 1.0, ZERO model calls | metadata edge is free |
| I-014 | group Office Frandss participant list includes Sudhir | L ... aff/member ... [CODE] conf 1.0, ZERO model calls | metadata edge is free |
| I-015 | group Society participant list includes Hrishikesh | L ... aff/member ... [CODE] conf 1.0, ZERO model calls | metadata edge is free |
| I-016 | recurring evidence establishes Dr Shreedhar as doctor | L ... rel/doctor ... (NOT a separate provides_care edge) | 7-edge discipline |
| I-017 | recurring evidence establishes the therapist as therapist | L ... rel/therapist ... (NOT a separate provides_care edge) | 7-edge discipline |
| I-018 | recurring evidence establishes Prabhat as cook | L ... rel/cook ... (NOT a separate provides_care edge) | 7-edge discipline |
| I-019 | recurring evidence establishes the trainer as trainer | L ... rel/trainer ... (NOT a separate provides_care edge) | 7-edge discipline |
| I-020 | ownership evidence about M2 MacBook | L ... has/owns ... | has absorbs owns AND pet_of |
| I-021 | ownership evidence about the car | L ... has/owns ... | has absorbs owns AND pet_of |
| I-022 | ownership evidence about a farm with basil | L ... has/owns ... | has absorbs owns AND pet_of |
| I-023 | ownership evidence about the dog | L ... has/owns ... | has absorbs owns AND pet_of |
| I-024 | subscription evidence for Superhuman | L ... has/subscribes ... | has/subscribes not a separate edge |
| I-025 | subscription evidence for Netflix | L ... has/subscribes ... | has/subscribes not a separate edge |
| I-026 | subscription evidence for ACT broadband | L ... has/subscribes ... | has/subscribes not a separate edge |
| I-027 | 'the villa is booked for Sep' | NO has/owns edge — a booking is not ownership | edge discipline |
| I-028 | evidence Rahul lives at Indiranagar | L ... loc/current ...; prior loc gets valid_to + superseded | moves supersede |
| I-029 | evidence me lives at Bangalore | L ... loc/current ...; prior loc gets valid_to + superseded | moves supersede |
| I-030 | evidence Didi lives at America | L ... loc/current ...; prior loc gets valid_to + superseded | moves supersede |
| I-031 | contradiction: Prabhat stopped cooking | old edge valid_to + status=superseded with evidence | contradictions close, never delete |
| I-032 | contradiction: Rashmi left the office | old edge valid_to + status=superseded with evidence | contradictions close, never delete |
| I-033 | contradiction: broadband switched | old edge valid_to + status=superseded with evidence | contradictions close, never delete |
| I-034 | contradiction: trainer changed | old edge valid_to + status=superseded with evidence | contradictions close, never delete |
| I-035 | an opinion/preference stated about a person | NO edge emitted — that is a claim | edges are structural only |
| I-036 | an opinion/preference stated about a person | NO edge emitted — that is a claim | edges are structural only |
| I-037 | an opinion/preference stated about a person | NO edge emitted — that is a claim | edges are structural only |
| I-038 | calendar invite with attendees (1) | L ... par/attendee ... [CODE] | calendar metadata edges |
| I-039 | calendar invite with attendees (2) | L ... par/attendee ... [CODE] | calendar metadata edges |
| I-040 | calendar invite with attendees (3) | L ... par/attendee ... [CODE] | calendar metadata edges |

### J — EPISODES (55)

_1:1 default, split, attach, aging, verdict replay_

| ID | Given | Expect | Assert |
|---|---|---|---|
| J-001 | sealed session solely about Goa trip, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-002 | sealed session solely about flat hunt, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-003 | sealed session solely about bhangra class, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-004 | sealed session solely about therapy, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-005 | sealed session solely about tax filing, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-006 | sealed session solely about rabies shots, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-007 | sealed session solely about muesli idea, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-008 | sealed session solely about local LLM setup, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-009 | sealed session solely about Rahul's wedding, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-010 | sealed session solely about Gargi's 40th, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-011 | sealed session solely about villa booking, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-012 | sealed session solely about broadband plan, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-013 | sealed session solely about Goa trip, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-014 | sealed session solely about flat hunt, no drift, no open episodes | episode := session, NO MODEL CALL | 1:1 default |
| J-015 | session pivots Goa trip -> rabies shots, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-016 | session pivots flat hunt -> muesli idea, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-017 | session pivots bhangra class -> local LLM setup, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-018 | session pivots therapy -> Rahul's wedding, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-019 | session pivots tax filing -> Gargi's 40th, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-020 | session pivots rabies shots -> villa booking, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-021 | session pivots muesli idea -> broadband plan, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-022 | session pivots local LLM setup -> Goa trip, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-023 | session pivots Rahul's wedding -> flat hunt, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-024 | session pivots Gargi's 40th -> bhangra class, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-025 | session pivots villa booking -> therapy, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-026 | session pivots broadband plan -> tax filing, >=2 events each | G lines split into 2 segments partitioning all event ids | split + partition invariant |
| J-027 | session resumes Goa trip; open episode last active 1d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-028 | session resumes flat hunt; open episode last active 2d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-029 | session resumes bhangra class; open episode last active 3d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-030 | session resumes therapy; open episode last active 4d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-031 | session resumes tax filing; open episode last active 5d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-032 | session resumes rabies shots; open episode last active 6d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-033 | session resumes muesli idea; open episode last active 1d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-034 | session resumes local LLM setup; open episode last active 2d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-035 | session resumes Rahul's wedding; open episode last active 3d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-036 | session resumes Gargi's 40th; open episode last active 4d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-037 | session resumes villa booking; open episode last active 5d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-038 | session resumes broadband plan; open episode last active 6d ago, SAME stream | G/.../att/e<k>/conf/label; verdict persisted | attach |
| J-039 | 'Goa trip' appears in two DIFFERENT streams | TWO separate episodes; joining is arc work | episode matching is stream-scoped |
| J-040 | 'flat hunt' appears in two DIFFERENT streams | TWO separate episodes; joining is arc work | episode matching is stream-scoped |
| J-041 | 'bhangra class' appears in two DIFFERENT streams | TWO separate episodes; joining is arc work | episode matching is stream-scoped |
| J-042 | 'therapy' appears in two DIFFERENT streams | TWO separate episodes; joining is arc work | episode matching is stream-scoped |
| J-043 | 'tax filing' appears in two DIFFERENT streams | TWO separate episodes; joining is arc work | episode matching is stream-scoped |
| J-044 | open episode quiet 14d | arc_state=closed, outcome=faded [CODE] | aging is code |
| J-045 | open episode quiet 15d | arc_state=closed, outcome=faded [CODE] | aging is code |
| J-046 | open episode quiet 16d | arc_state=closed, outcome=faded [CODE] | aging is code |
| J-047 | open episode quiet 17d | arc_state=closed, outcome=faded [CODE] | aging is code |
| J-048 | re-run pipeline over same sealed sessions (run #2) | identical episodes; verdicts reused; ZERO new calls | verdict replay determinism |
| J-049 | re-run pipeline over same sealed sessions (run #3) | identical episodes; verdicts reused; ZERO new calls | verdict replay determinism |
| J-050 | re-run pipeline over same sealed sessions (run #4) | identical episodes; verdicts reused; ZERO new calls | verdict replay determinism |
| J-051 | re-run pipeline over same sealed sessions (run #5) | identical episodes; verdicts reused; ZERO new calls | verdict replay determinism |
| J-052 | session with no intra-session drift | skip call, 1:1 default | [ML] pre-flag gates the [LLM-M] call |
| J-053 | session with high intra-session drift | P-EP2 runs | [ML] pre-flag gates the [LLM-M] call |
| J-054 | session with no intra-session drift | skip call, 1:1 default | [ML] pre-flag gates the [LLM-M] call |
| J-055 | session with high intra-session drift | P-EP2 runs | [ML] pre-flag gates the [LLM-M] call |

### K — BRIDGES (30)

_8 deterministic cross-source joins_

| ID | Given | Expect | Assert |
|---|---|---|---|
| K-001 | link site0.com/x shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE]; episodes JOIN one arc | url bridge, precision 1.0 |
| K-002 | link site1.com/x shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE]; episodes JOIN one arc | url bridge, precision 1.0 |
| K-003 | link site2.com/x shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE]; episodes JOIN one arc | url bridge, precision 1.0 |
| K-004 | link site3.com/x shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE]; episodes JOIN one arc | url bridge, precision 1.0 |
| K-005 | link site4.com/x shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE]; episodes JOIN one arc | url bridge, precision 1.0 |
| K-006 | link site5.com/x shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE]; episodes JOIN one arc | url bridge, precision 1.0 |
| K-007 | link site6.com/x shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE]; episodes JOIN one arc | url bridge, precision 1.0 |
| K-008 | link site7.com/x shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE]; episodes JOIN one arc | url bridge, precision 1.0 |
| K-009 | tracking params / shortlink variant of the same url (1) | normalised to the same value_norm; bridge fires | url normalisation |
| K-010 | tracking params / shortlink variant of the same url (2) | normalised to the same value_norm; bridge fires | url normalisation |
| K-011 | tracking params / shortlink variant of the same url (3) | normalised to the same value_norm; bridge fires | url normalisation |
| K-012 | tracking params / shortlink variant of the same url (4) | normalised to the same value_norm; bridge fires | url normalisation |
| K-013 | MakeMyTrip order id in a Gmail receipt == id in a commerce event | bridge(order_id) | order id bridge |
| K-014 | Amazon order id in a Gmail receipt == id in a commerce event | bridge(order_id) | order id bridge |
| K-015 | Zomato order id in a Gmail receipt == id in a commerce event | bridge(order_id) | order id bridge |
| K-016 | Uber order id in a Gmail receipt == id in a commerce event | bridge(order_id) | order id bridge |
| K-017 | calendar attendees vs group participants, Jaccard 0.5 | bridge fires only at >=0.6 | attendee_set threshold |
| K-018 | calendar attendees vs group participants, Jaccard 0.6 | bridge fires only at >=0.6 | attendee_set threshold |
| K-019 | calendar attendees vs group participants, Jaccard 0.7 | bridge fires only at >=0.6 | attendee_set threshold |
| K-020 | calendar attendees vs group participants, Jaccard 0.8 | bridge fires only at >=0.6 | attendee_set threshold |
| K-021 | media_work entity referenced in chat and in watch history (1) | bridge(media_work_id) | media bridge |
| K-022 | media_work entity referenced in chat and in watch history (2) | bridge(media_work_id) | media bridge |
| K-023 | media_work entity referenced in chat and in watch history (3) | bridge(media_work_id) | media bridge |
| K-024 | media_work entity referenced in chat and in watch history (4) | bridge(media_work_id) | media bridge |
| K-025 | Uber drop and restaurant order 150m/30min apart | fires | geo_time within 200m AND 45min |
| K-026 | Uber drop and restaurant order 250m/30min apart | no | geo_time within 200m AND 45min |
| K-027 | Uber drop and restaurant order 150m/60min apart | no | geo_time within 200m AND 45min |
| K-028 | Drive file shared in chat; file_change events on same id | bridge(file_id) | file bridge |
| K-029 | Drive file shared in chat; file_change events on same id | bridge(file_id) | file bridge |
| K-030 | Drive file shared in chat; file_change events on same id | bridge(file_id) | file bridge |

### L — ARCS (45)

_Binding ladder, adjudication, aging, id stability_

| ID | Given | Expect | Assert |
|---|---|---|---|
| L-001 | episode with a bridge to an episode already in arc n1 | JOIN via ladder step 1 | bridges run first |
| L-002 | episode with a bridge to an episode already in arc n2 | JOIN via ladder step 1 | bridges run first |
| L-003 | episode with a bridge to an episode already in arc n3 | JOIN via ladder step 1 | bridges run first |
| L-004 | episode with a bridge to an episode already in arc n4 | JOIN via ladder step 1 | bridges run first |
| L-005 | episode with a bridge to an episode already in arc n5 | JOIN via ladder step 1 | bridges run first |
| L-006 | episode with a bridge to an episode already in arc n6 | JOIN via ladder step 1 | bridges run first |
| L-007 | episode with a bridge to an episode already in arc n7 | JOIN via ladder step 1 | bridges run first |
| L-008 | episode with a bridge to an episode already in arc n8 | JOIN via ladder step 1 | bridges run first |
| L-009 | weighted Jaccard on anchors = 0.42 | no join on overlap | entity overlap threshold |
| L-010 | weighted Jaccard on anchors = 0.46 | no join on overlap | entity overlap threshold |
| L-011 | weighted Jaccard on anchors = 0.50 | JOIN if >=0.5 | entity overlap threshold |
| L-012 | weighted Jaccard on anchors = 0.54 | JOIN if >=0.5 | entity overlap threshold |
| L-013 | weighted Jaccard on anchors = 0.58 | JOIN if >=0.5 | entity overlap threshold |
| L-014 | weighted Jaccard on anchors = 0.62 | JOIN if >=0.5 | entity overlap threshold |
| L-015 | weighted Jaccard on anchors = 0.66 | JOIN if >=0.5 | entity overlap threshold |
| L-016 | weighted Jaccard on anchors = 0.70 | JOIN if >=0.5 | entity overlap threshold |
| L-017 | overlap driven purely by shared topic entities | weight 0.4 — insufficient alone | topics drift, people anchor |
| L-018 | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.68 | P-AG2 one call -> jn/nw/un; un -> user question | adjudication only at ladder step 4 |
| L-019 | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.72 | P-AG2 one call -> jn/nw/un; un -> user question | adjudication only at ladder step 4 |
| L-020 | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.76 | P-AG2 one call -> jn/nw/un; un -> user question | adjudication only at ladder step 4 |
| L-021 | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.80 | P-AG2 one call -> jn/nw/un; un -> user question | adjudication only at ladder step 4 |
| L-022 | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.84 | P-AG2 one call -> jn/nw/un; un -> user question | adjudication only at ladder step 4 |
| L-023 | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.88 | P-AG2 one call -> jn/nw/un; un -> user question | adjudication only at ladder step 4 |
| L-024 | ambient episode, similarity 0.9, NO bridge, NO overlap | DO NOT join | ambient joins via bridge/overlap only |
| L-025 | ambient episode, similarity 0.9, NO bridge, NO overlap | DO NOT join | ambient joins via bridge/overlap only |
| L-026 | ambient episode, similarity 0.9, NO bridge, NO overlap | DO NOT join | ambient joins via bridge/overlap only |
| L-027 | ambient episode, similarity 0.9, NO bridge, NO overlap | DO NOT join | ambient joins via bridge/overlap only |
| L-028 | arc quiet 3w | live->dormant at 3w; ->archived at 12w [CODE] | arc aging |
| L-029 | arc quiet 4w | live->dormant at 3w; ->archived at 12w [CODE] | arc aging |
| L-030 | arc quiet 5w | live->dormant at 3w; ->archived at 12w [CODE] | arc aging |
| L-031 | arc quiet 6w | live->dormant at 3w; ->archived at 12w [CODE] | arc aging |
| L-032 | full re-derivation run #2 | same arc_keys -> same ids; labels and pins survive | arc-id stability |
| L-033 | full re-derivation run #3 | same arc_keys -> same ids; labels and pins survive | arc-id stability |
| L-034 | full re-derivation run #4 | same arc_keys -> same ids; labels and pins survive | arc-id stability |
| L-035 | full re-derivation run #5 | same arc_keys -> same ids; labels and pins survive | arc-id stability |
| L-036 | two provisional arcs for the same trip created in parallel cohorts | reconcile merges them before either surfaces | two-phase commit |
| L-037 | two provisional arcs for the same trip created in parallel cohorts | reconcile merges them before either surfaces | two-phase commit |
| L-038 | two provisional arcs for the same trip created in parallel cohorts | reconcile merges them before either surfaces | two-phase commit |
| L-039 | two provisional arcs for the same trip created in parallel cohorts | reconcile merges them before either surfaces | two-phase commit |
| L-040 | user split an arc; reconcile re-runs | split PERSISTS; reconcile plans around it | user rows are hard walls |
| L-041 | cross-source: WhatsApp thread + Calendar block, same trip, attendee bridge (1) | ONE arc spanning both sources | THE THESIS ROW — cross-source binding |
| L-042 | cross-source: WhatsApp thread + Calendar block, same trip, attendee bridge (2) | ONE arc spanning both sources | THE THESIS ROW — cross-source binding |
| L-043 | cross-source: WhatsApp thread + Calendar block, same trip, attendee bridge (3) | ONE arc spanning both sources | THE THESIS ROW — cross-source binding |
| L-044 | cross-source: WhatsApp thread + Calendar block, same trip, attendee bridge (4) | ONE arc spanning both sources | THE THESIS ROW — cross-source binding |
| L-045 | cross-source: WhatsApp thread + Calendar block, same trip, attendee bridge (5) | ONE arc spanning both sources | THE THESIS ROW — cross-source binding |

### M — CLAIMS (95)

_8 kinds, attribution, third person, evidence_

| ID | Given | Expect | Assert |
|---|---|---|---|
| M-001 | self says: 'i've started bhangra on saturdays' | H/<ev>/self/1p/conf/-/Attends bhangra classes on Saturdays | kind = tag; third person resolved |
| M-002 | self says: 'it's better than the gym' | P/<ev>/self/1p/conf/-/Prefers bhangra classes over the gym | kind = tag; third person resolved |
| M-003 | self says: 'ACT is way overpriced' | O/<ev>/self/1p/conf/-/Considers ACT broadband overpriced | kind = tag; third person resolved |
| M-004 | self says: 'i think therapy actually helps' | B/<ev>/self/1p/conf/-/Believes therapy helps | kind = tag; third person resolved |
| M-005 | self says: 'you should try Kalpaney' | R/<ev>/self/1p/conf/-/Recommends Kalpaney | kind = tag; third person resolved |
| M-006 | self says: 'i've been reading about local LLMs' | I/<ev>/self/1p/conf/-/Interested in local LLM setups | kind = tag; third person resolved |
| M-007 | self says: 'my lease ends in Nov 2027' | F/<ev>/self/1p/conf/-/Lease ends in November 2027 | kind = tag; third person resolved |
| M-008 | self says: 'every sunday i do groceries' | H/<ev>/self/1p/conf/-/Does groceries every Sunday | kind = tag; third person resolved |
| M-009 | self says: 'i always draft first then send' | W/<ev>/self/1p/conf/-/Drafts before sending | kind = tag; third person resolved |
| M-010 | self says: 'chole bhature is the best' | O/<ev>/self/1p/conf/-/Considers chole bhature the best | kind = tag; third person resolved |
| M-011 | self says: 'i've started bhangra on saturdays' | H/<ev>/self/1p/conf/-/Attends bhangra classes on Saturdays | kind = tag; third person resolved |
| M-012 | self says: 'it's better than the gym' | P/<ev>/self/1p/conf/-/Prefers bhangra classes over the gym | kind = tag; third person resolved |
| M-013 | self says: 'ACT is way overpriced' | O/<ev>/self/1p/conf/-/Considers ACT broadband overpriced | kind = tag; third person resolved |
| M-014 | self says: 'i think therapy actually helps' | B/<ev>/self/1p/conf/-/Believes therapy helps | kind = tag; third person resolved |
| M-015 | self says: 'you should try Kalpaney' | R/<ev>/self/1p/conf/-/Recommends Kalpaney | kind = tag; third person resolved |
| M-016 | self says: 'i've been reading about local LLMs' | I/<ev>/self/1p/conf/-/Interested in local LLM setups | kind = tag; third person resolved |
| M-017 | self says: 'my lease ends in Nov 2027' | F/<ev>/self/1p/conf/-/Lease ends in November 2027 | kind = tag; third person resolved |
| M-018 | self says: 'every sunday i do groceries' | H/<ev>/self/1p/conf/-/Does groceries every Sunday | kind = tag; third person resolved |
| M-019 | self says: 'i always draft first then send' | W/<ev>/self/1p/conf/-/Drafts before sending | kind = tag; third person resolved |
| M-020 | self says: 'chole bhature is the best' | O/<ev>/self/1p/conf/-/Considers chole bhature the best | kind = tag; third person resolved |
| M-021 | Pranjali says: 'i've started bhangra on saturdays' | H/<ev>/a<k>/1p/... | other speaking about self -> 1p |
| M-022 | Rahul says: 'it's better than the gym' | P/<ev>/a<k>/1p/... | other speaking about self -> 1p |
| M-023 | Rashmi says: 'ACT is way overpriced' | O/<ev>/a<k>/1p/... | other speaking about self -> 1p |
| M-024 | Sudhir says: 'i think therapy actually helps' | B/<ev>/a<k>/1p/... | other speaking about self -> 1p |
| M-025 | Hrishikesh says: 'you should try Kalpaney' | R/<ev>/a<k>/1p/... | other speaking about self -> 1p |
| M-026 | Gargi says: 'i've been reading about local LLMs' | I/<ev>/a<k>/1p/... | other speaking about self -> 1p |
| M-027 | Keerti says: 'my lease ends in Nov 2027' | F/<ev>/a<k>/1p/... | other speaking about self -> 1p |
| M-028 | Prabhat says: 'every sunday i do groceries' | H/<ev>/a<k>/1p/... | other speaking about self -> 1p |
| M-029 | self says something about Pranjali | attribution=ao | about_other |
| M-030 | self says something about Rahul | attribution=ao | about_other |
| M-031 | self says something about Rashmi | attribution=ao | about_other |
| M-032 | self says something about Sudhir | attribution=ao | about_other |
| M-033 | self says something about Hrishikesh | attribution=ao | about_other |
| M-034 | self says something about Gargi | attribution=ao | about_other |
| M-035 | self says something about Keerti | attribution=ao | about_other |
| M-036 | self says something about Prabhat | attribution=ao | about_other |
| M-037 | Pranjali relays what Rahul said | attribution=rs | reported_speech discounts confidence |
| M-038 | Rahul relays what Rashmi said | attribution=rs | reported_speech discounts confidence |
| M-039 | Rashmi relays what Sudhir said | attribution=rs | reported_speech discounts confidence |
| M-040 | Sudhir relays what Hrishikesh said | attribution=rs | reported_speech discounts confidence |
| M-041 | Hrishikesh relays what Gargi said | attribution=rs | reported_speech discounts confidence |
| M-042 | Gargi relays what Keerti said | attribution=rs | reported_speech discounts confidence |
| M-043 | forwarded article/quote pasted by Pranjali | attribution=q3; NOT the forwarder's belief | quoted_third_party |
| M-044 | forwarded article/quote pasted by Rahul | attribution=q3; NOT the forwarder's belief | quoted_third_party |
| M-045 | forwarded article/quote pasted by Rashmi | attribution=q3; NOT the forwarder's belief | quoted_third_party |
| M-046 | forwarded article/quote pasted by Sudhir | attribution=q3; NOT the forwarder's belief | quoted_third_party |
| M-047 | forwarded article/quote pasted by Hrishikesh | attribution=q3; NOT the forwarder's belief | quoted_third_party |
| M-048 | forwarded article/quote pasted by Gargi | attribution=q3; NOT the forwarder's belief | quoted_third_party |
| M-049 | 'I love X' said by self | text='Loves X' — never 'I love X' | resolved third person, no stray pronoun |
| M-050 | 'I love X' said by self | text='Loves X' — never 'I love X' | resolved third person, no stray pronoun |
| M-051 | 'I love X' said by self | text='Loves X' — never 'I love X' | resolved third person, no stray pronoun |
| M-052 | 'I love X' said by self | text='Loves X' — never 'I love X' | resolved third person, no stray pronoun |
| M-053 | 'I love X' said by self | text='Loves X' — never 'I love X' | resolved third person, no stray pronoun |
| M-054 | 'I love X' said by self | text='Loves X' — never 'I love X' | resolved third person, no stray pronoun |
| M-055 | 'I love X' said by self | text='Loves X' — never 'I love X' | resolved third person, no stray pronoun |
| M-056 | 'she is doing better' where only Pranjali is in scope | subject resolved to Pranjali | no stray 'she' in stored text |
| M-057 | 'she is doing better' where only Rahul is in scope | subject resolved to Rahul | no stray 'she' in stored text |
| M-058 | 'she is doing better' where only Rashmi is in scope | subject resolved to Rashmi | no stray 'she' in stored text |
| M-059 | 'she is doing better' where only Sudhir is in scope | subject resolved to Sudhir | no stray 'she' in stored text |
| M-060 | 'she is doing better' where only Hrishikesh is in scope | subject resolved to Hrishikesh | no stray 'she' in stored text |
| M-061 | 'she is doing better' where only Gargi is in scope | subject resolved to Gargi | no stray 'she' in stored text |
| M-062 | 'ok' | NO claim emitted | logistics chatter is not a claim |
| M-063 | 'sent' | NO claim emitted | logistics chatter is not a claim |
| M-064 | 'reaching' | NO claim emitted | logistics chatter is not a claim |
| M-065 | 'done' | NO claim emitted | logistics chatter is not a claim |
| M-066 | 'k' | NO claim emitted | logistics chatter is not a claim |
| M-067 | 'yes' | NO claim emitted | logistics chatter is not a claim |
| M-068 | 'sure' | NO claim emitted | logistics chatter is not a claim |
| M-069 | 'noted' | NO claim emitted | logistics chatter is not a claim |
| M-070 | claim about someone not on roster (1) | subject '-' + subject_hint | unknown beats wrong |
| M-071 | claim about someone not on roster (2) | subject '-' + subject_hint | unknown beats wrong |
| M-072 | claim about someone not on roster (3) | subject '-' + subject_hint | unknown beats wrong |
| M-073 | claim about someone not on roster (4) | subject '-' + subject_hint | unknown beats wrong |
| M-074 | claim about someone not on roster (5) | subject '-' + subject_hint | unknown beats wrong |
| M-075 | claim about someone not on roster (6) | subject '-' + subject_hint | unknown beats wrong |
| M-076 | 'from next month I'm vegetarian' (1) | valid_from set to the stated boundary | bitemporal valid_from |
| M-077 | 'from next month I'm vegetarian' (2) | valid_from set to the stated boundary | bitemporal valid_from |
| M-078 | 'from next month I'm vegetarian' (3) | valid_from set to the stated boundary | bitemporal valid_from |
| M-079 | 'from next month I'm vegetarian' (4) | valid_from set to the stated boundary | bitemporal valid_from |
| M-080 | 'from next month I'm vegetarian' (5) | valid_from set to the stated boundary | bitemporal valid_from |
| M-081 | 'from next month I'm vegetarian' (6) | valid_from set to the stated boundary | bitemporal valid_from |
| M-082 | claim written with empty confidence field | stored 0.9 | empty conf means 0.9 |
| M-083 | claim written with empty confidence field | stored 0.9 | empty conf means 0.9 |
| M-084 | claim written with empty confidence field | stored 0.9 | empty conf means 0.9 |
| M-085 | claim written with empty confidence field | stored 0.9 | empty conf means 0.9 |
| M-086 | claim written with empty confidence field | stored 0.9 | empty conf means 0.9 |
| M-087 | claim written with empty confidence field | stored 0.9 | empty conf means 0.9 |
| M-088 | claim emitted with no event citation | REJECT — no evidence, no write | evidence mandatory |
| M-089 | claim emitted with no event citation | REJECT — no evidence, no write | evidence mandatory |
| M-090 | claim emitted with no event citation | REJECT — no evidence, no write | evidence mandatory |
| M-091 | claim emitted with no event citation | REJECT — no evidence, no write | evidence mandatory |
| M-092 | claim from a 2024 backfill episode (1) | extracted in full; NO age filtering on claims | claims are never age-filtered |
| M-093 | claim from a 2024 backfill episode (2) | extracted in full; NO age filtering on claims | claims are never age-filtered |
| M-094 | claim from a 2024 backfill episode (3) | extracted in full; NO age filtering on claims | claims are never age-filtered |
| M-095 | claim from a 2024 backfill episode (4) | extracted in full; NO age filtering on claims | claims are never age-filtered |

### N — LOOPS (75)

_Intent+end-state test, temporal boundaries, dates_

| ID | Given | Expect | Assert |
|---|---|---|---|
| N-001 | self: 'i'll send you the Goa trip link tonight' | T/.../self/a<k>/ex/i2t/.../due today/... | explicit commitment -> loop |
| N-002 | self: 'i'll send you the flat hunt link tonight' | T/.../self/a<k>/ex/i2t/.../due today/... | explicit commitment -> loop |
| N-003 | self: 'i'll send you the bhangra class link tonight' | T/.../self/a<k>/ex/i2t/.../due today/... | explicit commitment -> loop |
| N-004 | self: 'i'll send you the therapy link tonight' | T/.../self/a<k>/ex/i2t/.../due today/... | explicit commitment -> loop |
| N-005 | self: 'i'll send you the tax filing link tonight' | T/.../self/a<k>/ex/i2t/.../due today/... | explicit commitment -> loop |
| N-006 | self: 'i'll send you the rabies shots link tonight' | T/.../self/a<k>/ex/i2t/.../due today/... | explicit commitment -> loop |
| N-007 | 'my policy renews/expires on <date>' | T with due + recurrence where applicable | TEMPORAL BOUNDARY loop — highest value in old data |
| N-008 | 'my lease renews/expires on <date>' | T with due + recurrence where applicable | TEMPORAL BOUNDARY loop — highest value in old data |
| N-009 | 'my passport renews/expires on <date>' | T with due + recurrence where applicable | TEMPORAL BOUNDARY loop — highest value in old data |
| N-010 | 'my warranty renews/expires on <date>' | T with due + recurrence where applicable | TEMPORAL BOUNDARY loop — highest value in old data |
| N-011 | 'my subscription renews/expires on <date>' | T with due + recurrence where applicable | TEMPORAL BOUNDARY loop — highest value in old data |
| N-012 | 'my AMC renews/expires on <date>' | T with due + recurrence where applicable | TEMPORAL BOUNDARY loop — highest value in old data |
| N-013 | 'my insurance renews/expires on <date>' | T with due + recurrence where applicable | TEMPORAL BOUNDARY loop — highest value in old data |
| N-014 | 'my visa renews/expires on <date>' | T with due + recurrence where applicable | TEMPORAL BOUNDARY loop — highest value in old data |
| N-015 | 'Pranjali recommends trying X' | R claim, NOT a loop | recommendation is not a commitment |
| N-016 | 'Rahul recommends trying X' | R claim, NOT a loop | recommendation is not a commitment |
| N-017 | 'Rashmi recommends trying X' | R claim, NOT a loop | recommendation is not a commitment |
| N-018 | 'Sudhir recommends trying X' | R claim, NOT a loop | recommendation is not a commitment |
| N-019 | 'we should get dinner sometime' (1) | NO loop — no unresolved end state | vague wish is not a loop |
| N-020 | 'we should get dinner sometime' (2) | NO loop — no unresolved end state | vague wish is not a loop |
| N-021 | 'we should get dinner sometime' (3) | NO loop — no unresolved end state | vague wish is not a loop |
| N-022 | 'we should get dinner sometime' (4) | NO loop — no unresolved end state | vague wish is not a loop |
| N-023 | habit statement about Goa trip | H claim, NO loop | state evidence -> claim not loop |
| N-024 | habit statement about flat hunt | H claim, NO loop | state evidence -> claim not loop |
| N-025 | habit statement about bhangra class | H claim, NO loop | state evidence -> claim not loop |
| N-026 | habit statement about therapy | H claim, NO loop | state evidence -> claim not loop |
| N-027 | habit statement about tax filing | H claim, NO loop | state evidence -> claim not loop |
| N-028 | habit statement about rabies shots | H claim, NO loop | state evidence -> claim not loop |
| N-029 | agent COULD help with Goa trip | NO loop — capability guess, not intent | hypothetical is not latent |
| N-030 | agent COULD help with flat hunt | NO loop — capability guess, not intent | hypothetical is not latent |
| N-031 | agent COULD help with bhangra class | NO loop — capability guess, not intent | hypothetical is not latent |
| N-032 | agent COULD help with therapy | NO loop — capability guess, not intent | hypothetical is not latent |
| N-033 | agent COULD help with tax filing | NO loop — capability guess, not intent | hypothetical is not latent |
| N-034 | agent COULD help with rabies shots | NO loop — capability guess, not intent | hypothetical is not latent |
| N-035 | 'soon' | due='-' — NEVER invent a date | no invented dates |
| N-036 | 'next week' | due='-' — NEVER invent a date | no invented dates |
| N-037 | 'sometime' | due='-' — NEVER invent a date | no invented dates |
| N-038 | 'later' | due='-' — NEVER invent a date | no invented dates |
| N-039 | 'shortly' | due='-' — NEVER invent a date | no invented dates |
| N-040 | 'eventually' | due='-' — NEVER invent a date | no invented dates |
| N-041 | 'the 28th' in an episode dated 2026-08-12 | resolved against the EPISODE date, not today | relative date anchoring |
| N-042 | 'the 28th' in an episode dated 2026-01-30 | resolved against the EPISODE date, not today | relative date anchoring |
| N-043 | 'the 28th' in an episode dated 2025-11-02 | resolved against the EPISODE date, not today | relative date anchoring |
| N-044 | 'the 28th' in an episode dated 2026-03-15 | resolved against the EPISODE date, not today | relative date anchoring |
| N-045 | 'the 28th' in an episode dated 2026-06-01 | resolved against the EPISODE date, not today | relative date anchoring |
| N-046 | 'the 28th' in an episode dated 2026-09-20 | resolved against the EPISODE date, not today | relative date anchoring |
| N-047 | loop created with due already in the past (1) | state=lapsed, never born 'open' | code fact |
| N-048 | loop created with due already in the past (2) | state=lapsed, never born 'open' | code fact |
| N-049 | loop created with due already in the past (3) | state=lapsed, never born 'open' | code fact |
| N-050 | loop created with due already in the past (4) | state=lapsed, never born 'open' | code fact |
| N-051 | loop created with due already in the past (5) | state=lapsed, never born 'open' | code fact |
| N-052 | past due + recurrence annual, next occurrence in the future | state=open — LIVE | recurrence projection beats age |
| N-053 | past due + recurrence annual, next occurrence in the future | state=open — LIVE | recurrence projection beats age |
| N-054 | past due + recurrence annual, next occurrence in the future | state=open — LIVE | recurrence projection beats age |
| N-055 | past due + recurrence annual, next occurrence in the future | state=open — LIVE | recurrence projection beats age |
| N-056 | past due + recurrence annual, next occurrence in the future | state=open — LIVE | recurrence projection beats age |
| N-057 | past due, no recurrence, no resolving evidence | state=lapsed; not a task | dead loop stays history |
| N-058 | past due, no recurrence, no resolving evidence | state=lapsed; not a task | dead loop stays history |
| N-059 | past due, no recurrence, no resolving evidence | state=lapsed; not a task | dead loop stays history |
| N-060 | past due, no recurrence, no resolving evidence | state=lapsed; not a task | dead loop stays history |
| N-061 | past due, no recurrence, no resolving evidence | state=lapsed; not a task | dead loop stays history |
| N-062 | loop owned by Pranjali, counterparty null | triage=context; NEVER in the user's task list | non-self loops are context |
| N-063 | loop owned by Rahul, counterparty null | triage=context; NEVER in the user's task list | non-self loops are context |
| N-064 | loop owned by Rashmi, counterparty null | triage=context; NEVER in the user's task list | non-self loops are context |
| N-065 | loop owned by Sudhir, counterparty null | triage=context; NEVER in the user's task list | non-self loops are context |
| N-066 | loop owned by Hrishikesh, counterparty null | triage=context; NEVER in the user's task list | non-self loops are context |
| N-067 | implicit loop inferred from a complaint (1) | origin=im; triage never 'auto' | implicit never auto |
| N-068 | implicit loop inferred from a complaint (2) | origin=im; triage never 'auto' | implicit never auto |
| N-069 | implicit loop inferred from a complaint (3) | origin=im; triage never 'auto' | implicit never auto |
| N-070 | implicit loop inferred from a complaint (4) | origin=im; triage never 'auto' | implicit never auto |
| N-071 | implicit loop inferred from a complaint (5) | origin=im; triage never 'auto' | implicit never auto |
| N-072 | implicit, no due, no recurrence, evidence >30d old, never reinforced | default state=latent not open | the one surviving age rule |
| N-073 | implicit, no due, no recurrence, evidence >30d old, never reinforced | default state=latent not open | the one surviving age rule |
| N-074 | implicit, no due, no recurrence, evidence >30d old, never reinforced | default state=latent not open | the one surviving age rule |
| N-075 | implicit, no due, no recurrence, evidence >30d old, never reinforced | default state=latent not open | the one surviving age rule |

### O — PARTY (45)

_3 roles, 9 pairs, code derivation, not-your-space_

| ID | Given | Expect | Assert |
|---|---|---|---|
| O-001 | claim: self states about self (variant 1) | party_pair=ss | derived by CODE from roles |
| O-002 | claim: self states about self (variant 2) | party_pair=ss | derived by CODE from roles |
| O-003 | claim: self states about self (variant 3) | party_pair=ss | derived by CODE from roles |
| O-004 | claim: self about the person present (variant 1) | party_pair=so | derived by CODE from roles |
| O-005 | claim: self about the person present (variant 2) | party_pair=so | derived by CODE from roles |
| O-006 | claim: self about the person present (variant 3) | party_pair=so | derived by CODE from roles |
| O-007 | claim: self about an absent person (variant 1) | party_pair=st | derived by CODE from roles |
| O-008 | claim: self about an absent person (variant 2) | party_pair=st | derived by CODE from roles |
| O-009 | claim: self about an absent person (variant 3) | party_pair=st | derived by CODE from roles |
| O-010 | claim: other about me (variant 1) | party_pair=os | derived by CODE from roles |
| O-011 | claim: other about me (variant 2) | party_pair=os | derived by CODE from roles |
| O-012 | claim: other about me (variant 3) | party_pair=os | derived by CODE from roles |
| O-013 | claim: other about themselves (variant 1) | party_pair=oo | derived by CODE from roles |
| O-014 | claim: other about themselves (variant 2) | party_pair=oo | derived by CODE from roles |
| O-015 | claim: other about themselves (variant 3) | party_pair=oo | derived by CODE from roles |
| O-016 | claim: other about an absent person (variant 1) | party_pair=ot | derived by CODE from roles |
| O-017 | claim: other about an absent person (variant 2) | party_pair=ot | derived by CODE from roles |
| O-018 | claim: other about an absent person (variant 3) | party_pair=ot | derived by CODE from roles |
| O-019 | claim: absent person's words about me (variant 1) | party_pair=ts | derived by CODE from roles |
| O-020 | claim: absent person's words about me (variant 2) | party_pair=ts | derived by CODE from roles |
| O-021 | claim: absent person's words about me (variant 3) | party_pair=ts | derived by CODE from roles |
| O-022 | claim: absent person's words about the present person (variant 1) | party_pair=to | derived by CODE from roles |
| O-023 | claim: absent person's words about the present person (variant 2) | party_pair=to | derived by CODE from roles |
| O-024 | claim: absent person's words about the present person (variant 3) | party_pair=to | derived by CODE from roles |
| O-025 | claim: absent person's words about another absent person (variant 1) | party_pair=tt | derived by CODE from roles |
| O-026 | claim: absent person's words about another absent person (variant 2) | party_pair=tt | derived by CODE from roles |
| O-027 | claim: absent person's words about another absent person (variant 3) | party_pair=tt | derived by CODE from roles |
| O-028 | loop: owner/counterparty roles giving ss | party_pair=ss | loop pair derivation |
| O-029 | loop: owner/counterparty roles giving so | party_pair=so | loop pair derivation |
| O-030 | loop: owner/counterparty roles giving st | party_pair=st | loop pair derivation |
| O-031 | loop: owner/counterparty roles giving os | party_pair=os | loop pair derivation |
| O-032 | loop: owner/counterparty roles giving oo | party_pair=oo | loop pair derivation |
| O-033 | loop: owner/counterparty roles giving ot | party_pair=ot | loop pair derivation |
| O-034 | loop: owner/counterparty roles giving ts | party_pair=ts | loop pair derivation |
| O-035 | loop: owner/counterparty roles giving to | party_pair=to | loop pair derivation |
| O-036 | loop: owner/counterparty roles giving tt | party_pair=tt | loop pair derivation |
| O-037 | 5-person group: participant #1 not the addressee | role=o (participant), addressee_id separate | 'other' means participant, not addressee |
| O-038 | model emits a party_pair field on the wire | REJECT — party_pair is never model-emitted | zero model burden |
| O-039 | arc whose loops are all oo/ot/tt | NOT promoted to a space; lives on the People record | the 'not your space' rule |
| O-040 | arc with at least one loop containing s | eligible for promotion | self-involvement required |
| O-041 | oo loop reaches the task list (1) | FAIL | oo must never be a task |
| O-042 | oo loop reaches the task list (2) | FAIL | oo must never be a task |
| O-043 | oo loop reaches the task list (3) | FAIL | oo must never be a task |
| O-044 | oo loop reaches the task list (4) | FAIL | oo must never be a task |
| O-045 | query: everything Rahul said about Ana | filter party_pair=ot AND speaker=Rahul AND subject=Ana | pairs are queryable |

### P — PROMOTION (50)

_4 routes, 8 archetypes, demotion_

| ID | Given | Expect | Assert |
|---|---|---|---|
| P-001 | arc with 1 open loop(s) | promoted, promotion_reason=cmt, status=active | commitment route |
| P-002 | arc with 2 open loop(s) | promoted, promotion_reason=cmt, status=active | commitment route |
| P-003 | arc with 3 open loop(s) | promoted, promotion_reason=cmt, status=active | commitment route |
| P-004 | arc with 4 open loop(s) | promoted, promotion_reason=cmt, status=active | commitment route |
| P-005 | arc with 5 open loop(s) | promoted, promotion_reason=cmt, status=active | commitment route |
| P-006 | arc with 6 open loop(s) | promoted, promotion_reason=cmt, status=active | commitment route |
| P-007 | arc anchored on my flat with a has/loc relation, NO loops | promoted, promotion_reason=ref | REFERENCE route — the failure case loop-only misses |
| P-008 | arc anchored on car with a has/loc relation, NO loops | promoted, promotion_reason=ref | REFERENCE route — the failure case loop-only misses |
| P-009 | arc anchored on policy with a has/loc relation, NO loops | promoted, promotion_reason=ref | REFERENCE route — the failure case loop-only misses |
| P-010 | arc anchored on connection with a has/loc relation, NO loops | promoted, promotion_reason=ref | REFERENCE route — the failure case loop-only misses |
| P-011 | arc anchored on account with a has/loc relation, NO loops | promoted, promotion_reason=ref | REFERENCE route — the failure case loop-only misses |
| P-012 | arc anchored on lease with a has/loc relation, NO loops | promoted, promotion_reason=ref | REFERENCE route — the failure case loop-only misses |
| P-013 | arc: 3 episodes over 2 weeks, 3 distinct days, user participated | promoted, promotion_reason=rec | recurrence route |
| P-014 | arc: 4 episodes over 3 weeks, 4 distinct days, user participated | promoted, promotion_reason=rec | recurrence route |
| P-015 | arc: 5 episodes over 4 weeks, 5 distinct days, user participated | promoted, promotion_reason=rec | recurrence route |
| P-016 | arc: 6 episodes over 5 weeks, 6 distinct days, user participated | promoted, promotion_reason=rec | recurrence route |
| P-017 | arc: 7 episodes over 6 weeks, 7 distinct days, user participated | promoted, promotion_reason=rec | recurrence route |
| P-018 | arc: 8 episodes over 7 weeks, 8 distinct days, user participated | promoted, promotion_reason=rec | recurrence route |
| P-019 | arc: 2 episodes, 1 day, no loops (1) | NOT promoted; stays a browsable thread | recurrence thresholds |
| P-020 | arc: 2 episodes, 1 day, no loops (2) | NOT promoted; stays a browsable thread | recurrence thresholds |
| P-021 | arc: 2 episodes, 1 day, no loops (3) | NOT promoted; stays a browsable thread | recurrence thresholds |
| P-022 | arc: 2 episodes, 1 day, no loops (4) | NOT promoted; stays a browsable thread | recurrence thresholds |
| P-023 | user pins an unpromoted thread | promoted, promotion_reason=usr, permanent | user route |
| P-024 | user pins an unpromoted thread | promoted, promotion_reason=usr, permanent | user route |
| P-025 | user pins an unpromoted thread | promoted, promotion_reason=usr, permanent | user route |
| P-026 | all loops in a promoted arc reach done/lapsed | status=archived; still retrievable; id unchanged | demotion is a field flip |
| P-027 | all loops in a promoted arc reach done/lapsed | status=archived; still retrievable; id unchanged | demotion is a field flip |
| P-028 | all loops in a promoted arc reach done/lapsed | status=archived; still retrievable; id unchanged | demotion is a field flip |
| P-029 | all loops in a promoted arc reach done/lapsed | status=archived; still retrievable; id unchanged | demotion is a field flip |
| P-030 | a thread is demoted | NO row deleted, arc id unchanged | one table, promoted is a field |
| P-031 | thread shaped as: outcome + steps + span (variant 1) | D/.../project/... | archetype by shape not subject |
| P-032 | thread shaped as: outcome + steps + span (variant 2) | D/.../project/... | archetype by shape not subject |
| P-033 | thread shaped as: a single date approaching (variant 1) | D/.../event/... | archetype by shape not subject |
| P-034 | thread shaped as: a single date approaching (variant 2) | D/.../event/... | archetype by shape not subject |
| P-035 | thread shaped as: recurring commitment to others (variant 1) | D/.../rhythm/... | archetype by shape not subject |
| P-036 | thread shaped as: recurring commitment to others (variant 2) | D/.../rhythm/... | archetype by shape not subject |
| P-037 | thread shaped as: recurring external duty with a ledger (variant 1) | D/.../admin/... | archetype by shape not subject |
| P-038 | thread shaped as: recurring external duty with a ledger (variant 2) | D/.../admin/... | archetype by shape not subject |
| P-039 | thread shaped as: a durable thing owned/inhabited (variant 1) | D/.../holding/... | archetype by shape not subject |
| P-040 | thread shaped as: a durable thing owned/inhabited (variant 2) | D/.../holding/... | archetype by shape not subject |
| P-041 | thread shaped as: unresolved situation, no fixed end (variant 1) | D/.../matter/... | archetype by shape not subject |
| P-042 | thread shaped as: unresolved situation, no fixed end (variant 2) | D/.../matter/... | archetype by shape not subject |
| P-043 | thread shaped as: self-directed recurring activity you DO (variant 1) | D/.../pursuit/... | archetype by shape not subject |
| P-044 | thread shaped as: self-directed recurring activity you DO (variant 2) | D/.../pursuit/... | archetype by shape not subject |
| P-045 | thread shaped as: a topic you FOLLOW without doing (variant 1) | D/.../watch/... | archetype by shape not subject |
| P-046 | thread shaped as: a topic you FOLLOW without doing (variant 2) | D/.../watch/... | archetype by shape not subject |
| P-047 | hobby where evidence is mostly the user's own events | pursuit | act vs observe |
| P-048 | interest where evidence is mostly things arriving at the user | watch | act vs observe |
| P-049 | 'learning guitar' gains a recital date | archetype revises to project, transition recorded with reason | archetype is revisable |
| P-050 | promoted thread | promotion_reason recorded and renderable | 'why is this a space' always answers |

### Q — TASKS (30)

_The view, explicit/implicit, done, teaching_

| ID | Given | Expect | Assert |
|---|---|---|---|
| Q-001 | loop owner=me, state=latent | appears in Tasks | task = view over loops |
| Q-002 | loop owner=me, state=open | appears in Tasks | task = view over loops |
| Q-003 | loop owner=me, state=latent | appears in Tasks | task = view over loops |
| Q-004 | loop owner=me, state=open | appears in Tasks | task = view over loops |
| Q-005 | loop owner=me, state=latent | appears in Tasks | task = view over loops |
| Q-006 | loop owner=me, state=open | appears in Tasks | task = view over loops |
| Q-007 | loop owner=Pranjali | does NOT appear in Tasks; shows under Waiting on others / People | others' loops are context |
| Q-008 | loop owner=Rahul | does NOT appear in Tasks; shows under Waiting on others / People | others' loops are context |
| Q-009 | loop owner=Rashmi | does NOT appear in Tasks; shows under Waiting on others / People | others' loops are context |
| Q-010 | loop owner=Sudhir | does NOT appear in Tasks; shows under Waiting on others / People | others' loops are context |
| Q-011 | loop owner=Hrishikesh | does NOT appear in Tasks; shows under Waiting on others / People | others' loops are context |
| Q-012 | loop owner=Gargi | does NOT appear in Tasks; shows under Waiting on others / People | others' loops are context |
| Q-013 | loop reaches state=done | leaves every surface immediately | never nag about finished things |
| Q-014 | loop reaches state=done | leaves every surface immediately | never nag about finished things |
| Q-015 | loop reaches state=done | leaves every surface immediately | never nag about finished things |
| Q-016 | loop reaches state=done | leaves every surface immediately | never nag about finished things |
| Q-017 | explicit vs implicit loops rendered (1) | TWO separate lists, different verbs, never interleaved | different products |
| Q-018 | explicit vs implicit loops rendered (2) | TWO separate lists, different verbs, never interleaved | different products |
| Q-019 | explicit vs implicit loops rendered (3) | TWO separate lists, different verbs, never interleaved | different products |
| Q-020 | explicit vs implicit loops rendered (4) | TWO separate lists, different verbs, never interleaved | different products |
| Q-021 | user taps 'not useful' on an implicit loop (1) | writes a user-sourced preference claim that enters future rosters | rejection teaches, not deletes |
| Q-022 | user taps 'not useful' on an implicit loop (2) | writes a user-sourced preference claim that enters future rosters | rejection teaches, not deletes |
| Q-023 | user taps 'not useful' on an implicit loop (3) | writes a user-sourced preference claim that enters future rosters | rejection teaches, not deletes |
| Q-024 | user taps 'not useful' on an implicit loop (4) | writes a user-sourced preference claim that enters future rosters | rejection teaches, not deletes |
| Q-025 | loop born lapsed from backfill | shows LAPSED with reason 'born lapsed' | honest about backfill |
| Q-026 | loop born lapsed from backfill | shows LAPSED with reason 'born lapsed' | honest about backfill |
| Q-027 | loop born lapsed from backfill | shows LAPSED with reason 'born lapsed' | honest about backfill |
| Q-028 | any loop in state possibly_done | FAIL — the state does not exist | evidence or a question, never a parking lot |
| Q-029 | P-DD1 returns 'ps' (possibly) | loop stays open AND a one-tap question is raised | possibly -> question |
| Q-030 | approval attaches to a blanket queue | FAIL | approval attaches to action class |

### R — WRITE (40)

_Reinforce, supersede, stated_at precedence, confluence_

| ID | Given | Expect | Assert |
|---|---|---|---|
| R-001 | identical claim re-extracted (1) | REINFORCE: union evidence, max confidence, NO new row | exact claim_key hit |
| R-002 | identical claim re-extracted (2) | REINFORCE: union evidence, max confidence, NO new row | exact claim_key hit |
| R-003 | identical claim re-extracted (3) | REINFORCE: union evidence, max confidence, NO new row | exact claim_key hit |
| R-004 | identical claim re-extracted (4) | REINFORCE: union evidence, max confidence, NO new row | exact claim_key hit |
| R-005 | identical claim re-extracted (5) | REINFORCE: union evidence, max confidence, NO new row | exact claim_key hit |
| R-006 | habit claim seen a 2nd time | reinforced; graduates by evidence count, no MIN_EVIDENCE constant | no code judging |
| R-007 | habit claim seen a 3nd time | reinforced; graduates by evidence count, no MIN_EVIDENCE constant | no code judging |
| R-008 | habit claim seen a 4nd time | reinforced; graduates by evidence count, no MIN_EVIDENCE constant | no code judging |
| R-009 | habit claim seen a 5nd time | reinforced; graduates by evidence count, no MIN_EVIDENCE constant | no code judging |
| R-010 | near-hit claim, calibrated 0.88, same subject+kind | -> P-AG3 | near hit routes to adjudicator |
| R-011 | near-hit claim, calibrated 0.90, same subject+kind | -> P-AG3 | near hit routes to adjudicator |
| R-012 | near-hit claim, calibrated 0.92, same subject+kind | -> P-AG3 | near hit routes to adjudicator |
| R-013 | near-hit claim, calibrated 0.94, same subject+kind | -> P-AG3 | near hit routes to adjudicator |
| R-014 | near-hit claim, calibrated 0.96, same subject+kind | -> P-AG3 | near hit routes to adjudicator |
| R-015 | near-hit claim, calibrated 0.98, same subject+kind | -> P-AG3 | near hit routes to adjudicator |
| R-016 | P-AG3 returns dup | reinforce | adjudication outcomes |
| R-017 | P-AG3 returns rfn | supersede 'refined by better evidence' | adjudication outcomes |
| R-018 | P-AG3 returns ctr | supersede + valid_to on the earlier | adjudication outcomes |
| R-019 | P-AG3 returns dst | insert | adjudication outcomes |
| R-020 | P-AG3 returns un | insert + question | adjudication outcomes |
| R-021 | older claim (stated_at earlier) arrives AFTER a newer one (1) | stored as predecessor with closed window; newer stays active | precedence by stated_at NOT arrival |
| R-022 | older claim (stated_at earlier) arrives AFTER a newer one (2) | stored as predecessor with closed window; newer stays active | precedence by stated_at NOT arrival |
| R-023 | older claim (stated_at earlier) arrives AFTER a newer one (3) | stored as predecessor with closed window; newer stays active | precedence by stated_at NOT arrival |
| R-024 | older claim (stated_at earlier) arrives AFTER a newer one (4) | stored as predecessor with closed window; newer stays active | precedence by stated_at NOT arrival |
| R-025 | older claim (stated_at earlier) arrives AFTER a newer one (5) | stored as predecessor with closed window; newer stays active | precedence by stated_at NOT arrival |
| R-026 | older claim (stated_at earlier) arrives AFTER a newer one (6) | stored as predecessor with closed window; newer stays active | precedence by stated_at NOT arrival |
| R-027 | precedence decided using ingested_at | FAIL | ingested_at is audit only |
| R-028 | same corpus ingested in order A (different source order / delayed sync) | identical final graph | CONFLUENCE |
| R-029 | same corpus ingested in order B (different source order / delayed sync) | identical final graph | CONFLUENCE |
| R-030 | same corpus ingested in order C (different source order / delayed sync) | identical final graph | CONFLUENCE |
| R-031 | same corpus ingested in order D (different source order / delayed sync) | identical final graph | CONFLUENCE |
| R-032 | loop_key computed (1) | sha1(owner/counterparty/normalize(intent)) — NO space_id or arc_id | no circular key |
| R-033 | loop_key computed (2) | sha1(owner/counterparty/normalize(intent)) — NO space_id or arc_id | no circular key |
| R-034 | loop_key computed (3) | sha1(owner/counterparty/normalize(intent)) — NO space_id or arc_id | no circular key |
| R-035 | loop_key computed (4) | sha1(owner/counterparty/normalize(intent)) — NO space_id or arc_id | no circular key |
| R-036 | any write performed | a mutations row is emitted | undo is reverse-replay |
| R-037 | any write performed | a mutations row is emitted | undo is reverse-replay |
| R-038 | any write performed | a mutations row is emitted | undo is reverse-replay |
| R-039 | 'undo last run' invoked | all that run's mutations reversed; user mutations untouched | undo scope |
| R-040 | model output dropped by code anywhere in the path | FAIL — must stay 0 | THE ROW THAT KILLED FOUR SYSTEMS |

### S — WIRE (50)

_STW-2 codec, tolerance, repair, A/B_

| ID | Given | Expect | Assert |
|---|---|---|---|
| S-001 | round trip on generated line set #1 | serialize(parse(serialize(x))) byte-identical | round-trip gate |
| S-002 | round trip on generated line set #2 | serialize(parse(serialize(x))) byte-identical | round-trip gate |
| S-003 | round trip on generated line set #3 | serialize(parse(serialize(x))) byte-identical | round-trip gate |
| S-004 | round trip on generated line set #4 | serialize(parse(serialize(x))) byte-identical | round-trip gate |
| S-005 | random byte input #1 | parser never throws | totality |
| S-006 | random byte input #2 | parser never throws | totality |
| S-007 | random byte input #3 | parser never throws | totality |
| S-008 | truncated line prefix #1 | violation, never a throw | truncation safety |
| S-009 | truncated line prefix #2 | violation, never a throw | truncation safety |
| S-010 | truncated line prefix #3 | violation, never a throw | truncation safety |
| S-011 | degenerate input "" | no throw; accounted | degenerate inputs |
| S-012 | degenerate input "/" | no throw; accounted | degenerate inputs |
| S-013 | degenerate input "////////" | no throw; accounted | degenerate inputs |
| S-014 | degenerate input null | no throw; accounted | degenerate inputs |
| S-015 | degenerate input undefined | no throw; accounted | degenerate inputs |
| S-016 | line wrapped as **T/...** (#1) | emphasis stripped, line PARSES, strip counted | 212-violation lesson |
| S-017 | line wrapped as **T/...** (#2) | emphasis stripped, line PARSES, strip counted | 212-violation lesson |
| S-018 | line wrapped as **T/...** (#3) | emphasis stripped, line PARSES, strip counted | 212-violation lesson |
| S-019 | line wrapped in ``` fence / # heading / - bullet | skipped and counted, not a violation | markdown skip classes |
| S-020 | line wrapped in ``` fence / # heading / - bullet | skipped and counted, not a violation | markdown skip classes |
| S-021 | line wrapped in ``` fence / # heading / - bullet | skipped and counted, not a violation | markdown skip classes |
| S-022 | enum written as USER_TO_OTHER | decodes to the stored long form | enum drift tolerated |
| S-023 | enum written as Deadline | decodes to the stored long form | enum drift tolerated |
| S-024 | enum written as first_person | decodes to the stored long form | enum drift tolerated |
| S-025 | enum written as one_off | decodes to the stored long form | enum drift tolerated |
| S-026 | enum written as a genuinely wrong word (#1) | VIOLATION, not a silent default | wrong word != blank |
| S-027 | enum written as a genuinely wrong word (#2) | VIOLATION, not a silent default | wrong word != blank |
| S-028 | enum written as a genuinely wrong word (#3) | VIOLATION, not a silent default | wrong word != blank |
| S-029 | {due:2026-08-08} in a due field | unwrapped to the date | token wrapper |
| S-030 | {conf:0.8} in a DUE field | VIOLATION — key must match field | key/field match |
| S-031 | bare {due} | '' meaning not stated; no date invented | never invent |
| S-032 | prose field containing a / character (#1) | tail re-joined, kept whole | prose is always last |
| S-033 | prose field containing a / character (#2) | tail re-joined, kept whole | prose is always last |
| S-034 | prose field containing a / character (#3) | tail re-joined, kept whole | prose is always last |
| S-035 | prose field containing a / character (#4) | tail re-joined, kept whole | prose is always last |
| S-036 | surplus field on a tag ending in machine fields | field_count violation | no slack where none is safe |
| S-037 | surplus field on a tag ending in machine fields | field_count violation | no slack where none is safe |
| S-038 | surplus field on a tag ending in machine fields | field_count violation | no slack where none is safe |
| S-039 | event list 12-15 | base-36 INCLUSIVE decode; runs>=3 compress | range encoding |
| S-040 | event list c-f | base-36 INCLUSIVE decode; runs>=3 compress | range encoding |
| S-041 | event list 7,8,12-15 | base-36 INCLUSIVE decode; runs>=3 compress | range encoding |
| S-042 | alias a9 cited with a roster of 7 | resolves to null, NOT a string match | range-check resolution |
| S-043 | whole answer was prose | EXACTLY ONE no_wire_lines violation | one violation for the answer |
| S-044 | parse of a mixed batch (#1) | accepted + violations + skipped == non_blank_lines | accounting invariant |
| S-045 | parse of a mixed batch (#2) | accepted + violations + skipped == non_blank_lines | accounting invariant |
| S-046 | parse of a mixed batch (#3) | accepted + violations + skipped == non_blank_lines | accounting invariant |
| S-047 | two damaged lines out of five | repair round re-asks ONLY those two; accepted lines kept | bounded repair |
| S-048 | repair round fails again | violations retained; NO loop | one repair round only |
| S-049 | wire vs JSON path on the gold set | EQUAL parsed results | A/B correctness gate |
| S-050 | token saving measured | REPORTED, never asserted | a token assertion is a flake |

### T — SCHED (30)

_Latency gates, critical path, streaming, two-pass_

| ID | Given | Expect | Assert |
|---|---|---|---|
| T-001 | cold connect with existing history | first claim rendered <=30s | LATENCY GATE |
| T-002 | cold connect | spaces and tasks visible <=120s | THE 120s GATE |
| T-003 | first-paint path inspected | exactly ONE LLM call (P-CL1) | one-call critical path |
| T-004 | P-EP1 on the first-paint path | FAIL — must be deferred | deferred stages |
| T-005 | P-TR1 on the first-paint path | FAIL — must be deferred | deferred stages |
| T-006 | P-SP1 on the first-paint path | FAIL — must be deferred | deferred stages |
| T-007 | media enrichment on the first-paint path | FAIL — must be deferred | deferred stages |
| T-008 | P-AG1 executed before first paint | FAIL — barred by rule | adjudicators never on the path |
| T-009 | P-AG2 executed before first paint | FAIL — barred by rule | adjudicators never on the path |
| T-010 | P-AG3 executed before first paint | FAIL — barred by rule | adjudicators never on the path |
| T-011 | claims rendered | streamed line by line as they arrive, not after call completion | STW-2 line streaming |
| T-012 | Lane E during first paint | ZERO LLM slots | slot reservation |
| T-013 | cohort 0 sizing | by expected OUTPUT TOKENS (~600), not session count | right sizing axis |
| T-014 | CLI child at connect time | pre-warmed before the clock starts | spawn cost paid early |
| T-015 | cohort seq 0 | budget = min(MAX, BASE x 2^0) | adaptive ramp |
| T-016 | cohort seq 1 | budget = min(MAX, BASE x 2^1) | adaptive ramp |
| T-017 | steady state: new message arrives | claims visible <= live_interval + 15s | live trigger latency |
| T-018 | live_interval set to 6h | live trigger effectively never fires; pure seal-time behaviour | configurable range 30s-6h |
| T-019 | live pass on a 40-message session | DELTA only; tokens O(n) not O(n^2) | delta mandatory at 30s |
| T-020 | chatty stream, 50 msgs in 10min | backpressure lengthens effective interval; shown in UI | visible backpressure |
| T-021 | live passes on one stream in an hour | <= 20 | hard cap |
| T-022 | seal with unchanged content hash | consolidation pass SKIPPED | hash gate |
| T-023 | silent gap during import (#1) | <= 90s while cohorts remain (excl. quota pause) | no-stall gate |
| T-024 | silent gap during import (#2) | <= 90s while cohorts remain (excl. quota pause) | no-stall gate |
| T-025 | silent gap during import (#3) | <= 90s while cohorts remain (excl. quota pause) | no-stall gate |
| T-026 | quota pause occurs | countdown rendered; retry budget NOT spent | pause is not a stall |
| T-027 | coverage meter during import | monotonic, never regresses | progress legibility |
| T-028 | episode with media | exactly 2 passes: text-only, then complete | two-pass model |
| T-029 | late transcript arrives | re-read in the SAME session/episode/roster | context preserved |
| T-030 | reprocess count per episode | <= 3 | bounded |

### U — ACCT (15)

_4-way tokens, cost correctness, caching reality_

| ID | Given | Expect | Assert |
|---|---|---|---|
| U-001 | any run row | total_input == cache_read + cache_creation + input_tokens | the identity must hold |
| U-002 | input_tokens rendered as total input | FAIL | input_tokens is post-breakpoint only |
| U-003 | Usage UI shows Input 21,849 next to Cache 21,846 | FAIL — same tokens twice | no double presentation |
| U-004 | cost and tokens aggregated | same filter, same row set | the '—' cost bug |
| U-005 | run without role or cohort_id | FAIL | attribution mandatory |
| U-006 | quota gate input | billable = input + 1.25*cache_create + 0.1*cache_read + output | never a raw sum |
| U-007 | cost value shown | verbatim from the CLI's reported total_cost_usd | never recomputed locally |
| U-008 | block labelled 'Chat' containing background extraction | FAIL | truthful labels |
| U-009 | before a bootstrap | projected cost shown from event count x tokens/event | estimate before spend |
| U-010 | during a bootstrap | spend-to-date and projection shown | live cost visibility |
| U-011 | haiku call with a 1.2k-token prompt | cache fields both 0 — expected, below the 4096 minimum | documented, not a bug |
| U-012 | cache hit rate | measured and surfaced, never assumed | measure don't assume |
| U-013 | 8 parallel calls sharing a prefix, warm_first=on | first call completes before fan-out | warm-then-fan-out |
| U-014 | 8 parallel calls issued simultaneously with warm_first=on | FAIL | all-miss + write premium |
| U-015 | runs table after a full import | every call has 4-way tokens + cost + model + role | complete accounting |

### V — CALIB (15)

_Embedder floor, normalisation, per-use-case_

| ID | Given | Expect | Assert |
|---|---|---|---|
| V-001 | measure e5 floor from 1000 random unrelated pairs | floor ~0.75-0.85 persisted per (model,use_case) | floor is measured |
| V-002 | measure e5 floor from 1500 random unrelated pairs | floor ~0.75-0.85 persisted per (model,use_case) | floor is measured |
| V-003 | measure e5 floor from 2000 random unrelated pairs | floor ~0.75-0.85 persisted per (model,use_case) | floor is measured |
| V-004 | raw cosine 0.86, floor 0.83 | normalised ~0.24 | score=(cos-floor)/(1-floor) |
| V-005 | raw cosine 0.93, floor 0.83 | normalised ~0.65 | score=(cos-floor)/(1-floor) |
| V-006 | raw cosine 0.97, floor 0.83 | normalised ~0.88 | score=(cos-floor)/(1-floor) |
| V-007 | raw cosine 0.8, floor 0.83 | normalised ~0.0 | score=(cos-floor)/(1-floor) |
| V-008 | raw cosine 0.89, floor 0.83 | normalised ~0.41 | score=(cos-floor)/(1-floor) |
| V-009 | use_case entity_name | its own threshold row; arc_topic bar > episode_topic | per-use-case thresholds |
| V-010 | use_case entity_rich_text | its own threshold row; arc_topic bar > episode_topic | per-use-case thresholds |
| V-011 | use_case episode_topic | its own threshold row; arc_topic bar > episode_topic | per-use-case thresholds |
| V-012 | use_case arc_topic | its own threshold row; arc_topic bar > episode_topic | per-use-case thresholds |
| V-013 | use_case claim_text | its own threshold row; arc_topic bar > episode_topic | per-use-case thresholds |
| V-014 | use_case loop_intent | its own threshold row; arc_topic bar > episode_topic | per-use-case thresholds |
| V-015 | embedding model swapped | floor re-measured at startup; similarity rungs blocked until then | stale calib blocks |
