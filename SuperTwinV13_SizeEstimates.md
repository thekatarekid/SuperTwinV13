# SuperTwin V13 — Batch and Step Size Estimates

Sizes for every stage of the pipeline, from real SuperTwin WhatsApp data plus a modelled screen and browser load.

**Data source.** `/Users/adityakatare/SuperTwin` — 8,481 real events over 63.1 days (4 Jul to 5 Sep 2026), 139 chats, 159 people, plus the run ledger of 1,254 real model calls with stored prompt sizes. Raw messages and their timestamps were used. No batch from that build was reused.

Every number is tagged:

- **M** measured from the real data.
- **D** derived by simulating the V6 flush policy on real timestamps.
- **E** estimated from a stated model where the source does not exist yet (screen, browser).

Token conversion is chars ÷ 3.5, the usual ratio for chat text with Hinglish and emoji.

* * *

## 1. What the raw data looks like

| Fact | Value | Tag |
|---|---|---|
| Events | 8,481 over 63.1 days | M |
| Rate | 134 events/day WhatsApp | M |
| Text per message, mean | 46 chars | M |
| Text per message | p50 22 · p75 44 · p90 88 · p95 168 · p99 438 · max 4,647 | M |
| Rendered per event, with head and reply-to | mean 79 chars ≈ 23 tokens | M |
| Kinds | 7,558 text · 507 image · 222 video · 169 reaction · 15 other | M |
| Events with a reply-to | 13.1% | M |
| Chats | 139 (9 groups, 130 DMs) | M |
| Events per chat | p50 4 · p90 99 · max 2,223 | M |
| Events per day | p50 115 · p90 257 · max 665 | M |
| Gap between events | p50 18 s · p75 94 s · p90 1,361 s | M |
| Gaps under 45 s | 67.5% | M |

The heavy skew matters. Half the chats carry 4 events or fewer across two months. Three chats carry 4,738 events between them.

* * *

## 2. Steady state: how many events per day

Screen and browser do not exist in this build, so they are modelled and laid over the real activity envelope. The hour-of-day shape comes from the real WhatsApp distribution.

```
  SOURCE      events/day    rendered chars each       basis
  ─────────────────────────────────────────────────────────────────────────────
  screen           725      mean 1,136  (diff only)   E  AX capture on switch,
                                                         typing pause, scroll stop,
                                                         60 s heartbeat, after
                                                         content-hash dedup;
                                                         anchor+diff storage
  browser          169      mean   120                E  title + stripped URL,
                                                         30 s duplicate collapse
  whatsapp         134      mean    84                M  real
  ─────────────────────────────────────────────────────────────────────────────
  TOTAL          1,028 events/day
```

Screen is 71% of events and 87% of characters. Everything downstream is set by screen, not by chat.

* * *

## 3. Live bundle: the delta

The V6 flush policy simulated on the real timestamps.

### 3.1 At V6's stated setting, 45 s idle and 120 s max

| Sources in the mix | Bundles/day | Events per bundle | Singletons |
|---|---|---|---|
| WhatsApp only | 46 | mean 2.9 · p50 1 · p90 7 · max 73 | 52% |
| WhatsApp + browser | 179 | mean 1.7 · p50 1 · p90 3 | 76% |
| All three | **474** | mean 2.2 · p50 1 · p90 4 · max 75 | 56% |

All D.

Bundle content at the all-three setting:

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| Chars | 667 | 5,146 | 12,358 | 28,624 |
| Tokens | 191 | 1,470 | 3,531 | 8,178 |
| Streams | 1 | 4 | — | 15 |

**Your instinct was right on both counts.** Half the bundles hold one event, and the policy fires 474 times a day. Section 5 shows why the first is not a problem and section 6 shows why the second is.

### 3.2 The flush policy needs to change

Adding a low-signal deferral (a bundle under 800 chars and under 4 events carries forward, up to 20 minutes) and widening the idle window:

| Preset | idle / max | Live calls/day | All calls/day | Pack p50 tokens | Flush lag p50 | Flush lag p90 | $/mo API-equivalent |
|---|---|---|---|---|---|---|---|
| Live | 45 / 120 s | 327 | 926 | 4,300 | 118 s | 315 s | 157 |
| **Balanced** | **90 / 300 s** | **208** | **613** | **4,550** | **257 s** | **462 s** | **106** |
| Relaxed | 180 / 900 s | 104 | 336 | 5,489 | 648 s | 1,068 s | 62 |
| Economy | 300 / 900 s | 82 | 278 | 6,391 | 965 s | 1,237 s | 54 |

All D. Lag is first event of a bundle to its flush; add 15 to 30 seconds of model time on top.

At the Balanced point the bundle becomes healthy:

| Metric | Value |
|---|---|
| Events per bundle | mean 4.9 · p50 4 · p90 9 · p99 20 · max 75 |
| Chars | p50 2,525 · p90 9,420 · p99 19,241 |
| Tokens | p50 721 · p90 2,691 · p99 5,497 |
| Streams per bundle | p50 3 · p90 7 · max 15 |
| Bundles spanning 2+ sources | 56% |
| Singletons | 10%, down from 56% |

Cross-source co-occurrence, the whole reason to bundle by time, only appears at 90 seconds. At 45 seconds only 21% of bundles see more than one source. At 90 seconds it is 56%.

* * *

## 4. History and backfill batch

Screen has no past, so backfill is WhatsApp plus browser only.

### 4.1 One calendar day, all history sources

| | mean | p50 | p90 | max |
|---|---|---|---|---|
| Events | 299 | 283 | 433 | 877 |
| Chars | 31,116 | 30,484 | 48,212 | 77,922 |
| Tokens | 8,890 | 8,710 | 13,775 | 22,263 |
| Streams | 20.8 | — | 25 | 28 |

D, on real WhatsApp days plus modelled browser.

WhatsApp alone is much smaller: mean 11,102 chars, 3,172 tokens, p90 7,098 tokens.

### 4.2 Day splitting

At a 30,000-char cap per call, **52% of days need splitting** at their largest inactivity gap. That works out to 1.55 orient calls per day of history.

| Backfill window | Orient calls | With critic, extract, decide | Cost | Wall clock at 4 slots |
|---|---|---|---|---|
| 30 days | 46 | 72 | $1.08 | 2 min |
| 90 days | 139 | 216 | $3.24 | 7 min |
| 1 year | 565 | 875 | $13.12 | 30 min |
| 5 years | 2,823 | 4,376 | $65.64 | 2.5 h |

D. The 5-year figure is why deep history has to be an explicit opt-in with its own confirmation.

* * *

## 5. The pack: what surrounds the bundle

This is the answer to the context-starvation question. Sizes use the real world-model card lengths from the database.

Measured card sizes:

| Object | Count after 63 days | Chars each |
|---|---|---|
| Spaces | 104 | 140 (name + latest update) |
| Tasks | 378 | 99 (title + intent + plan) |
| People | 212 | 8 (name only, no notes yet) |
| Goals | 136 | 40 |
| Milestones | 68 | 34 |
| Patterns | 86 | 49 |
| Thread history, last 20 events of one stream | — | mean 1,148 · p90 2,260 |
| Thread history, last 40 events of one stream | — | mean 1,596 · p90 3,182 |

All M.

The pack, at the Balanced operating point:

```
  ┌─ PACK ───────────────────────────────────── p50 ──── p90 ──── max ──┐
  │ system prompt                    fixed      1,800   1,800   1,800   │
  │ BUNDLE (the delta)               measured   2,525   9,420  28,624   │ ◄ 16%
  │ thread history   20 ev/stream, cap 5        3,444   7,500   7,500   │
  │ open + dormant episodes          6-12       780    1,560   2,000    │
  │ candidate spaces     retrieval top 5        2,500   2,500   3,000   │
  │ open tasks           retrieval top 20       1,980   1,980   3,000   │
  │ calendar next 7 days             15 items     900   1,200   1,800   │
  │ roster               10-20 people             600   1,200   1,800   │
  │ relevant claims      top 10                 1,100   1,650   2,200   │
  │ cross-source bridges 3-8                      300     700     900   │
  ├──────────────────────────────────────────────────────────────────────┤
  │ TOTAL chars                                15,929  29,510  52,624   │
  │ TOTAL tokens                                4,551   8,431  15,035   │
  └──────────────────────────────────────────────────────────────────────┘
```

**The bundle is 16% of the p50 pack. Context is 84%.** A one-event bundle still arrives with roughly 13,400 characters of thread history, spaces, tasks, calendar, roster and claims around it. It is not starved. The delta is a cursor, not the prompt.

### 5.1 Why retrieval instead of enumeration, in one number

The old build's space-filing pass enumerated every space. Measured over 185 real runs:

| Pass | Prompt chars, mean | p50 | p90 | max | Output tokens | Seconds |
|---|---|---|---|---|---|---|
| `extraction:assign` | **36,953** | 37,192 | 49,340 | 64,660 | 2,083 | 25.5 |
| `extraction:extract` | 5,812 | 4,712 | 10,765 | 24,568 | 417 | 7.0 |
| `done_detection` | 3,195 | 2,160 | 6,259 | 19,939 | 239 | 5.3 |
| `triage` | 1,528 | 1,532 | 1,648 | 1,740 | 81 | 3.9 |
| `planning` | 10,055 | — | — | 13,430 | 166 | 5.1 |
| `execution` | 10,664 | 9,564 | 13,909 | 14,077 | 6,782 | 98.3 |

All M, from 1,254 real runs.

37k characters at 104 spaces. That prompt grows with the user. Retrieving the top 5 candidates instead holds it at 2,500 characters and does not grow. The whole V6 pack, at 15,929 chars, is **less than half** what the old filing pass alone consumed.

* * *

## 6. Every step, sized

Rates are per day at the Balanced operating point, 208 live calls.

| Step | Calls/day | In tokens | Out tokens | Basis |
|---|---|---|---|---|
| Live call, orient + decide | 208 | 4,551 | 900 | pack p50 D, output shape from V2 |
| Critic | 208 | 1,400 | 250 | writes + near-dupes; triage measured at 1,528 chars |
| Extract, claims | 72 | 1,660 | 420 | **M** `extraction:extract` |
| Decide, per space, deep | 62 | 2,900 | 700 | space state + episodes + tasks + plan |
| Digest, tier-3, weekly | 6 | 3,000 | 300 | one stream, one week |
| Executor-lite, prepared work | 8 | 3,050 | 1,800 | bounded loop, 3 to 8 turns |
| Executor, full task | 6 | 3,046 | 6,782 | **M** `execution` |
| Surface router | 25 | 400 | 60 | artifact + presence |
| Grounded bar | 15 | 2,500 | 500 | user-initiated |
| **Total** | **610** | | | |

Fan-out per live call: 1 live + 1 critic + 0.35 extract + 0.30 decide = 2.65 pipeline calls, plus about 60 fixed calls a day for agents, router and bar.

Average cost per call works out to **$0.0058**, which lands on the $0.006 target in the V3 spec.

* * *

## 7. Cost

```
   API-equivalent, Haiku-class pricing ($1/Mtok in, $5/Mtok out)

   preset      live/day   all calls/day    $/month
   ───────────────────────────────────────────────
   Live            327          926          157
   Balanced        208          613          106
   Relaxed         104          336           62
   Economy          82          278           54
   ───────────────────────────────────────────────
   no screen        47          185           22     ◄ chat + browser only
```

Two things follow.

1. **V6's cost claim does not hold.** V6 says roughly 115 calls a day and $11 to $20 a month with screen on. The real figure at V6's own flush parameters is 474 live calls and 926 total, near $157 a month. The gap is screen: 725 events a day at 1,136 chars each. Either the flush window widens to 180 seconds, or screen events get a much harder pre-filter, or the budget is wrong.
2. **On a CLI subscription the dollar figure is a ceiling, not a bill.** The subscription is flat, so the binding constraint is the five-hour rolling quota, not money. 613 calls a day is roughly 26 an hour, which fits. The dollar column matters when the user picks the OpenRouter or OAuth door.

* * *

## 8. Storage

Measured from the real database.

| Item | Size | Tag |
|---|---|---|
| Events table on disk | 540 bytes/event | M |
| Whole database with indexes and full-text search | 1,330 bytes/event | M |
| 8,481 events | 11 MB total | M |
| WhatsApp media | 2,041 KB/file, 695 files in 63 days | M |
| Media rate | 11 files/day, 22 MB/day | M |

Projected per year:

```
   source mix                     events/yr      database        media       total
   ──────────────────────────────────────────────────────────────────────────────
   WhatsApp only                       49k        0.07 GB      8.0 GB      8.1 GB
   + browser                          111k        0.15 GB      8.0 GB      8.2 GB
   + screen (live only, no past)      375k        0.50 GB      8.0 GB      8.5 GB
```

**Media is 94% of the footprint.** The event log is almost free at half a gigabyte a year with everything on. V6's 10 GB default budget is spent by WhatsApp media alone inside 15 months, and the events it was written for never come close to it. Media needs its own budget, its own retention and thumbnail-only storage past a window.

* * *

## 9. What this changes in V6

1. **§11.3 flush parameters.** Change 45 s idle / 2 min max to 90 s idle / 5 min max, with low-signal deferral under 800 chars and 4 events up to 20 minutes. That moves singletons from 56% to 10%, cross-source bundles from 21% to 56%, and calls from 474 to 208 a day.
2. **§11.3 call-count claim.** The stated 60 to 115 calls a day is wrong with screen on. Replace with the preset table in section 3.2 and make freshness a user-visible setting, as V3 had it.
3. **§14.2 latency.** The Balanced flush lag is p50 257 s, p90 462 s, plus 15 to 30 s of model time. So the honest live-path figure is **4.5 to 8 minutes**, not the 1.5 to 4 minutes V6 states. Express flush on intent still lands in 30 to 90 seconds, and that is the path that matters for a nudge.
4. **§10.6 disk budget.** Split it. Events and derived data get 2 GB a year. Media gets its own budget with a retention window, default 30 GB and thumbnails past 90 days.
5. **§23.4 retrieval.** Keep the top-5 candidate rule as a hard cap. The measured 37k-char enumeration prompt is the failure it prevents, and it grows with every space the user accumulates.
6. **§11.3 day splitting.** State that a history day is split at 30,000 chars, which fires on 52% of days, giving 1.55 calls per day of history rather than 1.

* * *

## 10. Assumptions to check

| # | Assumption | Value used | How to verify |
|---|---|---|---|
| 1 | Screen AX events after content-hash dedup | 725/day | Ship the recorder, count for a week |
| 2 | Screen rendered size is the diff, not the tree | mean 1,136 chars | Instrument anchor+diff |
| 3 | Browser visits after 30 s duplicate collapse | 169/day | Read the real history database |
| 4 | Chars to tokens | 3.5 | Count with the real tokenizer |
| 5 | Live output is 900 tokens | shape from V2 | First real orient+decide runs |
| 6 | Extract fires on 35% of bundles | 35% | Instrument |
| 7 | Decide fires on 30% of bundles | 30% | Instrument |
| 8 | This user's WhatsApp volume is typical | 134/day | Widen the sample |

Items 1 and 2 carry the whole model. Screen is 71% of events and 87% of characters, so a 2x error there moves every number in this document.
