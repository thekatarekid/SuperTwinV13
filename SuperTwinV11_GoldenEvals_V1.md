# SuperTwinV11 — Golden Evals V1

**1,000 labelled evals** for the chunking build (Phase 1 + Phase 2). Human-reviewable source of truth; the harness materialises each row into a JSON fixture (frozen events in, expected labels out) keyed by the eval ID.

## Format

1. **ID** — stable key (`<CAT>-<n>`); fixtures live at `evals/fixtures/<ID>.json`.
2. **Context** — stream kind / source / sub-area under test.
3. **Input** — compact scenario; the fixture holds the full synthetic events.
4. **Expected** — the label the pipeline must produce.
5. **Why** — the rule under test (traces to the Phase 1/2 docs).

Determinism rule: `[CODE]`-only categories (A–E, I, L-partial) must match **exactly**; model categories (F partial, G, H, J, K) are scored against gates in the Phase docs (§14 Phase 1, §11 Phase 2). Model-call fixtures freeze verdicts so the suite runs offline.

## Coverage

| Cat | Name | Count | Tests |
|---|---|---|---|
| A | SESS-CONV | 180 | Session boundaries — conversation streams (WhatsApp/Slack-shaped) |
| B | SESS-DOC | 60 | Session boundaries — document streams (Docs/Notes sittings) |
| C | SESS-ACT | 80 | Session boundaries — activity streams (browser/commerce/watch) |
| D | SESS-AMB | 60 | Session boundaries — ambient streams (screen/voice) + prefilter |
| E | SESS-BND | 40 | Session boundaries — bounded records (calendar/meetings/rides) |
| F | ENT-RES | 170 | Entity identity resolution (bind/merge/split/negative/me) |
| G | ENT-MEN | 90 | Mention linking (roster, pronouns, hints, ambiguity) |
| H | ENT-EDGE | 70 | Relations / edges (family, work, care, metadata edges, validity) |
| I | ENR | 30 | Enrichment executor routing (LLM-S vs ML vs CODE) |
| J | EPI | 100 | Episodes (1:1 default, split, attach, aging, replay) — Phase 2 |
| K | ARC | 100 | Arcs (bridges, overlap, similarity, adjudication, aging) — Phase 2 |
| L | CAL | 20 | Embedder calibration (floor, normalisation, per-use-case) |
| — | **Total** | **1000** | |

## A — SESS-CONV (180)

_Session boundaries — conversation streams (WhatsApp/Slack-shaped)_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| A-001 | conversation · WhatsApp 1:1 Pranjali | msg 'lunch?' at t0; next msg at t0+5h59m; stream G=6h | NO cut | just under G=6h |
| A-002 | conversation · WhatsApp 1:1 Pranjali | msg 'sent the doc' at t0; next msg at t0+6h01m; stream G=6h | CUT (gap) | just over G=6h |
| A-003 | conversation · WhatsApp 1:1 Pranjali | msg voice note at t0; next msg at t0+30m; stream G=6h | NO cut | well under G |
| A-004 | conversation · WhatsApp 1:1 Pranjali | msg 'ok done' at t0; next msg at t0+2h; stream G=6h | NO cut | under G |
| A-005 | conversation · WhatsApp 1:1 Pranjali | msg photo of menu at t0; next msg at t0+7h; stream G=6h | CUT (gap) | over G |
| A-006 | conversation · WhatsApp 1:1 Pranjali | msg 'call me when free' at t0; next msg at t0+12h; stream G=6h | CUT (gap) | far over G |
| A-007 | conversation · WhatsApp 1:1 Pranjali | msg 'reached' at t0; next msg at t0+5h30m; stream G=6h | NO cut | under G |
| A-008 | conversation · WhatsApp 1:1 Pranjali | msg link to listing at t0; next msg at t0+6h30m; stream G=6h | CUT (gap) | over G |
| A-009 | conversation · WhatsApp 1:1 Rahul | msg 'lunch?' at t0; next msg at t0+5h59m; stream G=6h | NO cut | just under G=6h |
| A-010 | conversation · WhatsApp 1:1 Rahul | msg 'sent the doc' at t0; next msg at t0+6h01m; stream G=6h | CUT (gap) | just over G=6h |
| A-011 | conversation · WhatsApp 1:1 Rahul | msg voice note at t0; next msg at t0+30m; stream G=6h | NO cut | well under G |
| A-012 | conversation · WhatsApp 1:1 Rahul | msg 'ok done' at t0; next msg at t0+2h; stream G=6h | NO cut | under G |
| A-013 | conversation · WhatsApp 1:1 Rahul | msg photo of menu at t0; next msg at t0+7h; stream G=6h | CUT (gap) | over G |
| A-014 | conversation · WhatsApp 1:1 Rahul | msg 'call me when free' at t0; next msg at t0+12h; stream G=6h | CUT (gap) | far over G |
| A-015 | conversation · WhatsApp 1:1 Rahul | msg 'reached' at t0; next msg at t0+5h30m; stream G=6h | NO cut | under G |
| A-016 | conversation · WhatsApp 1:1 Rahul | msg link to listing at t0; next msg at t0+6h30m; stream G=6h | CUT (gap) | over G |
| A-017 | conversation · WhatsApp 1:1 Rashmi | msg 'lunch?' at t0; next msg at t0+5h59m; stream G=6h | NO cut | just under G=6h |
| A-018 | conversation · WhatsApp 1:1 Rashmi | msg 'sent the doc' at t0; next msg at t0+6h01m; stream G=6h | CUT (gap) | just over G=6h |
| A-019 | conversation · WhatsApp 1:1 Rashmi | msg voice note at t0; next msg at t0+30m; stream G=6h | NO cut | well under G |
| A-020 | conversation · WhatsApp 1:1 Rashmi | msg 'ok done' at t0; next msg at t0+2h; stream G=6h | NO cut | under G |
| A-021 | conversation · WhatsApp 1:1 Rashmi | msg photo of menu at t0; next msg at t0+7h; stream G=6h | CUT (gap) | over G |
| A-022 | conversation · WhatsApp 1:1 Rashmi | msg 'call me when free' at t0; next msg at t0+12h; stream G=6h | CUT (gap) | far over G |
| A-023 | conversation · WhatsApp 1:1 Rashmi | msg 'reached' at t0; next msg at t0+5h30m; stream G=6h | NO cut | under G |
| A-024 | conversation · WhatsApp 1:1 Rashmi | msg link to listing at t0; next msg at t0+6h30m; stream G=6h | CUT (gap) | over G |
| A-025 | conversation · WhatsApp 1:1 Sudhir | msg 'lunch?' at t0; next msg at t0+5h59m; stream G=6h | NO cut | just under G=6h |
| A-026 | conversation · WhatsApp 1:1 Sudhir | msg 'sent the doc' at t0; next msg at t0+6h01m; stream G=6h | CUT (gap) | just over G=6h |
| A-027 | conversation · WhatsApp 1:1 Sudhir | msg voice note at t0; next msg at t0+30m; stream G=6h | NO cut | well under G |
| A-028 | conversation · WhatsApp 1:1 Sudhir | msg 'ok done' at t0; next msg at t0+2h; stream G=6h | NO cut | under G |
| A-029 | conversation · WhatsApp 1:1 Sudhir | msg photo of menu at t0; next msg at t0+7h; stream G=6h | CUT (gap) | over G |
| A-030 | conversation · WhatsApp 1:1 Sudhir | msg 'call me when free' at t0; next msg at t0+12h; stream G=6h | CUT (gap) | far over G |
| A-031 | conversation · WhatsApp 1:1 Sudhir | msg 'reached' at t0; next msg at t0+5h30m; stream G=6h | NO cut | under G |
| A-032 | conversation · WhatsApp 1:1 Sudhir | msg link to listing at t0; next msg at t0+6h30m; stream G=6h | CUT (gap) | over G |
| A-033 | conversation · WhatsApp 1:1 Hrishikesh | msg 'lunch?' at t0; next msg at t0+5h59m; stream G=6h | NO cut | just under G=6h |
| A-034 | conversation · WhatsApp 1:1 Hrishikesh | msg 'sent the doc' at t0; next msg at t0+6h01m; stream G=6h | CUT (gap) | just over G=6h |
| A-035 | conversation · WhatsApp 1:1 Hrishikesh | msg voice note at t0; next msg at t0+30m; stream G=6h | NO cut | well under G |
| A-036 | conversation · WhatsApp 1:1 Hrishikesh | msg 'ok done' at t0; next msg at t0+2h; stream G=6h | NO cut | under G |
| A-037 | conversation · WhatsApp 1:1 Hrishikesh | msg photo of menu at t0; next msg at t0+7h; stream G=6h | CUT (gap) | over G |
| A-038 | conversation · WhatsApp 1:1 Hrishikesh | msg 'call me when free' at t0; next msg at t0+12h; stream G=6h | CUT (gap) | far over G |
| A-039 | conversation · WhatsApp 1:1 Hrishikesh | msg 'reached' at t0; next msg at t0+5h30m; stream G=6h | NO cut | under G |
| A-040 | conversation · WhatsApp 1:1 Hrishikesh | msg link to listing at t0; next msg at t0+6h30m; stream G=6h | CUT (gap) | over G |
| A-041 | conversation · WhatsApp 1:1 Gargi | msg 'lunch?' at t0; next msg at t0+5h59m; stream G=6h | NO cut | just under G=6h |
| A-042 | conversation · WhatsApp 1:1 Gargi | msg 'sent the doc' at t0; next msg at t0+6h01m; stream G=6h | CUT (gap) | just over G=6h |
| A-043 | conversation · WhatsApp 1:1 Gargi | msg voice note at t0; next msg at t0+30m; stream G=6h | NO cut | well under G |
| A-044 | conversation · WhatsApp 1:1 Gargi | msg 'ok done' at t0; next msg at t0+2h; stream G=6h | NO cut | under G |
| A-045 | conversation · WhatsApp 1:1 Gargi | msg photo of menu at t0; next msg at t0+7h; stream G=6h | CUT (gap) | over G |
| A-046 | conversation · WhatsApp 1:1 Gargi | msg 'call me when free' at t0; next msg at t0+12h; stream G=6h | CUT (gap) | far over G |
| A-047 | conversation · WhatsApp 1:1 Gargi | msg 'reached' at t0; next msg at t0+5h30m; stream G=6h | NO cut | under G |
| A-048 | conversation · WhatsApp 1:1 Gargi | msg link to listing at t0; next msg at t0+6h30m; stream G=6h | CUT (gap) | over G |
| A-049 | conversation · WhatsApp 1:1 Keerti | msg 'lunch?' at t0; next msg at t0+5h59m; stream G=6h | NO cut | just under G=6h |
| A-050 | conversation · WhatsApp 1:1 Keerti | msg 'sent the doc' at t0; next msg at t0+6h01m; stream G=6h | CUT (gap) | just over G=6h |
| A-051 | conversation · WhatsApp 1:1 Keerti | msg voice note at t0; next msg at t0+30m; stream G=6h | NO cut | well under G |
| A-052 | conversation · WhatsApp 1:1 Keerti | msg 'ok done' at t0; next msg at t0+2h; stream G=6h | NO cut | under G |
| A-053 | conversation · WhatsApp 1:1 Keerti | msg photo of menu at t0; next msg at t0+7h; stream G=6h | CUT (gap) | over G |
| A-054 | conversation · WhatsApp 1:1 Keerti | msg 'call me when free' at t0; next msg at t0+12h; stream G=6h | CUT (gap) | far over G |
| A-055 | conversation · WhatsApp 1:1 Keerti | msg 'reached' at t0; next msg at t0+5h30m; stream G=6h | NO cut | under G |
| A-056 | conversation · WhatsApp 1:1 Keerti | msg link to listing at t0; next msg at t0+6h30m; stream G=6h | CUT (gap) | over G |
| A-057 | conversation · WhatsApp 1:1 Prabhat | msg 'lunch?' at t0; next msg at t0+5h59m; stream G=6h | NO cut | just under G=6h |
| A-058 | conversation · WhatsApp 1:1 Prabhat | msg 'sent the doc' at t0; next msg at t0+6h01m; stream G=6h | CUT (gap) | just over G=6h |
| A-059 | conversation · WhatsApp 1:1 Prabhat | msg voice note at t0; next msg at t0+30m; stream G=6h | NO cut | well under G |
| A-060 | conversation · WhatsApp 1:1 Prabhat | msg 'ok done' at t0; next msg at t0+2h; stream G=6h | NO cut | under G |
| A-061 | conversation · WhatsApp 1:1 Prabhat | msg photo of menu at t0; next msg at t0+7h; stream G=6h | CUT (gap) | over G |
| A-062 | conversation · WhatsApp 1:1 Prabhat | msg 'call me when free' at t0; next msg at t0+12h; stream G=6h | CUT (gap) | far over G |
| A-063 | conversation · WhatsApp 1:1 Prabhat | msg 'reached' at t0; next msg at t0+5h30m; stream G=6h | NO cut | under G |
| A-064 | conversation · WhatsApp 1:1 Prabhat | msg link to listing at t0; next msg at t0+6h30m; stream G=6h | CUT (gap) | over G |
| A-065 | conversation · WhatsApp group Ghar+ | burst ends t0; next msg t0+3h50m; group override G=4h | NO cut | group G=4h override governs, not the 6h default |
| A-066 | conversation · WhatsApp group Ghar+ | burst ends t0; next msg t0+4h10m; group override G=4h | CUT (gap) | group G=4h override governs, not the 6h default |
| A-067 | conversation · WhatsApp group Ghar+ | burst ends t0; next msg t0+5h; group override G=4h | CUT (gap) | group G=4h override governs, not the 6h default |
| A-068 | conversation · WhatsApp group Ghar+ | burst ends t0; next msg t0+2h; group override G=4h | NO cut | group G=4h override governs, not the 6h default |
| A-069 | conversation · WhatsApp group Goa Crew | burst ends t0; next msg t0+3h50m; group override G=4h | NO cut | group G=4h override governs, not the 6h default |
| A-070 | conversation · WhatsApp group Goa Crew | burst ends t0; next msg t0+4h10m; group override G=4h | CUT (gap) | group G=4h override governs, not the 6h default |
| A-071 | conversation · WhatsApp group Goa Crew | burst ends t0; next msg t0+5h; group override G=4h | CUT (gap) | group G=4h override governs, not the 6h default |
| A-072 | conversation · WhatsApp group Goa Crew | burst ends t0; next msg t0+2h; group override G=4h | NO cut | group G=4h override governs, not the 6h default |
| A-073 | conversation · WhatsApp group Family | burst ends t0; next msg t0+3h50m; group override G=4h | NO cut | group G=4h override governs, not the 6h default |
| A-074 | conversation · WhatsApp group Family | burst ends t0; next msg t0+4h10m; group override G=4h | CUT (gap) | group G=4h override governs, not the 6h default |
| A-075 | conversation · WhatsApp group Family | burst ends t0; next msg t0+5h; group override G=4h | CUT (gap) | group G=4h override governs, not the 6h default |
| A-076 | conversation · WhatsApp group Family | burst ends t0; next msg t0+2h; group override G=4h | NO cut | group G=4h override governs, not the 6h default |
| A-077 | conversation · WhatsApp group Office Frandss | burst ends t0; next msg t0+3h50m; group override G=4h | NO cut | group G=4h override governs, not the 6h default |
| A-078 | conversation · WhatsApp group Office Frandss | burst ends t0; next msg t0+4h10m; group override G=4h | CUT (gap) | group G=4h override governs, not the 6h default |
| A-079 | conversation · WhatsApp group Office Frandss | burst ends t0; next msg t0+5h; group override G=4h | CUT (gap) | group G=4h override governs, not the 6h default |
| A-080 | conversation · WhatsApp group Office Frandss | burst ends t0; next msg t0+2h; group override G=4h | NO cut | group G=4h override governs, not the 6h default |
| A-081 | conversation · WhatsApp 1:1 Rajat | msgs at 23:50 and 00:10 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-082 | conversation · WhatsApp 1:1 Rajat | msgs at 23:58 and 00:02 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-083 | conversation · WhatsApp 1:1 Rajat | msgs at 22:00 and 00:30 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-084 | conversation · WhatsApp 1:1 Rajat | msgs at 23:30 and 01:00 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-085 | conversation · WhatsApp 1:1 Mansi | msgs at 23:50 and 00:10 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-086 | conversation · WhatsApp 1:1 Mansi | msgs at 23:58 and 00:02 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-087 | conversation · WhatsApp 1:1 Mansi | msgs at 22:00 and 00:30 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-088 | conversation · WhatsApp 1:1 Mansi | msgs at 23:30 and 01:00 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-089 | conversation · WhatsApp 1:1 Natesh | msgs at 23:50 and 00:10 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-090 | conversation · WhatsApp 1:1 Natesh | msgs at 23:58 and 00:02 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-091 | conversation · WhatsApp 1:1 Natesh | msgs at 22:00 and 00:30 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-092 | conversation · WhatsApp 1:1 Natesh | msgs at 23:30 and 01:00 next day, gap < G, stream tz Asia/Kolkata | CUT (day_boundary) | sessions never cross local midnight |
| A-093 | conversation · WhatsApp group Ghar+ | 41 continuous msgs, no gap ever > 10m | CUT at event #40 (size_cap), continue new session | hard cap 40 events prevents unbounded chunk |
| A-094 | conversation · WhatsApp group Ghar+ | 55 continuous msgs, no gap ever > 10m | CUT at event #40 (size_cap), continue new session | hard cap 40 events prevents unbounded chunk |
| A-095 | conversation · WhatsApp group Ghar+ | 80 continuous msgs, no gap ever > 10m | CUT at event #40 (size_cap), continue new session | hard cap 40 events prevents unbounded chunk |
| A-096 | conversation · WhatsApp group Ghar+ | 120 continuous msgs, no gap ever > 10m | CUT at event #40 (size_cap), continue new session | hard cap 40 events prevents unbounded chunk |
| A-097 | conversation · WhatsApp 1:1 Pranjali | long pasted texts totalling 6200 tokens across 12 msgs | CUT when 6,000-token cap crossed (size_cap) | token cap fires before event cap |
| A-098 | conversation · WhatsApp 1:1 Pranjali | long pasted texts totalling 9000 tokens across 12 msgs | CUT when 6,000-token cap crossed (size_cap) | token cap fires before event cap |
| A-099 | conversation · WhatsApp group Ghar+ | gap 20m (< shift min-gap 1h), then Pranjali initiates a new subject | NO cut | shift is a conjunction: initiator-flip below min-gap never cuts |
| A-100 | conversation · WhatsApp group Goa Crew | gap 90m (> shift min-gap 1h), then Rahul (silent all prior burst) initiates a new subject | CUT (participant_shift) | gap ≥ min-gap AND initiator-flip = boundary; both params recorded |
| A-101 | conversation · WhatsApp group Family | gap 90m (> shift min-gap 1h), then Rashmi (silent all prior burst) initiates a new subject | CUT (participant_shift) | gap ≥ min-gap AND initiator-flip = boundary; both params recorded |
| A-102 | conversation · WhatsApp group Office Frandss | gap 20m (< shift min-gap 1h), then Sudhir initiates a new subject | NO cut | shift is a conjunction: initiator-flip below min-gap never cuts |
| A-103 | conversation · WhatsApp group Ghar+ | gap 90m (> shift min-gap 1h), then Hrishikesh (silent all prior burst) initiates a new subject | CUT (participant_shift) | gap ≥ min-gap AND initiator-flip = boundary; both params recorded |
| A-104 | conversation · WhatsApp group Goa Crew | gap 90m (> shift min-gap 1h), then Gargi (silent all prior burst) initiates a new subject | CUT (participant_shift) | gap ≥ min-gap AND initiator-flip = boundary; both params recorded |
| A-105 | conversation · WhatsApp group Family | gap 20m (< shift min-gap 1h), then Keerti initiates a new subject | NO cut | shift is a conjunction: initiator-flip below min-gap never cuts |
| A-106 | conversation · WhatsApp group Office Frandss | gap 90m (> shift min-gap 1h), then Prabhat (silent all prior burst) initiates a new subject | CUT (participant_shift) | gap ≥ min-gap AND initiator-flip = boundary; both params recorded |
| A-107 | conversation · WhatsApp group Ghar+ | gap 90m (> shift min-gap 1h), then Rajat (silent all prior burst) initiates a new subject | CUT (participant_shift) | gap ≥ min-gap AND initiator-flip = boundary; both params recorded |
| A-108 | conversation · WhatsApp group Goa Crew | gap 20m (< shift min-gap 1h), then Mansi initiates a new subject | NO cut | shift is a conjunction: initiator-flip below min-gap never cuts |
| A-109 | conversation · WhatsApp group Family | gap 90m (> shift min-gap 1h), then Natesh (silent all prior burst) initiates a new subject | CUT (participant_shift) | gap ≥ min-gap AND initiator-flip = boundary; both params recorded |
| A-110 | conversation · WhatsApp group Office Frandss | gap 90m (> shift min-gap 1h), then Shivangi (silent all prior burst) initiates a new subject | CUT (participant_shift) | gap ≥ min-gap AND initiator-flip = boundary; both params recorded |
| A-111 | conversation · WhatsApp 1:1 Pranjali | msg replies (quoted) to a message 2 days old | NEW session (reply_break), linked via reply_to; old session stays sealed | a reply targeting an event older than G starts a new session |
| A-112 | conversation · WhatsApp 1:1 Rahul | msg replies (quoted) to a message 3 days old | NEW session (reply_break), linked via reply_to; old session stays sealed | a reply targeting an event older than G starts a new session |
| A-113 | conversation · WhatsApp 1:1 Rashmi | msg replies (quoted) to a message 4 days old | NEW session (reply_break), linked via reply_to; old session stays sealed | a reply targeting an event older than G starts a new session |
| A-114 | conversation · WhatsApp 1:1 Sudhir | msg replies (quoted) to a message 5 days old | NEW session (reply_break), linked via reply_to; old session stays sealed | a reply targeting an event older than G starts a new session |
| A-115 | conversation · WhatsApp 1:1 Hrishikesh | msg replies (quoted) to a message 6 days old | NEW session (reply_break), linked via reply_to; old session stays sealed | a reply targeting an event older than G starts a new session |
| A-116 | conversation · WhatsApp 1:1 Gargi | msg replies (quoted) to a message 7 days old | NEW session (reply_break), linked via reply_to; old session stays sealed | a reply targeting an event older than G starts a new session |
| A-117 | conversation · WhatsApp 1:1 Pranjali | 👍 reaction arrives 3h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-118 | conversation · WhatsApp 1:1 Rahul | 👍 reaction arrives 4h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-119 | conversation · WhatsApp 1:1 Rashmi | 👍 reaction arrives 5h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-120 | conversation · WhatsApp 1:1 Sudhir | 👍 reaction arrives 6h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-121 | conversation · WhatsApp 1:1 Hrishikesh | 👍 reaction arrives 7h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-122 | conversation · WhatsApp 1:1 Gargi | 👍 reaction arrives 8h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-123 | conversation · WhatsApp 1:1 Keerti | 👍 reaction arrives 9h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-124 | conversation · WhatsApp 1:1 Prabhat | 👍 reaction arrives 10h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-125 | conversation · WhatsApp 1:1 Rajat | 👍 reaction arrives 11h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-126 | conversation · WhatsApp 1:1 Mansi | 👍 reaction arrives 12h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-127 | conversation · WhatsApp 1:1 Natesh | 👍 reaction arrives 13h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-128 | conversation · WhatsApp 1:1 Shivangi | 👍 reaction arrives 14h after target msg; target's session sealed | attach reaction to parent's sealed session; NO new session; NO debounce reset | a reaction is not a conversation; sessions stay honest |
| A-129 | conversation · WhatsApp · edit handling | edit event; parent in open session | edit mutates event in place; hash unaffected until seal | sealed sessions are immutable in membership; content change is flagged, not merged |
| A-130 | conversation · WhatsApp · edit handling | edit event; parent in sealed session | store edit; attach to parent session; set superseded_hash | sealed sessions are immutable in membership; content change is flagged, not merged |
| A-131 | conversation · WhatsApp · edit handling | edit event; parent in sealed session, edit twice | one superseded_hash flag; both edits stored | sealed sessions are immutable in membership; content change is flagged, not merged |
| A-132 | conversation · WhatsApp · edit handling | edit event; parent in open session, edit then gap 7h | edited text is what the sealed session hashes | sealed sessions are immutable in membership; content change is flagged, not merged |
| A-133 | conversation · WhatsApp · edit handling | edit event; parent in sealed session of another stream | edit routes by parent external_id, not stream | sealed sessions are immutable in membership; content change is flagged, not merged |
| A-134 | conversation · WhatsApp · revoke | revoke arrives for msg in open session | mark event revoked; membership unchanged; superseded_hash set if sealed | revocation is a state change, never a membership change |
| A-135 | conversation · WhatsApp · revoke | revoke arrives for msg in sealed session | mark event revoked; membership unchanged; superseded_hash set if sealed | revocation is a state change, never a membership change |
| A-136 | conversation · WhatsApp · revoke | revoke arrives for msg in sealed session | mark event revoked; membership unchanged; superseded_hash set if sealed | revocation is a state change, never a membership change |
| A-137 | conversation · live · Pranjali | silence for 20m after last msg; debounce_ms=45m | NO seal yet | seal fires on debounce expiry, not on next message |
| A-138 | conversation · live · Rahul | silence for 44m after last msg; debounce_ms=45m | NO seal (default 45m) | seal fires on debounce expiry, not on next message |
| A-139 | conversation · live · Rashmi | silence for 46m after last msg; debounce_ms=45m | SEAL (debounce) | seal fires on debounce expiry, not on next message |
| A-140 | conversation · live · Sudhir | silence for 60m after last msg; debounce_ms=45m | SEAL (debounce) | seal fires on debounce expiry, not on next message |
| A-141 | conversation · live · Hrishikesh | silence for 45m after last msg; debounce_ms=45m | SEAL at exactly 45m | seal fires on debounce expiry, not on next message |
| A-142 | conversation · live · Gargi | silence for 30m after last msg; debounce_ms=45m | NO seal | seal fires on debounce expiry, not on next message |
| A-143 | conversation · live · Keerti | silence for 90m after last msg; debounce_ms=45m | SEAL (debounce) | seal fires on debounce expiry, not on next message |
| A-144 | conversation · slow trickle chat | 1 msg every 3h for 30h, never a 6h gap | SEAL at 24h ceiling; remainder opens new session | a session may never stay open past 24h |
| A-145 | conversation · slow trickle chat | 1 msg every 4h for 30h, never a 6h gap | SEAL at 24h ceiling; remainder opens new session | a session may never stay open past 24h |
| A-146 | conversation · slow trickle chat | 1 msg every 5h for 30h, never a 6h gap | SEAL at 24h ceiling; remainder opens new session | a session may never stay open past 24h |
| A-147 | conversation · slow trickle chat | 1 msg every 6h for 30h, never a 6h gap | SEAL at 24h ceiling; remainder opens new session | a session may never stay open past 24h |
| A-148 | conversation · backfill overlap · Pranjali | backfilled msg ts falls inside an already-sealed session's range | NEW session flagged late_arrival, overlap_of=sealed id; sealed session untouched | sealed sessions are never reopened |
| A-149 | conversation · backfill overlap · Rahul | backfilled msg ts falls inside an already-sealed session's range | NEW session flagged late_arrival, overlap_of=sealed id; sealed session untouched | sealed sessions are never reopened |
| A-150 | conversation · backfill overlap · Rashmi | backfilled msg ts falls inside an already-sealed session's range | NEW session flagged late_arrival, overlap_of=sealed id; sealed session untouched | sealed sessions are never reopened |
| A-151 | conversation · backfill overlap · Sudhir | backfilled msg ts falls inside an already-sealed session's range | NEW session flagged late_arrival, overlap_of=sealed id; sealed session untouched | sealed sessions are never reopened |
| A-152 | conversation · backfill overlap · Hrishikesh | backfilled msg ts falls inside an already-sealed session's range | NEW session flagged late_arrival, overlap_of=sealed id; sealed session untouched | sealed sessions are never reopened |
| A-153 | conversation · backfill overlap · Gargi | backfilled msg ts falls inside an already-sealed session's range | NEW session flagged late_arrival, overlap_of=sealed id; sealed session untouched | sealed sessions are never reopened |
| A-154 | conversation · backfill overlap · Keerti | backfilled msg ts falls inside an already-sealed session's range | NEW session flagged late_arrival, overlap_of=sealed id; sealed session untouched | sealed sessions are never reopened |
| A-155 | conversation · backfill overlap · Prabhat | backfilled msg ts falls inside an already-sealed session's range | NEW session flagged late_arrival, overlap_of=sealed id; sealed session untouched | sealed sessions are never reopened |
| A-156 | conversation · 24-month backfill | history chunk 1: same gap rules on old data, ordered by ts not rowid | identical boundaries as if live; is_historical flag only | backfill and live share one segmenter; ordering is ts |
| A-157 | conversation · 24-month backfill | history chunk 2: same gap rules on old data, ordered by ts not rowid | identical boundaries as if live; is_historical flag only | backfill and live share one segmenter; ordering is ts |
| A-158 | conversation · 24-month backfill | history chunk 3: same gap rules on old data, ordered by ts not rowid | identical boundaries as if live; is_historical flag only | backfill and live share one segmenter; ordering is ts |
| A-159 | conversation · 24-month backfill | history chunk 4: same gap rules on old data, ordered by ts not rowid | identical boundaries as if live; is_historical flag only | backfill and live share one segmenter; ordering is ts |
| A-160 | conversation · 24-month backfill | history chunk 5: same gap rules on old data, ordered by ts not rowid | identical boundaries as if live; is_historical flag only | backfill and live share one segmenter; ordering is ts |
| A-161 | conversation · Pranjali | burst of 6 photos, no text, 2m apart | ONE session; captions (enrichment) included in token cap accounting | media events are events; no special casing |
| A-162 | conversation · Rahul | burst of 6 photos, no text, 2m apart | ONE session; captions (enrichment) included in token cap accounting | media events are events; no special casing |
| A-163 | conversation · Rashmi | burst of 6 photos, no text, 2m apart | ONE session; captions (enrichment) included in token cap accounting | media events are events; no special casing |
| A-164 | conversation · Sudhir | burst of 6 photos, no text, 2m apart | ONE session; captions (enrichment) included in token cap accounting | media events are events; no special casing |
| A-165 | conversation · Hrishikesh | burst of 6 photos, no text, 2m apart | ONE session; captions (enrichment) included in token cap accounting | media events are events; no special casing |
| A-166 | conversation · business channel Policybazaar | 5 promotional msgs over 3 days, user never replies | sessions cut normally by gap; is_business on events; no participant_shift (single sender) | business streams get no special segmentation, only flags |
| A-167 | conversation · business channel Amazon | 5 promotional msgs over 3 days, user never replies | sessions cut normally by gap; is_business on events; no participant_shift (single sender) | business streams get no special segmentation, only flags |
| A-168 | conversation · business channel Jio | 5 promotional msgs over 3 days, user never replies | sessions cut normally by gap; is_business on events; no participant_shift (single sender) | business streams get no special segmentation, only flags |
| A-169 | conversation · business channel Zomato | 5 promotional msgs over 3 days, user never replies | sessions cut normally by gap; is_business on events; no participant_shift (single sender) | business streams get no special segmentation, only flags |
| A-170 | conversation · business channel HDFC | 5 promotional msgs over 3 days, user never replies | sessions cut normally by gap; is_business on events; no participant_shift (single sender) | business streams get no special segmentation, only flags |
| A-171 | conversation · self-chat (me only) | self-notes at 09:00, 09:05, 19:00 (gap 10h) | CUT at the >6h gap; participant_shift disabled (single actor) | single-actor conversation streams disable shift triggers |
| A-172 | conversation · self-chat (me only) | self-notes at 09:00, 09:05, 19:00 (gap 6h05m) | CUT at the >6h gap; participant_shift disabled (single actor) | single-actor conversation streams disable shift triggers |
| A-173 | conversation · self-chat (me only) | self-notes at 09:00, 09:05, 19:00 (gap 7h) | CUT at the >6h gap; participant_shift disabled (single actor) | single-actor conversation streams disable shift triggers |
| A-174 | conversation · tz Asia/Kolkata | msgs at 23:50 and 00:10 local-to-stream | CUT (day_boundary) computed in the STREAM's tz, not UTC | midnight is local; travel changes are per-stream override |
| A-175 | conversation · tz America/New_York | msgs at 23:50 and 00:10 local-to-stream | CUT (day_boundary) computed in the STREAM's tz, not UTC | midnight is local; travel changes are per-stream override |
| A-176 | conversation · tz Europe/London | msgs at 23:50 and 00:10 local-to-stream | CUT (day_boundary) computed in the STREAM's tz, not UTC | midnight is local; travel changes are per-stream override |
| A-177 | conversation · tz Asia/Dubai | msgs at 23:50 and 00:10 local-to-stream | CUT (day_boundary) computed in the STREAM's tz, not UTC | midnight is local; travel changes are per-stream override |
| A-178 | conversation · tz Asia/Kolkata→America/New_York (travel) | msgs at 23:50 and 00:10 local-to-stream | CUT (day_boundary) computed in the STREAM's tz, not UTC | midnight is local; travel changes are per-stream override |
| A-179 | conversation · skew | msg ts 12 min in the future | clamp to now, flag in structured_json | future timestamps are device bugs, not data |
| A-180 | conversation · skew | msg ts 3 min in the future | accept (≤5m tolerance) | small skew tolerated |

## B — SESS-DOC (60)

_Session boundaries — document streams (Docs/Notes sittings)_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| B-001 | document · Google Docs · rent agreement draft | revision burst; next revision after 20m; doc gap G=45m | NO cut | a sitting ends when the author stops for >45m |
| B-002 | document · Google Docs · rent agreement draft | revision burst; next revision after 40m; doc gap G=45m | NO cut | a sitting ends when the author stops for >45m |
| B-003 | document · Google Docs · rent agreement draft | revision burst; next revision after 50m; doc gap G=45m | CUT (gap) | a sitting ends when the author stops for >45m |
| B-004 | document · Google Docs · rent agreement draft | revision burst; next revision after 2h; doc gap G=45m | CUT (gap) | a sitting ends when the author stops for >45m |
| B-005 | document · Google Docs · Goa budget sheet | revision burst; next revision after 20m; doc gap G=45m | NO cut | a sitting ends when the author stops for >45m |
| B-006 | document · Google Docs · Goa budget sheet | revision burst; next revision after 40m; doc gap G=45m | NO cut | a sitting ends when the author stops for >45m |
| B-007 | document · Google Docs · Goa budget sheet | revision burst; next revision after 50m; doc gap G=45m | CUT (gap) | a sitting ends when the author stops for >45m |
| B-008 | document · Google Docs · Goa budget sheet | revision burst; next revision after 2h; doc gap G=45m | CUT (gap) | a sitting ends when the author stops for >45m |
| B-009 | document · Google Docs · wedding guest list doc | revision burst; next revision after 20m; doc gap G=45m | NO cut | a sitting ends when the author stops for >45m |
| B-010 | document · Google Docs · wedding guest list doc | revision burst; next revision after 40m; doc gap G=45m | NO cut | a sitting ends when the author stops for >45m |
| B-011 | document · Google Docs · wedding guest list doc | revision burst; next revision after 50m; doc gap G=45m | CUT (gap) | a sitting ends when the author stops for >45m |
| B-012 | document · Google Docs · wedding guest list doc | revision burst; next revision after 2h; doc gap G=45m | CUT (gap) | a sitting ends when the author stops for >45m |
| B-013 | document · Google Docs · meeting notes | revision burst; next revision after 20m; doc gap G=45m | NO cut | a sitting ends when the author stops for >45m |
| B-014 | document · Google Docs · meeting notes | revision burst; next revision after 40m; doc gap G=45m | NO cut | a sitting ends when the author stops for >45m |
| B-015 | document · Google Docs · meeting notes | revision burst; next revision after 50m; doc gap G=45m | CUT (gap) | a sitting ends when the author stops for >45m |
| B-016 | document · Google Docs · meeting notes | revision burst; next revision after 2h; doc gap G=45m | CUT (gap) | a sitting ends when the author stops for >45m |
| B-017 | document · Google Docs · recipe note | revision burst; next revision after 20m; doc gap G=45m | NO cut | a sitting ends when the author stops for >45m |
| B-018 | document · Google Docs · recipe note | revision burst; next revision after 40m; doc gap G=45m | NO cut | a sitting ends when the author stops for >45m |
| B-019 | document · Google Docs · recipe note | revision burst; next revision after 50m; doc gap G=45m | CUT (gap) | a sitting ends when the author stops for >45m |
| B-020 | document · Google Docs · recipe note | revision burst; next revision after 2h; doc gap G=45m | CUT (gap) | a sitting ends when the author stops for >45m |
| B-021 | document · Google Docs · rent agreement draft | Pranjali edits 10m after my last revision | CUT (author_shift): their sitting is a separate session | sessions are per-author sittings; collaboration shows as adjacent sessions |
| B-022 | document · Google Docs · Goa budget sheet | Rahul edits 10m after my last revision | CUT (author_shift): their sitting is a separate session | sessions are per-author sittings; collaboration shows as adjacent sessions |
| B-023 | document · Google Docs · wedding guest list doc | Rashmi edits 10m after my last revision | CUT (author_shift): their sitting is a separate session | sessions are per-author sittings; collaboration shows as adjacent sessions |
| B-024 | document · Google Docs · meeting notes | Sudhir edits 10m after my last revision | CUT (author_shift): their sitting is a separate session | sessions are per-author sittings; collaboration shows as adjacent sessions |
| B-025 | document · Google Docs · recipe note | Hrishikesh edits 10m after my last revision | CUT (author_shift): their sitting is a separate session | sessions are per-author sittings; collaboration shows as adjacent sessions |
| B-026 | document · Google Docs · rent agreement draft | Gargi edits 10m after my last revision | CUT (author_shift): their sitting is a separate session | sessions are per-author sittings; collaboration shows as adjacent sessions |
| B-027 | document · Google Docs · Goa budget sheet | Keerti edits 10m after my last revision | CUT (author_shift): their sitting is a separate session | sessions are per-author sittings; collaboration shows as adjacent sessions |
| B-028 | document · Google Docs · wedding guest list doc | Prabhat edits 10m after my last revision | CUT (author_shift): their sitting is a separate session | sessions are per-author sittings; collaboration shows as adjacent sessions |
| B-029 | document · Google Docs · meeting notes | Rajat edits 10m after my last revision | CUT (author_shift): their sitting is a separate session | sessions are per-author sittings; collaboration shows as adjacent sessions |
| B-030 | document · Google Docs · recipe note | Mansi edits 10m after my last revision | CUT (author_shift): their sitting is a separate session | sessions are per-author sittings; collaboration shows as adjacent sessions |
| B-031 | document · Google Sheets · Goa budget sheet | 210 rapid revisions in one sitting | CUT at 200-revision cap, continue | runaway autosave bursts cannot make unbounded sessions |
| B-032 | document · Google Sheets · Goa budget sheet | 250 rapid revisions in one sitting | CUT at 200-revision cap, continue | runaway autosave bursts cannot make unbounded sessions |
| B-033 | document · Google Sheets · Goa budget sheet | 290 rapid revisions in one sitting | CUT at 200-revision cap, continue | runaway autosave bursts cannot make unbounded sessions |
| B-034 | document · Google Sheets · Goa budget sheet | 330 rapid revisions in one sitting | CUT at 200-revision cap, continue | runaway autosave bursts cannot make unbounded sessions |
| B-035 | document · Google Sheets · Goa budget sheet | 370 rapid revisions in one sitting | CUT at 200-revision cap, continue | runaway autosave bursts cannot make unbounded sessions |
| B-036 | document · Apple Notes · rent agreement draft | single edit, nothing before/after for days | ONE single-revision session | a lone edit is still a sitting |
| B-037 | document · Apple Notes · Goa budget sheet | single edit, nothing before/after for days | ONE single-revision session | a lone edit is still a sitting |
| B-038 | document · Apple Notes · wedding guest list doc | single edit, nothing before/after for days | ONE single-revision session | a lone edit is still a sitting |
| B-039 | document · Apple Notes · meeting notes | single edit, nothing before/after for days | ONE single-revision session | a lone edit is still a sitting |
| B-040 | document · Apple Notes · recipe note | single edit, nothing before/after for days | ONE single-revision session | a lone edit is still a sitting |
| B-041 | document · Apple Notes · rent agreement draft | single edit, nothing before/after for days | ONE single-revision session | a lone edit is still a sitting |
| B-042 | document · Apple Notes · Goa budget sheet | single edit, nothing before/after for days | ONE single-revision session | a lone edit is still a sitting |
| B-043 | document · Apple Notes · wedding guest list doc | single edit, nothing before/after for days | ONE single-revision session | a lone edit is still a sitting |
| B-044 | document · Apple Notes · meeting notes | single edit, nothing before/after for days | ONE single-revision session | a lone edit is still a sitting |
| B-045 | document · Apple Notes · recipe note | single edit, nothing before/after for days | ONE single-revision session | a lone edit is still a sitting |
| B-046 | document · Google Slides · pitch deck | slide edits over 20m, max inter-revision gap 10m | ONE sitting (all gaps < 45m) | slides follow the same sitting rules as docs |
| B-047 | document · Google Slides · wedding slideshow | slide edits over 35m, max inter-revision gap 15m | ONE sitting (all gaps < 45m) | slides follow the same sitting rules as docs |
| B-048 | document · Google Slides · review deck | slide edits over 50m, max inter-revision gap 20m | ONE sitting (all gaps < 45m) | slides follow the same sitting rules as docs |
| B-049 | document · Google Slides · trip plan | slide edits over 65m, max inter-revision gap 25m | ONE sitting (all gaps < 45m) | slides follow the same sitting rules as docs |
| B-050 | document · Google Slides · templates | slide edits over 80m, max inter-revision gap 30m | ONE sitting (all gaps < 45m) | slides follow the same sitting rules as docs |
| B-051 | document · Reminders | reminder 'pay rent' created, edited 0× within 5m | ONE single-sitting session per reminder artifact | each reminder is its own artifact stream |
| B-052 | document · Reminders | reminder 'call Didi' created, edited 1× within 5m | ONE single-sitting session per reminder artifact | each reminder is its own artifact stream |
| B-053 | document · Reminders | reminder 'book cab' created, edited 2× within 5m | ONE single-sitting session per reminder artifact | each reminder is its own artifact stream |
| B-054 | document · Reminders | reminder 'renew policy' created, edited 3× within 5m | ONE single-sitting session per reminder artifact | each reminder is its own artifact stream |
| B-055 | document · Reminders | reminder 'buy gift' created, edited 4× within 5m | ONE single-sitting session per reminder artifact | each reminder is its own artifact stream |
| B-056 | document · Notes → Docs same title | note 'Goa packing' edited in Notes, later a Doc 'Goa packing' created | TWO streams, two sessions (different artifacts); linking is arc-layer work | sessions never merge across artifacts |
| B-057 | document · Notes → Docs same title | note 'Goa packing' edited in Notes, later a Doc 'Goa packing' created | TWO streams, two sessions (different artifacts); linking is arc-layer work | sessions never merge across artifacts |
| B-058 | document · Notes → Docs same title | note 'Goa packing' edited in Notes, later a Doc 'Goa packing' created | TWO streams, two sessions (different artifacts); linking is arc-layer work | sessions never merge across artifacts |
| B-059 | document · Notes → Docs same title | note 'Goa packing' edited in Notes, later a Doc 'Goa packing' created | TWO streams, two sessions (different artifacts); linking is arc-layer work | sessions never merge across artifacts |
| B-060 | document · Notes → Docs same title | note 'Goa packing' edited in Notes, later a Doc 'Goa packing' created | TWO streams, two sessions (different artifacts); linking is arc-layer work | sessions never merge across artifacts |

## C — SESS-ACT (80)

_Session boundaries — activity streams (browser/commerce/watch)_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| C-001 | activity · browser · airbnb.com | visit burst; next visit after 25m; activity G=30m | NO cut | browsing bursts end at 30m silence |
| C-002 | activity · browser · airbnb.com | visit burst; next visit after 35m; activity G=30m | CUT (gap) | browsing bursts end at 30m silence |
| C-003 | activity · browser · booking.com | visit burst; next visit after 25m; activity G=30m | NO cut | browsing bursts end at 30m silence |
| C-004 | activity · browser · booking.com | visit burst; next visit after 35m; activity G=30m | CUT (gap) | browsing bursts end at 30m silence |
| C-005 | activity · browser · zomato.com | visit burst; next visit after 25m; activity G=30m | NO cut | browsing bursts end at 30m silence |
| C-006 | activity · browser · zomato.com | visit burst; next visit after 35m; activity G=30m | CUT (gap) | browsing bursts end at 30m silence |
| C-007 | activity · browser · youtube.com | visit burst; next visit after 25m; activity G=30m | NO cut | browsing bursts end at 30m silence |
| C-008 | activity · browser · youtube.com | visit burst; next visit after 35m; activity G=30m | CUT (gap) | browsing bursts end at 30m silence |
| C-009 | activity · browser · amazon.in | visit burst; next visit after 25m; activity G=30m | NO cut | browsing bursts end at 30m silence |
| C-010 | activity · browser · amazon.in | visit burst; next visit after 35m; activity G=30m | CUT (gap) | browsing bursts end at 30m silence |
| C-011 | activity · browser · makemytrip.com | visit burst; next visit after 25m; activity G=30m | NO cut | browsing bursts end at 30m silence |
| C-012 | activity · browser · makemytrip.com | visit burst; next visit after 35m; activity G=30m | CUT (gap) | browsing bursts end at 30m silence |
| C-013 | activity · browser · x.com | visit burst; next visit after 25m; activity G=30m | NO cut | browsing bursts end at 30m silence |
| C-014 | activity · browser · x.com | visit burst; next visit after 35m; activity G=30m | CUT (gap) | browsing bursts end at 30m silence |
| C-015 | activity · browser · github.com | visit burst; next visit after 25m; activity G=30m | NO cut | browsing bursts end at 30m silence |
| C-016 | activity · browser · github.com | visit burst; next visit after 35m; activity G=30m | CUT (gap) | browsing bursts end at 30m silence |
| C-017 | activity · browser · nykaa.com | visit burst; next visit after 25m; activity G=30m | NO cut | browsing bursts end at 30m silence |
| C-018 | activity · browser · nykaa.com | visit burst; next visit after 35m; activity G=30m | CUT (gap) | browsing bursts end at 30m silence |
| C-019 | activity · browser · cred.club | visit burst; next visit after 25m; activity G=30m | NO cut | browsing bursts end at 30m silence |
| C-020 | activity · browser · cred.club | visit burst; next visit after 35m; activity G=30m | CUT (gap) | browsing bursts end at 30m silence |
| C-021 | activity · browser | 12 visits on airbnb.com, then first visit to youtube.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-022 | activity · browser | 12 visits on booking.com, then first visit to amazon.in 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-023 | activity · browser | 12 visits on zomato.com, then first visit to makemytrip.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-024 | activity · browser | 12 visits on youtube.com, then first visit to x.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-025 | activity · browser | 12 visits on amazon.in, then first visit to github.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-026 | activity · browser | 12 visits on makemytrip.com, then first visit to nykaa.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-027 | activity · browser | 12 visits on x.com, then first visit to cred.club 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-028 | activity · browser | 12 visits on github.com, then first visit to airbnb.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-029 | activity · browser | 12 visits on nykaa.com, then first visit to booking.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-030 | activity · browser | 12 visits on cred.club, then first visit to zomato.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-031 | activity · browser | 12 visits on airbnb.com, then first visit to youtube.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-032 | activity · browser | 12 visits on booking.com, then first visit to amazon.in 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-033 | activity · browser | 12 visits on zomato.com, then first visit to makemytrip.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-034 | activity · browser | 12 visits on youtube.com, then first visit to x.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-035 | activity · browser | 12 visits on amazon.in, then first visit to github.com 4m later | CUT (context_shift: registrable domain change) | domain change ends the burst even without a gap |
| C-036 | activity · commerce · Zomato | kind=order event (biryani order) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-037 | activity · commerce · Swiggy | kind=order event (groceries) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-038 | activity · commerce · Amazon | kind=order event (earphones) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-039 | activity · commerce · Blinkit | kind=order event (milk run) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-040 | activity · commerce · Uber | kind=order event (airport ride receipt) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-041 | activity · commerce · Zepto | kind=order event (fruits) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-042 | activity · commerce · MakeMyTrip | kind=order event (GOI-BLR flight) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-043 | activity · commerce · Goibibo | kind=order event (hotel) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-044 | activity · commerce · BookMyShow | kind=order event (2 tickets) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-045 | activity · commerce · Instamart | kind=order event (snacks) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-046 | activity · commerce · Amazon | kind=order event (return initiated) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-047 | activity · commerce · Zomato | kind=order event (refund credit) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-048 | activity · commerce · Swiggy | kind=order event (order cancelled) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-049 | activity · commerce · Uber | kind=order event (ride receipt) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-050 | activity · commerce · Blinkit | kind=order event (festival order) lands amid a 20-visit browsing burst | order seals as its OWN single-event session; browsing burst unaffected | a transaction is never merged into a browsing burst |
| C-051 | activity · YouTube watch history | 4 videos back-to-back, ≤10m between plays | ONE session (activity burst) | contiguous watching is one sitting |
| C-052 | activity · YouTube watch history | 5 videos back-to-back, ≤10m between plays | ONE session (activity burst) | contiguous watching is one sitting |
| C-053 | activity · YouTube watch history | 6 videos back-to-back, ≤10m between plays | ONE session (activity burst) | contiguous watching is one sitting |
| C-054 | activity · YouTube watch history | 7 videos back-to-back, ≤10m between plays | ONE session (activity burst) | contiguous watching is one sitting |
| C-055 | activity · YouTube watch history | 8 videos back-to-back, ≤10m between plays | ONE session (activity burst) | contiguous watching is one sitting |
| C-056 | activity · YouTube watch history | 9 videos back-to-back, ≤10m between plays | ONE session (activity burst) | contiguous watching is one sitting |
| C-057 | activity · YouTube watch history | 10 videos back-to-back, ≤10m between plays | ONE session (activity burst) | contiguous watching is one sitting |
| C-058 | activity · YouTube watch history | 11 videos back-to-back, ≤10m between plays | ONE session (activity burst) | contiguous watching is one sitting |
| C-059 | activity · YouTube watch history | 12 videos back-to-back, ≤10m between plays | ONE session (activity burst) | contiguous watching is one sitting |
| C-060 | activity · YouTube watch history | 13 videos back-to-back, ≤10m between plays | ONE session (activity burst) | contiguous watching is one sitting |
| C-061 | activity · scratchpad clipboard | 3 clips copied within 5m, next clip 40m later | burst = one session; later clip starts new (gap>30m) | micro-artifacts follow activity gap rules |
| C-062 | activity · scratchpad clipboard | 4 clips copied within 5m, next clip 41m later | burst = one session; later clip starts new (gap>30m) | micro-artifacts follow activity gap rules |
| C-063 | activity · scratchpad clipboard | 5 clips copied within 5m, next clip 42m later | burst = one session; later clip starts new (gap>30m) | micro-artifacts follow activity gap rules |
| C-064 | activity · scratchpad clipboard | 6 clips copied within 5m, next clip 43m later | burst = one session; later clip starts new (gap>30m) | micro-artifacts follow activity gap rules |
| C-065 | activity · scratchpad clipboard | 3 clips copied within 5m, next clip 44m later | burst = one session; later clip starts new (gap>30m) | micro-artifacts follow activity gap rules |
| C-066 | activity · scratchpad clipboard | 4 clips copied within 5m, next clip 45m later | burst = one session; later clip starts new (gap>30m) | micro-artifacts follow activity gap rules |
| C-067 | activity · scratchpad clipboard | 5 clips copied within 5m, next clip 46m later | burst = one session; later clip starts new (gap>30m) | micro-artifacts follow activity gap rules |
| C-068 | activity · scratchpad clipboard | 6 clips copied within 5m, next clip 47m later | burst = one session; later clip starts new (gap>30m) | micro-artifacts follow activity gap rules |
| C-069 | activity · scratchpad clipboard | 3 clips copied within 5m, next clip 48m later | burst = one session; later clip starts new (gap>30m) | micro-artifacts follow activity gap rules |
| C-070 | activity · scratchpad clipboard | 4 clips copied within 5m, next clip 49m later | burst = one session; later clip starts new (gap>30m) | micro-artifacts follow activity gap rules |
| C-071 | activity · AI keyboard | autocomplete acceptance events, 30 in 10m | ONE session; size cap 100 applies | intent-rich micro-events batch into sittings |
| C-072 | activity · AI keyboard | autocomplete acceptance events, 30 in 10m | ONE session; size cap 100 applies | intent-rich micro-events batch into sittings |
| C-073 | activity · AI keyboard | autocomplete acceptance events, 30 in 10m | ONE session; size cap 100 applies | intent-rich micro-events batch into sittings |
| C-074 | activity · AI keyboard | autocomplete acceptance events, 30 in 10m | ONE session; size cap 100 applies | intent-rich micro-events batch into sittings |
| C-075 | activity · AI keyboard | autocomplete acceptance events, 30 in 10m | ONE session; size cap 100 applies | intent-rich micro-events batch into sittings |
| C-076 | activity · browser bookmark | bookmark saved mid-burst on same domain | same session as the burst (same context) | a save is part of the sitting, not a transaction |
| C-077 | activity · browser bookmark | bookmark saved mid-burst on same domain | same session as the burst (same context) | a save is part of the sitting, not a transaction |
| C-078 | activity · browser bookmark | bookmark saved mid-burst on same domain | same session as the burst (same context) | a save is part of the sitting, not a transaction |
| C-079 | activity · browser bookmark | bookmark saved mid-burst on same domain | same session as the burst (same context) | a save is part of the sitting, not a transaction |
| C-080 | activity · browser bookmark | bookmark saved mid-burst on same domain | same session as the burst (same context) | a save is part of the sitting, not a transaction |

## D — SESS-AMB (60)

_Session boundaries — ambient streams (screen/voice) + prefilter_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| D-001 | ambient · PC voice | 20m of room silence between two conversations, VAD on | silence never written to disk; two sessions (context_shift: silence>90s) | VAD gates the recorder itself |
| D-002 | ambient · PC voice | 25m of room silence between two conversations, VAD on | silence never written to disk; two sessions (context_shift: silence>90s) | VAD gates the recorder itself |
| D-003 | ambient · PC voice | 30m of room silence between two conversations, VAD on | silence never written to disk; two sessions (context_shift: silence>90s) | VAD gates the recorder itself |
| D-004 | ambient · PC voice | 35m of room silence between two conversations, VAD on | silence never written to disk; two sessions (context_shift: silence>90s) | VAD gates the recorder itself |
| D-005 | ambient · PC voice | 40m of room silence between two conversations, VAD on | silence never written to disk; two sessions (context_shift: silence>90s) | VAD gates the recorder itself |
| D-006 | ambient · PC voice | 45m of room silence between two conversations, VAD on | silence never written to disk; two sessions (context_shift: silence>90s) | VAD gates the recorder itself |
| D-007 | ambient · PC voice | 50m of room silence between two conversations, VAD on | silence never written to disk; two sessions (context_shift: silence>90s) | VAD gates the recorder itself |
| D-008 | ambient · PC voice | 55m of room silence between two conversations, VAD on | silence never written to disk; two sessions (context_shift: silence>90s) | VAD gates the recorder itself |
| D-009 | ambient · PC voice | 60m of room silence between two conversations, VAD on | silence never written to disk; two sessions (context_shift: silence>90s) | VAD gates the recorder itself |
| D-010 | ambient · PC voice | 65m of room silence between two conversations, VAD on | silence never written to disk; two sessions (context_shift: silence>90s) | VAD gates the recorder itself |
| D-011 | ambient · screen frames | 200 near-identical frames of a paused editor | phash-collapse to 1 frame + duration; salience low | dedupe before anything downstream |
| D-012 | ambient · screen frames | 300 near-identical frames of a paused editor | phash-collapse to 1 frame + duration; salience low | dedupe before anything downstream |
| D-013 | ambient · screen frames | 400 near-identical frames of a paused editor | phash-collapse to 1 frame + duration; salience low | dedupe before anything downstream |
| D-014 | ambient · screen frames | 500 near-identical frames of a paused editor | phash-collapse to 1 frame + duration; salience low | dedupe before anything downstream |
| D-015 | ambient · screen frames | 600 near-identical frames of a paused editor | phash-collapse to 1 frame + duration; salience low | dedupe before anything downstream |
| D-016 | ambient · screen frames | 700 near-identical frames of a paused editor | phash-collapse to 1 frame + duration; salience low | dedupe before anything downstream |
| D-017 | ambient · screen frames | 800 near-identical frames of a paused editor | phash-collapse to 1 frame + duration; salience low | dedupe before anything downstream |
| D-018 | ambient · screen frames | 900 near-identical frames of a paused editor | phash-collapse to 1 frame + duration; salience low | dedupe before anything downstream |
| D-019 | ambient · screen frames | 1000 near-identical frames of a paused editor | phash-collapse to 1 frame + duration; salience low | dedupe before anything downstream |
| D-020 | ambient · screen frames | 1100 near-identical frames of a paused editor | phash-collapse to 1 frame + duration; salience low | dedupe before anything downstream |
| D-021 | ambient · screen | foreground app VS Code → Chrome | CUT (context_shift: app change) | app switch is the ambient boundary |
| D-022 | ambient · screen | foreground app Chrome → WhatsApp | CUT (context_shift: app change) | app switch is the ambient boundary |
| D-023 | ambient · screen | foreground app Figma → Slack | CUT (context_shift: app change) | app switch is the ambient boundary |
| D-024 | ambient · screen | foreground app Terminal → Notes | CUT (context_shift: app change) | app switch is the ambient boundary |
| D-025 | ambient · screen | foreground app Chrome → Zoom | CUT (context_shift: app change) | app switch is the ambient boundary |
| D-026 | ambient · screen | foreground app Slack → Chrome | CUT (context_shift: app change) | app switch is the ambient boundary |
| D-027 | ambient · screen | foreground app Notes → VS Code | CUT (context_shift: app change) | app switch is the ambient boundary |
| D-028 | ambient · screen | foreground app Zoom → Chrome | CUT (context_shift: app change) | app switch is the ambient boundary |
| D-029 | ambient · screen | foreground app WhatsApp → Figma | CUT (context_shift: app change) | app switch is the ambient boundary |
| D-030 | ambient · screen | foreground app Chrome → Terminal | CUT (context_shift: app change) | app switch is the ambient boundary |
| D-031 | ambient · PC voice | speech, then 91s silence, then speech | CUT (context_shift: silence>90s) | 90s of quiet ends an ambient session |
| D-032 | ambient · PC voice | speech, then 101s silence, then speech | CUT (context_shift: silence>90s) | 90s of quiet ends an ambient session |
| D-033 | ambient · PC voice | speech, then 111s silence, then speech | CUT (context_shift: silence>90s) | 90s of quiet ends an ambient session |
| D-034 | ambient · PC voice | speech, then 121s silence, then speech | CUT (context_shift: silence>90s) | 90s of quiet ends an ambient session |
| D-035 | ambient · PC voice | speech, then 131s silence, then speech | CUT (context_shift: silence>90s) | 90s of quiet ends an ambient session |
| D-036 | ambient · PC voice | speech, then 141s silence, then speech | CUT (context_shift: silence>90s) | 90s of quiet ends an ambient session |
| D-037 | ambient · PC voice | speech, then 151s silence, then speech | CUT (context_shift: silence>90s) | 90s of quiet ends an ambient session |
| D-038 | ambient · PC voice | speech, then 161s silence, then speech | CUT (context_shift: silence>90s) | 90s of quiet ends an ambient session |
| D-039 | ambient · screen | single app focused continuously for 16 min | CUT at 15-min absolute ceiling | no ambient session exceeds the ceiling |
| D-040 | ambient · screen | single app focused continuously for 21 min | CUT at 15-min absolute ceiling | no ambient session exceeds the ceiling |
| D-041 | ambient · screen | single app focused continuously for 26 min | CUT at 15-min absolute ceiling | no ambient session exceeds the ceiling |
| D-042 | ambient · screen | single app focused continuously for 31 min | CUT at 15-min absolute ceiling | no ambient session exceeds the ceiling |
| D-043 | ambient · screen | single app focused continuously for 36 min | CUT at 15-min absolute ceiling | no ambient session exceeds the ceiling |
| D-044 | ambient · screen | single app focused continuously for 41 min | CUT at 15-min absolute ceiling | no ambient session exceeds the ceiling |
| D-045 | ambient · screen | single app focused continuously for 46 min | CUT at 15-min absolute ceiling | no ambient session exceeds the ceiling |
| D-046 | ambient · screen low-salience | 30m idle scrolling, salience below threshold throughout | ONE coarse session ('browsing, ~30m'); zero LLM enrichment | low-salience runs collapse; they never flood surfaces or spend |
| D-047 | ambient · screen low-salience | 35m idle scrolling, salience below threshold throughout | ONE coarse session ('browsing, ~35m'); zero LLM enrichment | low-salience runs collapse; they never flood surfaces or spend |
| D-048 | ambient · screen low-salience | 40m idle scrolling, salience below threshold throughout | ONE coarse session ('browsing, ~40m'); zero LLM enrichment | low-salience runs collapse; they never flood surfaces or spend |
| D-049 | ambient · screen low-salience | 45m idle scrolling, salience below threshold throughout | ONE coarse session ('browsing, ~45m'); zero LLM enrichment | low-salience runs collapse; they never flood surfaces or spend |
| D-050 | ambient · screen low-salience | 50m idle scrolling, salience below threshold throughout | ONE coarse session ('browsing, ~50m'); zero LLM enrichment | low-salience runs collapse; they never flood surfaces or spend |
| D-051 | ambient · screen low-salience | 55m idle scrolling, salience below threshold throughout | ONE coarse session ('browsing, ~55m'); zero LLM enrichment | low-salience runs collapse; they never flood surfaces or spend |
| D-052 | ambient · screen low-salience | 60m idle scrolling, salience below threshold throughout | ONE coarse session ('browsing, ~60m'); zero LLM enrichment | low-salience runs collapse; they never flood surfaces or spend |
| D-053 | ambient · screen low-salience | 65m idle scrolling, salience below threshold throughout | ONE coarse session ('browsing, ~65m'); zero LLM enrichment | low-salience runs collapse; they never flood surfaces or spend |
| D-054 | ambient · screen low-salience | 70m idle scrolling, salience below threshold throughout | ONE coarse session ('browsing, ~70m'); zero LLM enrichment | low-salience runs collapse; they never flood surfaces or spend |
| D-055 | ambient · screen low-salience | 75m idle scrolling, salience below threshold throughout | ONE coarse session ('browsing, ~75m'); zero LLM enrichment | low-salience runs collapse; they never flood surfaces or spend |
| D-056 | ambient · manifest validation | register ambient source with prefilter=none | REJECT at registration | ambient without a prefilter is a boot error |
| D-057 | ambient · manifest validation | register ambient source with prefilter=vad | accept | ambient without a prefilter is a boot error |
| D-058 | ambient · manifest validation | register ambient source with prefilter=dedupe | accept | ambient without a prefilter is a boot error |
| D-059 | ambient · manifest validation | register ambient source with prefilter=diff | accept | ambient without a prefilter is a boot error |
| D-060 | ambient · manifest validation | register ambient source with prefilter=threshold | accept | ambient without a prefilter is a boot error |

## E — SESS-BND (40)

_Session boundaries — bounded records (calendar/meetings/rides)_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| E-001 | bounded · Calendar | event 'Standup 10:00–10:15' | session = the record; boundary_reason=record_bounded; no inference | bounded records carry their own boundaries |
| E-002 | bounded · Calendar | event 'Dr. Shreedhar 16:00–16:30' | session = the record; boundary_reason=record_bounded; no inference | bounded records carry their own boundaries |
| E-003 | bounded · Calendar | event 'Gargi's 40th 19:00–23:00' | session = the record; boundary_reason=record_bounded; no inference | bounded records carry their own boundaries |
| E-004 | bounded · Calendar | event 'Flight GOI-BLR 14:05–15:20' | session = the record; boundary_reason=record_bounded; no inference | bounded records carry their own boundaries |
| E-005 | bounded · Calendar | event 'Bhangra class 18:00–19:00' | session = the record; boundary_reason=record_bounded; no inference | bounded records carry their own boundaries |
| E-006 | bounded · Calendar | event 'Rahul wedding events 11:00–15:00' | session = the record; boundary_reason=record_bounded; no inference | bounded records carry their own boundaries |
| E-007 | bounded · Calendar | event 'Therapy 17:00–17:50' | session = the record; boundary_reason=record_bounded; no inference | bounded records carry their own boundaries |
| E-008 | bounded · Calendar | event '1:1 with Bhavesh 15:00–15:30' | session = the record; boundary_reason=record_bounded; no inference | bounded records carry their own boundaries |
| E-009 | bounded · Calendar | event 'Yoga 07:00–07:45' | session = the record; boundary_reason=record_bounded; no inference | bounded records carry their own boundaries |
| E-010 | bounded · Calendar | event 'Movers slot 09:00–12:00' | session = the record; boundary_reason=record_bounded; no inference | bounded records carry their own boundaries |
| E-011 | bounded · meeting transcript | 30-min Zoom transcript, 80 utterances | ONE session regardless of size cap; caps do not apply to bounded | a 90-min meeting is one session |
| E-012 | bounded · meeting transcript | 40-min Zoom transcript, 120 utterances | ONE session regardless of size cap; caps do not apply to bounded | a 90-min meeting is one session |
| E-013 | bounded · meeting transcript | 50-min Zoom transcript, 160 utterances | ONE session regardless of size cap; caps do not apply to bounded | a 90-min meeting is one session |
| E-014 | bounded · meeting transcript | 60-min Zoom transcript, 200 utterances | ONE session regardless of size cap; caps do not apply to bounded | a 90-min meeting is one session |
| E-015 | bounded · meeting transcript | 70-min Zoom transcript, 240 utterances | ONE session regardless of size cap; caps do not apply to bounded | a 90-min meeting is one session |
| E-016 | bounded · meeting transcript | 80-min Zoom transcript, 280 utterances | ONE session regardless of size cap; caps do not apply to bounded | a 90-min meeting is one session |
| E-017 | bounded · meeting transcript | 90-min Zoom transcript, 320 utterances | ONE session regardless of size cap; caps do not apply to bounded | a 90-min meeting is one session |
| E-018 | bounded · meeting transcript | 100-min Zoom transcript, 360 utterances | ONE session regardless of size cap; caps do not apply to bounded | a 90-min meeting is one session |
| E-019 | bounded · meeting transcript | 110-min Zoom transcript, 400 utterances | ONE session regardless of size cap; caps do not apply to bounded | a 90-min meeting is one session |
| E-020 | bounded · meeting transcript | 120-min Zoom transcript, 440 utterances | ONE session regardless of size cap; caps do not apply to bounded | a 90-min meeting is one session |
| E-021 | bounded · Uber | ride receipt 12 Aug, pickup/drop times present | session = the ride record (record_bounded) | a ride is a bounded record, not an activity burst |
| E-022 | bounded · Uber | ride receipt 13 Aug, pickup/drop times present | session = the ride record (record_bounded) | a ride is a bounded record, not an activity burst |
| E-023 | bounded · Uber | ride receipt 14 Aug, pickup/drop times present | session = the ride record (record_bounded) | a ride is a bounded record, not an activity burst |
| E-024 | bounded · Uber | ride receipt 15 Aug, pickup/drop times present | session = the ride record (record_bounded) | a ride is a bounded record, not an activity burst |
| E-025 | bounded · Uber | ride receipt 16 Aug, pickup/drop times present | session = the ride record (record_bounded) | a ride is a bounded record, not an activity burst |
| E-026 | bounded · Uber | ride receipt 17 Aug, pickup/drop times present | session = the ride record (record_bounded) | a ride is a bounded record, not an activity burst |
| E-027 | bounded · Uber | ride receipt 18 Aug, pickup/drop times present | session = the ride record (record_bounded) | a ride is a bounded record, not an activity burst |
| E-028 | bounded · Uber | ride receipt 19 Aug, pickup/drop times present | session = the ride record (record_bounded) | a ride is a bounded record, not an activity burst |
| E-029 | bounded · flight/hotel booking | booking with checkin/checkout dates, 1 nights | session = the booking record; the STAY span is arc-layer, not a session | do not stretch sessions across multi-day stays |
| E-030 | bounded · flight/hotel booking | booking with checkin/checkout dates, 2 nights | session = the booking record; the STAY span is arc-layer, not a session | do not stretch sessions across multi-day stays |
| E-031 | bounded · flight/hotel booking | booking with checkin/checkout dates, 3 nights | session = the booking record; the STAY span is arc-layer, not a session | do not stretch sessions across multi-day stays |
| E-032 | bounded · flight/hotel booking | booking with checkin/checkout dates, 4 nights | session = the booking record; the STAY span is arc-layer, not a session | do not stretch sessions across multi-day stays |
| E-033 | bounded · flight/hotel booking | booking with checkin/checkout dates, 5 nights | session = the booking record; the STAY span is arc-layer, not a session | do not stretch sessions across multi-day stays |
| E-034 | bounded · flight/hotel booking | booking with checkin/checkout dates, 6 nights | session = the booking record; the STAY span is arc-layer, not a session | do not stretch sessions across multi-day stays |
| E-035 | bounded · size-cap interaction | calendar event with 50 embedded agenda lines | NO size-cap cut (bounded exempt) | record_bounded overrides caps |
| E-036 | bounded · size-cap interaction | calendar event with 80 embedded agenda lines | NO size-cap cut (bounded exempt) | record_bounded overrides caps |
| E-037 | bounded · size-cap interaction | calendar event with 110 embedded agenda lines | NO size-cap cut (bounded exempt) | record_bounded overrides caps |
| E-038 | bounded · size-cap interaction | calendar event with 140 embedded agenda lines | NO size-cap cut (bounded exempt) | record_bounded overrides caps |
| E-039 | bounded · size-cap interaction | calendar event with 170 embedded agenda lines | NO size-cap cut (bounded exempt) | record_bounded overrides caps |
| E-040 | bounded · size-cap interaction | calendar event with 200 embedded agenda lines | NO size-cap cut (bounded exempt) | record_bounded overrides caps |

## F — ENT-RES (170)

_Entity identity resolution (bind/merge/split/negative/me)_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| F-001 | identity · exact rebind | known jid of Pranjali appears in a new group | BIND to existing ent(Pranjali) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-002 | identity · exact rebind | known jid of Rahul appears in a new group | BIND to existing ent(Rahul) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-003 | identity · exact rebind | known jid of Rashmi appears in a new group | BIND to existing ent(Rashmi) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-004 | identity · exact rebind | known jid of Sudhir appears in a new group | BIND to existing ent(Sudhir) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-005 | identity · exact rebind | known jid of Hrishikesh appears in a new group | BIND to existing ent(Hrishikesh) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-006 | identity · exact rebind | known jid of Gargi appears in a new group | BIND to existing ent(Gargi) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-007 | identity · exact rebind | known jid of Keerti appears in a new group | BIND to existing ent(Keerti) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-008 | identity · exact rebind | known jid of Prabhat appears in a new group | BIND to existing ent(Prabhat) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-009 | identity · exact rebind | known jid of Rajat appears in a new group | BIND to existing ent(Rajat) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-010 | identity · exact rebind | known jid of Mansi appears in a new group | BIND to existing ent(Mansi) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-011 | identity · exact rebind | known jid of Natesh appears in a new group | BIND to existing ent(Natesh) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-012 | identity · exact rebind | known jid of Shivangi appears in a new group | BIND to existing ent(Shivangi) [CODE]; no new entity | exact (source,kind,value) match is rung 1 |
| F-013 | identity · cross-source phone | Contacts card 'Pranjali' phone +91-9800… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-014 | identity · cross-source phone | Contacts card 'Rahul' phone +91-9801… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-015 | identity · cross-source phone | Contacts card 'Rashmi' phone +91-9802… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-016 | identity · cross-source phone | Contacts card 'Sudhir' phone +91-9803… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-017 | identity · cross-source phone | Contacts card 'Hrishikesh' phone +91-9804… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-018 | identity · cross-source phone | Contacts card 'Gargi' phone +91-9805… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-019 | identity · cross-source phone | Contacts card 'Keerti' phone +91-9806… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-020 | identity · cross-source phone | Contacts card 'Prabhat' phone +91-9807… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-021 | identity · cross-source phone | Contacts card 'Rajat' phone +91-9808… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-022 | identity · cross-source phone | Contacts card 'Mansi' phone +91-9809… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-023 | identity · cross-source phone | Contacts card 'Natesh' phone +91-9810… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-024 | identity · cross-source phone | Contacts card 'Shivangi' phone +91-9811… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-025 | identity · cross-source phone | Contacts card 'Pranjali' phone +91-9812… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-026 | identity · cross-source phone | Contacts card 'Rahul' phone +91-9813… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-027 | identity · cross-source phone | Contacts card 'Rashmi' phone +91-9814… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-028 | identity · cross-source phone | Contacts card 'Sudhir' phone +91-9815… == WhatsApp jid phone | BIND same entity [CODE], confidence 1.0 | normalised phone is a cross-source join key |
| F-029 | identity · cross-source email | gmail From: pranjali@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-030 | identity · cross-source email | gmail From: rahul@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-031 | identity · cross-source email | gmail From: rashmi@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-032 | identity · cross-source email | gmail From: sudhir@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-033 | identity · cross-source email | gmail From: hrishikesh@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-034 | identity · cross-source email | gmail From: gargi@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-035 | identity · cross-source email | gmail From: keerti@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-036 | identity · cross-source email | gmail From: prabhat@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-037 | identity · cross-source email | gmail From: rajat@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-038 | identity · cross-source email | gmail From: mansi@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-039 | identity · cross-source email | gmail From: pranjali@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-040 | identity · cross-source email | gmail From: rahul@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-041 | identity · cross-source email | gmail From: rashmi@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-042 | identity · cross-source email | gmail From: sudhir@… == calendar attendee email | BIND same entity [CODE] | normalised email joins gmail↔calendar |
| F-043 | identity · alias | 'Babbu' used consistently in chat where Shaurya is the counterparty | alias identity row on ent(Shaurya) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-044 | identity · alias | 'Didi' used consistently in chat where Rashmi is the counterparty | alias identity row on ent(Rashmi) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-045 | identity · alias | 'Doc' used consistently in chat where Dr. Shreedhar is the counterparty | alias identity row on ent(Dr. Shreedhar) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-046 | identity · alias | 'Hrishi' used consistently in chat where Hrishikesh is the counterparty | alias identity row on ent(Hrishikesh) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-047 | identity · alias | 'Praj' used consistently in chat where Pranjali is the counterparty | alias identity row on ent(Pranjali) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-048 | identity · alias | 'Sudhi' used consistently in chat where Sudhir is the counterparty | alias identity row on ent(Sudhir) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-049 | identity · alias | 'Bhav' used consistently in chat where Bhavesh is the counterparty | alias identity row on ent(Bhavesh) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-050 | identity · alias | 'Jitu' used consistently in chat where Jitendra is the counterparty | alias identity row on ent(Jitendra) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-051 | identity · alias | 'Mumma' used consistently in chat where Mummy is the counterparty | alias identity row on ent(Mummy) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-052 | identity · alias | 'Pops' used consistently in chat where Papa is the counterparty | alias identity row on ent(Papa) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-053 | identity · alias | 'Shivi' used consistently in chat where Shivangi is the counterparty | alias identity row on ent(Shivangi) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-054 | identity · alias | 'Aaku' used consistently in chat where Aakash is the counterparty | alias identity row on ent(Aakash) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-055 | identity · alias | 'Mansiji' used consistently in chat where Mansi is the counterparty | alias identity row on ent(Mansi) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-056 | identity · alias | 'Nat' used consistently in chat where Natesh is the counterparty | alias identity row on ent(Natesh) via mention pass, evidence quoted | nicknames are identities, not new entities |
| F-057 | identity · new number | contact 'Papa (new number Jio)' messages; old Papa jid dormant since 1w | candidate pair → agent; expected verdict same (shared groups, same alias 'Papa'); if conf<bar → resolution queue | renamed/re-numbered contacts must converge on one entity |
| F-058 | identity · new number | contact 'Papa (new number Jio)' messages; old Papa jid dormant since 2w | candidate pair → agent; expected verdict same (shared groups, same alias 'Papa'); if conf<bar → resolution queue | renamed/re-numbered contacts must converge on one entity |
| F-059 | identity · new number | contact 'Papa (new number Jio)' messages; old Papa jid dormant since 3w | candidate pair → agent; expected verdict same (shared groups, same alias 'Papa'); if conf<bar → resolution queue | renamed/re-numbered contacts must converge on one entity |
| F-060 | identity · new number | contact 'Papa (new number Jio)' messages; old Papa jid dormant since 4w | candidate pair → agent; expected verdict same (shared groups, same alias 'Papa'); if conf<bar → resolution queue | renamed/re-numbered contacts must converge on one entity |
| F-061 | identity · new number | contact 'Papa (new number Jio)' messages; old Papa jid dormant since 5w | candidate pair → agent; expected verdict same (shared groups, same alias 'Papa'); if conf<bar → resolution queue | renamed/re-numbered contacts must converge on one entity |
| F-062 | identity · new number | contact 'Papa (new number Jio)' messages; old Papa jid dormant since 6w | candidate pair → agent; expected verdict same (shared groups, same alias 'Papa'); if conf<bar → resolution queue | renamed/re-numbered contacts must converge on one entity |
| F-063 | identity · new number | contact 'Papa (new number Jio)' messages; old Papa jid dormant since 7w | candidate pair → agent; expected verdict same (shared groups, same alias 'Papa'); if conf<bar → resolution queue | renamed/re-numbered contacts must converge on one entity |
| F-064 | identity · new number | contact 'Papa (new number Jio)' messages; old Papa jid dormant since 8w | candidate pair → agent; expected verdict same (shared groups, same alias 'Papa'); if conf<bar → resolution queue | renamed/re-numbered contacts must converge on one entity |
| F-065 | identity · new number | contact 'Papa (new number Jio)' messages; old Papa jid dormant since 9w | candidate pair → agent; expected verdict same (shared groups, same alias 'Papa'); if conf<bar → resolution queue | renamed/re-numbered contacts must converge on one entity |
| F-066 | identity · new number | contact 'Papa (new number Jio)' messages; old Papa jid dormant since 10w | candidate pair → agent; expected verdict same (shared groups, same alias 'Papa'); if conf<bar → resolution queue | renamed/re-numbered contacts must converge on one entity |
| F-067 | identity · same-first-name NEGATIVE | 'Rahul Arora' and 'Rahul Mehta': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-068 | identity · same-first-name NEGATIVE | 'Amit (gym)' and 'Amit (office)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-069 | identity · same-first-name NEGATIVE | 'Priya S' and 'Priya D': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-070 | identity · same-first-name NEGATIVE | 'Dr. Rao (dentist)' and 'Dr. Rao (Amma's)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-071 | identity · same-first-name NEGATIVE | 'Ankit HDFC' and 'Ankit college': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-072 | identity · same-first-name NEGATIVE | 'Sneha' and 'Sneha (Rahul's cousin)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-073 | identity · same-first-name NEGATIVE | 'Vikram' and 'Vikram (broker)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-074 | identity · same-first-name NEGATIVE | 'Rohit ola' and 'Rohit school': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-075 | identity · same-first-name NEGATIVE | 'Neha' and 'Neha (Keerti's friend)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-076 | identity · same-first-name NEGATIVE | 'Arjun' and 'Arjun (Goa)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-077 | identity · same-first-name NEGATIVE | 'Karan' and 'Karan (X)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-078 | identity · same-first-name NEGATIVE | 'Divya' and 'Divya (yoga)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-079 | identity · same-first-name NEGATIVE | 'Sameer' and 'Sameer (Sudhir's PM)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-080 | identity · same-first-name NEGATIVE | 'Pooja' and 'Pooja (Didi's neighbour)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-081 | identity · same-first-name NEGATIVE | 'Raj' and 'Raj (plumber)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-082 | identity · same-first-name NEGATIVE | 'Isha' and 'Isha (bhangra)': no shared phone/email/groups; different circles | DIFFERENT entities; store negative pair; never re-propose | name similarity alone must never merge |
| F-083 | identity · business | broadcast sender 'Policybazaar' with is_business flag | entity type=org (vendor), NOT person; person_class from flag [CODE] | businesses are orgs; flag comes from source metadata |
| F-084 | identity · business | broadcast sender 'Amazon' with is_business flag | entity type=org (vendor), NOT person; person_class from flag [CODE] | businesses are orgs; flag comes from source metadata |
| F-085 | identity · business | broadcast sender 'HDFC Bank' with is_business flag | entity type=org (vendor), NOT person; person_class from flag [CODE] | businesses are orgs; flag comes from source metadata |
| F-086 | identity · business | broadcast sender 'Zomato' with is_business flag | entity type=org (vendor), NOT person; person_class from flag [CODE] | businesses are orgs; flag comes from source metadata |
| F-087 | identity · business | broadcast sender 'Jio' with is_business flag | entity type=org (vendor), NOT person; person_class from flag [CODE] | businesses are orgs; flag comes from source metadata |
| F-088 | identity · business | broadcast sender 'Swiggy' with is_business flag | entity type=org (vendor), NOT person; person_class from flag [CODE] | businesses are orgs; flag comes from source metadata |
| F-089 | identity · business | broadcast sender 'Netflix' with is_business flag | entity type=org (vendor), NOT person; person_class from flag [CODE] | businesses are orgs; flag comes from source metadata |
| F-090 | identity · business | broadcast sender 'Airtel' with is_business flag | entity type=org (vendor), NOT person; person_class from flag [CODE] | businesses are orgs; flag comes from source metadata |
| F-091 | identity · business | broadcast sender 'Cred' with is_business flag | entity type=org (vendor), NOT person; person_class from flag [CODE] | businesses are orgs; flag comes from source metadata |
| F-092 | identity · business | broadcast sender 'MakeMyTrip' with is_business flag | entity type=org (vendor), NOT person; person_class from flag [CODE] | businesses are orgs; flag comes from source metadata |
| F-093 | identity · group minting | group chat 'Ghar+' first seen | mint entity type=group [CODE]; member_of edges from participant list | groups are entities with free metadata edges |
| F-094 | identity · group minting | group chat 'Goa Crew' first seen | mint entity type=group [CODE]; member_of edges from participant list | groups are entities with free metadata edges |
| F-095 | identity · group minting | group chat 'Family' first seen | mint entity type=group [CODE]; member_of edges from participant list | groups are entities with free metadata edges |
| F-096 | identity · group minting | group chat 'Office Frandss' first seen | mint entity type=group [CODE]; member_of edges from participant list | groups are entities with free metadata edges |
| F-097 | identity · group minting | group chat 'School WA' first seen | mint entity type=group [CODE]; member_of edges from participant list | groups are entities with free metadata edges |
| F-098 | identity · group minting | group chat 'Society' first seen | mint entity type=group [CODE]; member_of edges from participant list | groups are entities with free metadata edges |
| F-099 | identity · group minting | group chat 'Trek 2026' first seen | mint entity type=group [CODE]; member_of edges from participant list | groups are entities with free metadata edges |
| F-100 | identity · group minting | group chat 'Cousins' first seen | mint entity type=group [CODE]; member_of edges from participant list | groups are entities with free metadata edges |
| F-101 | identity · group minting | group chat 'Book club' first seen | mint entity type=group [CODE]; member_of edges from participant list | groups are entities with free metadata edges |
| F-102 | identity · group minting | group chat 'Badminton' first seen | mint entity type=group [CODE]; member_of edges from participant list | groups are entities with free metadata edges |
| F-103 | identity · me-entity | whatsapp self_jid observed at source registration | bind identity to the ONE canonical me entity [CODE] | every manifest's self_identity funnels to me; is_self derives from it |
| F-104 | identity · me-entity | gmail account observed at source registration | bind identity to the ONE canonical me entity [CODE] | every manifest's self_identity funnels to me; is_self derives from it |
| F-105 | identity · me-entity | calendar owner observed at source registration | bind identity to the ONE canonical me entity [CODE] | every manifest's self_identity funnels to me; is_self derives from it |
| F-106 | identity · me-entity | device_id mac observed at source registration | bind identity to the ONE canonical me entity [CODE] | every manifest's self_identity funnels to me; is_self derives from it |
| F-107 | identity · me-entity | device_id phone observed at source registration | bind identity to the ONE canonical me entity [CODE] | every manifest's self_identity funnels to me; is_self derives from it |
| F-108 | identity · me-entity | contacts 'me' card observed at source registration | bind identity to the ONE canonical me entity [CODE] | every manifest's self_identity funnels to me; is_self derives from it |
| F-109 | identity · me-entity | slack self observed at source registration | bind identity to the ONE canonical me entity [CODE] | every manifest's self_identity funnels to me; is_self derives from it |
| F-110 | identity · me-entity | browser profile observed at source registration | bind identity to the ONE canonical me entity [CODE] | every manifest's self_identity funnels to me; is_self derives from it |
| F-111 | identity · ambiguous → ask | new jid, display 'K…', ML score 0.55 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-112 | identity · ambiguous → ask | new jid, display 'R…', ML score 0.58 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-113 | identity · ambiguous → ask | new jid, display 'S…', ML score 0.61 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-114 | identity · ambiguous → ask | new jid, display 'A…', ML score 0.64 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-115 | identity · ambiguous → ask | new jid, display 'K…', ML score 0.67 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-116 | identity · ambiguous → ask | new jid, display 'R…', ML score 0.55 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-117 | identity · ambiguous → ask | new jid, display 'S…', ML score 0.58 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-118 | identity · ambiguous → ask | new jid, display 'A…', ML score 0.61 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-119 | identity · ambiguous → ask | new jid, display 'K…', ML score 0.64 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-120 | identity · ambiguous → ask | new jid, display 'R…', ML score 0.67 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-121 | identity · ambiguous → ask | new jid, display 'S…', ML score 0.55 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-122 | identity · ambiguous → ask | new jid, display 'A…', ML score 0.58 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-123 | identity · ambiguous → ask | new jid, display 'K…', ML score 0.61 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-124 | identity · ambiguous → ask | new jid, display 'R…', ML score 0.64 vs two candidates | resolution queue question; NO bind | in-band ambiguity is a human question, never a guess |
| F-125 | identity · agent adjudication | pair with ML score in band; shared 1 phone-suffix pattern | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-126 | identity · agent adjudication | pair with ML score in band; shared 2 groups | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-127 | identity · agent adjudication | pair with ML score in band; shared 1 phone-suffix pattern | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-128 | identity · agent adjudication | pair with ML score in band; shared 2 groups | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-129 | identity · agent adjudication | pair with ML score in band; shared 1 phone-suffix pattern | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-130 | identity · agent adjudication | pair with ML score in band; shared 2 groups | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-131 | identity · agent adjudication | pair with ML score in band; shared 1 phone-suffix pattern | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-132 | identity · agent adjudication | pair with ML score in band; shared 2 groups | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-133 | identity · agent adjudication | pair with ML score in band; shared 1 phone-suffix pattern | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-134 | identity · agent adjudication | pair with ML score in band; shared 2 groups | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-135 | identity · agent adjudication | pair with ML score in band; shared 1 phone-suffix pattern | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-136 | identity · agent adjudication | pair with ML score in band; shared 2 groups | P-AG1 runs (≤3 turns, read-only); verdict applied only if conf ≥ bar, else queue | the agent settles what similarity cannot; unsure escalates |
| F-137 | identity · user override | user answered 'different' on pair #1 last month; automation now scores 0.93 | NO merge; negative pair is permanent | actor:user beats every future automated verdict |
| F-138 | identity · user override | user answered 'different' on pair #2 last month; automation now scores 0.93 | NO merge; negative pair is permanent | actor:user beats every future automated verdict |
| F-139 | identity · user override | user answered 'different' on pair #3 last month; automation now scores 0.93 | NO merge; negative pair is permanent | actor:user beats every future automated verdict |
| F-140 | identity · user override | user answered 'different' on pair #4 last month; automation now scores 0.93 | NO merge; negative pair is permanent | actor:user beats every future automated verdict |
| F-141 | identity · user override | user answered 'different' on pair #5 last month; automation now scores 0.93 | NO merge; negative pair is permanent | actor:user beats every future automated verdict |
| F-142 | identity · user override | user answered 'different' on pair #6 last month; automation now scores 0.93 | NO merge; negative pair is permanent | actor:user beats every future automated verdict |
| F-143 | identity · user override | user answered 'different' on pair #7 last month; automation now scores 0.93 | NO merge; negative pair is permanent | actor:user beats every future automated verdict |
| F-144 | identity · user override | user answered 'different' on pair #8 last month; automation now scores 0.93 | NO merge; negative pair is permanent | actor:user beats every future automated verdict |
| F-145 | identity · user override | user answered 'different' on pair #9 last month; automation now scores 0.93 | NO merge; negative pair is permanent | actor:user beats every future automated verdict |
| F-146 | identity · user override | user answered 'different' on pair #10 last month; automation now scores 0.93 | NO merge; negative pair is permanent | actor:user beats every future automated verdict |
| F-147 | identity · tombstone | read entity B after merge B→A (1 refs via old id) | redirect via merged_into O(1); nightly compaction re-points refs | merges are reversible tombstones, not rewrites |
| F-148 | identity · tombstone | read entity B after merge B→A (2 refs via old id) | redirect via merged_into O(1); nightly compaction re-points refs | merges are reversible tombstones, not rewrites |
| F-149 | identity · tombstone | read entity B after merge B→A (3 refs via old id) | redirect via merged_into O(1); nightly compaction re-points refs | merges are reversible tombstones, not rewrites |
| F-150 | identity · tombstone | read entity B after merge B→A (4 refs via old id) | redirect via merged_into O(1); nightly compaction re-points refs | merges are reversible tombstones, not rewrites |
| F-151 | identity · tombstone | read entity B after merge B→A (5 refs via old id) | redirect via merged_into O(1); nightly compaction re-points refs | merges are reversible tombstones, not rewrites |
| F-152 | identity · tombstone | read entity B after merge B→A (6 refs via old id) | redirect via merged_into O(1); nightly compaction re-points refs | merges are reversible tombstones, not rewrites |
| F-153 | identity · tombstone | read entity B after merge B→A (7 refs via old id) | redirect via merged_into O(1); nightly compaction re-points refs | merges are reversible tombstones, not rewrites |
| F-154 | identity · tombstone | read entity B after merge B→A (8 refs via old id) | redirect via merged_into O(1); nightly compaction re-points refs | merges are reversible tombstones, not rewrites |
| F-155 | identity · tombstone | read entity B after merge B→A (9 refs via old id) | redirect via merged_into O(1); nightly compaction re-points refs | merges are reversible tombstones, not rewrites |
| F-156 | identity · tombstone | read entity B after merge B→A (10 refs via old id) | redirect via merged_into O(1); nightly compaction re-points refs | merges are reversible tombstones, not rewrites |
| F-157 | identity · split | user splits wrongly-merged entity (edges present on both sides) | split restores two entities; evidence rows re-point by source identity; mutation logged | wrong merges must be cheaply reversible |
| F-158 | identity · split | user splits wrongly-merged entity (mentions present on both sides) | split restores two entities; evidence rows re-point by source identity; mutation logged | wrong merges must be cheaply reversible |
| F-159 | identity · split | user splits wrongly-merged entity (identities present on both sides) | split restores two entities; evidence rows re-point by source identity; mutation logged | wrong merges must be cheaply reversible |
| F-160 | identity · split | user splits wrongly-merged entity (edges present on both sides) | split restores two entities; evidence rows re-point by source identity; mutation logged | wrong merges must be cheaply reversible |
| F-161 | identity · split | user splits wrongly-merged entity (mentions present on both sides) | split restores two entities; evidence rows re-point by source identity; mutation logged | wrong merges must be cheaply reversible |
| F-162 | identity · split | user splits wrongly-merged entity (identities present on both sides) | split restores two entities; evidence rows re-point by source identity; mutation logged | wrong merges must be cheaply reversible |
| F-163 | identity · handle collision | handle @rahul on slack — same string exists on another source for a different person | handles are per-source identities; NO cross-source bind on handle string alone | handle strings collide; only phone/email bind cross-source at CODE rung |
| F-164 | identity · handle collision | handle @rahul on x.com — same string exists on another source for a different person | handles are per-source identities; NO cross-source bind on handle string alone | handle strings collide; only phone/email bind cross-source at CODE rung |
| F-165 | identity · handle collision | handle @pran on slack — same string exists on another source for a different person | handles are per-source identities; NO cross-source bind on handle string alone | handle strings collide; only phone/email bind cross-source at CODE rung |
| F-166 | identity · handle collision | handle @pran on instagram — same string exists on another source for a different person | handles are per-source identities; NO cross-source bind on handle string alone | handle strings collide; only phone/email bind cross-source at CODE rung |
| F-167 | identity · handle collision | handle @aditya on x.com — same string exists on another source for a different person | handles are per-source identities; NO cross-source bind on handle string alone | handle strings collide; only phone/email bind cross-source at CODE rung |
| F-168 | identity · handle collision | handle @aditya on github — same string exists on another source for a different person | handles are per-source identities; NO cross-source bind on handle string alone | handle strings collide; only phone/email bind cross-source at CODE rung |
| F-169 | identity · handle collision | handle @keerti_k on instagram — same string exists on another source for a different person | handles are per-source identities; NO cross-source bind on handle string alone | handle strings collide; only phone/email bind cross-source at CODE rung |
| F-170 | identity · handle collision | handle @keerti on slack — same string exists on another source for a different person | handles are per-source identities; NO cross-source bind on handle string alone | handle strings collide; only phone/email bind cross-source at CODE rung |

## G — ENT-MEN (90)

_Mention linking (roster, pronouns, hints, ambiguity)_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| G-001 | mention · roster person | msg: 'ask Pranjali about the Goa trip' | mention → ent(Pranjali), confidence ≥0.9 | plain roster hit |
| G-002 | mention · roster person | msg: 'ask Rahul about the housing search' | mention → ent(Rahul), confidence ≥0.9 | plain roster hit |
| G-003 | mention · roster person | msg: 'ask Rashmi about the bhangra class' | mention → ent(Rashmi), confidence ≥0.9 | plain roster hit |
| G-004 | mention · roster person | msg: 'ask Sudhir about the therapy schedule' | mention → ent(Sudhir), confidence ≥0.9 | plain roster hit |
| G-005 | mention · roster person | msg: 'ask Hrishikesh about the tax filing' | mention → ent(Hrishikesh), confidence ≥0.9 | plain roster hit |
| G-006 | mention · roster person | msg: 'ask Gargi about the rabies shots' | mention → ent(Gargi), confidence ≥0.9 | plain roster hit |
| G-007 | mention · roster person | msg: 'ask Keerti about the muesli idea' | mention → ent(Keerti), confidence ≥0.9 | plain roster hit |
| G-008 | mention · roster person | msg: 'ask Prabhat about the local LLM setup' | mention → ent(Prabhat), confidence ≥0.9 | plain roster hit |
| G-009 | mention · roster person | msg: 'ask Rajat about the Rahul's wedding' | mention → ent(Rajat), confidence ≥0.9 | plain roster hit |
| G-010 | mention · roster person | msg: 'ask Mansi about the Gargi's 40th' | mention → ent(Mansi), confidence ≥0.9 | plain roster hit |
| G-011 | mention · roster person | msg: 'ask Natesh about the villa booking' | mention → ent(Natesh), confidence ≥0.9 | plain roster hit |
| G-012 | mention · roster person | msg: 'ask Shivangi about the broadband plan' | mention → ent(Shivangi), confidence ≥0.9 | plain roster hit |
| G-013 | mention · roster person | msg: 'ask Aakash about the Goa trip' | mention → ent(Aakash), confidence ≥0.9 | plain roster hit |
| G-014 | mention · roster person | msg: 'ask Bhavesh about the housing search' | mention → ent(Bhavesh), confidence ≥0.9 | plain roster hit |
| G-015 | mention · roster person | msg: 'ask Jitendra about the bhangra class' | mention → ent(Jitendra), confidence ≥0.9 | plain roster hit |
| G-016 | mention · roster person | msg: 'ask Plabita about the therapy schedule' | mention → ent(Plabita), confidence ≥0.9 | plain roster hit |
| G-017 | mention · roster person | msg: 'ask Vishal about the tax filing' | mention → ent(Vishal), confidence ≥0.9 | plain roster hit |
| G-018 | mention · roster person | msg: 'ask Mummy about the rabies shots' | mention → ent(Mummy), confidence ≥0.9 | plain roster hit |
| G-019 | mention · roster person | msg: 'ask Papa about the muesli idea' | mention → ent(Papa), confidence ≥0.9 | plain roster hit |
| G-020 | mention · roster person | msg: 'ask Didi about the local LLM setup' | mention → ent(Didi), confidence ≥0.9 | plain roster hit |
| G-021 | mention · place | msg mentions 'Indiranagar' | mention → place entity (Indiranagar); mint if novel with subtype | places are first-class entities |
| G-022 | mention · place | msg mentions 'Pizza 4P's' | mention → place entity (Pizza 4P's); mint if novel with subtype | places are first-class entities |
| G-023 | mention · place | msg mentions 'Vega City' | mention → place entity (Vega City); mint if novel with subtype | places are first-class entities |
| G-024 | mention · place | msg mentions 'Domlur' | mention → place entity (Domlur); mint if novel with subtype | places are first-class entities |
| G-025 | mention · place | msg mentions 'Ratlam' | mention → place entity (Ratlam); mint if novel with subtype | places are first-class entities |
| G-026 | mention · place | msg mentions 'Goa' | mention → place entity (Goa); mint if novel with subtype | places are first-class entities |
| G-027 | mention · place | msg mentions 'Bangalore' | mention → place entity (Bangalore); mint if novel with subtype | places are first-class entities |
| G-028 | mention · place | msg mentions 'the metro station' | mention → place entity (the metro station); mint if novel with subtype | places are first-class entities |
| G-029 | mention · place | msg mentions 'Koramangala' | mention → place entity (Koramangala); mint if novel with subtype | places are first-class entities |
| G-030 | mention · place | msg mentions 'HSR' | mention → place entity (HSR); mint if novel with subtype | places are first-class entities |
| G-031 | mention · product/service/thing | msg mentions 'M2 MacBook' | mention typed correctly (product/service/pet/app_site/document/place) | type discipline from the closed 16-type list |
| G-032 | mention · product/service/thing | msg mentions 'the air fryer' | mention typed correctly (product/service/pet/app_site/document/place) | type discipline from the closed 16-type list |
| G-033 | mention · product/service/thing | msg mentions 'Wispr Flow' | mention typed correctly (product/service/pet/app_site/document/place) | type discipline from the closed 16-type list |
| G-034 | mention · product/service/thing | msg mentions 'Superhuman' | mention typed correctly (product/service/pet/app_site/document/place) | type discipline from the closed 16-type list |
| G-035 | mention · product/service/thing | msg mentions 'broadband plan' | mention typed correctly (product/service/pet/app_site/document/place) | type discipline from the closed 16-type list |
| G-036 | mention · product/service/thing | msg mentions 'muesli' | mention typed correctly (product/service/pet/app_site/document/place) | type discipline from the closed 16-type list |
| G-037 | mention · product/service/thing | msg mentions 'the Rottweiler? (pet)' | mention typed correctly (product/service/pet/app_site/document/place) | type discipline from the closed 16-type list |
| G-038 | mention · product/service/thing | msg mentions 'Claude CLI' | mention typed correctly (product/service/pet/app_site/document/place) | type discipline from the closed 16-type list |
| G-039 | mention · product/service/thing | msg mentions 'rent agreement PDF' | mention typed correctly (product/service/pet/app_site/document/place) | type discipline from the closed 16-type list |
| G-040 | mention · product/service/thing | msg mentions 'the villa' | mention typed correctly (product/service/pet/app_site/document/place) | type discipline from the closed 16-type list |
| G-041 | mention · media_work | msg: 'watched that WWE match last night' | mention → media_work entity (mint w/ subtype) | media works enable cross-source media bridges later |
| G-042 | mention · media_work | msg: 'watched the Odyssey last night' | mention → media_work entity (mint w/ subtype) | media works enable cross-source media bridges later |
| G-043 | mention · media_work | msg: 'watched a YouTube video on local LLMs last night' | mention → media_work entity (mint w/ subtype) | media works enable cross-source media bridges later |
| G-044 | mention · media_work | msg: 'watched the book Rahul recommended last night' | mention → media_work entity (mint w/ subtype) | media works enable cross-source media bridges later |
| G-045 | mention · media_work | msg: 'watched the new SRK film last night' | mention → media_work entity (mint w/ subtype) | media works enable cross-source media bridges later |
| G-046 | mention · media_work | msg: 'watched the podcast episode last night' | mention → media_work entity (mint w/ subtype) | media works enable cross-source media bridges later |
| G-047 | mention · media_work | msg: 'watched Didi's reel last night' | mention → media_work entity (mint w/ subtype) | media works enable cross-source media bridges later |
| G-048 | mention · media_work | msg: 'watched the wedding video last night' | mention → media_work entity (mint w/ subtype) | media works enable cross-source media bridges later |
| G-049 | mention · food_item | msg mentions 'chole bhature' | mention → food_item entity | recurring dishes/recipes are entities |
| G-050 | mention · food_item | msg mentions 'the baked thing I tried' | mention → food_item entity | recurring dishes/recipes are entities |
| G-051 | mention · food_item | msg mentions 'biryani from that place' | mention → food_item entity | recurring dishes/recipes are entities |
| G-052 | mention · food_item | msg mentions 'pudina chutney' | mention → food_item entity | recurring dishes/recipes are entities |
| G-053 | mention · food_item | msg mentions 'the muesli mix' | mention → food_item entity | recurring dishes/recipes are entities |
| G-054 | mention · food_item | msg mentions 'paneer recipe' | mention → food_item entity | recurring dishes/recipes are entities |
| G-055 | mention · health_item | msg mentions 'rabies shot #3' | mention → health_item entity (condition/medication/treatment/procedure) | health items are entities; claims about them come later layers |
| G-056 | mention · health_item | msg mentions 'arthritis treatment' | mention → health_item entity (condition/medication/treatment/procedure) | health items are entities; claims about them come later layers |
| G-057 | mention · health_item | msg mentions 'the new dose since 2 Aug' | mention → health_item entity (condition/medication/treatment/procedure) | health items are entities; claims about them come later layers |
| G-058 | mention · health_item | msg mentions 'therapy session' | mention → health_item entity (condition/medication/treatment/procedure) | health items are entities; claims about them come later layers |
| G-059 | mention · health_item | msg mentions 'eye check-up' | mention → health_item entity (condition/medication/treatment/procedure) | health items are entities; claims about them come later layers |
| G-060 | mention · health_item | msg mentions 'BP medicine' | mention → health_item entity (condition/medication/treatment/procedure) | health items are entities; claims about them come later layers |
| G-061 | mention · pronoun in-session | [Pranjali]: 'she said the reports are clear' — only Rahul (F) discussed earlier IN THIS session | 'she' → ent(Rahul) (unambiguous within session) | pronouns resolve within the session only |
| G-062 | mention · pronoun in-session | [Rahul]: 'she said the reports are clear' — only Rashmi (F) discussed earlier IN THIS session | 'she' → ent(Rashmi) (unambiguous within session) | pronouns resolve within the session only |
| G-063 | mention · pronoun in-session | [Rashmi]: 'she said the reports are clear' — only Sudhir (F) discussed earlier IN THIS session | 'she' → ent(Sudhir) (unambiguous within session) | pronouns resolve within the session only |
| G-064 | mention · pronoun in-session | [Sudhir]: 'she said the reports are clear' — only Hrishikesh (F) discussed earlier IN THIS session | 'she' → ent(Hrishikesh) (unambiguous within session) | pronouns resolve within the session only |
| G-065 | mention · pronoun in-session | [Hrishikesh]: 'she said the reports are clear' — only Gargi (F) discussed earlier IN THIS session | 'she' → ent(Gargi) (unambiguous within session) | pronouns resolve within the session only |
| G-066 | mention · pronoun in-session | [Gargi]: 'she said the reports are clear' — only Keerti (F) discussed earlier IN THIS session | 'she' → ent(Keerti) (unambiguous within session) | pronouns resolve within the session only |
| G-067 | mention · pronoun in-session | [Keerti]: 'she said the reports are clear' — only Prabhat (F) discussed earlier IN THIS session | 'she' → ent(Prabhat) (unambiguous within session) | pronouns resolve within the session only |
| G-068 | mention · pronoun in-session | [Prabhat]: 'she said the reports are clear' — only Pranjali (F) discussed earlier IN THIS session | 'she' → ent(Pranjali) (unambiguous within session) | pronouns resolve within the session only |
| G-069 | mention · pronoun in-session | [Pranjali]: 'she said the reports are clear' — only Rahul (F) discussed earlier IN THIS session | 'she' → ent(Rahul) (unambiguous within session) | pronouns resolve within the session only |
| G-070 | mention · pronoun in-session | [Rahul]: 'she said the reports are clear' — only Rashmi (F) discussed earlier IN THIS session | 'she' → ent(Rashmi) (unambiguous within session) | pronouns resolve within the session only |
| G-071 | mention · pronoun in-session | [Rashmi]: 'she said the reports are clear' — only Sudhir (F) discussed earlier IN THIS session | 'she' → ent(Sudhir) (unambiguous within session) | pronouns resolve within the session only |
| G-072 | mention · pronoun in-session | [Sudhir]: 'she said the reports are clear' — only Hrishikesh (F) discussed earlier IN THIS session | 'she' → ent(Hrishikesh) (unambiguous within session) | pronouns resolve within the session only |
| G-073 | mention · off-roster hint | msg mentions 'the broker', no roster candidate | entity_id NULL + entity_hint 'the broker'; optional question | unknown beats wrong — hints are honest |
| G-074 | mention · off-roster hint | msg mentions 'the electrician', no roster candidate | entity_id NULL + entity_hint 'the electrician'; optional question | unknown beats wrong — hints are honest |
| G-075 | mention · off-roster hint | msg mentions 'Rahul's cousin', no roster candidate | entity_id NULL + entity_hint 'Rahul's cousin'; optional question | unknown beats wrong — hints are honest |
| G-076 | mention · off-roster hint | msg mentions 'the new PM', no roster candidate | entity_id NULL + entity_hint 'the new PM'; optional question | unknown beats wrong — hints are honest |
| G-077 | mention · off-roster hint | msg mentions 'the landlord', no roster candidate | entity_id NULL + entity_hint 'the landlord'; optional question | unknown beats wrong — hints are honest |
| G-078 | mention · off-roster hint | msg mentions 'didi's neighbour', no roster candidate | entity_id NULL + entity_hint 'didi's neighbour'; optional question | unknown beats wrong — hints are honest |
| G-079 | mention · off-roster hint | msg mentions 'the cab guy', no roster candidate | entity_id NULL + entity_hint 'the cab guy'; optional question | unknown beats wrong — hints are honest |
| G-080 | mention · off-roster hint | msg mentions 'the trainer', no roster candidate | entity_id NULL + entity_hint 'the trainer'; optional question | unknown beats wrong — hints are honest |
| G-081 | mention · off-roster hint | msg mentions 'the CA', no roster candidate | entity_id NULL + entity_hint 'the CA'; optional question | unknown beats wrong — hints are honest |
| G-082 | mention · off-roster hint | msg mentions 'the caterer', no roster candidate | entity_id NULL + entity_hint 'the caterer'; optional question | unknown beats wrong — hints are honest |
| G-083 | mention · ambiguous → ask | 'tell Amit' — TWO roster Amits, both plausible in context | entity_id NULL + hint 'Amit (which?)' + question raised | two live candidates is a question, never a coin flip |
| G-084 | mention · ambiguous → ask | 'tell Amit' — TWO roster Amits, both plausible in context | entity_id NULL + hint 'Amit (which?)' + question raised | two live candidates is a question, never a coin flip |
| G-085 | mention · ambiguous → ask | 'tell Amit' — TWO roster Amits, both plausible in context | entity_id NULL + hint 'Amit (which?)' + question raised | two live candidates is a question, never a coin flip |
| G-086 | mention · ambiguous → ask | 'tell Amit' — TWO roster Amits, both plausible in context | entity_id NULL + hint 'Amit (which?)' + question raised | two live candidates is a question, never a coin flip |
| G-087 | mention · ambiguous → ask | 'tell Amit' — TWO roster Amits, both plausible in context | entity_id NULL + hint 'Amit (which?)' + question raised | two live candidates is a question, never a coin flip |
| G-088 | mention · ambiguous → ask | 'tell Amit' — TWO roster Amits, both plausible in context | entity_id NULL + hint 'Amit (which?)' + question raised | two live candidates is a question, never a coin flip |
| G-089 | mention · ambiguous → ask | 'tell Amit' — TWO roster Amits, both plausible in context | entity_id NULL + hint 'Amit (which?)' + question raised | two live candidates is a question, never a coin flip |
| G-090 | mention · ambiguous → ask | 'tell Amit' — TWO roster Amits, both plausible in context | entity_id NULL + hint 'Amit (which?)' + question raised | two live candidates is a question, never a coin flip |

## H — ENT-EDGE (70)

_Relations / edges (family, work, care, metadata edges, validity)_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| H-001 | edge · family_of | quote 'meri didi' about Rashmi | family_of:sibling edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-002 | edge · family_of | quote 'maa' about Mummy | family_of:mother edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-003 | edge · family_of | quote 'papa' about Papa | family_of:father edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-004 | edge · family_of | quote 'Didi's son turned 1' about Shaurya | family_of:child-of-Didi edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-005 | edge · family_of | quote 'cousin Gargi' about Gargi | family_of:cousin edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-006 | edge · family_of | quote 'bhabhi' about Keerti | family_of:in_law edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-007 | edge · family_of | quote 'didi' about Didi | family_of:sibling edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-008 | edge · family_of | quote 'Nana blessed him' about Nana | family_of:grandparent edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-009 | edge · family_of | quote 'meri didi' about Rashmi | family_of:sibling edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-010 | edge · family_of | quote 'maa' about Mummy | family_of:mother edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-011 | edge · family_of | quote 'papa' about Papa | family_of:father edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-012 | edge · family_of | quote 'Didi's son turned 1' about Shaurya | family_of:child-of-Didi edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-013 | edge · family_of | quote 'cousin Gargi' about Gargi | family_of:cousin edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-014 | edge · family_of | quote 'bhabhi' about Keerti | family_of:in_law edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-015 | edge · family_of | quote 'didi' about Didi | family_of:sibling edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-016 | edge · family_of | quote 'Nana blessed him' about Nana | family_of:grandparent edge with verbatim quote, conf model-set | family edges from text need quotes |
| H-017 | edge · works_at/works_with | evidence that Bhavesh works at Hotstar | works_at or works_with edge; valid_from if stated | professional edges are durable structural relations |
| H-018 | edge · works_at/works_with | evidence that Sudhir works at Hotstar | works_at or works_with edge; valid_from if stated | professional edges are durable structural relations |
| H-019 | edge · works_at/works_with | evidence that Rashmi works at her new office | works_at or works_with edge; valid_from if stated | professional edges are durable structural relations |
| H-020 | edge · works_at/works_with | evidence that Prakul works at (his firm) | works_at or works_with edge; valid_from if stated | professional edges are durable structural relations |
| H-021 | edge · works_at/works_with | evidence that me works at (side project) | works_at or works_with edge; valid_from if stated | professional edges are durable structural relations |
| H-022 | edge · works_at/works_with | evidence that Rajat works at office in Domlur | works_at or works_with edge; valid_from if stated | professional edges are durable structural relations |
| H-023 | edge · works_at/works_with | evidence that Mansi works at (her company) | works_at or works_with edge; valid_from if stated | professional edges are durable structural relations |
| H-024 | edge · works_at/works_with | evidence that Natesh works at (his startup) | works_at or works_with edge; valid_from if stated | professional edges are durable structural relations |
| H-025 | edge · member_of [CODE] | group 'Ghar+' participant list includes Pranjali | member_of edge [CODE] conf 1.0, zero model calls | metadata edges are free and exact — extract before any model |
| H-026 | edge · member_of [CODE] | group 'Goa Crew' participant list includes Rahul | member_of edge [CODE] conf 1.0, zero model calls | metadata edges are free and exact — extract before any model |
| H-027 | edge · member_of [CODE] | group 'Family' participant list includes Rashmi | member_of edge [CODE] conf 1.0, zero model calls | metadata edges are free and exact — extract before any model |
| H-028 | edge · member_of [CODE] | group 'Office Frandss' participant list includes Sudhir | member_of edge [CODE] conf 1.0, zero model calls | metadata edges are free and exact — extract before any model |
| H-029 | edge · member_of [CODE] | group 'Society' participant list includes Hrishikesh | member_of edge [CODE] conf 1.0, zero model calls | metadata edges are free and exact — extract before any model |
| H-030 | edge · member_of [CODE] | group 'Cousins' participant list includes Gargi | member_of edge [CODE] conf 1.0, zero model calls | metadata edges are free and exact — extract before any model |
| H-031 | edge · member_of [CODE] | group 'Book club' participant list includes Keerti | member_of edge [CODE] conf 1.0, zero model calls | metadata edges are free and exact — extract before any model |
| H-032 | edge · member_of [CODE] | group 'Trek 2026' participant list includes Prabhat | member_of edge [CODE] conf 1.0, zero model calls | metadata edges are free and exact — extract before any model |
| H-033 | edge · member_of [CODE] | group 'School WA' participant list includes Rajat | member_of edge [CODE] conf 1.0, zero model calls | metadata edges are free and exact — extract before any model |
| H-034 | edge · member_of [CODE] | group 'Badminton' participant list includes Mansi | member_of edge [CODE] conf 1.0, zero model calls | metadata edges are free and exact — extract before any model |
| H-035 | edge · provides_care | recurring appointments/quotes establish Dr. Shreedhar as doctor | provides_care:doctor edge → me (or the correct patient) | care relations power later scheduling layers |
| H-036 | edge · provides_care | recurring appointments/quotes establish the therapist as therapist | provides_care:therapist edge → me (or the correct patient) | care relations power later scheduling layers |
| H-037 | edge · provides_care | recurring appointments/quotes establish Prabhat as cook | provides_care:cook edge → me (or the correct patient) | care relations power later scheduling layers |
| H-038 | edge · provides_care | recurring appointments/quotes establish the trainer as trainer | provides_care:trainer edge → me (or the correct patient) | care relations power later scheduling layers |
| H-039 | edge · provides_care | recurring appointments/quotes establish Dr. Rao as doctor | provides_care:doctor edge → me (or the correct patient) | care relations power later scheduling layers |
| H-040 | edge · provides_care | recurring appointments/quotes establish the maid as domestic_help | provides_care:domestic_help edge → me (or the correct patient) | care relations power later scheduling layers |
| H-041 | edge · provides_care | recurring appointments/quotes establish physio as therapist | provides_care:therapist edge → me (or the correct patient) | care relations power later scheduling layers |
| H-042 | edge · provides_care | recurring appointments/quotes establish yoga teacher as trainer | provides_care:trainer edge → me (or the correct patient) | care relations power later scheduling layers |
| H-043 | edge · pet_of | 'Pranjali''s dog' referenced repeatedly | pet entity + pet_of edge to owner | pets are entities with ownership edges |
| H-044 | edge · pet_of | 'the neighbour''s dog' referenced repeatedly | pet entity + pet_of edge to owner | pets are entities with ownership edges |
| H-045 | edge · pet_of | 'Rahul''s dog' referenced repeatedly | pet entity + pet_of edge to owner | pets are entities with ownership edges |
| H-046 | edge · pet_of | 'Keerti''s dog' referenced repeatedly | pet entity + pet_of edge to owner | pets are entities with ownership edges |
| H-047 | edge · owns | evidence about M2 MacBook | owns edge ONLY for ownership; the villa booking is NOT owns (skip) | edge discipline: bookings/rentals are not ownership |
| H-048 | edge · owns | evidence about the air fryer | owns edge ONLY for ownership; the villa booking is NOT owns (skip) | edge discipline: bookings/rentals are not ownership |
| H-049 | edge · owns | evidence about a farm with basil | owns edge ONLY for ownership; the villa booking is NOT owns (skip) | edge discipline: bookings/rentals are not ownership |
| H-050 | edge · owns | evidence about the car | owns edge ONLY for ownership; the villa booking is NOT owns (skip) | edge discipline: bookings/rentals are not ownership |
| H-051 | edge · owns | evidence about new phone | owns edge ONLY for ownership; the villa booking is NOT owns (skip) | edge discipline: bookings/rentals are not ownership |
| H-052 | edge · owns | evidence about the villa (booked, not owned!) | owns edge ONLY for ownership; the villa booking is NOT owns (skip) | edge discipline: bookings/rentals are not ownership |
| H-053 | edge · subscribes_to | receipts/cancellation talk about Superhuman | subscribes_to edge; valid_to set on cancellation evidence | subscriptions carry temporal validity |
| H-054 | edge · subscribes_to | receipts/cancellation talk about Wispr Flow | subscribes_to edge; valid_to set on cancellation evidence | subscriptions carry temporal validity |
| H-055 | edge · subscribes_to | receipts/cancellation talk about broadband plan | subscribes_to edge; valid_to set on cancellation evidence | subscriptions carry temporal validity |
| H-056 | edge · subscribes_to | receipts/cancellation talk about Netflix | subscribes_to edge; valid_to set on cancellation evidence | subscriptions carry temporal validity |
| H-057 | edge · subscribes_to | receipts/cancellation talk about Spotify | subscribes_to edge; valid_to set on cancellation evidence | subscriptions carry temporal validity |
| H-058 | edge · lives_at | evidence Rahul lives at/moves to Indiranagar | lives_at:current edge; prior lives_at gets valid_to + superseded | moves supersede, never overwrite |
| H-059 | edge · lives_at | evidence me lives at/moves to Bangalore | lives_at:current edge; prior lives_at gets valid_to + superseded | moves supersede, never overwrite |
| H-060 | edge · lives_at | evidence Mummy/Papa lives at/moves to hometown | lives_at:current edge; prior lives_at gets valid_to + superseded | moves supersede, never overwrite |
| H-061 | edge · lives_at | evidence Didi lives at/moves to America | lives_at:current edge; prior lives_at gets valid_to + superseded | moves supersede, never overwrite |
| H-062 | edge · lives_at | evidence Rajat lives at/moves to Domlur (office) | lives_at:current edge; prior lives_at gets valid_to + superseded | moves supersede, never overwrite |
| H-063 | edge · lives_at | evidence Hrishikesh lives at/moves to (his area) | lives_at:current edge; prior lives_at gets valid_to + superseded | moves supersede, never overwrite |
| H-064 | edge · validity change | contradiction arrives: Prabhat stopped cooking | old edge valid_to+status=superseded with evidence; new edge if stated | contradictions close edges with provenance |
| H-065 | edge · validity change | contradiction arrives: Rashmi left the office | old edge valid_to+status=superseded with evidence; new edge if stated | contradictions close edges with provenance |
| H-066 | edge · validity change | contradiction arrives: broadband switched | old edge valid_to+status=superseded with evidence; new edge if stated | contradictions close edges with provenance |
| H-067 | edge · validity change | contradiction arrives: trainer changed | old edge valid_to+status=superseded with evidence; new edge if stated | contradictions close edges with provenance |
| H-068 | edge · about/participant_in | calendar invite 'Standup 10:00–10:15' with attendees | participant_in edges [CODE] from attendees; about edge to occasion topic | calendar metadata yields free edges |
| H-069 | edge · about/participant_in | calendar invite 'Dr. Shreedhar 16:00–16:30' with attendees | participant_in edges [CODE] from attendees; about edge to occasion topic | calendar metadata yields free edges |
| H-070 | edge · about/participant_in | calendar invite 'Gargi's 40th 19:00–23:00' with attendees | participant_in edges [CODE] from attendees; about edge to occasion topic | calendar metadata yields free edges |

## I — ENR (30)

_Enrichment executor routing (LLM-S vs ML vs CODE)_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| I-001 | enrich routing · image | photo #1 (menu/screenshot/document/person/receipt) | caption via [LLM-S] Haiku-class CLI bare call (batched, hallucination guard) | vision is a small hosted LLM, NOT on-device ML |
| I-002 | enrich routing · image | photo #2 (menu/screenshot/document/person/receipt) | caption via [LLM-S] Haiku-class CLI bare call (batched, hallucination guard) | vision is a small hosted LLM, NOT on-device ML |
| I-003 | enrich routing · image | photo #3 (menu/screenshot/document/person/receipt) | caption via [LLM-S] Haiku-class CLI bare call (batched, hallucination guard) | vision is a small hosted LLM, NOT on-device ML |
| I-004 | enrich routing · image | photo #4 (menu/screenshot/document/person/receipt) | caption via [LLM-S] Haiku-class CLI bare call (batched, hallucination guard) | vision is a small hosted LLM, NOT on-device ML |
| I-005 | enrich routing · image | photo #5 (menu/screenshot/document/person/receipt) | caption via [LLM-S] Haiku-class CLI bare call (batched, hallucination guard) | vision is a small hosted LLM, NOT on-device ML |
| I-006 | enrich routing · sticker | sticker received | describe via [LLM-S]; cheap; solo-degrade on batch mismatch | V11 pipeline kept |
| I-007 | enrich routing · sticker | sticker received | describe via [LLM-S]; cheap; solo-degrade on batch mismatch | V11 pipeline kept |
| I-008 | enrich routing · sticker | sticker received | describe via [LLM-S]; cheap; solo-degrade on batch mismatch | V11 pipeline kept |
| I-009 | enrich routing · video | 15s video | [CODE] ffmpeg frame sample → ONE [LLM-S] call for all frames | one call per video, never per frame |
| I-010 | enrich routing · video | 35s video | [CODE] ffmpeg frame sample → ONE [LLM-S] call for all frames | one call per video, never per frame |
| I-011 | enrich routing · video | 55s video | [CODE] ffmpeg frame sample → ONE [LLM-S] call for all frames | one call per video, never per frame |
| I-012 | enrich routing · video | 75s video | [CODE] ffmpeg frame sample → ONE [LLM-S] call for all frames | one call per video, never per frame |
| I-013 | enrich routing · voice note | 10s voice note | [ML] whisper.cpp on-device; NO LLM | transcription is on-device ML |
| I-014 | enrich routing · voice note | 25s voice note | [ML] whisper.cpp on-device; NO LLM | transcription is on-device ML |
| I-015 | enrich routing · voice note | 40s voice note | [ML] whisper.cpp on-device; NO LLM | transcription is on-device ML |
| I-016 | enrich routing · voice note | 55s voice note | [ML] whisper.cpp on-device; NO LLM | transcription is on-device ML |
| I-017 | enrich routing · voice note | 70s voice note | [ML] whisper.cpp on-device; NO LLM | transcription is on-device ML |
| I-018 | enrich routing · link | link to airbnb.com | [CODE] fetch+scrape; og fill; no model | scraping is code |
| I-019 | enrich routing · link | link to booking.com | [CODE] fetch+scrape; og fill; no model | scraping is code |
| I-020 | enrich routing · link | link to zomato.com | [CODE] fetch+scrape; og fill; no model | scraping is code |
| I-021 | enrich routing · link | link to youtube.com | [CODE] fetch+scrape; og fill; no model | scraping is code |
| I-022 | enrich routing · link | link to amazon.in | [CODE] fetch+scrape; og fill; no model | scraping is code |
| I-023 | enrich routing · YouTube link | youtube.com/watch?v=… | [CODE] yt-dlp captions; no model | captions are code |
| I-024 | enrich routing · YouTube link | youtube.com/watch?v=… | [CODE] yt-dlp captions; no model | captions are code |
| I-025 | enrich routing · YouTube link | youtube.com/watch?v=… | [CODE] yt-dlp captions; no model | captions are code |
| I-026 | enrich routing · embedding | any text event | [ML] e5-small int8 on-device | embeddings are on-device |
| I-027 | enrich routing · embedding | any text event | [ML] e5-small int8 on-device | embeddings are on-device |
| I-028 | enrich routing · embedding | any text event | [ML] e5-small int8 on-device | embeddings are on-device |
| I-029 | enrich routing · budget | quiet day, 4 texts, no media | ZERO LLM enrichment calls | enrichment cost scales with media, not time |
| I-030 | enrich routing · budget | quiet day, 4 texts, no media | ZERO LLM enrichment calls | enrichment cost scales with media, not time |

## J — EPI (100)

_Episodes (1:1 default, split, attach, aging, replay) — Phase 2_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| J-001 | episode · 1:1 default | sealed session solely about Goa trip; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-002 | episode · 1:1 default | sealed session solely about housing search; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-003 | episode · 1:1 default | sealed session solely about bhangra class; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-004 | episode · 1:1 default | sealed session solely about therapy schedule; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-005 | episode · 1:1 default | sealed session solely about tax filing; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-006 | episode · 1:1 default | sealed session solely about rabies shots; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-007 | episode · 1:1 default | sealed session solely about muesli idea; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-008 | episode · 1:1 default | sealed session solely about local LLM setup; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-009 | episode · 1:1 default | sealed session solely about Rahul's wedding; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-010 | episode · 1:1 default | sealed session solely about Gargi's 40th; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-011 | episode · 1:1 default | sealed session solely about villa booking; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-012 | episode · 1:1 default | sealed session solely about broadband plan; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-013 | episode · 1:1 default | sealed session solely about Goa trip; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-014 | episode · 1:1 default | sealed session solely about housing search; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-015 | episode · 1:1 default | sealed session solely about bhangra class; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-016 | episode · 1:1 default | sealed session solely about therapy schedule; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-017 | episode · 1:1 default | sealed session solely about tax filing; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-018 | episode · 1:1 default | sealed session solely about rabies shots; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-019 | episode · 1:1 default | sealed session solely about muesli idea; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-020 | episode · 1:1 default | sealed session solely about local LLM setup; no drift; no open episodes in stream | episode := session, NO model call | the common case is free |
| J-021 | episode · split | one session pivots Goa trip → rabies shots (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-022 | episode · split | one session pivots housing search → muesli idea (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-023 | episode · split | one session pivots bhangra class → local LLM setup (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-024 | episode · split | one session pivots therapy schedule → Rahul's wedding (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-025 | episode · split | one session pivots tax filing → Gargi's 40th (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-026 | episode · split | one session pivots rabies shots → villa booking (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-027 | episode · split | one session pivots muesli idea → broadband plan (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-028 | episode · split | one session pivots local LLM setup → Goa trip (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-029 | episode · split | one session pivots Rahul's wedding → housing search (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-030 | episode · split | one session pivots Gargi's 40th → bhangra class (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-031 | episode · split | one session pivots villa booking → therapy schedule (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-032 | episode · split | one session pivots broadband plan → tax filing (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-033 | episode · split | one session pivots Goa trip → rabies shots (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-034 | episode · split | one session pivots housing search → muesli idea (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-035 | episode · split | one session pivots bhangra class → local LLM setup (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-036 | episode · split | one session pivots therapy schedule → Rahul's wedding (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-037 | episode · split | one session pivots tax filing → Gargi's 40th (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-038 | episode · split | one session pivots rabies shots → villa booking (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-039 | episode · split | one session pivots muesli idea → broadband plan (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-040 | episode · split | one session pivots local LLM setup → Goa trip (≥2 events each) | P-EP2 splits into 2 segments partitioning event ids; two episodes | genuine topic change splits; segments partition exactly |
| J-041 | episode · attach | new session resumes Goa trip; open episode (last activity 1d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-042 | episode · attach | new session resumes housing search; open episode (last activity 2d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-043 | episode · attach | new session resumes bhangra class; open episode (last activity 3d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-044 | episode · attach | new session resumes therapy schedule; open episode (last activity 4d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-045 | episode · attach | new session resumes tax filing; open episode (last activity 5d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-046 | episode · attach | new session resumes rabies shots; open episode (last activity 6d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-047 | episode · attach | new session resumes muesli idea; open episode (last activity 1d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-048 | episode · attach | new session resumes local LLM setup; open episode (last activity 2d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-049 | episode · attach | new session resumes Rahul's wedding; open episode (last activity 3d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-050 | episode · attach | new session resumes Gargi's 40th; open episode (last activity 4d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-051 | episode · attach | new session resumes villa booking; open episode (last activity 5d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-052 | episode · attach | new session resumes broadband plan; open episode (last activity 6d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-053 | episode · attach | new session resumes Goa trip; open episode (last activity 1d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-054 | episode · attach | new session resumes housing search; open episode (last activity 2d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-055 | episode · attach | new session resumes bhangra class; open episode (last activity 3d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-056 | episode · attach | new session resumes therapy schedule; open episode (last activity 4d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-057 | episode · attach | new session resumes tax filing; open episode (last activity 5d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-058 | episode · attach | new session resumes rabies shots; open episode (last activity 6d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-059 | episode · attach | new session resumes muesli idea; open episode (last activity 1d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-060 | episode · attach | new session resumes local LLM setup; open episode (last activity 2d ago) in SAME stream | attach to open episode; verdict row stores candidates+reason | same matter accretes; days later is fine |
| J-061 | episode · NO cross-stream attach | 'Goa trip' discussed in Pranjali chat AND Hrishikesh chat | two separate episodes (different streams); joining is ARC work | episode matching is stream-scoped, always |
| J-062 | episode · NO cross-stream attach | 'housing search' discussed in Pranjali chat AND Hrishikesh chat | two separate episodes (different streams); joining is ARC work | episode matching is stream-scoped, always |
| J-063 | episode · NO cross-stream attach | 'bhangra class' discussed in Pranjali chat AND Hrishikesh chat | two separate episodes (different streams); joining is ARC work | episode matching is stream-scoped, always |
| J-064 | episode · NO cross-stream attach | 'therapy schedule' discussed in Pranjali chat AND Hrishikesh chat | two separate episodes (different streams); joining is ARC work | episode matching is stream-scoped, always |
| J-065 | episode · NO cross-stream attach | 'tax filing' discussed in Pranjali chat AND Hrishikesh chat | two separate episodes (different streams); joining is ARC work | episode matching is stream-scoped, always |
| J-066 | episode · NO cross-stream attach | 'rabies shots' discussed in Pranjali chat AND Hrishikesh chat | two separate episodes (different streams); joining is ARC work | episode matching is stream-scoped, always |
| J-067 | episode · NO cross-stream attach | 'muesli idea' discussed in Pranjali chat AND Hrishikesh chat | two separate episodes (different streams); joining is ARC work | episode matching is stream-scoped, always |
| J-068 | episode · NO cross-stream attach | 'local LLM setup' discussed in Pranjali chat AND Hrishikesh chat | two separate episodes (different streams); joining is ARC work | episode matching is stream-scoped, always |
| J-069 | episode · NO cross-stream attach | 'Rahul's wedding' discussed in Pranjali chat AND Hrishikesh chat | two separate episodes (different streams); joining is ARC work | episode matching is stream-scoped, always |
| J-070 | episode · NO cross-stream attach | 'Gargi's 40th' discussed in Pranjali chat AND Hrishikesh chat | two separate episodes (different streams); joining is ARC work | episode matching is stream-scoped, always |
| J-071 | episode · faded | open episode quiet for 14d | arc_state=closed, outcome=faded [CODE]; topic returning later = NEW episode | lifecycle is code, never model-declared |
| J-072 | episode · faded | open episode quiet for 15d | arc_state=closed, outcome=faded [CODE]; topic returning later = NEW episode | lifecycle is code, never model-declared |
| J-073 | episode · faded | open episode quiet for 16d | arc_state=closed, outcome=faded [CODE]; topic returning later = NEW episode | lifecycle is code, never model-declared |
| J-074 | episode · faded | open episode quiet for 17d | arc_state=closed, outcome=faded [CODE]; topic returning later = NEW episode | lifecycle is code, never model-declared |
| J-075 | episode · faded | open episode quiet for 18d | arc_state=closed, outcome=faded [CODE]; topic returning later = NEW episode | lifecycle is code, never model-declared |
| J-076 | episode · faded | open episode quiet for 19d | arc_state=closed, outcome=faded [CODE]; topic returning later = NEW episode | lifecycle is code, never model-declared |
| J-077 | episode · faded | open episode quiet for 20d | arc_state=closed, outcome=faded [CODE]; topic returning later = NEW episode | lifecycle is code, never model-declared |
| J-078 | episode · faded | open episode quiet for 21d | arc_state=closed, outcome=faded [CODE]; topic returning later = NEW episode | lifecycle is code, never model-declared |
| J-079 | episode · faded | open episode quiet for 22d | arc_state=closed, outcome=faded [CODE]; topic returning later = NEW episode | lifecycle is code, never model-declared |
| J-080 | episode · faded | open episode quiet for 23d | arc_state=closed, outcome=faded [CODE]; topic returning later = NEW episode | lifecycle is code, never model-declared |
| J-081 | episode · verdict replay | re-run pipeline over same sealed sessions (run #2) | identical episodes — verdicts reused, zero re-judging, zero new calls | persisted verdicts make boundaries reproducible |
| J-082 | episode · verdict replay | re-run pipeline over same sealed sessions (run #3) | identical episodes — verdicts reused, zero re-judging, zero new calls | persisted verdicts make boundaries reproducible |
| J-083 | episode · verdict replay | re-run pipeline over same sealed sessions (run #4) | identical episodes — verdicts reused, zero re-judging, zero new calls | persisted verdicts make boundaries reproducible |
| J-084 | episode · verdict replay | re-run pipeline over same sealed sessions (run #5) | identical episodes — verdicts reused, zero re-judging, zero new calls | persisted verdicts make boundaries reproducible |
| J-085 | episode · verdict replay | re-run pipeline over same sealed sessions (run #6) | identical episodes — verdicts reused, zero re-judging, zero new calls | persisted verdicts make boundaries reproducible |
| J-086 | episode · verdict replay | re-run pipeline over same sealed sessions (run #7) | identical episodes — verdicts reused, zero re-judging, zero new calls | persisted verdicts make boundaries reproducible |
| J-087 | episode · verdict replay | re-run pipeline over same sealed sessions (run #8) | identical episodes — verdicts reused, zero re-judging, zero new calls | persisted verdicts make boundaries reproducible |
| J-088 | episode · verdict replay | re-run pipeline over same sealed sessions (run #9) | identical episodes — verdicts reused, zero re-judging, zero new calls | persisted verdicts make boundaries reproducible |
| J-089 | episode · verdict replay | re-run pipeline over same sealed sessions (run #10) | identical episodes — verdicts reused, zero re-judging, zero new calls | persisted verdicts make boundaries reproducible |
| J-090 | episode · verdict replay | re-run pipeline over same sealed sessions (run #11) | identical episodes — verdicts reused, zero re-judging, zero new calls | persisted verdicts make boundaries reproducible |
| J-091 | episode · pre-flag | session with no intra-session embedding drift | drift high → P-EP2 runs; no drift & no open episodes → skip call | the [ML] pre-flag decides whether to spend the [LLM-M] call |
| J-092 | episode · pre-flag | session with high intra-session embedding drift | drift high → P-EP2 runs; no drift & no open episodes → skip call | the [ML] pre-flag decides whether to spend the [LLM-M] call |
| J-093 | episode · pre-flag | session with no intra-session embedding drift | drift high → P-EP2 runs; no drift & no open episodes → skip call | the [ML] pre-flag decides whether to spend the [LLM-M] call |
| J-094 | episode · pre-flag | session with high intra-session embedding drift | drift high → P-EP2 runs; no drift & no open episodes → skip call | the [ML] pre-flag decides whether to spend the [LLM-M] call |
| J-095 | episode · pre-flag | session with no intra-session embedding drift | drift high → P-EP2 runs; no drift & no open episodes → skip call | the [ML] pre-flag decides whether to spend the [LLM-M] call |
| J-096 | episode · pre-flag | session with high intra-session embedding drift | drift high → P-EP2 runs; no drift & no open episodes → skip call | the [ML] pre-flag decides whether to spend the [LLM-M] call |
| J-097 | episode · pre-flag | session with no intra-session embedding drift | drift high → P-EP2 runs; no drift & no open episodes → skip call | the [ML] pre-flag decides whether to spend the [LLM-M] call |
| J-098 | episode · pre-flag | session with high intra-session embedding drift | drift high → P-EP2 runs; no drift & no open episodes → skip call | the [ML] pre-flag decides whether to spend the [LLM-M] call |
| J-099 | episode · pre-flag | session with no intra-session embedding drift | drift high → P-EP2 runs; no drift & no open episodes → skip call | the [ML] pre-flag decides whether to spend the [LLM-M] call |
| J-100 | episode · pre-flag | session with high intra-session embedding drift | drift high → P-EP2 runs; no drift & no open episodes → skip call | the [ML] pre-flag decides whether to spend the [LLM-M] call |

## K — ARC (100)

_Arcs (bridges, overlap, similarity, adjudication, aging) — Phase 2_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| K-001 | arc · url bridge | link airbnb.com/item0 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-002 | arc · url bridge | link booking.com/item1 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-003 | arc · url bridge | link zomato.com/item2 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-004 | arc · url bridge | link youtube.com/item3 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-005 | arc · url bridge | link amazon.in/item4 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-006 | arc · url bridge | link makemytrip.com/item5 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-007 | arc · url bridge | link x.com/item6 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-008 | arc · url bridge | link github.com/item7 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-009 | arc · url bridge | link nykaa.com/item8 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-010 | arc · url bridge | link cred.club/item9 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-011 | arc · url bridge | link airbnb.com/item10 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-012 | arc · url bridge | link booking.com/item11 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-013 | arc · url bridge | link zomato.com/item12 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-014 | arc · url bridge | link youtube.com/item13 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-015 | arc · url bridge | link amazon.in/item14 shared in WhatsApp; same canonical url visited in browser | bridge(url) [CODE] → episodes JOIN one arc, precision 1.0 | exact join before any similarity |
| K-016 | arc · order_id bridge | MMT order id in Gmail receipt == id in commerce event | bridge(order_id) → JOIN | receipts stitch commerce to mail |
| K-017 | arc · order_id bridge | Amazon order id in Gmail receipt == id in commerce event | bridge(order_id) → JOIN | receipts stitch commerce to mail |
| K-018 | arc · order_id bridge | Zomato order id in Gmail receipt == id in commerce event | bridge(order_id) → JOIN | receipts stitch commerce to mail |
| K-019 | arc · order_id bridge | Goibibo order id in Gmail receipt == id in commerce event | bridge(order_id) → JOIN | receipts stitch commerce to mail |
| K-020 | arc · order_id bridge | Uber order id in Gmail receipt == id in commerce event | bridge(order_id) → JOIN | receipts stitch commerce to mail |
| K-021 | arc · order_id bridge | Swiggy order id in Gmail receipt == id in commerce event | bridge(order_id) → JOIN | receipts stitch commerce to mail |
| K-022 | arc · order_id bridge | BookMyShow order id in Gmail receipt == id in commerce event | bridge(order_id) → JOIN | receipts stitch commerce to mail |
| K-023 | arc · order_id bridge | Blinkit order id in Gmail receipt == id in commerce event | bridge(order_id) → JOIN | receipts stitch commerce to mail |
| K-024 | arc · order_id bridge | Amazon order id in Gmail receipt == id in commerce event | bridge(order_id) → JOIN | receipts stitch commerce to mail |
| K-025 | arc · order_id bridge | MMT order id in Gmail receipt == id in commerce event | bridge(order_id) → JOIN | receipts stitch commerce to mail |
| K-026 | arc · file_id bridge | Drive file shared in chat; file_change events on same file id | bridge(file_id) → chat episode + doc sessions in one arc | documents stitch chat to work |
| K-027 | arc · file_id bridge | Drive file shared in chat; file_change events on same file id | bridge(file_id) → chat episode + doc sessions in one arc | documents stitch chat to work |
| K-028 | arc · file_id bridge | Drive file shared in chat; file_change events on same file id | bridge(file_id) → chat episode + doc sessions in one arc | documents stitch chat to work |
| K-029 | arc · file_id bridge | Drive file shared in chat; file_change events on same file id | bridge(file_id) → chat episode + doc sessions in one arc | documents stitch chat to work |
| K-030 | arc · file_id bridge | Drive file shared in chat; file_change events on same file id | bridge(file_id) → chat episode + doc sessions in one arc | documents stitch chat to work |
| K-031 | arc · file_id bridge | Drive file shared in chat; file_change events on same file id | bridge(file_id) → chat episode + doc sessions in one arc | documents stitch chat to work |
| K-032 | arc · file_id bridge | Drive file shared in chat; file_change events on same file id | bridge(file_id) → chat episode + doc sessions in one arc | documents stitch chat to work |
| K-033 | arc · file_id bridge | Drive file shared in chat; file_change events on same file id | bridge(file_id) → chat episode + doc sessions in one arc | documents stitch chat to work |
| K-034 | arc · file_id bridge | Drive file shared in chat; file_change events on same file id | bridge(file_id) → chat episode + doc sessions in one arc | documents stitch chat to work |
| K-035 | arc · file_id bridge | Drive file shared in chat; file_change events on same file id | bridge(file_id) → chat episode + doc sessions in one arc | documents stitch chat to work |
| K-036 | arc · attendee_set bridge | calendar event attendees ≈ group participants (J=0.6) | bridge(attendee_set) when J≥0.6 → JOIN | people-sets stitch calendar to conversation |
| K-037 | arc · attendee_set bridge | calendar event attendees ≈ group participants (J=0.7) | bridge(attendee_set) when J≥0.6 → JOIN | people-sets stitch calendar to conversation |
| K-038 | arc · attendee_set bridge | calendar event attendees ≈ group participants (J=0.8) | bridge(attendee_set) when J≥0.6 → JOIN | people-sets stitch calendar to conversation |
| K-039 | arc · attendee_set bridge | calendar event attendees ≈ group participants (J=0.9) | bridge(attendee_set) when J≥0.6 → JOIN | people-sets stitch calendar to conversation |
| K-040 | arc · attendee_set bridge | calendar event attendees ≈ group participants (J=0.6) | bridge(attendee_set) when J≥0.6 → JOIN | people-sets stitch calendar to conversation |
| K-041 | arc · attendee_set bridge | calendar event attendees ≈ group participants (J=0.7) | bridge(attendee_set) when J≥0.6 → JOIN | people-sets stitch calendar to conversation |
| K-042 | arc · attendee_set bridge | calendar event attendees ≈ group participants (J=0.8) | bridge(attendee_set) when J≥0.6 → JOIN | people-sets stitch calendar to conversation |
| K-043 | arc · attendee_set bridge | calendar event attendees ≈ group participants (J=0.9) | bridge(attendee_set) when J≥0.6 → JOIN | people-sets stitch calendar to conversation |
| K-044 | arc · attendee_set bridge | calendar event attendees ≈ group participants (J=0.6) | bridge(attendee_set) when J≥0.6 → JOIN | people-sets stitch calendar to conversation |
| K-045 | arc · attendee_set bridge | calendar event attendees ≈ group participants (J=0.7) | bridge(attendee_set) when J≥0.6 → JOIN | people-sets stitch calendar to conversation |
| K-046 | arc · media_work bridge | a YouTube video recommended in chat; same media_work entity in watch history | bridge(media_work_id) → JOIN | media entities stitch recommendation to consumption |
| K-047 | arc · media_work bridge | the SRK film recommended in chat; same media_work entity in watch history | bridge(media_work_id) → JOIN | media entities stitch recommendation to consumption |
| K-048 | arc · media_work bridge | a song recommended in chat; same media_work entity in watch history | bridge(media_work_id) → JOIN | media entities stitch recommendation to consumption |
| K-049 | arc · media_work bridge | the WWE match recommended in chat; same media_work entity in watch history | bridge(media_work_id) → JOIN | media entities stitch recommendation to consumption |
| K-050 | arc · media_work bridge | a podcast recommended in chat; same media_work entity in watch history | bridge(media_work_id) → JOIN | media entities stitch recommendation to consumption |
| K-051 | arc · media_work bridge | a YouTube video recommended in chat; same media_work entity in watch history | bridge(media_work_id) → JOIN | media entities stitch recommendation to consumption |
| K-052 | arc · media_work bridge | the SRK film recommended in chat; same media_work entity in watch history | bridge(media_work_id) → JOIN | media entities stitch recommendation to consumption |
| K-053 | arc · media_work bridge | a song recommended in chat; same media_work entity in watch history | bridge(media_work_id) → JOIN | media entities stitch recommendation to consumption |
| K-054 | arc · media_work bridge | the WWE match recommended in chat; same media_work entity in watch history | bridge(media_work_id) → JOIN | media entities stitch recommendation to consumption |
| K-055 | arc · media_work bridge | a podcast recommended in chat; same media_work entity in watch history | bridge(media_work_id) → JOIN | media entities stitch recommendation to consumption |
| K-056 | arc · geo_time bridge | Uber drop 19:00 ≤200m & ≤45m from restaurant order | bridge(geo_time) → JOIN | place+time coincidence is a physical join |
| K-057 | arc · geo_time bridge | Uber drop 19:01 ≤200m & ≤45m from restaurant order | bridge(geo_time) → JOIN | place+time coincidence is a physical join |
| K-058 | arc · geo_time bridge | Uber drop 19:02 ≤200m & ≤45m from restaurant order | bridge(geo_time) → JOIN | place+time coincidence is a physical join |
| K-059 | arc · geo_time bridge | Uber drop 19:03 ≤200m & ≤45m from restaurant order | bridge(geo_time) → JOIN | place+time coincidence is a physical join |
| K-060 | arc · geo_time bridge | Uber drop 19:04 ≤200m & ≤45m from restaurant order | bridge(geo_time) → JOIN | place+time coincidence is a physical join |
| K-061 | arc · entity overlap | episodes share {Pranjali, Goa, Villa Amara} — weighted Jaccard 0.50 | ≥0.5 → JOIN (signal=overlap); people/place weigh 1.0, topics 0.4 | anchored people+places bind; topics alone drift |
| K-062 | arc · entity overlap | episodes share {Rahul, Goa, Villa Amara} — weighted Jaccard 0.58 | ≥0.5 → JOIN (signal=overlap); people/place weigh 1.0, topics 0.4 | anchored people+places bind; topics alone drift |
| K-063 | arc · entity overlap | episodes share {Rashmi, Goa, Villa Amara} — weighted Jaccard 0.66 | ≥0.5 → JOIN (signal=overlap); people/place weigh 1.0, topics 0.4 | anchored people+places bind; topics alone drift |
| K-064 | arc · entity overlap | episodes share {Sudhir, Goa, Villa Amara} — weighted Jaccard 0.74 | ≥0.5 → JOIN (signal=overlap); people/place weigh 1.0, topics 0.4 | anchored people+places bind; topics alone drift |
| K-065 | arc · entity overlap | episodes share {Hrishikesh, Goa, Villa Amara} — weighted Jaccard 0.82 | ≥0.5 → JOIN (signal=overlap); people/place weigh 1.0, topics 0.4 | anchored people+places bind; topics alone drift |
| K-066 | arc · entity overlap | episodes share {Gargi, Goa, Villa Amara} — weighted Jaccard 0.50 | ≥0.5 → JOIN (signal=overlap); people/place weigh 1.0, topics 0.4 | anchored people+places bind; topics alone drift |
| K-067 | arc · entity overlap | episodes share {Pranjali, Goa, Villa Amara} — weighted Jaccard 0.58 | ≥0.5 → JOIN (signal=overlap); people/place weigh 1.0, topics 0.4 | anchored people+places bind; topics alone drift |
| K-068 | arc · entity overlap | episodes share {Rahul, Goa, Villa Amara} — weighted Jaccard 0.66 | ≥0.5 → JOIN (signal=overlap); people/place weigh 1.0, topics 0.4 | anchored people+places bind; topics alone drift |
| K-069 | arc · entity overlap | episodes share {Rashmi, Goa, Villa Amara} — weighted Jaccard 0.74 | ≥0.5 → JOIN (signal=overlap); people/place weigh 1.0, topics 0.4 | anchored people+places bind; topics alone drift |
| K-070 | arc · entity overlap | episodes share {Sudhir, Goa, Villa Amara} — weighted Jaccard 0.82 | ≥0.5 → JOIN (signal=overlap); people/place weigh 1.0, topics 0.4 | anchored people+places bind; topics alone drift |
| K-071 | arc · adjudication | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.68 | P-AG2 one call → join/new; UNSURE → user question, never silent dup | judgment only at the top of the ladder |
| K-072 | arc · adjudication | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.72 | P-AG2 one call → join/new; UNSURE → user question, never silent dup | judgment only at the top of the ladder |
| K-073 | arc · adjudication | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.76 | P-AG2 one call → join/new; UNSURE → user question, never silent dup | judgment only at the top of the ladder |
| K-074 | arc · adjudication | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.80 | P-AG2 one call → join/new; UNSURE → user question, never silent dup | judgment only at the top of the ladder |
| K-075 | arc · adjudication | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.84 | P-AG2 one call → join/new; UNSURE → user question, never silent dup | judgment only at the top of the ladder |
| K-076 | arc · adjudication | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.68 | P-AG2 one call → join/new; UNSURE → user question, never silent dup | judgment only at the top of the ladder |
| K-077 | arc · adjudication | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.72 | P-AG2 one call → join/new; UNSURE → user question, never silent dup | judgment only at the top of the ladder |
| K-078 | arc · adjudication | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.76 | P-AG2 one call → join/new; UNSURE → user question, never silent dup | judgment only at the top of the ladder |
| K-079 | arc · adjudication | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.80 | P-AG2 one call → join/new; UNSURE → user question, never silent dup | judgment only at the top of the ladder |
| K-080 | arc · adjudication | cross-source candidate, no bridge, overlap 0.3, calibrated sim 0.84 | P-AG2 one call → join/new; UNSURE → user question, never silent dup | judgment only at the top of the ladder |
| K-081 | arc · ambient rule | ambient screen episode similar (0.9) to a trip arc, NO bridge, NO overlap | DO NOT join — ambient joins via bridge/overlap only | the noisiest source must not dominate arcs |
| K-082 | arc · ambient rule | ambient screen episode similar (0.9) to a trip arc, NO bridge, NO overlap | DO NOT join — ambient joins via bridge/overlap only | the noisiest source must not dominate arcs |
| K-083 | arc · ambient rule | ambient screen episode similar (0.9) to a trip arc, NO bridge, NO overlap | DO NOT join — ambient joins via bridge/overlap only | the noisiest source must not dominate arcs |
| K-084 | arc · ambient rule | ambient screen episode similar (0.9) to a trip arc, NO bridge, NO overlap | DO NOT join — ambient joins via bridge/overlap only | the noisiest source must not dominate arcs |
| K-085 | arc · ambient rule | ambient screen episode similar (0.9) to a trip arc, NO bridge, NO overlap | DO NOT join — ambient joins via bridge/overlap only | the noisiest source must not dominate arcs |
| K-086 | arc · aging | arc quiet 3w | live→dormant at 3w; dormant→archived at 12w [CODE]; retrievable | arcs age or they accumulate forever |
| K-087 | arc · aging | arc quiet 4w | live→dormant at 3w; dormant→archived at 12w [CODE]; retrievable | arcs age or they accumulate forever |
| K-088 | arc · aging | arc quiet 5w | live→dormant at 3w; dormant→archived at 12w [CODE]; retrievable | arcs age or they accumulate forever |
| K-089 | arc · aging | arc quiet 6w | live→dormant at 3w; dormant→archived at 12w [CODE]; retrievable | arcs age or they accumulate forever |
| K-090 | arc · aging | arc quiet 7w | live→dormant at 3w; dormant→archived at 12w [CODE]; retrievable | arcs age or they accumulate forever |
| K-091 | arc · user split sticky | user split 'Goa trip' from 'Rohan money settling'; reconcile re-runs | split PERSISTS; reconcile treats user rows as hard walls | actor:user constraints bind the reconciler |
| K-092 | arc · user split sticky | user split 'Goa trip' from 'Rohan money settling'; reconcile re-runs | split PERSISTS; reconcile treats user rows as hard walls | actor:user constraints bind the reconciler |
| K-093 | arc · user split sticky | user split 'Goa trip' from 'Rohan money settling'; reconcile re-runs | split PERSISTS; reconcile treats user rows as hard walls | actor:user constraints bind the reconciler |
| K-094 | arc · user split sticky | user split 'Goa trip' from 'Rohan money settling'; reconcile re-runs | split PERSISTS; reconcile treats user rows as hard walls | actor:user constraints bind the reconciler |
| K-095 | arc · user split sticky | user split 'Goa trip' from 'Rohan money settling'; reconcile re-runs | split PERSISTS; reconcile treats user rows as hard walls | actor:user constraints bind the reconciler |
| K-096 | arc · key stability | full re-derivation run #2 on same corpus | same arc_keys → same ids; labels & pins survive | arc_key = anchors+label stem keeps ids stable |
| K-097 | arc · key stability | full re-derivation run #3 on same corpus | same arc_keys → same ids; labels & pins survive | arc_key = anchors+label stem keeps ids stable |
| K-098 | arc · key stability | full re-derivation run #4 on same corpus | same arc_keys → same ids; labels & pins survive | arc_key = anchors+label stem keeps ids stable |
| K-099 | arc · key stability | full re-derivation run #5 on same corpus | same arc_keys → same ids; labels & pins survive | arc_key = anchors+label stem keeps ids stable |
| K-100 | arc · key stability | full re-derivation run #6 on same corpus | same arc_keys → same ids; labels & pins survive | arc_key = anchors+label stem keeps ids stable |

## L — CAL (20)

_Embedder calibration (floor, normalisation, per-use-case)_

| ID | Context | Input | Expected | Why |
|---|---|---|---|---|
| L-001 | calibration · floor | measure e5 floor from 1000 random unrelated pairs | floor ≈0.75–0.85 persisted to embedder_calib per (model,use_case) | the floor is measured, never assumed |
| L-002 | calibration · floor | measure e5 floor from 1500 random unrelated pairs | floor ≈0.75–0.85 persisted to embedder_calib per (model,use_case) | the floor is measured, never assumed |
| L-003 | calibration · floor | measure e5 floor from 2000 random unrelated pairs | floor ≈0.75–0.85 persisted to embedder_calib per (model,use_case) | the floor is measured, never assumed |
| L-004 | calibration · floor | measure e5 floor from 2500 random unrelated pairs | floor ≈0.75–0.85 persisted to embedder_calib per (model,use_case) | the floor is measured, never assumed |
| L-005 | calibration · floor | measure e5 floor from 3000 random unrelated pairs | floor ≈0.75–0.85 persisted to embedder_calib per (model,use_case) | the floor is measured, never assumed |
| L-006 | calibration · normalisation | raw cosine 0.86, floor 0.83 | norm ≈0.24 → below same-bar | score=(cos−floor)/(1−floor); absolute bars are meaningless |
| L-007 | calibration · normalisation | raw cosine 0.93, floor 0.83 | norm ≈0.65 → candidate band | score=(cos−floor)/(1−floor); absolute bars are meaningless |
| L-008 | calibration · normalisation | raw cosine 0.97, floor 0.83 | norm ≈0.88 → high band | score=(cos−floor)/(1−floor); absolute bars are meaningless |
| L-009 | calibration · normalisation | raw cosine 0.8, floor 0.83 | norm ≈0.0 → unrelated | score=(cos−floor)/(1−floor); absolute bars are meaningless |
| L-010 | calibration · normalisation | raw cosine 0.89, floor 0.83 | norm ≈0.41 → below bar | score=(cos−floor)/(1−floor); absolute bars are meaningless |
| L-011 | calibration · per-use-case | use_case entity_name | distinct threshold row; arc bar > episode bar | one constant cannot serve different text registers |
| L-012 | calibration · per-use-case | use_case entity_rich_text | distinct threshold row; arc bar > episode bar | one constant cannot serve different text registers |
| L-013 | calibration · per-use-case | use_case episode_topic | distinct threshold row; arc bar > episode bar | one constant cannot serve different text registers |
| L-014 | calibration · per-use-case | use_case arc_topic | distinct threshold row; arc bar > episode bar | one constant cannot serve different text registers |
| L-015 | calibration · per-use-case | use_case arc_topic vs episode_topic bars | distinct threshold row; arc bar > episode bar | one constant cannot serve different text registers |
| L-016 | calibration · drift | embedding model swapped to e5-base | re-measure floor at startup; stale calib for model → block similarity rungs | similarity without current calibration must not run |
| L-017 | calibration · drift | embedding model swapped to bge-small | re-measure floor at startup; stale calib for model → block similarity rungs | similarity without current calibration must not run |
| L-018 | calibration · drift | embedding model swapped to new rev | re-measure floor at startup; stale calib for model → block similarity rungs | similarity without current calibration must not run |
| L-019 | calibration · short strings | compare bare names 'Pets' vs 'Pets and Animals Discussion' | FORBIDDEN — comparisons embed rich text (name+aliases+context+quote) | short strings sit where the embedder is least discriminative |
| L-020 | calibration · adjudicator present | borderline score with no adjudicator installed | HARD ERROR at boot — ladder step ④ must exist | no verdict may resolve by giving up |
