# Bundle design — brainstorm

Direct answers to eight questions. Brainstorm only: no plan, no code, nothing committed.

Every number is marked **CONFIRMED** (measured from the live DB, the real traces, or the
installed binary) or **ESTIMATE** (modelled, with the model stated). Where an earlier doc
was wrong, it says so.

Sources: `~/SuperTwinV13/supertwinv13.db` (read-only), `~/SuperTwinV13/traces/2026-08-2{8,9}.jsonl`,
`~/SuperTwin/supertwin.db` (V11, read-only), `claude` 2.1.251 on this machine.

---

## 0. The correction that reframes all eight answers

The bill is not "the system prompt". CONFIRMED, `runs` table, `kind='orient.v6'`, n=16,654:

| component | tokens/call | billed weight | billable units | share of cost |
|---|---:|---:|---:|---:|
| fresh input | 3 | ×1 | 3 | 0.0% |
| **`cache_create_1h`** | **11,166** | **×2** | **22,332** | **91.1%** |
| `cache_read` | 18,293 | ×0.1 | 1,829 | 7.5% |
| output | 338 | ×1 | 338 | 1.4% |
| | | | **24,502** | **$0.02859** |

`cache_create_5m` is **0 on all 16,654 calls**. The 18,483-token Claude Code prefix everyone
worried about is **7.5% of the bill** and it is already caching correctly across fresh sessions.

The 91% is a **1-hour cache write** of bytes that are byte-identical every call and never read
back. From the binary, verbatim: *"Unset = automatic: 1 hour on a Claude subscription… 1-hour
cache writes are billed at a higher rate. The `CLAUDE_CODE_PROMPT_CACHE_TTL` environment
variable takes precedence."* CONFIRMED.

Two consequences that decide most of what follows:

1. **A call costs $0.0283. An extra event inside a call costs ~$0.0002.** A stream riding as a
   passenger is ~32× cheaper than a stream driving its own call. Call count is the only lever
   that matters.
2. **Transport is orthogonal to bundling and multiplies with it.** Every batching number below
   also shrinks by the transport factor. They are not competing options.

Where the $512 went — CONFIRMED:

| kind | calls | total |
|---|---:|---:|
| orient.v6 | 16,654 | $476.13 |
| critic.v4 | 965 | $24.22 |
| everything else | 399 | $11.71 |

---

## Q1 — WhatsApp: the real distribution, and where the earlier number misled

**Where it misled.** The earlier note said "7,278 events / 133 chats = 54.7 mean". Two things
wrong with it.

- **It is 57 days, not ~30.** CONFIRMED: `2026-07-04` → `2026-08-29`, 7,278 messages, 133 chats.
  So the mean is over nearly two months of history, not a month.
- **The mean is produced by five chats.** CONFIRMED distribution:

| messages in chat | chats | messages |
|---|---:|---:|
| exactly 1 | 41 | 41 |
| 2–5 | 44 | 134 |
| 6–20 | 24 | 245 |
| 21–50 | 5 | 178 |
| 51–200 | 14 | 1,705 |
| 200+ | 5 | 4,975 |

**median 3 · p75 10 · p90 90 · p95 176 · max 2,199.** Top 10 chats of 133 (7.5%) carry
**80.2% of all messages.** CONFIRMED.

Last 30 days only: 88 active chats, 3,931 messages, median 3, max 1,153. **84% of chats have
≤30 messages in the month.**

**The shape that actually matters is reply structure, not volume.** Splitting by how many
messages the user himself sent (self JID `919731006976@s.whatsapp.net`) — CONFIRMED:

| group | chats | messages | share of volume |
|---|---:|---:|---:|
| user never replied | 88 (66%) | 648 | 8.9% |
| 1–10 replies | 24 (18%) | 213 | 2.9% |
| **11+ replies** | **21 (16%)** | **6,417** | **88.2%** |

Two thirds of chats are one-way. They carry 9% of the traffic and all of the noise.
Twenty-one chats are the actual relationship graph.

**What this changes.** "54.7 events per chat" makes WhatsApp look like a fat, easy-to-batch
source. It is not. It is 21 firehoses and 112 trickles. Any single global rule is wrong for one
half or the other — which is exactly the argument for Q7.

---

## Q2 — Is 3–5 events per call acceptable?

**No. And it is worse than 3–5.** CONFIRMED from 16,069 real orient calls in the traces:
**27,388 events across 16,069 calls = 1.70 events per call. 13,688 calls (85.2%) carried
exactly one event.**

Browser confirms it from the other side: 2,220 of 2,446 streams are singletons (**90.8%**),
CONFIRMED. We paid $0.0283 to think about one URL, 13,688 times.

The reference point is your own previous build. V11, CONFIRMED from `extraction_runs`:
**1,454 model calls over 26 days, $27.37, every row `provider=claude-local`,
`model=claude-haiku-4-5`** — same subscription, same model. In that window WhatsApp produced
3,714 messages across 79 chats, so V11 ran at **7.34 events per extract call**.

> V11: 1,454 calls in 26 days. V13: 16,069 orient calls in about two.
> Same per-call price. The whole difference is batching.

### The right target

| source | mode | events/call target | why |
|---|---|---|---|
| browser | backfill | ~5.4 (domain+day) | 643 groups from 3,452 events, CONFIRMED regrouping |
| browser | live | whatever the window holds | live windows are small; see Q7 |
| whatsapp | backfill | ~52 (one call per chat) | 140 calls for 57 days, CONFIRMED |
| whatsapp | live | **~7** | matches V11's proven 7.34 |
| screen | either | 3–8 | pack-cap bound, see below |

### What actually breaks when you put many streams in one call

Three separate walls, in the order they bind.

**(a) The packer char cap — soft, and not the real limit.** `DEFAULT_PACK_MAX_CHARS = 28_000`
(`worker/src/packer/pack.ts:56`), CONFIRMED. Median real user block is 875 chars. We are using
3% of the budget. Browser p50 is 876 chars/stream → the cap binds at ~32 streams; screen at
~3,500 chars/stream → ~8 streams. Trivially raised, but note the step-4 fallback truncates
everything above the first `[NEW BUNDLE]` (`pack.ts:315-319`) — under batching that would
silently delete every stream's roster and history at once.

**(b) The commit layer — hard, silent, and already latently broken.** `DeltaBundle` carries a
**scalar** `streamId`. `worker/src/brain/commit.ts` writes `bundle.streamId` into
`episodes.stream_id` at **ten** call sites (lines 249, 265, 281, 299, 325, 333, 366, 377, 392,
400) — CONFIRMED by grep. The Orient output schema (`worker/src/prompts/orient.v6.ts:17-36`)
has **no stream field anywhere**.

So with 25 streams in one call, every episode is filed under stream #1. That is not a cosmetic
bug. `episode_events` stores a **rowid range**, and `packEpisode` reads members back with
`AND stream_id = ?` (`worker/src/brain/thin-pack.ts:76`). An episode written under the wrong
stream resolves to **zero member events** — the row survives, its grounding vanishes, nothing
errors, and Decide, the consolidation sweep and T2 all consume the empty result.

Three other consumers do the range lookup with **no** stream predicate
(`server/grounded-routes.ts:147`, `consolidation/sweep.ts:100`, `assist/gate.ts:185`), so they
would pull in foreign events instead. This is already latently wrong at 4% of ranges today;
batching makes it the norm.

**(c) All-or-nothing parsing.** A parse failure re-sends the whole call once
(`worker/src/brain/llm.ts:504-545`), and a second failure quarantines the **entire unit**.
Measured first-answer failure rate: **1.01%**. P(a batch needs repair) = 1−0.9899^N:

| N | 1 | 5 | 10 | 25 | 50 |
|---|---|---|---|---|---|
| P(repair) | 1.0% | 4.9% | 9.7% | 22.4% | 39.8% |

At N=25 a quarantine parks 25 streams and advances none of their cursors.

**(d) Quality — real, was fixed at N=2, never tested above.** `evals/v13/TOP-09.json` is a
two-stream fixture. Judge verdicts recovered from the traces, CONFIRMED: orient v1, v2, v3
merged both chats into one episode **4 times out of 4** (`wrong-mode: stream-merge`). orient.v6
emitted two correct episodes **5 out of 5**. The fix was per-stream event aliases plus the
explicit rule at `worker/src/prompts/orient.v6.ts:62-65` — *"ONE EPISODE PER STREAM… Never
merge streams into one episode"* (CONFIRMED verbatim).

So cross-contamination is **not folklore**. It is a measured failure that a prompt rule fixed
at N=2. There is **zero** measurement at N=10 or N=25. And note the trap: TOP-09 passes today
only because the judge counts episodes — in production both of those episodes would still be
written to the same `bundle.streamId`. **The model is already better at this than the commit
layer is.**

**Conclusion for Q2.** 1.70 events/call is indefensible. But the cheapest fix is *not*
multi-stream packing (A4) — it is **coarser single-stream keys**, which gets browser from 2,446
calls to 643 with zero schema change and zero new failure mode. A4 buys more, costs ~200 lines
across `commit.ts` / `orient.ts` / `critic.ts` / `dispatch.ts`, and carries an unmeasured
quality risk. Do the keying first; treat A4 as a separate decision (Q-D below).

---

## Q3 — Cross-source in one call: effect, not permission

**Neither. It buys no understanding and no money, and it costs correctness.**

**No understanding, because the link is already being delivered.** Bridge keys are extracted at
ingest (`worker/src/db/eventlog.ts:273-283`); the live DB holds 3,416 url + 887 phone + 6
order_id bridge rows. `crossSourceEpisodes` (`worker/src/packer/history.ts:187-220`) joins on
those shared keys and hands the model the *other* stream's episodes **with their space links**.
That block fired in **10,520 of 15,354 real calls (68.5%)** — CONFIRMED.

So the WhatsApp-villa call already sees the browser villa episodes and the space they live in.
Mixing bundles would re-buy a link the system already has.

**No money, because the wrong half merges.** The cheap part (event lines, ~90 chars each) merges
for free. The expensive part multiplies: `[ROSTER]`, `[STREAM]` (tier/category/engagement),
`[THREAD HISTORY]`, `[EPISODES here]` are all `WHERE stream_id = ?` — one set **per source**
mixed in. And `[BAND]`/`[MODE]` is a scalar hard constraint (`pack.ts:174-177`): a mixed
A-live + C-backfill bundle cannot honour band policy for both halves.

**Real cost: silent, permanent corruption.** Same mechanism as Q2(b) — a mixed bundle files
browser episodes under a WhatsApp stream id, and every later `threadHistory` / `streamEpisodes`
lookup for those streams returns wrong or empty rows.

**One naming note worth knowing.** `crossSourceEpisodes` excludes only `ep.stream_id != ?`
(`history.ts:207`) — it is cross-**stream**, not cross-source. That is exactly why 68.5% of
browser-only calls carry it: it is currently working as a **patch for chain-key fragmentation
between browser streams**. Coarsen the browser key and this block gets smaller *and* more
meaningful, because the same-domain episodes it keeps re-gluing will already be inside the
bundle.

**If you want a stronger cross-source link**, the lever is the existing block, not mixing: raise
the `crossSourceEpisodes` limit from 4 (`history.ts:196`) and add entity joins alongside the
bridge-key join. Costs no extra calls.

---

## Q4 — URL params: the concrete rule

The problem is real. CONFIRMED over 3,437 URL-bearing browser events:

- 166 distinct query params; 68.2% of URLs carry a query string
- query strings are **62.5%** of all URL bytes
- classified: **tracking 270,800 B (69.4% of query bytes)** · content 115,554 B (29.6%) ·
  unknown 3,617 B (0.9%)
- tracking junk = **33.1% of all `events.text` bytes**

And a verbatim line from a real packed prompt (`traces/2026-08-29.jsonl`), CONFIRMED:

```
  e3 08-29 01:30 self: Netflix https://www.netflix.com/watch/82095411?trackId=264293154&tctx=1%2C0%2Cd378192d-e97c-411e-85b9-6b2357de262e%2CeyJwYWdlSWQiOiJQU18yYTUxN2Q1OS0yMTQxLTRkMzUtOWM1MS1kNmUzNDRiMTM0ZDNfTDFfTjEyIiwic2VjdGlvbklkIjoiOWIzOGI5ZWUtNTVkOC00M2RlLTgyZmEtZTRkYWIwZmU0MTNhIiwiaWR4IjotOTk5fQ%3D%3D%2CPS_2a517d59-2141-4d35-9c51-d6e344b134d3_L1_N12%2C%2C%2C%2C81788930%2CVideo%3A82095411%2CdetailsPageEpisodePlayButton
```

**One correction to the earlier doc**: it blamed Netflix. Netflix is 53% junk by URL bytes.
**Google is the offender** — 442 events (12.8%) but 225,597 junk bytes = **81.6% of its URL
bytes**, driven by `gs_lp` (avg 687 B/occurrence), `gs_lcrp`, `fbs`, `mstk`, `ved`, `sca_esv`.

### The rule: denylist + a small per-domain override, applied at emit

Measured over all 3,437 URLs — bytes, and distinct-URL count (dedup power):

| rule | distinct URLs | total bytes | B/event |
|---|---:|---:|---:|
| raw (today) | 1,734 | 649,232 | 188.9 |
| **denylist** | **1,234** | **216,467** | **63.0** |
| allowlist | 1,209 | 212,442 | 61.8 |
| strip everything | 850 | 97,296 | 28.3 |

**Denylist wins on failure mode, not on the 2%.** A denylist fails *open* — an unknown param is
kept, a few bytes wasted, content preserved. An allowlist fails *closed* — an unknown param is
dropped and the content is gone forever. For a memory system that cannot re-derive what it
discarded, fail-open is the only correct default. The 170 "unknown" pairs in this corpus
(`content_title`, `nextpage`, `phrase`, `returnUrl`, `content_id`) are exactly what a strict
allowlist would have eaten. Strip-everything destroys `?q=`, `?v=` and Roughdraft's `?path=` —
which is precisely your objection, and it is correct.

Five ordered steps. **Reuse `normaliseUrl` (`worker/src/bridges/normalise.ts:186`) — it already
implements 2, 4 and 5**, including the YouTube `{v,t}` case at `normalise.ts:206-213`:

1. **Per-domain override, checked first.** ~10 entries, only where vendor params are known
   content: `youtube.com/watch → {v,t,list}` · `google.com/search → {q,udm,tbm}` ·
   `hotstar.com → {search_query,seasonId,episodeNumber}` · `localhost:7373 → {path}` ·
   `amazon.* → {k,node}`. On a listed domain the override is an allowlist; elsewhere fall
   through.
2. **Denylist by prefix**: `utm_ mtm_ pk_ at_ hsa_ gads_ ga_ openid. __cf_chl`.
3. **Denylist by name**: attribution (`gclid fbclid dclid gbraid msclkid igshid mc_cid …`) plus
   the vendor block measured here (`trackId tctx jbv ref_ jic ulp_id`) plus the Google SERP
   block (`ie sourceid gs_lcrp gs_lp cs oq ved sca_esv aep mstk csuir biw bih atvm fbs ntc sa
   aioh stick ei lei sclient iflsig sxsrf`).
4. **Drop the fragment unless route-shaped** (`#!` or `#/`) — already at `normalise.ts:237-238`.
   105,355 bytes (16% of URL bytes), **zero** route-shaped fragments in this corpus.
5. **Hard cap 200 chars** as a backstop. Then **sort the survivors**, so the same page always
   spells itself the same way.

**Apply it to `text` only** (`worker/src/adapters/browser/watcher.ts:238`), keeping the raw URL
in `payload.url` (`watcher.ts:240`). Nothing is destroyed and the page stays clickable.

**Take this for retrieval quality first, money second.** `events.text` is what the prompt reads
(`pack.ts:263`), what FTS indexes (`db/schema.ts:155`), **and what `salientTokens()` builds the
retrieval query from** (`packer/spaces.ts:53-66`). Running the real algorithm on a real Google
bundle whose subject was "tfidf", **11 of the top 24 tokens were base64 tracking garbage** — and
worse than noise, because `fbs` has only 9 distinct values across 120 occurrences, so a
frequency ranker *promotes* it. Result of the fix: −53% text bytes, ~−60% tokens (ESTIMATE, no
offline tokenizer), 1,734 → 1,234 distinct URLs, and a search index that finds "tfidf".

---

## Q5 — Does domain+day keying lose which page the user visited?

**Definitive: NO. Zero page-level detail is lost.**

The evidence is the verbatim bundle above, plus its neighbours in the same real prompt
(`traces/2026-08-29.jsonl`, CONFIRMED):

```
[NEW BUNDLE] 4 events
  e1 08-29 01:30 self: Home - Netflix https://www.netflix.com/browse
  e2 08-29 01:30 self: Home - Netflix https://www.netflix.com/browse?jbv=81788930
  e3 08-29 01:30 self: Netflix https://www.netflix.com/watch/82095411?trackId=…
  e4 08-29 01:30 self: Netflix https://www.netflix.com/watch/82095411?trackId=…
```

Every event line already carries **alias · timestamp to the minute · actor · full page title ·
full URL with path and query**. That comes from `payload.text` — set at
`browser/watcher.ts:238` as `` `${title} ${url}` `` — rendered at `pack.ts:263`.

**The stream key is never in that path.** `toEnvelope(e, bundle.streamKey, …)` puts the key on
`env.streamKey` (`pack.ts:82`) and `serveContent` never reads it. The key does exactly four
jobs: dedupe input (browser bypasses it — `watcher.ts:250` hashes url+ts+visitId, **not** the
key, so re-keying breaks nothing), cursor identity, **grouping**, and **retrieval scope**.
The key names the group; the URL rides in the payload.

**Coarser is better, and the current key is actively hurting.** From 15,354 real orient calls,
CONFIRMED:

| block | "(none)" in |
|---|---:|
| `[THREAD HISTORY]` | 99.7% |
| `[EPISODES here]` | 99.7% |
| `[CANDIDATE SPACES]` | 99.0% |
| `[CROSS-SOURCE]` present | 68.5% |

The chain key starves its own context blocks, then the packer spends tokens gluing the pieces
back with `[CROSS-SOURCE]`. Look at the Netflix trace again: four Netflix chains, four separate
calls, and each prompt shows the other three.

The damage lands in the world model, not the prompt. CONFIRMED: 3,452 browser events produced
**4,409 episodes**, including `"User clicked a Netflix link to a specific title."` × **50**,
`"Opened SuperTwin_PRD.md in rich-text editor."` × **42**, `"User shared a Netflix link…"` × 27,
`"User visited Netflix home page."` × 21. That is the real loss — not URLs, but fifty episodes
where there should be one.

Regrouping the actual 3,452 events, CONFIRMED:

| key | groups | events/group |
|---|---:|---:|
| chain (today) | 2,446 | 1.4 |
| **domain + day** | **643** | **5.4** |
| domain + hour | 1,317 | 2.6 |
| day only | 80 | 43.1 |

**One caveat you should know about, and it is not a keying problem:** `transition`, `referrer`,
`dwell_ms` and `visit_count` are in the payload but are **never rendered** into the bundle line
(`pack.ts:258` builds the head as `e{n} {time} {actor}` only). They are invisible to the model
*today*, under the current key. If you want them, that is a one-line render change.

---

## Q6 — Screen: per-app vs per-document

**Here your worry is correct — but the loss is one render line, not the key.**

Screen keys are `bundleId¦docKey`. CONFIRMED live rows:

```
com.brave.Browser¦https://www.youtube.com/watch?v=Oj2Sr60EaOs
com.apple.systempreferences¦Accessibility
com.anthropic.claudefordesktop¦Claude
```

The captured AX text per event survives any re-keying — it is `payload.text`
(`adapters/screen/envelope.ts:95`), rendered at `pack.ts:263`.

**But `window_title`, `doc_key` and `app_name` are never rendered per event.** `pack.ts:258` is
literally:

```ts
const head = `e${i + 1} ${short(e.ts)} ${e.actor ?? "?"}`;
```

Today the document identity reaches the model exactly once, through the `[STREAM]` line
(`pack.ts:191`) — and only because `streams.label` is empty in the live DB, so it falls back to
printing the raw external key. **So coarsening the screen key without a render change would
genuinely lose it.** That is the difference from browser: browser carries identity in the
payload, screen carries it in the key.

**Fix the render, then coarsen.** With `window_title`/`doc_key` in the per-event head, per-app
becomes strictly better: the model sees doc A → doc B → doc C inside one app session, with the
switches visible, instead of three amnesiac calls each believing it is the only thing that
happened.

Two operational notes. Screen `content_hash` **does** include the stream key
(`screen/envelope.ts:70-78`), unlike browser — expect a one-time re-land of in-flight frames
during a changeover. And screen is ~3,500 chars/stream, so the 28,000 pack cap binds at ~8
streams.

**Bigger finding found on the way, worth more than the keying decision.** The whole L0/L1/L2
digest economy is **inert**. `CONTENT_KINDS` (`packer/digest.ts:50-54`) lists
`browser.page_text` / `screen.ax` / `screen.ax_capture`. The four kinds actually in the DB are
`browser.visit`, `wa.message`, `ax.capture`, `screen.snapshot` — **zero overlap**, and
`content_digests` = 0 rows, `context_escalations` = 0 rows confirm it never fires. So a
21,999-char AX capture reaches the model as its **first 1,200 characters** (`pack.ts:263`). That
loses more real detail than any keying choice on the table.

---

## Q7 — What A3 / engagement-tiered windows actually is

**Plain English.** Today every stream is flushed on the same clock — five minutes, for everyone
(`DEFAULT_DISPATCH_CONFIG.windowMs = 5 * 60_000`, `scheduler/dispatch.ts:68`). A3 says: *how
long you wait before spending a call on a chat should depend on how much that chat matters.*
A chat you talk **in** gets flushed fast. A chat that talks **at** you gets flushed once a day.
Same events, same eventual processing — fewer calls, because waiting longer lets more messages
pile into one call.

Concretely, with hot 30 min / warm 4 h / cold 24 h: the family group (21 such chats, 88% of
volume) flushes 30 minutes after the conversation goes quiet — one call instead of six. The
marketing broadcast (88 such chats, 9% of volume) accumulates all day and gets one call at
day's end. Nothing is dropped; the promo's real bill is still read, just later.

**The data it needs already exists and is already populated.** `streams` carries
`engagement_score`, `reply_count`, `last_user_reply_ts`, `tier` — bumped by `noteUserReply()`
(`categories/promotion.ts:72-99`), recency-weighted with a 30-day half-life
(`promotion.ts:36-46`). Live DB: 2,500 streams, 2,488 with `engagement_score > 0`, max 46.0.
**The scoring works. Nothing consumes it for windowing.**

**Is the existing T1/T2 tier system already this? No — and that is the finding.**
`worker/src/tiers/priority.ts:22-24` states it: *"Nothing here decides WHETHER work happens —
only when."* `tiers/derive.ts:18-21`: *"TIERING DELAYS, NEVER FILTERS."* The tier system is a
**sort key**. It reorders a queue. Reordering a queue of 2,196 calls still costs 2,196 calls.

**The rule is already written down as data, and simply not wired.**
`adapters/whatsapp/manifest.ts:28-42` declares `GAP_MS_DM = 6h`, `GAP_MS_GROUP = 4h`,
`DEBOUNCE_MS = 45min`, `SIZE_CAP_EVENTS = 40`, `day_boundary = true`; `adapters/registry.ts:120`
documents per-stream overrides via `streams.segmentation_override_json`, and `gapMsFor()`
(`registry.ts:437`) reads it. None of it reaches the dispatcher — `dispatch.ts:5` says so in the
second line of the file: *"There is no segmenter."*

**And A3's label points at the wrong half.** Modelled on the real 7,278-message timeline
(ESTIMATE, tumbling window per chat, cap 500):

| scheme | calls/57d | ev/call |
|---|---:|---:|
| flat 5 min (today) | 2,196 | 3.31 |
| tiered hot5m/warm1h/cold24h | 1,909 | 3.81 |
| tiered hot15m/warm2h/cold24h | 1,490 | 4.88 |
| **tiered hot30m/warm6h/cold24h** | **1,280** | **5.69** |

**Tiering alone saves 13%.** The 88 dead chats were only ever 529 of 2,196 calls. **71% of calls
are the 21 hot chats**, which tiering does not touch by definition. The lever is the **window**;
tiering is what makes a long window on a hot chat survivable — you can afford to wait on the
noisy tail precisely because you are not waiting on anything else.

Also: idle-gap beats a tumbling clock at identical latency, because a burst straddling a
boundary is not split — idle-gap 30 min = 1,220 calls vs tumbling 30 min = 1,520. Same wait,
20% fewer calls. (ESTIMATE.)

---

## Q8 — What "low signal browsing" means, tested against your data

**Your objection is right, and the data goes further than you did: the category has no members.**

CONFIRMED, `browser.visit`, n=3,452:

| category | events |
|---|---:|
| cat1 | 3,234 |
| ambiguous | 103 |
| null | 115 |
| **cat2** | **0** |

The categorizer has already run over this whole corpus and produced **zero** Cat-2 events. The
tracker blocklist (`adapters/browser/category.ts:24-57`) matched nothing; `isDroppableTrackerHop`
(`category.ts:173`) dropped nothing. **B2 — "don't call the model for Cat-2 browsing" — has an
addressable population of zero.**

But there *is* a large machine-generated fraction. It is not "low signal", it is "not an act".
Honest non-overlapping buckets, first match wins (CONFIRMED for transitions, ESTIMATE for the
dedup bucket):

| bucket | events | share |
|---|---:|---:|
| SPA route churn (`redirect`) | 603 | 17.5% |
| page reload | 687 | 19.9% |
| browser start / restored tab | 75 | 2.2% |
| same **cleaned** URL again within 30 min | 856 | 24.8% |
| tracker/pixel domain | 0 | 0.0% |
| **deliberate (remainder)** | **1,231** | **35.7%** |

Remainder transitions: link 1,522 total, typed 276, generated 103, form_submit 41, bookmark 30 —
every one a human act.

Two apps dominate the machine fraction:

- **Roughdraft** (`localhost:7373`, your local markdown editor): 836 events = 24.2% of the
  corpus, and **836 distinct stream ids = 34.2% of all streams, every one a singleton.** It
  rotates hostnames per document (`rd1…rd92.localhost`), so it defeats domain keying too. Its
  `?path=` param is genuinely content — the strongest single argument against a strip-all URL
  rule.
- **hotstar.com**: 506 redirect hops, including in-page dialogs recorded as visits.
- Netflix from the other side: 716 events, 391 distinct raw URLs, **33 distinct titles** —
  `/browse` re-pushed 185 times with a fresh `tctx`.

**Note that dedup and Q4 are the same project**: 505 of the 856 near-duplicates are invisible
until tracking params are stripped.

### The honest cost of keeping everything

80-day browser corpus. ESTIMATE, using $0.0283/call today and ~$0.0057 post-transport-fix:

| scenario | calls | today | post-fix | post-fix /month |
|---|---:|---:|---:|---:|
| chain key, all events (today) | 2,446 | $69.22 | $13.94 | $5.23 |
| domain+day, **all** events | 643 | $18.20 | $3.67 | **$1.38** |
| domain+day, deliberate only | 273 | $7.73 | $1.56 | $0.58 |

**Keeping literally everything — all 687 reloads, all 603 redirect hops, all 856 duplicates —
costs about $1.40/month once the key and the transport are fixed.** Skipping the machine 64%
saves under $1/month, bought with a permanent, irreversible policy about whose browsing counts.

**Retire "low signal" as a frame. Drop B2.** Handle the machine fraction with **deduplication
and coarser keys** — lossless, reversible, the events stay in the log — never with a
skip-the-model policy.

---

## Backfill vs live — they are different problems, per source

They differ because the constraint differs. Backfill has all the data at once and no latency
requirement. Live has almost no data per window and a latency requirement.

**The live ceiling is set by the data, not by your choice.** CONFIRMED from the live DB: streams
with new events per 5-minute window are **p50 = 1, p90 = 4, p99 = 24, mean 2.4** across 1,075
active windows. You cannot batch 25 streams live because 25 streams almost never exist. The live
lever is not "big batches" — it is **one call per window across all streams instead of one call
per stream**, worth exactly the mean: **~2.4×**. Beyond that, live savings mean *waiting*, which
is a latency decision, not an accounting one.

| source | BACKFILL | LIVE |
|---|---|---|
| **browser** | key `browser:{browser}:{domain}:{day}`; one call per group. 3,452 events → **643 calls** (CONFIRMED). Keep chain-root hash on the payload so the tab-chain view is still reconstructible. | Flush the whole window across all streams, no fixed N. Same domain+day key, so a day accumulates instead of fragmenting. Ceiling ~2.4×. |
| **whatsapp** | one call per chat, cap 500 (`dispatch.ts:71`) — already correct. 57 days = **140 calls**, $3.96 today. **Add one gate**: hold dispatch on a stream while history-sync is still landing, or a 2,199-message chat arriving as five pages across five ticks becomes 5+ calls. `horizons.ts:123` already tracks `backfill_complete`. | Per-stream **idle-gap debounce** from `gapMsFor()`, scaled by the engagement score already stored. hot 30 min / warm 4 h / cold 24 h, cap 100. Force-flush immediately on `INTENT_RE` (`dispatch.ts:132`). **2,196 → 1,024 calls/57d, 7.11 events/call** (ESTIMATE) — which lands back on V11's proven 7.34. |
| **screen** | key `screen:{bundle_id}:{session}`, session = 30-min idle gap. Cap at ~8 streams (pack cap) or raise `DEFAULT_PACK_MAX_CHARS`. **Requires the `pack.ts:258` render fix first** (Q6). | Same key, flush the window. Volume is tiny (25 events / 10 streams). Do this for coherence, not money. |

**Also worth fixing while in `dispatch.ts`:** `signalFloorChars = 12` almost never fires. Run
against all 7,278 real WhatsApp messages, only ~27% would defer as singletons — the average
message is 44 chars. The floor is set below the noise it was meant to catch.

---

## Combined cost — a realistic first run

Assumptions, stated: bundles → calls at **×1.7** (Orient plus a Critic call whenever
`episodes + proposals > 0`, `brain/consumer.ts:87`; ~70% of traced calls would qualify).
"Today" = $0.0283/call CONFIRMED. "Recommended" = $0.0057/call — the transport stage that
strips CLI attachments and the 1-hour cache write, keeping the subscription (see below).
Bundle counts: browser and WhatsApp-57d **CONFIRMED**; WhatsApp lifetime **ESTIMATE**.

### First run — import everything, once

| lane | bundles | calls | today | recommended |
|---|---:|---:|---:|---:|
| browser backfill, 80 days, all events | 643 | 1,093 | $30.93 | $6.23 |
| whatsapp backfill, 57 days measured | 140 | 238 | $6.74 | $1.36 |
| whatsapp backfill, **full lifetime (~8 yr)** | ~1,069 | ~1,817 | $51.43 | $10.36 |
| screen backfill | ~5 | 9 | $0.25 | $0.05 |
| **total (browser + full WhatsApp life + screen)** | **~1,717** | **~2,919** | **$82.61** | **$16.64** |

**Importing your entire WhatsApp history is a rounding error — about $10.** Backfill was never
the leak. Stop optimising it.

### Steady state, per month

| lane | bundles/mo | calls/mo | today | recommended |
|---|---:|---:|---:|---:|
| browser live (domain+day) | ~241 | ~410 | $11.60 | $2.34 |
| whatsapp live (tiered debounce) | ~539 | ~916 | $25.93 | $5.22 |
| screen live | ~30 | ~51 | $1.44 | $0.29 |
| **total** | **~810** | **~1,377** | **$38.97** | **$7.85** |

**Against the incident: 16,654 Orient calls, $476.13, in about two days.**

### Where the transport number comes from

All flags CONFIRMED present in the installed 2.1.251 by `claude --help` and by strings on the
binary. This stays on your subscription.

| stage | change | $/call | cumulative |
|---|---|---:|---:|
| 0 | today | $0.02859 | — |
| 1 | `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` + drop the double-sent prompt (`providers/claude-local/index.ts:189-192`) + `--no-session-persistence` + `--max-budget-usd` | $0.01714 | −40% |
| **2** | **+ `--safe-mode --strict-mcp-config`** (strips skills / MCP names / agent listing) | **$0.00568** | **−80%** |
| 3 | + `--system-prompt-file` + `--tools ""` | $0.00217 | −92% |

Stage 2 is the number used in the tables above. Stage 1 changes nothing the model sees. Stage 2
removes blocks Orient never used — and stops shipping your Gmail/Calendar/Linear/Figma connector
tool names to Haiku ~16,000 times to classify Netflix visits. Stage 3 replaces Claude Code's
default agent prompt that `orient.v6` was implicitly tuned against, so it needs an eval.

**Two things not to do.** `--bare` — its own help says *"Anthropic auth is strictly
ANTHROPIC_API_KEY… OAuth and keychain are never read"* (CONFIRMED verbatim); it would take you
off the subscription. And `--resume` / session reuse — the prefix already caches across fresh
sessions (18,483 `cache_read` on 14,761 distinct sessions, CONFIRMED), so resuming buys nothing
and adds ~709 tokens of transcript per turn forever.

Two stale comments in the codebase caused this money to sit on the table:
`providers/claude-local/cli.ts:88` and `index.ts:34-39` both assert that `--system-prompt` and
`--append-system-prompt-file` do not exist. Both exist.

---

## Six questions that genuinely need your call

Everything above is settled by evidence. These are not.

**Q-A — How long may a hot WhatsApp chat wait before the model sees it?**
30 minutes of quiet is the recommendation (1,024 calls/57d, 7.11 events/call). 15 minutes costs
~25% more calls; 5 minutes gives most of the money back. Intent-matching messages force-flush
immediately either way. This is a product-feel decision about how live SuperTwin should feel,
and no number decides it.

**Q-B — Do you want per-tab-chain browsing preserved as a queryable view?**
Domain+day is clearly right for the model. But it means "this tab chain" stops being a
first-class object. Keeping the chain-root hash on the payload preserves it offline for a future
UI. Worth carrying, or genuinely dead weight?

**Q-C — Roughdraft: model it or exclude it?**
Your own local markdown editor is 24.2% of the browser corpus and 34.2% of all streams, every
one a singleton, hostname-rotating per document. Coarsening needs a `*.localhost:7373 → one key`
collapse. But first: is your own work-in-progress writing something SuperTwin should be forming
episodes about at all, or is it your workshop and none of its business?

**Q-D — Build multi-stream packing (A4), or stop at coarser keys?**
Coarser keys get browser 2,446 → 643 with no schema change. A4 would get it to ~98, but costs
~200 lines across `commit.ts` / `orient.ts` / `critic.ts` / `dispatch.ts`, plus a quality risk
that has never been measured above N=2. A 26-call fixture would measure it for about $0.77.
Worth the detour now, or park it?

**Q-E — How far back should the WhatsApp import go?**
30 days ($0.53 post-fix) / 1 year (~$1.86) / everything (~$10.36). Not a cost question — a
question about how much of your past you want this thing to have. State the horizon and it
stops being a recurring debate.

**Q-F — Transport stage 3: eval it, or stay at stage 2?**
Stage 2 is safe and gets 80%. Stage 3 gets 92%, but replaces the default agent prompt that
`orient.v6` was tuned against. That means running the eval suite. Do you want that measured now,
or is stage 2 enough for the moment?
